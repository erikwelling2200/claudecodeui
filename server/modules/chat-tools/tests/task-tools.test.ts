import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { chatToolsMcpRoutes, chatToolsService } from '@/modules/chat-tools/index.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const SESSION_ID = 'task-tools-caller';
// What the CLI reports as its own session id, and so the name of the task directory.
const PROVIDER_SESSION_ID = 'task-tools-provider-session';

/** Runs the MCP routes on an ephemeral port with a database holding the calling chat, the way the server mounts them. */
async function withMcpServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-tools-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Caller');
  sessionsDb.assignProviderSessionId(SESSION_ID, PROVIDER_SESSION_ID);

  const app = express().use(express.json()).use('/api/chat-tools-mcp', chatToolsMcpRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    res.status(status).json({ success: false, error: { message: error instanceof Error ? error.message : String(error) } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await fs.rm(tempDirectory, { recursive: true, force: true });
    await fs.rm(path.join(os.homedir(), '.claude', 'tasks', PROVIDER_SESSION_ID), { recursive: true, force: true });
  }
}

async function callTool(baseUrl: string, tool: string, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const response = await fetch(`${baseUrl}/api/chat-tools-mcp/tools/${tool}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${chatToolsService.getMcpToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, ...body }),
  });
  return { status: response.status, data: await response.json() };
}

test('the task tools keep the calling chat\'s task list under the CLI\'s own session id', async () => {
  await withMcpServer(async (baseUrl) => {
    const created = await callTool(baseUrl, 'task_create', { subject: 'Fix H1', description: 'The NameTag stays hidden', activeForm: 'Fixing H1' });
    assert.equal(created.status, 200);
    assert.equal(created.data.data.task.id, '1');
    assert.equal(created.data.data.task.status, 'pending');

    const updated = await callTool(baseUrl, 'task_update', { taskId: '1', status: 'in_progress' });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.data.task.status, 'in_progress');
    assert.equal(updated.data.data.task.activeForm, 'Fixing H1');

    const listed = await callTool(baseUrl, 'task_list', {});
    assert.deepEqual(listed.data.data.tasks.map((task: { id: string; status: string }) => [task.id, task.status]), [['1', 'in_progress']]);

    // The file lives where the CLI's TaskList and the sidebar read it.
    const file = path.join(os.homedir(), '.claude', 'tasks', PROVIDER_SESSION_ID, '1.json');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'in_progress');
  });
});

test('a bad status and an unknown task are refused with a clear error', async () => {
  await withMcpServer(async (baseUrl) => {
    const badStatus = await callTool(baseUrl, 'task_update', { taskId: '1', status: 'done' });
    assert.equal(badStatus.status, 400);
    assert.match(badStatus.data.error.message, /status must be one of/);

    const missing = await callTool(baseUrl, 'task_update', { taskId: '42', status: 'completed' });
    assert.equal(missing.status, 404);
    assert.match(missing.data.error.message, /#42/);
  });
});
