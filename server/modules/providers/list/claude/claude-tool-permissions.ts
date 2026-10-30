/**
 * Matches the app's stored permission entries against a tool call, in the rule
 * format the Claude CLI reads from its own settings file — so an entry behaves
 * the same whether it was written in the permissions panel or in
 * `~/.claude/settings.json`:
 *
 * - `Read`, or a glob over tool names such as `mcp__unity-*__console-get-logs`;
 * - `Bash(git status:*)`, matching that command and anything after it, and
 *   `Bash(git -C * commit:*)`, where `*` stands for any run of characters;
 * - `Bash(npm run lint)` with no trailing `:*`, matching that command alone.
 *
 * PowerShell entries are written and matched exactly like Bash ones.
 *
 * A command is checked per subcommand, the way the CLI does it: an allow list
 * approves the call only when every part of `a && b | c` is covered, and a deny
 * list rejects it when any part is. Without that, `Bash(git checkout:*)` would
 * approve `git checkout x; rm -rf ~`.
 */

type BashSplit = {
  segments: string[];
  // Command or process substitution, whose inner commands cannot be vouched for.
  opaque: boolean;
};

function splitBashCommand(command: string): BashSplit {
  const segments: string[] = [];
  let opaque = false;
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

    if (char === '\\' && next !== undefined) {
      current += char + next;
      i++;
      continue;
    }

    if (char === '`' || (char === '$' && next === '(')) opaque = true;

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

    if ((char === '<' || char === '>') && next === '(') opaque = true;

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
  return { segments, opaque };
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
 * everything else is literal, so `mcp__unity-*__console-get-logs` covers every
 * Unity server and `git -C * commit` covers any repository path. Patterns are
 * few and reused on every tool call, so the compiled form is kept.
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

/** Whether an entry names this tool: `Read`, or a glob such as `mcp__unity-*__scene-get-data`. */
function matchesToolName(entry: string, toolName: string) {
  if (entry === toolName) return true;
  return entry.includes('*') && !entry.includes('(') && globToRegExp(entry).test(toolName);
}

function matchesCommandSegment(entry: string, toolName: string, segment: string) {
  const prefixMatch = entry.match(new RegExp(`^${toolName}\\((.+):\\*\\)$`));
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    if (!prefix.includes('*')) {
      return segment === prefix || (segment.startsWith(prefix) && /\s/.test(segment[prefix.length]));
    }
    // A wildcard prefix still has to end on a word boundary, so `git -C * commit`
    // covers `git -C <path> commit -m x` but not `git -C <path> commitfoo`.
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

export function isToolCallAllowed(entries: string[], toolName: string, input: unknown) {
  if (!toolName) return false;
  if (entries.some((entry) => matchesToolName(entry, toolName))) return true;

  const commandTool = commandToolFor(entries, toolName);
  if (!commandTool) return false;

  const { segments, opaque } = splitBashCommand(getBashCommand(input));
  if (opaque || segments.length === 0) return false;
  return segments.every((segment) => entries.some((entry) => matchesCommandSegment(entry, commandTool, segment)));
}

export function isToolCallDenied(entries: string[], toolName: string, input: unknown) {
  if (!toolName) return false;
  if (entries.some((entry) => matchesToolName(entry, toolName))) return true;

  const commandTool = commandToolFor(entries, toolName);
  if (!commandTool) return false;

  const { segments } = splitBashCommand(getBashCommand(input));
  return segments.some((segment) => entries.some((entry) => matchesCommandSegment(entry, commandTool, segment)));
}
