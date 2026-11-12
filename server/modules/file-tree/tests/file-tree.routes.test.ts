import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileContentMatch, FileContentSearchOptions, FileTreeServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    listDirectoryChildren: unexpectedOperation,
    searchProjectFiles: unexpectedOperation,
    searchProjectFileContents: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false, depth: undefined }]]);
});

test('project files route requests gitignore filtering and a depth when given', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true&depth=2`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true, depth: 2 }]]);
});

test('children route forwards the directory paths and depth', async () => {
  const inputs: Parameters<FileTreeServices['listDirectoryChildren']>[] = [];
  const services = createFakeServices({
    listDirectoryChildren: async (...input) => {
      inputs.push(input);
      return { '/project/src': [] };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/project/src'], depth: 2, respectGitignore: true }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { '/project/src': [] });
  });

  assert.deepEqual(inputs, [['project-1', ['/project/src'], { respectGitignore: true, depth: 2 }]]);
});

test('children route rejects a request without directory paths', async () => {
  await withFileTreeServer(createFakeServices(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: 'src' }),
    });

    assert.equal(response.status, 400);
  });
});

test('search route forwards the query and caps the result limit', async () => {
  const inputs: Parameters<FileTreeServices['searchProjectFiles']>[] = [];
  const services = createFakeServices({
    searchProjectFiles: async (...input) => {
      inputs.push(input);
      return { results: [], truncated: false };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search?q=main&limit=99999&type=file`);

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', 'main', { limit: 1000, type: 'file' }]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

test('content search route streams matches as events and ends with done', async () => {
  const inputs: Array<[string, string, FileContentSearchOptions]> = [];
  const match: FileContentMatch = {
    path: '/project/src/main.ts',
    relativePath: 'src/main.ts',
    rootPath: '/project',
    rootIndex: 0,
    line: 3,
    character: 6,
    snippet: 'const needle = 1;',
    highlights: [{ start: 6, end: 12 }],
  };
  const services = createFakeServices({
    searchProjectFileContents: async (projectId, query, options, run) => {
      inputs.push([projectId, query, options]);
      run.onMatches([match]);
      return { truncated: true };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/search-content`
      + '?q=%20needle&regex=true&glob=*.%7Bcs,ts%7D&glob=!*.meta&roots=0,2&limit=99999',
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(
      await response.text(),
      `event: matches\ndata: ${JSON.stringify({ matches: [match] })}\n\nevent: done\ndata: {"truncated":true}\n\n`,
    );
  });

  assert.deepEqual(inputs, [['project-1', ' needle', {
    regex: true,
    globs: ['*.{cs,ts}', '!*.meta'],
    rootIndexes: [0, 2],
    limit: 1000,
  }]]);
});

test('content search route searches every folder literally when no options are given', async () => {
  const inputs: FileContentSearchOptions[] = [];
  const services = createFakeServices({
    searchProjectFileContents: async (_projectId, _query, options) => {
      inputs.push(options);
      return { truncated: false };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search-content?q=needle`);
    assert.equal(await response.text(), 'event: done\ndata: {"truncated":false}\n\n');
  });

  assert.deepEqual(inputs, [{ regex: false, globs: [], rootIndexes: undefined, limit: 500 }]);
});

test('content search route rejects a short query and a malformed folder list before searching', async () => {
  const services = createFakeServices();

  await withFileTreeServer(services, async (baseUrl) => {
    const shortQuery = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search-content?q=%20a%20`);
    assert.equal(shortQuery.status, 400);

    const badRoots = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search-content?q=needle&roots=0,x`);
    assert.equal(badRoots.status, 400);
  });
});

test('content search route reports a search failure as an error event', async () => {
  const services = createFakeServices({
    searchProjectFileContents: async () => {
      throw new AppError('unclosed group', { code: 'INVALID_CONTENT_SEARCH', statusCode: 400 });
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/search-content?q=a(&regex=true`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'event: error\ndata: {"error":"unclosed group"}\n\n');
  });
});

test('content search route aborts the search when the client disconnects', async () => {
  let searchSignal: AbortSignal | null = null;
  let reportSearchEnded: () => void = () => undefined;
  const searchEnded = new Promise<void>((resolve) => {
    reportSearchEnded = resolve;
  });
  const services = createFakeServices({
    searchProjectFileContents: (_projectId, _query, _options, run) => new Promise((resolve) => {
      searchSignal = run.signal;
      run.signal.addEventListener('abort', () => {
        resolve({ truncated: false });
        reportSearchEnded();
      });
      run.onMatches([]);
    }),
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const clientAbort = new AbortController();
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files/search-content?q=needle`,
      { signal: clientAbort.signal },
    );
    // The first event has arrived, so the search is running when the client leaves.
    await response.body?.getReader().read();
    clientAbort.abort();
    await searchEnded;
  });

  assert.equal((searchSignal as AbortSignal | null)?.aborted, true);
});
