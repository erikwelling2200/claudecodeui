import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  FileTreeLogger,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type FileTreeUploadLimits = {
  maximumFileSizeMegabytes: number;
  maximumFileCount: number;
};

type UploadedRequest = Request & {
  files?: Express.Multer.File[];
};

function readBody(request: Request): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null
    ? request.body as Record<string, unknown>
    : {};
}

function readRequiredString(value: unknown, fieldName: string, message?: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(message ?? `${fieldName} is required`, {
      code: 'INVALID_FILE_TREE_REQUEST',
      statusCode: 400,
    });
  }
  return value;
}

const MAXIMUM_SEARCH_RESULTS = 1000;
const MAXIMUM_CONTENT_SEARCH_MATCHES = 1000;
const DEFAULT_CONTENT_SEARCH_MATCHES = 500;
const MINIMUM_CONTENT_SEARCH_QUERY_LENGTH = 2;
const MAXIMUM_CONTENT_SEARCH_QUERY_LENGTH = 1000;
const MAXIMUM_CONTENT_SEARCH_GLOBS = 20;

function createContentSearchRequestError(message: string): AppError {
  return new AppError(message, { code: 'INVALID_CONTENT_SEARCH_REQUEST', statusCode: 400 });
}

// Leading and trailing spaces are part of what is searched for, so the query is measured trimmed but passed on as typed.
function readContentSearchQuery(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < MINIMUM_CONTENT_SEARCH_QUERY_LENGTH) {
    throw createContentSearchRequestError(`Search for at least ${MINIMUM_CONTENT_SEARCH_QUERY_LENGTH} characters`);
  }
  if (value.length > MAXIMUM_CONTENT_SEARCH_QUERY_LENGTH) {
    throw createContentSearchRequestError('Search query is too long');
  }
  return value;
}

// A glob can hold commas (`*.{cs,ts}`), so each one is its own `glob` parameter.
function readContentSearchGlobs(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const globs = values
    .filter((entry): entry is string => typeof entry === 'string')
    .map((glob) => glob.trim())
    .filter(Boolean);
  if (globs.length > MAXIMUM_CONTENT_SEARCH_GLOBS) {
    throw createContentSearchRequestError(`At most ${MAXIMUM_CONTENT_SEARCH_GLOBS} file filters are allowed`);
  }
  return globs;
}

