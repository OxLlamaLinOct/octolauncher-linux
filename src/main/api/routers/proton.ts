import path from 'path';

import { shell } from 'electron';
import { z } from 'zod';

import Proton from '~main/modules/proton';
import Preferences from '~main/modules/preferences';
import { isGameRunning } from '~main/modules/updater';

import { createTRPCRouter, publicProcedure } from '../trpc';

const assertGameNotRunning = async () => {
	const clientDir = Preferences.data?.clientDir;
	if (!clientDir) return;
	const exePath = path.join(clientDir, 'WoW.exe');
	if (await isGameRunning(exePath))
		throw new Error('Please close WoW first before changing the prefix.');
};

export const protonRouter = createTRPCRouter({
	status: publicProcedure.query(() => Proton.status),
	observe: publicProcedure.subscription(() => Proton.observe()),
	verify: publicProcedure.mutation(() => Proton.verify()),
	setOverride: publicProcedure
		.input(z.string().optional())
		.mutation(({ input }) => Proton.setOverride(input)),
	resetPrefix: publicProcedure.mutation(async () => {
		await assertGameNotRunning();
		return Proton.resetPrefix();
	}),
	relocatePrefix: publicProcedure
		.input(z.string())
		.mutation(async ({ input }) => {
			await assertGameNotRunning();
			return Proton.relocatePrefix(input);
		}),
	openPrefixFolder: publicProcedure.mutation(() =>
		shell.openPath(Proton.getPrefixDir())
	)
});
