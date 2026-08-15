import dgram from 'dgram';
import http from 'http';
import os from 'os';

import Logger from 'electron-log/main';

// UPnP-IGD port mapping (best effort) for a NAT'd seeder; node builtins only, no-ops on failure.

export type PortMapping = { stop: () => Promise<void> };

const NOOP: PortMapping = { stop: async () => {} };

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const SEARCH = Buffer.from(
	[
		'M-SEARCH * HTTP/1.1',
		`HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
		'MAN: "ssdp:discover"',
		'MX: 2',
		'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
		'',
		''
	].join('\r\n')
);

// exposes AddPortMapping, newest first
const WAN_SERVICES = [
	'urn:schemas-upnp-org:service:WANIPConnection:2',
	'urn:schemas-upnp-org:service:WANIPConnection:1',
	'urn:schemas-upnp-org:service:WANPPPConnection:1'
];

type Gateway = { location: string; address: string; localAddress: string };
type WanService = { controlUrl: string; serviceType: string };

class SoapError extends Error {
	code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

const candidateAddresses = (): string[] =>
	Object.values(os.networkInterfaces())
		.flat()
		.filter(
			(a): a is os.NetworkInterfaceInfo =>
				!!a &&
				a.family === 'IPv4' &&
				!a.internal &&
				!a.address.startsWith('169.254.')
		)
		.map(a => a.address);

// a 0.0.0.0/empty host in LOCATION is really the address the datagram came from
const fixLocation = (location: string, responder: string): string => {
	try {
		const u = new URL(location);
		if (u.hostname === '0.0.0.0' || u.hostname === '') u.hostname = responder;
		return u.toString();
	} catch {
		return location;
	}
};

// M-SEARCH one interface; collect every responder (more than one can answer)
const searchInterface = (
	localAddress: string,
	timeoutMs: number
): Promise<Gateway[]> =>
	new Promise(resolve => {
		const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
		const found = new Map<string, Gateway>();
		let retry: ReturnType<typeof setInterval> | undefined;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			if (retry) clearInterval(retry);
			try {
				socket.close();
			} catch {
				// already closed
			}
			resolve([...found.values()]);
		};
		socket.on('message', (msg, rinfo) => {
			const m = /^location:\s*(\S+)/im.exec(msg.toString('utf8'));
			if (!m) return;
			const location = fixLocation(m[1].trim(), rinfo.address);
			if (!found.has(location))
				found.set(location, { location, address: rinfo.address, localAddress });
		});
		socket.on('error', () => finish());
		socket.bind(0, localAddress, () => {
			try {
				socket.setMulticastInterface(localAddress);
			} catch {
				// fall back to the default multicast interface
			}
			const send = () =>
				socket.send(SEARCH, SSDP_PORT, SSDP_ADDR, () => {
					/* fire-and-forget */
				});
			send();
			// Routers sometimes miss the first datagram; re-ask until the window closes.
			retry = setInterval(send, 700);
			setTimeout(finish, timeoutMs);
		});
	});

// search all interfaces: a VPN often owns the default route
const discoverGateways = async (timeoutMs: number): Promise<Gateway[]> => {
	const perInterface = await Promise.all(
		candidateAddresses().map(a => searchInterface(a, timeoutMs))
	);
	const seen = new Set<string>();
	const gateways: Gateway[] = [];
	for (const list of perInterface)
		for (const gw of list)
			if (!seen.has(gw.location)) {
				seen.add(gw.location);
				gateways.push(gw);
			}
	return gateways;
};

// build the control URL from the host we reached; routers advertise a bogus URLBase
const controlUrlFrom = (descriptorUrl: string, controlPath: string): string => {
	const desc = new URL(descriptorUrl);
	let path: string;
	try {
		const c = new URL(controlPath, descriptorUrl);
		path = `${c.pathname}${c.search}`;
	} catch {
		path = controlPath.startsWith('/') ? controlPath : `/${controlPath}`;
	}
	return `${desc.protocol}//${desc.host}${path}`;
};

// raw http, not fetch: many UPnP servers are non-compliant and undici rejects them
const httpRequest = (
	url: string,
	opts: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		timeoutMs?: number;
	} = {}
): Promise<{ status: number; body: string }> =>
	new Promise((resolve, reject) => {
		let u: URL;
		try {
			u = new URL(url);
		} catch (e) {
			reject(e as Error);
			return;
		}
		const headers = { ...(opts.headers ?? {}) };
		const body = opts.body ? Buffer.from(opts.body, 'utf8') : undefined;
		if (body) headers['Content-Length'] = String(body.length);
		const req = http.request(
			{
				hostname: u.hostname,
				port: u.port || 80,
				path: `${u.pathname}${u.search}`,
				method: opts.method ?? 'GET',
				headers
			},
			res => {
				const chunks: Buffer[] = [];
				res.on('data', c => chunks.push(c));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf8')
					})
				);
			}
		);
		req.on('error', reject);
		req.setTimeout(opts.timeoutMs ?? 5000, () =>
			req.destroy(new Error('request timed out'))
		);
		if (body) req.write(body);
		req.end();
	});

