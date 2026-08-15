import path from 'node:path';

import fs from 'fs-extra';
import {
	SFileOpenArchive,
	SFileCloseArchive,
	SFileHasFile
} from 'stormlib-node';
import { STREAM_FLAG } from 'stormlib-node/dist/enums';
import Logger from 'electron-log/main';

import Preferences from './preferences';

// old installs may have a copied patch-<letter>.mpq that overrides patch-5; sweep by marker
const ALL_LETTERS = 'BCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const MARKER = 'octolocale.marker';

const patchFile = (dataDir: string, letter: string) =>
	path.join(dataDir, `patch-${letter}.mpq`);

const isOurPatch = (mpqPath: string): boolean => {
	if (!fs.existsSync(mpqPath)) return false;
	try {
		const h = SFileOpenArchive(mpqPath, STREAM_FLAG.READ_ONLY);
		try {
			return SFileHasFile(h, MARKER);
		} finally {
			SFileCloseArchive(h);
		}
	} catch {
		return false;
	}
};

// remove locale patches we copied in (marker-carrying archives only); never throws
export const removeLegacyLocalePatches = async (
	clientDir: string | undefined
): Promise<void> => {
	if (!clientDir) return;
	const dataDir = path.join(clientDir, 'Data');
	if (!(await fs.pathExists(dataDir))) return;

	for (const letter of ALL_LETTERS) {
		const f = patchFile(dataDir, letter);
		if (!isOurPatch(f)) continue;
		try {
			await fs.remove(f);
			Logger.log(`Removed the retired locale patch patch-${letter}.mpq`);
		} catch (e) {
			Logger.error(`Could not remove patch-${letter}.mpq`, e);
		}
	}

	// clear the stale tracking keys
	if (Preferences.data.localePatchLetter || Preferences.data.localePatchLocale)
		Preferences.data = {
			localePatchLetter: undefined,
			localePatchLocale: undefined
		};
};
