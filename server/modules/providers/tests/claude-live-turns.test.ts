import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  acceptsClaudeSDKLiveTurn,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A turn sent while the previous one's background work still holds the CLI
 * process open goes into that process as streaming input, the way the CLI
 * takes a new prompt while its agents run: no interrupt, no new process, and
 * the work keeps running and reporting. Options only a launch can set still
 * start a new process. Driven with a scripted SDK stream through
 * `context.createQuery`, which also records what reaches the CLI's stdin.
 */

const NATIVE_ID = 'native-live-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  /** Prompt texts the CLI has read from stdin, in order. */
  prompts: string[];
  calls: string[];
};

/**
 * Each query gets its own scripted stream; `emit` feeds the newest one (the
 * process the session is on), `end` ends them all, and `released` watches the
 * first process's stdin — the one held for the background work.
 */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted; queries: () => number } {
  type Stream = { queue: Array<Record<string, unknown> | null>; wake: (() => void) | null; released: boolean };
  // The first stream exists before its query does, so a test can script it
  // while the run is still preparing.
  const streams: Stream[] = [{ queue: [], wake: null, released: false }];
  let queries = 0;
  const prompts: string[] = [];
  const calls: string[] = [];
  const push = (stream: Stream, message: Record<string, unknown> | null) => {
    stream.queue.push(message);
    const wake = stream.wake;
    stream.wake = null;
    wake?.();
  };

  const script: Scripted = {
    emit: (message) => { push(streams[streams.length - 1]!, message); },
    end: () => { for (const stream of streams) push(stream, null); },
    released: () => Boolean(streams[0]?.released),
    prompts,
    calls,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    if (queries > 0) {
      streams.push({ queue: [], wake: null, released: false });
    }
    queries += 1;
    const stream = streams[streams.length - 1]!;
    void (async () => {
      for await (const message of prompt) {
        prompts.push(String((message as { message: { content: unknown } }).message.content));
      }
      stream.released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (stream.queue.length === 0) {
          await new Promise<void>((resolve) => { stream.wake = resolve; });
          continue;
        }
        const next = stream.queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => { calls.push('interrupt'); },
      stopTask: async (taskId: string) => { calls.push(`stopTask:${taskId}`); },
      setModel: async (model?: string) => { calls.push(`setModel:${model}`); },
      setPermissionMode: async (mode: string) => { calls.push(`setPermissionMode:${mode}`); },
    });
  };

  return { createQuery, script, queries: () => queries };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const text = (value: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text: value }] },
});
const taskStarted = (taskId: string, toolUseId: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: 'local_agent',
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });

type Writer = { sent: NormalizedMessage[]; writer: never; completes: () => NormalizedMessage[] };
const createWriter = (): Writer => {
  const sent: NormalizedMessage[] = [];
  return {
    sent,
    writer: { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null } as never,
    completes: () => sent.filter((message) => message.kind === 'complete'),
  };
};

/**
 * Starts a session whose first turn launches a background agent and ends,
 * leaving the process held for it. Hands the test the pieces to send the
 * next turn with, and winds everything down afterwards.
 */
async function withHeldSession(
  sessionId: string,
  runTest: (context: {
    script: Scripted;
    queries: () => number;
    first: Writer;
    firstRun: Promise<void>;
    send: (command: string, options?: Record<string, unknown>) => { writer: Writer; run: Promise<void> };
  }) => Promise<void>,
  firstOptions: Record<string, unknown> = {},
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-live-turns-'));
  const { createQuery, script, queries } = createScriptedQuery();
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  let providerSessionId: string | null = null;
  const context: ProviderRuntimeContext = {
    // Like the session row: the native id is known once the first turn has it.
    resolveProviderSessionId: () => providerSessionId,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
    createQuery,
  };

  const first = createWriter();
  const firstRun = queryClaudeSDK('start an agent', { sessionId, cwd, ...firstOptions }, first.writer, context);
  try {
    await settle();
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 60', subagent_type: 'general-purpose', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent'));
    script.emit(result());
    await waitFor(() => first.completes().length === 1);
    providerSessionId = NATIVE_ID;
    assert.equal(script.released(), false, 'the process is held for the agent');

    await runTest({
      script,
      queries,
      first,
      firstRun,
      send: (command, options = {}) => {
        const writer = createWriter();
        return { writer, run: queryClaudeSDK(command, { sessionId, cwd, ...firstOptions, ...options }, writer.writer, context) };
      },
    });
  } finally {
    script.end();
    await firstRun;
    await rm(cwd, { recursive: true, force: true });
  }
}

