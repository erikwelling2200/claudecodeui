import express from 'express';

import { chatToolsService } from '@/modules/chat-tools/chat-tools.service.js';
import type { ChatToolsSettings } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readSettingsChanges(body: unknown): Partial<ChatToolsSettings> {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const changes: Partial<ChatToolsSettings> = {};
  if (record.appendMode !== undefined) changes.appendMode = record.appendMode as ChatToolsSettings['appendMode'];
  if (record.appendText !== undefined) {
    if (typeof record.appendText !== 'string') {
      throw new AppError('appendText must be a string', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    changes.appendText = record.appendText;
  }
  if (record.renameToolEnabled !== undefined) {
    if (typeof record.renameToolEnabled !== 'boolean') {
      throw new AppError('renameToolEnabled must be a boolean', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    changes.renameToolEnabled = record.renameToolEnabled;
  }
  return changes;
}

/** Settings of the chat-tools module, behind the app's JWT authentication. */
export const chatToolsRoutes = express.Router();

chatToolsRoutes.get('/settings', asyncHandler(async (_req, res) => {
  res.json(createApiSuccessResponse(chatToolsService.getSettings()));
}));

chatToolsRoutes.put('/settings', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(await chatToolsService.updateSettings(readSettingsChanges(req.body))));
}));
