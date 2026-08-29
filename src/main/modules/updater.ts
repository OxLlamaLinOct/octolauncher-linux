import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

import { app } from 'electron';
import fetch from 'node-fetch';
import fs from 'fs-extra';
import Logger from 'electron-log/main';

import { nestedGet, nestedSet } from '~common/utils';
import { mainWindow } from '~main/index';
import { getClientVersion } from '~main/utils';
import {
	torrentUrl,
	resolveSyncSource,
	fetchTorrentSha,
	syncClient,
	refreshPristineWow,
	clearTorrentResumeState,
	raidVisualsUrl,
	clientPatchUrl,
	pruneStaleArchives,
	torrentTreeIntact,
	torrentDownloadSelection,
	startSeeding,
	stopSeeding,
	isSeeding
} from '~main/modules/aria2';
import { healRealmlist } from '~main/modules/patcher';

import Preferences from './preferences';
import Observable from './observable';

type FolderTags = 'allowExtra';
type FileTags = 'vanillaFixes' | 'raidVisuals';
type FileManifest = { name: string } & (
	| { type: 'del' }
	| { type: 'dir'; files: FileManifest[]; tags?: FolderTags[] }
	| { type: 'mpq'; files: FileManifest[]; hash: string; size: number }
	| {
			type: 'file';
			hash: string;
			version?: number;
			size: number;
			tags?: FileTags[];
	  }
);

type CacheEntry = [hash: string, mtime: number];
type CacheTree = { [key: string]: CacheTree & CacheEntry };

const getManifestItem = (
	m?: FileManifest,
	p?: string[]
): FileManifest | undefined => {
	if (!p?.length) return m;

	if (m?.type === 'file' || m?.type === 'del')
		throw Error(`Can't access ${p.join('.')} from file ${m.name}`);

	const [next, ...rest] = p;
	return getManifestItem(
		m?.files.find(f => f.name === next),
		rest
	);
};

const ownedDataArchives = async (): Promise<Set<string>> => {
	try {
		const j = await fs.readJSON(
			path.join(Preferences.userDataDir, 'manifest.json')
		);
		const data = getManifestItem(j?.root ?? j, ['Data']);
		if (!data || data.type === 'file' || data.type === 'del') return new Set();
		return new Set(
			data.files
				.filter(f => f.type !== 'dir' && /\.mpq$/i.test(f.name))
				.map(f => f.name.toLowerCase())
		);
	} catch {
		return new Set();
	}
};

export const isGameRunning = (executablePath: string) =>
	new Promise<boolean>(resolve => {
		const exeName = path.basename(executablePath);
		// -x (exact process name) rather than -f (full command line) - -f also
		// matches our own Proton wrapper invocation, since its argv contains
		// the exe path as the target to run, causing false "already running"
		// positives against our own not-yet-started launch.
		execFile('pgrep', ['-x', '-i', exeName], (error, stdout) => {
			if (error && (error as { code?: number }).code !== 1) {
				Logger.warn(
					`pgrep probe for "${exeName}" failed; assuming game is not ` +
						`running. Error: ${error.message}`
				);
				resolve(false);
				return;
			}
			resolve(stdout.trim().length > 0);
		});
	});

type UpdaterState =
	| 'verifying'
	| 'serverUnreachable'
	| 'noClient'
	| 'updateAvailable'
	| 'updating'
	| 'upToDate'
	| 'failed';

export type UpdaterStatus = {
	state: UpdaterState;
	progress?: number;
	message?: string;
	bytesDone?: number;
	bytesTotal?: number;
	bytesPerSecond?: number;
	etaSeconds?: number;
	seeding?: boolean;
	seedingBlockedByDxvk?: boolean;
};

const SIDECAR_TIMEOUT_MS = 30_000;

class UpdaterClass extends Observable<UpdaterStatus> {
	#cachePath = path.join(Preferences.userDataDir, 'cache.json');
	#cache: CacheTree = this.#readCache();

