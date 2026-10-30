import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeRuntime, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';
import { waitFor } from '@/shared/tests/wait-for.js';

/**
 * `/mcp` reads the servers of the chat's live process and reconnects them in
 * place, so both have to reach the query the run holds, and a chat without a
 * process has to say so instead of reporting an empty server list.
 */

const SESSION_ID = 'app-mcp-session';

const SDK_STATUS: AnyRecord[] = [
  {
    name: 'unity',
    status: 'failed',
    error: 'Connection closed',
    scope: 'user',
    config: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'secret' } },
  },
  {
    name: 'docs',
    status: 'connected',
    scope: 'project',
    config: { type: 'http', url: 'http://localhost:9000/mcp', headers: { Authorization: 'secret' } },
    serverInfo: { name: 'docs', version: '1.2.0' },
    tools: [{ name: 'search' }, { name: 'read' }],
  },
];

type Scripted = { end: () => void; reconnected: string[]; started: () => boolean };

/** A stand-in for the SDK query that stays open until ended and reports fixed MCP servers. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  let finish: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  const reconnected: string[] = [];
  let started = false;

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = () => {
    started = true;
    const iterator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'native-mcp-session' };
      await ended;
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      mcpServerStatus: async () => SDK_STATUS,
      reconnectMcpServer: async (name: string) => {
        if (name === 'missing') {
          throw new Error('Server not found: missing');
        }
        reconnected.push(name);
      },
    });
  };

  return { createQuery, script: { end: () => finish?.(), reconnected, started: () => started } };
}

async function withRun(runTest: (script: Scripted) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-mcp-'));
  const { createQuery, script } = createScriptedQuery();
  const writer = { send: () => {}, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    explainToolCall: async () => null,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await waitFor(() => script.started(), 'the run has created its query');
    await runTest(script);
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('lists the live servers sorted by name, without env vars or headers', async () => {
  await withRun(async () => {
    const servers = await claudeRuntime.listMcpServers(SESSION_ID);

    assert.deepEqual(servers, [
      {
        name: 'docs',
        status: 'connected',
        scope: 'project',
        transport: 'http',
        target: 'http://localhost:9000/mcp',
        serverVersion: '1.2.0',
        toolCount: 2,
      },
      {
        name: 'unity',
        status: 'failed',
        error: 'Connection closed',
        scope: 'user',
        transport: 'stdio',
        target: 'node server.js',
        toolCount: 0,
      },
    ]);
    assert.ok(!JSON.stringify(servers).includes('secret'));
  });
});

test('reconnects a server in the live process and passes its failure on', async () => {
  await withRun(async (script) => {
    assert.equal(await claudeRuntime.reconnectMcpServer(SESSION_ID, 'unity'), true);
    assert.deepEqual(script.reconnected, ['unity']);

    await assert.rejects(claudeRuntime.reconnectMcpServer(SESSION_ID, 'missing'), /Server not found/);
  });
});

test('a session with no live process reports null and reconnects nothing', async () => {
  assert.equal(await claudeRuntime.listMcpServers('no-such-session'), null);
  assert.equal(await claudeRuntime.reconnectMcpServer('no-such-session', 'unity'), false);
});
