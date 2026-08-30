import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import fs from 'fs-extra';
import Logger from 'electron-log/main';

import Preferences from './preferences';
import Observable from './observable';

export type ProtonInstall = {
	name: string;
	protonPath: string;
	steamRoot: string;
};

export type ProtonStatus =
	| { state: 'searching' }
	| { state: 'missing' }
	| { state: 'ready'; selected: ProtonInstall; installs: ProtonInstall[] };

const STEAM_ROOTS = [
	path.join(os.homedir(), '.local/share/Steam'),
	path.join(os.homedir(), '.steam/steam'),
	path.join(os.homedir(), '.var/app/com.valvesoftware.Steam/.local/share/Steam')
];

const PROTON_VERSION_HINT = '9.0';

const parseLibraryFolders = async (steamRoot: string): Promise<string[]> => {
	const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
	const libraries = [steamRoot];
	try {
		const raw = await fs.readFile(vdfPath, 'utf8');
		const matches = raw.matchAll(/"path"\s+"([^"]+)"/g);
		for (const m of matches) {
			const lib = m[1].replace(/\\\\/g, '/');
			if (!libraries.includes(lib)) libraries.push(lib);
		}
	} catch {
		// No libraryfolders.vdf (or unreadable) - fall back to the root itself.
	}
	return libraries;
};

const readDisplayName = async (dir: string, fallback: string) => {
	try {
		const raw = await fs.readFile(path.join(dir, 'version'), 'utf8');
		const label = raw.trim().split(/\s+/).slice(1).join(' ');
		return label || fallback;
	} catch {
		return fallback;
	}
};

const scanForProtonInstalls = async (
	dir: string,
	steamRoot: string
): Promise<ProtonInstall[]> => {
	let entries: fs.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const found: ProtonInstall[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const protonPath = path.join(dir, entry.name);
		if (!(await fs.pathExists(path.join(protonPath, 'proton')))) continue;
		found.push({
			name: await readDisplayName(protonPath, entry.name),
			protonPath,
			steamRoot
		});
	}
	return found;
};

export const findProtonInstalls = async (): Promise<ProtonInstall[]> => {
	const found: ProtonInstall[] = [];

	for (const steamRoot of STEAM_ROOTS) {
		if (!(await fs.pathExists(steamRoot))) continue;

		const libraries = await parseLibraryFolders(steamRoot);
		for (const lib of libraries)
			found.push(
				...(await scanForProtonInstalls(
					path.join(lib, 'steamapps', 'common'),
					steamRoot
				))
			);

		found.push(
			...(await scanForProtonInstalls(
				path.join(steamRoot, 'compatibilitytools.d'),
				steamRoot
			))
		);
	}

	// De-dupe by resolved path, then prefer the version we know works, then
	// newest-looking names first.
	const unique = Array.from(
		new Map(found.map(p => [p.protonPath, p])).values()
	);
	unique.sort((a, b) => {
		const aHint = a.name.includes(PROTON_VERSION_HINT) ? 0 : 1;
		const bHint = b.name.includes(PROTON_VERSION_HINT) ? 0 : 1;
		if (aHint !== bHint) return aHint - bHint;
		return b.name.localeCompare(a.name, undefined, { numeric: true });
	});
	return unique;
};

class ProtonClass extends Observable<ProtonStatus> {
	protected _value: ProtonStatus = { state: 'searching' };

	get status(): ProtonStatus {
		return this._value;
	}

	private set status(v: ProtonStatus) {
		this._value = v;
		this._notifyObservers(v);
	}

	async verify() {
		this.status = { state: 'searching' };
		const installs = await findProtonInstalls();
		if (!installs.length) {
			this.status = { state: 'missing' };
			return;
		}

		const overridePath = Preferences.data?.protonOverridePath;
		const selected =
			installs.find(i => i.protonPath === overridePath) ?? installs[0];
		this.status = { state: 'ready', selected, installs };
	}

	async setOverride(protonPath: string | undefined) {
		Preferences.data = { protonOverridePath: protonPath };
		await this.verify();
	}

	getPrefixDir() {
		return (
			Preferences.data?.protonPrefixDir ??
			path.join(Preferences.userDataDir, 'proton-prefix')
		);
	}

	async resetPrefix() {
		await fs.remove(this.getPrefixDir());
		Logger.info('Proton prefix reset');
	}