// first WAN service + control URL from a device descriptor
const findWanService = (
	xml: string,
	descriptorUrl: string
): WanService | undefined => {
	for (const block of xml.split(/<service>/i).slice(1)) {
		const type = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i
			.exec(block)?.[1]
			?.trim();
		const ctrl = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i
			.exec(block)?.[1]
			?.trim();
		if (
			type &&
			ctrl &&
			WAN_SERVICES.some(w => w.toLowerCase() === type.toLowerCase())
		)
			return {
				controlUrl: controlUrlFrom(descriptorUrl, ctrl),
				serviceType: type
			};
	}
	return undefined;
};

const xmlEscape = (s: string): string =>
	s.replace(
		/[<>&'"]/g,
		c =>
			({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[
				c
			] as string)
	);

const arg = (name: string, value: string | number): string =>
	`<${name}>${value}</${name}>`;

const soap = async (
	svc: WanService,
	action: string,
	body: string
): Promise<void> => {
	const envelope =
		'<?xml version="1.0"?>' +
		'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
		'<s:Body>' +
		`<u:${action} xmlns:u="${svc.serviceType}">${body}</u:${action}>` +
		'</s:Body></s:Envelope>';
	const res = await httpRequest(svc.controlUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'text/xml; charset="utf-8"',
			'SOAPAction': `"${svc.serviceType}#${action}"`
		},
		body: envelope
	});
	if (res.status < 200 || res.status >= 300) {
		const code = /<errorCode>\s*(\d+)/i.exec(res.body)?.[1];
		throw new SoapError(
			`${action} failed: HTTP ${res.status}${code ? ` (UPnP ${code})` : ''}`,
			code
		);
	}
};

const addMapping = (
	svc: WanService,
	port: number,
	protocol: 'TCP' | 'UDP',
	client: string,
	description: string,
	lease: number
): Promise<void> =>
	soap(
		svc,
		'AddPortMapping',
		arg('NewRemoteHost', '') +
			arg('NewExternalPort', port) +
			arg('NewProtocol', protocol) +
			arg('NewInternalPort', port) +
			arg('NewInternalClient', client) +
			arg('NewEnabled', 1) +
			arg('NewPortMappingDescription', xmlEscape(description)) +
			arg('NewLeaseDuration', lease)
	);

const deleteMapping = (
	svc: WanService,
	port: number,
	protocol: 'TCP' | 'UDP'
): Promise<void> =>
	soap(
		svc,
		'DeletePortMapping',
		arg('NewRemoteHost', '') +
			arg('NewExternalPort', port) +
			arg('NewProtocol', protocol)
	);

// map port (TCP+UDP), kept alive until stop(); returns a no-op handle when no gateway
export const mapPort = async (
	port: number,
	opts: { description?: string; ttlSeconds?: number } = {}
): Promise<PortMapping> => {
	const description = opts.description ?? 'OctoWoW';
	try {
		const gateways = await discoverGateways(4000);
		if (!gateways.length) {
			Logger.log('UPnP: no gateway found; seeding without a port mapping');
			return NOOP;
		}
		// take the first responder that exposes a WAN service
		const probed = await Promise.all(
			gateways.map(async gw => {
				const res = await httpRequest(gw.location).catch(() => undefined);
				const svc =
					res && res.status < 400
						? findWanService(res.body, gw.location)
						: undefined;
				return svc ? { svc, client: gw.localAddress } : undefined;
			})
		);
		const target = probed.find(Boolean);
		if (!target) {
			Logger.log('UPnP: no gateway exposes a WAN service; skipping mapping');
			return NOOP;
		}
		const { svc, client } = target;

		// Some routers only grant permanent leases (UPnP error 725); fall back to one.
		let lease = opts.ttlSeconds ?? 3600;
		const mapped: ('TCP' | 'UDP')[] = [];
		const mapOne = async (protocol: 'TCP' | 'UDP') => {
			try {
				await addMapping(svc, port, protocol, client, description, lease);
			} catch (e) {
				if (e instanceof SoapError && e.code === '725' && lease !== 0) {
					lease = 0;
					await addMapping(svc, port, protocol, client, description, lease);
				} else throw e;
			}
			mapped.push(protocol);
		};
		try {
			await mapOne('TCP');
			await mapOne('UDP');
		} catch (e) {
			for (const p of mapped) await deleteMapping(svc, port, p).catch(() => {});
			throw e;
		}

		// A finite lease self-heals if we exit uncleanly; renew ahead of expiry.
		let renew: ReturnType<typeof setInterval> | undefined;
		if (lease > 0) {
			const period = Math.max(60_000, (lease - 60) * 1000);
			renew = setInterval(() => {
				addMapping(svc, port, 'TCP', client, description, lease).catch(
					() => {}
				);
				addMapping(svc, port, 'UDP', client, description, lease).catch(
					() => {}
				);
			}, period);
			renew.unref?.();
		}

		Logger.log(
			`UPnP: mapped ${port} TCP+UDP to ${client} (lease ${
				lease || 'permanent'
			})`
		);
		return {
			stop: async () => {
				if (renew) clearInterval(renew);
				await deleteMapping(svc, port, 'TCP').catch(() => {});
				await deleteMapping(svc, port, 'UDP').catch(() => {});
			}
		};
	} catch (e) {
		Logger.warn('UPnP: port mapping failed; seeding without it', e);
		return NOOP;
	}
};
