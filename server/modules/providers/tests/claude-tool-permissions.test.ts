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

// Rules are written in the CLI's own format. An allow match is never wider
// than the CLI's: the CLI judges a call against the same rules before the app
// sees it, so all an app-side allow can add is a call the CLI chose to refuse.

test('a tool-name glob covers one MCP server, in the only shape the CLI honours', () => {
  const entries = ['mcp__unity-vov__gameobject-*'];
  assert.equal(isToolCallAllowed(entries, 'mcp__unity-vov__gameobject-find', {}), true);
  assert.equal(isToolCallAllowed(entries, 'mcp__unity-vov__script-execute', {}), false);
  assert.equal(isToolCallAllowed(entries, 'mcp__unity-comp__gameobject-find', {}), false);
});

test('glob shapes the CLI ignores grant nothing here either', () => {
  // Honouring these would hand the UI a wider rule than the same entry gives
  // the user's terminal — `*` would be bypassPermissions by the back door.
  assert.equal(isToolCallAllowed(['*'], 'Bash', bash('rm -rf /')), false);
  assert.equal(isToolCallAllowed(['mcp__*'], 'mcp__unity-vov__script-execute', {}), false);
  assert.equal(isToolCallAllowed(['mcp__unity-*__console-get-logs'], 'mcp__unity-comp__console-get-logs', {}), false);
  assert.equal(isToolCallAllowed(['mcp__*__console-get-logs'], 'mcp__unity-vov__console-get-logs', {}), false);
});

test('the CLI reads no wildcard inside a command, so an allow rule does not either', () => {
  // Measured: the CLI refused a plain `git -C . status` under this rule. Here a
  // `*` would also swallow flags, `-c core.fsmonitor=<command>` included.
  const entries = ['Bash(git -C * status:*)'];
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git -C C:/Unity/Operatie-OV status')), false);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash("git -C . -c core.fsmonitor='touch pwned' status")), false);
});

test('a deny rule may use a wildcard inside a command, still part by part', () => {
  const entries = ['Bash(git -C * push:*)'];
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git -C C:/Unity/Operatie-OV push --force')), true);
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git status && git -C . push')), true);
  assert.equal(isToolCallDenied(entries, 'Bash', bash('git -C . pushfoo')), false, 'still on a word boundary');
});

test('no allow rule covers a command that writes to a file', () => {
  const entries = ['Bash(echo:*)', 'Bash(git log:*)', 'PowerShell(Get-Content:*)'];
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('echo pwned >> ~/.bashrc')), false);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git log > out.txt')), false);
  assert.equal(isToolCallAllowed(entries, 'PowerShell', bash('Get-Content a > b')), false);
  // Discarding output or joining streams writes nothing anywhere.
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git log 2>/dev/null')), true);
  assert.equal(isToolCallAllowed(entries, 'Bash', bash('git log 2>&1')), true);
  assert.equal(isToolCallAllowed(entries, 'PowerShell', bash('Get-Content a 2> $null')), true);
});

test('a PowerShell subexpression is never vouched for by the command around it', () => {
  const entries = ['PowerShell(git status:*)', 'PowerShell(Get-ChildItem:*)', 'PowerShell(Get-Date:*)'];
  assert.equal(isToolCallAllowed(entries, 'PowerShell', bash('git status (Remove-Item x)')), false);
  assert.equal(isToolCallAllowed(entries, 'PowerShell', bash('Get-ChildItem @(Remove-Item x)')), false);
  assert.equal(isToolCallAllowed(entries, 'PowerShell', bash('Get-Date (New-Item pwned)')), false);
});

test('PowerShell rules work like Bash rules, and do not cross over', () => {
  assert.equal(isToolCallAllowed(['PowerShell(git status:*)'], 'PowerShell', bash('git status --short')), true);
  assert.equal(isToolCallAllowed(['PowerShell(git status:*)'], 'Bash', bash('git status')), false);
  assert.equal(isToolCallAllowed(['Bash(git status:*)'], 'PowerShell', bash('git status')), false);
  assert.equal(isToolCallAllowed(['PowerShell(Get-ChildItem:*)'], 'PowerShell', bash('Get-ChildItem -Recurse | Measure-Object')), false);
});

test('a command rule is never read as a glob over tool names', () => {
  // The `*` is part of the command pattern, so it says nothing about which
  // tools the entry covers — and for an allow list it is just a character.
  assert.equal(isToolCallAllowed(['Bash(git *:*)'], 'mcp__unity-vov__script-execute', {}), false);
  assert.equal(isToolCallAllowed(['Bash(*)'], 'Bash', bash('rm -rf ~')), false);
  assert.equal(isToolCallDenied(['Bash(*)'], 'Bash', bash('rm -rf ~')), true);
});

test('an unterminated quote cannot hide a command from a deny rule', () => {
  // The apostrophe opens a quote that never closes, so the `;` does not split.
  const sneaky = bash("echo don't; rm -rf ~/x");
  assert.equal(isToolCallDenied(['Bash(rm:*)'], 'Bash', sneaky), true);
  // The same command fails closed for an allow list rather than being approved.
  assert.equal(isToolCallAllowed(['Bash(echo:*)', 'Bash(rm:*)'], 'Bash', sneaky), false);
});

test('a backtick is an escape in PowerShell, not a subshell', () => {
  assert.equal(isToolCallAllowed(['PowerShell(Get-Content:*)'], 'PowerShell', bash('Get-Content a`nb.txt')), true);
  // In Bash it still marks the command opaque.
  assert.equal(isToolCallAllowed(['Bash(echo:*)'], 'Bash', bash('echo `whoami`')), false);
});

test('a Windows path separator does not escape a separator in PowerShell', () => {
  assert.equal(isToolCallDenied(['PowerShell(Remove-Item:*)'], 'PowerShell', bash('Get-Item C:\\x; Remove-Item C:\\y')), true);
});

test('a deny list takes the wider glob shapes the CLI also denies on', () => {
  // Allowing on these would grant more here than in the terminal; denying on
  // them fails closed, which is the side a deny rule must err towards.
  assert.equal(isToolCallDenied(['*'], 'Bash', bash('rm -rf /')), true);
  assert.equal(isToolCallDenied(['mcp__*'], 'mcp__unity-vov__script-execute', {}), true);
  assert.equal(isToolCallDenied(['mcp__unity-*__script-execute'], 'mcp__unity-comp__script-execute', {}), true);
  assert.equal(isToolCallDenied(['mcp__*'], 'Bash', bash('ls')), false);
});
