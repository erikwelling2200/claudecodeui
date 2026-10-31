/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { isToolCallAllowed, isToolCallDenied } from '@/modules/providers/list/claude/claude-tool-permissions.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import { applyClaudeBillingEnv, claudeBilling } from '@/modules/usage/index.js';
import type { ClaudeBilling } from '@/modules/usage/index.js';
import {
  getReportedClaudeContextWindow,
  getReportedClaudeModelContextWindow,
  rememberClaudeContextWindow
} from '@/modules/providers/services/provider-token-usage.service.js';
import { appendPromptText, buildAgentSessionEnv, createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';
import type {
  AnyRecord,
  BackgroundTaskSummary,
  LiveTurnTerms,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

// The notifications module is still JavaScript, and its defaults (`dedupeKey = null`)
// infer as the only accepted types; this states the shape callers really pass.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;

type ClaudeQuery = ReturnType<NonNullable<ProviderRuntimeContext['createQuery']>>;

/** The run's writer: the WebSocket writer adds a socket swap for reconnects. */
type ClaudeRuntimeWriter = ProviderRuntimeWriter & { updateWebSocket?(rawWs: unknown): void };

type ActiveSession = {
  instance: ClaudeQuery;
  startTime: number;
  status: 'active' | 'aborted';
  writer: ClaudeRuntimeWriter | null;
  releaseInput: (() => void) | null;
  // The run loop's handle for taking further turns into this process; set once
  // the query exists, carried across the mid-run re-registration.
  liveProcess: LiveProcess | null;
  /** Switches the live process and the run's own approval rules to another permission mode. */
  applyPermissionMode: ((permissionMode: string) => Promise<void>) | null;
};

/** A later turn as `queryClaudeSDK` prepared it, handed to the live process instead of a new query. */
type LiveTurnDelivery = {
  messages: unknown[];
  writer: ClaudeRuntimeWriter;
  sessionSummary: AnyRecord[string];
  /** The turn's own options, read only for the client-facing terms. */
  options: AnyRecord;
  /** The SDK options a new process would have been started with for this turn. */
  sdkOptions: AnyRecord;
  mcpServers: AnyRecord | null;
  providerSessionId: string | null;
};

/**
 * What a run loop exposes about its process once the query is up, so a later
 * turn on the same session can be pushed into it as streaming input rather
 * than replacing it — the way the CLI takes a new prompt while background
 * agents keep running.
 */
type LiveProcess = {
  /** The launch options the SDK cannot change on a running query. */
  terms: LiveTurnTerms;
  /** True while the process sits between turns with nothing in flight. */
  canTakeTurn(): boolean;
  /**
   * Pushes the turn into the process. Resolves null without touching the
   * process when it cannot take this turn (it moved on, or an option differs
   * in a way the SDK cannot apply live); the caller then starts a new one.
   * Otherwise resolves with a promise that settles when the turn ends.
   */
  deliverTurn(turn: LiveTurnDelivery): Promise<{ settled: Promise<void> } | null>;
  /**
   * Interrupts a turn that was delivered into the process without tearing
   * the process down: the turn settles on the `result` the interrupt ends it
   * with, and the process then waits for the next turn. The CLI's interrupt
   * stops the background tasks it has running (seen through SDK 0.3.165
   * against a real CLI); anything that survives keeps reporting. False when
   * the turn in flight is the one the process was started for, which an abort
   * stops as it always has.
   */
  interruptTurn(): Promise<boolean>;
  /**
   * Adds a user message to the turn in flight, the way the CLI takes a message
   * typed while it works: it reaches the model at the next tool boundary, or,
   * should the turn end first, runs as a turn of its own that the client sees
   * as part of this one. False when no turn is in flight.
   *
   * The client is told with `steer_pending` until the CLI takes it, and then
   * gets it as the user message it is, at that point in the turn.
   */
  steerTurn(messages: unknown[], steer: { steerId: string; content: string }): boolean;
  /**
   * Interrupts the turn in flight so a steered message still waiting goes in
   * at once: the CLI keeps the message and runs it next. False when the message
   * is not waiting (anymore).
   */
  interruptForSteer(steerId: string): Promise<boolean>;
};

type ToolApprovalDecision = AnyRecord | null;

/** A pending approval's resolver, carrying the lookup fields getPendingApprovalsForSession reads. */
type ToolApprovalResolver = ((decision: ToolApprovalDecision) => void) & AnyRecord;

/**
 * A context-window reading. `used` is what the window holds; `total` is its size.
 */
type TokenBudget = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: { input: number; output: number };
};

const activeSessions = new Map<string, ActiveSession>();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map<string, ToolApprovalResolver>();
// The claude.ai session URL of each live process with Remote Control on, keyed
// like activeSessions. The bridge runs inside the process and ends with it.
const remoteControlUrls = new Map<string, string>();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set<string>();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet<ClaudeQuery>();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10) || 15 * 60 * 1000;

// Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: how long, once
// its stdin has ended, it waits for still-running background *agents* before
// killing them.
//
// Stdin itself is never ended on a timer. A session's process stays up between
// turns for as long as the chat is open, so its MCP servers and background work
// survive and every later turn goes into it as streaming input (see LiveProcess).
// It is let go only when the chat is archived or deleted
// (`releaseClaudeSDKIdleProcess`), when a turn needs a process launched with other
// options (`releaseHeldSession`), on an abort of the turn it was started for, and
// at server shutdown (`closeAllClaudeSDKProcesses`). Ending stdin is what the CLI
// reads as "print wind-down", which also kills background *shells* after a short
// grace period.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(
  model: string,
  effort: unknown,
  modelsDefinition: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS,
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions: AnyRecord, resolvedEffort: string | undefined) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

type ToolApprovalWaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onCancel?: (reason: string) => void;
  metadata?: AnyRecord;
};

