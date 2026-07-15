import path from 'path';

import { screen } from 'electron';
import fs from 'fs-extra';
import Logger from 'electron-log/main';

import Preferences from '~main/modules/preferences';
import { ConfigWtfSchema, type PreferencesSchema } from '~common/schemas';
import { isNotUndef } from '~common/utils';
import { fetchFile } from '~main/modules/updater';

const Servers = {
	live: {
		realmList: 'octowow.st',
		patchList: 'octowow.st',
		realmName: 'OctoWoW'
	},
	ptr: {
		realmList: 'octowow.st',
		patchList: 'octowow.st',
		realmName: 'OctoWoW PTR'
	}
} as const;

type TweakKey =
	| { synthetic?: false; key: keyof PreferencesSchema['config'] }
	| { synthetic: true; key: string };

type Tweak = TweakKey & {
	default?: unknown;
	forced?: boolean;
} & (
		| {
				type: 'bytes';
				tweaks: [number, number[]][];
		  }
		| {
				type: 'int8' | 'uint16' | 'float';
				offset: number;
				value?: number;
		  }
	);

export const patchExecutable = async () => {
	Logger.log('Patching WoW.exe...');

	const { clientDir, config } = Preferences.data;
	if (!clientDir) return;
	const exePath = path.join(clientDir, 'WoW.exe');

	try {
		Logger.log('Fetching clean WoW.exe...');
		const file = await fetchFile('WoW.exe');
		const buffer = Buffer.from(file);

		const Tweaks = [
			{
				key: 'largeAddress',
				type: 'uint16',
				offset: 0x126,
				value: buffer.readUint16LE(0x126) | 0x20,
				default: false
			},
			{ key: 'farClip', type: 'float', offset: 0x40fed8 },
			{
				key: 'fieldOfView',
				type: 'float',
				offset: 0x4089b4,
				value: (config.fieldOfView ?? 1) * (Math.PI / 180),
				default: 90
			},
			{ key: 'frillDistance', type: 'float', offset: 0x467958 },
			{
				key: 'soundInBackground',
				type: 'int8',
				offset: 0x3a4869,
				value: config.soundInBackground ? 0x27 : 0x14,
				default: false
			},
			{
				key: 'alwaysAutoLoot',
				type: 'bytes',
				tweaks: [
					[0x0c1ecf, [0x75]],
					[0x0c2b25, [0x75]]
				]
			},
			{ key: 'nameplateRange', type: 'float', offset: 0x40c448 },
			{ key: 'cameraDistance', type: 'float', offset: 0x4089a4 },
			{
				synthetic: true,
				key: 'crossFactionResurrect',
				type: 'bytes',
				default: true,
				tweaks: [
					[0x006e5fb8, [0x006e5fb9]],
					[0x006e62a8, [0x006e62a9]]
				]
			},
			{
				synthetic: true,
				key: 'skillUiGateHijack',
				type: 'bytes',
				default: true,
				forced: true,
				tweaks: [
					[
						0x002ddf90,
						[
							0x55, 0x8b, 0xec, 0x83, 0xec, 0x08, 0x53, 0x56, 0x57, 0x8b, 0x3d,
							0x60, 0xab, 0xce, 0x00, 0x83, 0xff, 0xff, 0x89, 0x55, 0xfc, 0x89,
							0x4d, 0xf8, 0x74, 0x79, 0x8b, 0x75, 0x08, 0x8b, 0x15, 0x58, 0xab,
							0xce, 0x00, 0x8b, 0xc7, 0x23, 0xc6, 0x8d, 0x04, 0x40, 0x8b, 0x4c,
							0x82, 0x08, 0xf6, 0xc1, 0x01, 0x8d, 0x44, 0x82, 0x04, 0x75, 0x04,
							0x85, 0xc9, 0x75, 0x05, 0x33, 0xc9, 0x8d, 0x49, 0x00, 0xf6, 0xc1,
							0x01, 0x75, 0x4e, 0x85, 0xc9, 0x74, 0x4a, 0x39, 0x31, 0x74, 0x13,
							0x8b, 0xc7, 0x23, 0xc6, 0x8d, 0x04, 0x40, 0x8d, 0x04, 0x82, 0x8b,
							0x00, 0x03, 0xc1, 0x8b, 0x48, 0x04, 0xeb, 0xe0, 0x8b, 0x59, 0x1c,
							0x8b, 0x71, 0x18, 0x33, 0xff, 0x85, 0xdb, 0x7e, 0x27, 0x8d, 0x64,
							0x24, 0x00, 0x8b, 0x4e, 0x0c, 0x8b, 0x56, 0x08, 0x6a, 0x00, 0x6a,
							0x00, 0x51, 0x8b, 0x4d, 0xf8, 0x52, 0x8b, 0x55, 0xfc, 0xe8, 0xb9,
							0xfd, 0xff, 0xff, 0x84, 0xc0, 0x75, 0x13, 0x47, 0x83, 0xc6, 0x20,
							0x3b, 0xfb, 0x7c, 0xdd, 0x5f, 0x5e, 0x33, 0xc0, 0x5b, 0x8b, 0xe5,
							0x5d, 0xc2, 0x04, 0x00, 0x5f, 0x8b, 0xc6, 0x5e, 0x5b, 0x8b, 0xe5,
							0x5d, 0xc2, 0x04, 0x00, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90
						]
					]
				]
			},
			{
				synthetic: true,
				key: 'octowowUrlAllowlist',
				type: 'bytes',
				default: true,
				forced: true,
				tweaks: [
					[
						0x45ccd8,
						[
							0x6f, 0x63, 0x74, 0x6f, 0x77, 0x6f, 0x77, 0x2e, 0x73, 0x74,
							0x00, 0x00, 0x00, 0x00, 0x00, 0x00
						]
					]
				]
			}
		] satisfies Tweak[];

		Tweaks.forEach(t => {
			const val = t.synthetic
				? t.default
				: config[t.key] ?? t.default ?? ConfigWtfSchema.parse({})[t.key];

			Logger.log(`Applying "${t.key}" patch with value: ${val}`);
			if (t.type === 'float') {
				buffer.writeFloatLE(t.value ?? (val as number), t.offset);
			} else if (t.type === 'int8') {
				buffer.writeInt8(t.value ?? (val as number), t.offset);
			} else if (t.type === 'uint16') {
				if (!t.forced && !val) return;
				buffer.writeUInt16LE(t.value ?? (val as number), t.offset);
			} else if (t.type === 'bytes') {
				if (!t.forced && !val) return;
				t.tweaks.forEach(([offset, bytes]) =>
					Buffer.from(bytes).copy(buffer, offset)
				);
			}
		});

		await fs.writeFile(exePath, buffer);
		Logger.log('WoW.exe successfully patched');
	} catch (e) {
		Logger.error('Failed to patch WoW.exe', e);
		throw e instanceof Error ? e : new Error('Failed to patch WoW.exe');
	}
};

