import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatToolsService } from '@/modules/chat-tools/index.js';
import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const CALLER_SESSION_ID = 'caller-session';
const TARGET_SESSION_ID = 'target-session';

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'resume-chat-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  // These tests assert the exact prompt a provider receives.
  await chatToolsService.updateSettings({ appendMode: 'off' });

  try {
    userDb.createUser('resumer', 'hash');
    sessionsDb.createAppSession(CALLER_SESSION_ID, 'claude', tempDirectory, 'Caller');
    sessionsDb.createAppSession(TARGET_SESSION_ID, 'claude', tempDirectory, 'Target');
    await runTest();
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
function createRuntime(runs: RunCall[], backgroundWork = false) {
  let release = () => {};
  let markStarted = () => {};
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runtime = {
    hasRuntime: () => true,
    hasBackgroundWork: () => backgroundWork,
    acceptsLiveTurn: () => false,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      runs.push({ provider, command, options });
      markStarted();
      await finished;
    },
  } as never;
  return { runtime, started, release: () => release() };
}

test('resume_chat runs the message in the existing chat on the model it last ran with', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.setSessionModel(TARGET_SESSION_ID, 'sonnet');
    sessionsDb.setSessionEffort(TARGET_SESSION_ID, 'high');
    const runs: RunCall[] = [];
    const { runtime, started, release } = createRuntime(runs);

    const result = await chatToolsService.resumeChat(CALLER_SESSION_ID, { targetSessionId: TARGET_SESSION_ID, message: 'All agents are done.' }, runtime);
    await started;

    assert.equal(result.sessionId, TARGET_SESSION_ID);
    assert.equal(chatRunRegistry.isProcessing(TARGET_SESSION_ID), true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'All agents are done.');
    assert.equal(runs[0].options.sessionId, TARGET_SESSION_ID);
    assert.equal(runs[0].options.model, 'sonnet');
    assert.equal(runs[0].options.effort, 'high');
    assert.equal(runs[0].options.permissionMode, 'auto');
    release();
  });
});

test('resume_chat refuses a chat that is running or still has background work', async () => {
  await withIsolatedDatabase(async () => {
    const { runtime, started, release } = createRuntime([]);
    await chatToolsService.resumeChat(CALLER_SESSION_ID, { targetSessionId: TARGET_SESSION_ID, message: 'First' }, runtime);
    await started;

    await assert.rejects(chatToolsService.resumeChat(CALLER_SESSION_ID, { targetSessionId: TARGET_SESSION_ID, message: 'Second' }, runtime), /still running/);
    release();

    const busy = createRuntime([], true);
    await assert.rejects(chatToolsService.resumeChat(CALLER_SESSION_ID, { targetSessionId: CALLER_SESSION_ID, message: 'Hi' }, busy.runtime), /still running/);
  });
});

test('resume_chat refuses a chat that does not exist', async () => {
  await withIsolatedDatabase(async () => {
    const { runtime } = createRuntime([]);
    await assert.rejects(chatToolsService.resumeChat(CALLER_SESSION_ID, { targetSessionId: 'missing', message: 'hi' }, runtime), /was not found/);
  });
});
