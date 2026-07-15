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
