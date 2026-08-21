import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

import { app } from 'electron';
import fs from 'fs-extra';
import Logger from 'electron-log/main';

import { mapPort, type PortMapping } from './upnp';

const TORRENT_NAME = 'client';

// aria2 is a system dependency on Linux (same posture as Steam/Proton) rather
// than a bundled binary, so it's just resolved off PATH.
const bin = () =>
	os.platform() === 'win32'
		? app.isPackaged
			? path.join(process.resourcesPath, 'aria2c.exe')
			: path.join(app.getAppPath(), 'resources', 'aria2c.exe')
		: 'aria2c';

type SyncOpts = {
	torrentUrl: string;
	clientDir: string;
	totalBytes?: number;
	checkIntegrity?: boolean;
	seedTime?: number;
	selectFiles?: number[];
	onProgress?: (p: SyncProgress) => void;
	signal?: AbortSignal;
};

export type SyncProgress = {
	progress: number;
	bytesDone: number;
	bytesTotal: number;
	bytesPerSecond: number;
};

const ensureJunction = async (clientDir: string): Promise<string> => {
	await fs.ensureDir(clientDir);
	const staging = path.join(app.getPath('userData'), 'torrent-root');
	await fs.ensureDir(staging);
	const link = path.join(staging, TORRENT_NAME);

	const target = path.resolve(clientDir);
	try {
		const cur = await fs.lstat(link);
		if (cur.isSymbolicLink() || cur.isDirectory()) {
			const resolved = await fs.realpath(link).catch(() => '');
			if (path.resolve(resolved) === target) return staging;
		}
		await fs.remove(link);
	} catch {}
	// 'junction' is an NTFS-only symlink type; anywhere else a plain directory
	// symlink does the same job.
	await fs.symlink(
		target,
		link,
		os.platform() === 'win32' ? 'junction' : 'dir'
	);
	return staging;
};

const SIZE_UNITS: Record<string, number> = {
	B: 1,
	KiB: 1024,
	MiB: 1024 ** 2,
	GiB: 1024 ** 3,
	TiB: 1024 ** 4
};

const toBytes = (s: string): number => {
	const m = /^([\d.]+)(B|KiB|MiB|GiB|TiB)$/.exec(s.trim());
	if (!m) return 0;
	return parseFloat(m[1]) * (SIZE_UNITS[m[2]] ?? 1);
};

const parseProgress = (
	line: string,
	totalHint: number
): SyncProgress | undefined => {
	const frac =
		/([\d.]+(?:B|KiB|MiB|GiB|TiB))\/([\d.]+(?:B|KiB|MiB|GiB|TiB))\((\d+)%\)/.exec(
			line
		);
	if (!frac) return undefined;
	const dl = /DL:([\d.]+(?:B|KiB|MiB|GiB|TiB))/.exec(line);
	return {
		progress: parseInt(frac[3], 10) / 100,
		bytesDone: toBytes(frac[1]),
		bytesTotal: toBytes(frac[2]) || totalHint,
		bytesPerSecond: dl ? toBytes(dl[1]) : 0
	};
};

let syncChild: ChildProcess | undefined;

// aria2's --stop-with-process is unreliable on Windows; kill the download
// child explicitly on quit or it keeps running headless
export const stopSyncing = (): void => {
	syncChild?.kill();
	syncChild = undefined;
};

export const syncClient = (opts: SyncOpts): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		let child: ChildProcess | undefined;
		ensureJunction(opts.clientDir)
			.then(dir => {
				const args = [
					`--dir=${dir}`,
					`--seed-time=${opts.seedTime ?? 0}`,
					`--check-integrity=${opts.checkIntegrity ? 'true' : 'false'}`,
					'--bt-save-metadata=true',
					'--bt-remove-unselected-file=false',
					'--continue=true',
					'--allow-overwrite=true',
					'--auto-file-renaming=false',
					'--file-allocation=none',
					'--disk-cache=128M',
					'--stream-piece-selector=inorder',
					'--max-tries=0',
					'--retry-wait=5',
					'--bt-stop-timeout=120',
					'--auto-save-interval=15',
					'--summary-interval=1',
					'--console-log-level=warn',
					'--enable-dht=true',
					'--bt-enable-lpd=true',
					'--max-connection-per-server=8',
					'--split=16',
					'--min-split-size=1M',
					...(opts.selectFiles?.length
						? [`--select-file=${opts.selectFiles.join(',')}`]
						: []),
					`--stop-with-process=${process.pid}`,
					opts.torrentUrl
				];
				Logger.log(`aria2c ${args.join(' ')}`);
				child = spawn(bin(), args, { windowsHide: true });
				syncChild = child;

				const onLine = (buf: Buffer) => {
					for (const line of buf.toString().split(/\r?\n/)) {
						if (!line.trim()) continue;
						const p = parseProgress(line, opts.totalBytes ?? 0);
						if (p) opts.onProgress?.(p);
						else Logger.log(`[aria2] ${line}`);
					}
				};
				child.stdout?.on('data', onLine);
				child.stderr?.on('data', onLine);

				opts.signal?.addEventListener('abort', () => child?.kill());

				child.on('error', reject);
				child.on('close', code => {
					if (syncChild === child) syncChild = undefined;
					if (code === 0) resolve();
					else reject(new Error(`aria2c exited with code ${code}`));
				});
			})
			.catch(reject);
	});

