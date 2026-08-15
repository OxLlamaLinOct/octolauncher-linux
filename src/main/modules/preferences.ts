import path from 'path';

import fs from 'fs-extra';
import { type z } from 'zod';
import { app } from 'electron';
import Logger from 'electron-log/main';

import { PreferencesSchema } from '~common/schemas';
import { DEFAULT_ENABLED_MODS } from '~common/mods';
import { isTorrentMode } from '~main/modules/aria2';

const errCode = (e: unknown) =>
	e && typeof e === 'object' ? (e as NodeJS.ErrnoException).code : undefined;

const LOCK_CODES = ['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE'];
const isLocked = (e: unknown) => LOCK_CODES.includes(errCode(e) ?? '');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const readJsonRetrying = async (file: string, attempts = 5) => {
	for (let i = 0; ; i++) {
		try {
			return await fs.readJSON(file);
		} catch (e) {
			if (i >= attempts - 1 || !isLocked(e)) throw e;
			await delay(60 * (i + 1));
		}
	}
};

const renameRetrying = async (from: string, to: string, attempts = 5) => {
	for (let i = 0; ; i++) {
		try {
			return await fs.rename(from, to);
		} catch (e) {
			if (i >= attempts - 1 || !isLocked(e)) throw e;
			await delay(60 * (i + 1));
		}
	}
};

const writeJsonAtomic = async (file: string, data: unknown) => {
	const tmp = `${file}.tmp`;
	await fs.writeJSON(tmp, data, { spaces: 2 });
	await renameRetrying(tmp, file);
};

const dropUndefined = <T extends object>(obj: T): Partial<T> =>
	Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined)
	) as Partial<T>;

abstract class Preferences {
	static #data: z.infer<typeof PreferencesSchema>;
	static #writeChain: Promise<void> = Promise.resolve();
	static #readOnly = false;
	static #rememberedClientDir?: string;
	static #freshInstall = false;

	static readonly userDataDir = app.getPath('userData');

