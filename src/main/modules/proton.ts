import os from 'node:os';
import path from 'node:path';

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
	path.join(
		os.homedir(),
		'.var/app/com.valvesoftware.Steam/.local/share/Steam'
	)
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

export const getLaunchInvocation = async (
	exePath: string,
	extraArgs: string[] = []
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

	return {
		command: 'python3',
		args: [
			path.join(selected.protonPath, 'proton'),
			'waitforexitandrun',
			exePath,
			...extraArgs
		],
		env: {
			STEAM_COMPAT_DATA_PATH: prefixDir,
			STEAM_COMPAT_CLIENT_INSTALL_PATH: selected.steamRoot
		}
	};
};
