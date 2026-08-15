import os from 'node:os';
import { execFile } from 'node:child_process';

import { app } from 'electron';
import fs from 'fs-extra';
import Logger from 'electron-log/main';

import type { HardwareInfo } from '~common/schemas';

export const HARDWARE_SCHEMA_VERSION = 1;

export const FARCLIP_FLOOR = 777;
export const FARCLIP_CEILING = 3000;

const getVramMbFromNvidiaSmi = (): Promise<number | null> =>
	new Promise(resolve => {
		execFile(
			'nvidia-smi',
			['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
			(error, stdout) => {
				if (error) {
					resolve(null);
					return;
				}
				const mb = Number(stdout.trim().split('\n')[0]);
				resolve(Number.isFinite(mb) && mb > 0 ? Math.round(mb) : null);
			}
		);
	});

// dxvk-gplasync v2.7.1-1 (the build this launcher pins) requires
// VK_KHR_maintenance5, which NVIDIA's proprietary driver only supports from
// 550.54.14 onward; below that DXVK silently falls back to whatever other
// GPU is visible (often an integrated one), which crashes on hybrid-GPU
// desktops. https://github.com/doitsujin/dxvk/wiki/Driver-support
const MIN_NVIDIA_DRIVER_FOR_DXVK = [550, 54, 14];

const versionAtLeast = (have: number[], want: number[]): boolean => {
	for (let i = 0; i < want.length; i++) {
		const h = have[i] ?? 0;
		const w = want[i];
		if (h !== w) return h > w;
	}
	return true;
};

// true only when an NVIDIA GPU is present and its driver is below the
// version DXVK needs; false (not our problem to flag) if there's no NVIDIA
// GPU, nvidia-smi isn't available, or the driver is new enough.
export const nvidiaDriverTooOldForDxvk = (): Promise<boolean> =>
	new Promise(resolve => {
		execFile(
			'nvidia-smi',
			['--query-gpu=driver_version', '--format=csv,noheader'],
			(error, stdout) => {
				const raw = error ? '' : stdout.trim().split('\n')[0];
				if (!raw) {
					resolve(false);
					return;
				}
				const have = raw.split('.').map(Number);
				resolve(!versionAtLeast(have, MIN_NVIDIA_DRIVER_FOR_DXVK));
			}
		);
	});

const getVramMbFromSysfs = async (): Promise<number | null> => {
	try {
		const drmDir = '/sys/class/drm';
		const entries = await fs.readdir(drmDir);
		let max = 0;
		for (const entry of entries) {
			if (!/^card\d+$/.test(entry)) continue;
			const vramPath = `${drmDir}/${entry}/device/mem_info_vram_total`;
			try {
				const raw = await fs.readFile(vramPath, 'utf8');
				const bytes = Number(raw.trim());
				if (Number.isFinite(bytes) && bytes > max) max = bytes;
			} catch {
				// This device doesn't expose VRAM info (e.g. not a discrete GPU).
			}
		}
		return max > 0 ? Math.round(max / 1024 / 1024) : null;
	} catch {
		return null;
	}
};

const getVramMb = async (): Promise<{
	mb: number | null;
	source: HardwareInfo['vramSource'];
}> => {
	const nvidia = await getVramMbFromNvidiaSmi();
	if (nvidia !== null) return { mb: nvidia, source: 'nvidia-smi' };

	const sysfs = await getVramMbFromSysfs();
	if (sysfs !== null) return { mb: sysfs, source: 'sysfs' };

	return { mb: null, source: 'none' };
};

const getGpuModel = async (): Promise<string> => {
	try {
		const info = (await app.getGPUInfo('complete')) as {
			auxAttributes?: { glRenderer?: string };
			gpuDevice?: { active?: boolean; vendorId?: number; deviceId?: number }[];
		};
		const renderer = info?.auxAttributes?.glRenderer?.trim();
		if (renderer) return renderer;
		const active = info?.gpuDevice?.find(d => d.active) ?? info?.gpuDevice?.[0];
		if (active) return `vendor ${active.vendorId} device ${active.deviceId}`;
	} catch (e) {
		Logger.warn('GPU info detection failed', e);
	}
	return 'unknown';
};

export const detectHardware = async (): Promise<HardwareInfo> => {
	const cpus = os.cpus();
	const [vram, gpuModel] = await Promise.all([getVramMb(), getGpuModel()]);

	const info: HardwareInfo = {
		totalRamMb: Math.round(os.totalmem() / 1024 / 1024),
		cpuCores: cpus.length,
		cpuModel: cpus[0]?.model?.trim() || 'unknown',
		gpuModel,
		vramMb: vram.mb,
		vramSource: vram.source,
		detectedAt: new Date().toISOString(),
		schemaVersion: HARDWARE_SCHEMA_VERSION
	};
	Logger.info('Detected hardware', info);
	return info;
};

const clampFarClip = (n: number) =>
	Math.min(FARCLIP_CEILING, Math.max(FARCLIP_FLOOR, Math.round(n)));

export const recommendFarClip = (hw: HardwareInfo | null): number => {
	if (!hw) return clampFarClip(1000);

	const ramGb = hw.totalRamMb / 1024;
	const cores = hw.cpuCores;
	const vramTrusted = hw.vramSource !== 'none' && hw.vramMb != null;
	const vramGb = vramTrusted ? (hw.vramMb as number) / 1024 : null;

	if (ramGb < 6 || cores <= 2) return clampFarClip(FARCLIP_FLOOR);

	if (vramGb === null)
		return clampFarClip(ramGb >= 8 && cores >= 4 ? 1500 : 1000);

	if (ramGb < 8 || vramGb < 2) return clampFarClip(1000);
	if (ramGb >= 32 && vramGb >= 8 && cores >= 8) return clampFarClip(3000);
	if (ramGb >= 16 && vramGb >= 4 && cores >= 6) return clampFarClip(2200);
	if (ramGb >= 8 && vramGb >= 2 && cores >= 4) return clampFarClip(1500);
	return clampFarClip(1000);
};
