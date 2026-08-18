import os from 'node:os';
import { spawn, execFile } from 'node:child_process';

import { screen } from 'electron';
import Logger from 'electron-log/main';

export const detectPrimaryDisplayIndex = (): Promise<number> => {
	const displays = screen.getAllDisplays();
	const primary = screen.getPrimaryDisplay();
	const index = displays.findIndex(d => d.id === primary.id);

	if (index < 0) {
		Logger.warn('Primary display not found among displays, defaulting to 0');
		return Promise.resolve(0);
	}

	Logger.info(`Detected primary display at index ${index}`);
	return Promise.resolve(index);
};

export type DisplayDevice = {
	index: number;
	deviceName: string;
	deviceString: string;
	attached: boolean;
	primary: boolean;
	width: number;
	height: number;
	refresh: number;
	modes: string[];
};

const SCRIPT = [
	'$ErrorActionPreference = "Stop"',
	"$ProgressPreference = 'SilentlyContinue'",
	"Add-Type -TypeDefinition @'",
	'using System;',
	'using System.Runtime.InteropServices;',
	'public static class VmmfDisplays {',
	'  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]',
	'  public struct DISPLAY_DEVICE {',
	'    public int cb;',
	'    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;',
	'    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;',
	'    public int StateFlags;',
	'    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;',
	'    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;',
	'  }',
	'  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]',
	'  public struct DEVMODE {',
	'    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;',
	'    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;',
	'    public int dmFields; public int dmPositionX; public int dmPositionY;',
	'    public int dmDisplayOrientation; public int dmDisplayFixedOutput;',
	'    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;',
	'    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;',
	'    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;',
	'    public int dmDisplayFlags; public int dmDisplayFrequency;',
	'    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;',
	'    public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;',
	'  }',
	'  [DllImport("user32.dll", EntryPoint="EnumDisplayDevicesA", CharSet=CharSet.Ansi)]',
	'  public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);',
	'  [DllImport("user32.dll", EntryPoint="EnumDisplaySettingsA", CharSet=CharSet.Ansi)]',
	'  public static extern bool EnumDisplaySettings(string lpszDeviceName, int iModeNum, ref DEVMODE lpDevMode);',
	'}',
	"'@",
	'for ($i = 0; ; $i++) {',
	'  $dd = New-Object VmmfDisplays+DISPLAY_DEVICE',
	'  $dd.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($dd)',
	'  if (-not [VmmfDisplays]::EnumDisplayDevices([NullString]::Value, $i, [ref]$dd, 0)) { break }',
	'  $dm = New-Object VmmfDisplays+DEVMODE',
	'  $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($dm)',
	'  $cur = ""',
	'  if ([VmmfDisplays]::EnumDisplaySettings($dd.DeviceName, -1, [ref]$dm)) {',
	'    $cur = "$($dm.dmPelsWidth)|$($dm.dmPelsHeight)|$($dm.dmDisplayFrequency)"',
	'  }',
	'  $modes = New-Object System.Collections.Generic.HashSet[string]',
	'  for ($m = 0; ; $m++) {',
	'    $d2 = New-Object VmmfDisplays+DEVMODE',
	'    $d2.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($d2)',
	'    if (-not [VmmfDisplays]::EnumDisplaySettings($dd.DeviceName, $m, [ref]$d2)) { break }',
	'    [void]$modes.Add("$($d2.dmPelsWidth)x$($d2.dmPelsHeight)")',
	'  }',
	'  Write-Output ("{0}`t{1}`t{2}`t{3}`t{4}`t{5}" -f $i, $dd.DeviceName, $dd.DeviceString, $dd.StateFlags, $cur, ($modes -join ","))',
	'}'
].join('\n');