export const aria2Available = async (): Promise<boolean> => {
	if (os.platform() === 'win32') return fs.pathExists(bin());
	// bin() is a bare command name on Linux (resolved via PATH by spawn), so
	// existence has to be checked by actually asking the shell to resolve it.
	return new Promise(resolve => {
		const child = spawn('which', [bin()]);
		child.on('error', () => resolve(false));
		child.on('close', code => resolve(code === 0));
	});
};

// aria2 names the saved metainfo file after the server's Content-Disposition
// header (currently "wow-client.torrent"), not after TORRENT_NAME - so resume
// state has to be found by extension rather than by a hardcoded name.
const findResumeStateFiles = async (dir: string): Promise<string[]> => {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	return entries
		.filter(name => name.endsWith('.torrent') || name.endsWith('.aria2'))
		.map(name => path.join(dir, name));
};

export const downloadIsComplete = async (): Promise<boolean> => {
	const dir = path.join(app.getPath('userData'), 'torrent-root');
	const files = await findResumeStateFiles(dir);
	return !files.some(f => f.endsWith('.aria2'));
};

export const clearTorrentResumeState = async (): Promise<void> => {
	const dir = path.join(app.getPath('userData'), 'torrent-root');
	const files = await findResumeStateFiles(dir);
	await Promise.all(files.map(f => fs.remove(f)));
};

export const torrentUrl = (): string | undefined =>
	import.meta.env.MAIN_VITE_CLIENT_TORRENT_URL || undefined;

export const isTorrentMode = (): boolean => !!torrentUrl();

export const raidVisualsUrl = (): string | undefined =>
	import.meta.env.MAIN_VITE_RAID_VISUALS_URL || undefined;

export const clientPatchUrl = (): string | undefined =>
	import.meta.env.MAIN_VITE_CLIENT_PATCH_URL || undefined;

export const fetchTorrentSha = async (url: string): Promise<string> => {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const buf = Buffer.from(await r.arrayBuffer());
	return crypto.createHash('sha1').update(buf).digest('hex');
};

const bdecode = (buf: Buffer, pos = 0): [unknown, number] => {
	if (pos >= buf.length) throw new Error('bencode: unexpected end of data');
	const ch = buf[pos];
	if (ch === 0x69) {
		const end = buf.indexOf(0x65, pos);
		if (end === -1) throw new Error('bencode: unterminated integer');
		return [parseInt(buf.toString('latin1', pos + 1, end), 10), end + 1];
	}
	if (ch === 0x6c) {
		const list: unknown[] = [];
		let p = pos + 1;
		while (buf[p] !== 0x65) {
			if (p >= buf.length) throw new Error('bencode: unterminated list');
			const [v, np] = bdecode(buf, p);
			list.push(v);
			p = np;
		}
		return [list, p + 1];
	}
	if (ch === 0x64) {
		const dict: Record<string, unknown> = {};
		let p = pos + 1;
		while (buf[p] !== 0x65) {
			if (p >= buf.length) throw new Error('bencode: unterminated dict');
			const [k, kp] = bdecode(buf, p);
			const [v, vp] = bdecode(buf, kp);
			dict[k as string] = v;
			p = vp;
		}
		return [dict, p + 1];
	}
	const colon = buf.indexOf(0x3a, pos);
	if (colon === -1) throw new Error('bencode: unterminated string length');
	const len = parseInt(buf.toString('latin1', pos, colon), 10);
	if (!Number.isInteger(len) || len < 0 || colon + 1 + len > buf.length)
		throw new Error('bencode: invalid string length');
	const start = colon + 1;
	return [buf.toString('latin1', start, start + len), start + len];
};

const torrentDataArchives = (torrentBytes: Buffer): Set<string> => {
	const [torrent] = bdecode(torrentBytes) as [
		{ info?: { files?: { path?: string[] }[] } },
		number
	];
	const files = torrent?.info?.files ?? [];
	return new Set(
		files
			.filter(
				f =>
					f.path?.length === 2 &&
					f.path[0] === 'Data' &&
					/\.mpq$/i.test(f.path[1])
			)
			.map(f => f.path![1].toLowerCase())
	);
};

