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
 * Auto mode decides with a model classifier, so the user's own lists and the
 * permission dialog both have to reach the call from a hook: PreToolUse applies
 * the lists ahead of the classifier, and PermissionRequest puts the decision
 * back in the user's hands with an answer that is authoritative — an `allow`
 * there runs the call.
 *
 * PermissionDenied is only the fallback for a denial that never reached
 * PermissionRequest. Its `retry` tells the model it MAY try again and executes
 * nothing itself, so these tests pin that difference rather than treating the
 * two as equivalent.
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

async function withRun(runOptions: AnyRecord, runTest: (script: Scripted) => Promise<void>): Promise<void> {
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

const runHook = (options: AnyRecord, event: 'PreToolUse' | 'PermissionRequest' | 'PermissionDenied', input: AnyRecord) =>
  options.hooks[event][0].hooks[0](input, undefined, { signal: new AbortController().signal }) as Promise<AnyRecord>;

const verdict = (output: AnyRecord) => output?.hookSpecificOutput?.permissionDecision;

/** Answers the dialog the hook under test is waiting on. */
async function answerPrompt(script: Scripted, decision: AnyRecord) {
  await waitFor(() => script.sent.some((message) => message.kind === 'permission_request'), 'the prompt reached the client');
  const request = script.sent.find((message) => message.kind === 'permission_request');
  resolveToolApproval(request!.requestId!, decision as never);
}

const denied = (toolName: string, toolInput: AnyRecord, toolUseId = 'tool-1') => ({
  hook_event_name: 'PermissionDenied',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: toolUseId,
  reason: 'Blocked by classifier',
});

const needsDecision = (toolName: string, toolInput: AnyRecord) => ({
  hook_event_name: 'PermissionRequest',
  tool_name: toolName,
  tool_input: toolInput,
});

const preToolUse = (toolName: string, toolInput: AnyRecord, toolUseId = 'tool-1') => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: toolUseId,
});

test('the allow list decides before the classifier does', async () => {
  const toolsSettings = { allowedTools: ['mcp__unity-vov__gameobject-find'], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const output = await runHook(script.options(), 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__unity-vov__gameobject-find',
      tool_input: {},
      tool_use_id: 'tool-1',
    });

    assert.equal(verdict(output), 'allow');
  });
});

test('an entry added mid-run counts against the process already up', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const call = { hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: {}, tool_use_id: 'tool-1' };
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', call)), undefined, 'unlisted, so the classifier decides');

    script.options().allowedTools.push('WebSearch');

    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', call)), 'allow');
  });
});

test('the deny list still refuses, and its refusal is not re-prompted', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: ['Write'], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const output = await runHook(script.options(), 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {},
      tool_use_id: 'tool-1',
    });
    assert.equal(verdict(output), 'deny');

    // The same call reaching PermissionDenied is this run's own verdict, so it stands.
    assert.deepEqual(await runHook(script.options(), 'PermissionDenied', denied('Write', {})), {});
    assert.equal(script.sent.some((message) => message.kind === 'permission_request'), false);
  });
});

test('a call needing a decision is put to the user, and their allow runs it', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const input = { csharpCode: 'Undo.DestroyObjectImmediate(target);' };
    const hookDone = runHook(script.options(), 'PermissionRequest', needsDecision('mcp__unity-vov__script-execute', input));
    await answerPrompt(script, { allow: true });

    // Authoritative: the call runs, rather than the model being invited to try.
    assert.deepEqual((await hookDone).hookSpecificOutput, {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    });
    assert.deepEqual(script.options().allowedTools, [], 'allow-once leaves the list alone');
  });
});

test('a refusal the user gives is passed back as the decision', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const hookDone = runHook(script.options(), 'PermissionRequest', needsDecision('Write', { file_path: 'a.txt' }));
    await answerPrompt(script, { allow: false, message: 'not that file' });

    assert.deepEqual((await hookDone).hookSpecificOutput, {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'not that file' },
    });
  });
});

