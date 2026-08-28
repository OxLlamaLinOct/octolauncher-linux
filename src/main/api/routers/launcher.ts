import path from 'path';
import { spawn } from 'child_process';

import fs from 'fs-extra';
import Logger from 'electron-log/main';
import { z } from 'zod';

import Preferences from '~main/modules/preferences';
import Mods from '~main/modules/mods';
import { nvidiaDriverTooOldForDxvk } from '~main/modules/hardware';
import { mainWindow } from '~main/index';
import Updater, { isGameRunning } from '~main/modules/updater';
import {
	patchConfig,
	patchExecutable,
	ensureDxvkConf
} from '~main/modules/patcher';
import { removeLegacyLocalePatches } from '~main/modules/localePatch';
import { syncVanillaFixesCache } from '~main/modules/dllsTxt';
import { stopSeeding } from '~main/modules/aria2';
import { minimizeToTray, restoreFromTray } from '~main/modules/tray';
import {
	getLaunchInvocation,
	pinGameToOneCore,
	pidsOf
} from '~main/modules/proton';
import GameCrash from '~main/modules/gameCrash';
import { getMod } from '~common/mods';

import { createTRPCRouter, publicProcedure } from '../trpc';

const chainloaderNeeded = async (clientDir: string): Promise<boolean> => {
	const installed = Mods.status.mods.filter(r => r.installedVersion);
	if (installed.some(r => r.id === 'vanillaFixes')) return true;
	if (installed.some(r => getMod(r.id)?.requires?.includes('vanillaFixes')))
		return true;

	const dllsPath = path.join(clientDir, 'dlls.txt');
	if (await fs.pathExists(dllsPath)) {
		const raw = await fs.readFile(dllsPath, 'utf8');
		return raw.split(/\r?\n/).some(l => l.trim() && !l.trim().startsWith('#'));
	}
	return false;
};

type StartResult = {
	ok: boolean;
	error?: string;
	code?: 'dxvkDriverTooOld';
};

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// the client's own crash handler writes a timestamped report here on a
// trapped fault (access violation, etc) - grabbing the newest one written
// since launch turns "WoW stopped" into an actual diagnosable crash reason
// instead of just a process-exit event.
const CRASH_REPORT_MAX_CHARS = 8000;

const findCrashReport = async (
	clientDir: string,
	after: number
): Promise<{ file: string; content: string } | undefined> => {
	const errorsDir = path.join(clientDir, 'Errors');
	let entries: fs.Dirent[];
	try {
		entries = await fs.readdir(errorsDir, { withFileTypes: true });
	} catch {
		return undefined;
	}

	let newest: { name: string; mtimeMs: number } | undefined;
	for (const e of entries) {
		if (!e.isFile() || !/(error|crash).*\.txt$/i.test(e.name)) continue;
		const stat = await fs.stat(path.join(errorsDir, e.name)).catch(() => undefined);
		if (stat && stat.mtimeMs >= after && (!newest || stat.mtimeMs > newest.mtimeMs))
			newest = { name: e.name, mtimeMs: stat.mtimeMs };
	}
	if (!newest) return undefined;

	const raw = await fs
		.readFile(path.join(errorsDir, newest.name), 'utf8')
		.catch(() => undefined);
	if (!raw) return undefined;

	// the memory dump section is a giant hex blob with no diagnostic value here
	const content = raw
		.split('Memory Dump')[0]
		.trim()
		.slice(0, CRASH_REPORT_MAX_CHARS);
	return { file: newest.name, content };
};

// exitInfo is only available when we hold a direct child handle (not the
// VanillaFixes loader path, which can only poll for the process going away)
const handleGameStopped = async (
	clientDir: string,
	launchedAt: number,
	exitInfo?: { code: number | null; signal: NodeJS.Signals | null }
) => {
	const report = await findCrashReport(clientDir, launchedAt).catch(
		() => undefined
	);
	if (report)
		Logger.warn(`WoW crash report (Errors/${report.file}):\n${report.content}`);

	const crashed = !!report || (!!exitInfo && exitInfo.code !== 0);
	if (crashed && Preferences.data.showCrashDialog !== false)
		GameCrash.notify({
			code: exitInfo?.code ?? null,
			signal: exitInfo?.signal ?? null,
			reportFile: report?.file,
			reportContent: report?.content,
			at: Date.now()
		});
};

let starting = false;

