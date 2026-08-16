import path from 'path';
import os from 'os';

import { screen } from 'electron';
import fs from 'fs-extra';
import Logger from 'electron-log/main';

import Preferences from '~main/modules/preferences';
import { ConfigWtfSchema, type PreferencesSchema } from '~common/schemas';
import { isNotUndef } from '~common/utils';
import { readPristineWow } from '~main/modules/aria2';
import { enumerateDisplays } from '~main/modules/displays';

const Servers = {
	live: {
		realmList: 'octowow.st',
		patchList: 'octowow.st',
		realmName: 'OctoWoW'
	},
	ptr: {
		realmList: import.meta.env.MAIN_VITE_PTR_REALMLIST || 'octowow.st',
		patchList: import.meta.env.MAIN_VITE_PTR_REALMLIST || 'octowow.st',
		realmName: 'OctoWoW PTR'
	}
} as const;

const LOCALES = {
	enUS: { tag: 'enUS', index: 0 },
	deDE: { tag: 'deDE', index: 3 },
	zhCN: { tag: 'zhCN', index: 4 },
	ruRU: { tag: 'ruRU', index: 5 },
	esES: { tag: 'esES', index: 6 },
	ptBR: { tag: 'ptBR', index: 7 }
} as const satisfies Record<
	PreferencesSchema['locale'],
	{ tag: string; index: number }
>;

const LOCALE_NAMES = [
	'enUS',
	'koKR',
	'frFR',
	'deDE',
	'zhCN',
	'zhTW',
	'esES',
	'xxYY'
] as const;

const localeNameOffset = (index: number) => 0x45591c - index * 8;

const carrierName = (index: number) => LOCALE_NAMES[index];

type TweakKey =
	| { synthetic?: false; key: keyof PreferencesSchema['config'] }
	| { synthetic: true; key: string };

type Tweak = TweakKey & {
	default?: unknown;
	forced?: boolean;
} & (
		| {
				type: 'bytes';
				tweaks: [number, number[], number[]?][];
		  }
		| {
				type: 'int8' | 'uint16' | 'float';
				offset: number;
				value?: number;
		  }
	);

const hex = (bytes: number[]) =>
	bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');