test('one call never produces two dialogs', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const input = { command: 'git push' };
    const asked = runHook(script.options(), 'PermissionRequest', needsDecision('Bash', input));
    await answerPrompt(script, { allow: false });
    await asked;

    // The same call reaching the fallback afterwards must not ask again.
    assert.deepEqual(await runHook(script.options(), 'PermissionDenied', denied('Bash', input)), {});
    assert.equal(script.sent.filter((message) => message.kind === 'permission_request').length, 1);
  });
});

test('the same call later in the run is asked about again', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const input = { command: 'git push' };
    const first = runHook(script.options(), 'PermissionRequest', needsDecision('Bash', input));
    await answerPrompt(script, { allow: false });
    await first;

    // A fresh occurrence starts at PreToolUse, which clears the earlier answer.
    await runHook(script.options(), 'PreToolUse', preToolUse('Bash', input, 'tool-2'));
    const second = runHook(script.options(), 'PermissionDenied', denied('Bash', input, 'tool-2'));
    await waitFor(
      () => script.sent.filter((message) => message.kind === 'permission_request').length === 2,
      'the repeated call is asked about again',
    );
    const request = script.sent.filter((message) => message.kind === 'permission_request')[1];
    resolveToolApproval(request.requestId!, { allow: false } as never);
    await second;
  });
});

test('"always allow" writes the rule instead of a one-shot grant', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const call = { command: 'git status' };
    const hookDone = runHook(script.options(), 'PermissionDenied', denied('Bash', call));
    await answerPrompt(script, { allow: true, rememberEntry: 'Bash(git status:*)' });

    assert.equal((await hookDone).hookSpecificOutput?.retry, true);
    assert.deepEqual(script.options().allowedTools, ['Bash(git status:*)']);

    // The rule, not a one-shot grant, is what the retry matches on.
    const retry = await runHook(script.options(), 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: call,
      tool_use_id: 'tool-2',
    });
    assert.equal(verdict(retry), 'allow');
  });
});

test('the fallback can only invite a retry, and an allow-once backs it with a grant', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const input = { csharpCode: 'SaveScene();' };
    const hookDone = runHook(script.options(), 'PermissionDenied', denied('mcp__unity-vov__script-execute', input));
    await answerPrompt(script, { allow: true });

    // `retry` runs nothing — it tells the model it may try the call again.
    assert.equal((await hookDone).hookSpecificOutput?.retry, true);

    // Should it try, the grant is what lets the call past PreToolUse.
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('mcp__unity-vov__script-execute', input, 'tool-2'))), 'allow');
    // The grant is spent, so a third occurrence is not waved through.
    assert.equal(verdict(await runHook(script.options(), 'PreToolUse', preToolUse('mcp__unity-vov__script-execute', input, 'tool-3'))), undefined);
  });
});

test('outside auto mode canUseTool is the dialog, so neither hook asks', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'default', toolsSettings }, async (script) => {
    assert.deepEqual(await runHook(script.options(), 'PermissionRequest', needsDecision('Write', {})), {});
    assert.deepEqual(await runHook(script.options(), 'PermissionDenied', denied('Write', {})), {});
    assert.equal(script.sent.some((message) => message.kind === 'permission_request'), false);
  });
});

test('interactive tools are asked for in the mode that skips canUseTool', async () => {
  const toolsSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'bypassPermissions', toolsSettings }, async (script) => {
    const output = await runHook(script.options(), 'PreToolUse', preToolUse('AskUserQuestion', {}));
    assert.equal(verdict(output), 'ask');
  });

  await withRun({ permissionMode: 'auto', toolsSettings }, async (script) => {
    const output = await runHook(script.options(), 'PreToolUse', preToolUse('AskUserQuestion', {}));
    assert.equal(verdict(output), undefined, 'auto routes interactive tools to canUseTool itself');
  });
});
