import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { stopAppSessionProcesses } from '@/modules/websocket/services/session-process-stop.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';

type AbortCall = { provider: string; sessionId: string };

function createRuntime(hasBackgroundWork = false) {
  const aborts: AbortCall[] = [];
  return {
    aborts,
    abort: async (provider: string, sessionId: string) => {
      aborts.push({ provider, sessionId });
      return true;
    },
    hasBackgroundWork: () => hasBackgroundWork,
  };
}

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (data: string) => void };
  socket.readyState = WebSocket.OPEN;
  socket.send = () => {};
  return socket;
}

/** A pty that reports its exit to every listener as soon as it is killed, like node-pty does. */
function createFakePty() {
  const exitListeners: Array<(event: { exitCode: number }) => void> = [];
  return {
    killed: false,
    onData: () => ({ dispose: () => undefined }),
    onExit(listener: (event: { exitCode: number }) => void) {
      exitListeners.push(listener);
      return { dispose: () => undefined };
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
      exitListeners.forEach((listener) => listener({ exitCode: 0 }));
    },
  };
}

function openShell(sessionId: string) {
  const pty = createFakePty();
  const socket = createFakeSocket();
  handleShellConnection(socket as never, { resolveProviderSessionId: () => null, spawnPty: () => pty as never });
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
  }));
  return pty;
}

test('a running chat run is aborted and completed as aborted', async () => {
  const sessionId = `stop-running-${Date.now()}`;
  chatRunRegistry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: null });
  const runtime = createRuntime();

  const stopped = await stopAppSessionProcesses(sessionId, runtime as never);

  assert.equal(stopped, true);
  assert.deepEqual(runtime.aborts, [{ provider: 'claude', sessionId }]);
  assert.equal(chatRunRegistry.isProcessing(sessionId), false);
});

test('a process held open for background work is aborted through the session provider', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-process-stop-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession('held-session', 'codex', tempDirectory);
    const runtime = createRuntime(true);

    const stopped = await stopAppSessionProcesses('held-session', runtime as never);

    assert.equal(stopped, true);
    assert.deepEqual(runtime.aborts, [{ provider: 'codex', sessionId: 'held-session' }]);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('only the shell ptys opened on the session are killed', async () => {
  const sessionId = `stop-shell-${Date.now()}`;
  const ownPty = openShell(sessionId);
  const otherPty = openShell(`${sessionId}-other`);
  const runtime = createRuntime();

  const stopped = await stopAppSessionProcesses(sessionId, runtime as never);

  assert.equal(stopped, true);
  assert.equal(ownPty.killed, true);
  assert.equal(otherPty.killed, false);
  assert.deepEqual(runtime.aborts, []);
  otherPty.kill();
});

test('a session with nothing running reports that nothing was stopped', async () => {
  const runtime = createRuntime();

  const stopped = await stopAppSessionProcesses(`idle-${Date.now()}`, runtime as never);

  assert.equal(stopped, false);
  assert.deepEqual(runtime.aborts, []);
});
