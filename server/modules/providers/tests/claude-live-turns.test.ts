import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  acceptsClaudeSDKLiveTurn,
  closeAllClaudeSDKProcesses,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  releaseClaudeSDKIdleProcess,
  interruptClaudeSDKTurnForSteer,
  steerClaudeSDKTurn,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';
import { waitFor } from '@/shared/tests/wait-for.js';

/**
 * A session's CLI process stays up between turns, whether or not background
 * work is outstanding, and every later turn goes into it as streaming input,
 * the way the CLI takes a new prompt: no interrupt, no new process, MCP
 * servers stay connected and any work keeps running and reporting. Options
 * only a launch can set still start a new process, and closing the chat lets
 * the process go. Driven with a scripted SDK stream through
 * `context.createQuery`, which also records what reaches the CLI's stdin.
 */

const NATIVE_ID = 'native-live-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  /** Prompt texts the CLI has read from stdin, in order. */
  prompts: string[];
  /** The stdin messages behind `prompts`. */
  stdin: Array<Record<string, unknown>>;
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
  const stdin: Array<Record<string, unknown>> = [];
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
    stdin,
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
        stdin.push(message as Record<string, unknown>);
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
      close: () => { calls.push('close'); },
    });
  };

  return { createQuery, script, queries: () => queries };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

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
// The CLI's receipt for a stdin message it took (--replay-user-messages).
const replayOf = (stdinMessage: Record<string, unknown> | undefined) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null, isReplay: true,
  uuid: stdinMessage?.uuid, message: stdinMessage?.message,
});
const STEER_ID = '0b5e6a58-6f0a-4c86-9a43-3f4a1b2c9d10';
const userTexts = (writer: Writer) => writer.sent.filter((message) => message.kind === 'text' && message.role === 'user');

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
 * Starts a session whose first turn ends, by default with a background agent
 * still running. Hands the test the pieces to send the next turn with, and
 * winds everything down afterwards.
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
  { withBackgroundAgent = true }: { withBackgroundAgent?: boolean } = {},
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
    if (withBackgroundAgent) {
      script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 60', subagent_type: 'general-purpose', run_in_background: true }));
      script.emit(taskStarted('a1', 'toolu_agent'));
    } else {
      script.emit(text('Hello.'));
    }
    script.emit(result());
    await waitFor(() => first.completes().length === 1);
    providerSessionId = NATIVE_ID;
    assert.equal(script.released(), false, 'the process stays up after the turn');

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

    // The agent's report reaches the stream; the process stays up after it.
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(text('The agent finished.'));
    script.emit(result());
    await waitFor(() => second.writer.sent.some((message) => message.kind === 'text' && message.content === 'The agent finished.'));
    await waitFor(() => second.writer.completes().length > 0, 'the turn has completed');
    assert.equal(second.writer.completes().length, 1);
    assert.equal(script.released(), false);
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-deliver', {}), true);
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

