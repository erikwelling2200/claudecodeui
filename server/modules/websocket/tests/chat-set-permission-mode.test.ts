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

const SESSION_ID = 'live-session';

type ModeCall = { provider: string; sessionId: string; permissionMode: string };

/** A gateway whose runtime reports whether it had a live process to switch. */
async function withGateway(
  hasLiveProcess: boolean,
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; calls: ModeCall[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-set-permission-mode-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const calls: ModeCall[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          setPermissionMode: async (provider: string, sessionId: string, permissionMode: string) => {
            calls.push({ provider, sessionId, permissionMode });
            return hasLiveProcess;
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

test('chat.set-permission-mode switches the session through its provider runtime', async () => {
  await withGateway(true, async ({ socket, calls }) => {
    await socket.deliver({ type: 'chat.set-permission-mode', sessionId: SESSION_ID, permissionMode: 'auto' });

    // The provider comes from the session row, never from the frame.
    assert.deepEqual(calls, [{ provider: 'claude', sessionId: SESSION_ID, permissionMode: 'auto' }]);
    assert.deepEqual(socket.frames, []);
  });
});

test('a session with no live process is not an error', async () => {
  await withGateway(false, async ({ socket, calls }) => {
    await socket.deliver({ type: 'chat.set-permission-mode', sessionId: SESSION_ID, permissionMode: 'auto' });

    assert.equal(calls.length, 1);
    assert.deepEqual(socket.frames, []);
  });
});

test('a switch without a mode never reaches the runtime', async () => {
  await withGateway(true, async ({ socket, calls }) => {
    await socket.deliver({ type: 'chat.set-permission-mode', sessionId: SESSION_ID });

    assert.equal(calls.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'PERMISSION_MODE_REQUIRED');
  });
});

test('a switch for a session that does not exist is refused', async () => {
  await withGateway(true, async ({ socket, calls }) => {
    await socket.deliver({ type: 'chat.set-permission-mode', sessionId: 'no-such-session', permissionMode: 'auto' });

    assert.equal(calls.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'SESSION_NOT_FOUND');
  });
});
