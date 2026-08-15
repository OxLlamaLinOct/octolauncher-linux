import { z } from 'zod';

import { PreferencesSchema } from '~common/schemas';
import Preferences from '~main/modules/preferences';
import Updater from '~main/modules/updater';

import { createTRPCRouter, publicProcedure } from '../trpc';

export const preferencesRouter = createTRPCRouter({
	get: publicProcedure.output(PreferencesSchema).query(() => Preferences.data),
	set: publicProcedure
		.input(PreferencesSchema.partial())
		.mutation(async ({ input }) => {
			// Language change no longer touches the game folder; the exe is re-patched on
			// the next Play (launcher router), so this stays network-free and can't fail.
			Preferences.data = input;
			if (input.shareDownloads !== undefined) void Updater.refreshSeeding();
			return Preferences.data;
		}),
	isValidClientDir: publicProcedure
		.input(z.string().optional())
		.query(({ input }) => Preferences.isValidClientDir(input))
});
