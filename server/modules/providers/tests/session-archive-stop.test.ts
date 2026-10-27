import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

async function withIsolatedDatabase(runTest: (tempDirectory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-archive-stop-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// Runs first: the stopper is module state, installed by the later tests.
test('archiving with stopProcesses fails without archiving when no stopper is installed', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    sessionsDb.createAppSession('unstoppable', 'codex', tempDirectory);

    await assert.rejects(
      sessionsService.deleteOrArchiveSessionById('unstoppable', { stopProcesses: true }),
      (error: unknown) => (error as { code?: string }).code === 'SESSION_PROCESS_STOPPER_MISSING',
    );
    assert.equal(sessionsDb.getSessionById('unstoppable')?.isArchived, 0);
  });
});

test('archiving with stopProcesses stops the processes before the session is archived', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    sessionsDb.createAppSession('running', 'codex', tempDirectory);
    const archivedWhenStopped: number[] = [];
    sessionsService.setAppSessionProcessStopper(async (sessionId) => {
      archivedWhenStopped.push(sessionsDb.getSessionById(sessionId)?.isArchived ?? -1);
      return false;
    });

    const result = await sessionsService.deleteOrArchiveSessionById('running', { stopProcesses: true });

    assert.equal(result.action, 'archived');
    assert.deepEqual(archivedWhenStopped, [0]);
    assert.equal(sessionsDb.getSessionById('running')?.isArchived, 1);
  });
});

test('a plain archive leaves running processes alone', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    sessionsDb.createAppSession('plain', 'codex', tempDirectory);
    let stopperCalls = 0;
    sessionsService.setAppSessionProcessStopper(async () => {
      stopperCalls += 1;
      return false;
    });

    await sessionsService.deleteOrArchiveSessionById('plain');

    assert.equal(stopperCalls, 0);
    assert.equal(sessionsDb.getSessionById('plain')?.isArchived, 1);
  });
});

test('archiving or deleting a chat lets go of the process it keeps between turns', { concurrency: false }, async (t) => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const released: string[] = [];
    t.mock.method(providerRegistry, 'listProviders', () => [
      { id: 'claude', runtime: { releaseIdleProcess: (sessionId: string) => { released.push(sessionId); return true; } } },
    ]);
    sessionsDb.createAppSession('closed-chat', 'claude', tempDirectory);
    sessionsDb.createAppSession('deleted-chat', 'claude', tempDirectory);

    await sessionsService.deleteOrArchiveSessionById('closed-chat');
    await sessionsService.deleteOrArchiveSessionById('deleted-chat', { force: true });

    assert.deepEqual(released, ['closed-chat', 'deleted-chat']);
  });
});
