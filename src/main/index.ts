import { join } from 'path';

import { app, shell, session, BrowserWindow, screen } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { createIPCHandler } from 'electron-trpc/main';
import Logger from 'electron-log/main';

import icon from '~build/icon.png?asset';

import { appRouter } from './api/root';
import Preferences from './modules/preferences';
import Updater from './modules/updater';
import Addons from './modules/addons';
import Mods from './modules/mods';
import Proton from './modules/proton';
import { initSelfUpdater } from './modules/selfUpdater';
import {
	detectHardware,
	recommendFarClip,
	HARDWARE_SCHEMA_VERSION
} from './modules/hardware';

Logger.initialize();
Logger.errorHandler.startCatching();
// The `console-message` listener below already forwards renderer console
// output into Logger. Leaving the ipc transport on would echo every main-log
// line back into the renderer's console, which re-triggers `console-message`
// and forwards it back into Logger - an infinite feedback loop.
Logger.transports.ipc.level = false;
Logger.info('Launcher starting...');

app.disableHardwareAcceleration();

export let mainWindow: BrowserWindow | null = null;

const isOnScreen = (
	pos?: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null
) => {
	if (!pos) return false;
	return screen.getAllDisplays().some(d => {
		const a = d.workArea;
		return (
			pos.x < a.x + a.width &&
			pos.x + pos.width > a.x &&
			pos.y < a.y + a.height &&
			pos.y + pos.height > a.y
		);
	});
};

const createWindow = async () => {
	const saved =
		Preferences.data.rememberPosition &&
		isOnScreen(Preferences.data.windowPosition)
			? Preferences.data.windowPosition
			: undefined;
	const position = saved ?? { width: 1000, height: 700 };

	mainWindow = new BrowserWindow({
		...position,
		minWidth: 1000,
		minHeight: 700,
		icon,
		frame: false,
		maximizable: false,
		fullscreenable: false,
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			contextIsolation: true,
			sandbox: false,
			devTools: true
		}
	});

	mainWindow.webContents.on('render-process-gone', (_e, details) => {
		Logger.error('Renderer process gone:', details);
	});
	mainWindow.webContents.on('unresponsive', () => {
		Logger.error('Renderer unresponsive');
	});

	mainWindow.webContents.on(
		'console-message',
		(_e, level, message, line, sourceId) => {
			const lvl = level === 3 ? 'error' : level === 2 ? 'warn' : 'info';
			Logger[lvl](`[renderer:${lvl}] ${message} (${sourceId}:${line})`);
		}
	);

	mainWindow.webContents.on('before-input-event', (_e, input) => {
		if (input.type !== 'keyDown') return;
		if (input.key === 'F12') {
			mainWindow?.webContents.toggleDevTools();
			return;
		}
		if ((input.control || input.meta) && input.key.toLowerCase() === 'c')
			mainWindow?.webContents.copy();
	});

	createIPCHandler({ router: appRouter, windows: [mainWindow] });

	mainWindow.on('ready-to-show', () => {
		mainWindow?.show();
	});
	mainWindow.webContents.setWindowOpenHandler(details => {
		shell.openExternal(details.url);
		return { action: 'deny' };
	});
	mainWindow.on('close', () => {
		if (!mainWindow) return;
		const [x = 0, y = 0] = mainWindow.getPosition();
		const [width = 0, height = 0] = mainWindow.getSize();
		Preferences.data = { windowPosition: { x, y, width, height } };
	});

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
	}
};

const gotSingleInstanceLock = is.dev || app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		if (!mainWindow.isVisible()) mainWindow.show();
		mainWindow.focus();
	});

	app.whenReady().then(async () => {
		Preferences.data = await Preferences.load();

		Addons.verify();
		Updater.verify();
		Mods.verify();
		Proton.verify();
		initSelfUpdater();

		void (async () => {
			try {
				let hardware = Preferences.data.hardware;
				if (!hardware || hardware.schemaVersion < HARDWARE_SCHEMA_VERSION) {
					hardware = await detectHardware();
					Preferences.data = { hardware };
				}
				const rec = recommendFarClip(hardware ?? null);
				if (
					Preferences.data.farClipUserSet !== true &&
					Preferences.data.config.farClip !== rec
				)
					Preferences.data = {
						config: { ...Preferences.data.config, farClip: rec }
					};
			} catch (e) {
				Logger.error('Hardware detection / farClip recommendation failed', e);
			}
		})();

		electronApp.setAppUserModelId('st.octowow.launcher');

		if (app.isPackaged) {
			const serverOrigin = new URL(
				import.meta.env.MAIN_VITE_SERVER_URL || 'https://octowow.st'
			).origin;
			session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
				cb({
					responseHeaders: {
						...details.responseHeaders,
						'Content-Security-Policy': [
							[
								"default-src 'self'",
								"script-src 'self'",
								"style-src 'self' 'unsafe-inline'",
								`img-src 'self' data: https://octowow.st https://forum.octowow.st ${serverOrigin}`,
								"font-src 'self' data:",
								"connect-src 'self'"
							].join('; ')
						]
					}
				});
			});
		}

		app.on('browser-window-created', (_, window) => {
			optimizer.watchWindowShortcuts(window);
		});

		await createWindow();
	});

	app.on('window-all-closed', () => {
		app.quit();
	});
}
