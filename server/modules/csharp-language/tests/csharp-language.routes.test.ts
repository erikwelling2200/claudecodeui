import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createCsharpLanguageRouter } from '@/modules/csharp-language/csharp-language.routes.js';
import type { CsharpLanguageServices, CsharpPositionRequest } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const filePath = path.resolve('/repo/Player.cs');

function createFakeServices(overrides: Partial<CsharpLanguageServices> = {}): CsharpLanguageServices {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected csharp-language service call');
  };
  return { getStatus: unused, getSemanticTokens: unused, findDefinition: unused, findReferences: unused, ...overrides };
}

async function withServer(services: CsharpLanguageServices, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/csharp-language', createCsharpLanguageRouter(services));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/csharp-language`);
  } finally {
    server.close();
  }
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('POST /references passes the parsed position to the service', async () => {
  let received: CsharpPositionRequest | null = null;
  const services = createFakeServices({
    findReferences: async (request) => {
      received = request;
      return { status: { state: 'ready', solutionPath: null, message: null, semanticRevision: 0 }, result: [] };
    },
  });

  await withServer(services, async (baseUrl) => {
    const response = await post(`${baseUrl}/references`, { filePath, text: 'class Player {}', line: 0, character: 7 });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(received, { filePath, text: 'class Player {}', line: 0, character: 7 });
});

test('rejects a path that is not an absolute .cs file', async () => {
  await withServer(createFakeServices(), async (baseUrl) => {
    assert.equal((await post(`${baseUrl}/status`, { filePath: 'Player.cs' })).status, 400);
    assert.equal((await post(`${baseUrl}/status`, { filePath: path.resolve('/repo/notes.txt') })).status, 400);
  });
});

test('rejects a negative or fractional position', async () => {
  await withServer(createFakeServices(), async (baseUrl) => {
    assert.equal((await post(`${baseUrl}/definition`, { filePath, text: '', line: -1, character: 0 })).status, 400);
    assert.equal((await post(`${baseUrl}/definition`, { filePath, text: '', line: 0, character: 1.5 })).status, 400);
  });
});
