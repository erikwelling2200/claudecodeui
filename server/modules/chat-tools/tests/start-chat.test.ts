import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatToolsService } from '@/modules/chat-tools/index.js';
import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const CALLER_SESSION_ID = 'caller-session';

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

async function withIsolatedDatabase(runTest: (projectPath: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'start-chat-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  // These tests assert the exact prompt a provider receives.
  await chatToolsService.updateSettings({ appendMode: 'off' });

  try {
    userDb.createUser('starter', 'hash');
    sessionsDb.createAppSession(CALLER_SESSION_ID, 'claude', tempDirectory, 'Caller');
    await runTest(tempDirectory);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A runtime that records each run, reports when one starts, and finishes it when `release` is called. */
function createRuntime(runs: RunCall[]) {
  let release = () => {};
  let markStarted = () => {};
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    acceptsLiveTurn: () => false,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      runs.push({ provider, command, options });
      markStarted();
      await finished;
    },
  } as never;
  return { runtime, started, release: () => release() };
}

test('start_chat creates a session in the caller project and runs the message in auto mode', async () => {
  await withIsolatedDatabase(async (projectPath) => {
    const runs: RunCall[] = [];
    const { runtime, started, release } = createRuntime(runs);

    const result = await chatToolsService.startChat(CALLER_SESSION_ID, { message: 'Fix the build', model: 'opus', effort: 'high' }, runtime);
    await started;

    assert.notEqual(result.sessionId, CALLER_SESSION_ID);
    assert.equal(result.projectPath, projectPath);
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.provider, 'claude');
    // The new chat's turn keeps running after startChat returned.
    assert.equal(chatRunRegistry.isProcessing(result.sessionId), true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'Fix the build');
    assert.equal(runs[0].options.permissionMode, 'auto');
    assert.equal(runs[0].options.model, 'opus');
    assert.equal(runs[0].options.effort, 'high');
    release();
  });
});

test('start_chat refuses a caller session that does not exist', async () => {
  await withIsolatedDatabase(async () => {
    const { runtime } = createRuntime([]);
    await assert.rejects(chatToolsService.startChat('missing', { message: 'hi', model: 'opus' }, runtime), /was not found/);
  });
});