// Comma-separated positions in the project's folder list; absent means every folder.
function readContentSearchRootIndexes(value: unknown): number[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.split(',').filter(Boolean).map((entry) => {
    if (!/^\d+$/.test(entry)) {
      throw createContentSearchRequestError('roots must be a list of folder positions');
    }
    return Number.parseInt(entry, 10);
  });
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// Accepts a JSON number or a query-string digit run; anything else is absent.
function readOptionalInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function readProjectId(request: Request): string {
  return readRequiredString(request.params.projectId, 'projectId');
}

function readEntryType(value: unknown): 'file' | 'directory' {
  if (value !== 'file' && value !== 'directory') {
    throw new AppError('Type must be "file" or "directory"', {
      code: 'INVALID_FILE_TREE_ENTRY_TYPE',
      statusCode: 400,
    });
  }
  return value;
}

function readRelativePaths(value: unknown): string[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function readRequestedFileCount(value: unknown, fallbackCount: number): number {
  const parsedCount = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : fallbackCount;
}

function normalizeUploadedFiles(request: UploadedRequest): FileTreeUploadedFile[] {
  return Array.isArray(request.files)
    ? request.files.map((file) => ({
        originalName: file.originalname,
        temporaryPath: file.path,
        size: file.size,
        mimeType: file.mimetype,
      }))
    : [];
}

function createRouteHandler(
  operation: (request: Request, response: Response) => void | Promise<void>,
  logger: FileTreeLogger,
): RequestHandler {
  return async (request, response) => {
    try {
      await operation(request, response);
    } catch (error) {
      if (error instanceof AppError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('File Tree API error', error);
      response.status(500).json({ error: message });
    }
  };
}

/**
 * Builds the File Tree HTTP router for the server composition root and route tests.
 * Paths are relative to the module's `/api/file-tree` mount point so the
 * complete HTTP surface has one feature-owned namespace.
 */
export function createFileTreeRouter(
  services: FileTreeServices,
  uploadFilesMiddleware: RequestHandler,
  uploadLimits: FileTreeUploadLimits,
  logger: FileTreeLogger,
): express.Router {
  const router = express.Router();

  router.get('/browse-filesystem', createRouteHandler(async (request, response) => {
    response.json(await services.browseWorkspace(readOptionalString(request.query.path)));
  }, logger));

  router.post('/create-folder', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const folderPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.createWorkspaceFolder(folderPath));
  }, logger));

  router.get('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.filePath, 'filePath', 'Invalid file path');
    response.json(await services.readTextFile(readProjectId(request), filePath));
  }, logger));

  router.get('/projects/:projectId/files/content', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.path, 'path', 'Invalid file path');
    const file = await services.openFile(readProjectId(request), filePath);
    response.setHeader('Content-Type', file.contentType);
    file.stream.pipe(response);
    file.stream.on('error', (error) => {
      logger.error('Error streaming File Tree content', error);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Error reading file' });
      }
    });
  }, logger));

  router.put('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.filePath, 'filePath', 'Invalid file path');
    if (body.content === undefined) {
      throw new AppError('Content is required', {
        code: 'FILE_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }
    if (typeof body.content !== 'string') {
      throw new AppError('Content must be a string', {
        code: 'INVALID_FILE_CONTENT',
        statusCode: 400,
      });
    }
    response.json(await services.saveTextFile(readProjectId(request), filePath, body.content));
  }, logger));

  router.get('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    response.json(await services.listProjectFiles(readProjectId(request), {
      respectGitignore: request.query.respectGitignore === 'true',
      depth: readOptionalInteger(request.query.depth),
    }));
  }, logger));

  router.post('/projects/:projectId/files/children', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!Array.isArray(body.paths) || body.paths.some((value) => typeof value !== 'string' || !value)) {
      throw new AppError('paths must be a list of directory paths', {
        code: 'INVALID_DIRECTORY_PATHS',
        statusCode: 400,
      });
    }
    response.json(await services.listDirectoryChildren(readProjectId(request), body.paths as string[], {
      respectGitignore: body.respectGitignore === true,
      depth: readOptionalInteger(body.depth) ?? 1,
    }));
  }, logger));

  router.get('/projects/:projectId/files/search', createRouteHandler(async (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q : '';
    const limit = Math.min(MAXIMUM_SEARCH_RESULTS, Math.max(1, readOptionalInteger(request.query.limit) ?? 100));
    response.json(await services.searchProjectFiles(readProjectId(request), query, {
      limit,
      type: request.query.type === 'file' ? 'file' : 'any',
    }));
  }, logger));

  // Server-sent events: `matches` while the search runs, then one `done` or `error`.
  router.get('/projects/:projectId/files/search-content', createRouteHandler(async (request, response) => {
    const projectId = readProjectId(request);
    const query = readContentSearchQuery(request.query.q);
    const options = {
      regex: request.query.regex === 'true',
      globs: readContentSearchGlobs(request.query.glob),
      rootIndexes: readContentSearchRootIndexes(request.query.roots),
      limit: Math.min(
        MAXIMUM_CONTENT_SEARCH_MATCHES,
        Math.max(1, readOptionalInteger(request.query.limit) ?? DEFAULT_CONTENT_SEARCH_MATCHES),
      ),
    };

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abortController = new AbortController();
    // The response, not the request: a GET's request stream can close before the client goes away.
    response.on('close', () => {
      if (!response.writableEnded) {
        abortController.abort();
      }
    });
    const sendEvent = (eventName: string, data: unknown): void => {
      if (!abortController.signal.aborted) {
        response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      const { truncated } = await services.searchProjectFileContents(projectId, query, options, {
        signal: abortController.signal,
        onMatches: (matches) => sendEvent('matches', { matches }),
      });
      sendEvent('done', { truncated });
    } catch (error) {
      // The headers are out, so a failure travels as an event instead of a status code.
      if (!(error instanceof AppError)) {
        logger.error('File Tree content search error', error);
      }
      sendEvent('error', { error: error instanceof AppError ? error.message : 'Search failed' });
    } finally {
      response.end();
    }
  }, logger));

  router.post('/projects/:projectId/files/create', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.name || !body.type) {
      throw new AppError('Name and type are required', {
        code: 'FILE_TREE_ENTRY_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    const name = readRequiredString(body.name, 'name');
    const type = readEntryType(body.type);
    const parentPath = readOptionalString(body.path) ?? '';
    response.json(await services.createEntry({
      projectId: readProjectId(request),
      parentPath,
      type,
      name,
    }));
  }, logger));

  router.put('/projects/:projectId/files/rename', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.oldPath || !body.newName) {
      throw new AppError('oldPath and newName are required', {
        code: 'FILE_TREE_RENAME_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    response.json(await services.renameEntry({
      projectId: readProjectId(request),
      oldPath: readRequiredString(body.oldPath, 'oldPath'),
      newName: readRequiredString(body.newName, 'newName'),
    }));
  }, logger));

  router.delete('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const targetPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.deleteEntry({
      projectId: readProjectId(request),
      targetPath,
    }));
  }, logger));

  const uploadHandler = createRouteHandler(async (request, response) => {
    const uploadedRequest = request as UploadedRequest;
    const body = readBody(request);
    const files = normalizeUploadedFiles(uploadedRequest);
    response.json(await services.storeUploadedFiles({
      projectId: readProjectId(request),
      targetPath: readOptionalString(body.targetPath) ?? '',
      relativePaths: readRelativePaths(body.relativePaths),
      requestedFileCount: readRequestedFileCount(body.requestedFileCount, files.length),
      files,
    }));
  }, logger);

  router.post(
    '/projects/:projectId/files/upload',
    (request: Request, response: Response, next: NextFunction) => {
      uploadFilesMiddleware(request, response, (error?: unknown) => {
        if (!error) {
          void uploadHandler(request, response, next);
          return;
        }

        const errorCode = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null;
        if (errorCode === 'LIMIT_FILE_SIZE') {
          response.status(400).json({
            error: `File too large. Maximum size is ${uploadLimits.maximumFileSizeMegabytes}MB.`,
          });
          return;
        }
        if (errorCode === 'LIMIT_FILE_COUNT') {
          response.status(400).json({
            error: `Too many files. Maximum is ${uploadLimits.maximumFileCount} files.`,
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      });
    },
  );

  return router;
}
