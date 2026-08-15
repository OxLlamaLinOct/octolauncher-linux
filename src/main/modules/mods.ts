import path from 'path';
import { createHash } from 'crypto';

import fs from 'fs-extra';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import Logger from 'electron-log/main';

import {
	MODS,
	DEFAULT_ENABLED_MODS,
	type ModEntry,
	type ModId,
	getMod
} from '~common/mods';
import { type ModState } from '~common/schemas';

import Preferences from './preferences';
import { isTorrentMode, stopSeeding } from './aria2';
import Observable from './observable';
import Updater from './updater';
import { addDll, removeDll, listDlls } from './dllsTxt';
import { enumerateDisplays } from './displays';
import { nvidiaDriverTooOldForDxvk } from './hardware';

const MOD_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Files a mod installs on disk. */
const modTargetFiles = (m: ModEntry): string[] => {
	if (m.source.kind === 'directFile') return [m.source.assetName];
	if (m.source.kind === 'archive') return Object.values(m.source.extractMap);
	return [];
};

// client-shipped DLLs that aren't injectable mods; not counted as custom mods
const RESERVED_DLLS = new Set([
	'ace.dll',
	'divxdecoder.dll',
	'discordoverlay.dll',
	'discord_game_sdk.dll',
	'dbghelp.dll',
	'fmod.dll',
	'ijl15.dll',
	'sdl.dll',
	'scan.dll',
	'unicows.dll',
	'zlib1.dll'
]);

// files owned by an active built-in mod; a disabled mod's files are fair game to add by hand
const KNOWN_DLLS = new Set(
	MODS.filter(m => !m.disabled)
		.flatMap(m => [m.registerInDllsTxt, ...modTargetFiles(m)])
		.filter((f): f is string => !!f)
		.map(f => f.toLowerCase())
);

const AV_ERROR =
	'Windows Defender blocked this download. Use "Allow through antivirus" and apply again.';

// pinned dxvk-gplasync v2.7.1-1 x32 d3d9.dll (same build the client ships)
const DXVK_DLL_SHA256 =
	'a2cd6841e102f37189527c118ec416fa5071ac4d3120762973d9a0c6c5fd067e';

const fileSha256 = async (p: string): Promise<string | null> => {
	try {
		return createHash('sha256')
			.update(await fs.readFile(p))
			.digest('hex');
	} catch {
		return null;
	}
};

const looksLikeAvBlock = (msg: string) =>
	/windows defender|virus|potentially unwanted/i.test(msg);

export type ModRowStatus = {
	id: ModId;
	name: string;
	description: string;
	repoUrl: string;
	recommended: boolean;
	requires: ModId[];
	enabled: boolean;
	ignoreUpdates: boolean;
	installedVersion?: string;
	latestVersion: string;
	state: 'idle' | 'downloading' | 'installing' | 'uninstalling' | 'error';
	progress?: number;
	error?: string;
};

export type CustomMod = { name: string; enabled: boolean };

export type ModsStatus = {
	state: 'verifying' | 'idle' | 'busy';
	dirty: boolean;
	mods: ModRowStatus[];
	custom: CustomMod[];
	// enabled mods whose files are missing (AV quarantine or incomplete sync)
	missingFiles: string[];
};

class ModsClass extends Observable<ModsStatus> {
	protected _value: ModsStatus = {
		state: 'verifying',
		dirty: false,
		mods: [],
		custom: [],
		missingFiles: []
	};

	// staged custom-DLL toggles, keyed lower-case; #customApplied mirrors dlls.txt
	#customDesired = new Map<string, boolean>();
	#customApplied = new Map<string, boolean>();
	#customNames = new Map<string, string>();

	get status(): ModsStatus {
		return this._value;
	}