function waitForToolApproval(requestId: string, options: ToolApprovalWaitOptions = {}): Promise<ToolApprovalDecision> {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise<ToolApprovalDecision>(resolve => {
    let settled = false;

    const finalize = (decision: ToolApprovalDecision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver: ToolApprovalResolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId: string, decision: ToolApprovalDecision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

/**
 * Environment for the spawned CLI. Forwards all host env vars (e.g. ANTHROPIC_BASE_URL);
 * since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
 *
 * Claude Code turns the Artifact tools off for SDK-driven sessions unless
 * CLAUDE_CODE_ARTIFACT is set, so a session continued from this UI would lose them.
 * Default it on; a host value (e.g. CLAUDE_CODE_ARTIFACT=0) still wins.
 *
 * @param {NodeJS.ProcessEnv} [hostEnv] - Environment to forward, `process.env` by default
 * @returns {NodeJS.ProcessEnv} Environment for the spawned CLI
 */
export function buildClaudeSdkEnv(hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_ARTIFACT: '1',
    ...hostEnv,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS),
  };
}

/** The API-key variables a launch env carries, so two launches can be compared on what they bill to. */
function readCredentialEnv(env: NodeJS.ProcessEnv | undefined): string {
  return JSON.stringify([env?.ANTHROPIC_API_KEY ?? null, env?.ANTHROPIC_AUTH_TOKEN ?? null]);
}

// Tools plan mode lets through without a prompt, on top of the user's own allow list.
const PLAN_MODE_TOOLS = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];

const CLAUDE_PERMISSION_MODES = new Set(['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']);

/**
 * The mode the SDK actually runs in for a requested mode. "Skip permissions" in
 * the tool settings overrides every mode except plan, which only reads.
 */
function resolveSdkPermissionMode(permissionMode: string | undefined, skipPermissions: boolean) {
  if (skipPermissions && permissionMode !== 'plan') {
    return 'bypassPermissions';
  }
  return permissionMode || 'default';
}

/**
 * Adds plan mode's tools to a run's allow list while the run is in plan mode,
 * and takes back out exactly the ones it added once it leaves. `granted`
 * remembers those, so a tool the user allowed themselves is never removed.
 */
function syncPlanModeTools(allowedTools: string[], granted: Set<string>, permissionMode: string | undefined) {
  if (permissionMode === 'plan') {
    for (const tool of PLAN_MODE_TOOLS) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
        granted.add(tool);
      }
    }
    return;
  }
  for (const tool of granted) {
    const index = allowedTools.indexOf(tool);
    if (index !== -1) {
      allowedTools.splice(index, 1);
    }
  }
  granted.clear();
}