export const patchExecutable = async () => {
	Logger.log('Patching WoW.exe...');

	const { clientDir, config, locale } = Preferences.data;
	if (!clientDir) return;
	const exePath = path.join(clientDir, 'WoW.exe');

	try {
		Logger.log('Reading clean WoW.exe base...');
		const buffer = await readPristineWow(clientDir);

		const loc = LOCALES[locale];

		// revert any previous locale patch to the pristine bytes first, so a
		// language switch (or an adopted pre-patched exe) can re-patch cleanly
		const TAG_OFFSET = 0x1b2115;
		const INDEX_OFFSET = 0x253c;
		const PRISTINE_TAG = [0xa1, 0xa4, 0xa2, 0xc2, 0x00];
		const PRISTINE_INDEX = [0x33, 0xf6, 0x8b, 0xff, 0x8b, 0x04, 0xb5];
		if (
			buffer[TAG_OFFSET] === 0xb8 &&
			buffer[INDEX_OFFSET] === 0xbe &&
			buffer[INDEX_OFFSET + 5] === 0xeb
		) {
			const prevIndex = buffer[INDEX_OFFSET + 1];
			const prevCarrier = LOCALE_NAMES[prevIndex] as string | undefined;
			const prevTag = prevCarrier
				? Buffer.from([0xb8, ...Buffer.from(prevCarrier, 'latin1').reverse()])
				: undefined;
			if (
				prevCarrier &&
				prevTag &&
				buffer.subarray(TAG_OFFSET, TAG_OFFSET + 5).equals(prevTag)
			) {
				Logger.log(
					`Reverting previous locale patch (index ${prevIndex}) to the clean base`
				);
				Buffer.from(PRISTINE_TAG).copy(buffer, TAG_OFFSET);
				Buffer.from(PRISTINE_INDEX).copy(buffer, INDEX_OFFSET);
				Buffer.from(prevCarrier, 'latin1').copy(
					buffer,
					localeNameOffset(prevIndex)
				);
			}
		}

		const Tweaks = [
			{
				key: 'largeAddress',
				type: 'uint16',
				offset: 0x126,
				value: buffer.readUint16LE(0x126) | 0x20,
				default: false
			},
			{ key: 'farClip', type: 'float', offset: 0x40fed8 },
			{
				key: 'fieldOfView',
				type: 'float',
				offset: 0x4089b4,
				value: (config.fieldOfView ?? 1) * (Math.PI / 180),
				default: 90
			},
			{ key: 'frillDistance', type: 'float', offset: 0x467958 },
			{
				key: 'soundInBackground',
				type: 'int8',
				offset: 0x3a4869,
				value: config.soundInBackground ? 0x27 : 0x14,
				default: false
			},
			{
				// shipped exe carries the enabled bytes; off must write 0x74 back
				key: 'alwaysAutoLoot',
				type: 'bytes',
				tweaks: [
					[0x0c1ecf, [0x75], [0x74]],
					[0x0c2b25, [0x75], [0x74]]
				]
			},
			{ key: 'nameplateRange', type: 'float', offset: 0x40c448 },
			{ key: 'cameraDistance', type: 'float', offset: 0x4089a4 },
			{
				synthetic: true,
				key: 'skillUiGateHijack',
				type: 'bytes',
				default: true,
				forced: true,
				tweaks: [
					[
						0x002ddf90,
						[
							0x55, 0x8b, 0xec, 0x83, 0xec, 0x08, 0x53, 0x56, 0x57, 0x8b, 0x3d,
							0x60, 0xab, 0xce, 0x00, 0x83, 0xff, 0xff, 0x89, 0x55, 0xfc, 0x89,
							0x4d, 0xf8, 0x74, 0x79, 0x8b, 0x75, 0x08, 0x8b, 0x15, 0x58, 0xab,
							0xce, 0x00, 0x8b, 0xc7, 0x23, 0xc6, 0x8d, 0x04, 0x40, 0x8b, 0x4c,
							0x82, 0x08, 0xf6, 0xc1, 0x01, 0x8d, 0x44, 0x82, 0x04, 0x75, 0x04,
							0x85, 0xc9, 0x75, 0x05, 0x33, 0xc9, 0x8d, 0x49, 0x00, 0xf6, 0xc1,
							0x01, 0x75, 0x4e, 0x85, 0xc9, 0x74, 0x4a, 0x39, 0x31, 0x74, 0x13,
							0x8b, 0xc7, 0x23, 0xc6, 0x8d, 0x04, 0x40, 0x8d, 0x04, 0x82, 0x8b,
							0x00, 0x03, 0xc1, 0x8b, 0x48, 0x04, 0xeb, 0xe0, 0x8b, 0x59, 0x1c,
							0x8b, 0x71, 0x18, 0x33, 0xff, 0x85, 0xdb, 0x7e, 0x27, 0x8d, 0x64,
							0x24, 0x00, 0x8b, 0x4e, 0x0c, 0x8b, 0x56, 0x08, 0x6a, 0x00, 0x6a,
							0x00, 0x51, 0x8b, 0x4d, 0xf8, 0x52, 0x8b, 0x55, 0xfc, 0xe8, 0xb9,
							0xfd, 0xff, 0xff, 0x84, 0xc0, 0x75, 0x13, 0x47, 0x83, 0xc6, 0x20,
							0x3b, 0xfb, 0x7c, 0xdd, 0x5f, 0x5e, 0x33, 0xc0, 0x5b, 0x8b, 0xe5,
							0x5d, 0xc2, 0x04, 0x00, 0x5f, 0x8b, 0xc6, 0x5e, 0x5b, 0x8b, 0xe5,
							0x5d, 0xc2, 0x04, 0x00, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90
						]
					]
				]
			},
			{
				synthetic: true,
				key: 'octowowUrlAllowlist',
				type: 'bytes',
				default: true,
				forced: true,
				tweaks: [
					[
						0x45ccd8,
						[
							0x6f, 0x63, 0x74, 0x6f, 0x77, 0x6f, 0x77, 0x2e, 0x73, 0x74, 0x00,
							0x00, 0x00, 0x00, 0x00, 0x00
						]
					]
				]
			},
			{
				synthetic: true,
				key: 'localeTag',
				type: 'bytes',
				default: true,
				forced: true,
				tweaks: [
					[
						0x1b2115,
						[0xb8, ...Buffer.from(carrierName(loc.index), 'latin1').reverse()],
						[0xa1, 0xa4, 0xa2, 0xc2, 0x00]
					]
				]
			},
			{
				synthetic: true,
				key: 'localeIndex',
				type: 'bytes',
				default: true,
				forced: true,
				tweaks: [
					[
						0x253c,
						[0xbe, loc.index, 0x00, 0x00, 0x00, 0xeb, 0x1f],
						[0x33, 0xf6, 0x8b, 0xff, 0x8b, 0x04, 0xb5]
					]
				]
			},
			{
				synthetic: true,
				key: 'localeName',
				type: 'bytes',
				default: true,
				forced: true,
				tweaks: [
					[
						localeNameOffset(loc.index),
						[...Buffer.from(loc.tag, 'latin1')],
						[...Buffer.from(LOCALE_NAMES[loc.index], 'latin1')]
					]
				]
			}
		] satisfies Tweak[];

		Tweaks.forEach(t => {
			const val = t.synthetic
				? t.default
				: config[t.key] ?? t.default ?? ConfigWtfSchema.parse({})[t.key];

			Logger.log(`Applying "${t.key}" patch with value: ${val}`);
			if (t.type === 'float') {
				buffer.writeFloatLE(t.value ?? (val as number), t.offset);
			} else if (t.type === 'int8') {
				buffer.writeInt8(t.value ?? (val as number), t.offset);
			} else if (t.type === 'uint16') {
				if (!t.forced && !val) return;
				buffer.writeUInt16LE(t.value ?? (val as number), t.offset);
			} else if (t.type === 'bytes') {
				if (!t.forced && !val) {
					// disabled: revert sites carrying the enabled bytes to the
					// stock bytes when known; unknown bytes stay untouched
					t.tweaks.forEach(
						([offset, bytes, expect]: [number, number[], number[]?]) => {
							if (!expect) return;
							const current = buffer.subarray(offset, offset + bytes.length);
							if (current.equals(Buffer.from(bytes)))
								Buffer.from(expect).copy(buffer, offset);
						}
					);
					return;
				}
				t.tweaks.forEach(
					([offset, bytes, expect]: [number, number[], number[]?]) => {
						if (expect) {
							const current = buffer.subarray(offset, offset + expect.length);
							if (current.equals(Buffer.from(bytes))) return;
							if (!current.equals(Buffer.from(expect)))
								throw new Error(
									`"${t.key}" expected [${hex(expect)}] at 0x${offset.toString(
										16
									)} ` +
										`but found [${hex([
											...current
										])}]; refusing to patch WoW.exe`
								);
						}
						const written = Buffer.from(bytes).copy(buffer, offset);
						if (written !== bytes.length)
							Logger.error(
								`"${t.key}" wrote ${written}/${bytes.length} bytes at ` +
									`0x${offset.toString(16)}: past end of file (${
										buffer.length
									} bytes). ` +
									'This tweak is a no-op; the offset is probably a virtual address.'
							);
					}
				);
			}
		});

		await fs.writeFile(exePath, buffer);
		Preferences.data = { patchedLocale: locale };
		Logger.log(`WoW.exe successfully patched (language: ${locale})`);
	} catch (e) {
		Logger.error('Failed to patch WoW.exe', e);
		throw e instanceof Error ? e : new Error('Failed to patch WoW.exe');
	}
};