test('an interrupted delivered turn settles on its own result, and work that survives keeps the process', async () => {
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

test('an interrupt that stops the background work leaves the process up for the next turn', async () => {
  // What the real CLI does: its interrupt stops the running tasks too, then
  // ends the turn with an `error_during_execution` result.
  await withHeldSession('app-live-abort-stops', async ({ script, send }) => {
    const second = send('long question');
    await waitFor(() => script.prompts.length === 2);

    assert.equal(await abortClaudeSDKSession('app-live-abort-stops'), true);
    script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    assert.equal(script.released(), false, 'not while the interrupted turn is still winding down');
    script.emit({ ...result(), subtype: 'error_during_execution' });
    await second.run;
    assert.equal(script.released(), false);
    assert.deepEqual(listClaudeSDKBackgroundWork().filter((entry) => entry.sessionId === 'app-live-abort-stops'), []);
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-abort-stops', {}), true);
  });
});

test('a delivered turn whose work has all reported leaves the process up', async () => {
  await withHeldSession('app-live-release', async ({ script, send }) => {
    const second = send('anything new?');
    await waitFor(() => script.prompts.length === 2);
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(text('Yes, it finished.'));
    script.emit(result());
    await second.run;
    await settle();
    assert.equal(script.released(), false);
    assert.ok(second.writer.completes()[0]?.liveTurn, 'the next turn can still go in');
  });
});

test('a turn with no background work leaves the process up, and the next turn goes into it', async () => {
  await withHeldSession('app-live-idle', async ({ script, queries, first, send }) => {
    assert.ok(first.completes()[0]?.liveTurn);
    assert.deepEqual(listClaudeSDKBackgroundWork().filter((entry) => entry.sessionId === 'app-live-idle'), [], 'idle, not busy');

    const second = send('and now?');
    await waitFor(() => script.prompts.length === 2);
    script.emit(text('Now this.'));
    script.emit(result());
    await second.run;
    assert.equal(queries(), 1, 'one process for both turns');
    assert.deepEqual(script.calls, []);
    assert.equal(script.released(), false);
  }, {}, { withBackgroundAgent: false });
});

test('closing the chat lets the idle process go', async () => {
  await withHeldSession('app-live-close', async ({ script, firstRun }) => {
    assert.equal(releaseClaudeSDKIdleProcess('app-live-close'), true);
    await waitFor(() => script.released());
    script.end();
    await firstRun;
    assert.equal(releaseClaudeSDKIdleProcess('app-live-close'), false, 'nothing left to close');
    assert.equal(acceptsClaudeSDKLiveTurn('app-live-close', {}), false);
  }, {}, { withBackgroundAgent: false });
});

test('closing the chat stops its background work before letting the process go', async () => {
  await withHeldSession('app-live-close-work', async ({ script }) => {
    assert.equal(releaseClaudeSDKIdleProcess('app-live-close-work'), true);
    assert.deepEqual(script.calls, ['stopTask:a1']);
    await waitFor(() => script.released());
  });
});

test('closing the chat leaves a turn in flight alone', async () => {
  await withHeldSession('app-live-close-busy', async ({ script, send }) => {
    const second = send('busy');
    await waitFor(() => script.prompts.length === 2);
    assert.equal(releaseClaudeSDKIdleProcess('app-live-close-busy'), false);
    assert.equal(script.released(), false);
    script.emit(result());
    await second.run;
  }, {}, { withBackgroundAgent: false });
});

test('server shutdown closes every session process', async () => {
  await withHeldSession('app-live-shutdown', async ({ script }) => {
    closeAllClaudeSDKProcesses();
    assert.deepEqual(script.calls, ['close']);
    await waitFor(() => script.released());
  }, {}, { withBackgroundAgent: false });
});

test('a message steered into the turn in flight reaches the CLI and the turn completes once', async () => {
  await withHeldSession('app-steer-inline', async ({ script, first, send }) => {
    // The CLI's receipt for the first prompt is not shown a second time.
    script.emit(replayOf(script.stdin[0]));

    const second = send('run the tests');
    await waitFor(() => script.prompts.length === 2);
    assert.equal(await steerClaudeSDKTurn('app-steer-inline', 'only the unit tests', { steerId: STEER_ID }), true);
    await waitFor(() => script.prompts.length === 3);
    assert.match(script.prompts[2] ?? '', /^only the unit tests\n\n<cloudcli_appended>\n.*text reply/s, 'with the ask to answer visibly');
    assert.equal(script.stdin[2]?.priority, 'next', 'taken the way the CLI takes a message typed mid-turn');
    assert.equal(script.stdin[2]?.uuid, STEER_ID, 'the CLI echoes it back under the client\'s id');
    const pending = second.writer.sent.filter((message) => message.kind === 'steer_pending');
    assert.deepEqual(pending.map((message) => [message.steerId, message.content]), [[STEER_ID, 'only the unit tests']]);

    // Taken at the next tool boundary, inside the same turn.
    script.emit(replayOf(script.stdin[1]));
    script.emit(toolUse('toolu_bash', 'Bash', { command: 'npm test' }));
    script.emit(replayOf(script.stdin[2]));
    script.emit(text('Unit tests pass.'));
    script.emit(result());
    await second.run;
    assert.equal(second.writer.completes().length, 1);
    assert.deepEqual(userTexts(first), []);
    // Only the steered message is shown, where the model read it: after the
    // tool call and before the answer it led to.
    const rows = second.writer.sent.filter((message) => message.kind === 'text' || message.kind === 'tool_use');
    assert.deepEqual(rows.map((message) => [message.kind, message.role ?? null, message.content ?? null]), [
      ['tool_use', null, null],
      ['text', 'user', 'only the unit tests'],
      ['text', 'assistant', 'Unit tests pass.'],
    ]);
    assert.equal(userTexts(second.writer)[0]?.steerId, STEER_ID);
    assert.ok(userTexts(second.writer)[0]?.id.startsWith('local_'), 'retired for the transcript row once that loads');
    assert.equal(acceptsClaudeSDKLiveTurn('app-steer-inline', {}), true);
  }, {}, { withBackgroundAgent: false });
});

test('a steered message the turn ended before taking keeps the turn open until it has run', async () => {
  await withHeldSession('app-steer-after', async ({ script, send }) => {
    const second = send('summarise');
    await waitFor(() => script.prompts.length === 2);
    assert.equal(await steerClaudeSDKTurn('app-steer-after', 'in Dutch', { steerId: STEER_ID }), true);
    await waitFor(() => script.prompts.length === 3);

    script.emit(text('Summary.'));
    script.emit(result());
    await settle();
    assert.equal(second.writer.completes().length, 0, 'the CLI runs the steered message next');
    assert.equal(acceptsClaudeSDKLiveTurn('app-steer-after', {}), false);

    script.emit(replayOf(script.stdin[2]));
    script.emit(text('Samenvatting.'));
    script.emit(result());
    await second.run;
    assert.equal(second.writer.completes().length, 1);
    assert.ok(second.writer.sent.some((message) => message.kind === 'text' && message.content === 'Samenvatting.'));
  }, {}, { withBackgroundAgent: false });
});

test('a turn whose steered message the CLI never starts completes after a short wait', async () => {
  await withHeldSession('app-steer-dropped', async ({ script, send }) => {
    const second = send('summarise');
    await waitFor(() => script.prompts.length === 2);
    assert.equal(await steerClaudeSDKTurn('app-steer-dropped', 'in Dutch', { steerId: STEER_ID }), true);
    script.emit(result());
    await settle();
    assert.equal(second.writer.completes().length, 0);
    // The runtime's wait does not keep the process alive; this one does.
    let keepAlive: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([second.run, new Promise((resolve) => { keepAlive = setTimeout(resolve, 10_000); })]);
    clearTimeout(keepAlive);
    assert.equal(second.writer.completes().length, 1);
    assert.equal(acceptsClaudeSDKLiveTurn('app-steer-dropped', {}), true);
  }, {}, { withBackgroundAgent: false });
});

test('nothing is steered into a session with no turn in flight', async () => {
  await withHeldSession('app-steer-idle', async ({ script }) => {
    assert.equal(await steerClaudeSDKTurn('app-steer-idle', 'hello?', { steerId: STEER_ID }), false);
    assert.equal(await steerClaudeSDKTurn('app-steer-unknown', 'hello?', { steerId: STEER_ID }), false);
    await settle();
    assert.equal(script.prompts.length, 1);
  }, {}, { withBackgroundAgent: false });
});

test('sending a pending message now interrupts the step, and the turn runs on with the message', async () => {
  await withHeldSession('app-steer-now', async ({ script, send }) => {
    const second = send('run the slow tests');
    await waitFor(() => script.prompts.length === 2);
    assert.equal(await steerClaudeSDKTurn('app-steer-now', 'stop, run only one', { steerId: STEER_ID }), true);
    await waitFor(() => script.prompts.length === 3);
    assert.equal(await interruptClaudeSDKTurnForSteer('app-steer-now', crypto.randomUUID()), false, 'only for a message that waits');

    assert.equal(await interruptClaudeSDKTurnForSteer('app-steer-now', STEER_ID), true);
    assert.deepEqual(script.calls, ['interrupt']);

    // The interrupted step ends; the CLI then runs the message it kept.
    script.emit({ ...result(), subtype: 'error_during_execution' });
    await settle();
    assert.equal(second.writer.completes().length, 0, 'the turn goes on with the message');
    script.emit(replayOf(script.stdin[2]));
    script.emit(text('Running one.'));
    script.emit(result());
    await second.run;
    assert.equal(second.writer.completes().length, 1);
    assert.deepEqual(userTexts(second.writer).map((message) => message.content), ['stop, run only one']);
    assert.equal(await interruptClaudeSDKTurnForSteer('app-steer-now', STEER_ID), false, 'taken already');
  }, {}, { withBackgroundAgent: false });
});
