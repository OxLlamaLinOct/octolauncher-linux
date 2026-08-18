import os from 'node:os';
import path from 'node:path';

import { app, dialog, shell } from 'electron';
import fs from 'fs-extra';
import Logger from 'electron-log/main';
import { z } from 'zod';

import { mainWindow } from '~main/index';
import Preferences from '~main/modules/preferences';
import { detectHardware, recommendFarClip } from '~main/modules/hardware';
import Proton from '~main/modules/proton';
import Mods from '~main/modules/mods';

import { createTRPCRouter, publicProcedure } from '../trpc';

const LOG_TAIL_LINES = 150;

const buildDiagnostics = async (): Promise<string> => {
	const hw = Preferences.data.hardware;
	const proton = Proton.status;
	const enabledMods = Mods.status.mods.filter(m => m.enabled).map(m => m.name);

	const logPath = Logger.transports.file.getFile().path;
	const logTail = await fs
		.readFile(logPath, 'utf8')
		.then(text => text.split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n'))
		.catch(e => `(could not read log file: ${String(e)})`);

	const lines = [
		'OctoLauncher diagnostics',
		'========================',
		`App version: ${app.getVersion()}`,
		`Platform: ${os.platform()} ${os.release()} (${os.arch()})`,
		`Proton: ${
			proton.state === 'ready'
				? `${proton.selected.name} (${proton.selected.protonPath})`
				: proton.state
		}`,
		`Client folder set: ${Preferences.data.clientDir ? 'yes' : 'no'}`,
		`Locale: ${Preferences.data.locale ?? 'unknown'}`,
		'',
		'Hardware:',
		hw
			? [
					`  CPU: ${hw.cpuModel} (${hw.cpuCores} cores)`,
					`  RAM: ${hw.totalRamMb} MB`,
					`  GPU: ${hw.gpuModel}`,
					`  VRAM: ${hw.vramMb ?? 'unknown'} MB (source: ${hw.vramSource})`
			  ].join('\n')
			: '  not detected yet',
		'',
		`Mods enabled: ${enabledMods.length ? enabledMods.join(', ') : 'none'}`,
		'',
		`--- last ${LOG_TAIL_LINES} lines of main.log ---`,
		logTail
	];

	return lines.join('\n');
};

export const generalRouter = createTRPCRouter({
	appVersion: publicProcedure.query(() => app.getVersion()),
	diagnostics: publicProcedure.query(() => buildDiagnostics()),
	hardware: publicProcedure.query(() => {
		const hardware = Preferences.data.hardware ?? null;
		return { hardware, recommendedFarClip: recommendFarClip(hardware) };
	}),
	redetectHardware: publicProcedure.mutation(async () => {
		const hardware = await detectHardware();
		Preferences.data = { hardware };
		return { hardware, recommendedFarClip: recommendFarClip(hardware) };
	}),
	quit: publicProcedure.mutation(() => app.quit()),
	minimize: publicProcedure.mutation(() => mainWindow?.minimize()),
	openLink: publicProcedure
		.input(z.string().url())
		.mutation(({ input }) => shell.openExternal(input)),
	openInstallFolder: publicProcedure.mutation(() => {
		// the file manager needs native separators; a stored forward-slash path fails to open.
		const dir = Preferences.data.clientDir;
		if (dir) shell.openPath(path.normalize(dir));
	}),
	openLogFile: publicProcedure.mutation(() => {
		const file = Logger.transports.file.getFile().path;
		shell.openPath(path.normalize(file));
	}),
	filePicker: publicProcedure
		.input(
			z.object({
				title: z.string().optional(),
				message: z.string().optional(),
				filters: z
					.array(
						z.object({
							name: z.string(),
							extensions: z.array(z.string())
						})
					)
					.optional(),
				properties: z
					.array(
						z.enum([
							'openDirectory',
							'openFile',
							'multiSelections',
							'showHiddenFiles',
							'createDirectory',
							'promptToCreate',
							'noResolveAliases',
							'treatPackageAsDirectory',
							'dontAddToRecent'
						])
					)
					.optional()
			})
		)
		.mutation(async ({ input }) => {
			if (!mainWindow) return { canceled: true } as const;
			const { canceled, filePaths } = await dialog.showOpenDialog(
				mainWindow,
				input
			);

			return canceled
				? ({ canceled: true } as const)
				: ({
						canceled: false,
						path: filePaths as [string, ...string[]]
				  } as const);
		})
});
