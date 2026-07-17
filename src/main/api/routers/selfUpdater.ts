import SelfUpdater from '~main/modules/selfUpdater';

import { createTRPCRouter, publicProcedure } from '../trpc';

export const selfUpdaterRouter = createTRPCRouter({
	observe: publicProcedure.subscription(() => SelfUpdater.observe()),
	openReleasePage: publicProcedure.mutation(() => SelfUpdater.openReleasePage())
});
