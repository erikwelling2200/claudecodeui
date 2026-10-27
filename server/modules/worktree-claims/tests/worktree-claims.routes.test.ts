import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createWorktreeClaimsRouter } from '@/modules/worktree-claims/worktree-claims.routes.js';
import type { WorktreeClaimsServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createFakeServices(overrides: Partial<WorktreeClaimsServices> = {}): WorktreeClaimsServices {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected worktree-claims service call');
  };
  return {
    getGroups: unused,
    saveGroups: unused,
    listWorktrees: unused,
    startCreate: unused,
    readJob: unused,
    listClaims: unused,
    release: unused,
    ...overrides,
  };
}

async function withServer(services: WorktreeClaimsServices, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/worktree-claims', createWorktreeClaimsRouter(services));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    res.status(status).json({ success: false, error: { message: error instanceof Error ? error.message : String(error) } });
  });
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/worktree-claims`);
  } finally {
    server.close();
  }
}

test('PUT /groups passes the parsed groups to the service', async () => {
  let received: unknown = null;
  const services = createFakeServices({
    saveGroups: async (projectId, groups) => {
      received = { projectId, groups };
      return { folders: [], groups };
    },
  });
  await withServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/groups`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'p1', groups: [{ name: 'g', repos: ['/a', '/b'] }] }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(received, { projectId: 'p1', groups: [{ name: 'g', repos: ['/a', '/b'] }] });
});

test('PUT /groups rejects a group without a repo list', async () => {
  await withServer(createFakeServices(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/groups`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'p1', groups: [{ name: 'g' }] }),
    });
    assert.equal(response.status, 400);
  });
});

test('POST /worktrees defaults "from" to the main checkout and requires a suffix', async () => {
  let received: unknown = null;
  const services = createFakeServices({
    startCreate: async (input) => {
      received = input;
      return { jobId: 'job-1' };
    },
  });
  await withServer(services, async (baseUrl) => {
    const post = (body: unknown) => fetch(`${baseUrl}/worktrees`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ project: 'p1', unit: 'g' })).status, 400);
    assert.equal((await post({ project: 'p1', unit: 'g', suffix: 'w2', from: '../../x' })).status, 400);
    const response = await post({ project: 'p1', unit: 'g', suffix: 'w2' });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(received, { projectId: 'p1', unit: 'g', suffix: 'w2', from: '' });
});

test('POST /release accepts the main checkout\'s empty suffix', async () => {
  let received: unknown = null;
  const services = createFakeServices({
    release: async (unitKey, suffix) => {
      received = { unitKey, suffix };
      return { released: [] };
    },
  });
  await withServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit: 'group:g', suffix: '' }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(received, { unitKey: 'group:g', suffix: '' });
});
