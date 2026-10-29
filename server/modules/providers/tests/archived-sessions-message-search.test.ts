import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';

async function withIsolatedDatabase(runTest: (tempDirectory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'archived-message-search-'));

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

const userLine = (message: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } });
const assistantLine = (text: string) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});

async function addCodexSession(tempDirectory: string, id: string, lines: string[], archived: boolean): Promise<void> {
  const jsonlPath = path.join(tempDirectory, `${id}.jsonl`);
  await writeFile(jsonlPath, `${lines.join('\n')}\n`);
  sessionsDb.createSession(id, 'codex', tempDirectory, undefined, undefined, undefined, jsonlPath);
  sessionsDb.updateSessionIsArchived(id, archived);
}

test('archived message search matches only what the user typed, only in archived sessions', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    await addCodexSession(tempDirectory, 'typed-by-user', [userLine('please fix the flaky widget test'), assistantLine('done')], true);
    await addCodexSession(tempDirectory, 'said-by-assistant', [userLine('hello'), assistantLine('the widget is fine')], true);
    await addCodexSession(tempDirectory, 'still-open', [userLine('another widget question')], false);

    const matches = await sessionConversationsSearchService.searchArchivedUserMessages('widget', new AbortController().signal);

    assert.deepEqual(matches.map((match) => match.sessionId), ['typed-by-user']);
    assert.match(matches[0].snippet, /flaky widget/);
  });
});
