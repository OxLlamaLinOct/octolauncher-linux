import path from 'path';

import fs from 'fs-extra';
import Logger from 'electron-log/main';

import Proton from './proton';

let queue: Promise<unknown> = Promise.resolve();

const serial = <T>(fn: () => Promise<T>): Promise<T> => {
	const next = queue.then(fn, fn);
	queue = next.catch(() => {});
	return next;
};

const dllsPath = (clientDir: string) => path.join(clientDir, 'dlls.txt');

const readLines = async (clientDir: string): Promise<string[]> => {
	const file = dllsPath(clientDir);
	if (!(await fs.pathExists(file))) return [];
	const text = await fs.readFile(file, 'utf8');
	return text.split(/\r?\n/);
};

const dllNames = (lines: string[]) =>
	lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));

// keep VanillaFixes' consent cache in step with dlls.txt so it won't re-prompt.
// VanillaFixes.exe runs under Proton/Wine and computes its own absolute path
// via GetModuleFileName, comparing it byte-for-byte against this cache; the
// cache has to hold the exact same drive-letter view of clientDir Wine itself
// resolves to. That isn't always "Z:" - some prefixes map more than one drive
// to the same host directory (we've observed both "D:\" and "Z:\" pointing at
// the Unix root on the same prefix, with Wine resolving to "D:"), so
// hardcoding Z: silently breaks the cache match. Read the prefix's own drive
// mappings and use whichever drive Wine would actually pick.
const isUnderOrEqual = (target: string, dir: string) => {
	const rel = path.relative(target, dir);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

let driveCache: { prefixDir: string; letter: string } | undefined;

const resolveWineDrive = async (clientDir: string): Promise<string> => {
	const prefixDir = Proton.getPrefixDir();
	if (driveCache?.prefixDir === prefixDir) return driveCache.letter;

	const dosdevicesDir = path.join(prefixDir, 'pfx', 'dosdevices');
	let letter = 'z';
	try {
		const entries = await fs.readdir(dosdevicesDir);
		const candidates: string[] = [];
		for (const entry of entries) {
			const m = /^([a-z]):$/i.exec(entry);
			if (!m) continue;
			const target = await fs
				.realpath(path.join(dosdevicesDir, entry))
				.catch(() => null);
			if (target && isUnderOrEqual(target, clientDir))
				candidates.push(m[1].toLowerCase());
		}
		// Wine picked "d:" over "z:" for the same target in testing; lowest
		// letter first matches that observed precedence.
		if (candidates.length) letter = candidates.sort()[0];
	} catch (e) {
		Logger.warn(
			'Could not read Proton prefix drive mappings; defaulting to Z:',
			e
		);
	}

	driveCache = { prefixDir, letter };
	Logger.info(
		`dlls.txt.cache: resolved client folder to Wine drive "${letter.toUpperCase()}:"`
	);
	return letter;
};

const toWinePath = async (clientDir: string, name: string) => {
	const letter = await resolveWineDrive(clientDir);
	return `${letter.toUpperCase()}:${path.win32.join(clientDir, name)}`;
};

const writeCache = async (clientDir: string, names: string[]) => {
	const cache = path.join(clientDir, 'dlls.txt.cache');
	if (!names.length) {
		await fs.remove(cache).catch(() => {});
		return;
	}
	const winePaths = await Promise.all(names.map(n => toWinePath(clientDir, n)));
	Logger.info(`Wrote dlls.txt.cache: ${winePaths.join(', ')}`);
	await fs.writeFile(cache, winePaths.join('\r\n'), 'utf8').catch(() => {});
};

const writeLines = async (clientDir: string, lines: string[]) => {
	const file = dllsPath(clientDir);
	const trimmed = lines.join('\n').replace(/\n+$/, '');
	if (!trimmed.trim()) {
		if (await fs.pathExists(file)) await fs.remove(file);
		await writeCache(clientDir, []);
		return;
	}
	await fs.writeFile(file, `${trimmed}\n`, 'utf8');
	await writeCache(clientDir, dllNames(lines));
};

export const syncVanillaFixesCache = (clientDir: string) =>
	serial(async () =>
		writeCache(clientDir, dllNames(await readLines(clientDir)))
	);

const matches = (line: string, name: string) =>
	line.trim().toLowerCase() === name.toLowerCase();

export const addDll = (clientDir: string, name: string) =>
	serial(async () => {
		const lines = await readLines(clientDir);
		if (lines.some(l => matches(l, name))) return;
		lines.push(name);
		await writeLines(clientDir, lines);
	});

export const removeDll = (clientDir: string, name: string) =>
	serial(async () => {
		const lines = await readLines(clientDir);
		const next = lines.filter(l => !matches(l, name));
		if (next.length === lines.length) return;
		await writeLines(clientDir, next);
	});

export const hasDll = (clientDir: string, name: string) =>
	serial(async () => {
		const lines = await readLines(clientDir);
		return lines.some(l => matches(l, name));
	});

export const listDlls = (clientDir: string): Promise<string[]> =>
	serial(async () => dllNames(await readLines(clientDir)));
