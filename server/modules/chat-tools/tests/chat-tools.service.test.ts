import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatToolsService, isSameMcpRegistration } from '@/modules/chat-tools/chat-tools.service.js';
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

test('a provider entry left by another CloudCLI instance does not count as registered', () => {
  const input = {
    name: 'cloudcli-chat',
    scope: 'user' as const,
    transport: 'stdio' as const,
    command: 'node',
    args: ['C:\\Tools\\claudecodeui\\chat-tools-mcp.ts'],
    env: { CLOUDCLI_CHAT_TOOLS_MCP_TOKEN: 'main-token', CLOUDCLI_CHAT_TOOLS_API_URL: 'http://127.0.0.1:3001/api/chat-tools-mcp' },
    envVars: ['CLOUDCLI_SESSION_ID'],
  };
  const entry = { provider: 'claude' as const, name: 'cloudcli-chat', scope: 'user' as const, transport: 'stdio' as const, command: 'node', args: [...input.args], env: { ...input.env } };

  assert.equal(isSameMcpRegistration(entry, input), true);
  assert.equal(isSameMcpRegistration(null, input), false, 'a missing entry');
  assert.equal(isSameMcpRegistration({ ...entry, env: { ...entry.env, CLOUDCLI_CHAT_TOOLS_API_URL: 'http://127.0.0.1:3012/api/chat-tools-mcp' } }, input), false, 'another port');
  assert.equal(isSameMcpRegistration({ ...entry, env: { ...entry.env, CLOUDCLI_CHAT_TOOLS_MCP_TOKEN: 'alt-token' } }, input), false, 'another token');
  assert.equal(isSameMcpRegistration({ ...entry, args: ['C:\\Tools\\claudecodeui-alt1\\chat-tools-mcp.ts'] }, input), false, 'another checkout');
});

test('followUpForSlashCommand carries the appended text for slash commands only', async () => {
  await withIsolatedDatabase(async () => {
    assert.equal(chatToolsService.followUpForSlashCommand('hello', true), null, 'plain text gets it appended instead');
    assert.match(chatToolsService.followUpForSlashCommand('/changefied:timesheet', true) ?? '', /set_chat_name/);
    assert.equal(chatToolsService.followUpForSlashCommand('/changefied:timesheet', false), null, 'the default covers the first message');

    await chatToolsService.updateSettings({ appendMode: 'off' });
    assert.equal(chatToolsService.followUpForSlashCommand('/changefied:timesheet', true), null);
  });
});

test('getChatThreads shows a chat its threads, and a thread its parent and siblings', async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = path.join(tmpdir(), 'chat-threads-project');
    sessionsDb.createAppSession('parent', 'claude', projectPath, 'Release prep');
    sessionsDb.createAppSession('thread-a', 'claude', projectPath, 'Changelog', 'parent');
    sessionsDb.createAppSession('thread-b', 'claude', projectPath, 'Build', 'parent');
    sessionsDb.updateSessionIsArchived('thread-b', true);
    sessionsDb.createAppSession('loner', 'claude', projectPath, 'Unrelated');
    const runtime = { hasBackgroundWork: (sessionId: string) => sessionId === 'thread-a' };

    const fromParent = chatToolsService.getChatThreads('parent', runtime);
    assert.equal(fromParent.parent, null);
    assert.deepEqual(fromParent.chat, { sessionId: 'parent', name: 'Release prep', running: false, archived: false });
    assert.deepEqual(fromParent.threads.map((thread) => [thread.sessionId, thread.running, thread.archived]).sort(), [['thread-a', true, false], ['thread-b', false, true]]);

    const fromThread = chatToolsService.getChatThreads('thread-a', runtime);
    assert.equal(fromThread.parent?.sessionId, 'parent');
    assert.equal(fromThread.parent?.name, 'Release prep');
    assert.deepEqual(fromThread.threads.map((thread) => thread.sessionId).sort(), ['thread-a', 'thread-b']);

    assert.deepEqual(chatToolsService.getChatThreads('loner', runtime).threads, []);
    assert.throws(() => chatToolsService.getChatThreads('missing', runtime), /was not found/);
  });
});

test('a thread first turn names its parent chat, whatever the append mode', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('parent', 'claude', path.join(tmpdir(), 'chat-threads-project'), 'Release prep');
    await chatToolsService.updateSettings({ appendMode: 'off' });

    const sent = chatToolsService.appendToPrompt('Write the changelog', true, 'parent');
    assert.match(sent, /thread of the CloudCLI chat parent \("Release prep"\)/);
    assert.match(sent, /get_chat_threads/);
    assert.equal(stripAppendedPromptText(sent), 'Write the changelog');
    assert.equal(chatToolsService.appendToPrompt('Next step', false, 'parent'), 'Next step', 'only the first turn carries the note');
    assert.match(chatToolsService.followUpForSlashCommand('/changefied:changelog', true, 'parent') ?? '', /thread of the CloudCLI chat parent/);

    await chatToolsService.updateSettings({ appendMode: 'first', appendText: 'Name this chat.' });
    const both = chatToolsService.appendToPrompt('Write the changelog', true, 'parent');
    assert.match(both, /thread of the CloudCLI chat parent[\s\S]*Name this chat\./);
  });
});
