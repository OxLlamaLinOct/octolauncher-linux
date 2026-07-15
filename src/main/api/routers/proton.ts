import { shell } from 'electron';
import { z } from 'zod';

import Proton from '~main/modules/proton';

import { createTRPCRouter, publicProcedure } from '../trpc';

export const protonRouter = createTRPCRouter({
	status: publicProcedure.query(() => Proton.status),
	observe: publicProcedure.subscription(() => Proton.observe()),
	verify: publicProcedure.mutation(() => Proton.verify()),
	setOverride: publicProcedure
		.input(z.string().optional())
		.mutation(({ input }) => Proton.setOverride(input)),
	resetPrefix: publicProcedure.mutation(() => Proton.resetPrefix()),
	openPrefixFolder: publicProcedure.mutation(() =>
		shell.openPath(Proton.getPrefixDir())
	)
});
