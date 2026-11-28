import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CACHE_TTL_MS,
  KEEPALIVE_WINDOW_MS,
  PING_AFTER_MS,
  cacheKeepaliveService,
  closeCacheKeepalive,
  decideKeepalive,
  initializeCacheKeepalive,
  isCacheMiss,
  recordPing,
  runKeepaliveTick,
} from '@/modules/cache-keepalive/services/cache-keepalive.service.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

const SESSION_ID = 'keepalive-session';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'cache-keepalive-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Keepalive session');
    await runTest();
  } finally {
    closeCacheKeepalive();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const base = { now: 0, until: KEEPALIVE_WINDOW_MS, warmAt: 0, canPing: true, busy: false };

test('pings in the last minutes of the cache hour, not before', () => {
  assert.equal(decideKeepalive({ ...base, now: PING_AFTER_MS - 1 }), 'wait');
  assert.equal(decideKeepalive({ ...base, now: PING_AFTER_MS }), 'ping');
  assert.equal(decideKeepalive({ ...base, now: CACHE_TTL_MS - 1 }), 'ping');
});

test('does not ping a cache that has already expired, since that pays for the whole conversation', () => {
  assert.equal(decideKeepalive({ ...base, now: CACHE_TTL_MS }), 'wait');
});

test('waits while the chat is running, before its first turn, or without options to ping with', () => {
  assert.equal(decideKeepalive({ ...base, now: PING_AFTER_MS, busy: true }), 'wait');
  assert.equal(decideKeepalive({ ...base, now: PING_AFTER_MS, warmAt: undefined }), 'wait');
  assert.equal(decideKeepalive({ ...base, now: PING_AFTER_MS, canPing: false }), 'wait');
});

test('switches off once the window has run out, even mid-hour', () => {
  assert.equal(decideKeepalive({ ...base, now: PING_AFTER_MS, until: PING_AFTER_MS }), 'disable');
});

test('enabling sets a 20-hour window, and a tick past it switches keepalive off', async () => {
  await withIsolatedDatabase(async () => {
    initializeCacheKeepalive({ warmCache: async () => null }, { tickMs: 60 * 60_000 });
    const enabledAt = Date.now();
    const state = cacheKeepaliveService.setEnabled(SESSION_ID, true);
    assert.equal(state.enabled, true);
    const until = Date.parse(state.until!);
    assert.ok(Math.abs(until - (enabledAt + KEEPALIVE_WINDOW_MS)) < 5_000);
    assert.equal(state.nextPingAt, null, 'no turn has run, so there is nothing to ping with yet');

    await runKeepaliveTick(until - 1);
    assert.equal(cacheKeepaliveService.getState(SESSION_ID).enabled, true);
    await runKeepaliveTick(until);
    assert.equal(cacheKeepaliveService.getState(SESSION_ID).enabled, false);
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.cache_keepalive_until, null);
  });
});

test('a ping that writes more than it reads has missed the cache', () => {
  assert.equal(isCacheMiss({ cacheReadTokens: 482876, cacheWriteTokens: 1777, inputTokens: 3 }), false);
  assert.equal(isCacheMiss({ cacheReadTokens: 64732, cacheWriteTokens: 66283, inputTokens: 3 }), true);
  assert.equal(isCacheMiss({ cacheReadTokens: 0, cacheWriteTokens: 131018, inputTokens: 3 }), true);
});

test('a ping that misses the cache switches keepalive off and says why, until it is switched on again', async () => {
  await withIsolatedDatabase(async () => {
    initializeCacheKeepalive({ warmCache: async () => null }, { tickMs: 60 * 60_000 });
    cacheKeepaliveService.setEnabled(SESSION_ID, true);

    recordPing(SESSION_ID, '2026-11-28T01:00:00.000Z', { cacheReadTokens: 300000, cacheWriteTokens: 2000, inputTokens: 3 });
    assert.equal(cacheKeepaliveService.getState(SESSION_ID).enabled, true);
    assert.equal(cacheKeepaliveService.getState(SESSION_ID).stoppedByMiss, null);

    const miss = { cacheReadTokens: 64732, cacheWriteTokens: 66283, inputTokens: 3 };
    recordPing(SESSION_ID, '2026-11-28T02:00:00.000Z', miss);
    const stopped = cacheKeepaliveService.getState(SESSION_ID);
    assert.equal(stopped.enabled, false);
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.cache_keepalive_until, null);
    assert.deepEqual(stopped.stoppedByMiss, { at: '2026-11-28T02:00:00.000Z', ...miss });

    assert.equal(cacheKeepaliveService.setEnabled(SESSION_ID, true).stoppedByMiss, null);
    assert.equal(cacheKeepaliveService.setEnabled(SESSION_ID, false).stoppedByMiss, null);
  });
});
