import { type Worker, type WorkerOptions } from 'node:worker_threads';
import path from 'node:path';

import Logger from 'electron-log/main';
import fs from 'fs-extra';

import Preferences from './modules/preferences';

const isCallbackResponse = (
	data: unknown
): data is { cb: string; args: unknown[] } =>
	typeof data === 'object' &&
	data !== null &&
	'cb' in data &&
	typeof (data as { cb: unknown }).cb === 'string' &&
	'args' in data &&
	Array.isArray((data as { args: unknown }).args);

export const runWorker = <T>(
	worker: (o: WorkerOptions) => Worker,
	workerData: Record<string, unknown>,
	callbacks?: Record<string, (...data: any[]) => void>
) =>
	new Promise<T>((resolve, reject) =>
		worker({ workerData })
			.on('message', (m: unknown) => {
				if (!isCallbackResponse(m)) return resolve(m as T);
				const callback = callbacks?.[m.cb];
				if (callback) callback(...m.args);
				else Logger.warn('Unknown worker callback', m.cb);
			})
			.on('error', reject)
			.on('exit', code =>
				reject(new Error(`Worker exited (code ${code}) without finishing`))
			)
	);

export const getClientVersion = async () => {
	Logger.log('Reading client version...');

	const exePath = path.join(Preferences.data.clientDir ?? '', 'WoW.exe');

	if (!(await fs.exists(exePath))) {
		Logger.log('Client not found...');
		return undefined;
	}

	const file = await fs.readFile(exePath);
	const buffer = Buffer.from(file);

	const VERSION_OFFSET = 0x00437c04;
	const VERSION_LEN = 6;
	const BUILD_OFFSET = 0x00437bfc;
	const BUILD_LEN = 4;

	const version = buffer.toString(
		'utf-8',
		VERSION_OFFSET,
		VERSION_OFFSET + VERSION_LEN
	);
	const build = buffer.toString(
		'utf-8',
		BUILD_OFFSET,
		BUILD_OFFSET + BUILD_LEN
	);

	Logger.log(`Client version is: ${version} (${build})`);
	return `${version} (${build})`;
};
