import { z } from 'zod';
import fetch from 'node-fetch';
import Logger from 'electron-log/main';

import { NewsFeedSchema, type NewsItem } from '~common/schemas';

import { createTRPCRouter, publicProcedure } from '../trpc';

const FETCH_TIMEOUT_MS = 8_000;

// Boards octonews.php exposes as a list: 2 = Announcements, 4 = Patch Notes.
const FEED_FORUMS = [2, 4];

const fetchNews = async (forum: number): Promise<NewsItem[]> => {
	const f = FEED_FORUMS.includes(forum) ? forum : 2;
	const url = `${
		import.meta.env.MAIN_VITE_FORUM_URL || 'https://octowow.st'
	}/forum/octonews.php?mode=list&forum=${f}&limit=5`;
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw Error(`HTTP ${res.status}`);
		const parsed = NewsFeedSchema.safeParse(await res.json());
		if (!parsed.success) {
			Logger.error(
				'News feed failed schema validation',
				parsed.error.flatten()
			);
			throw Error('Malformed news feed');
		}
		return parsed.data.items;
	} finally {
		clearTimeout(t);
	}
};

export const newsRouter = createTRPCRouter({
	list: publicProcedure
		.input(z.object({ forum: z.number() }).optional())
		.query(async ({ input }) => {
			try {
				return await fetchNews(input?.forum ?? 2);
			} catch (e) {
				Logger.error('Failed to fetch news', e);
				throw e;
			}
		})
});