const LOCALE_DIRS = new Set([
	'enus',
	'engb',
	'encn',
	'entw',
	'kokr',
	'frfr',
	'dede',
	'zhcn',
	'zhtw',
	'eses',
	'esmx',
	'ruru',
	'ptbr',
	'ptpt',
	'itit'
]);

const torrentDataDirs = (torrentBytes: Buffer): Set<string> => {
	const [torrent] = bdecode(torrentBytes) as [
		{ info?: { files?: { path?: string[] }[] } },
		number
	];
	const files = torrent?.info?.files ?? [];
	return new Set(
		files
			.filter(f => (f.path?.length ?? 0) >= 3 && f.path![0] === 'Data')
			.map(f => f.path![1].toLowerCase())
	);
};

// archives the old client shipped under names the current one no longer uses;
// matched by name AND exact size so player mods reusing a name are never touched
const LEGACY_ARCHIVES: Record<string, number> = {
	'patch-6.mpq': 451195806,
	'patch-7.mpq': 175256564,
	'patch-8.mpq': 484649870,
	'patch-9.mpq': 506808141,
	'patch-a.mpq': 241751337
};

export const pruneStaleArchives = async (
	clientDir: string,
	url: string,
	_owned: Set<string>
): Promise<string[]> => {
	try {
		const r = await fetch(url);
		if (!r.ok) return [];
		const bytes = Buffer.from(await r.arrayBuffer());
		const expected = torrentDataArchives(bytes);
		if (!expected.size) return [];
		for (const u of [clientPatchUrl(), raidVisualsUrl()])
			if (u) expected.add(path.basename(u).toLowerCase());
		const usedDirs = torrentDataDirs(bytes);
		const dataDir = path.join(clientDir, 'Data');
		const onDisk = await fs.readdir(dataDir).catch(() => []);
		const removed: string[] = [];
		for (const name of onDisk) {
			const lc = name.toLowerCase();
			const full = path.join(dataDir, name);
			const st = await fs.stat(full).catch(() => null);
			if (!st) continue;
			if (st.isDirectory()) {
				if (LOCALE_DIRS.has(lc) && !usedDirs.has(lc)) {
					await fs.remove(full);
					removed.push(`${name}/`);
				}
				continue;
			}
			if (!/\.mpq$/i.test(name) || expected.has(lc)) continue;
			if (LEGACY_ARCHIVES[lc] !== st.size) continue;
			await fs.remove(full);
			removed.push(name);
		}
		return removed;
	} catch (e) {
		Logger.warn('Prune of stale archives failed', e);
		return [];
	}
};

// files the torrent ships but a mod toggle owns; the sync must not re-add
// them or count their absence as an incomplete tree
const LAUNCHER_OWNED_FILES = new Set(['d3d9.dll']);
const isLauncherOwned = (parts: string[]) =>
	parts.length === 1 && LAUNCHER_OWNED_FILES.has(parts[0].toLowerCase());

// the intro/logo cinematics are purely cosmetic and playing them pulls in
// Wine's COM/DirectShow + DivX codec stack, which we've seen crash the whole
// client on launch on at least one system; skip them entirely on Linux
// rather than risk it - a missing cinematic file is a silent, harmless skip
// for the client, not an error.
const SKIPPED_LINUX_FILES = new Set([
	'data/interface/cinematics/logo_800.avi',
	'data/interface/cinematics/logo_1024.avi',
	'data/interface/cinematics/wow_intro_800.avi',
	'data/interface/cinematics/wow_intro_1024.avi'
]);
const isSkippedOnLinux = (parts: string[]) =>
	os.platform() !== 'win32' &&
	SKIPPED_LINUX_FILES.has(parts.join('/').toLowerCase());

export const torrentDownloadSelection = async (
	clientDir: string,
	url: string,
	dropMismatched = false
): Promise<number[] | null> => {
	try {
		const r = await fetch(url);
		if (!r.ok) return null;
		const [torrent] = bdecode(Buffer.from(await r.arrayBuffer())) as [
			{ info?: { files?: { path?: string[]; length?: number }[] } },
			number
		];
		const files = torrent?.info?.files ?? [];
		if (!files.length) return null;
		const need: number[] = [];
		let missing = false;
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			if (!f.path?.length || typeof f.length !== 'number') return null;
			if (isLauncherOwned(f.path) || isSkippedOnLinux(f.path)) continue;
			const dest = path.join(clientDir, ...f.path);
			const st = await fs.stat(dest).catch(() => null);
			if (!st) {
				missing = true;
				need.push(i + 1);
				continue;
			}
			if (st.size !== f.length) {
				if (dropMismatched || st.size > f.length)
					await fs.remove(dest).catch(() => {});
				need.push(i + 1);
			}
		}
		// a deleted file poisons the resume state (its pieces are marked
		// done, so aria2 skips them forever); partial files keep it so an
		// interrupted download resumes instead of restarting
		if (missing) await clearTorrentResumeState().catch(() => undefined);
		return need;
	} catch (e) {
		Logger.warn('Torrent selection computation failed', e);
		return null;
	}
};

