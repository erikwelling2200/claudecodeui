import assert from 'node:assert/strict';
import test from 'node:test';

import { isToolCallDenied } from '@/modules/providers/list/claude/claude-tool-permissions.js';

const bash = (command: string) => ({ command });

// Only a deny list is matched in the app. The CLI holds the same rules and
// judges every call against them first, with per-command checks no prefix rule
// can express, so an app-side allow could only add calls it chose to refuse.

test('a deny rule hits when any part matches', () => {
  const entries = ['Bash(rm:*)'];
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git status && rm -rf ~')), true);
  assert.equal(isToolCallDenied(entries, 'Bash', bash('echo $(ls) ; rm x')), true);
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git status')), false);
});

test('a deny prefix rule needs a word boundary', () => {
  assert.equal(isToolCallDenied(['Bash(rm:*)'], 'Bash', bash('rmdir x')), false);
});

test('separators inside quotes do not split the command', () => {
  assert.equal(isToolCallDenied(['Bash(rm:*)'], 'Bash', bash('echo "a; rm -rf ~"')), false);
  assert.equal(isToolCallDenied(['Bash(rm:*)'], 'Bash', bash("echo 'a && rm b'")), false);
});

test('a redirection ampersand is not a separator', () => {
  assert.equal(isToolCallDenied(['Bash(rm:*)'], 'Bash', bash('git log 2>&1')), false);
  assert.equal(isToolCallDenied(['Bash(rm:*)'], 'Bash', bash('git log 2>&1 & rm x')), true);
});

test('an exact deny rule matches only that command', () => {
  assert.equal(isToolCallDenied(['Bash(git push)'], 'Bash', bash('git push')), true);
  assert.equal(isToolCallDenied(['Bash(git push)'], 'Bash', bash('git push --force')), false);
});

test('plain tool names match exactly', () => {
  assert.equal(isToolCallDenied(['Write'], 'Write', { file_path: 'x' }), true);
  assert.equal(isToolCallDenied(['Write'], 'Edit', { file_path: 'x' }), false);
  assert.equal(isToolCallDenied(['Bash'], 'Bash', bash('ls')), true);
});

test('a deny list takes the wide glob shapes the CLI also denies on', () => {
  assert.equal(isToolCallDenied(['*'], 'Bash', bash('rm -rf /')), true);
  assert.equal(isToolCallDenied(['mcp__*'], 'mcp__unity-vov__script-execute', {}), true);
  assert.equal(isToolCallDenied(['mcp__unity-*__script-execute'], 'mcp__unity-comp__script-execute', {}), true);
  assert.equal(isToolCallDenied(['mcp__*'], 'Bash', bash('ls')), false);
});

test('a deny rule may use a wildcard inside a command, still part by part', () => {
  const entries = ['Bash(git -C * push:*)'];
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git -C C:/Unity/Operatie-OV push --force')), true);
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git status && git -C . push')), true);
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git -C . pushfoo')), false, 'still on a word boundary');
  assert.equal(isToolCallDenied(['Bash(*)'], 'Bash', bash('rm -rf ~')), true);
});

test('a command rule is never read as a glob over tool names', () => {
  assert.equal(isToolCallDenied(['Bash(git *:*)'], 'mcp__unity-vov__script-execute', {}), false);
});

test('an unterminated quote cannot hide a command from a deny rule', () => {
  // The apostrophe opens a quote that never closes, so the `;` does not split.
  assert.equal(isToolCallDenied(['Bash(rm:*)'], 'Bash', bash("echo don't; rm -rf ~/x")), true);
});

test('PowerShell rules work like Bash rules, and do not cross over', () => {
  assert.equal(isToolCallDenied(['PowerShell(Remove-Item:*)'], 'PowerShell', bash('Remove-Item -Recurse x')), true);
  assert.equal(isToolCallDenied(['PowerShell(Remove-Item:*)'], 'Bash', bash('Remove-Item x')), false);
  assert.equal(isToolCallDenied(['Bash(rm:*)'], 'PowerShell', bash('rm x')), false);
});

test('a Windows path separator does not escape a separator in PowerShell', () => {
  assert.equal(isToolCallDenied(['PowerShell(Remove-Item:*)'], 'PowerShell', bash('Get-Item C:\\x; Remove-Item C:\\y')), true);
});
