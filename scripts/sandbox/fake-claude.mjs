#!/usr/bin/env node
// Stand-in for the Claude Code CLI inside the sandbox. It speaks enough of the SDK's stream-json protocol for a
// chat to run end to end, answers from a script instead of a model, and writes the same JSONL transcript the real
// CLI writes, so reloading a sandbox chat shows its history. It makes no network calls.
//
// What the reply contains depends on words in the prompt:
//   "tool"  - a Bash tool call and its result before the answer
//   "error" - the turn ends as an error
//   "slow"  - the answer streams in over a few seconds
//   "long"  - a long markdown answer with a table and a code block
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { encodeClaudeProjectDir } from './seed.mjs';

const MODEL = 'claude-sandbox';
const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args.includes('--version') || args.includes('-v')) {
  console.log('2.1.0 (Claude Code sandbox)');
  process.exit(0);
}

const sessionId = argValue('--resume') ?? argValue('--session-id') ?? randomUUID();
const cwd = process.cwd();
const transcriptPath = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
let parentUuid = null;
let initSent = false;

function emit(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function record(entry) {
  const uuid = randomUUID();
  const line = { parentUuid, isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.0', uuid, timestamp: new Date().toISOString(), ...entry };
  parentUuid = uuid;
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.appendFileSync(transcriptPath, JSON.stringify(line) + '\n');
  return uuid;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assistantMessage(content, stopReason = 'end_turn') {
  return { id: `msg_sandbox_${randomUUID().slice(0, 8)}`, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}

function sendAssistant(content, stopReason) {
  const message = assistantMessage(content, stopReason);
  const uuid = record({ type: 'assistant', message });
  emit({ type: 'assistant', message, parent_tool_use_id: null, session_id: sessionId, uuid });
}

function sendToolResult(toolUseId, output, isError = false) {
  const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: isError }] };
  const uuid = record({ type: 'user', message });
  emit({ type: 'user', message, parent_tool_use_id: null, session_id: sessionId, uuid });
}

/** The prompt as the user typed it, without the instructions the server appends to it. */
function promptText(content) {
  const text = typeof content === 'string' ? content : content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  return text.replace(/<cloudcli_appended>[\s\S]*?<\/cloudcli_appended>/g, '').trim();
}

const LONG_ANSWER = [
  '## Sandbox report', '', 'Here is a longer answer for testing layout.', '',
  '| File | Lines | Status |', '| --- | ---: | --- |', '| src/cart.js | 3 | ok |', '| src/discount.js | 4 | ok |', '| src/checkout.js | 1 | draft |', '',
  '```js', 'export function cartTotal(items) {', '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);', '}', '```', '',
  ...Array.from({ length: 12 }, (_, index) => `${index + 1}. Point number ${index + 1}, which exists only to take up space.`),
].join('\n');

async function runTurn(userMessage) {
  const started = Date.now();
  const text = promptText(userMessage.message.content);
  record({ type: 'user', message: userMessage.message });

  if (!initSent) {
    initSent = true;
    emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd, model: MODEL, tools: ['Bash', 'Read', 'Edit', 'Write'], mcp_servers: [], permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', uuid: randomUUID() });
  }

  const lower = text.toLowerCase();
  await sleep(500);

  if (lower.includes('tool')) {
    const toolUseId = `toolu_sandbox_${randomUUID().slice(0, 12)}`;
    sendAssistant([{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls', description: 'List files' } }], 'tool_use');
    await sleep(400);
    sendToolResult(toolUseId, fs.readdirSync(cwd).join('\n'));
    await sleep(300);
  }

  const isError = lower.includes('error');
  let answer = lower.includes('long') ? LONG_ANSWER : `Sandbox reply to: "${text.slice(0, 200)}"\n\nThis chat runs a fake Claude CLI; nothing was sent to a model.`;
  if (isError) answer = 'Sandbox error: the prompt asked for one.';

  if (lower.includes('slow')) {
    for (let second = 1; second <= 4; second++) {
      sendAssistant([{ type: 'text', text: `Working slowly... ${second}/4` }]);
      await sleep(1000);
    }
  }
  sendAssistant([{ type: 'text', text: answer }]);

  emit({
    type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, duration_ms: Date.now() - started, duration_api_ms: 0, num_turns: 1,
    result: answer, session_id: sessionId, total_cost_usd: 0, stop_reason: 'end_turn',
    usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [MODEL]: { inputTokens: 900, outputTokens: 120, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, contextWindow: 200000 } },
    permission_denials: [], uuid: randomUUID(),
  });
}

function answerControlRequest(message) {
  const subtype = message.request?.subtype;
  const response = subtype === 'initialize'
    ? {
      commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], account: { email: 'sandbox@example.invalid' },
      models: [{ value: MODEL, displayName: 'Sandbox', description: 'Scripted replies, no model behind it' }],
    }
    : {};
  emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
}

// Turns run one at a time, in arrival order, like the real CLI.
let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    answerControlRequest(message);
  } else if (message.type === 'user') {
    queue = queue.then(() => runTurn(message));
  }
});
input.on('close', () => queue.then(() => process.exit(0)));
