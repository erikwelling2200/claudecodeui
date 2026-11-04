import path from 'node:path';

import express from 'express';

import type { CsharpDocumentRequest, CsharpLanguageServices, CsharpPositionRequest } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readBody(request: express.Request): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {};
}

function readCsharpFilePath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !value.toLowerCase().endsWith('.cs')) {
    throw new AppError('filePath must be the absolute path of a .cs file', { code: 'INVALID_CSHARP_REQUEST', statusCode: 400 });
  }
  return value;
}

function readDocument(body: Record<string, unknown>): CsharpDocumentRequest {
  if (typeof body.text !== 'string') {
    throw new AppError('text must be the editor content of the file', { code: 'INVALID_CSHARP_REQUEST', statusCode: 400 });
  }
  return { filePath: readCsharpFilePath(body.filePath), text: body.text };
}

function readPosition(body: Record<string, unknown>): CsharpPositionRequest {
  const { line, character } = body;
  if (!Number.isInteger(line) || !Number.isInteger(character) || (line as number) < 0 || (character as number) < 0) {
    throw new AppError('line and character must be 0-based integers', { code: 'INVALID_CSHARP_REQUEST', statusCode: 400 });
  }
  return { ...readDocument(body), line: line as number, character: character as number };
}

/**
 * Builds the C# language HTTP router for the server entrypoint and route tests: language server status,
 * semantic tokens, go to definition and find references for one `.cs` file.
 */
export function createCsharpLanguageRouter(services: CsharpLanguageServices): express.Router {
  const router = express.Router();

  router.post('/status', asyncHandler(async (request, response) => {
    response.json(createApiSuccessResponse(await services.getStatus(readCsharpFilePath(readBody(request).filePath))));
  }));

  router.post('/semantic-tokens', asyncHandler(async (request, response) => {
    response.json(createApiSuccessResponse(await services.getSemanticTokens(readDocument(readBody(request)))));
  }));

  router.post('/definition', asyncHandler(async (request, response) => {
    response.json(createApiSuccessResponse(await services.findDefinition(readPosition(readBody(request)))));
  }));

  router.post('/references', asyncHandler(async (request, response) => {
    response.json(createApiSuccessResponse(await services.findReferences(readPosition(readBody(request)))));
  }));

  return router;
}