export const torrentTreeIntact = async (
	clientDir: string,
	url: string
): Promise<boolean> => {
	try {
		const r = await fetch(url);
		if (!r.ok) return false;
		const [torrent] = bdecode(Buffer.from(await r.arrayBuffer())) as [
			{ info?: { files?: { path?: string[]; length?: number }[] } },
			number
		];
		const files = torrent?.info?.files ?? [];
		if (!files.length) return false;
		for (const f of files) {
			if (!f.path?.length || typeof f.length !== 'number') return false;
			if (isLauncherOwned(f.path) || isSkippedOnLinux(f.path)) continue;
			const st = await fs
				.stat(path.join(clientDir, ...f.path))
				.catch(() => null);
			if (!st || st.size !== f.length) return false;
		}
		return true;
	} catch (e) {
		Logger.warn('Torrent tree check failed', e);
		return false;
	}
};

const LOCALE_ASSERT_OFFSET = 0x1b2115;
const pristineWowPath = () =>
	path.join(app.getPath('userData'), 'base-WoW.exe');

export const refreshPristineWow = async (clientDir: string): Promise<void> => {
	const exe = path.join(clientDir, 'WoW.exe');
	if (!(await fs.pathExists(exe))) return;
	const fd = await fs.open(exe, 'r');
	try {
		const b = Buffer.alloc(1);
		await fs.read(fd, b, 0, 1, LOCALE_ASSERT_OFFSET);
		if (b[0] === 0xa1) {
			await fs.copy(exe, pristineWowPath(), { overwrite: true });
			Logger.log('Cached pristine WoW.exe base');
		}
	} finally {
		await fs.close(fd);
	}
};

export const readPristineWow = async (clientDir: string): Promise<Buffer> => {
	const cache = pristineWowPath();
	if (await fs.pathExists(cache)) return fs.readFile(cache);
	return fs.readFile(path.join(clientDir, 'WoW.exe'));
};

let seeder: ChildProcess | undefined;
let mapping: Promise<PortMapping> | undefined;
let wantSeeding = false;
let starting = false;

const SEED_PORT = 6881;
const SEED_TIME_MINUTES = 525600;

export const isSeeding = (): boolean => !!seeder;

const releaseMapping = (): void => {
	const m = mapping;
	mapping = undefined;
	if (m) void m.then(x => x.stop()).catch(() => {});
};

export const stopSeeding = (): void => {
	wantSeeding = false;
	seeder?.kill();
	seeder = undefined;
	releaseMapping();
};

export const startSeeding = async (
	clientDir: string,
	uploadLimit = '2M'
): Promise<void> => {
	wantSeeding = true;
	if (seeder || starting) return;
	starting = true;
	try {
		const url = torrentUrl();
		if (!url) return;
		const dir = await ensureJunction(clientDir);
		if (!wantSeeding || seeder) return;
		const args = [
			`--dir=${dir}`,
			'--bt-seed-unverified=true',
			`--seed-time=${SEED_TIME_MINUTES}`,
			'--check-integrity=false',
			// no prealloc: the seeder must not recreate missing files as zeros
			'--file-allocation=none',
			'--continue=true',
			'--bt-save-metadata=true',
			'--enable-dht=true',
			'--bt-enable-lpd=true',
			`--listen-port=${SEED_PORT}`,
			`--dht-listen-port=${SEED_PORT}`,
			`--max-overall-upload-limit=${uploadLimit}`,
			'--summary-interval=0',
			'--console-log-level=warn',
			`--stop-with-process=${process.pid}`,
			url
		];
		Logger.log(`aria2c (seed) ${args.join(' ')}`);
		const child = spawn(bin(), args, { windowsHide: true });
		seeder = child;
		const onExit = () => {
			if (seeder === child) {
				seeder = undefined;
				releaseMapping();
			}
		};
		child.on('close', onExit);
		child.on('error', e => {
			Logger.warn('Seeder failed', e);
			onExit();
		});

		mapping = mapPort(SEED_PORT, { description: 'OctoWoW' });
		void mapping.catch(() => undefined);
	} catch (e) {
		Logger.warn('startSeeding failed', e);
	} finally {
		starting = false;
	}
};
