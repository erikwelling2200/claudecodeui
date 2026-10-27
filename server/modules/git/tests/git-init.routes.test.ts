import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { createGitRouter } from '@/modules/git/git.routes.js';
import type { AppError } from '@/shared/utils.js';

test('git init does not run when repository validation fails for an execution error', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => child.emit('error', Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })));
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectFolderPathsById: () => ['/workspace/repo'],
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    const body = await response.json() as { success: boolean; error: string };
    assert.equal(body.success, false);
    assert.match(body.error, /permission denied/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands, [['rev-parse', '--is-inside-work-tree']]);
});

test('delete branch parses force and uses Git force deletion', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      if (args.includes('--show-current')) child.stdout.write('main\n');
      if (args.includes('-D')) child.stdout.write('Deleted branch feature/unmerged.\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectFolderPathsById: () => ['/workspace/repo'],
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: true }),
    });
    const body = await response.json() as { success: boolean; output: string };
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.match(body.output, /Deleted branch/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands.at(-1), ['branch', '-D', '--', 'feature/unmerged']);
});

test('delete branch rejects a non-boolean force value before running Git', async () => {
  const spawnProcess = (() => {
    throw new Error('Git must not run for invalid input');
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectFolderPathsById: () => ['/workspace/repo'],
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: 'yes' }),
    });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 400);
    assert.equal(body.error, 'force must be a boolean');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const PRIMARY_FOLDER = path.resolve('/workspace/repo');
const SECOND_FOLDER = path.resolve('/workspace/second');

/**
 * A git router for a two-folder project behind the server's AppError handler.
 * Records the working directory of every git command it is asked to run.
 */
async function startTwoFolderGitServer() {
  const commandDirectories: string[] = [];
  const spawnProcess = ((_command: string, args: string[], options: { cwd: string }) => {
    commandDirectories.push(options.cwd);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write(`${options.cwd}\n`);
      if (args.includes('--show-current')) child.stdout.write('main\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as unknown as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const app = express();
  app.use(express.json());
  app.use('/api/git', createGitRouter({
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectFolderPathsById: () => [PRIMARY_FOLDER, SECOND_FOLDER],
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error as AppError;
    res.status(appError.statusCode ?? 500).json({ error: { code: appError.code, message: appError.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/git`,
    commandDirectories,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('git routes run in the folder named by `folder`, and in the primary without one', async () => {
  const gitServer = await startTwoFolderGitServer();
  try {
    const query = new URLSearchParams({ project: 'project-1', folder: SECOND_FOLDER });
    const secondResponse = await fetch(`${gitServer.baseUrl}/status?${query}`);
    assert.equal(secondResponse.status, 200);
    assert.ok(gitServer.commandDirectories.length > 0);
    assert.ok(gitServer.commandDirectories.every((directory) => directory === SECOND_FOLDER));

    gitServer.commandDirectories.length = 0;
    const branchResponse = await fetch(`${gitServer.baseUrl}/create-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', folder: SECOND_FOLDER, branch: 'feature/x' }),
    });
    assert.equal(branchResponse.status, 200);
    assert.ok(gitServer.commandDirectories.every((directory) => directory === SECOND_FOLDER));

    gitServer.commandDirectories.length = 0;
    await fetch(`${gitServer.baseUrl}/status?project=project-1`);
    assert.ok(gitServer.commandDirectories.length > 0);
    assert.ok(gitServer.commandDirectories.every((directory) => directory === PRIMARY_FOLDER));
  } finally {
    await gitServer.close();
  }
});

test('git routes reject a folder that is not part of the project instead of using the primary', async () => {
  const gitServer = await startTwoFolderGitServer();
  try {
    const query = new URLSearchParams({ project: 'project-1', folder: path.resolve('/workspace/elsewhere') });
    const response = await fetch(`${gitServer.baseUrl}/status?${query}`);
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'GIT_FOLDER_NOT_IN_PROJECT');

    const postResponse = await fetch(`${gitServer.baseUrl}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', folder: path.resolve('/workspace/elsewhere'), message: 'x', files: ['a'] }),
    });
    assert.equal(postResponse.status, 400);
    assert.deepEqual(gitServer.commandDirectories, []);
  } finally {
    await gitServer.close();
  }
});