const parseRow = (line: string): DisplayDevice | undefined => {
	const f = line.split('\t');
	if (f.length < 6) return undefined;
	const index = Number(f[0]);
	const stateFlags = Number(f[3]);
	if (!Number.isInteger(index) || index < 0 || !Number.isInteger(stateFlags))
		return undefined;
	const [w, h, hz] = (f[4] || '').split('|').map(Number);
	return {
		index,
		deviceName: f[1],
		deviceString: f[2],
		attached: (stateFlags & 1) !== 0,
		primary: (stateFlags & 4) !== 0,
		width: Number.isFinite(w) ? w : 0,
		height: Number.isFinite(h) ? h : 0,
		refresh: Number.isFinite(hz) ? hz : 0,
		modes: (f[5] || '').split(',').filter(Boolean)
	};
};

// Caller (VanillaMultiMonitorFix's preferred-monitor sync) indexes displays
// by the same ordinal Windows' EnumDisplayDevices would assign, since that's
// what the DLL itself reads back under Wine. Wine's X11 driver builds its
// display list directly from XRandR output order, so xrandr's own listing
// order is the same ordinal in practice - this isn't independently verified
// against Wine's enumeration, just the best available match without a
// Windows API to call directly.
const parseXrandr = (output: string): DisplayDevice[] => {
	const devices: DisplayDevice[] = [];
	let current: DisplayDevice | undefined;
	let modes: Set<string> | undefined;

	const flush = () => {
		if (!current || !modes) return;
		current.modes = [...modes];
		devices.push(current);
	};

	for (const line of output.split(/\r?\n/)) {
		const head = /^(\S+) (connected|disconnected)( primary)?(?: (\d+)x(\d+)\+\d+\+\d+)?/.exec(
			line
		);
		if (head) {
			flush();
			const [, name, state, primaryFlag, w, h] = head;
			modes = new Set();
			current = {
				index: devices.length,
				deviceName: name,
				deviceString: name,
				attached: state === 'connected',
				primary: !!primaryFlag,
				width: w ? Number(w) : 0,
				height: h ? Number(h) : 0,
				refresh: 0,
				modes: []
			};
			continue;
		}
		const mode = /^\s+(\d+)x(\d+)\s+([\d.]+)(\*)?/.exec(line);
		if (mode && current && modes) {
			const [, w, h, hz, isCurrent] = mode;
			modes.add(`${w}x${h}`);
			if (isCurrent) current.refresh = Math.round(Number(hz));
		}
	}
	flush();

	return devices;
};

const enumerateDisplaysLinux = (): Promise<DisplayDevice[] | null> =>
	new Promise(resolve => {
		execFile('xrandr', ['--query'], (error, stdout) => {
			if (error) {
				Logger.warn('xrandr enumeration failed', error);
				resolve(null);
				return;
			}
			const devices = parseXrandr(stdout);
			if (!devices.length) {
				Logger.warn('xrandr returned no display devices');
				resolve(null);
				return;
			}
			Logger.info(`Enumerated ${devices.length} display device(s) via xrandr`);
			resolve(devices);
		});
	});

const enumerateDisplaysWindows = (): Promise<DisplayDevice[] | null> => {
	const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');

	return new Promise(resolve => {
		let settled = false;
		const finish = (v: DisplayDevice[] | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};

		const child = spawn(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
			{ windowsHide: true }
		);

		const timer = setTimeout(() => {
			child.kill();
			Logger.warn('Display enumeration timed out');
			finish(null);
		}, 10000);

		let stdout = '';
		child.stdout.on('data', d => (stdout += String(d)));
		child.on('error', e => {
			Logger.warn('Display enumeration failed to launch PowerShell', e);
			finish(null);
		});
		child.on('exit', code => {
			const devices = stdout
				.split(/\r?\n/)
				.map(parseRow)
				.filter((d): d is DisplayDevice => d !== undefined);
			if (code === 0 && devices.length) {
				Logger.info(`Enumerated ${devices.length} display device(s)`);
				finish(devices);
			} else {
				Logger.warn('Display enumeration returned nothing usable');
				finish(null);
			}
		});
	});
};

export const enumerateDisplays = (): Promise<DisplayDevice[] | null> => {
	if (os.platform() === 'win32') return enumerateDisplaysWindows();
	if (os.platform() === 'linux') return enumerateDisplaysLinux();
	return Promise.resolve(null);
};
