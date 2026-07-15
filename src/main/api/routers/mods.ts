import path from 'path';

import { z } from 'zod';

import Mods from '~main/modules/mods';
import Preferences from '~main/modules/preferences';
import { isGameRunning } from '~main/modules/updater';
import { ModIdSchema } from '~common/mods';

import { createTRPCRouter, publicProcedure } from '../trpc';

export const modsRouter = createTRPCRouter({
	list: publicProcedure.query(() => Mods.status),
	verify: publicProcedure.mutation(() => Mods.verify()),
	toggle: publicProcedure
		.input(z.object({ id: ModIdSchema, enabled: z.boolean() }))
		.mutation(({ input }) => Mods.toggle(input.id, input.enabled)),
	setIgnoreUpdates: publicProcedure
		.input(z.object({ id: ModIdSchema, ignore: z.boolean() }))
		.mutation(({ input }) => Mods.setIgnoreUpdates(input.id, input.ignore)),
	applyAll: publicProcedure.mutation(() => Mods.applyAll()),
	repair: publicProcedure.mutation(async () => {
		const clientDir = Preferences.data?.clientDir;
		if (clientDir && !Preferences.data.allowMultipleInstances) {
			const exePath = path.join(clientDir, 'WoW.exe');
			if (await isGameRunning(exePath))
				throw new Error('Please close WoW first before verifying files.');
		}
		return Mods.applyAll({ repairOnly: true });
	}),
	observe: publicProcedure.subscription(() => Mods.observe())
});
