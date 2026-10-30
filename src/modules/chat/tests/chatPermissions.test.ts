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
  assert.equal(buildClaudeToolPermissionEntry('Bash', { command: 'npm test' }), 'Bash(npm:*)');
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
