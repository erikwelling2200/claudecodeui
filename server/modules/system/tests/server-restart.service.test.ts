import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerRestartService } from '../server-restart.service.js';

function createDependencies(isSupervised: boolean) {
  const calls: string[] = [];
  const service = createServerRestartService({
    isSupervised,
    spawnReplacement: () => { calls.push('spawn'); },
    shutdown: async () => { calls.push('shutdown'); },
    logInfo: () => undefined,
  });
  return { service, calls };
}

test('under a supervisor the restart is only a shutdown', async () => {
  const { service, calls } = createDependencies(true);

  await service.restart();

  assert.deepEqual(calls, ['shutdown']);
  assert.deepEqual(service.describe(), { supervised: true });
});

test('without a supervisor the replacement is spawned before the shutdown', async () => {
  const { service, calls } = createDependencies(false);

  await service.restart();

  assert.deepEqual(calls, ['spawn', 'shutdown']);
  assert.deepEqual(service.describe(), { supervised: false });
});

test('a second restart request while one is under way does nothing', async () => {
  const { service, calls } = createDependencies(false);

  await service.restart();
  await service.restart();

  assert.deepEqual(calls, ['spawn', 'shutdown']);
});
