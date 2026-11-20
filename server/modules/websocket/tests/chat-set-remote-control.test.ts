import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { createFakeSocket } from '@/modules/websocket/tests/fake-chat-socket.js';

const PARENT_ID = 'parent-session';
const THREAD_ID = 'thread-session';
const OTHER_ID = 'other-session';

type RemoteControlCall = { sessionId: string; enabled: boolean };

/** A gateway whose runtime has a live process only for the parent. */
async function withGateway(
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; calls: RemoteControlCall[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-set-remote-control-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const calls: RemoteControlCall[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(PARENT_ID, 'claude', tempDirectory);
    sessionsDb.createAppSession(THREAD_ID, 'claude', tempDirectory, undefined, PARENT_ID);
    sessionsDb.createAppSession(OTHER_ID, 'claude', tempDirectory);

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          setRemoteControl: async (_provider: string, sessionId: string, enabled: boolean) => {
            calls.push({ sessionId, enabled });
            return sessionId === PARENT_ID ? { enabled, sessionUrl: enabled ? 'https://claude.ai/code/parent' : null } : null;
          },
        } as never,
      },
    );

    await runTest({ socket, calls });
  } finally {
    connectedClients.clear();
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

test('turning Remote Control on for a chat turns it on for its threads', async () => {
  await withGateway(async ({ socket, calls }) => {
    await socket.deliver({ type: 'chat.set-remote-control', sessionId: PARENT_ID, enabled: true });

    assert.deepEqual(calls.map((call) => call.sessionId).sort(), [PARENT_ID, THREAD_ID].sort());
    assert.equal(sessionsDb.getSessionById(PARENT_ID)?.remote_control, 1);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.remote_control, 1);
    assert.equal(sessionsDb.getSessionById(OTHER_ID)?.remote_control, 0);

    // A thread with no live process is still reported, so every client records the wish.
    const events = socket.frames.filter((frame) => frame.kind === 'remote_control');
    assert.deepEqual(
      events.map((event) => [event.sessionId, event.enabled, event.sessionUrl]).sort(),
      [[PARENT_ID, true, 'https://claude.ai/code/parent'], [THREAD_ID, true, null]].sort(),
    );
  });
});

test('turning Remote Control off for a chat turns it off for its threads', async () => {
  await withGateway(async ({ socket }) => {
    await socket.deliver({ type: 'chat.set-remote-control', sessionId: PARENT_ID, enabled: true });
    await socket.deliver({ type: 'chat.set-remote-control', sessionId: PARENT_ID, enabled: false });

    assert.equal(sessionsDb.getSessionById(PARENT_ID)?.remote_control, 0);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.remote_control, 0);
    assert.equal(socket.frames.filter((frame) => frame.kind === 'remote_control' && frame.enabled === false).length, 2);
  });
});

test('a thread switched on its own leaves its parent alone', async () => {
  await withGateway(async ({ calls }) => {
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: { setRemoteControl: async () => null } as never });
    await socket.deliver({ type: 'chat.set-remote-control', sessionId: THREAD_ID, enabled: true });

    assert.equal(calls.length, 0);
    assert.equal(sessionsDb.getSessionById(THREAD_ID)?.remote_control, 1);
    assert.equal(sessionsDb.getSessionById(PARENT_ID)?.remote_control, 0);
  });
});

test('starting a Remote Control chat launches its process idle with the bridge on', async () => {
  await withGateway(async () => {
    const runs: Array<{ command: string; options: Record<string, unknown> }> = [];
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, command: string, options: Record<string, unknown>) => {
          runs.push({ command, options });
        },
      } as never,
    });
    await socket.deliver({ type: 'chat.start-remote-control', sessionId: OTHER_ID, options: { model: 'opus' } });

    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.startIdle, true);
    assert.equal(runs[0].options.remoteControl, true);
    assert.equal(runs[0].options.model, 'opus');
    assert.equal(sessionsDb.getSessionById(OTHER_ID)?.remote_control, 1);
  });
});

test('a chat that already ran a turn is not started again for Remote Control', async () => {
  await withGateway(async () => {
    sessionsDb.assignProviderSessionId(OTHER_ID, 'provider-other');
    let launched = false;
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: { hasRuntime: () => true, run: async () => { launched = true; } } as never,
    });
    await socket.deliver({ type: 'chat.start-remote-control', sessionId: OTHER_ID });

    assert.equal(launched, false);
    assert.ok(socket.frames.some((frame) => frame.code === 'SESSION_ALREADY_STARTED' || JSON.stringify(frame).includes('SESSION_ALREADY_STARTED')));
  });
});