const repairResolution = async (
	clientDir: string,
	current: string | undefined,
	lastWritten: string | undefined
): Promise<{ gxResolution?: string }> => {
	const devices = await enumerateDisplays();
	if (!devices?.length) return {};

	const pinnedRaw = await fs
		.readFile(path.join(clientDir, 'VMMFix_preferred_monitor.txt'), 'utf8')
		.then(s => s.trim())
		.catch(() => '');
	const pinned = pinnedRaw ? Number(pinnedRaw) : NaN;
	const target =
		devices.find(d => d.index === pinned && d.attached) ??
		devices.find(d => d.primary && d.attached);
	if (!target?.modes.length) return {};

	const native = `${target.width}x${target.height}`;
	if (!target.modes.includes(native)) return {};

	let owned = !current || current === lastWritten;

	if (!owned && lastWritten === undefined && current) {
		const width = Number(current.split('x')[0]);
		if (Number.isFinite(width) && width * 2 < target.width) {
			Logger.warn(
				`gxResolution ${current} is far below ${target.deviceName}'s ${native} and predates resolution tracking; treating it as a client fallback`
			);
			owned = true;
		}
	}

	if (!owned) return {};
	if (current === native) return {};

	Logger.warn(
		`gxResolution ${current ?? '<unset>'} is launcher-owned; correcting to ${
			target.deviceName
		}'s ${native}`
	);
	return { gxResolution: native };
};