test('a turn sent while background work runs goes into the live process', async () => {
  await withHeldSession('app-live-deliver', async ({ script, queries, first, send }) => {
    // The client is told, on the turn's end and in the running list, that the next turn can go in.
    assert.deepEqual(first.completes()[0]?.liveTurn, {
      effort: null, bypassPermissions: false, planMode: false, allowedTools: [], disallowedTools: [],
    });
    assert.ok(listClaudeSDKBackgroundWork().find((entry) => entry.sessionId === 'app-live-deliver')?.liveTurn);
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-deliver', {}), true);

    const second = send('how is it going?');
    await waitFor(() => script.prompts.length === 2);
    assert.deepEqual(script.prompts, ['start an agent', 'how is it going?']);
    assert.equal(queries(), 1, 'no new process');
    assert.deepEqual(script.calls, [], 'nothing interrupted or stopped');
    assert.deepEqual(
      listClaudeSDKBackgroundWork().find((entry) => entry.sessionId === 'app-live-deliver')?.tasks.map((task) => task.taskId),
      ['a1'],
      'the agent is still tracked',
    );
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-deliver', {}), false, 'a turn is in flight now');

    // The answer streams to the new turn's writer and completes it.
    script.emit(text('Still sleeping.'));
    script.emit(result());
    await second.run;
    assert.ok(second.writer.sent.some((message) => message.kind === 'text' && message.content === 'Still sleeping.'));
    assert.equal(second.writer.completes().length, 1);
    assert.equal(first.completes().length, 1, 'the first turn is not completed again');
    assert.equal(script.released(), false, 'still held: the agent has not reported');

    // The agent's report reaches the stream, then its follow-up turn ends the hold.
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(text('The agent finished.'));
    script.emit(result());
    await waitFor(() => script.released());
    assert.ok(second.writer.sent.some((message) => message.kind === 'text' && message.content === 'The agent finished.'));
    assert.equal(second.writer.completes().length, 1);
  });
});

test('a model or permission mode change is applied to the live process', async () => {
  await withHeldSession('app-live-setters', async ({ script, queries, send }) => {
    const second = send('switch', { model: 'opus', permissionMode: 'acceptEdits' });
    await waitFor(() => script.prompts.length === 2);
    assert.equal(queries(), 1);
    assert.deepEqual(script.calls, ['setPermissionMode:acceptEdits', 'setModel:opus']);
    script.emit(result());
    await second.run;
  });
});

test('a turn may allow more tools than the launch, but not fewer, and keep the launch effort and modes', async () => {
  await withHeldSession('app-live-tools', async () => {
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-tools', { toolsSettings: { allowedTools: ['Read', 'Bash(git:*)'], disallowedTools: [] } }), true);
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-tools', { toolsSettings: { allowedTools: [], disallowedTools: [] } }), false);
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-tools', { toolsSettings: { allowedTools: ['Read'], disallowedTools: ['Write'] } }), false);
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-tools', { permissionMode: 'bypassPermissions', toolsSettings: { allowedTools: ['Read'] } }), false);
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-tools', { effort: 'high', toolsSettings: { allowedTools: ['Read'] } }), false);
  }, { toolsSettings: { allowedTools: ['Read'], disallowedTools: [] } });
});

test('an option only a launch can set starts a new process, as before', async () => {
  await withHeldSession('app-live-fallback', async ({ script, queries, send }) => {
    const second = send('think harder', { effort: 'high' });
    await waitFor(() => queries() === 2);
    // Its agent stopped, then the process interrupted and let go.
    assert.deepEqual(script.calls, ['stopTask:a1', 'interrupt'], 'the held process is stopped and replaced');
    assert.equal(script.released(), true);
    script.emit(result());
    // A fresh process stays up until its stream ends.
    script.end();
    await second.run;
  });
});

test('an edit resumes partway in a new process', async () => {
  await withHeldSession('app-live-edit', async ({ script, queries, send }) => {
    const second = send('edited', { resumeAnchorId: 'row-1' });
    await waitFor(() => queries() === 2);
    assert.equal(script.prompts.includes('edited'), true, 'the new process reads it, not the held one');
    assert.equal(script.released(), true);
    script.emit(result());
    script.end();
    await second.run;
  });
});

test('interrupting a delivered turn leaves the background work running', async () => {
  await withHeldSession('app-live-abort', async ({ script, send }) => {
    const second = send('long question');
    await waitFor(() => script.prompts.length === 2);

    assert.equal(await abortClaudeSDKSession('app-live-abort'), true);
    assert.deepEqual(script.calls, ['interrupt']);
    assert.equal(script.released(), false, 'the process stays for the agent');

    // The interrupted turn winds down with a result; the abort already completed it.
    script.emit(result());
    await second.run;
    assert.equal(second.writer.completes().length, 0, 'the chat handler sends the aborted complete, not the runtime');
    assert.equal(script.released(), false);
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-abort', {}), true, 'and it can take the next turn');

    const third = send('another');
    await waitFor(() => script.prompts.length === 3);
    script.emit(result());
    await third.run;
    assert.equal(third.writer.completes().length, 1);
  });
});

test('a delivered turn whose work has all reported lets the process go', async () => {
  await withHeldSession('app-live-release', async ({ script, send }) => {
    const second = send('anything new?');
    await waitFor(() => script.prompts.length === 2);
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(text('Yes, it finished.'));
    script.emit(result());
    await second.run;
    await waitFor(() => script.released());
    assert.equal(second.writer.completes()[0]?.liveTurn, undefined, 'nothing left to deliver into');
  });
});
