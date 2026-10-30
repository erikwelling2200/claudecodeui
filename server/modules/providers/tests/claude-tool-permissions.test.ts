import assert from 'node:assert/strict';
import test from 'node:test';

import { isToolCallAllowed, isToolCallDenied } from '@/modules/providers/list/claude/claude-tool-permissions.js';

const bash = (command: string) => ({ command });

test('a Bash prefix rule allows the command it names', () => {
  const entries = ['Bash(git checkout:*)'];
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git checkout main')), true);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git checkout')), true);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git checkout main 2>&1')), true);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git checkout -- a && git checkout b')), true);
});

test('a Bash prefix rule needs a word boundary', () => {
  assert.equal(isToolCallAllowed(['Bash(ls:*)'], 'Bash', bash('lsblk')), false);
});

test('a compound command is allowed only when every part is covered', () => {
  const entries = ['Bash(git checkout:*)'];
  for (const command of [
    'git checkout x; rm -rf ~',
    'git checkout x && rm -rf ~',
    'git checkout x || rm -rf ~',
    'git checkout x | sh',
    'git checkout x & rm -rf ~',
    'git checkout x\nrm -rf ~',
  ]) {
    assert.equal(isToolCallAllowed(entries, 'Bash', bash(command)), false, command);
  }
  assert.equal(
    isToolCallAllowed([...entries, 'Bash(tail:*)', 'Bash(git status:*)'], 'Bash', bash('git checkout x 2>&1 | tail -5; git status')),
    true,
  );
});

test('separators inside quotes do not split the command', () => {
  const entries = ['Bash(echo:*)'];
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('echo "a; rm -rf ~"')), true);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash("echo 'a && b | c'")), true);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('echo a\\; rm')), true);
});

test('command substitution is never auto-allowed', () => {
  const entries = ['Bash(echo:*)'];
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('echo $(rm -rf ~)')), false);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('echo "`rm -rf ~`"')), false);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('echo <(rm -rf ~)')), false);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash("echo '$(literal)'")), true);
});

test('an exact Bash rule matches only that command', () => {
  assert.equal(isToolCallAllowed(['Bash(git status)'], 'Bash', bash('git status')), true);
  assert.equal(isToolCallAllowed(['Bash(git status)'], 'Bash', bash('git status --short')), false);
});

test('a deny rule hits when any part matches', () => {
  const entries = ['Bash(rm:*)'];
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git status && rm -rf ~')), true);
  assert.equal(isToolCallDenied(entries, 'Bash', bash('echo $(ls) ; rm x')), true);
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git status')), false);
});

test('plain tool names match exactly', () => {
  assert.equal(isToolCallAllowed(['Read'], 'Read', { file_path: 'x' }), true);
  assert.equal(isToolCallAllowed(['Read'], 'Write', { file_path: 'x' }), false);
  assert.equal(isToolCallAllowed(['Bash'], 'Bash', bash('anything; at all')), true);
  assert.equal(isToolCallDenied(['Bash'], 'Bash', bash('ls')), true);
});

// Rules are written in the CLI's own format, which includes globs, so one
// entry can cover every Unity MCP server or any repository path.

test('a glob over tool names covers a whole MCP server', () => {
  const entries = ['mcp__unity-*__console-get-logs', 'mcp__unity-vov__gameobject-*'];
  assert.equal(isToolCallAllowed(entries, 'mcp__unity-comp__console-get-logs', {}), true);
  assert.equal(isToolCallAllowed(entries, 'mcp__unity-vov__gameobject-find', {}), true);
  assert.equal(isToolCallAllowed(entries, 'mcp__unity-vov__script-execute', {}), false);
  assert.equal(isToolCallDenied(['mcp__unity-*__script-execute'], 'mcp__unity-vov__script-execute', {}), true);
});

test('a wildcard inside a command rule stands for any run of characters', () => {
  const entries = ['Bash(git -C * commit:*)'];
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git -C C:/Unity/Operatie-OV commit -m x')), true);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git -C C:/Unity/Operatie-OV push')), false);
  // The prefix still has to end on a word boundary.
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git -C C:/Unity/Operatie-OV commitfoo')), false);
});

test('a wildcard rule is still checked per subcommand', () => {
  const entries = ['Bash(git -C * status:*)'];
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git -C C:/Unity/Operatie-OV status && rm -rf build')), false);
});

test('PowerShell rules work like Bash rules, and do not cross over', () => {
  assert.equal(isToolCallAllowed(['PowerShell(git status:*)'], 'PowerShell', bash('git status --short')), true);
  assert.equal(isToolCallAllowed(['PowerShell(git status:*)'], 'Bash', bash('git status')), false);
  assert.equal(isToolCallAllowed(['Bash(git status:*)'], 'PowerShell', bash('git status')), false);
  assert.equal(isToolCallAllowed(['PowerShell(Get-ChildItem:*)'], 'PowerShell', bash('Get-ChildItem -Recurse | Measure-Object')), false);
});

test('a command rule is never read as a glob over tool names', () => {
  // The `*` is part of the command pattern, so it says nothing about which
  // tools the entry covers.
  assert.equal(isToolCallAllowed(['Bash(git *:*)'], 'mcp__unity-vov__script-execute', {}), false);
  assert.equal(isToolCallAllowed(['Bash(*)'], 'Bash', bash('rm -rf ~')), true);
});
