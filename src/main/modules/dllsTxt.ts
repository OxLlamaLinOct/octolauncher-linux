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

const writeLines = async (clientDir: string, lines: string[]) => {
	const file = dllsPath(clientDir);
	const trimmed = lines.join('\n').replace(/\n+$/, '');
	if (!trimmed.trim()) {
		if (await fs.pathExists(file)) await fs.remove(file);
		return;
	}
	await fs.writeFile(file, trimmed + '\n', 'utf8');
};

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
