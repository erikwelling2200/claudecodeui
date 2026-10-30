import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult } from '@/shared/types';
import { getClaudeSettings, saveClaudePermissions } from '@/modules/chat/utils/chatStorage';
import { saveClaudeRules } from '@/shared/claudePermissionRules';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// The only commands "Allow & remember" will widen into a prefix rule: each
// reads and reports, and none runs another program, a script, or a value it was
// handed. Anything not listed gets a rule for the exact command instead. A list
// of programs to refuse could never be complete — the CLI carries its own
// per-program checks and keeps adding to them — but a list of programs to
// trust can be checked by reading it.
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'pwd', 'which', 'file', 'stat', 'du', 'df', 'tree', 'diff', 'jq',
  'get-childitem', 'get-content', 'select-string', 'test-path', 'get-command', 'get-location', 'measure-object',
  'get-item', 'resolve-path', 'get-date',
]);

// Git subcommands that only read. `git config` is not among them: it can set
// `core.fsmonitor`, which every later `git status` then runs.
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'describe', 'shortlog', 'reflog',
  'merge-base', 'rev-list', 'cherry', 'whatchanged',
]);

// Anything that makes one command line several commands, sends output to a
// file, or runs something nested. Such a line gets no rule: the CLI checks each
// part on its own, so a single rule cannot stand for all of them.
const COMPOUND_OR_NESTED = /[;&|`<>()\n]/;

// Tools whose every call can do anything, so remembering the bare tool would be
// remembering everything: the CLI itself treats `Agent` and `Task` as dangerous.
const UNREMEMBERABLE_TOOL = /^(Agent|Task)$|(^|__)(script-execute|execute[_-](?:blender[_-])?code)/i;

/**
 * The rule "Allow & remember" saves for a call, or null when none is safe to
 * offer. The rule lands in Claude's settings file, which the user's terminal
 * sessions and every machine it syncs to obey as well, so it never reaches
 * further than the call the user is looking at:
 *
 * - a known read-only command becomes a prefix rule (`Bash(git log:*)`);
 * - any other single command becomes a rule for exactly that command;
 * - a line that is several commands, writes to a file or nests one gets none,
 *   and can still be allowed once.
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
  const command = fullCommand.replace(/^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(&&|;)\s*/, '');
  if (!command || COMPOUND_OR_NESTED.test(command)) return null;

  const [first, second] = command.split(/\s+/);
  const program = first.toLowerCase();
  if (program === 'git' && second && READ_ONLY_GIT_SUBCOMMANDS.has(second)) {
    return `${toolName}(git ${second}:*)`;
  }
  if (READ_ONLY_COMMANDS.has(program)) {
    return `${toolName}(${first}:*)`;
  }
  // An exact rule ending in `:*` would be read as a prefix rule instead.
  return command.endsWith(':*') ? null : `${toolName}(${command})`;
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
