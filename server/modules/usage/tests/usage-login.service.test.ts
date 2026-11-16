import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUsageLoginService } from '../usage-login.service.js';

const NOW = Date.parse('2026-11-16T10:00:00Z');

function createHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-login-'));
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'user:profile' }), { status: 200 });
}

test('completing a sign-in with the pasted code#state saves a token usage.js can use', async () => {
  const home = createHome();
  const requests: any[] = [];
  const service = createUsageLoginService({
    homeDirectory: home,
    fetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return tokenResponse(); },
    now: () => NOW,
  });
  assert.equal(service.tokenUsable(), false);

  const { url } = service.start();
  const state = new URL(url).searchParams.get('state');
  await service.complete(`the-code#${state}`);

  assert.equal(requests[0].code, 'the-code');
  assert.equal(requests[0].state, state);
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'usage-token.json'), 'utf8'));
  assert.deepEqual(saved, { accessToken: 'access', refreshToken: 'refresh', expiresAt: NOW + 3_600_000, scopes: 'user:profile' });
  assert.equal(service.tokenUsable(), true);
});

test('a code from another sign-in is refused before anything is exchanged', async () => {
  let called = false;
  const service = createUsageLoginService({ homeDirectory: createHome(), fetch: async () => { called = true; return tokenResponse(); }, now: () => NOW });

  service.start();

  await assert.rejects(service.complete('the-code#someone-elses-state'), /older sign-in/);
  assert.equal(called, false);
});

test('an expired token is not usable', () => {
  const home = createHome();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'usage-token.json'), JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 1 }));

  assert.equal(createUsageLoginService({ homeDirectory: home, fetch: globalThis.fetch, now: () => NOW }).tokenUsable(), false);
});
