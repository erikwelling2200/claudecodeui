import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { createSessionPermissionModeService } from '@/modules/providers/services/session-permission-mode.service.js';

type Row = { permission_mode: string | null };

const createService = (rows: Record<string, Row>, providerMode: string | null = null) => {
  const sessions = {
    getSessionById: (sessionId: string) => rows[sessionId] ?? null,
    setSessionPermissionMode: (sessionId: string, permissionMode: string) => {
      rows[sessionId].permission_mode = permissionMode;
    },
  };
  const resolveProvider = () => ({
    models: { getSessionPermissionMode: async () => providerMode },
  }) as never;
  return createSessionPermissionModeService({ sessions, resolveProvider });
};

test('the mode recorded on the row wins over the provider record', async () => {
  const service = createService({ s1: { permission_mode: 'plan' } }, 'auto');

  assert.equal(await service.resolve('claude', 's1'), 'plan');
});

test('a row with no mode falls back to the provider record', async () => {
  const service = createService({ s1: { permission_mode: null } }, 'auto');

  assert.equal(await service.resolve('claude', 's1'), 'auto');
});

test('a provider record the provider does not offer is ignored', async () => {
  const service = createService({ s1: { permission_mode: null } }, 'auto');

  // Codex has no auto mode.
  assert.equal(await service.resolve('codex', 's1'), null);
});

test('record ignores a session the gateway has not created yet', () => {
  const rows: Record<string, Row> = {};
  const service = createService(rows);

  service.record('claude', 'missing', 'plan');

  assert.deepEqual(rows, {});
});

test('Claude reads the mode of the last prompt in the transcript', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-permission-mode-'));
  try {
    const jsonlPath = path.join(directory, 'session.jsonl');
    await writeFile(jsonlPath, [
      JSON.stringify({ type: 'user', permissionMode: 'auto', message: { content: 'first' } }),
      JSON.stringify({ type: 'user', permissionMode: 'plan', message: { content: 'second' } }),
      // Tool results carry no mode and must not hide the prompt before them.
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: 'reply' } }),
    ].join('\n'));

    const { sessionsDb } = await import('@/modules/database/index.js');
    const original = sessionsDb.getSessionById;
    sessionsDb.getSessionById = (() => ({ jsonl_path: jsonlPath })) as never;
    try {
      assert.equal(await new ClaudeProviderModels().getSessionPermissionMode('s1'), 'plan');
    } finally {
      sessionsDb.getSessionById = original;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
