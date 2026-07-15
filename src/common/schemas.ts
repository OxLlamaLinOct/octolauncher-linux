import { z } from 'zod';

const f = {
	boolean: (defaultValue?: boolean) =>
		z.boolean().nullish().default(!!defaultValue),
	number: (defaultValue?: number, val?: (v: z.ZodNumber) => z.ZodNumber) =>
		z.preprocess(
			v =>
				v === '' || v === undefined
					? defaultValue ?? null
					: typeof v === 'string'
					? Number(v)
					: v,
			(val?.(z.number()) ?? z.number()).nullish()
		)
};

export const ConfigWtfSchema = z.object({
	vanillaFixes: f.boolean(),
	largeAddress: f.boolean(true),
	nameplateRange: f.number(41),
	alwaysAutoLoot: f.boolean(),
	fieldOfView: f.number(110),
	farClip: f.number(777),
	frillDistance: f.number(70),
	cameraDistance: f.number(50),
	soundInBackground: f.boolean(true)
});
export type ConfigWtfSchema = z.infer<typeof ConfigWtfSchema>;

export const ModStateSchema = z.object({
	enabled: z.boolean().default(false),
	installedVersion: z.string().optional(),
	installedFiles: z.array(z.string()).default([]),
	ignoreUpdates: z.boolean().default(false)
});
export type ModState = z.infer<typeof ModStateSchema>;

export const HardwareInfoSchema = z.object({
	totalRamMb: z.number(),
	cpuCores: z.number(),
	cpuModel: z.string(),
	gpuModel: z.string(),
	vramMb: z.number().nullable(),
	vramSource: z.enum(['nvidia-smi', 'sysfs', 'none']),
	detectedAt: z.string(),
	schemaVersion: z.number()
});
export type HardwareInfo = z.infer<typeof HardwareInfoSchema>;

export const PreferencesSchema = z.object({
	server: z.enum(['live', 'ptr']).default('live'),
	clientDir: z.string().optional(),
	protonOverridePath: z.string().optional(),
	version: z.string().optional(),
	lastPatchedLauncherVersion: z.string().optional(),
	expectedPatchedWowHash: z.string().optional(),
	minimizeToTrayOnPlay: f.boolean(true),
	cleanWdb: f.boolean(true),
	allowMultipleInstances: f.boolean(false),
	locale: z
		.enum(['enUS', 'deDE', 'zhCN', 'esES', 'ptBR', 'ruRU'])
		.default('enUS'),
	localePatchLetter: z.string().optional(),
	localePatchLocale: z.string().optional(),
	rememberPosition: f.boolean(),
	windowPosition: z
		.object({
			x: z.number(),
			y: z.number(),
			width: z.number(),
			height: z.number()
		})
		.nullish(),
	config: ConfigWtfSchema.default({}),
	mods: z.record(ModStateSchema).default({}),
	hardware: HardwareInfoSchema.optional(),
	farClipUserSet: z.boolean().optional()
});
export type PreferencesSchema = z.infer<typeof PreferencesSchema>;

export const TocDataSchema = z.object({
	Interface: z.string(),
	Title: z.string(),
	Author: z.string(),
	Notes: z.string(),
	Version: z.string(),
	Dependencies: z.string().optional(),
	OptionalDeps: z.string().optional()
});

export type TocData = z.infer<typeof TocDataSchema>;

export const AddonDataSchema = z.object({
	status: z.enum([
		'available',
		'fetching',
		'unknown',
		'upToDate',
		'outOfDate',
		'downloading',
		'invalid'
	]),
	git: z.string().optional(),
	toc: TocDataSchema.optional(),
	description: z.string().optional(),
	error: z.string().optional(),
	branch: z.string().optional(),
	ref: z.string().optional(),
	folder: z.string(),
	progress: z.string().optional(),
	preview: z.string().optional()
});

export type AddonData = z.infer<typeof AddonDataSchema>;

export const NewsItemSchema = z.object({
	id: z.string(),
	title: z.string(),
	date: z.string(),
	body: z.string(),
	url: z.string().url().optional(),
	author: z.string().nullish()
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const NewsFeedSchema = z.object({
	items: z.array(NewsItemSchema)
});
export type NewsFeed = z.infer<typeof NewsFeedSchema>;

export const ForumAnnouncementSchema = z.object({
	id: z.string(),
	title: z.string(),
	author: z.string().nullish(),
	date: z.string(),
	url: z.string().url(),
	html: z.string()
});
export type ForumAnnouncement = z.infer<typeof ForumAnnouncementSchema>;
