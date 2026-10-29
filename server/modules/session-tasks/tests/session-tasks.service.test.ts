import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { readSessionTasks } from '@/modules/session-tasks/services/session-tasks.service.js';

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