/** Exported for the Providers tests; the runtime below is its only production caller. */
export function mapCliOptionsToSDK(options: AnyRecord = {}) {
  const {
    sessionId,
    providerSessionId,
    cwd,
    additionalDirectories,
    toolsSettings,
    permissionMode,
    effort,
    resumeAnchorId,
    resumeFromScratch,
    billing,
  } = options;

  const sdkOptions: AnyRecord = {};

  sdkOptions.env = { ...buildClaudeSdkEnv(), ...buildAgentSessionEnv(sessionId) };
  if (billing) {
    sdkOptions.env = applyClaudeBillingEnv(sdkOptions.env, billing as ClaudeBilling);
  }

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // The project's extra folders, so file tools may work there without a prompt.
  if (Array.isArray(additionalDirectories) && additionalDirectories.length > 0) {
    sdkOptions.additionalDirectories = additionalDirectories;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  const sdkPermissionMode = resolveSdkPermissionMode(permissionMode, Boolean(settings.skipPermissions));
  if (sdkPermissionMode !== 'default') {
    sdkOptions.permissionMode = sdkPermissionMode;
  }

  // Plan mode's extra tools are added by the run itself, which has to be able
  // to take them back out when the mode changes mid-run.
  sdkOptions.allowedTools = [...(settings.allowedTools || [])];

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 * @param {Object} liveProcess - The run loop's handle for later turns
 */
function addSession(
  sessionId: string,
  queryInstance: ClaudeQuery,
  writer: ClaudeRuntimeWriter | null = null,
  releaseInput: (() => void) | null = null,
  liveProcess: LiveProcess | null = null,
  applyPermissionMode: ((permissionMode: string) => Promise<void>) | null = null,
) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, whose
  // session-keyed abortedSessionIds flag would be consumed by the new run
  // and suppress its terminal `complete`.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding && existing) {
    supersededInstances.add(existing.instance);
    Promise.resolve()
      .then(() => existing.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing.releaseInput?.();
    // Whatever the superseded process had outstanding dies with it and will
    // never report, so the new run starts from an empty task set.
    backgroundWork.clear(sessionId);
    remoteControlUrls.delete(sessionId);
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    liveProcess: liveProcess || carried?.liveProcess || null,
    applyPermissionMode: applyPermissionMode || carried?.applyPermissionMode || null,
  });
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Lets go of the process an earlier run left holding a session open, so the
 * next turn can take the session over.
 *
 * Closing stdin is not enough on its own: the CLI's wind-down waits for the
 * background agents the process still has going — for up to the ceiling it
 * was started with (BG_WAIT_CEILING_MS) — so an abandoned process with an
 * agent outstanding would run next to the process that replaced it for as
 * long as the agent does, both appending to the same session file. Stop the
 * tasks first, while stdin is still open: the SDK drops control requests
 * written after stdin has ended, which is also why the interrupt a later
 * supersede sends to this process cannot do the job.
 *
 * The stops are not awaited — each request is written to the CLI before this
 * returns, and a reply is only missing when the process has already gone.
 * @param {string} sessionId - Session identifier
 */
function releaseHeldSession(sessionId: string) {
  const held = getSession(sessionId);
  if (!held) {
    return;
  }
  for (const task of backgroundWork.outstanding(sessionId)) {
    // A stop that cannot be delivered changes nothing about what happens
    // next: the process is on its way out either way. Guard the synchronous
    // call too, so a failing stop can never skip the release below.
    try {
      Promise.resolve(held.instance?.stopTask?.(task.taskId)).catch(() => {});
    } catch {
      // Same as a rejected stop.
    }
  }
  held.releaseInput?.();
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId: string) {
  activeSessions.delete(sessionId);
  // No process, no background work: anything still tracked was killed with it.
  backgroundWork.clear(sessionId);
  remoteControlUrls.delete(sessionId);
  // See addSession: a page cached while the process was up still says
  // `running` for any agent that never reported back.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId: string) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage: AnyRecord): AnyRecord {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message: AnyRecord | null | undefined) {
  return Boolean(message?.parentToolUseId) && message?.role === 'user' && message?.kind === 'text';
}

function readNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The window a budget is measured against: the one the SDK reported for the
 * session's model when known, else the server-wide CONTEXT_WINDOW setting.
 * @param {number|null|undefined} reportedContextWindow - SDK-reported window
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(reportedContextWindow?: number | null): number {
  if (typeof reportedContextWindow === 'number' && Number.isFinite(reportedContextWindow) && reportedContextWindow > 0) {
    return reportedContextWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || 160000;
}

/**
 * The window a requested model id is known to have before any turn reports one: Opus and
 * every `[1m]` variant run with 1M. A reported window replaces this after the first turn.
 */
function knownClaudeContextWindow(requestedModel: string | null | undefined): number | null {
  return requestedModel && /opus|\[1m\]$/i.test(requestedModel) ? 1_000_000 : null;
}

/**
 * Reads the context window the SDK measured for the model that served a turn.
 *
 * `result.modelUsage` has one entry per model the turn billed, subagents'
 * included, so the entry has to be the main thread's model. Its key is the id
 * the CLI requested, which for a 1M variant carries a `[1m]` suffix that the
 * assistant rows' `message.model` lacks (`claude-sonnet-5-5[1m]` vs
 * `claude-sonnet-5-5`); newer CLIs also state the bare id as `canonicalModel`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {string|null} mainModel - `message.model` of the turn's main-thread assistant rows
 * @returns {number|null} The reported window, or null when there is none
 */
function readReportedContextWindow(sdkMessage: AnyRecord, mainModel: string | null): number | null {
  const modelUsage = sdkMessage?.type === 'result' ? sdkMessage.modelUsage : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const reported = Object.entries(modelUsage as Record<string, AnyRecord>).filter(
    ([, modelData]) => modelData && typeof modelData === 'object' && readNumber(modelData.contextWindow) > 0
  );
  const exactMatch = reported.find(([modelKey]) => modelKey === mainModel);
  const variantMatch = reported.find(([modelKey, modelData]) => (
    Boolean(mainModel)
    && (modelData.canonicalModel === mainModel || modelKey.replace(/\[[^\]]*\]$/, '') === mainModel)
  ));
  // A turn that billed a single model was served by it, whatever it is called.
  const entry = exactMatch ?? variantMatch ?? (reported.length === 1 ? reported[0] : null);
  return entry ? readNumber(entry[1].contextWindow) : null;
}

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage: AnyRecord, reportedContextWindow?: number | null): TokenBudget {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage: unknown, reportedContextWindow?: number | null): TokenBudget | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  const message = sdkMessage as AnyRecord;
  if (message.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (message.type !== 'assistant') {
    return null;
  }

  const messageUsage = message.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage, reportedContextWindow);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(rawMessage: unknown, reportedContextWindow?: number | null): TokenBudget | null {
  const sdkMessage = rawMessage as AnyRecord | null;
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage, reportedContextWindow);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * The process stays up after every turn; this only decides whether a later
 * `result` is that work reporting back (for tools whose work emits no task
 * events, which the tracker would otherwise know about).
 *
 * Used by the providers module's tests, which pin the tool matching directly.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage: AnyRecord | null | undefined) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block: AnyRecord | null) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    // A backgrounded subagent outlives the turn exactly like a backgrounded
    // Bash does, and reports back in a follow-up turn the same way.
    // Agents background by default — `run_in_background` is optional and only
    // an explicit `false` opts out — hence `!== false` rather than `=== true`.
    // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
    // a follow-up turn, so it would pin the process for the full ceiling.
    if (block.name === 'Agent') {
      return block.input?.run_in_background !== false;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

// `task_updated` patch statuses after which a task is gone for good. `pending`,
// `running` and `paused` are still outstanding; `killed` is what the CLI
// writes when it stops a task itself (the task notification spells it
// `stopped`).
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Tracks the background tasks each live session still has outstanding, folded
 * from the `system` task events the SDK stream already carries.
 *
 * `startsBackgroundWork` above only knows that a turn *launched* something
 * lasting; this knows what is still running and which task ids it answers to,
 * which is what the running-sessions list and a stop request need once the
 * turn's `result` has gone out and nothing else remembers the session is busy.
 *
 * Verified against a real query (SDK 0.3.165): `task_started` carries
 * `task_id`, `tool_use_id`, `task_type` and `description` for every agent,
 * workflow and backgrounded command (a foreground Bash emits nothing);
 * `task_notification` settles a task with any status; `task_updated` carries
 * only `task_id` and a patch, and is terminal when the patch's `status` is.
 * Housekeeping tasks the CLI starts on its own have no `tool_use_id` and are
 * not tracked — nothing in the transcript could show them.
 *
 * Exported so the folding can be driven with the four event shapes directly;
 * the runtime keeps one instance keyed like `activeSessions`.
 *
 */
export function createBackgroundWorkTracker() {
  const sessions = new Map<string, Map<string, BackgroundTaskSummary>>();
  /**
   * Tool-use ids the session's own turns issued. A task started for a call an
   * agent made inside its own transcript — a workflow agent's backgrounded
   * command, say — reaches this stream too, and nothing in the parent
   * transcript could show it; it is kept for stopping but flagged `nested`.
   */
  const ownToolUseIds = new Map<string, Set<string>>();

  const remove = (sessionKey: string, taskId: string) => {
    const tasks = sessions.get(sessionKey);
    if (!tasks) {
      return;
    }
    tasks.delete(taskId);
    if (tasks.size === 0) {
      sessions.delete(sessionKey);
    }
  };

  return {
    apply(sessionKey: string, message: AnyRecord | null | undefined) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Set<string>();
                ownToolUseIds.set(sessionKey, ids);
              }
              ids.add(block.id);
            }
          }
        }
        return;
      }
      if (message?.type !== 'system' || typeof message.task_id !== 'string') {
        return;
      }
      switch (message.subtype) {
        case 'task_started': {
          if (typeof message.tool_use_id !== 'string') {
            return;
          }
          const task: BackgroundTaskSummary = {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            taskType: message.task_type,
            description: message.description,
            startedAt: Date.now()
          };
          if (typeof message.workflow_name === 'string') {
            task.workflowName = message.workflow_name;
          }
          if (!ownToolUseIds.get(sessionKey)?.has(message.tool_use_id)) {
            task.nested = true;
          }
          let tasks = sessions.get(sessionKey);
          if (!tasks) {
            tasks = new Map<string, BackgroundTaskSummary>();
            sessions.set(sessionKey, tasks);
          }
          tasks.set(task.taskId, task);
          return;
        }
        case 'task_notification':
          remove(sessionKey, message.task_id);
          return;
        case 'task_updated':
          if (TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
            remove(sessionKey, message.task_id);
          }
          return;
        default:
      }
    },

    hasOutstanding(sessionKey: string) {
      return sessions.has(sessionKey);
    },

    has(sessionKey: string, taskId: string) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    outstanding(sessionKey: string): BackgroundTaskSummary[] {
      return Array.from(sessions.get(sessionKey)?.values() ?? []);
    },

    clear(sessionKey: string) {
      sessions.delete(sessionKey);
      ownToolUseIds.delete(sessionKey);
    },

    list() {
      return Array.from(sessions, ([sessionId, tasks]) => ({
        sessionId,
        tasks: Array.from(tasks.values())
      }));
    }
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command: string, images: unknown, files: unknown, cwd: string) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * The CLI's stdin as a queue: yields the turn's prompt messages, then parks
 * until more are pushed or the stream is released.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone. While it is
 * pending, a later turn pushed in here reaches the same process as streaming
 * input, with its background work still running.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send first
 * @returns Stream, a pusher (false once released) and the closer
 */
