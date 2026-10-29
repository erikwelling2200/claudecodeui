import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SessionTask, SessionTaskStatus } from '@/shared/types.js';

const TASK_STATUSES: SessionTaskStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * The CLI writes one JSON file per task under a directory named after the task
 * list, which for an ordinary chat is its own provider session id.
 */
function taskListDirectory(listId: string): string {
  return path.join(os.homedir(), '.claude', 'tasks', listId);
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