	#initialRow(m: ModEntry): ModRowStatus {
		const state = Preferences.data?.mods?.[m.id];
		return {
			id: m.id,
			name: m.name,
			description: m.description,
			repoUrl: m.repoUrl,
			recommended: !!m.recommended,
			requires: m.requires ?? [],
			enabled: !!state?.enabled,
			ignoreUpdates: !!state?.ignoreUpdates,
			installedVersion: state?.installedVersion,
			latestVersion: m.version,
			state: 'idle'
		};
	}

	#patchRow(id: ModId, patch: Partial<ModRowStatus>) {
		this._value = {
			...this._value,
			mods: this._value.mods.map(r => (r.id === id ? { ...r, ...patch } : r))
		};
		this._value = { ...this._value, dirty: this.#computeDirty() };
		this._notifyObservers();
	}

	#computeDirty(): boolean {
		if (this.#customDesired.size > 0) return true;
		return this._value.mods.some(r => {
			const wantInstalled = r.enabled;
			const isInstalled = !!r.installedVersion;
			if (wantInstalled !== isInstalled) return true;
			if (
				r.installedVersion &&
				r.installedVersion !== r.latestVersion &&
				!r.ignoreUpdates
			)
				return true;
			return false;
		});
	}

	load() {
		this._value = {
			state: 'verifying',
			dirty: false,
			mods: MODS.filter(m => !m.disabled).map(m => this.#initialRow(m)),
			custom: this._value.custom,
			missingFiles: []
		};
	}

	// DLLs in the client dir we neither ship nor own
	async #detectCustomDlls(clientDir: string): Promise<CustomMod[]> {
		const inDllsTxt = await listDlls(clientDir);
		const enabled = new Set(inDllsTxt.map(n => n.toLowerCase()));
		const found = new Map<string, string>();
		const consider = (name: string) => {
			const lc = name.toLowerCase();
			if (RESERVED_DLLS.has(lc) || KNOWN_DLLS.has(lc) || found.has(lc)) return;
			found.set(lc, name);
		};
		for (const f of await fs.readdir(clientDir).catch(() => [] as string[]))
			if (/\.dll$/i.test(f)) consider(f);
		inDllsTxt.forEach(consider);
		const names = [...found.values()].sort((a, b) => a.localeCompare(b));
		this.#customApplied = new Map(
			names.map(n => [n.toLowerCase(), enabled.has(n.toLowerCase())])
		);
		this.#customNames = new Map(names.map(n => [n.toLowerCase(), n]));
		// drop staged changes for DLLs no longer present
		const present = new Set(names.map(n => n.toLowerCase()));
		for (const lc of [...this.#customDesired.keys()])
			if (!present.has(lc)) this.#customDesired.delete(lc);
		return names.map(name => {
			const lc = name.toLowerCase();
			return {
				name,
				enabled: this.#customDesired.has(lc)
					? !!this.#customDesired.get(lc)
					: !!this.#customApplied.get(lc)
			};
		});
	}

	// flush staged custom-DLL changes to dlls.txt; a failed write stays staged (still pending)
	async #applyCustomDlls(clientDir: string) {
		for (const [lc, enabled] of [...this.#customDesired]) {
			const name = this.#customNames.get(lc) ?? lc;
			try {
				await (enabled ? addDll(clientDir, name) : removeDll(clientDir, name));
				this.#customDesired.delete(lc);
			} catch (e) {
				Logger.warn(`custom dll apply failed for ${name}`, e);
			}
		}
	}

	async #syncPreferredMonitor(clientDir: string) {
		const vmmfDll = path.join(clientDir, 'VanillaMultiMonitorFix.dll');
		if (!(await fs.pathExists(vmmfDll))) return;

		const vmmfCfg = path.join(clientDir, 'VMMFix_preferred_monitor.txt');
		const existsCfg = await fs.pathExists(vmmfCfg);
		const current = existsCfg
			? Number(
					await fs
						.readFile(vmmfCfg, 'utf8')
						.then(s => s.trim())
						.catch(() => '')
			  )
			: NaN;
		const hasCurrent = Number.isInteger(current);
		const ours = Preferences.data?.vmmfWrittenIndex;

		const devices = await enumerateDisplays();
		const usable = devices?.filter(d => d.attached && d.width > 0);
		if (!devices || !usable?.length) {
			Logger.warn('Could not enumerate displays; preferred monitor unchanged');
			return;
		}
		const primary = usable.find(d => d.primary) ?? usable[0];

		if (hasCurrent && ours === undefined) {
			const pinned = devices.find(d => d.index === current);
			const broken = !pinned || !pinned.attached || !pinned.primary;
			if (!broken) {
				Preferences.data = { vmmfWrittenIndex: current };
				Logger.info(`Adopting existing preferred monitor ${current} as chosen`);
				return;
			}
			Logger.warn(
				`Preferred monitor ${current} (${
					pinned ? pinned.deviceName : 'missing'
				}) is ${
					!pinned || !pinned.attached
						? 'not attached'
						: 'not the primary display'
				}; healing to ${primary.index}`
			);
		} else if (hasCurrent && current !== ours) {
			Logger.info(
				`Preferred monitor ${current} was set manually; leaving it alone`
			);
			Preferences.data = { vmmfWrittenIndex: current };
			return;
		} else if (hasCurrent && current === primary.index) {
			return;
		}

		await fs
			.writeFile(vmmfCfg, `${primary.index}\n`, 'utf8')
			.then(() => {
				Preferences.data = { vmmfWrittenIndex: primary.index };
				Logger.info(
					`Preferred monitor set to ${primary.index} (${primary.deviceName} ${primary.width}x${primary.height})`
				);
			})
			.catch(e => Logger.warn('Failed to write preferred monitor', e));
	}

	async verify() {
		this.load();
		this._notifyObservers();

		const clientDir = Preferences.data?.clientDir;

		if (clientDir) {
			await this.#syncPreferredMonitor(clientDir);
		}

		const missing: string[] = [];
		let dxvkRepair = false;
		for (const m of MODS) {
			// disabled mods: leave dlls.txt and installed state untouched
			if (m.disabled) continue;

			const state = Preferences.data?.mods?.[m.id];
			let installedVersion = state?.installedVersion;

			// torrent mode: DLLs ship in the client; a missing file goes to `missing`, not dirty
			if (isTorrentMode()) {
				const enabled = state?.enabled ?? DEFAULT_ENABLED_MODS.includes(m.id);
				// dxvk loads by file presence and torrent piece spillover can
				// corrupt it; hash-verify every state: park/restore verified
				// copies only, delete junk, re-download the pin when needed
				if (m.id === 'dxvk' && clientDir) {
					const live = path.join(clientDir, 'd3d9.dll');
					const off = path.join(clientDir, 'd3d9.dll.off');
					const liveSha = await fileSha256(live);
					if (!enabled) {
						if (liveSha === DXVK_DLL_SHA256 && !(await fs.pathExists(off))) {
							await fs
								.move(live, off)
								.then(() => Logger.info('dxvk disabled: parked d3d9.dll'))
								.catch(e => Logger.warn('Could not park d3d9.dll', e));
						} else if (liveSha !== null) {
							await fs.remove(live).catch(() => undefined);
						}
					} else if (liveSha !== DXVK_DLL_SHA256) {
						if (liveSha !== null) {
							Logger.warn('dxvk: d3d9.dll failed verification; replacing');
							await fs.remove(live).catch(() => undefined);
						}
						const offSha = await fileSha256(off);
						if (offSha === DXVK_DLL_SHA256) {
							await fs
								.move(off, live)
								.then(() => Logger.info('dxvk enabled: restored d3d9.dll'))
								.catch(e => Logger.warn('Could not restore d3d9.dll', e));
						} else {
							if (offSha !== null) await fs.remove(off).catch(() => undefined);
							dxvkRepair = true;
						}
					}
				}
				const files = modTargetFiles(m);
				const present =
					!!clientDir &&
					files.length > 0 &&
					(
						await Promise.all(
							files.map(rel => fs.pathExists(path.join(clientDir, rel)))
						)
					).every(Boolean);
				installedVersion = enabled ? m.version : undefined;
				if (enabled && files.length > 0 && !present) missing.push(m.name);
				// only point dlls.txt at a file actually on disk
				if (clientDir && m.registerInDllsTxt)
					await (present && enabled
						? addDll(clientDir, m.registerInDllsTxt)
						: removeDll(clientDir, m.registerInDllsTxt)
					).catch(e => Logger.warn(`dlls.txt update failed for ${m.id}`, e));
				const dxvkDriverTooOld =
					m.id === 'dxvk' && enabled && (await nvidiaDriverTooOldForDxvk());
				this.#patchRow(m.id, {
					installedVersion,
					latestVersion: m.version,
					enabled,
					ignoreUpdates: true,
					...(dxvkDriverTooOld
						? {
								state: 'error',
								error:
									'Your NVIDIA driver is too old for DXVK (needs 550.54.14 or ' +
									'newer, ideally 575.51.02+). Update your driver, or disable ' +
									'DXVK to avoid crashes on launch.'
						  }
						: {})
				});
				continue;
			}

			if (clientDir && installedVersion) {
				const filesPresent = await Promise.all(
					(state?.installedFiles ?? []).map(rel =>
						fs.pathExists(path.join(clientDir, rel))
					)
				);
				if (state?.installedFiles?.length && !filesPresent.every(Boolean)) {
					installedVersion = undefined;
					await this.#savePref(m.id, {
						enabled: state?.enabled ?? false,
						installedVersion: undefined,
						installedFiles: [],
						ignoreUpdates: state?.ignoreUpdates ?? false
					});
				}
			}

			if (clientDir && m.registerInDllsTxt)
				await (installedVersion
					? addDll(clientDir, m.registerInDllsTxt)
					: removeDll(clientDir, m.registerInDllsTxt)
				).catch(() => {});

			this.#patchRow(m.id, {
				installedVersion,
				latestVersion: m.version,
				enabled: !!state?.enabled,
				ignoreUpdates: !!state?.ignoreUpdates
			});
		}

		if (dxvkRepair) {
			const dm = getMod('dxvk');
			if (dm)
				await this.#install(dm).catch(e =>
					Logger.warn('dxvk repair download failed', e)
				);
		}

		this._value = {
			...this._value,
			state: 'idle',
			dirty: this.#computeDirty(),
			custom: clientDir ? await this.#detectCustomDlls(clientDir) : [],
			missingFiles: missing
		};
		this._notifyObservers();
	}

	async toggleCustom(name: string, enabled: boolean) {
		const clientDir = Preferences.data?.clientDir;
		if (!clientDir) return;
		// stage; matching dlls.txt clears the pending change
		const lc = name.toLowerCase();
		if (enabled === !!this.#customApplied.get(lc))
			this.#customDesired.delete(lc);
		else this.#customDesired.set(lc, enabled);
		this._value = {
			...this._value,
			custom: await this.#detectCustomDlls(clientDir)
		};
		this._value = { ...this._value, dirty: this.#computeDirty() };
		this._notifyObservers();
	}

	async addCustomDll(
		srcPath: string
	): Promise<{ ok: boolean; error?: string }> {
		const clientDir = Preferences.data?.clientDir;
		if (!clientDir) return { ok: false, error: 'No game folder is set.' };
		const name = path.basename(srcPath);
		if (!/\.dll$/i.test(name))
			return { ok: false, error: 'Please choose a .dll file.' };
		const lc = name.toLowerCase();
		if (RESERVED_DLLS.has(lc) || KNOWN_DLLS.has(lc))
			return {
				ok: false,
				error: `${name} is a built-in file and can't be added as a custom mod.`
			};
		try {
			const dest = path.join(clientDir, name);
			if (path.resolve(srcPath) !== path.resolve(dest))
				await fs.copy(srcPath, dest, { overwrite: true });
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		// stage enabled; Apply writes dlls.txt
		this.#customDesired.set(name.toLowerCase(), true);
		this._value = {
			...this._value,
			custom: await this.#detectCustomDlls(clientDir)
		};
		this._value = { ...this._value, dirty: this.#computeDirty() };
		this._notifyObservers();
		return { ok: true };
	}

	async toggle(id: ModId, enabled: boolean) {
		const cur = Preferences.data?.mods?.[id];
		await this.#savePref(id, {
			enabled,
			installedVersion: cur?.installedVersion,
			installedFiles: cur?.installedFiles ?? [],
			ignoreUpdates: cur?.ignoreUpdates ?? false
		});
		this.#patchRow(id, { enabled });
	}

	async setIgnoreUpdates(id: ModId, ignore: boolean) {
		const cur = Preferences.data?.mods?.[id];
		await this.#savePref(id, {
			enabled: cur?.enabled ?? false,
			installedVersion: cur?.installedVersion,
			installedFiles: cur?.installedFiles ?? [],
			ignoreUpdates: ignore
		});
		this.#patchRow(id, { ignoreUpdates: ignore });
	}

	async applyAll(opts: { repairOnly?: boolean } = {}) {
		const clientDir = Preferences.data?.clientDir;
		if (!clientDir) {
			Logger.warn('No clientDir set; cannot apply mods.');
			return;
		}
		// don't commit a mod set with an unmet dependency; dirty stays set. repair is exempt.
		if (!opts.repairOnly) {
			const enabledIds = new Set(
				this._value.mods.filter(r => r.enabled).map(r => r.id)
			);
			const missingDeps = [
				...new Set(
					this._value.mods
						.filter(r => r.enabled)
						.flatMap(r => r.requires.filter(dep => !enabledIds.has(dep)))
				)
			];
			if (missingDeps.length) {
				Logger.warn(
					`Not applying mods: unmet dependencies ${missingDeps.join(', ')}`
				);
				return;
			}
		}
		// commit the player's own DLL toggles first
		await this.#applyCustomDlls(clientDir);
		// torrent mode: mods ship in the client; reconcile dlls.txt. The
		// seeder holds files open, so release it for the dxvk park/restore.
		if (isTorrentMode()) {
			stopSeeding();
			try {
				await this.verify();
			} finally {
				await Updater.refreshSeeding().catch(() => undefined);
			}
			return;
		}
		if (this._value.state === 'busy') {
			Logger.warn('applyAll already running; ignoring re-entrant call.');
			return;
		}
		await this.verify();
		this._value = { ...this._value, state: 'busy' };
		this._notifyObservers();

		const queue = [...this._value.mods];
		queue.sort((a, b) => {
			if (a.id === 'vanillaFixes') return -1;
			if (b.id === 'vanillaFixes') return 1;
			return 0;
		});

		const failures = new Map<ModId, string>();
		for (const row of queue) {
			const m = getMod(row.id);
			if (!m) continue;

			const wantInstalled = row.enabled;
			const isInstalled = !!row.installedVersion;
			const updateAvailable =
				isInstalled &&
				row.installedVersion !== row.latestVersion &&
				!row.ignoreUpdates;

			try {
				if (wantInstalled && !isInstalled) {
					await this.#install(m);
				} else if (!wantInstalled && isInstalled) {
					await this.#uninstall(m);
				} else if (wantInstalled && updateAvailable && !opts.repairOnly) {
					await this.#uninstall(m);
					await this.#install(m);
				}
			} catch (e) {
				Logger.error(`Failed to apply ${m.id}:`, e);
				const msg = e instanceof Error ? e.message : String(e);
				failures.set(m.id, looksLikeAvBlock(msg) ? AV_ERROR : msg);
			}
		}

		this._value = { ...this._value, state: 'idle' };
		await this.verify();
		for (const [id, error] of failures)
			this.#patchRow(id, { state: 'error', error });
		await Updater.verify();
	}

	async #install(m: ModEntry) {
		const clientDir = Preferences.data?.clientDir;
		// dxvk: restoring a parked copy is the only enable path that works in
		// torrent mode (nothing is fetched there, the sync ignores d3d9.dll)
		if (m.id === 'dxvk' && clientDir) {
			const live = path.join(clientDir, 'd3d9.dll');
			const off = path.join(clientDir, 'd3d9.dll.off');
			if (!(await fs.pathExists(live)) && (await fs.pathExists(off))) {
				Logger.info('Restoring parked d3d9.dll for dxvk');
				await fs.move(off, live);
				await this.#savePref(m.id, {
					enabled: true,
					installedVersion: m.version,
					installedFiles: ['d3d9.dll'],
					ignoreUpdates: Preferences.data?.mods?.[m.id]?.ignoreUpdates ?? false
				});
				this.#patchRow(m.id, {
					state: 'idle',
					installedVersion: m.version,
					progress: 1
				});
				return;
			}
		}
		// torrent mode ships mod binaries with the client; dxvk is the
		// exception (unsynced), a fresh enable with no parked copy downloads
		if (isTorrentMode() && m.id !== 'dxvk') return;
		if (!clientDir) throw new Error('No client dir');
		if (m.source.kind === 'managed') return;

		Logger.info(`Installing mod ${m.id}...`);
		this.#patchRow(m.id, {
			state: 'downloading',
			progress: 0,
			error: undefined
		});

		const written: string[] = [];
		const missing: string[] = [];

		if (m.source.kind === 'directFile') {
			const dest = path.join(clientDir, m.source.assetName);
			await this.#downloadTo(m.source.url, dest, m.source.sha256);
			written.push(m.source.assetName);
		} else if (m.source.kind === 'archive') {
			const scratch = path.join(clientDir, '.octolauncher-tmp');
			await fs.ensureDir(scratch);
			const tmp = path.join(
				scratch,
				`${m.id}-${Date.now()}.${m.source.format}`
			);
			await this.#downloadTo(m.source.url, tmp, m.source.sha256);
			this.#patchRow(m.id, { state: 'installing' });

			const map = m.source.extractMap;
			if (m.source.format === 'zip') {
				const zip = new AdmZip(tmp);
				const entries = zip.getEntries();
				for (const [src, dst] of Object.entries(map)) {
					const entry = entries.find(e => e.entryName === src);
					if (!entry) {
						missing.push(src);
						continue;
					}
					const target = path.join(clientDir, dst);
					await fs.ensureDir(path.dirname(target));
					await fs.writeFile(target, entry.getData());
					written.push(dst);
				}
			} else {
				const stagingDir = path.join(scratch, `${m.id}-${Date.now()}-extract`);
				await fs.ensureDir(stagingDir);
				await tar.x({ file: tmp, cwd: stagingDir });
				for (const [src, dst] of Object.entries(map)) {
					const srcPath = path.join(stagingDir, src);
					if (!(await fs.pathExists(srcPath))) {
						missing.push(src);
						continue;
					}
					const target = path.join(clientDir, dst);
					await fs.ensureDir(path.dirname(target));
					await fs.copy(srcPath, target);
					written.push(dst);
				}
				await fs.remove(stagingDir).catch(() => {});
			}
			await fs.remove(tmp).catch(() => {});
		}

		if (missing.length)
			throw new Error(
				`${m.name}: download is missing expected file(s): ${missing.join(', ')}`
			);

		if (m.registerInDllsTxt) {
			await addDll(clientDir, m.registerInDllsTxt);
		}

		await this.#savePref(m.id, {
			enabled: true,
			installedVersion: m.version,
			installedFiles: written,
			ignoreUpdates: Preferences.data?.mods?.[m.id]?.ignoreUpdates ?? false
		});

		this.#patchRow(m.id, {
			state: 'idle',
			installedVersion: m.version,
			progress: 1
		});
	}

	async #uninstall(m: ModEntry) {
		const clientDir = Preferences.data?.clientDir;
		if (!clientDir) throw new Error('No client dir');
		if (m.source.kind === 'managed') return;

		Logger.info(`Uninstalling mod ${m.id}...`);
		this.#patchRow(m.id, { state: 'uninstalling', error: undefined });

		const cur = Preferences.data?.mods?.[m.id];
		// dxvk: park instead of delete so re-enable is instant and offline
		const files = [...(cur?.installedFiles ?? [])].filter(
			f => !(m.id === 'dxvk' && /d3d9\.dll$/i.test(f))
		);
		if (m.id === 'dxvk') {
			const live = path.join(clientDir, 'd3d9.dll');
			const off = path.join(clientDir, 'd3d9.dll.off');
			if (await fs.pathExists(live)) {
				await fs.remove(off).catch(() => undefined);
				await fs
					.move(live, off)
					.catch(err => Logger.warn(`Couldn't park ${live}:`, err));
			}
		}

		for (const rel of files) {
			const fullPath = path.join(clientDir, rel);
			await fs
				.remove(fullPath)
				.catch(err => Logger.warn(`Couldn't remove ${fullPath}:`, err));
		}

		if (m.registerInDllsTxt) {
			await removeDll(clientDir, m.registerInDllsTxt);
		}

		await this.#savePref(m.id, {
			enabled: cur?.enabled ?? false,
			installedVersion: undefined,
			installedFiles: [],
			ignoreUpdates: cur?.ignoreUpdates ?? false
		});

		this.#patchRow(m.id, { state: 'idle', installedVersion: undefined });
	}

	async #downloadTo(url: string, dest: string, sha256?: string) {
		const res = await fetch(url, {
			headers: { 'User-Agent': 'OctoLauncher' },
			timeout: MOD_DOWNLOAD_TIMEOUT_MS
		});
		if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
		await fs.ensureDir(path.dirname(dest));
		const buf = await res.arrayBuffer();

		if (sha256) {
			const got = createHash('sha256').update(Buffer.from(buf)).digest('hex');
			if (got !== sha256.toLowerCase())
				throw new Error(
					`Checksum mismatch for ${path.basename(
						dest
					)}: expected ${sha256}, got ${got}. Refusing to install.`
				);
		}

		await fs.writeFile(dest, Buffer.from(buf));
		if (!(await fs.pathExists(dest)))
			throw new Error(
				`Downloaded file disappeared after writing: ${path.basename(dest)}. ` +
					'This is often Windows Defender quarantine; if so, use "Allow through antivirus" and apply again.'
			);
	}

	async #savePref(id: ModId, state: ModState) {
		const allMods = { ...(Preferences.data?.mods ?? {}), [id]: state };
		Preferences.data = { mods: allMods };
	}
}

const Mods = new ModsClass();
export default Mods;
