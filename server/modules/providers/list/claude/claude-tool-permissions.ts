/**
 * Matches the app's deny list against a tool call, in the rule format the
 * Claude CLI reads from its own settings file — so an entry behaves the same
 * whether it was written in the permissions panel or in
 * `~/.claude/settings.json`:
 *
 * - `Write`, or a tool-name glob such as `*` (every tool) or `mcp__*` (every
 *   MCP tool on every server), the shapes the CLI denies on;
 * - `Bash(rm:*)`, matching that command and anything after it;
 * - `Bash(rm -rf build)` with no trailing `:*`, matching that command alone;
 * - `*` anywhere inside a command pattern.
 *
 * There is deliberately no allow-side match. The CLI holds the same rules and
 * judges a call against them before the app ever sees it, with per-command
 * checks no prefix rule can express, so the only thing an app-side allow could
 * add is a call the CLI chose not to wave through. Denying more than the CLI
 * would, on the other hand, only ever refuses more.
 *
 * PowerShell entries are written and matched like Bash ones, except that its
 * backtick escapes and backslash path separators are not bash metacharacters.
 *
 * A command is checked per subcommand: a deny list rejects `a && b | c` when
 * any part matches, so `Bash(rm:*)` sees the `rm` in `git status; rm -rf ~`.
 * The split is simpler than the CLI's own parser — it does not look inside a
 * subshell, `$( )`, a wrapper such as `bash -c` or `xargs`, or a leading
 * variable assignment — so this is a second line of defence: the CLI enforces
 * the same deny rules itself, before any hook runs.
 */

type BashSplit = {
  segments: string[];
  // A quote that never closed, so the split below cannot be trusted to have
  // found every separator.
  unbalanced: boolean;
};

/**
 * `escapes` is false for PowerShell, where a backtick is the escape character
 * rather than a subshell and a backslash is a path separator.
 */
function splitBashCommand(command: string, escapes = true): BashSplit {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      if (char === "'") quote = null;
      current += char;
      continue;
    }

    if (escapes && char === '\\' && next !== undefined) {
      current += char + next;
      i++;
      continue;
    }

    if (quote === '"') {
      if (char === '"') quote = null;
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    // `2>&1`, `&>file` and `>&2` are redirections, not the background operator.
    const isRedirectAmpersand = char === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || next === '>');

    if (char === ';' || char === '\n' || char === '\r' || char === '|' || (char === '&' && !isRedirectAmpersand)) {
      flush();
      if ((char === '|' || char === '&') && (next === char || (char === '|' && next === '&'))) i++;
      continue;
    }

    current += char;
  }

  flush();
  return { segments, unbalanced: quote !== null };
}

/**
 * Every separated part of a command, including the parts an unterminated quote
 * would otherwise hide. `echo don't; rm -rf ~` leaves a quote open at the `'`,
 * so the `;` never splits and the whole line reads as one segment — a deny
 * list still has to see the `rm`.
 */
function denySegments(command: string, escapes: boolean): string[] {
  const split = splitBashCommand(command, escapes);
  if (!split.unbalanced) return split.segments;

  const ignoringQuotes = command.replace(/['"]/g, ' ');
  return [...split.segments, ...splitBashCommand(ignoringQuotes, escapes).segments];
}

function getBashCommand(input: unknown) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') {
    return (input as { command: string }).command.trim();
  }
  return '';
}

// Tools whose entries carry a command, as `Tool(command)` — PowerShell rules
// are written and matched exactly like Bash ones.
const COMMAND_TOOLS = ['Bash', 'PowerShell'];

const GLOB_CACHE = new Map<string, RegExp>();

/**
 * Compiles a pattern in which `*` stands for any run of characters and
 * everything else is literal. Patterns are few and reused on every call, so
 * the compiled form is kept.
 */
function globToRegExp(pattern: string): RegExp {
  const cached = GLOB_CACHE.get(pattern);
  if (cached) return cached;

  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  const compiled = new RegExp(`^${source}$`);
  GLOB_CACHE.set(pattern, compiled);
  return compiled;
}

/** Whether an entry names this tool: exactly, or by a glob over tool names. */
function deniesToolName(entry: string, toolName: string) {
  if (entry === toolName) return true;
  if (!entry.includes('*') || entry.includes('(')) return false;
  return globToRegExp(entry).test(toolName);
}

/** Whether one command segment falls under a `Tool(...)` entry. */
function matchesCommandSegment(entry: string, toolName: string, segment: string) {
  const prefixMatch = entry.match(new RegExp(`^${toolName}\\((.+):\\*\\)$`));
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    if (!prefix.includes('*')) {
      return segment === prefix || (segment.startsWith(prefix) && /\s/.test(segment[prefix.length]));
    }
    // A wildcard prefix still has to end on a word boundary, so `git -C * push`
    // covers `git -C <path> push --force` but not `git -C <path> pushfoo`.
    return globToRegExp(prefix).test(segment) || globToRegExp(`${prefix} *`).test(segment);
  }

  const exactMatch = entry.match(new RegExp(`^${toolName}\\((.+)\\)$`));
  if (!exactMatch) return false;
  const pattern = exactMatch[1];
  return pattern.includes('*') ? globToRegExp(pattern).test(segment) : segment === pattern;
}

/** The command tool this call is for, when any entry could speak about its command. */
function commandToolFor(entries: string[], toolName: string) {
  if (!COMMAND_TOOLS.includes(toolName)) return null;
  const hasEntry = entries.some((entry) => entry === toolName || entry.startsWith(`${toolName}(`));
  return hasEntry ? toolName : null;
}

export function isToolCallDenied(entries: string[], toolName: string, input: unknown) {
  if (!toolName) return false;
  if (entries.some((entry) => deniesToolName(entry, toolName))) return true;

  const commandTool = commandToolFor(entries, toolName);
  if (!commandTool) return false;

  const segments = denySegments(getBashCommand(input), commandTool === 'Bash');
  return segments.some((segment) => entries.some((entry) => matchesCommandSegment(entry, commandTool, segment)));
}
