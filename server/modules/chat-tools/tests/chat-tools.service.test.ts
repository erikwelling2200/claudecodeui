import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatToolsService } from '@/modules/chat-tools/chat-tools.service.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { parseFilesInputTag } from '@/shared/image-attachments.js';
import { appendPromptText, normalizeSessionName, stripAppendedPromptText } from '@/shared/utils.js';

async function withIsolatedDatabase(run: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-tools-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await run();
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

test('appended text round-trips: history readers show only what the user typed', () => {
  const sent = appendPromptText('Fix the login bug', 'Name this chat first.');
  assert.match(sent, /Name this chat first\./);
  assert.equal(stripAppendedPromptText(sent), 'Fix the login bug');
  assert.equal(appendPromptText('Fix it', '   '), 'Fix it', 'blank text appends nothing');
});

test('the shared prompt parser drops appended text next to a files block', () => {
  const sent = `${appendPromptText('Look at this', 'Name this chat first.')}\n\n<files_input>\n1. C:/a.txt\n</files_input>`;
  const parsed = parseFilesInputTag(sent);
  assert.equal(parsed.text, 'Look at this');
  assert.equal(parsed.filePaths.length, 1);
});

test('appendToPrompt follows the append mode and skips slash commands', async () => {
  await withIsolatedDatabase(async () => {
    const appended = chatToolsService.appendToPrompt('hello', true);
    assert.notEqual(appended, 'hello', 'the default appends to the first message');
    assert.equal(chatToolsService.appendToPrompt('hello', false), 'hello', 'the default leaves follow-ups alone');
    assert.equal(chatToolsService.appendToPrompt('/compact', true), '/compact');

    await chatToolsService.updateSettings({ appendMode: 'every', appendText: 'Be brief.' });
    assert.equal(stripAppendedPromptText(chatToolsService.appendToPrompt('hello', false)), 'hello');
    assert.match(chatToolsService.appendToPrompt('hello', false), /Be brief\./);

    await chatToolsService.updateSettings({ appendMode: 'off' });
    assert.equal(chatToolsService.appendToPrompt('hello', true), 'hello');
    await assert.rejects(chatToolsService.updateSettings({ appendMode: 'sometimes' as never }), /appendMode/);
  });
});

test('setChatName renames the chat and rejects blank or overlong names', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-1', 'claude', path.resolve('/home/test/project'), 'First message');

    const result = await chatToolsService.setChatName('app-1', '  Login   bug fix ');
    assert.deepEqual(result, { sessionId: 'app-1', summary: 'Login bug fix' });
    assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Login bug fix');

    await assert.rejects(chatToolsService.setChatName('app-1', '   '), /name is required/);
    await assert.rejects(chatToolsService.setChatName('app-1', 'x'.repeat(81)), /longer than/);
    await assert.rejects(chatToolsService.setChatName('missing', 'Some name'), /was not found/);
  });
});

test('a chat title taken from a prompt leaves out the appended text', () => {
  assert.equal(normalizeSessionName(appendPromptText('Fix the login form', 'Name this chat first.'), 'Untitled'), 'Fix the login form');
});

test('the registered MCP command answers the handshake when started outside the repo', async () => {
  await withIsolatedDatabase(async () => {
    // The test runner itself runs under `tsx --tsconfig server/tsconfig.json`, so this
    // process carries the relative TSX_TSCONFIG_PATH an agent CLI would pass on.
    assert.equal(await chatToolsService.checkMcpStarts(), null);
  });
});
