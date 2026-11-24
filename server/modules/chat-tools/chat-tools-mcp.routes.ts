import express from 'express';

import { chatToolsService } from '@/modules/chat-tools/chat-tools.service.js';
import { sessionTasksServices } from '@/modules/session-tasks/index.js';
import { chatWorktreeLocks, readSuffix, readUnitKey, recordSessionWorktreeClaim } from '@/modules/worktree-claims/index.js';
import type { SessionTaskStatus, SessionWorktreeCheckout } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readRequiredString(value: unknown, name: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) {
    throw new AppError(`${name} is required`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return parsed;
}

/**
 * Tool calls from the `cloudcli-chat` MCP server. Agents have no app login, so
 * this router checks the MCP server's shared token instead of a JWT.
 */
export const chatToolsMcpRoutes = express.Router();

chatToolsMcpRoutes.use((req, res, next) => {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '').trim());
  if (match?.[1] !== chatToolsService.getMcpToken()) {
    res.status(401).json({ success: false, error: { code: 'INVALID_MCP_TOKEN', message: 'Invalid chat tools MCP token.' } });
    return;
  }
  next();
});

chatToolsMcpRoutes.post('/tools/set_chat_name', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await chatToolsService.setChatName(readRequiredString(body.sessionId, 'sessionId'), readRequiredString(body.name, 'name'));
  res.json(createApiSuccessResponse(result));
}));

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

chatToolsMcpRoutes.post('/tools/start_chat', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await chatToolsService.startChat(readRequiredString(body.sessionId, 'sessionId'), {
    message: readRequiredString(body.message, 'message'),
    model: readRequiredString(body.model, 'model'),
    effort: readOptionalString(body.effort),
    projectPath: readOptionalString(body.projectPath),
    parentSessionId: readOptionalString(body.parentSessionId),
    topLevel: body.topLevel === true,
  });
  res.json(createApiSuccessResponse(result));
}));

chatToolsMcpRoutes.post('/tools/resume_chat', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await chatToolsService.resumeChat(readRequiredString(body.sessionId, 'sessionId'), {
    targetSessionId: readRequiredString(body.targetSessionId, 'targetSessionId'),
    message: readRequiredString(body.message, 'message'),
  });
  res.json(createApiSuccessResponse(result));
}));

chatToolsMcpRoutes.post('/tools/compact_chat', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await chatToolsService.compactChat(readRequiredString(body.sessionId, 'sessionId'), {
    instructions: readOptionalString(body.instructions),
    continueWith: readOptionalString(body.continueWith),
  });
  res.json(createApiSuccessResponse(result));
}));

chatToolsMcpRoutes.post('/tools/get_chat_threads', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json(createApiSuccessResponse(chatToolsService.getChatThreads(readRequiredString(body.sessionId, 'sessionId'))));
}));

chatToolsMcpRoutes.post('/tools/list_worktree_locks', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json(createApiSuccessResponse(await chatWorktreeLocks.list(readRequiredString(body.sessionId, 'sessionId'))));
}));

chatToolsMcpRoutes.post('/tools/release_worktree_locks', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sessionId = readRequiredString(body.sessionId, 'sessionId');
  if (body.all === true) {
    res.json(createApiSuccessResponse(await chatWorktreeLocks.release(sessionId, 'all')));
    return;
  }
  // '' is the main checkout's suffix, so only a missing suffix is an error.
  if (typeof body.suffix !== 'string') {
    throw new AppError('Pass unit and suffix to release one worktree, or all: true to release every lock', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  res.json(createApiSuccessResponse(await chatWorktreeLocks.release(sessionId, { unitKey: readRequiredString(body.unit, 'unit'), suffix: body.suffix.trim() })));
}));

function readCheckouts(value: unknown): SessionWorktreeCheckout[] {
  const entries = Array.isArray(value) ? value as Array<{ repo?: unknown; path?: unknown }> : [];
  if (entries.length === 0 || entries.some((entry) => typeof entry?.repo !== 'string' || typeof entry?.path !== 'string')) {
    throw new AppError('checkouts must list at least one { repo, path } pair', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return entries.map((entry) => ({ repo: entry.repo as string, path: entry.path as string }));
}

// Posted by the worktree-lock hook (~/.claude/hooks/worktree-lock.js) each time it grants a chat a worktree.
chatToolsMcpRoutes.post('/tools/worktree_claimed', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unitKey = readUnitKey(body.unit);
  recordSessionWorktreeClaim(readRequiredString(body.sessionId, 'sessionId'), {
    unitKey,
    unitName: readOptionalString(body.unitName) ?? unitKey,
    suffix: readSuffix(body.suffix, 'suffix'),
    checkouts: readCheckouts(body.checkouts),
  });
  res.json(createApiSuccessResponse({ recorded: true }));
}));

chatToolsMcpRoutes.post('/tools/list_mcp_servers', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json(createApiSuccessResponse(await chatToolsService.listMcpServers(readRequiredString(body.sessionId, 'sessionId'))));
}));

chatToolsMcpRoutes.post('/tools/reconnect_mcp_server', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await chatToolsService.reconnectMcpServer(readRequiredString(body.sessionId, 'sessionId'), readRequiredString(body.name, 'name'));
  res.json(createApiSuccessResponse(result));
}));

const TASK_STATUSES: SessionTaskStatus[] = ['pending', 'in_progress', 'completed'];

function readOptionalStatus(value: unknown): SessionTaskStatus | undefined {
  if (value === undefined) return undefined;
  if (!TASK_STATUSES.includes(value as SessionTaskStatus)) {
    throw new AppError(`status must be one of ${TASK_STATUSES.join(', ')}`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value as SessionTaskStatus;
}

// The chat's task list, kept in the CLI's own files: the same list TaskCreate/TaskUpdate keep and the sidebar shows.
// Agents the CLI gives no task tools (background subagents) keep it through these.
chatToolsMcpRoutes.post('/tools/task_list', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json(createApiSuccessResponse({ tasks: await sessionTasksServices.listTasks(readRequiredString(body.sessionId, 'sessionId')) }));
}));

chatToolsMcpRoutes.post('/tools/task_create', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const task = await sessionTasksServices.createTask(readRequiredString(body.sessionId, 'sessionId'), {
    subject: readRequiredString(body.subject, 'subject'),
    description: readRequiredString(body.description, 'description'),
    activeForm: readOptionalString(body.activeForm),
  });
  res.json(createApiSuccessResponse({ task }));
}));

chatToolsMcpRoutes.post('/tools/task_update', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const task = await sessionTasksServices.updateTask(readRequiredString(body.sessionId, 'sessionId'), readRequiredString(body.taskId, 'taskId'), {
    status: readOptionalStatus(body.status),
    subject: readOptionalString(body.subject),
    description: readOptionalString(body.description),
    activeForm: readOptionalString(body.activeForm),
  });
  res.json(createApiSuccessResponse({ task }));
}));
