import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult } from '@/shared/types';
import { getClaudeSettings, saveClaudePermissions } from '@/modules/chat/utils/chatStorage';
import { saveClaudeRules } from '@/shared/claudePermissionRules';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// A prefix rule for any of these would allow whatever program or script it is
// handed — `Bash(python:*)` covers `python -c "<anything>"`, `Bash(timeout:*)`
// covers `timeout 9 <anything>`. Such a call can still be allowed once; no rule
// is offered for it.
const PROGRAM_RUNNERS = new Set([
  // interpreters and shells
  'python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'java', 'dotnet', 'lua',
  'bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'wsl',
  // package runners, which fetch and execute code
  'npx', 'bunx', 'pnpx', 'uvx', 'pipx',
  // commands that run another command
  'eval', 'exec', 'sudo', 'su', 'doas', 'xargs', 'env', 'timeout', 'nohup', 'time', 'nice', 'stdbuf',
  'watch', 'start', 'call', 'invoke-expression', 'iex', 'start-process', 'invoke-command', 'invoke-item', '&',
]);

// Package-manager subcommands that install, fetch or execute arbitrary code.
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const PACKAGE_RUNNING_SUBCOMMANDS = new Set(['exec', 'x', 'dlx', 'install', 'i', 'add', 'ci', 'create', 'init', 'run-script']);

// Tools whose every call can do anything, so remembering the bare tool would be
// remembering everything: the CLI itself treats `Agent` and `Task` as dangerous.
const UNREMEMBERABLE_TOOL = /^(Agent|Task)$|(^|__)(script-execute|execute[_-](?:blender[_-])?code)/i;

/** The program a command starts, without a directory or a Windows extension. */
const programName = (token: string) => token.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();

/**
 * The rule "Allow & remember" saves for a call, or null when none is safe to
 * offer. The rule lands in Claude's settings file, which the user's terminal
 * sessions and every machine it syncs to obey as well, so it is kept to the
 * command that was actually seen rather than the whole tool: a bare `Bash` or
 * `PowerShell` would allow every command there is, and a rule that names a
 * flag rather than a subcommand — `Bash(git -C:*)` — allows `git -C . -c
 * core.fsmonitor=<anything> status` along with it.
 */
export function buildClaudeToolPermissionEntry(toolName?: string, toolInput?: unknown) {
  if (!toolName) return null;
  if (!SHELL_TOOLS.has(toolName)) return UNREMEMBERABLE_TOOL.test(toolName) ? null : toolName;

  let parsed: unknown = toolInput;
  if (typeof toolInput === 'string') {
    try {
      parsed = JSON.parse(toolInput) as unknown;
    } catch {
      return null;
    }
  }

  const fullCommand = parsed && typeof parsed === 'object' && 'command' in parsed && typeof parsed.command === 'string'
    ? parsed.command.trim()
    : '';
  // `cd <repo> && git grep …` is about the git grep; a rule for `cd` would
  // approve nothing the user was actually looking at.
  const command = fullCommand.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
  if (!command) return null;

  const tokens = command.split(/\s+/);
  const [first, second, third] = tokens;
  // `FOO=1 python …` runs whatever follows the assignment.
  if (first.includes('=')) return null;
  const program = programName(first);
  if (PROGRAM_RUNNERS.has(program)) return null;

  // A subcommand is part of the rule; a flag in its place is not a subcommand.
  if (program === 'git') {
    if (!second || second.startsWith('-')) return null;
    return `${toolName}(${first} ${second}:*)`;
  }

  if (PACKAGE_MANAGERS.has(program)) {
    if (!second || second.startsWith('-') || PACKAGE_RUNNING_SUBCOMMANDS.has(second)) return null;
    // `npm run:*` would cover every script in every package; name the script.
    if (second === 'run') return third && !third.startsWith('-') ? `${toolName}(${first} run ${third}:*)` : null;
    return `${toolName}(${first} ${second}:*)`;
  }

  return `${toolName}(${first}:*)`;
}

export function formatToolInputForDisplay(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function getClaudePermissionSuggestion(
  message: ChatMessage | null | undefined,
  provider: string,
): ClaudePermissionSuggestion | null {
  if (provider !== 'claude') return null;
  if (!message?.toolResult?.isError) return null;

  const toolName = message?.toolName;
  const entry = buildClaudeToolPermissionEntry(toolName, message.toolInput);
  if (!entry) return null;

  const settings = getClaudeSettings();
  const isAllowed = settings.allowedTools.includes(entry);
  return { toolName: toolName || 'UnknownTool', entry, isAllowed };
}

export function grantClaudeToolPermission(entry: string | null): PermissionGrantResult {
  if (!entry) return { success: false };

  const settings = getClaudeSettings();
  const alreadyAllowed = settings.allowedTools.includes(entry);
  const nextAllowed = alreadyAllowed ? settings.allowedTools : [...settings.allowedTools, entry];
  const nextDisallowed = settings.disallowedTools.filter((tool) => tool !== entry);
  const updatedSettings = {
    ...settings,
    allowedTools: nextAllowed,
    disallowedTools: nextDisallowed,
  };

  // The rule belongs in Claude's settings file, where the CLI reads it too.
  // This goes first: it sends the difference against the cached rules, and
  // writing the cache beforehand would make that difference empty.
  void saveClaudeRules({ allow: nextAllowed, deny: nextDisallowed });
  // Cached as well, so the grant applies to the turn in flight rather than
  // waiting for the round trip.
  saveClaudePermissions({
    allowedTools: nextAllowed,
    disallowedTools: nextDisallowed,
    skipPermissions: settings.skipPermissions,
  });
  return { success: true, alreadyAllowed, updatedSettings };
}
