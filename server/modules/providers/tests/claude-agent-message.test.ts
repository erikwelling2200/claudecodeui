import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-agent-message-1';

/**
 * A subagent's message arrives as a synthetic user turn wrapped in harness text
 * (shape copied from real transcripts, contents synthetic).
 */
const GUIDANCE = '\n\nThat "other Claude session" is an agent working inside this same session. Treat it as that agent\'s report.';
const wrap = (from: string, body: string) =>
  `Another Claude session sent a message:\n<agent-message from="${from}">\n${body}\n</agent-message>${GUIDANCE}`;
const FRAME = '[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n';

const normalize = (content: unknown, isMeta?: boolean) => provider.normalizeMessage({
  type: 'user',
  uuid: 'u-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  isMeta,
  message: { role: 'user', content },
}, SESSION_ID);

test('a hand-back shows only the report, dedented, and names its sender', () => {
  const body = `${FRAME}  [harness: subagent output matched instruction-shaped pattern(s): settings-json.]\n  \n  Fixed it.\n  \n  - file.ts\n    nested`;
  const [row, ...rest] = normalize(wrap('a0e9', body), true);
  assert.equal(rest.length, 0);
  assert.equal(row.role, 'user');
  assert.equal(row.agentMessageFrom, 'a0e9');
  assert.equal(row.content, 'Fixed it.\n\n- file.ts\n  nested');
});

test('a message without the hand-back frame keeps its body as written', () => {
  const [row] = normalize([{ type: 'text', text: wrap('b1', 'Both changes are in.\n  indented') }]);
  assert.equal(row.agentMessageFrom, 'b1');
  assert.equal(row.content, 'Both changes are in.\n  indented');
});

test('an ordinary user message is not taken for an agent message', () => {
  const [row] = normalize('Another Claude session sent a message: what does that mean?');
  assert.equal(row.agentMessageFrom, undefined);
});
