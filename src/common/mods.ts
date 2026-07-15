import { z } from 'zod';

export const ModIdSchema = z.enum([
	'dxvk',
	'nampower',
	'multiMonitorFix',
	'superWow',
	'transmogFix',
	'unitXp',
	'vanillaFixes',
	'vanillaHelpers'
]);
export type ModId = z.infer<typeof ModIdSchema>;

export type ModSource =
	| {
			kind: 'directFile';
			url: string;
			parseLatest?: 'githubRelease' | 'gitlabRelease' | 'codebergRelease';
			apiUrl?: string;
			pinnedTag?: string;
			assetName: string;
	  }
	| {
			kind: 'archive';
			url: string;
			apiUrl?: string;
			parseLatest?: 'githubRelease' | 'gitlabRelease' | 'codebergRelease';
			pinnedTag?: string;
			format: 'zip' | 'tar.gz';
			extractMap: Record<string, string>;
	  }
	| { kind: 'managed' };

export type ModEntry = {
	id: ModId;
	name: string;
	version: string;
	description: string;
	recommended?: boolean;
	requires?: ModId[];
	repoUrl: string;
	source: ModSource;
	registerInDllsTxt?: string;
};

export const MODS: ModEntry[] = [
	{
		id: 'dxvk',
		name: 'dxvk',
		version: 'v2.7.1-1',
		description: 'Enables Vulkan based rendering mode for better performance.',
		recommended: true,
		repoUrl: 'https://gitlab.com/Ph42oN/dxvk-gplasync',
		source: {
			kind: 'archive',
			url: 'https://gitlab.com/Ph42oN/dxvk-gplasync/-/raw/main/releases/dxvk-gplasync-v2.7.1-1.tar.gz?ref_type=heads',
			pinnedTag: 'v2.7.1-1',
			format: 'tar.gz',
			extractMap: {
				'dxvk-gplasync-v2.7.1-1/x32/d3d9.dll': 'd3d9.dll'
			}
		}
	},
	{
		id: 'nampower',
		name: 'nampower',
		version: 'v4.6.2',
		description:
			'A client modification that minimizes your input lag if you have higher latency.',
		repoUrl: 'https://github.com/Emyrk/nampower',
		requires: ['vanillaFixes'],
		source: {
			kind: 'directFile',
			url: 'https://github.com/Emyrk/nampower/releases/download/v4.6.2/nampower.dll',
			pinnedTag: 'v4.6.2',
			assetName: 'nampower.dll'
		},
		registerInDllsTxt: 'nampower.dll'
	},
	{
		id: 'multiMonitorFix',
		name: 'no1600x1200',
		version: '0.2',
		description: 'Fix for larger resolutions or multi monitor setups.',
		repoUrl: 'https://github.com/Mates1500/VanillaMultiMonitorFix',
		requires: ['vanillaFixes'],
		source: {
			kind: 'archive',
			url: 'https://github.com/Mates1500/VanillaMultiMonitorFix/releases/download/0.2/release.zip',
			apiUrl:
				'https://api.github.com/repos/Mates1500/VanillaMultiMonitorFix/releases/latest',
			parseLatest: 'githubRelease',
			pinnedTag: '0.2',
			format: 'zip',
			extractMap: {
				'VanillaMultiMonitorFix.dll': 'VanillaMultiMonitorFix.dll'
			}
		},
		registerInDllsTxt: 'VanillaMultiMonitorFix.dll'
	},
	{
		id: 'superWow',
		name: 'SuperWoW',
		version: 'Release 2.1',
		description:
			'Extends the client with additional Lua API data (unit GUIDs, spell info, and more) required by many modern addons.',
		repoUrl: 'https://github.com/balakethelock/SuperWoW',
		requires: ['vanillaFixes'],
		source: {
			kind: 'archive',
			url: 'https://github.com/balakethelock/SuperWoW/releases/download/Release/SuperWoW.release.2.1.zip',
			pinnedTag: 'Release',
			format: 'zip',
			extractMap: {
				'SuperWoWhook.dll': 'SuperWoWhook.dll'
			}
		},
		registerInDllsTxt: 'SuperWoWhook.dll'
	},
	{
		id: 'transmogFix',
		name: 'transmogFix',
		version: 'v0.7.0',
		description:
			"A client-side fix that eliminates frame drops caused by the server's transmogrification durability workaround.",
		repoUrl: 'https://codeberg.org/MarcelineVQ/WeirdUtils',
		requires: ['vanillaFixes'],
		source: {
			kind: 'directFile',
			url: 'https://codeberg.org/MarcelineVQ/WeirdUtils/releases/download/v0.7.0/transmogfix.dll',
			pinnedTag: 'v0.7.0',
			assetName: 'transmogfix.dll'
		},
		registerInDllsTxt: 'transmogfix.dll'
	},
	{
		id: 'unitXp',
		name: 'unitXp',
		version: 'v89',
		description: 'An attempt to make Vanilla 1.12 modern.',
		repoUrl: 'https://codeberg.org/konaka/UnitXP_SP3',
		requires: ['vanillaFixes'],
		source: {
			kind: 'archive',
			url: 'https://codeberg.org/konaka/UnitXP_SP3/releases/download/v89/UnitXP_SP3%20v89.zip',
			pinnedTag: 'v89',
			format: 'zip',
			extractMap: {
				'UnitXP_SP3.dll': 'UnitXP_SP3.dll'
			}
		},
		registerInDllsTxt: 'UnitXP_SP3.dll'
	},
	{
		id: 'vanillaFixes',
		name: 'vanillaFixes',
		version: 'v1.5.3',
		description:
			'A client modification that eliminates stutter and animation lag.',
		recommended: true,
		repoUrl: 'https://github.com/hannesmann/vanillafixes',
		source: {
			kind: 'archive',
			url: 'https://github.com/hannesmann/vanillafixes/releases/download/v1.5.3/vanillafixes-1.5.3.zip',
			apiUrl:
				'https://api.github.com/repos/hannesmann/vanillafixes/releases/latest',
			parseLatest: 'githubRelease',
			pinnedTag: 'v1.5.3',
			format: 'zip',
			extractMap: {
				'VfPatcher.dll': 'VfPatcher.dll',
				'VanillaFixes.exe': 'VanillaFixes.exe'
			}
		}
	},
	{
		id: 'vanillaHelpers',
		name: 'vanillaHelpers',
		version: 'v1.1.2',
		description:
			'Utility library that might be required by other patches and addons.',
		repoUrl: 'https://github.com/isfir/VanillaHelpers',
		requires: ['vanillaFixes'],
		source: {
			kind: 'directFile',
			url: 'https://github.com/isfir/VanillaHelpers/releases/download/v1.1.2/VanillaHelpers.dll',
			apiUrl:
				'https://api.github.com/repos/isfir/VanillaHelpers/releases/latest',
			parseLatest: 'githubRelease',
			pinnedTag: 'v1.1.2',
			assetName: 'VanillaHelpers.dll'
		},
		registerInDllsTxt: 'VanillaHelpers.dll'
	}
];

export const getMod = (id: ModId): ModEntry | undefined =>
	MODS.find(m => m.id === id);