	static readonly #settingsPath = path.join(
		Preferences.userDataDir,
		'settings.json'
	);

	static readonly #installPath = path.join(
		Preferences.userDataDir,
		'install.json'
	);

	static get isFreshInstall() {
		return this.#freshInstall;
	}

	static async #detectFreshInstall() {
		const [settings, install, pending] = await Promise.all([
			fs.pathExists(this.#settingsPath),
			fs.pathExists(this.#installPath),
			fs.pathExists(`${this.#settingsPath}.tmp`)
		]);
		return !settings && !install && !pending;
	}

	static #withFreshInstallDefaults(data: PreferencesSchema): PreferencesSchema {
		if (!this.#freshInstall || Object.keys(data.mods).length) return data;

		// fresh installs seed every mod EXPLICITLY off; a missing row falls
		// back to enabled, which keeps legacy profiles untouched
		const mods = { ...data.mods };
		for (const id of DEFAULT_ENABLED_MODS)
			mods[id] = { enabled: false, installedFiles: [], ignoreUpdates: false };

		Logger.info('Fresh install: all mods start disabled (opt-in)');
		return { ...data, mods };
	}

	static async load() {
		this.#freshInstall = await this.#detectFreshInstall();
		await fs.ensureDir(this.userDataDir);
		const settingsPath = this.#settingsPath;

		let json: Record<string, unknown> = {};
		try {
			json = await readJsonRetrying(settingsPath);
		} catch (e) {
			if (isLocked(e)) {
				this.#readOnly = true;
				Logger.error(
					`Could not read ${settingsPath} (${errCode(e)}); running on ` +
						'defaults and leaving settings untouched for this session.',
					e
				);
			} else {
				if (errCode(e) !== 'ENOENT') {
					Logger.warn(`${settingsPath} is unreadable; keeping a copy`, e);
					await fs
						.copy(settingsPath, `${settingsPath}.corrupt`)
						.catch(() => {});
				}
				const recovered = await fs
					.readJSON(`${settingsPath}.tmp`)
					.catch(() => null);
				if (recovered && typeof recovered === 'object') {
					Logger.warn(`Recovered settings from ${settingsPath}.tmp`);
					json = recovered as Record<string, unknown>;
				}
			}
		}

		const parsed = PreferencesSchema.safeParse(json);
		if (parsed.success)
			return this.#withKnownClientDir(
				this.#withFreshInstallDefaults(parsed.data)
			);

		Logger.warn(
			'settings.json failed validation; salvaging valid fields',
			parsed.error
		);
		await fs.copy(settingsPath, `${settingsPath}.corrupt`).catch(() => {});

		const salvaged: Record<string, unknown> = {};
		const shape = PreferencesSchema.shape;
		for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
			if (!(key in json)) continue;
			const value = (json as Record<string, unknown>)[key];
			if (shape[key].safeParse(value).success) salvaged[key] = value;
		}
		// defaults if even the salvaged set is invalid; never throw out of load()
		const salvagedParsed = PreferencesSchema.safeParse(salvaged);
		return this.#withKnownClientDir(
			salvagedParsed.success ? salvagedParsed.data : PreferencesSchema.parse({})
		);
	}

	static async #withKnownClientDir(data: PreferencesSchema) {
		const remembered = await fs
			.readJSON(this.#installPath)
			.then(j => {
				const dir = (j as { clientDir?: unknown })?.clientDir;
				return typeof dir === 'string' && dir ? dir : undefined;
			})
			.catch(() => undefined);
		this.#rememberedClientDir = remembered;

		if (await this.isValidClientDir(data.clientDir)) return data;
		if (!remembered || remembered === data.clientDir) return data;
		if (!(await this.isValidClientDir(remembered))) return data;

		Logger.warn(
			`No usable clientDir in settings.json; restored "${remembered}" from ${
				this.#installPath
			}`
		);
		return { ...data, clientDir: remembered };
	}

	static get data(): PreferencesSchema {
		return this.#data;
	}

	static set data(newData: Partial<PreferencesSchema>) {
		this.#data = { ...this.#data, ...newData };

		if (this.#readOnly) return;

		const settingsPath = this.#settingsPath;
		const delta = dropUndefined(newData);
		const snapshot = dropUndefined(this.#data);
		this.#writeChain = this.#writeChain
			.then(async () => {
				let base: Record<string, unknown> | null = null;
				try {
					const onDisk = await readJsonRetrying(settingsPath);
					base =
						!!onDisk && typeof onDisk === 'object' && !Array.isArray(onDisk)
							? (onDisk as Record<string, unknown>)
							: null;
				} catch (e) {
					if (isLocked(e)) {
						Logger.error(
							`Skipping settings write; ${settingsPath} is locked (${errCode(
								e
							)})`,
							e
						);
						return;
					}
				}
				const merged = base ? { ...base, ...delta } : snapshot;
				await writeJsonAtomic(settingsPath, merged);

				const clientDir = (merged as { clientDir?: unknown }).clientDir;
				if (
					typeof clientDir === 'string' &&
					clientDir &&
					clientDir !== this.#rememberedClientDir
				) {
					this.#rememberedClientDir = clientDir;
					await writeJsonAtomic(this.#installPath, { clientDir }).catch(e =>
						Logger.warn(`Failed to write ${this.#installPath}`, e)
					);
				}
			})
			.catch(e => Logger.error('Failed to persist settings.json', e));
	}

	static save() {
		return this.#writeChain;
	}

	static async isValidClientDir(clientDir?: string) {
		if (!clientDir) return false;
		if (await fs.exists(path.join(clientDir, 'WoW.exe'))) return true;
		// torrent mode: no WoW.exe yet, accept a dir the download can populate
		if (isTorrentMode())
			return (
				(await fs.exists(clientDir)) ||
				(await fs.exists(path.dirname(clientDir)))
			);
		return false;
	}
}

export default Preferences;