function createHeldPromptStream(messages: unknown[]) {
  const pending = [...messages];
  let released = false;
  let wake: (() => void) | null = null;
  const signal = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const stream = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift();
        continue;
      }
      if (released) {
        return;
      }
      // Keeps stdin open — the CLI stays alive until release() is called.
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();

  return {
    stream,
    push(more: unknown[]) {
      if (released) {
        return false;
      }
      pending.push(...more);
      signal();
      return true;
    },
    release() {
      released = true;
      signal();
    },
  };
}

/**
 * Reads the launch terms a held process is measured against from a turn's
 * `chat.send` options — the same fields `mapCliOptionsToSDK` turns into the
 * CLI flags the SDK cannot change once the process is up.
 * @param {Object} options - The turn's options
 * @returns {LiveTurnTerms}
 */
function readLiveTurnTerms(options: AnyRecord): LiveTurnTerms {
  const settings = options.toolsSettings || {};
  const { permissionMode } = options;
  return {
    effort: typeof options.effort === 'string' && options.effort !== 'default' ? options.effort : null,
    bypassPermissions: permissionMode === 'bypassPermissions'
      || (Boolean(settings.skipPermissions) && permissionMode !== 'plan'),
    planMode: permissionMode === 'plan',
    allowedTools: [...(settings.allowedTools || [])],
    disallowedTools: [...(settings.disallowedTools || [])],
  };
}

/**
 * Whether a turn with `next` terms behaves the same in a process launched
 * with `launch` terms. The model and the other permission modes are applied
 * through the query's setters; what is compared here is what only a launch
 * can set:
 * - effort, which the CLI takes as a flag,
 * - bypass, which the CLI only enters when launched into it,
 * - plan, which adds its tools to the launch's allowed list,
 * - the tool lists, which the CLI enforces from its flags before our
 *   `canUseTool` sees a call. Allowing more is fine (the callback allows the
 *   additions); allowing less, or changing what is denied, is not.
 *
 * The composer applies the same rule to the terms the server reports, so it
 * knows before sending whether a new process (and the existing dialog) is
 * needed.
 */
function liveTurnTermsAccept(launch: LiveTurnTerms, next: LiveTurnTerms): boolean {
  const allowed = new Set(next.allowedTools);
  const denied = new Set(next.disallowedTools);
  return launch.effort === next.effort
    && launch.bypassPermissions === next.bypassPermissions
    && launch.planMode === next.planMode
    && launch.allowedTools.every((tool) => allowed.has(tool))
    && new Set(launch.disallowedTools).size === denied.size
    && launch.disallowedTools.every((tool) => denied.has(tool));
}

// How long a turn delivered after an interrupt waits for the interrupted
// turn's `result` before going in anyway. The result normally lands within
// moments; the wait only keeps it from being taken for the new turn's.
const INTERRUPT_SETTLE_MS = 5000;