	async relocatePrefix(newDir: string) {
		const currentDir = this.getPrefixDir();
		const resolvedNew = path.resolve(newDir);
		if (resolvedNew === path.resolve(currentDir)) return;

		if (await fs.pathExists(resolvedNew)) {
			const entries = await fs.readdir(resolvedNew);
			if (entries.length)
				throw new Error(
					'That folder is not empty. Pick an empty or new folder for the prefix.'
				);
		}

		if (await fs.pathExists(currentDir)) {
			await fs.move(currentDir, resolvedNew, { overwrite: true });
			Logger.info(`Proton prefix moved to ${resolvedNew}`);
		} else {
			Logger.info(
				`No existing prefix to move; new prefix will be created at ${resolvedNew}`
			);
		}

		Preferences.data = { protonPrefixDir: resolvedNew };
	}
}

const Proton = new ProtonClass();
export default Proton;

export type LaunchInvocation = {
	command: string;
	args: string[];
	env: Record<string, string>;
};

// the 32-bit 1.12 client has a genuine, ~20-year-old unsynchronized
// lazy-init race on one of its own critical sections (confirmed by direct
// disassembly of the shipped WoW.exe against the exact ntdll.dll a report
// used - WoW.exe never writes the corrupt value itself, but nothing guards
// the read either). Real 2+-core parallelism is enough to lose that race
// (confirmed on affected hardware even capped to 2 or 4 cores); only pinning
// to exactly one core, combined with faking a 1-core CPU topology, reliably
// avoids it. The 1.12 client itself never scales past a couple of small
// helper threads, so this costs nothing real.
//
// This has to be a hard OS-level pin from WoW.exe's very first instruction -
// applying it retroactively (e.g. `taskset -p` once the process is detected
// running) leaves a real window where the process is scheduled across every
// core before we catch up, which is enough to lose the race anyway. So the
// whole `proton run` invocation is wrapped in taskset, not just the exe.
// To avoid that throttling Proton's own prefix bootstrap (mono/gecko/
// vcredist installers on a fresh or version-upgraded prefix) down to one
// core - which can make a first launch look hung for minutes - warmPrefix()
// below forces that bootstrap to happen first, unthrottled, via a harmless
// wineboot invocation, before the real (pinned) launch ever starts.
const TASKSET_CANDIDATES = ['/usr/bin/taskset', '/bin/taskset'];
const findTaskset = async (): Promise<string | undefined> => {
	for (const p of TASKSET_CANDIDATES) if (await fs.pathExists(p)) return p;
	return undefined;
};

const protonEnv = (
	selected: ProtonInstall,
	prefixDir: string
): Record<string, string> => ({
	STEAM_COMPAT_DATA_PATH: prefixDir,
	STEAM_COMPAT_CLIENT_INSTALL_PATH: selected.steamRoot,
	// protonfixes' get_game_id() falls back to grabbing a number out of
	// STEAM_COMPAT_DATA_PATH when SteamAppId/SteamGameId aren't set, and
	// throws an uncaught IndexError (killing the launch before WoW.exe even
	// starts) when our prefix path has no digits in it at all. Setting a
	// harmless placeholder app id short-circuits that lookup.
	SteamAppId: '0',
	SteamGameId: '0'
});

// Forces prefix creation/upgrade (mono/gecko/vcredist installers) to run to
// completion, unthrottled, ahead of the real launch - `proton run` performs
// this bootstrap as a preamble no matter what command it's given, so
// `wineboot` (always present, effectively a no-op once the prefix is
// current) is a safe, cheap way to trigger it on its own.
export const warmPrefix = async (): Promise<void> => {
	if (Proton.status.state !== 'ready') await Proton.verify();
	if (Proton.status.state !== 'ready') return;

	const { selected } = Proton.status;
	const prefixDir = Proton.getPrefixDir();
	await fs.ensureDir(prefixDir);

	Logger.info('Preparing Proton prefix...');
	await new Promise<void>(resolve => {
		execFile(
			'python3',
			[path.join(selected.protonPath, 'proton'), 'run', 'wineboot'],
			{
				env: { ...process.env, ...protonEnv(selected, prefixDir) },
				timeout: 15 * 60_000
			},
			error => {
				if (error)
					Logger.warn(
						`Prefix warm-up did not finish cleanly (continuing anyway): ${error.message}`
					);
				else Logger.info('Proton prefix ready');
				resolve();
			}
		);
	});
};

