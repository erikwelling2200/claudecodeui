import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { applyAppBadge, countSessionsNeedingUser } from '@/modules/project-workspace/utils/appBadge';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('counts waiting and unread sessions once each', () => {
  const count = countSessionsNeedingUser(new Set(['a', 'b']), new Set(['b', 'c']), new Set());
  assert.equal(count, 3);
});

test('leaves out unread sessions that are still busy, but not waiting ones', () => {
  const count = countSessionsNeedingUser(new Set(['a']), new Set(['b', 'c']), new Set(['a', 'b']));
  assert.equal(count, 2);
});

test('sets the badge for a positive count and clears it at zero', () => {
  const setAppBadge = vi.fn(() => Promise.resolve());
  const clearAppBadge = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { setAppBadge, clearAppBadge });

  applyAppBadge(4);
  applyAppBadge(0);

  assert.deepEqual(setAppBadge.mock.calls, [[4]]);
  assert.equal(clearAppBadge.mock.calls.length, 1);
});

test('does nothing where the Badging API is missing', () => {
  vi.stubGlobal('navigator', {});
  assert.doesNotThrow(() => applyAppBadge(2));
});
