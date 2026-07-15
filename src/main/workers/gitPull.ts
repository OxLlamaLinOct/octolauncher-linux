import { workerData, parentPort } from 'worker_threads';

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs-extra';

const port = parentPort;
if (!port) throw new Error('gitPull worker has no parentPort');

const { dir, remote, branch, ref } = workerData as {
	dir: string;
	remote: string;
	branch: string;
	ref?: string;
};

const onProgress = (...args: unknown[]) =>
	port.postMessage({ cb: 'onProgress', args });

const run = async () => {
	if (ref) {
		await git.fetch({
			fs,
			http,
			dir,
			tags: true,
			singleBranch: false,
			onProgress
		});
		await git.checkout({ fs, dir, force: true, ref, onProgress });
		return;
	}

	await git.checkout({
		fs,
		dir,
		force: true,
		ref: `${remote}/${branch}`,
		onProgress
	});
	await git.pull({
		fs,
		http,
		dir,
		ref: branch,
		singleBranch: true,
		author: { name: 'Octo Launcher' },
		onProgress
	});
};

run()
	.then(() => port.postMessage(true))
	.catch(err => {
		throw err;
	});
