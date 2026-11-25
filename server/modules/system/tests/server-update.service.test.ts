import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerUpdateService, needsClientBuild } from '../server-update.service.js';

type Scenario = {
  upstream?: boolean;
  heads?: [string, string];
  changedPaths?: string[];
  // The commit dist/ was built from; null when there is no build or no stamp.
  clientBuildCommit?: string | null;
  failing?: string;
};

function createScenario({ upstream = true, heads = ['aaa', 'bbb'], changedPaths = [], clientBuildCommit = 'aaa', failing }: Scenario) {
  const calls: string[] = [];
  let headReads = 0;
  const service = createServerUpdateService({
    runCommand: async (program, args) => {
      const command = `${program} ${args.join(' ')}`;
      calls.push(command);
      if (command === failing) return { exitCode: 1, output: `${command} failed\n` };
      if (command.startsWith('git rev-parse --abbrev-ref --symbolic-full-name')) {
        return upstream ? { exitCode: 0, output: 'origin/main\n' } : { exitCode: 128, output: 'fatal: no upstream\n' };
      }
      if (command === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, output: 'feature\n' };
      if (command === 'git rev-parse HEAD') return { exitCode: 0, output: `${heads[Math.min(headReads++, 1)]}\n` };
      if (command.startsWith('git diff --name-only unknown')) return { exitCode: 128, output: 'fatal: bad object unknown\n' };
      if (command.startsWith('git diff --name-only')) return { exitCode: 0, output: changedPaths.join('\n') };
      if (command.startsWith('git rev-list --count')) return { exitCode: 0, output: '3\n' };
      return { exitCode: 0, output: '' };
    },
    readClientBuildCommit: () => clientBuildCommit,
    logInfo: () => undefined,
  });
  return { service, calls };
}

test('a server-only change fast-forwards without installing or building', async () => {
  const { service, calls } = createScenario({ changedPaths: ['server/index.ts'] });

  const result = await service.update();

  assert.deepEqual(result, { success: true, previousHead: 'aaa', head: 'bbb', commits: 3, installed: false, built: false });
  assert.ok(calls.includes('git fetch --quiet'));
  assert.ok(calls.includes('git merge --ff-only @{u}'));
  assert.ok(!calls.some((call) => call.startsWith('npm')));
});

test('a frontend change rebuilds the client', async () => {
  const { service, calls } = createScenario({ changedPaths: ['src/App.tsx'] });

  const result = await service.update();

  assert.equal(result.success && result.built, true);
  assert.ok(calls.includes('npm run build:client'));
  assert.ok(!calls.includes('npm install'));
});

test('a dependency change installs and then rebuilds', async () => {
  const { service, calls } = createScenario({ changedPaths: ['package-lock.json'] });

  await service.update();

  assert.ok(calls.indexOf('npm install') < calls.indexOf('npm run build:client'));
  assert.ok(calls.includes('npm install'));
});

test('nothing new still succeeds, and builds only when dist is missing or unstamped', async () => {
  const upToDate = createScenario({ heads: ['aaa', 'aaa'] });
  assert.deepEqual(await upToDate.service.update(), { success: true, previousHead: 'aaa', head: 'aaa', commits: 0, installed: false, built: false });

  const noBuild = createScenario({ heads: ['aaa', 'aaa'], clientBuildCommit: null });
  await noBuild.service.update();
  assert.ok(noBuild.calls.includes('npm run build:client'));
});

test('a frontend change pulled by hand before the update still rebuilds', async () => {
  const { service, calls } = createScenario({ heads: ['aaa', 'aaa'], clientBuildCommit: 'old', changedPaths: ['src/App.tsx'] });

  const result = await service.update();

  assert.equal(result.success && result.built, true);
  assert.ok(calls.includes('git diff --name-only old aaa'));
});

test('a build stamped with a commit git does not know rebuilds', async () => {
  const { service, calls } = createScenario({ heads: ['aaa', 'aaa'], clientBuildCommit: 'unknown' });

  await service.update();

  assert.ok(calls.includes('npm run build:client'));
});

test('a branch without an upstream fails before fetching', async () => {
  const { service, calls } = createScenario({ upstream: false });

  const result = await service.update();

  assert.deepEqual(result, { success: false, step: 'branch', error: 'Branch feature has no upstream to update from.' });
  assert.ok(!calls.includes('git fetch --quiet'));
});

test('a diverged branch reports the merge step and runs nothing after it', async () => {
  const { service, calls } = createScenario({ failing: 'git merge --ff-only @{u}', changedPaths: ['src/App.tsx'] });

  const result = await service.update();

  assert.deepEqual(result, { success: false, step: 'merge', error: 'git merge --ff-only @{u} failed' });
  assert.ok(!calls.some((call) => call.startsWith('npm')));
});

test('client build inputs', () => {
  assert.equal(needsClientBuild('src/modules/sidebar/SidebarFooter.tsx'), true);
  assert.equal(needsClientBuild('public/sw.js'), true);
  assert.equal(needsClientBuild('index.html'), true);
  assert.equal(needsClientBuild('vite.config.js'), true);
  assert.equal(needsClientBuild('server/index.ts'), false);
  assert.equal(needsClientBuild('shared/types.ts'), false);
});
