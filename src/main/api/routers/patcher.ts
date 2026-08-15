import { patchConfig, patchExecutable } from '~main/modules/patcher';
import Preferences from '~main/modules/preferences';
import Updater from '~main/modules/updater';
import { getClientVersion } from '~main/utils';
import { stopSeeding } from '~main/modules/aria2';

import { createTRPCRouter, publicProcedure } from '../trpc';

export const patcherRouter = createTRPCRouter({
	apply: publicProcedure.mutation(async () => {
		// release the seeder's file handles so the patchers can write
		stopSeeding();
		try {
			await patchExecutable();
			await patchConfig(true);
			await Updater.recordPatchedWow();
			Preferences.data = { version: await getClientVersion() };
		} finally {
			await Updater.refreshSeeding();
		}
	})
});