export const patchConfig = async (forceTweaks = false) => {
	const { clientDir, server, config, locale } = Preferences.data;
	if (!clientDir) return;

	const configPath = path.join(clientDir, 'WTF', 'Config.wtf');
	await fs.ensureDir(path.dirname(configPath));
	const raw = (await fs.pathExists(configPath))
		? await fs.readFile(configPath, { encoding: 'utf-8' })
		: '';

	const configWtf = Object.fromEntries(
		raw
			.split(/\r?\n/)
			.map(l => {
				const [, k, v] = l.match(/SET (\w+) "(.*)"/) ?? [];
				return !k || v === undefined ? undefined : [k, v];
			})
			.filter(isNotUndef)
	);

	const primaryDisplay = screen.getPrimaryDisplay();
	const scale = primaryDisplay.scaleFactor || 1;
	const width = Math.round(primaryDisplay.bounds.width * scale);
	const height = Math.round(primaryDisplay.bounds.height * scale);

	const parsed = {
		scriptMemory: 512000,
		gxResolution: `${width}x${height}`,
		gxColorBits: primaryDisplay.colorDepth,
		gxDepthBits: primaryDisplay.colorDepth,
		gxRefresh: 60,
		gxMultisample: 8,
		gxMultisampleQuality: 0,
		gxTripleBuffer: 1,
		anisotropic: 16,
		frillDensity: 48,
		fullAlpha: 1,
		SmallCull: 0.01,
		DistCull: 888.8,
		shadowLevel: 0,
		trilinear: 1,
		specular: 1,
		pixelShaders: 1,
		M2UsePixelShaders: 1,
		particleDensity: 1,
		unitDrawDist: 300,
		weatherDensity: 3,
		movieSubtitle: 1,
		minimapZoom: 0,
		minimapInsideZoom: 0,
		SoundZoneMusicNoDelay: 1,
		patchList: configWtf['patchList'] ?? Servers[server].patchList,
		realmName: configWtf['realmName'] ?? Servers[server].realmName,
		gxWindow: configWtf['gxWindow'] ?? 1,
		gxMaximize: configWtf['gxMaximize'] ?? 1,
		gxCursor: configWtf['gxCursor'] ?? 1,
		checkAddonVersion: configWtf['checkAddonVersion'] ?? 0,
		farClip: configWtf['farClip'] ?? config.farClip,
		CameraDistanceMax: configWtf['CameraDistanceMax'] ?? config.cameraDistance,
		...configWtf,
		locale,
		realmList: Servers[server].realmList,
		hwDetect: 0,
		M2UseShaders: 1,
		...(forceTweaks
			? { farClip: config.farClip, CameraDistanceMax: config.cameraDistance }
			: {})
	};

	const body = Object.entries(parsed)
		.filter(v => v[1] !== undefined && v[1] !== null)
		.map(l => `SET ${l[0]} "${l[1]}"`)
		.join('\n');
	const tmpPath = `${configPath}.tmp`;
	await fs.writeFile(tmpPath, body);
	await fs.move(tmpPath, configPath, { overwrite: true });
	Logger.log('Config.wtf successfully patched');
};
