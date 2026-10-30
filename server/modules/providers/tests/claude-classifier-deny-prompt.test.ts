import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK, resolveToolApproval } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';
import { waitFor } from '@/shared/tests/wait-for.js';

/**
 * Auto mode decides with a model classifier, which used to refuse a call with
 * no way for the user to overrule it. Measured against CLI 2.1.314, a refusal
 * fires only the PermissionDenied hook — neither PermissionRequest nor
 * `canUseTool` sees it — so that is where the call is put back to the user.
 *
 * `retry` cannot run the call; it tells the model it may try again. What makes
 * the attempt succeed is a one-shot grant that PreToolUse honours, since an
 * `allow` there outranks the classifier. Both halves were observed end to end
 * on the real CLI; these tests pin the server's side of them.
 */

const SESSION_ID = 'app-classifier-session';

type Sent = { kind?: string; requestId?: string; toolName?: string };

type Scripted = {
  end: () => void;
  options: () => AnyRecord;
  started: () => boolean;
  sent: Sent[];
};

function createScriptedQuery(sent: Sent[]) {
  let finish: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  let capturedOptions: AnyRecord | null = null;

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ options }) => {
    capturedOptions = options;
    const iterator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'native-classifier-session' };
      await ended;
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      setPermissionMode: async () => {},
    });
  };

  return {
    createQuery,
    script: {
      end: () => finish?.(),
      options: () => capturedOptions ?? {},
      started: () => capturedOptions !== null,
      sent,
    } satisfies Scripted,
  };
}

let explained: string[] = [];

async function withRun(runOptions: AnyRecord, runTest: (script: Scripted) => Promise<void>): Promise<void> {
  explained = [];
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-classifier-'));
  const sent: Sent[] = [];
  const { createQuery, script } = createScriptedQuery(sent);
  const writer = { send: (message: Sent) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    // A raised prompt must never start a real, billed explainer run.
    explainToolCall: async ({ toolName }) => {
      explained.push(toolName);
      return null;
    },
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, ...runOptions }, writer as never, context);
    await waitFor(() => script.started(), 'the run has created its query');
    await runTest(script);
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const noRules = { allowedTools: [], disallowedTools: [], skipPermissions: false };

const runHook = (options: AnyRecord, event: 'PreToolUse' | 'PermissionDenied', input: AnyRecord, signal?: AbortSignal) =>
  options.hooks[event][0].hooks[0](input, undefined, { signal: signal ?? new AbortController().signal }) as Promise<AnyRecord>;

const askCallback = (options: AnyRecord, toolName: string, input: AnyRecord, toolUseID = 'tool-1', signal?: AbortSignal) =>
  options.canUseTool(toolName, input, { signal: signal ?? new AbortController().signal, toolUseID }) as Promise<AnyRecord>;

const verdict = (output: AnyRecord) => output?.hookSpecificOutput?.permissionDecision;

const prompts = (script: Scripted) => script.sent.filter((message) => message.kind === 'permission_request');

/** Answers the newest dialog once it has reached the client. */
async function answerPrompt(script: Scripted, decision: AnyRecord, expectedCount = 1) {
  await waitFor(() => prompts(script).length >= expectedCount, 'the prompt reached the client');
  resolveToolApproval(prompts(script)[expectedCount - 1].requestId!, decision as never);
}

const denied = (toolName: string, toolInput: AnyRecord, toolUseId = 'tool-1') => ({
  hook_event_name: 'PermissionDenied',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: toolUseId,
  reason: '[Git Destructive]',
});

const preToolUse = (toolName: string, toolInput: AnyRecord, toolUseId = 'tool-1') => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: toolUseId,
});

test('an allow rule is left to the CLI, never answered here', async () => {
  // The CLI holds the same rules, judges them with a stricter matcher, and in
  // auto mode drops the ones that would bypass the classifier. An `allow` from
  // this hook would outrank all of that.
  const toolsSettings = { ...noRules, allowedTools: ['Bash', 'Bash(echo:*)', 'mcp__unity-vov__gameobject-find'] };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    for (const [toolName, input] of [
      ['mcp__unity-vov__gameobject-find', {}],
      ['Bash', { command: 'echo pwned >> ~/.bashrc' }],
      ['Bash', { command: 'rm -rf build' }],
    ] as const) {
      assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse(toolName, input))), undefined, toolName);
    }
  });
});

test('the deny list still refuses, and its refusal is not re-prompted', async () => {
  const toolsSettings = { ...noRules, disallowedTools: ['Write'] };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('Write', {}))), 'deny');

    // The same call reaching PermissionDenied is this run's own verdict, so it stands.
    assert.deepEqual(await runHook(script.options(), 'PermissionDenied', denied('Write', {})), {});
    assert.equal(prompts(script).length, 0);
  });
});

test('a classifier refusal is put to the user, and their allow-once lets the retry through', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const input = { csharpCode: 'Undo.DestroyObjectImmediate(target); SaveScene();' };
    const hookDone = runHook(script.options(), 'PermissionDenied', denied('mcp__unity-vov__script-execute', input));
    await answerPrompt(script, { allow: true });

    // `retry` runs nothing — it tells the model it may try the call again.
    assert.deepEqual(await hookDone, { hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } });

    // When it does, the grant gets the call past PreToolUse, ahead of the classifier.
    const retried = preToolUse('mcp__unity-vov__script-execute', input, 'tool-2');
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', retried)), 'allow');
    // The grant is spent, so a third occurrence is judged afresh.
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('mcp__unity-vov__script-execute', input, 'tool-3'))), undefined);
    assert.deepEqual(script.options().allowedTools, [], 'allow-once leaves the list alone');
  });
});

