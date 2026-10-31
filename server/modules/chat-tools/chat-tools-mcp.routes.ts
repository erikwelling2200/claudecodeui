import express from 'express';

import { chatToolsService } from '@/modules/chat-tools/chat-tools.service.js';
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
