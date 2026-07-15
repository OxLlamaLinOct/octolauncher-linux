import path from 'path';
import { spawn } from 'child_process';

import fs from 'fs-extra';
import Logger from 'electron-log/main';

import Preferences from '~main/modules/preferences';
import Mods from '~main/modules/mods';
import { mainWindow } from '~main/index';
import { isGameRunning } from '~main/modules/updater';
import { patchConfig } from '~main/modules/patcher';
import { applyLocalePatch } from '~main/modules/localePatch';
import { minimizeToTray, restoreFromTray } from '~main/modules/tray';
import { getLaunchInvocation } from '~main/modules/proton';
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

type StartResult = { ok: boolean; error?: string };

export const launcherRouter = createTRPCRouter({
	start: publicProcedure.mutation(async (): Promise<StartResult> => {
		const { cleanWdb, minimizeToTrayOnPlay, clientDir, allowMultipleInstances } =
			Preferences.data;
		if (!clientDir) return { ok: false, error: 'No game folder is set.' };

		const exePath = path.join(clientDir, 'WoW.exe');
		if (!(await fs.pathExists(exePath)))
			return { ok: false, error: 'WoW.exe was not found in the game folder.' };
		if (!allowMultipleInstances && (await isGameRunning(exePath)))
			return { ok: false, error: 'WoW is already running.' };

		if (cleanWdb) {
			Logger.log('Cleaning up WDB...');
			await fs.remove(path.join(clientDir, 'WDB'));
		}

		Logger.log('Checking Config.wtf...');
		await patchConfig();

		Logger.log('Applying UI language...');
		await applyLocalePatch(clientDir, Preferences.data.locale);

		const loaderPath = path.join(clientDir, 'VanillaFixes.exe');
		const needsLoader = await chainloaderNeeded(clientDir);
		const useLoader = needsLoader && (await fs.pathExists(loaderPath));
		if (needsLoader && !useLoader)
			Logger.warn(
				'VanillaFixes.exe is missing but mods/dlls.txt expect a chainloader; ' +
					'launching WoW.exe directly (mods will not load).'
			);

		const octoLocale = Preferences.data.locale || 'enUS';
		Logger.log(
			useLoader
				? `Launching via VanillaFixes (OCTO_LOCALE=${octoLocale})...`
				: `Launching ${exePath} (OCTO_LOCALE=${octoLocale})...`
		);

		let invocation;
		try {
			invocation = useLoader
				? await getLaunchInvocation(loaderPath, ['WoW.exe'])
				: await getLaunchInvocation(exePath);
		} catch (e) {
			Logger.error('Failed to prepare Proton launch', e);
			const message = e instanceof Error ? e.message : String(e);
			return { ok: false, error: message };
		}

		const child = spawn(invocation.command, invocation.args, {
			env: { ...process.env, ...invocation.env, OCTO_LOCALE: octoLocale },
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

		child.on('error', e => Logger.error('Game process error', e));

		if (!minimizeToTrayOnPlay) {
			mainWindow?.close();
			return { ok: true };
		}

		minimizeToTray();
		child.on('exit', () => {
			Logger.log('WoW stopped');
			restoreFromTray();
		});
		return { ok: true };
	})
});