export const launcherRouter = createTRPCRouter({
	start: publicProcedure
		.input(z.object({ force: z.boolean().optional() }).optional())
		.mutation(async ({ input }): Promise<StartResult> => {
			if (starting)
				return { ok: false, error: 'The game is already launching.' };
			starting = true;
			try {
				const {
					cleanWdb,
					minimizeToTrayOnPlay,
					clientDir,
					allowMultipleInstances
				} = Preferences.data;
				if (!clientDir) return { ok: false, error: 'No game folder is set.' };

				const exePath = path.join(clientDir, 'WoW.exe');
				if (!(await fs.pathExists(exePath)))
					return {
						ok: false,
						error: 'WoW.exe was not found in the game folder.'
					};
				if (!allowMultipleInstances && (await isGameRunning(exePath)))
					return { ok: false, error: 'WoW is already running.' };
				const gameAlreadyRunning = await isGameRunning(exePath);

				if (Mods.status.dirty)
					return {
						ok: false,
						error: 'You have unapplied mod changes. Click Apply first.'
					};

				const dxvkRow = Mods.status.mods.find(r => r.id === 'dxvk');
				if (
					!input?.force &&
					dxvkRow?.enabled &&
					(await nvidiaDriverTooOldForDxvk())
				)
					return {
						ok: false,
						code: 'dxvkDriverTooOld',
						error:
							'Your NVIDIA driver is too old for DXVK (needs 550.54.14 or ' +
							'newer, ideally 575.51.02+) and WoW will likely crash on launch. ' +
							'Update your driver, disable DXVK in the Mods tab, or launch ' +
							'anyway.'
					};

				stopSeeding();

				if (cleanWdb && !gameAlreadyRunning) {
					Logger.log('Cleaning up WDB...');
					await fs.remove(path.join(clientDir, 'WDB'));
				} else if (cleanWdb) {
					Logger.log(
						'Skipping WDB cleanup because another WoW instance is running.'
					);
				}

				Logger.log('Syncing preferred monitor...');
				await Mods.verify();

				Logger.log('Checking Config.wtf...');
				await patchConfig();
				await ensureDxvkConf(clientDir);

				await removeLegacyLocalePatches(clientDir);

				if (Preferences.data.patchedLocale !== Preferences.data.locale) {
					Logger.log(
						`Applying the client language (${Preferences.data.locale})...`
					);
					try {
						await patchExecutable();
						await patchConfig(true);
						await Updater.recordPatchedWow();
						if (!cleanWdb)
							await fs.remove(path.join(clientDir, 'WDB')).catch(() => {});
					} catch (e) {
						Logger.error(
							'Could not apply the client language; launching with the previous one',
							e
						);
					}
				}

				const loaderPath = path.join(clientDir, 'VanillaFixes.exe');
				const needsLoader = await chainloaderNeeded(clientDir);
				const useLoader = needsLoader && (await fs.pathExists(loaderPath));
				if (useLoader) await syncVanillaFixesCache(clientDir);
				if (needsLoader && !useLoader)
					Logger.warn(
						'VanillaFixes.exe is missing but mods/dlls.txt expect a chainloader; ' +
							'launching WoW.exe directly (mods will not load).'
					);

				Logger.log(
					useLoader
						? 'Launching via VanillaFixes...'
						: `Launching ${exePath}...`
				);

				let invocation;
				try {
					invocation = useLoader
						? await getLaunchInvocation(
								loaderPath,
								['WoW.exe'],
								!!allowMultipleInstances
						  )
						: await getLaunchInvocation(exePath, [], !!allowMultipleInstances);
				} catch (e) {
					Logger.error('Failed to prepare Proton launch', e);
					const message = e instanceof Error ? e.message : String(e);
					return { ok: false, error: message };
				}

				const preexistingWowPids = new Set(await pidsOf('WoW.exe'));

				const launchedAt = Date.now();
				const child = spawn(invocation.command, invocation.args, {
					env: { ...process.env, ...invocation.env },
					cwd: clientDir,
					detached: !minimizeToTrayOnPlay
				});

				try {
					await new Promise<void>((resolve, reject) => {
						child.once('spawn', resolve);
						child.once('error', reject);
					});
				} catch (e) {
					Logger.error('Failed to launch the game', e);
					const message = e instanceof Error ? e.message : String(e);
					return { ok: false, error: `Failed to launch the game: ${message}` };
				}

				void pinGameToOneCore(
					path.basename(exePath),
					preexistingWowPids
				);

				child.on('error', e => Logger.error('Game process error', e));
				// Wine prints unhandled-exception details (crashing module + address)
				// to stderr by default; capture it so a crash report actually shows
				// what faulted instead of just "WoW stopped".
				let stderrBuf = '';
				child.stderr?.on('data', (d: Buffer) => {
					stderrBuf += d.toString();
					const lines = stderrBuf.split('\n');
					stderrBuf = lines.pop() ?? '';
					lines.forEach(l => l.trim() && Logger.warn(`[wine] ${l.trim()}`));
				});

				if (!minimizeToTrayOnPlay) {
					mainWindow?.close();
					return { ok: true };
				}

				minimizeToTray();
				if (useLoader) {
					void (async () => {
						try {
							const started = Date.now();
							while (
								Date.now() - started < 30_000 &&
								!(await isGameRunning(exePath))
							)
								await delay(1000);
							while (await isGameRunning(exePath)) await delay(3000);
						} finally {
							Logger.log('WoW stopped');
							// no exit code available when just polling for the process to
							// go away, so this can only detect a crash via the report file
							await handleGameStopped(clientDir, launchedAt);
							restoreFromTray();
						}
					})();
				} else {
					child.on('exit', (code, signal) => {
						Logger.log(`WoW stopped (code=${code}, signal=${signal})`);
						void handleGameStopped(clientDir, launchedAt, {
							code,
							signal
						}).finally(restoreFromTray);
					});
				}
				return { ok: true };
			} catch (e) {
				Logger.error('Failed to start the game', e);
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			} finally {
				starting = false;
			}
		}),
	crash: publicProcedure.subscription(() => GameCrash.observe()),
	acknowledgeCrash: publicProcedure.mutation(() => GameCrash.acknowledge())
});
