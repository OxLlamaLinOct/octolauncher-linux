import fetch from 'node-fetch';
import Logger from 'electron-log/main';

import { ForumAnnouncementSchema, type ForumAnnouncement } from '~common/schemas';

import { createTRPCRouter, publicProcedure } from '../trpc';

const FETCH_TIMEOUT_MS = 8_000;

const fetchLatestAnnouncement = async (): Promise<ForumAnnouncement | null> => {
	const url = `${
		import.meta.env.MAIN_VITE_SERVER_URL || 'https://octowow.st'
	}/forum/octonews.php?forum=35&mode=full`;
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw Error(`HTTP ${res.status}`);
		const json = (await res.json()) as unknown;
		if (!json || typeof json !== 'object' || !('id' in json)) return null;
		const parsed = ForumAnnouncementSchema.safeParse(json);
		if (!parsed.success) {
			Logger.error(
				'Forum announcement failed schema validation',
				parsed.error.flatten()
			);
			throw Error('Malformed forum announcement');
		}
		return parsed.data;
	} finally {
		clearTimeout(t);
	}
};

export const forumRouter = createTRPCRouter({
	latestAnnouncement: publicProcedure.query(async () => {
		try {
			return await fetchLatestAnnouncement();
		} catch (e) {
			Logger.error('Failed to fetch forum announcement', e);
			throw e;
		}
	})
});