	#readCache(): CacheTree {
		try {
			return fs.existsSync(this.#cachePath)
				? fs.readJSONSync(this.#cachePath)
				: {};
		} catch {
			return {};
		}
	}

	async #saveCache() {
		await fs.writeJSON(this.#cachePath, this.#cache);
	}

	async #getHash(clientPath: string, ...filePath: string[]) {
		if (!(await fs.exists(path.join(clientPath, ...filePath)))) {
			nestedSet(this.#cache, filePath, undefined);
			return undefined;
		}

		const stats = await fs.stat(path.join(clientPath, ...filePath));
		if (stats.isDirectory())
			throw Error(`Tried to get hash of directory ${path.join(...filePath)}`);

		const c = nestedGet<CacheEntry>(this.#cache, filePath);

		if (c?.[0] && c[1] === stats.mtimeMs) return c[0];

		const newHash = crypto
			.createHash('sha1')
			.update(await fs.readFile(path.join(clientPath, ...filePath)))
			.digest('hex')
			.toLocaleUpperCase();
		nestedSet(this.#cache, filePath, {
			...c,
			[0]: newHash,
			[1]: stats.mtimeMs
		});
		return newHash;
	}

	protected _value: UpdaterStatus = { state: 'failed' };

	get status() {
		return this._value;
	}
	private set status(v: UpdaterStatus) {
		this._value = v;
		this._notifyObservers(v);
		if (this.status.state === 'failed') {
			mainWindow?.setProgressBar(1, { mode: 'error' });
		} else if (this.status.progress === 1) {
			mainWindow?.setProgressBar(0);
		} else {
			mainWindow?.setProgressBar(this.status.progress ?? 0, {
				mode: this.status.progress === -1 ? 'indeterminate' : 'normal'
			});
		}
	}

	async refreshSeeding() {
		// no seeding while dxvk is off: aria2 would recreate the parked
		// d3d9.dll as a 0-byte stub and break the game's d3d9 import
		const dxvkOff = Preferences.data.mods?.dxvk?.enabled === false;
		const wantsToSeed = Preferences.data.shareDownloads !== false;
		if (
			wantsToSeed &&
			Preferences.data.clientDir &&
			this.status.state === 'upToDate' &&
			!dxvkOff
		)
			await startSeeding(Preferences.data.clientDir);
		else stopSeeding();
		this.status = {
			...this.status,
			seeding: isSeeding(),
			seedingBlockedByDxvk: wantsToSeed && dxvkOff
		};
	}

	async #torrentVerify(clientPath: string) {
		const url = torrentUrl();
		if (!url) {
			this.status = { state: 'serverUnreachable' };
			return;
		}
		this.status = {
			state: 'verifying',
			progress: -1,
			message: 'Checking for updates...'
		};
		// an interrupted sync can leave realmlist.wtf as a 0-byte placeholder
		await healRealmlist(clientPath).catch(e =>
			Logger.warn('realmlist heal failed', e)
		);
		try {
			const sha = await fetchTorrentSha(url);
			await this.#reconcileClientPatch(clientPath);
			await this.#reconcileRaidVisuals(clientPath);
			const haveExe = await fs.pathExists(path.join(clientPath, 'WoW.exe'));
			if (
				haveExe &&
				sha !== Preferences.data.syncedTorrentHash &&
				(await this.#torrentFastForward(clientPath, sha, url))
			) {
				this.status = { state: 'upToDate', progress: 1 };
				await this.refreshSeeding();
				return;
			}
			const upToDate =
				haveExe &&
				sha === Preferences.data.syncedTorrentHash &&
				(await torrentTreeIntact(clientPath, url));
			if (upToDate) {
				const removed = await pruneStaleArchives(clientPath, url, new Set());
				if (removed.length)
					Logger.log(`Removed stale archives: ${removed.join(', ')}`);
			}
			this.status = upToDate
				? { state: 'upToDate', progress: 1 }
				: { state: 'updateAvailable' };
			await this.refreshSeeding();
		} catch (e) {
			Logger.error('Torrent verify failed', e);
			this.status = { state: 'serverUnreachable' };
		}
	}

	async #fetchSidecarFile(
		url: string,
		dest: string,
		storedHash: string | undefined,
		busyMessage: string
	): Promise<string | undefined> {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), SIDECAR_TIMEOUT_MS);
		const sha = await fetch(`${url}.sha256`, { signal: ac.signal })
			.then(r => {
				if (!r.ok) throw new Error(`sha256 HTTP ${r.status}`);
				return r.text();
			})
			.then(s => s.trim())
			.finally(() => clearTimeout(t));
		if ((await fs.pathExists(dest)) && storedHash === sha) return undefined;
		this.status = { state: 'updating', progress: -1, message: busyMessage };
		const buf = await this.#downloadWithIdleTimeout(url);
		if (crypto.createHash('sha256').update(buf).digest('hex') !== sha)
			throw new Error('checksum mismatch');
		await fs.ensureDir(path.dirname(dest));
		await fs.writeFile(`${dest}.part`, buf);
		await fs.move(`${dest}.part`, dest, { overwrite: true });
		return sha;
	}

	async #downloadWithIdleTimeout(url: string): Promise<Buffer> {
		const ac = new AbortController();
		let idle: ReturnType<typeof setTimeout> | undefined;
		const arm = () => {
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => ac.abort(), SIDECAR_TIMEOUT_MS);
		};
		arm();
		try {
			const res = await fetch(url, { signal: ac.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = res.body as NodeJS.ReadableStream | null;
			if (!body) throw new Error('empty response body');
			const chunks: Buffer[] = [];
			for await (const chunk of body) {
				arm();
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return Buffer.concat(chunks);
		} finally {
			if (idle) clearTimeout(idle);
		}
	}

	async #reconcileClientPatch(clientPath: string) {
		const url = clientPatchUrl();
		if (!url) return;
		const dest = path.join(clientPath, 'Data', 'patch-5.mpq');
		try {
			const sha = await this.#fetchSidecarFile(
				url,
				dest,
				Preferences.data.clientPatchHash,
				'Updating game files...'
			);
			if (sha) Preferences.data = { clientPatchHash: sha };
		} catch (e) {
			Logger.warn('Content patch reconcile failed', e);
			if (!(await fs.pathExists(dest)))
				throw new Error(
					'Could not download core game content. Please check your connection and try again.'
				);
		}
	}

	async #reconcileRaidVisuals(clientPath: string) {
		const url = raidVisualsUrl();
		if (!url) return;
		const dest = path.join(clientPath, 'Data', 'patch-O.mpq');
		try {
			if (!Preferences.data.config?.raidVisuals) {
				if (await fs.pathExists(dest)) {
					await fs.remove(dest);
					Preferences.data = { raidVisualsHash: undefined };
				}
				return;
			}
			const sha = await this.#fetchSidecarFile(
				url,
				dest,
				Preferences.data.raidVisualsHash,
				'Updating raid visuals...'
			);
			if (sha) Preferences.data = { raidVisualsHash: sha };
		} catch (e) {
			Logger.warn('Raid visuals reconcile failed', e);
		}
	}

	async syncRaidVisuals() {
		if (this.status?.state === 'verifying' || this.status?.state === 'updating')
			return;
		const clientPath = Preferences.data.clientDir;
		if (!clientPath) return;
		if (
			!Preferences.data.allowMultipleInstances &&
			(await isGameRunning(path.join(clientPath, 'WoW.exe')))
		) {
			this.status = {
				state: 'failed',
				message: 'Please close WoW first, before updating.'
			};
			return;
		}
		if (!torrentUrl()) return this.verify();
		await this.#reconcileRaidVisuals(clientPath);
		this.status = { state: 'upToDate', progress: 1 };
	}

	async #torrentFastForward(
		clientPath: string,
		sha: string,
		url: string
	): Promise<boolean> {
		if (!(await torrentTreeIntact(clientPath, url))) return false;
		// adopt a complete tree even on a fresh profile; empty delta selection
		// would otherwise fall through to a full re-download
		await clearTorrentResumeState().catch(() => {});
		await refreshPristineWow(clientPath);
		const removed = await pruneStaleArchives(
			clientPath,
			url,
			await ownedDataArchives()
		);
		if (removed.length)
			Logger.log(`Removed stale archives: ${removed.join(', ')}`);
		Preferences.data = {
			syncedTorrentHash: sha,
			version: await getClientVersion()
		};
		return true;
	}

	async #torrentUpdate(clientPath: string, clean?: boolean) {
		const url = torrentUrl();
		if (!url) {
			this.status = { state: 'serverUnreachable' };
			return;
		}
		// set before the first await - the re-entrancy guards in verify()/
		// update() check this.status, so a slow pre-flight (fetchTorrentSha
		// et al, which can now take up to a minute when falling back to a
		// DHT resolve) must not leave a window where a second click starts
		// its own overlapping syncClient() against the same directory.
		this.status = {
			state: 'updating',
			progress: -1,
			message: 'Checking for updates...'
		};
		try {
			stopSeeding();
			const sha = await fetchTorrentSha(url);
			if (!clean && (await this.#torrentFastForward(clientPath, sha, url))) {
				await this.#reconcileClientPatch(clientPath);
				await this.#reconcileRaidVisuals(clientPath);
				this.status = { state: 'upToDate', progress: 1 };
				await this.refreshSeeding();
				return;
			}
			const isUpdate = await fs.pathExists(path.join(clientPath, 'WoW.exe'));
			const staleContext =
				Preferences.data.activeTorrentHash !== sha ||
				Preferences.data.activeClientDir !== clientPath;
			if (staleContext) {
				await clearTorrentResumeState();
				Preferences.data = {
					activeTorrentHash: sha,
					activeClientDir: clientPath
				};
			}
			const selection = clean
				? null
				: await torrentDownloadSelection(clientPath, url, staleContext);
			const selectFiles =
				selection && selection.length > 0 ? selection : undefined;
			const source = await resolveSyncSource(url);
			this.status = {
				state: 'updating',
				progress: -1,
				message: clean
					? 'Verifying game files...'
					: isUpdate
					? source.usedFallback
						? 'Waiting for peers (download server unreachable)...'
						: 'Connecting...'
					: 'Preparing download...'
			};
			let downloading = false;
			await syncClient({
				torrentUrl: source.uri,
				clientDir: clientPath,
				checkIntegrity: !!clean,
				selectFiles,
				seedTime: 0,
				// a piece with no currently-connected seeder is a real (if
				// rare) possibility once the webseed backstop is down - worth
				// waiting out since DHT keeps finding new peers well past a
				// normal-case timeout, rather than failing fast like a
				// routine problem would
				stopTimeoutSeconds: source.usedFallback ? 600 : 120,
				onProgress: p => {
					if (p.bytesPerSecond > 0) downloading = true;
					const phase = downloading
						? 'Downloading'
						: clean
						? 'Verifying game files'
						: isUpdate
						? source.usedFallback
							? 'Waiting for peers'
							: 'Connecting'
						: 'Preparing';
					const remaining = p.bytesTotal - p.bytesDone;
					const etaSeconds =
						p.bytesPerSecond > 0 && remaining > 0
							? remaining / p.bytesPerSecond
							: undefined;
					this.status = {
						state: 'updating',
						progress: p.progress,
						bytesDone: p.bytesDone,
						bytesTotal: p.bytesTotal,
						bytesPerSecond: p.bytesPerSecond,
						etaSeconds,
						message: `${phase}...`
					};
				}
			});
			if (!(await torrentTreeIntact(clientPath, url))) {
				await healRealmlist(clientPath).catch(() => undefined);
				this.status = {
					state: 'updateAvailable',
					message: 'Download incomplete. Click update to finish.'
				};
				return;
			}
			await refreshPristineWow(clientPath);
			const removed = await pruneStaleArchives(
				clientPath,
				url,
				await ownedDataArchives()
			);
			if (removed.length)
				Logger.log(`Removed stale archives: ${removed.join(', ')}`);
			// a sync can recreate d3d9.dll (clean pass, or piece spillover);
			// drop it while dxvk is off, the mods verify owns park/restore
			if (Preferences.data.mods?.dxvk?.enabled === false)
				await fs
					.remove(path.join(clientPath, 'd3d9.dll'))
					.catch(() => undefined);
			await this.#reconcileClientPatch(clientPath);
			await this.#reconcileRaidVisuals(clientPath);
			Preferences.data = {
				syncedTorrentHash: sha,
				version: await getClientVersion()
			};
			this.status = { state: 'upToDate', progress: 1 };
			await this.refreshSeeding();
		} catch (e) {
			Logger.error('Torrent update failed', e);
			await healRealmlist(clientPath).catch(() => undefined);
			this.status = {
				state: 'failed',
				message: e instanceof Error ? e.message : 'Download failed'
			};
		}
	}

	async verify() {
		if (this.status?.state === 'verifying' || this.status?.state === 'updating')
			return;

		const clientPath = Preferences.data.clientDir;
		if (!clientPath) {
			this.status = { state: 'noClient' };
			return;
		}

		if (
			!Preferences.data.allowMultipleInstances &&
			(await isGameRunning(path.join(clientPath, 'WoW.exe')))
		) {
			this.status = {
				state: 'failed',
				message: 'Please close WoW first, before updating.'
			};
			return;
		}

		return this.#torrentVerify(clientPath);
	}

	async update(clean?: boolean) {
		if (this.status?.state === 'verifying' || this.status?.state === 'updating')
			return;

		const clientPath = Preferences.data.clientDir;
		if (!clientPath) {
			this.status = { state: 'noClient' };
			return;
		}

		if (
			!Preferences.data.allowMultipleInstances &&
			(await isGameRunning(path.join(clientPath, 'WoW.exe')))
		) {
			this.status = {
				state: 'failed',
				message: 'Please close WoW first, before updating.'
			};
			return;
		}

		return this.#torrentUpdate(clientPath, clean);
	}

	async recordPatchedWow() {
		const clientPath = Preferences.data.clientDir;
		if (!clientPath) return;
		const patchedWowHash = await this.#getHash(clientPath, 'WoW.exe');
		await this.#saveCache();
		Preferences.data = {
			lastPatchedLauncherVersion: app.getVersion(),
			expectedPatchedWowHash: patchedWowHash
		};
	}
}

const Updater = new UpdaterClass();
export default Updater;
