import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { createSessionTask, readSessionTasks, updateSessionTask } from '@/modules/session-tasks/services/session-tasks.service.js';

const listIds: string[] = [];

/** Writes task files where the service looks for them: `~/.claude/tasks/<listId>`. */
async function writeTaskList(listId: string, files: Record<string, string>): Promise<void> {
  const directory = path.join(os.homedir(), '.claude', 'tasks', listId);
  await fs.mkdir(directory, { recursive: true });
  listIds.push(listId);
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(directory, name), contents, 'utf8');
  }
}

afterEach(async () => {
  for (const listId of listIds.splice(0)) {
    await fs.rm(path.join(os.homedir(), '.claude', 'tasks', listId), { recursive: true, force: true });
  }
});

describe('readSessionTasks', () => {
  test('a chat that never made a task reads as an empty list', async () => {
    assert.deepEqual(await readSessionTasks('session-that-has-no-directory'), []);
  });

  test('reads the task files in creation order', async () => {
    await writeTaskList('test-order', {
      '2.json': JSON.stringify({ id: '2', subject: 'Second', status: 'pending', blockedBy: ['1'] }),
      '10.json': JSON.stringify({ id: '10', subject: 'Tenth', status: 'pending' }),
      '1.json': JSON.stringify({ id: '1', subject: 'First', status: 'completed' }),
    });

    const tasks = await readSessionTasks('test-order');

    assert.deepEqual(tasks.map((task) => task.id), ['1', '2', '10']);
    assert.equal(tasks[0].status, 'completed');
    assert.deepEqual(tasks[1].blockedBy, ['1']);
  });

  test('skips a half-written file instead of failing the whole list', async () => {
    await writeTaskList('test-partial', {
      '1.json': JSON.stringify({ id: '1', subject: 'Readable', status: 'in_progress', activeForm: 'Reading' }),
      '2.json': '{"id": "2", "subje',
      'notes.txt': 'not a task file',
    });

    const tasks = await readSessionTasks('test-partial');

    assert.deepEqual(tasks.map((task) => task.subject), ['Readable']);
    assert.equal(tasks[0].activeForm, 'Reading');
  });

  test('an unknown status reads as pending rather than reaching the panel', async () => {
    await writeTaskList('test-status', {
      '1.json': JSON.stringify({ id: '1', subject: 'Odd', status: 'something-new' }),
    });

    assert.equal((await readSessionTasks('test-status'))[0].status, 'pending');
  });
});

describe('createSessionTask', () => {
  test('writes the task the way the CLI does, one past the highest id, and raises the high-water mark', async () => {
    await writeTaskList('test-create', {
      '3.json': JSON.stringify({ id: '3', subject: 'Third', status: 'completed', blocks: [], blockedBy: [] }),
    });

    const task = await createSessionTask('test-create', { subject: 'Fourth', description: 'Do the fourth thing', activeForm: 'Doing the fourth thing' });

    assert.equal(task.id, '4');
    assert.equal(task.status, 'pending');
    const directory = path.join(os.homedir(), '.claude', 'tasks', 'test-create');
    const written = JSON.parse(await fs.readFile(path.join(directory, '4.json'), 'utf8'));
    assert.deepEqual(written, { id: '4', subject: 'Fourth', description: 'Do the fourth thing', activeForm: 'Doing the fourth thing', status: 'pending', blocks: [], blockedBy: [] });
    assert.equal(await fs.readFile(path.join(directory, '.highwatermark'), 'utf8'), '4');
  });

  test('never reuses an id below the high-water mark, even when that task file is gone', async () => {
    await writeTaskList('test-highwater', { '.highwatermark': '7' });

    const task = await createSessionTask('test-highwater', { subject: 'Eighth', description: 'After a deleted task' });

    assert.equal(task.id, '8');
  });

  test('a chat without a list yet gets one, starting at 1', async () => {
    listIds.push('test-first');

    const task = await createSessionTask('test-first', { subject: 'First', description: 'The first task' });

    assert.equal(task.id, '1');
    assert.deepEqual((await readSessionTasks('test-first')).map((entry) => entry.subject), ['First']);
  });
});

describe('updateSessionTask', () => {
  test('changes the given fields and keeps the rest of the file', async () => {
    await writeTaskList('test-update', {
      '1.json': JSON.stringify({ id: '1', subject: 'Work', description: 'Do it', status: 'pending', blocks: ['2'], blockedBy: [], metadata: { kept: true } }),
    });

    const task = await updateSessionTask('test-update', '1', { status: 'in_progress', activeForm: 'Working' });

    assert.equal(task.status, 'in_progress');
    assert.equal(task.activeForm, 'Working');
    const written = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude', 'tasks', 'test-update', '1.json'), 'utf8'));
    assert.deepEqual(written, { id: '1', subject: 'Work', description: 'Do it', status: 'in_progress', blocks: ['2'], blockedBy: [], metadata: { kept: true }, activeForm: 'Working' });
  });

  test('an unknown task id is a not-found error', async () => {
    listIds.push('test-update-missing');

    await assert.rejects(updateSessionTask('test-update-missing', '9', { status: 'completed' }), (error: { statusCode?: number }) => error.statusCode === 404);
  });
});