// Works around a Wine startup race, confirmed via a winedbg write-watchpoint
// plus static disassembly of the actual crash site: wined3d spins up its own
// background thread early on to create a throwaway window + GL context and
// probe adapter capabilities (used even for the pure-OpenGL path, since
// opengl32 shares wined3d's adapter plumbing) - independent of the game's
// own window. That thread can lose Wine's nodrv_CreateWindow race just like
// a real window can (winediag logs "Application tried to create a window,
// but no driver could be loaded" / "The explorer process failed to start"
// when this happens), and when its GL context creation fails as a result,
// WoW.exe's own error handler responds by nulling a "current adapter"
// pointer that later, unrelated-looking code dereferences with no null
// check while logging two of its fields - crashing with Error #132
// (ACCESS_VIOLATION) before Logs/gx.log ever gets a line written to it.
//
// Confirmed live (2026-08-30) on a KVM VM using virtio-gpu-gl/virgl GPU
// passthrough: this is the exact same nodrv mechanism, but the race window
// is wide enough there that a single fixed-duration throwaway launch loses
// it 100% of the time, not just occasionally - the driver init chain
// (SPICE -> virgl -> host GBM/EGL) is longer than a native GPU's X11/GLX
// path, so "wait N seconds and hope" doesn't reliably work on every host.
// So instead of one timed attempt, this retries a short-lived, unpinned
// throwaway launch of the target executable until an attempt completes
// without hitting nodrv (checked by watching its stderr for
// "nodrv_CreateWindow", which Wine's err-level winediag messages print
// unconditionally, no WINEDEBUG flags needed), up to a bounded number of
// tries - giving wider-race-window hosts more real shots at winning it
// instead of silently giving up after a duration that only happens to be
// long enough on some machines. Each attempt doesn't need to fully boot the
// game or even avoid the crash itself, only to let the X11 driver/window-
// manager side of the race settle once. launcher.ts only calls this as a
// one-time retry after detecting the specific crash signature above, not
// unconditionally on every launch.
const GRAPHICS_WARMUP_ATTEMPT_TIMEOUT_MS = 10_000;
const GRAPHICS_WARMUP_MAX_ATTEMPTS = 5;

export const warmupGraphics = async (exePath: string): Promise<void> => {
	if (Proton.status.state !== 'ready') await Proton.verify();
	if (Proton.status.state !== 'ready') return;

	const { selected } = Proton.status;
	const prefixDir = Proton.getPrefixDir();

	for (
		let attempt = 1;
		attempt <= GRAPHICS_WARMUP_MAX_ATTEMPTS;
		attempt++
	) {
		Logger.info(
			`Warming up graphics driver (attempt ${attempt}/${GRAPHICS_WARMUP_MAX_ATTEMPTS})...`
		);
		const hitNodrv = await new Promise<boolean>(resolve => {
			let sawNodrv = false;
			const child = execFile(
				'python3',
				[path.join(selected.protonPath, 'proton'), 'run', exePath],
				{
					env: { ...process.env, ...protonEnv(selected, prefixDir) },
					timeout: GRAPHICS_WARMUP_ATTEMPT_TIMEOUT_MS
				},
				() => resolve(sawNodrv)
			);
			child.stderr?.on('data', (d: Buffer) => {
				if (d.toString().includes('nodrv_CreateWindow')) sawNodrv = true;
			});
		});

		if (!hitNodrv) {
			Logger.info('Graphics warm-up succeeded (no nodrv fallback observed)');
			return;
		}
		Logger.warn(
			`Graphics warm-up attempt ${attempt} hit Wine's nodrv fallback ` +
				'(X11 driver not ready yet); retrying...'
		);
	}
	Logger.warn(
		'Graphics warm-up still hitting nodrv fallback after max attempts; ' +
			'proceeding to the real launch anyway'
	);
};

export const getLaunchInvocation = async (
	exePath: string,
	extraArgs: string[] = [],
	allowMultipleInstances = false
): Promise<LaunchInvocation> => {
	if (Proton.status.state !== 'ready') await Proton.verify();
	if (Proton.status.state !== 'ready')
		throw new Error(
			'No Proton installation found. Install Proton (e.g. via Steam) and try again.'
		);

	const { selected } = Proton.status;
	const prefixDir = Proton.getPrefixDir();
	await fs.ensureDir(prefixDir);

	Logger.info(
		`Launching via ${selected.name} (${selected.protonPath}), prefix: ${prefixDir}`
	);

	const protonArgs = [
		path.join(selected.protonPath, 'proton'),
		allowMultipleInstances ? 'run' : 'waitforexitandrun',
		exePath,
		...extraArgs
	];

	const tasksetPath = await findTaskset();
	Logger.info(
		tasksetPath
			? `Pinning WoW.exe to 1 core via ${tasksetPath}`
			: 'taskset not found; cannot pin WoW.exe to 1 core'
	);

	return {
		command: tasksetPath ?? 'python3',
		args: tasksetPath ? ['-c', '0', 'python3', ...protonArgs] : protonArgs,
		env: {
			...protonEnv(selected, prefixDir),
			...(tasksetPath ? { WINE_CPU_TOPOLOGY: '1:1' } : {})
		}
	};
};
