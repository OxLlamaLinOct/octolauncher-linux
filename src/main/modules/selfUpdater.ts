import { app, shell } from 'electron';
import fetch from 'node-fetch';
import { z } from 'zod';
import Logger from 'electron-log/main';
import { is } from '@electron-toolkit/utils';

import Observable from './observable';

const REPO = 'OxLlamaLinOct/octolauncher-linux';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 8_000;

export type SelfUpdaterStatus =
	| { state: 'idle'; currentVersion: string }
	| { state: 'checking'; currentVersion: string }
	| { state: 'unavailable'; currentVersion: string }
	| {
			state: 'available';
			currentVersion: string;
			nextVersion: string;
			releaseUrl: string;
	  }
	| { state: 'error'; currentVersion: string; message: string };

const GitHubReleaseSchema = z.object({
	tag_name: z.string(),
	html_url: z.string()
});

// Release tags look like "v1.2.3-linux" - strip that down to a bare "1.2.3"
// to compare against app.getVersion().
const bareVersion = (tag: string) =>
	tag.replace(/^v/i, '').replace(/-linux$/i, '');

const isNewer = (candidate: string, current: string) => {
	const a = candidate.split('.').map(Number);
	const b = current.split('.').map(Number);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const na = a[i] ?? 0;
		const nb = b[i] ?? 0;
		if (na !== nb) return na > nb;
	}
	return false;
};

class SelfUpdaterClass extends Observable<SelfUpdaterStatus> {
	protected _value: SelfUpdaterStatus = {
		state: 'idle',
		currentVersion: app.getVersion()
	};

	#initialized = false;

	get status(): SelfUpdaterStatus {
		return this._value;
	}

	private set status(v: SelfUpdaterStatus) {
		this._value = v;
		this._notifyObservers();
	}

	async init() {
		if (this.#initialized) return;
		this.#initialized = true;

		if (is.dev) {
			Logger.info('[selfUpdater] dev mode, skipping');
			return;
		}

		await this.check();
	}

	async check() {
		const currentVersion = app.getVersion();
		this.status = { state: 'checking', currentVersion };

		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(RELEASES_URL, {
				signal: controller.signal,
				headers: { Accept: 'application/vnd.github+json' }
			});
			if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);

			const parsed = GitHubReleaseSchema.safeParse(await res.json());
			if (!parsed.success) throw new Error('Malformed release response');

			const nextVersion = bareVersion(parsed.data.tag_name);
			if (!isNewer(nextVersion, currentVersion)) {
				Logger.info(`[selfUpdater] up to date (current: ${currentVersion})`);
				this.status = { state: 'unavailable', currentVersion };
				return;
			}

			Logger.info(`[selfUpdater] update available: ${nextVersion}`);
			this.status = {
				state: 'available',
				currentVersion,
				nextVersion,
				releaseUrl: parsed.data.html_url
			};
		} catch (err) {
			Logger.error('[selfUpdater] check failed', err);
			this.status = {
				state: 'error',
				currentVersion,
				message: err instanceof Error ? err.message : String(err)
			};
		} finally {
			clearTimeout(t);
		}
	}

	openReleasePage() {
		if (this._value.state !== 'available') return;
		shell.openExternal(this._value.releaseUrl);
	}
}

const SelfUpdater = new SelfUpdaterClass();
export default SelfUpdater;

export const initSelfUpdater = () => SelfUpdater.init();
