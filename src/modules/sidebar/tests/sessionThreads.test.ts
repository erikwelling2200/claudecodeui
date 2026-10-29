import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { SessionWithProvider } from '@/shared/types';
import { groupSessionThreads } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/**
 * A thread folds under its parent only when that parent is among the rows
 * passed in; any other thread stays a top-level row so nothing goes missing.
 */

const makeSession = (id: string, lastActivity: string, parentSessionId: string | null = null): SessionWithProvider => ({
  id,
  summary: id,
  lastActivity,
  parentSessionId,
  __provider: 'claude',
});

const shape = (sessions: SessionWithProvider[]) =>
  groupSessionThreads(sessions).map(({ session, threads }) => [session.id, threads.map((thread) => thread.id)]);

test('a thread renders under its loaded parent', () => {
  assert.deepEqual(
    shape([
      makeSession('thread', '2026-10-29T12:00:00.000Z', 'parent'),
      makeSession('parent', '2026-10-29T10:00:00.000Z'),
    ]),
    [['parent', ['thread']]],
  );
});

test('a thread whose parent is not loaded stays top-level', () => {
  assert.deepEqual(
    shape([
      makeSession('orphan', '2026-10-29T12:00:00.000Z', 'not-loaded'),
      makeSession('other', '2026-10-29T10:00:00.000Z'),
    ]),
    [['orphan', []], ['other', []]],
  );
});

test('a parent sorts by its own or its newest thread activity, whichever is later', () => {
  assert.deepEqual(
    shape([
      makeSession('b', '2026-10-29T09:00:00.000Z'),
      makeSession('a-thread', '2026-10-29T12:00:00.000Z', 'a'),
      makeSession('c', '2026-10-29T11:00:00.000Z'),
      makeSession('a', '2026-10-29T08:00:00.000Z'),
    ]).map(([id]) => id),
    ['a', 'c', 'b'],
  );
});

test('threads are ordered newest activity first', () => {
  assert.deepEqual(
    shape([
      makeSession('parent', '2026-10-29T13:00:00.000Z'),
      makeSession('old', '2026-10-29T09:00:00.000Z', 'parent'),
      makeSession('new', '2026-10-29T12:00:00.000Z', 'parent'),
      makeSession('mid', '2026-10-29T10:00:00.000Z', 'parent'),
    ]),
    [['parent', ['new', 'mid', 'old']]],
  );
});

test('a thread of a thread stays top-level instead of nesting deeper', () => {
  assert.deepEqual(
    shape([
      makeSession('root', '2026-10-29T13:00:00.000Z'),
      makeSession('child', '2026-10-29T12:00:00.000Z', 'root'),
      makeSession('grandchild', '2026-10-29T11:00:00.000Z', 'child'),
    ]),
    [['root', ['child']], ['grandchild', []]],
  );
});
