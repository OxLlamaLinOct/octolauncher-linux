import path from 'path';

import fs from 'fs-extra';

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
// against the prefix's default Z: drive (which maps to the Unix root), so the
// cache has to hold that same Z:\... view of clientDir, not the native path.
const toWinePath = (clientDir: string, name: string) =>
	`Z:${path.win32.join(clientDir, name)}`;

const writeCache = async (clientDir: string, names: string[]) => {
	const cache = path.join(clientDir, 'dlls.txt.cache');
	if (!names.length) {
		await fs.remove(cache).catch(() => {});
		return;
	}
	const body = names.map(n => toWinePath(clientDir, n)).join('\r\n');
	await fs.writeFile(cache, body, 'utf8').catch(() => {});
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
