import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SessionTask, SessionTaskStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const TASK_STATUSES: SessionTaskStatus[] = ['pending', 'in_progress', 'completed'];

// The CLI raises this past the highest task id it ever handed out, so a deleted task's id is never reused.
const HIGH_WATER_MARK_FILE = '.highwatermark';

/**
 * The CLI writes one JSON file per task under a directory named after the task
 * list, which for an ordinary chat is its own provider session id.
 */
function taskListDirectory(listId: string): string {
  return path.join(os.homedir(), '.claude', 'tasks', listId);
}

function taskFile(listId: string, taskId: string): string {
  return path.join(taskListDirectory(listId), `${taskId}.json`);
}

function readStatus(value: unknown): SessionTaskStatus {
  return TASK_STATUSES.includes(value as SessionTaskStatus) ? value as SessionTaskStatus : 'pending';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** One task file, or null when it is not a task this panel can show. */
function readTask(raw: unknown): SessionTask | null {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.subject !== 'string') return null;
  return {
    id: record.id,
    subject: record.subject,
    description: typeof record.description === 'string' ? record.description : '',
    activeForm: typeof record.activeForm === 'string' ? record.activeForm : null,
    status: readStatus(record.status),
    owner: typeof record.owner === 'string' ? record.owner : null,
    blockedBy: readStringArray(record.blockedBy),
  };
}

/** Task ids are numeric strings, so a plain numeric sort keeps creation order. */
function byId(left: SessionTask, right: SessionTask): number {
  const leftNumber = Number(left.id);
  const rightNumber = Number(right.id);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.id.localeCompare(right.id);
}

/**
 * Reads the task list the CLI keeps for `listId`.
 *
 * A chat that never created a task has no directory at all, which is the
 * ordinary case rather than a failure, so it reads as an empty list. A single
 * unreadable or half-written file is skipped instead of failing the request —
 * the CLI writes these while the panel polls them.
 */
export async function readSessionTasks(listId: string): Promise<SessionTask[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(taskListDirectory(listId));
  } catch {
    return [];
  }

  const tasks = await Promise.all(entries
    .filter((entry) => entry.endsWith('.json'))
    .map(async (entry) => {
      try {
        return readTask(JSON.parse(await fs.readFile(path.join(taskListDirectory(listId), entry), 'utf8')));
      } catch {
        return null;
      }
    }));

  return tasks.filter((task): task is SessionTask => task !== null).sort(byId);
}

/** The highest task id the list has handed out: the highest file id or the high-water mark, whichever is more. */
async function readHighestTaskId(listId: string): Promise<number> {
  const directory = taskListDirectory(listId);
  let highest = 0;
  try {
    highest = parseInt(await fs.readFile(path.join(directory, HIGH_WATER_MARK_FILE), 'utf8'), 10) || 0;
  } catch {
    // No mark yet: the file ids alone decide.
  }
  let entries: string[] = [];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return highest;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = parseInt(entry.slice(0, -'.json'.length), 10);
    if (Number.isFinite(id) && id > highest) highest = id;
  }
  return highest;
}

/** The task as the CLI writes it: its own schema requires the `blocks` and `blockedBy` arrays. */
function serializeTask(task: Record<string, unknown>): string {
  return JSON.stringify(task, null, 2);
}

export type SessionTaskInput = {
  subject: string;
  description: string;
  /** Present-continuous label shown while the task runs, e.g. "Running tests". */
  activeForm?: string;
};

export type SessionTaskUpdate = Partial<SessionTaskInput> & { status?: SessionTaskStatus };

/**
 * Adds a task to the list the CLI keeps for `listId`, in the CLI's own file
 * format, so the CLI's task tools and the sidebar see it as one of their own.
 *
 * The id is one past the highest id the list ever handed out, and the file is
 * created exclusively: when the CLI takes the same id first, the next one is
 * tried. The high-water mark is raised afterwards, the way the CLI does it.
 */
export async function createSessionTask(listId: string, input: SessionTaskInput): Promise<SessionTask> {
  const directory = taskListDirectory(listId);
  await fs.mkdir(directory, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = String(await readHighestTaskId(listId) + 1);
    const task = {
      id,
      subject: input.subject,
      description: input.description,
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      status: 'pending',
      blocks: [],
      blockedBy: [],
    };
    try {
      await fs.writeFile(taskFile(listId, id), serializeTask(task), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    await fs.writeFile(path.join(directory, HIGH_WATER_MARK_FILE), id, 'utf8');
    return readTask(task)!;
  }
  throw new AppError(`Could not find a free task id in list ${listId}`, { code: 'TASK_ID_CONFLICT', statusCode: 409 });
}

/** Changes the given fields of a task in the list the CLI keeps for `listId`; the rest of the file is kept as the CLI wrote it. */
export async function updateSessionTask(listId: string, taskId: string, update: SessionTaskUpdate): Promise<SessionTask> {
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(await fs.readFile(taskFile(listId, taskId), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError(`Task #${taskId} does not exist in this chat's task list`, { code: 'TASK_NOT_FOUND', statusCode: 404 });
    }
    throw error;
  }
  const next = {
    ...current,
    id: taskId,
    ...(update.subject !== undefined ? { subject: update.subject } : {}),
    ...(update.description !== undefined ? { description: update.description } : {}),
    ...(update.activeForm !== undefined ? { activeForm: update.activeForm } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
    blocks: readStringArray(current.blocks),
    blockedBy: readStringArray(current.blockedBy),
  };
  await fs.writeFile(taskFile(listId, taskId), serializeTask(next), 'utf8');
  const task = readTask(next);
  if (!task) throw new AppError(`Task #${taskId} is not a readable task`, { code: 'TASK_NOT_FOUND', statusCode: 404 });
  return task;
}