const applyRealmlist = async (clientDir: string, host: string) => {
	const body = `set realmlist "${host}"\n`;
	const write = async (target: string) => {
		// already correct: leave it alone (the seeder may hold the file open)
		const current = await fs
			.readFile(target, { encoding: 'utf-8' })
			.catch(() => null);
		if (current === body) return;
		const tmp = `${target}.tmp`;
		try {
			await fs.writeFile(tmp, body);
			await fs.move(tmp, target, { overwrite: true });
		} catch (e) {
			await fs.remove(tmp).catch(() => undefined);
			throw e;
		}
	};
	await write(path.join(clientDir, 'realmlist.wtf'));
	const dataDir = path.join(clientDir, 'Data');
	if (await fs.pathExists(dataDir))
		for (const entry of await fs.readdir(dataDir)) {
			const scoped = path.join(dataDir, entry, 'realmlist.wtf');
			if (!(await fs.pathExists(scoped))) continue;
			try {
				await write(scoped);
			} catch (e) {
				Logger.warn(`Could not rewrite ${scoped}: ${String(e)}`);
			}
		}
};

// rewrite realmlist.wtf when missing, empty, or wrong; an interrupted sync
// can leave a 0-byte placeholder that disconnects direct game launches
export const healRealmlist = async (clientDir: string) => {
	const server: keyof typeof Servers = import.meta.env.MAIN_VITE_PTR_REALMLIST
		? 'ptr'
		: 'live';
	const expected = `set realmlist "${Servers[server].realmList}"\n`;
	const target = path.join(clientDir, 'realmlist.wtf');
	const current = await fs
		.readFile(target, { encoding: 'utf-8' })
		.catch(() => null);
	if (current === expected) return;
	Logger.log(
		`realmlist.wtf ${
			current === null ? 'missing' : current.trim() ? 'wrong' : 'empty'
		}; rewriting`
	);
	await applyRealmlist(clientDir, Servers[server].realmList);
};

