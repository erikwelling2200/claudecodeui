import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatToolsService } from '@/modules/chat-tools/index.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import type { LiveMcpServerStatus } from '@/shared/types.js';

const SESSION_ID = 'caller-session';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-reconnect-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Caller');
    await runTest();
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

/** A runtime holding one live Claude process whose `unity` server is down until reconnected. */
function createFakeRuntime(options: { live?: boolean; reconnectError?: string } = {}) {
  const servers: LiveMcpServerStatus[] = [{ name: 'unity', status: 'failed', error: 'Connection closed', toolCount: 0 }];
  const calls: { provider: string; sessionId: string; serverName: string }[] = [];
  return {
    calls,
    async listMcpServers(_provider: string, _sessionId: string) {
      return options.live === false ? null : servers.map((server) => ({ ...server }));
    },
    async reconnectMcpServer(provider: string, sessionId: string, serverName: string) {
      calls.push({ provider, sessionId, serverName });
      if (options.live === false) return false;
      if (options.reconnectError) throw new Error(options.reconnectError);
      Object.assign(servers[0], { status: 'connected', error: undefined, toolCount: 12 });
      return true;
    },
  } as never as Parameters<typeof chatToolsService.reconnectMcpServer>[2] & { calls: typeof calls };
}

test('reconnect_mcp_server reconnects the caller\'s server and reports its state afterwards', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createFakeRuntime();
    assert.equal((await chatToolsService.listMcpServers(SESSION_ID, runtime)).servers[0].status, 'failed');

    const { server } = await chatToolsService.reconnectMcpServer(SESSION_ID, 'unity', runtime);
    assert.deepEqual(runtime.calls, [{ provider: 'claude', sessionId: SESSION_ID, serverName: 'unity' }]);
    assert.equal(server?.status, 'connected');
    assert.equal(server?.toolCount, 12);
  });
});

test('reconnect_mcp_server passes the SDK\'s failure on and refuses what it cannot do', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(chatToolsService.reconnectMcpServer(SESSION_ID, 'unity', createFakeRuntime({ reconnectError: 'ECONNREFUSED' })), /ECONNREFUSED/);
    await assert.rejects(chatToolsService.reconnectMcpServer(SESSION_ID, 'unity', createFakeRuntime({ live: false })), /no live process/);
    await assert.rejects(chatToolsService.listMcpServers(SESSION_ID, createFakeRuntime({ live: false })), /no live process/);
    await assert.rejects(chatToolsService.reconnectMcpServer(SESSION_ID, 'cloudcli-chat', createFakeRuntime()), /cannot reconnect itself/);
    await assert.rejects(chatToolsService.reconnectMcpServer('missing-session', 'unity', createFakeRuntime()), /was not found/);
  });
});
