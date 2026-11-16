import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUsageService } from '../usage.service.js';

const NOW = Date.parse('2026-10-29T14:00:00Z');

function createHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  return home;
}

function writeUsageCache(home: string, fetchedAt: number, sessionPercent: number): void {
  const body = {
    five_hour: { utilization: sessionPercent, resets_at: '2026-10-29T18:00:00Z' },
    seven_day: { utilization: 39, resets_at: '2026-11-01T01:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 0, resets_at: null },
  };
  fs.writeFileSync(path.join(home, '.claude', 'usage-cache.json'), JSON.stringify({ fetchedAt, body }));
}

function installScript(home: string, version: string): string {
  const dir = path.join(home, '.claude', 'plugins', 'cache', 'owner', 'plugin', version, 'skills', 'session-usage', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.js'), '');
  return path.join(dir, 'usage.js');
}

test('reads the session and weekly bars from the usage cache and skips caps the plan lacks', () => {
  const home = createHome();
  writeUsageCache(home, NOW - 60_000, 14);
  const service = createUsageService({ homeDirectory: home, runUsageScript: async () => undefined, tokenUsable: () => true, now: () => NOW });

  const usage = service.getUsage();

  assert.deepEqual(usage.limits.map((limit) => [limit.label, limit.percent]), [['Session', 14], ['Week', 39]]);
  assert.equal(usage.fetchedAt, NOW - 60_000);
});

test('prefers the ~/.claude.json reading when it is newer', () => {
  const home = createHome();
  writeUsageCache(home, NOW - 600_000, 14);
  const config = { cachedUsageUtilization: { fetchedAtMs: NOW - 1000, utilization: { limits: [{ kind: 'session', percent: 92, is_active: true }] } } };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(config));
  const service = createUsageService({ homeDirectory: home, runUsageScript: async () => undefined, tokenUsable: () => true, now: () => NOW });

  const [limit] = service.getUsage().limits;

  assert.equal(limit.percent, 92);
  assert.equal(limit.severity, 'critical');
  assert.equal(limit.active, true);
});

test('a stale reading starts one background refresh with the newest cached script', async () => {
  const home = createHome();
  writeUsageCache(home, NOW - 11 * 60_000, 14);
  installScript(home, '0.9.0');
  const newest = installScript(home, '0.10.0');
  const calls: string[] = [];
  const service = createUsageService({
    homeDirectory: home,
    runUsageScript: async (scriptPath) => { calls.push(scriptPath); writeUsageCache(home, NOW, 20); },
    tokenUsable: () => true,
    now: () => NOW,
  });

  service.getUsage();
  service.getUsage();
  const refreshed = await service.refreshUsage();

  assert.deepEqual(calls, [newest]);
  assert.equal(refreshed.limits[0].percent, 20);
});

test('refresh fails clearly when the session-usage skill is not installed', async () => {
  const service = createUsageService({ homeDirectory: createHome(), runUsageScript: async () => undefined, tokenUsable: () => true, now: () => NOW });

  await assert.rejects(service.refreshUsage(), /session-usage/);
});

test('a refresh that fetched nothing with a dead usage token asks for a sign-in', async () => {
  const home = createHome();
  writeUsageCache(home, NOW - 15 * 3_600_000, 14);
  installScript(home, '1.0.0');
  let usable = false;
  const service = createUsageService({ homeDirectory: home, runUsageScript: async () => undefined, tokenUsable: () => usable, now: () => NOW });

  assert.equal((await service.refreshUsage()).loginRequired, true);
  assert.equal(service.getUsage().loginRequired, true);

  usable = true;
  assert.equal((await service.refreshUsage()).loginRequired, false);
});

test('a refresh that fetched a new reading never asks for a sign-in, even without a dedicated token', async () => {
  const home = createHome();
  writeUsageCache(home, NOW - 15 * 3_600_000, 14);
  installScript(home, '1.0.0');
  const service = createUsageService({
    homeDirectory: home,
    runUsageScript: async () => writeUsageCache(home, NOW, 20),
    tokenUsable: () => false,
    now: () => NOW,
  });

  assert.equal((await service.refreshUsage()).loginRequired, false);
});