// How long a turn whose `result` lands with a steered message still unread
// waits for the CLI to start that message as a turn of its own. The CLI starts
// it at once; the wait only keeps a message it dropped from holding the turn open.
const STEER_PICKUP_MS = 5000;

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd: string | undefined): Promise<AnyRecord | null> {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', (error as Error).message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers: AnyRecord = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', (error as Error).message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK.
 *
 * A session's process stays up between turns, so a later turn is pushed into
 * it as streaming input (see LiveProcess): its MCP servers stay connected and
 * any background work keeps running. Edits and option changes the SDK cannot
 * apply to a running query still start a new process.
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(
  command: string,
  options: AnyRecord = {},
  ws: ClaudeRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const { sessionId } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  // The turn this process is serving. A later turn delivered into the process
  // takes these over: its events, permission prompts and notifications go to
  // its own writer, and the next `result` is the one that completes it.
  let turnWriter: ClaudeRuntimeWriter = ws;
  let turnSessionSummary = options.sessionSummary;
  // Ends the run promise of a delivered turn; set while one is in flight.
  let settleDeliveredTurn: (() => void) | null = null;
  // A delivered turn the user interrupted: the abort already completed it for
  // the client, and the next `result` is that turn winding down.
  let deliveredTurnInterrupted = false;
  let interruptSettled: Promise<void> | null = null;
  let resolveInterruptSettled: (() => void) | null = null;

  const emitNotification = (event: unknown) => {
    notifyUserIfEnabled({
      userId: turnWriter?.userId || null,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream: () => void = () => {};
  // Pushes a later turn into the held stdin stream; false once it is closed.
  let pushPrompt: (messages: unknown[]) => boolean = () => false;
  let promptReleased = false;
  // True from a turn's `result` until the next turn is pushed in: the process
  // is up with nothing in flight and can take the next turn.
  let betweenTurns = false;
  // The client is told the turn is over as soon as `result` lands; the process
  // stays up for the next one.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives.
  let backgroundWorkPending = false;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides; `startsBackgroundWork` is the fallback
  // for tools that emit none (Monitor, ScheduleWakeup, CronCreate, TaskCreate)
  // and for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
  // True while the turn that ended left background work going, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // The window the SDK reported for this session's model (a resumed session
  // starts from the one its last run reported), the model the main thread's
  // assistant rows name, and the budget last published — re-sent with the
  // right total when the turn's `result` is the first to state the window.
  let reportedContextWindow: number | null = getReportedClaudeContextWindow(providerSessionId) ?? null;
  let mainThreadModel: string | null = null;
  let lastSentTokenBudget: TokenBudget | null = null;

  // Uuids of the user messages this run pushed into the CLI. The CLI echoes
  // each one back once it takes it (--replay-user-messages); the client already
  // shows them, so the echo is a receipt and is not forwarded.
  const ownPromptUuids = new Set<string>();
  // Steered messages the CLI has not taken yet. A `result` that lands while one
  // waits does not end the turn, because the CLI runs that message next.
  const pendingSteers = new Set<string>();
  let steerPickupTimer: ReturnType<typeof setTimeout> | null = null;
  const trackPrompt = (messages: unknown[], uuid?: string): AnyRecord[] => messages.map((message, index) => {
    const messageUuid = index === 0 && uuid ? uuid : crypto.randomUUID();
    ownPromptUuids.add(messageUuid);
    return { ...(message as AnyRecord), uuid: messageUuid };
  });

  // Marks the process as between turns once a turn is over, and notes whether
  // that turn left background work going. The process stays up either way.
  //
  // Work started during this turn, or work from an earlier turn that has not
  // settled yet (a follow-up turn reports one task in while another is still
  // going), is still running and reports back in a follow-up turn the CLI
  // pushes. When the turn reported its tasks, the tracker is the whole truth:
  // an Agent call without `run_in_background` is scored as background by
  // `startsBackgroundWork`, but the CLI runs it in the foreground and it has
  // settled before this `result`.
  const settleBetweenTurns = () => {
    const stillOutstanding = backgroundWork.hasOutstanding(sessionKey()!);
    heldForBackgroundWork = sawTaskEventThisTurn ? stillOutstanding : backgroundWorkPending || stillOutstanding;
    backgroundWorkPending = false;
    sawTaskEventThisTurn = false;
    betweenTurns = true;
  };

  // Ends a delivered turn's run promise, and an interrupt's wait for the
  // interrupted turn to wind down.
  const settleTurn = () => {
    deliveredTurnInterrupted = false;
    const settle = settleDeliveredTurn;
    settleDeliveredTurn = null;
    settle?.();
    const settled = resolveInterruptSettled;
    resolveInterruptSettled = null;
    interruptSettled = null;
    settled?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance: ClaudeQuery | null = null;

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const billing = claudeBilling.resolve();
    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
      billing,
    });
    reportedContextWindow ??= getReportedClaudeModelContextWindow(sdkOptions.model) ?? knownClaudeContextWindow(sdkOptions.model);
    const planModeGrants = new Set<string>();
    syncPlanModeTools(sdkOptions.allowedTools, planModeGrants, options.permissionMode);
    // The echo of a steered message is the only word on whether the CLI took it
    // inside the running turn or will run it as a turn of its own.
    sdkOptions.extraArgs = { ...(sdkOptions.extraArgs || {}), 'replay-user-messages': null };

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    // A process this session left running for its background work takes the
    // turn as streaming input when it can, so that work keeps going. An edit
    // resumes the transcript partway, which only a new process can do.
    const heldSession = sessionKey() ? getSession(sessionKey()!) : undefined;
    if (heldSession?.liveProcess && !options.resumeAnchorId && !options.resumeFromScratch) {
      const delivery = await heldSession.liveProcess.deliverTurn({
        messages: promptMessages,
        writer: ws,
        sessionSummary: options.sessionSummary,
        options,
        sdkOptions,
        mcpServers,
        providerSessionId,
      });
      if (delivery) {
        await delivery.settled;
        return;
      }
    }

    // A new turn supersedes any earlier one still holding this session's process
    // open, so held runs cannot stack up across a conversation.
    if (sessionKey()) {
      releaseHeldSession(sessionKey()!);
    }

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input: AnyRecord) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(notificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: turnSessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName: string, input: unknown, context?: { signal?: AbortSignal }) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = isToolCallDenied(sdkOptions.disallowedTools || [], toolName, input);
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = isToolCallAllowed(sdkOptions.allowedTools || [], toolName, input);
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      // The prompt and its answer stay with the turn that asked, even if a
      // later turn takes the process over while it waits.
      const writer = turnWriter;
      const requestId = createRequestId();
      writer.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(notificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: turnSessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason: string) => {
          writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      writer.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter((entry: string) => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    const createQuery = context.createQuery ?? query;
    const ownPromptMessages = trackPrompt(promptMessages);
    let heldPrompt = createHeldPromptStream(ownPromptMessages);
    releasePromptStream = () => {
      promptReleased = true;
      heldPrompt.release();
    };
    pushPrompt = (messages) => heldPrompt.push(messages);
    try {
      queryInstance = createQuery({
        prompt: heldPrompt.stream as AsyncIterable<SDKUserMessage>,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', (hookError as Error)?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(ownPromptMessages);
      queryInstance = createQuery({
        prompt: heldPrompt.stream as AsyncIterable<SDKUserMessage>,
        options: sdkOptions
      });
    }
    const instance = queryInstance;

    // What the process was launched with that no setter can change; a later
    // turn is measured against it for as long as the process lives.
    const launchTerms = readLiveTurnTerms(options);
    const launchEffort = sdkOptions.effort;
    const launchSettings = JSON.stringify(sdkOptions.settings ?? null);
    const launchMcpServers = JSON.stringify(sdkOptions.mcpServers ?? null);
    const launchCwd = sdkOptions.cwd ?? null;
    const launchCredential = readCredentialEnv(sdkOptions.env);
    // Whether this process bills to an API key: launched on one, or handed one by settings.json, which the CLI
    // reads itself and the env cannot override. The CLI states its source on `init`.
    let billedToKey = billing.mode === 'api_key';
    // The CLI's running cost total for this process, so each `result` records only what its turn added.
    let lastCostTotal = 0;

    const liveProcess: LiveProcess = {
      terms: launchTerms,

      canTakeTurn: () => {
        const key = sessionKey();
        return Boolean(
          key
          && capturedSessionId
          && (betweenTurns || deliveredTurnInterrupted)
          && !promptReleased
          && !abortedSessionIds.has(key)
          && getSession(key)?.instance === instance
        );
      },

      deliverTurn: async (turn) => {
        if (!liveProcess.canTakeTurn()) {
          return null;
        }
        const next = turn.sdkOptions;
        const sameLaunch = liveTurnTermsAccept(launchTerms, readLiveTurnTerms(turn.options))
          && (next.cwd ?? null) === launchCwd
          && next.effort === launchEffort
          && JSON.stringify(next.settings ?? null) === launchSettings
          && JSON.stringify(turn.mcpServers ?? null) === launchMcpServers
          && (!turn.providerSessionId || turn.providerSessionId === capturedSessionId)
          // A billing switch needs a new process, unless that would end background work still running in this one.
          && (readCredentialEnv(next.env) === launchCredential || backgroundWork.hasOutstanding(sessionKey()!));
        if (!sameLaunch) {
          return null;
        }

        const nextPermissionMode = next.permissionMode || 'default';
        const changesPermissionMode = nextPermissionMode !== (sdkOptions.permissionMode || 'default');
        const changesModel = next.model !== sdkOptions.model;
        if ((changesPermissionMode && !instance.setPermissionMode) || (changesModel && !instance.setModel)) {
          return null;
        }

        // A turn sent right after an interrupt waits for the interrupted
        // turn's `result`, or it would be taken for this turn's.
        if (interruptSettled) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            interruptSettled,
            new Promise<void>((resolve) => { timer = setTimeout(resolve, INTERRUPT_SETTLE_MS); }),
          ]);
          clearTimeout(timer);
        }

        try {
          if (changesPermissionMode) {
            await instance.setPermissionMode!(nextPermissionMode);
          }
          if (changesModel) {
            await instance.setModel!(next.model);
          }
        } catch (error) {
          console.warn('[Claude SDK] Could not apply the new turn\'s options to the live process:', (error as Error)?.message || error);
          return null;
        }

        // Everything from here on is synchronous, so the process cannot be
        // let go between this check and the push.
        if (!liveProcess.canTakeTurn()) {
          return null;
        }

        sdkOptions.permissionMode = next.permissionMode;
        sdkOptions.model = next.model;
        // What a new process would have been given; the launch's own lists are
        // contained in it (liveTurnTermsAccept), so the CLI's flags agree.
        sdkOptions.allowedTools = [...(next.allowedTools || [])];
        sdkOptions.disallowedTools = [...(next.disallowedTools || [])];
        planModeGrants.clear();
        syncPlanModeTools(sdkOptions.allowedTools, planModeGrants, turn.options.permissionMode);

        // The turn takes the process over until its own `result`.
        settleTurn();
        betweenTurns = false;
        heldForBackgroundWork = false;
        backgroundWorkPending = false;
        sawTaskEventThisTurn = false;
        turnCompleteSent = false;
        turnWriter = turn.writer;
        turnSessionSummary = turn.sessionSummary;
        const entry = getSession(sessionKey()!);
        if (entry) {
          // Reconnects swap the socket on the writer of the turn in flight.
          entry.writer = turn.writer;
        }
        if (typeof turn.writer.setSessionId === 'function') {
          turn.writer.setSessionId(capturedSessionId!);
        }

        const settled = new Promise<void>((resolve) => { settleDeliveredTurn = resolve; });
        pushPrompt(trackPrompt(turn.messages));
        return { settled };
      },

      steerTurn: (messages, steer) => {
        const key = sessionKey();
        if (
          !key
          || betweenTurns
          || turnCompleteSent
          || deliveredTurnInterrupted
          || promptReleased
          || abortedSessionIds.has(key)
          || getSession(key)?.instance !== instance
          || ownPromptUuids.has(steer.steerId)
        ) {
          return false;
        }
        // `next` is the CLI's own priority for a message typed mid-turn.
        const steered = trackPrompt(messages, steer.steerId).map((message): AnyRecord => ({ ...message, priority: 'next' }));
        if (!pushPrompt(steered)) {
          return false;
        }
        for (const message of steered) {
          pendingSteers.add(message.uuid);
        }
        turnWriter.send(createNormalizedMessage({
          kind: 'steer_pending',
          steerId: steer.steerId,
          content: steer.content,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'claude',
        }));
        return true;
      },

      interruptForSteer: async (steerId) => {
        if (!pendingSteers.has(steerId) || turnCompleteSent) {
          return false;
        }
        await instance.interrupt();
        return true;
      },

      interruptTurn: async () => {
        if (!settleDeliveredTurn || turnCompleteSent) {
          return false;
        }
        // The abort completes the turn for the client; the interrupted turn's
        // own `result` must not complete it a second time.
        turnCompleteSent = true;
        deliveredTurnInterrupted = true;
        pendingSteers.clear();
        interruptSettled =new Promise<void>((resolve) => { resolveInterruptSettled = resolve; });
        try {
          await instance.interrupt();
        } catch (error) {
          console.error(`Error interrupting turn for session ${sessionKey()}:`, (error as Error)?.message || error);
          turnCompleteSent = false;
          deliveredTurnInterrupted = false;
          return false;
        }
        // The interrupted turn normally ends with a `result`, which settles
        // it and puts the process between turns. Should none come, settle
        // here, so the run is not left open and the process can take a turn.
        const fallback = setTimeout(() => {
          if (deliveredTurnInterrupted) {
            settleTurn();
            settleBetweenTurns();
          }
        }, INTERRUPT_SETTLE_MS);
        fallback.unref?.();
        return true;
      },
    };

    // canUseTool reads the mode and allow list from sdkOptions, so they change
    // together with the process; otherwise a switch to bypass would still prompt.
    const runQuery = queryInstance;
    const applyPermissionMode = async (permissionMode: string) => {
      const sdkPermissionMode = resolveSdkPermissionMode(permissionMode, Boolean(options.toolsSettings?.skipPermissions));
      await runQuery.setPermissionMode!(sdkPermissionMode);
      sdkOptions.permissionMode = sdkPermissionMode;
      syncPlanModeTools(sdkOptions.allowedTools, planModeGrants, permissionMode);
    };

    // Tells the client the turn is over; the process stays up for the next one.
    const completeTurn = () => {
      turnCompleteSent = true;
      turnWriter.send({
        ...createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }),
        // Tells the composer the next turn can go into this process.
        ...(liveProcess.canTakeTurn() ? { liveTurn: launchTerms } : {}),
      });
      notifyRunStopped({
        userId: turnWriter?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: turnSessionSummary,
        stopReason: 'completed'
      });
    };

    // Completes a turn whose `result` was held for a steered message the CLI
    // never started.
    const stopWaitingForSteers = () => {
      steerPickupTimer = null;
      if (pendingSteers.size === 0 || turnCompleteSent) {
        return;
      }
      pendingSteers.clear();
      settleBetweenTurns();
      completeTurn();
      settleTurn();
    };

    // Starts Remote Control once the process is registered under its session,
    // when the turn that launched it asked for it.
    let remoteControlRequested = options.remoteControl === true;
    const startRequestedRemoteControl = () => {
      const key = sessionKey();
      if (!remoteControlRequested || !key) {
        return;
      }
      remoteControlRequested = false;
      setClaudeSDKRemoteControl(key, true)
        .catch((error: unknown): RemoteControlState => ({ enabled: false, sessionUrl: null, error: (error as Error)?.message || String(error) }))
        .then((state) => {
          if (state) {
            turnWriter.send(createRemoteControlMessage(key, state));
          }
        });
    };

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey()!, queryInstance, ws, releasePromptStream, liveProcess, applyPermissionMode);
      startRequestedRemoteControl();
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const rawMessage of queryInstance) {
      const message = rawMessage as AnyRecord;
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey()!, queryInstance, turnWriter, releasePromptStream, liveProcess, applyPermissionMode);
        startRequestedRemoteControl();

        // Set session ID on writer
        if (turnWriter.setSessionId && typeof turnWriter.setSessionId === 'function') {
          turnWriter.setSessionId(capturedSessionId!);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          turnWriter.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      if (message.type === 'user' && message.isReplay && ownPromptUuids.delete(message.uuid)) {
        if (pendingSteers.delete(message.uuid)) {
          // Shown where the model read it. The `local_` id lets the client
          // retire it for the transcript's own row once that is loaded.
          const delivered = context.normalizeMessage({
            type: 'user',
            uuid: message.uuid,
            timestamp: new Date().toISOString(),
            message: message.message,
          }, capturedSessionId || sessionId || null);
          delivered.forEach((row, index) => {
            turnWriter.send({ ...row, id: `local_steer_${message.uuid}_${index}`, steerId: message.uuid });
          });
          if (pendingSteers.size === 0 && steerPickupTimer) {
            clearTimeout(steerPickupTimer);
            steerPickupTimer = null;
          }
        }
        continue;
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        turnWriter.send(msg);
      }

      if (
        message.type === 'assistant'
        && !message.parent_tool_use_id
        && typeof message.message?.model === 'string'
        && message.message.model !== '<synthetic>'
      ) {
        mainThreadModel = message.message.model;
      }

      // Only a turn's `result` states the window of the model that served it.
      const turnContextWindow = readReportedContextWindow(message, mainThreadModel);
      const contextWindowChanged = Boolean(turnContextWindow) && turnContextWindow !== reportedContextWindow;
      if (turnContextWindow) {
        reportedContextWindow = turnContextWindow;
        rememberClaudeContextWindow(message.session_id || capturedSessionId, turnContextWindow, sdkOptions.model);
        if (contextWindowChanged && sessionKey()) {
          // A history page cached before this turn ended carries the old total.
          sessionHistoryCache.invalidate(sessionKey());
        }
      }

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      let tokenBudgetData = extractTokenBudget(message, reportedContextWindow)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message, reportedContextWindow));
      if (
        !tokenBudgetData
        && turnContextWindow
        && lastSentTokenBudget
        && lastSentTokenBudget.total !== turnContextWindow
      ) {
        // The reading stands; only the window it is measured against was wrong.
        tokenBudgetData = { ...(lastSentTokenBudget as TokenBudget), total: turnContextWindow };
      }
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        lastSentTokenBudget = tokenBudgetData;
        turnWriter.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }
      if (message.type === 'system' && message.subtype === 'task_started') {
        sawTaskEventThisTurn = true;
      }
      backgroundWork.apply(sessionKey()!, message);

      if (message.type === 'system' && message.subtype === 'init' && typeof message.apiKeySource === 'string') {
        billedToKey ||= !['none', 'oauth'].includes(message.apiKeySource);
      }
      if (message.type === 'rate_limit_event' && !billedToKey) {
        claudeBilling.noteRateLimit(message.rate_limit_info);
      }
      if (message.type === 'result' && billedToKey && typeof message.total_cost_usd === 'number') {
        claudeBilling.recordSpend(message.total_cost_usd - lastCostTotal, sessionId || capturedSessionId || null);
        lastCostTotal = message.total_cost_usd;
      }

      if (message.type === 'result') {
        // The turn is done as far as the client is concerned.
        const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;
        const completesTurn = !turnCompleteSent && !abortPending;
        // The CLI runs a steered message it did not take within this turn as
        // a turn of its own, which the client sees as the rest of this one.
        if (completesTurn && pendingSteers.size > 0) {
          if (!steerPickupTimer) {
            steerPickupTimer = setTimeout(stopWaitingForSteers, STEER_PICKUP_MS);
            steerPickupTimer.unref?.();
          }
          continue;
        }
        // A result after the turn already reported complete means the work we
        // held the process open for has finished and pushed a follow-up turn
        // — the last of it, when nothing else is still running.
        const reportsBackgroundWorkDone = !completesTurn
          && heldForBackgroundWork
          && !abortPending
          && !backgroundWork.hasOutstanding(sessionKey()!);

        settleBetweenTurns();

        if (completesTurn) {
          completeTurn();
        } else if (reportsBackgroundWorkDone) {
          notifyBackgroundWorkCompleted({
            userId: turnWriter?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: turnSessionSummary
          });
        }
        // A delivered turn's run ends with its `result` (after the `complete`
        // above), as does an interrupt's wait for it.
        settleTurn();
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey()!)?.instance === queryInstance) {
      removeSession(sessionKey()!);
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()!) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        turnWriter.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: turnWriter?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: turnSessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey()!)?.instance === queryInstance) {
      removeSession(sessionKey()!);
    }

    if (queryInstance && supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()!) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : (error as Error).message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    turnWriter.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      turnWriter.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: turnWriter?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: turnSessionSummary,
      error
    });
  } finally {
    if (steerPickupTimer) {
      clearTimeout(steerPickupTimer);
    }
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    releasePromptStream();
    // A turn delivered into this process ends with it.
    settleTurn();
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId: string) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  // A turn delivered into a live process is interrupted in place and settles
  // on its own `result`; see LiveProcess.interruptTurn.
  if (await session.liveProcess?.interruptTurn()) {
    return true;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks.
 *
 * A session stays here after its turn's `result` for as long as the work is
 * outstanding — which is exactly the window in which nothing else (the chat
 * run registry marks the run completed at `result`) knows the session is
 * still busy. A process with nothing outstanding is idle and not listed.
 */
function listClaudeSDKBackgroundWork(): Array<{
  sessionId: string;
  tasks: BackgroundTaskSummary[];
  liveTurn?: LiveTurnTerms;
}> {
  return backgroundWork.list().map((entry) => {
    const liveProcess = getSession(entry.sessionId)?.liveProcess;
    return liveProcess?.canTakeTurn() ? { ...entry, liveTurn: liveProcess.terms } : entry;
  });
}

/**
 * Whether a turn with these options would go into the session's held process
 * rather than replace it. Checks the client-facing terms only; the run itself
 * also compares what the server resolves (cwd, MCP servers, the effort the
 * model allows) and starts a new process should one of those differ.
 * @param {string} sessionId - Session identifier
 * @param {Object} options - The turn's `chat.send` options
 * @returns {boolean}
 */
function acceptsClaudeSDKLiveTurn(sessionId: string, options: AnyRecord): boolean {
  const liveProcess = getSession(sessionId)?.liveProcess;
  return Boolean(liveProcess?.canTakeTurn() && liveTurnTermsAccept(liveProcess.terms, readLiveTurnTerms(options)));
}

// The model reads a message taken mid-turn inside a tool loop, and left to
// itself often answers it only in its thinking, which the user sees collapsed:
// across 440 such messages in local transcripts, 154 got a visible reply. A
// softer ask ("not only in your thinking") was still answered in thinking.
const STEER_REPLY_INSTRUCTION = 'The user sent this while you were working. The user cannot see your thinking. '
  + 'Before any further tool call, write a text reply to this message that the user can read, then continue.';

/**
 * Adds a message to the session's turn in flight, as LiveProcess.steerTurn.
 * @param {string} sessionId - Session identifier
 * @param {string} command - The message text
 * @param {Object} options - `steerId`, and the `images`, `files` and `cwd` a `chat.send` turn gets
 * @returns {Promise<boolean>} False when the session has no turn in flight
 */
async function steerClaudeSDKTurn(sessionId: string, command: string, options: AnyRecord) {
  const liveProcess = getSession(sessionId)?.liveProcess;
  if (!liveProcess || typeof options.steerId !== 'string') {
    return false;
  }
  const prompt = appendPromptText(command, STEER_REPLY_INSTRUCTION);
  const messages = await buildPromptMessages(prompt, options.images, options.files, options.cwd);
  return liveProcess.steerTurn(messages, { steerId: options.steerId, content: command });
}

/**
 * Interrupts a session's turn for a steered message still waiting, as
 * LiveProcess.interruptForSteer.
 * @param {string} sessionId - Session identifier
 * @param {string} steerId - The id the message was steered with
 * @returns {Promise<boolean>} False when the message is not waiting
 */
async function interruptClaudeSDKTurnForSteer(sessionId: string, steerId: string) {
  return Boolean(await getSession(sessionId)?.liveProcess?.interruptForSteer(steerId));
}

/**
 * Lets go of the process a session keeps between turns, when no turn is in
 * flight: its background tasks are stopped and stdin is ended, so the CLI and
 * its MCP servers exit. A session with a turn running is left alone; the
 * caller aborts that first if it means to.
 *
 * Used by the providers module's sessions service when a chat is archived or
 * deleted, and by the websocket module's session-process stopper.
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True when a process was let go
 */
function releaseClaudeSDKIdleProcess(sessionId: string): boolean {
  if (!getSession(sessionId)?.liveProcess?.canTakeTurn()) {
    return false;
  }
  releaseHeldSession(sessionId);
  return true;
}

/**
 * Ends every session process at once, for server shutdown. `close()` kills the
 * CLI subprocess (and with it its MCP servers) synchronously, which is what a
 * shutdown about to exit needs; ending stdin would leave the CLI waiting for
 * its background agents with nobody listening.
 */
function closeAllClaudeSDKProcesses(): void {
  for (const [sessionId, session] of activeSessions) {
    try {
      session.instance.close?.();
    } catch (error) {
      console.error(`Error closing the Claude process for session ${sessionId}:`, (error as Error)?.message || error);
    }
    session.releaseInput?.();
  }
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
async function stopClaudeSDKTask(sessionId: string, taskId: string) {
  const session = getSession(sessionId);
  if (!session || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  await session.instance.stopTask!(taskId);
  return true;
}

/**
 * Switches a live session to another permission mode, for the tool calls still
 * to come in its current turn.
 * @param {string} sessionId - Session identifier
 * @param {string} permissionMode - One of the SDK's permission modes
 * @returns {Promise<boolean>} False when no live process holds the session, or the mode is unknown
 */
async function setClaudeSDKPermissionMode(sessionId: string, permissionMode: string) {
  const session = getSession(sessionId);
  if (!session?.applyPermissionMode || session.status !== 'active' || !CLAUDE_PERMISSION_MODES.has(permissionMode)) {
    return false;
  }
  await session.applyPermissionMode(permissionMode);
  return true;
}

/** Whether a session's live process runs a Remote Control bridge, and where claude.ai shows it. */
type RemoteControlState = { enabled: boolean; sessionUrl: string | null; error?: string };

// The SDK's Query has this at runtime (0.3.165) but leaves it out of its typings.
type RemoteControlQuery = {
  enableRemoteControl?(enabled: boolean, name?: string): Promise<{ session_url?: string } | undefined>;
};

function createRemoteControlMessage(sessionId: string, state: RemoteControlState) {
  return createNormalizedMessage({ kind: 'remote_control', sessionId, provider: 'claude', ...state });
}

/**
 * Starts or stops Remote Control in a session's live process, so the chat can
 * be followed and driven from claude.ai or the Claude app.
 * @param {string} sessionId - Session identifier
 * @param {boolean} enabled - Whether the bridge should run
 * @returns {Promise<RemoteControlState|null>} Null when no live process holds the session
 */
async function setClaudeSDKRemoteControl(sessionId: string, enabled: boolean): Promise<RemoteControlState | null> {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') {
    return null;
  }
  const instance = session.instance as unknown as RemoteControlQuery;
  if (!instance.enableRemoteControl) {
    throw new Error('This Claude Agent SDK version cannot start Remote Control.');
  }
  const response = await instance.enableRemoteControl(enabled);
  if (enabled && response?.session_url) {
    remoteControlUrls.set(sessionId, response.session_url);
  } else {
    remoteControlUrls.delete(sessionId);
  }
  return { enabled, sessionUrl: remoteControlUrls.get(sessionId) ?? null };
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId: string) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * When the run behind a session started, or null when no run is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live run cannot belong to it.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live run started, or null
 */
function getClaudeSDKSessionStartTime(sessionId: string) {
  const session = getSession(sessionId);
  return session && session.status === 'active' ? session.startTime : null;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId: string) {
  const pending: AnyRecord[] = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId: string, newRawWs: unknown) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
  acceptsLiveTurn: acceptsClaudeSDKLiveTurn,
  setPermissionMode: setClaudeSDKPermissionMode,
  setRemoteControl: setClaudeSDKRemoteControl,
  steerTurn: steerClaudeSDKTurn,
  interruptForSteer: interruptClaudeSDKTurnForSteer,
  releaseIdleProcess: releaseClaudeSDKIdleProcess,
  closeAll: closeAllClaudeSDKProcesses,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
  acceptsClaudeSDKLiveTurn,
  setClaudeSDKPermissionMode,
  setClaudeSDKRemoteControl,
  steerClaudeSDKTurn,
  interruptClaudeSDKTurnForSteer,
  releaseClaudeSDKIdleProcess,
  closeAllClaudeSDKProcesses,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