export const patchConfig = async (forceTweaks = false) => {
	const { clientDir, config, locale } = Preferences.data;
	if (!clientDir) return;

	const server: keyof typeof Servers = import.meta.env.MAIN_VITE_PTR_REALMLIST
		? 'ptr'
		: 'live';

	const configPath = path.join(clientDir, 'WTF', 'Config.wtf');
	await fs.ensureDir(path.dirname(configPath));
	const raw = (await fs.pathExists(configPath))
		? await fs.readFile(configPath, { encoding: 'utf-8' })
		: '';

	const configWtf = Object.fromEntries(
		raw
			.split(/\r?\n/)
			.map(l => {
				const [, k, v] = l.match(/SET (\w+) "(.*)"/) ?? [];
				return !k || v === undefined ? undefined : [k, v];
			})
			.filter(isNotUndef)
	);

	const isFirstRun = Object.keys(configWtf).length === 0;

	const primaryDisplay = screen.getPrimaryDisplay();
	const scale = primaryDisplay.scaleFactor || 1;
	const width = Math.round(primaryDisplay.bounds.width * scale);
	const height = Math.round(primaryDisplay.bounds.height * scale);

	const seededResolution = `${width}x${height}`;

	const seed = isFirstRun
		? {
				scriptMemory: 512000,
				gxResolution: seededResolution,
				gxColorBits: primaryDisplay.colorDepth,
				gxDepthBits: primaryDisplay.colorDepth,
				gxRefresh: 60,
				gxMultisample: 8,
				gxMultisampleQuality: 0,
				gxTripleBuffer: 1,
				anisotropic: 16,
				frillDensity: 48,
				fullAlpha: 1,
				SmallCull: 0.01,
				DistCull: 888.8,
				shadowLevel: 0,
				trilinear: 1,
				specular: 1,
				pixelShaders: 1,
				M2UsePixelShaders: 1,
				M2UseShaders: 1,
				particleDensity: 1,
				unitDrawDist: 300,
				weatherDensity: 3,
				movieSubtitle: 1,
				minimapZoom: 0,
				minimapInsideZoom: 0,
				SoundZoneMusicNoDelay: 1,
				gxWindow: 1,
				gxMaximize: 1,
				gxCursor: 1,
				checkAddonVersion: 0,
				farClip: config.farClip,
				CameraDistanceMax: config.cameraDistance,
				patchList: Servers[server].patchList,
				realmName: Servers[server].realmName
		  }
		: {};

	const owned = {
		locale: carrierName(LOCALES[locale].index),
		patchList: configWtf.patchList ?? Servers[server].patchList,
		realmName: configWtf.realmName ?? Servers[server].realmName,
		hwDetect: 0,
		BackgroundSound: config.soundInBackground ? 1 : 0,
		// the 32-bit 1.12 client's thread/affinity handling predates >32-core
		// CPUs and reliably crashes (Error #132) on workstation/server chips
		// with higher logical-core counts; cap it to a mask it can represent.
		...(os.cpus().length > 32 ? { processAffinityMask: 0xffffffff } : {})
	};

	const repaired = await repairResolution(
		clientDir,
		configWtf.gxResolution,
		Preferences.data.lastWrittenResolution
	);

	const parsed = {
		...seed,
		...configWtf,
		...repaired,
		...owned,
		...(forceTweaks
			? { farClip: config.farClip, CameraDistanceMax: config.cameraDistance }
			: {})
	};

	const body = Object.entries(parsed)
		.filter(v => v[1] !== undefined && v[1] !== null)
		.filter(([k]) => !/^realmlist$/i.test(k))
		.map(l => `SET ${l[0]} "${l[1]}"`)
		.join('\n');
	const tmpPath = `${configPath}.tmp`;
	await fs.writeFile(tmpPath, body);
	await fs.move(tmpPath, configPath, { overwrite: true });

	await applyRealmlist(clientDir, Servers[server].realmList);

	const chosen =
		repaired.gxResolution ?? (isFirstRun ? seededResolution : undefined);
	if (chosen && chosen !== Preferences.data.lastWrittenResolution)
		Preferences.data = { lastWrittenResolution: chosen };

	Logger.log('Config.wtf successfully patched');
};

export const ensureDxvkConf = async (clientDir: string) => {
	if (!(await fs.pathExists(path.join(clientDir, 'd3d9.dll')))) return;
	const confPath = path.join(clientDir, 'dxvk.conf');
	if (await fs.pathExists(confPath)) return;
	await fs.writeFile(
		confPath,
		[
			'# Cap the texture memory the 32-bit client believes it has so it cannot',
			'# over-commit its address space (the common DXVK out-of-memory crash).',
			'd3d9.maxAvailableMemory = 2048',
			'd3d9.maxFrameLatency = 1',
			'dxvk.numCompilerThreads = 2',
			'dxvk.logLevel = none',
			''
		].join('\n')
	);
	Logger.log('Wrote dxvk.conf');
};
