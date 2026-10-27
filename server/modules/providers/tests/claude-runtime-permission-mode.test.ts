import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK, setClaudeSDKPermissionMode } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A mode the user picks mid-turn has to reach both the CLI process and the
 * run's own approval callback: canUseTool decides from the run's options, so
 * switching only the process would leave a "bypass" turn still prompting.
 */

const SESSION_ID = 'app-mode-session';

type Scripted = {
  end: () => void;
  modes: string[];
  options: () => AnyRecord;
  started: () => boolean;
};

/** A stand-in for the SDK query that stays open until ended and records mode switches. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  let finish: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  const modes: string[] = [];
  let capturedOptions: AnyRecord | null = null;

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ options }) => {
    capturedOptions = options;
    const iterator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'native-mode-session' };
      await ended;
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      setPermissionMode: async (mode: string) => { modes.push(mode); },
    });
  };

  return {
    createQuery,
    script: { end: () => finish?.(), modes, options: () => capturedOptions ?? {}, started: () => capturedOptions !== null },
  };
}

async function withRun(
  runOptions: AnyRecord,
  runTest: (script: Scripted) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-mode-'));
  const { createQuery, script } = createScriptedQuery();
  const writer = { send: () => {}, userId: null };
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
    // The run sets up asynchronously before it registers the session; a fixed
    // delay is too short on a loaded machine.
    for (let attempt = 0; attempt < 400 && !script.started(); attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    assert.ok(script.started(), 'the run never created its query');
    await runTest(script);
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const askTool = (options: AnyRecord, toolName: string) =>
  options.canUseTool(toolName, {}, { signal: AbortSignal.timeout(50) }) as Promise<{ behavior: string }>;

test('switching a running turn to bypass reaches the process and stops the prompts', async () => {
  await withRun({ permissionMode: 'default' }, async (script) => {
    assert.equal(await setClaudeSDKPermissionMode(SESSION_ID, 'bypassPermissions'), true);

    assert.deepEqual(script.modes, ['bypassPermissions']);
    assert.equal((await askTool(script.options(), 'Write')).behavior, 'allow');
  });
});

test('skip-permissions in the tool settings still wins over a picked mode', async () => {
  await withRun({ permissionMode: 'default', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true } }, async (script) => {
    await setClaudeSDKPermissionMode(SESSION_ID, 'acceptEdits');
    assert.deepEqual(script.modes, ['bypassPermissions']);
  });
});

test('leaving plan mode takes back only the tools plan mode added', async () => {
  const toolsSettings = { allowedTools: ['WebSearch'], disallowedTools: [], skipPermissions: false };
  await withRun({ permissionMode: 'plan', toolsSettings }, async (script) => {
    assert.ok(script.options().allowedTools.includes('WebFetch'));

    await setClaudeSDKPermissionMode(SESSION_ID, 'default');

    assert.deepEqual(script.options().allowedTools, ['WebSearch'], 'the user\'s own entry stays');
  });
});

test('an unknown mode or a session with no live process is refused', async () => {
  assert.equal(await setClaudeSDKPermissionMode('no-such-session', 'auto'), false);
  await withRun({}, async (script) => {
    assert.equal(await setClaudeSDKPermissionMode(SESSION_ID, 'yolo'), false);
    assert.deepEqual(script.modes, []);
  });
});