test('"always allow" also grants the retry, since the rule reaches the CLI only later', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const input = { command: 'cd repo && git push' };
    const hookDone = runHook(script.options(), 'PermissionDenied', denied('Bash', input));
    // The remembered rule covers only the first part of the command.
    await answerPrompt(script, { allow: true, rememberEntry: 'Bash(cd:*)' });

    assert.equal((await hookDone).hookSpecificOutput?.retry, true);
    assert.deepEqual(script.options().allowedTools, ['Bash(cd:*)']);
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('Bash', input, 'tool-2'))), 'allow');
  });
});

test('the grant survives the model rewording its description of the retry', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const first = { command: 'git push --dry-run origin main', description: 'Push the branch' };
    const hookDone = runHook(script.options(), 'PermissionDenied', denied('Bash', first));
    await answerPrompt(script, { allow: true });
    await hookDone;

    const reworded = { command: 'git push --dry-run origin main', description: 'Retry the dry-run push' };
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('Bash', reworded, 'tool-2'))), 'allow');
  });
});

test('a grant covers only the command the user saw', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const hookDone = runHook(script.options(), 'PermissionDenied', denied('Bash', { command: 'git push --dry-run origin main' }));
    await answerPrompt(script, { allow: true });
    await hookDone;

    const different = { command: 'git push --force origin main' };
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('Bash', different, 'tool-2'))), undefined);
  });
});

test('when the user refuses too, the classifier refusal stands', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const input = { command: 'git push --force origin main' };
    const hookDone = runHook(script.options(), 'PermissionDenied', denied('Bash', input));
    await answerPrompt(script, { allow: false });

    assert.deepEqual(await hookDone, {});
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('Bash', input, 'tool-2'))), undefined, 'no grant');
  });
});

test('a call that already had a dialog is not asked about a second time', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const input = { command: 'git push' };
    const asked = askCallback(script.options(), 'Bash', input, 'tool-1');
    await answerPrompt(script, { allow: false });
    await asked;

    assert.deepEqual(await runHook(script.options(), 'PermissionDenied', denied('Bash', input, 'tool-1')), {});
    assert.equal(prompts(script).length, 1);
  });
});

test('a dialog that timed out or was cancelled also counts as asked', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const input = { command: 'git push' };
    const controller = new AbortController();
    const asked = askCallback(script.options(), 'Bash', input, 'tool-1', controller.signal);
    await waitFor(() => prompts(script).length === 1, 'the prompt was raised');
    controller.abort();
    await asked;

    // Otherwise the user would sit through a second full-length dialog.
    assert.deepEqual(await runHook(script.options(), 'PermissionDenied', denied('Bash', input, 'tool-1')), {});
    assert.equal(prompts(script).length, 1);
  });
});

test('the same command issued again later is asked about again', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const input = { command: 'git push' };
    const first = askCallback(script.options(), 'Bash', input, 'tool-1');
    await answerPrompt(script, { allow: false });
    await first;

    // A new call has a new tool-use id, so the earlier answer does not silence it.
    const second = runHook(script.options(), 'PermissionDenied', denied('Bash', input, 'tool-2'));
    await answerPrompt(script, { allow: false }, 2);
    await second;
    assert.equal(prompts(script).length, 2);
  });
});

test('two identical calls issued in parallel each get a dialog of their own', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    // One "allow once" must never approve two executions the user saw once.
    const input = { command: 'npm test' };
    const first = askCallback(script.options(), 'Bash', input, 'tool-1');
    const second = askCallback(script.options(), 'Bash', input, 'tool-2');

    await waitFor(() => prompts(script).length === 2, 'each call raised its own dialog');
    const [requestA, requestB] = prompts(script);
    resolveToolApproval(requestA.requestId!, { allow: true } as never);
    resolveToolApproval(requestB.requestId!, { allow: false } as never);

    assert.equal((await first).behavior, 'allow');
    assert.equal((await second).behavior, 'deny');
  });
});

test('outside auto mode no classifier refused anything, so the hook does not ask', async () => {
  await withRun({ permissionMode: 'default', toolsSettings: { ...noRules } }, async (script) => {
    assert.deepEqual(await runHook(script.options(), 'PermissionDenied', denied('Write', {})), {});
    assert.equal(prompts(script).length, 0);
  });
});

test('interactive tools are asked for in the mode that skips canUseTool', async () => {
  await withRun({ permissionMode: 'bypassPermissions', toolsSettings: { ...noRules } }, async (script) => {
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('AskUserQuestion', {}))), 'ask');
  });

  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    assert.equal(
      verdict(await runHook(script.options(), 'PreToolUse', preToolUse('AskUserQuestion', {}))),
      undefined,
      'auto routes interactive tools to canUseTool itself',
    );
  });
});

test('a question waits for as long as the user takes', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    // An interactive tool's dialog has no time limit, whoever raises it.
    const asked = askCallback(script.options(), 'AskUserQuestion', { questions: [] });
    await waitFor(() => prompts(script).length === 1, 'the question reached the client');
    await answerPrompt(script, { allow: true });
    assert.equal((await asked).behavior, 'allow');
  });
});

test('a pending call is described, but a question or plan approval is not', async () => {
  await withRun({ permissionMode: 'auto', toolsSettings: { ...noRules } }, async (script) => {
    const call = askCallback(script.options(), 'Bash', { command: 'git push' }, 'tool-1');
    const question = askCallback(script.options(), 'AskUserQuestion', { questions: [] }, 'tool-2');
    await waitFor(() => prompts(script).length === 2, 'both dialogs were raised');
    for (const request of prompts(script)) {
      resolveToolApproval(request.requestId!, { allow: false } as never);
    }
    await Promise.all([call, question]);

    assert.deepEqual(explained, ['Bash']);
  });
});
