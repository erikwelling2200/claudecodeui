import assert from 'node:assert/strict';

import { test } from 'vitest';

import { buildClaudeToolPermissionEntry } from '@/modules/chat/utils/chatPermissions';

// The rule "Allow & remember" saves lands in Claude's settings file, which the
// terminal and every synced machine obey too. It never reaches further than the
// call on screen: a known read-only command becomes a prefix rule, any other
// single command a rule for exactly that command, and anything else no rule.

const ruleFor = (command: string, toolName = 'Bash') => buildClaudeToolPermissionEntry(toolName, { command });

test('buildClaudeToolPermissionEntry derives a scoped git command from JSON input', () => {
  assert.equal(
    buildClaudeToolPermissionEntry('Bash', JSON.stringify({ command: 'git status' })),
    'Bash(git status:*)',
  );
});

test('buildClaudeToolPermissionEntry widens only known read-only commands into a prefix rule', () => {
  assert.equal(ruleFor('git log --oneline -5'), 'Bash(git log:*)');
  assert.equal(ruleFor('grep -rn foo src'), 'Bash(grep:*)');
  assert.equal(ruleFor('Get-ChildItem -Recurse', 'PowerShell'), 'PowerShell(Get-ChildItem:*)');
});

test('buildClaudeToolPermissionEntry gives anything else a rule for exactly that command', () => {
  // A list of programs to refuse could never keep up with the CLI's own
  // checks, so nothing outside the read-only list is ever widened.
  for (const command of [
    'npm test', 'npm install left-pad', 'python3.12 x.py', 'source x.sh', '. ./x.sh',
    'git config user.name x', 'git push --force', 'git -C /c/repo status', 'uv run x', 'cargo run',
  ]) {
    assert.equal(ruleFor(command), `Bash(${command})`, command);
  }
  for (const command of ['Add-Type -TypeDefinition $x', 'saps calc', '. .\\x.ps1']) {
    assert.equal(ruleFor(command, 'PowerShell'), `PowerShell(${command})`, command);
  }
});

test('buildClaudeToolPermissionEntry offers no rule for a line that is several commands or nests one', () => {
  for (const command of [
    'git status && rm -rf build', 'git log | head', 'git log > out.txt', 'echo $(whoami)', 'echo `whoami`',
    'ls; rm x', 'git log 2>&1',
  ]) {
    assert.equal(ruleFor(command), null, command);
  }
  assert.equal(ruleFor('Get-Date (New-Item pwned)', 'PowerShell'), null);
});

test('buildClaudeToolPermissionEntry names the command after a leading cd', () => {
  assert.equal(ruleFor('cd "C:/Unity/Operatie-OV" && git grep -n x'), 'Bash(git grep:*)');
  assert.equal(ruleFor('cd /c/repo; git log'), 'Bash(git log:*)');
  // What follows the cd is judged like any other command.
  assert.equal(ruleFor('cd x; rm -rf y'), 'Bash(rm -rf y)');
  assert.equal(ruleFor('cd x && git status && rm -rf y'), null);
});

test('buildClaudeToolPermissionEntry never turns an exact rule into a prefix rule', () => {
  assert.equal(ruleFor('foo :*'), null);
});

test('buildClaudeToolPermissionEntry offers no rule without a command to scope it to', () => {
  // A bare `Bash` would allow every command there is.
  assert.equal(buildClaudeToolPermissionEntry('Bash', '{"command":'), null);
  assert.equal(buildClaudeToolPermissionEntry('Bash', JSON.stringify({ command: false })), null);
});

test('buildClaudeToolPermissionEntry offers no rule for a tool that can do anything', () => {
  for (const toolName of ['Agent', 'Task', 'mcp__unity-vov__script-execute', 'mcp__blender__execute_blender_code']) {
    assert.equal(buildClaudeToolPermissionEntry(toolName, {}), null, toolName);
  }
  assert.equal(buildClaudeToolPermissionEntry('mcp__unity-vov__gameobject-find', {}), 'mcp__unity-vov__gameobject-find');
});
