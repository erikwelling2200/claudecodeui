import assert from 'node:assert/strict';

import { test } from 'vitest';

import { buildClaudeToolPermissionEntry } from '@/modules/chat/utils/chatPermissions';

test('buildClaudeToolPermissionEntry derives a scoped git command from JSON input', () => {
  assert.equal(
    buildClaudeToolPermissionEntry('Bash', JSON.stringify({ command: 'git status' })),
    'Bash(git status:*)',
  );
});

// The rule is saved to Claude's settings file, which the terminal and every
// synced machine obey too, so a bare `Bash` — allowing every command — is never
// offered: with no command to scope it to, the call can be allowed once only.
test('buildClaudeToolPermissionEntry offers no rule for malformed JSON', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', '{"command":'), null);
});

test('buildClaudeToolPermissionEntry accepts an already parsed tool input', () => {
  // `Bash(npm:*)` would cover `npm install <anything>`, so the subcommand is kept.
  assert.equal(buildClaudeToolPermissionEntry('Bash', { command: 'npm test' }), 'Bash(npm test:*)');
});

test('buildClaudeToolPermissionEntry offers no rule for JSON with no string command', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', JSON.stringify({ command: false })), null);
});

test('buildClaudeToolPermissionEntry scopes a PowerShell rule like a Bash one', () => {
  assert.equal(buildClaudeToolPermissionEntry('PowerShell', { command: 'Get-ChildItem -Recurse' }), 'PowerShell(Get-ChildItem:*)');
  assert.equal(buildClaudeToolPermissionEntry('PowerShell', { command: 'git status' }), 'PowerShell(git status:*)');
});

test('buildClaudeToolPermissionEntry offers no rule for a program that runs other programs', () => {
  // `Bash(python:*)` would cover `python -c "<anything>"`.
  for (const command of ['python -c "print(1)"', 'node script.js', 'bash -c "ls"', 'sudo ls', 'xargs rm']) {
    assert.equal(buildClaudeToolPermissionEntry('Bash', { command }), null, command);
  }
  assert.equal(buildClaudeToolPermissionEntry('PowerShell', { command: 'Invoke-Expression $x' }), null);
});

test('buildClaudeToolPermissionEntry never names a flag where a subcommand belongs', () => {
  // `Bash(git -C:*)` let `git -C . -c core.fsmonitor=<anything> status` run on the real CLI.
  for (const command of ['git -C /c/repo status', 'git -c core.fsmonitor=x status', 'git --git-dir=x log']) {
    assert.equal(buildClaudeToolPermissionEntry('Bash', { command }), null, command);
  }
});

test('buildClaudeToolPermissionEntry catches a program runner however it is spelled', () => {
  for (const command of [
    '/usr/bin/python3 x.py', 'python.exe x.py', 'C:\\Tools\\pwsh.exe -c x', 'FOO=1 python x.py',
    'npx some-package', 'timeout 9 rm -rf x', 'nohup ./run.sh', 'wsl rm -rf ~',
  ]) {
    assert.equal(buildClaudeToolPermissionEntry('Bash', { command }), null, command);
  }
});

test('buildClaudeToolPermissionEntry keeps a package-manager rule to one script', () => {
  assert.equal(buildClaudeToolPermissionEntry('Bash', { command: 'npm run lint -- --fix' }), 'Bash(npm run lint:*)');
  for (const command of ['npm install left-pad', 'npm exec x', 'pnpm dlx x', 'yarn add x', 'npm run']) {
    assert.equal(buildClaudeToolPermissionEntry('Bash', { command }), null, command);
  }
});

test('buildClaudeToolPermissionEntry names the command after a leading cd', () => {
  assert.equal(
    buildClaudeToolPermissionEntry('Bash', { command: 'cd "C:/Unity/Operatie-OV" && git grep -n x' }),
    'Bash(git grep:*)',
  );
  assert.equal(buildClaudeToolPermissionEntry('Bash', { command: 'cd /c/repo; git log' }), 'Bash(git log:*)');
});

test('buildClaudeToolPermissionEntry offers no rule for a tool that can do anything', () => {
  for (const toolName of ['Agent', 'Task', 'mcp__unity-vov__script-execute', 'mcp__blender__execute_blender_code']) {
    assert.equal(buildClaudeToolPermissionEntry(toolName, {}), null, toolName);
  }
  assert.equal(buildClaudeToolPermissionEntry('mcp__unity-vov__gameobject-find', {}), 'mcp__unity-vov__gameobject-find');
});
