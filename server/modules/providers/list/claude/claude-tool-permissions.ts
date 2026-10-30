/**
 * Matches the app's stored permission entries (exact tool names, `Bash(cmd)`
 * and `Bash(prefix:*)`) against a tool call, for the approval callback that
 * runs after the CLI's own permission check has already asked.
 *
 * A Bash command is checked per subcommand, the way the CLI does it: an
 * allow list approves the call only when every part of `a && b | c` is
 * covered, and a deny list rejects it when any part is. Without that,
 * `Bash(git checkout:*)` would approve `git checkout x; rm -rf ~`.
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

function matchesBashSegment(entry: string, segment: string) {
  const prefixMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    return segment === prefix || (segment.startsWith(prefix) && /\s/.test(segment[prefix.length]));
  }

  const exactMatch = entry.match(/^Bash\((.+)\)$/);
  return exactMatch ? segment === exactMatch[1] : false;
}

function hasBashEntry(entries: string[]) {
  return entries.some((entry) => entry === 'Bash' || entry.startsWith('Bash('));
}

export function isToolCallAllowed(entries: string[], toolName: string, input: unknown) {
  if (!toolName) return false;
  if (entries.includes(toolName)) return true;
  if (toolName !== 'Bash' || !hasBashEntry(entries)) return false;

  const { segments, opaque } = splitBashCommand(getBashCommand(input));
  if (opaque || segments.length === 0) return false;
  return segments.every((segment) => entries.some((entry) => matchesBashSegment(entry, segment)));
}

export function isToolCallDenied(entries: string[], toolName: string, input: unknown) {
  if (!toolName) return false;
  if (entries.includes(toolName)) return true;
  if (toolName !== 'Bash' || !hasBashEntry(entries)) return false;

  const { segments } = splitBashCommand(getBashCommand(input));
  return segments.some((segment) => entries.some((entry) => matchesBashSegment(entry, segment)));
}
