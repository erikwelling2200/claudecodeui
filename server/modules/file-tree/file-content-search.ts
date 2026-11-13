import path from 'node:path';

import type {
  FileContentMatch,
  FileContentSearchOptions,
  FileTreeContentSearch,
  FileTreeContentSearchDependencies,
} from '@/shared/types.js';
import { AppError, SEARCH_SKIPPED_FOLDER_NAMES, isPathInsideFolder } from '@/shared/utils.js';

// One generated or minified file cannot use up the whole result limit.
const MAXIMUM_MATCHES_PER_FILE = 50;
const SNIPPET_MAXIMUM_LENGTH = 200;
// How much of a long line is kept in front of its first match.
const SNIPPET_CONTEXT_BEFORE_MATCH = 40;

type RipgrepSubmatch = { start: number; end: number };

/** Globs are relative to the folder ripgrep runs in, so a literal path has its glob characters neutralised. */
function escapeGlobLiteral(relativePath: string): string {
  return relativePath.replace(/[[\]*?{}]/g, '[$&]');
}

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A phrase is found wherever its words follow each other, also when the file
 * wraps it onto the next line: whitespace between words stands for any
 * whitespace, line breaks included. Spaces around the phrase stay literal, so
 * ` word` does not match a `word` that merely starts an indented line.
 * `null` for a query of one word, which needs none of this.
 */
function buildWhitespaceTolerantPattern(query: string): string | null {
  const leadingSpaces = /^\s*/.exec(query)?.[0] ?? '';
  const trailingSpaces = /\s*$/.exec(query.slice(leadingSpaces.length))?.[0] ?? '';
  const words = query.slice(leadingSpaces.length, query.length - trailingSpaces.length).split(/\s+/);
  if (words.length < 2) return null;
  return `${leadingSpaces}${words.map(escapeRegexLiteral).join('\\s+')}${trailingSpaces}`;
}

/**
 * A later glob overrules an earlier one, so the user's globs come first: they
 * can narrow the search but never reopen a skipped or nested folder.
 */
function buildRipgrepArguments(
  folderPath: string,
  folderPaths: string[],
  query: string,
  options: FileContentSearchOptions,
): string[] {
  // Files of a project folder nested in this one belong to that folder's own search.
  const nestedFolderGlobs = folderPaths
    .filter((other) => isPathInsideFolder(folderPath, other))
    .map((other) => `!${escapeGlobLiteral(path.relative(folderPath, other).split(path.sep).join('/'))}/**`);

  // Matching across lines makes ripgrep read whole files, so only a literal phrase of several words pays for it.
  const phrasePattern = options.regex ? null : buildWhitespaceTolerantPattern(query);
  const patternArguments = options.regex ? [] : phrasePattern === null ? ['--fixed-strings'] : ['--multiline'];

  return [
    '--json', '--smart-case', '--hidden', '--no-require-git', '--no-messages',
    '--max-count', String(MAXIMUM_MATCHES_PER_FILE),
    ...patternArguments,
    ...options.globs.flatMap((glob) => ['--glob', glob]),
    ...SEARCH_SKIPPED_FOLDER_NAMES.flatMap((folderName) => ['--glob', `!${folderName}`]),
    ...nestedFolderGlobs.flatMap((glob) => ['--glob', glob]),
    '--', phrasePattern ?? query, './',
  ];
}

function resolveRootIndexes(folderCount: number, rootIndexes: number[] | undefined): number[] {
  if (!rootIndexes) {
    return Array.from({ length: folderCount }, (_unused, rootIndex) => rootIndex);
  }
  for (const rootIndex of rootIndexes) {
    if (!Number.isInteger(rootIndex) || rootIndex < 0 || rootIndex >= folderCount) {
      throw new AppError('Unknown project folder', { code: 'INVALID_CONTENT_SEARCH_FOLDER', statusCode: 400 });
    }
  }
  return [...new Set(rootIndexes)].sort((left, right) => left - right);
}

/**
 * Turns the text of a match into one displayable line: a match that runs over
 * several lines has each line break, with the indentation around it, shown as
 * a single space. The line is then cut down to a window around its first match
 * and the match ranges are moved into that window. ripgrep counts bytes; the
 * editor and the snippet count UTF-16 units.
 */
function buildSnippet(
  matchedText: string,
  submatches: RipgrepSubmatch[],
): Pick<FileContentMatch, 'character' | 'snippet' | 'highlights'> & { lineOffset: number } {
  const block = matchedText.replace(/\r?\n$/, '');
  const blockBytes = Buffer.byteLength(matchedText, 'utf8') === matchedText.length ? null : Buffer.from(matchedText, 'utf8');
  let convertedBytes = 0;
  let convertedCharacters = 0;
  // Offsets are asked for in rising order, so each call only decodes the bytes since the previous one.
  const toCharacterOffset = (byteOffset: number): number => {
    if (blockBytes === null) return byteOffset;
    convertedCharacters += blockBytes.toString('utf8', convertedBytes, byteOffset).length;
    convertedBytes = byteOffset;
    return convertedCharacters;
  };

  const firstMatchInBlock = submatches.length > 0 ? toCharacterOffset(submatches[0].start) : 0;
  // Where the first match sits in the file: the line it starts on, and its offset on that line.
  const matchLineStart = firstMatchInBlock === 0 ? 0 : block.lastIndexOf('\n', firstMatchInBlock - 1) + 1;
  let lineOffset = 0;
  for (let lineBreak = block.indexOf('\n'); lineBreak !== -1 && lineBreak < matchLineStart; lineBreak = block.indexOf('\n', lineBreak + 1)) {
    lineOffset += 1;
  }

  // Every collapsed line break, so an offset into the block can be moved into the one-line text.
  const collapsedRuns: Array<{ start: number; length: number }> = [];
  const text = block.includes('\n')
    ? block.replace(/[ \t]*(?:\r?\n[ \t]*)+/g, (run: string, start: number) => {
      collapsedRuns.push({ start, length: run.length });
      return ' ';
    })
    : block;
  let passedRuns = 0;
  let removedCharacters = 0;
  // Asked for in rising order too.
  const toTextOffset = (blockOffset: number): number => {
    while (passedRuns < collapsedRuns.length && collapsedRuns[passedRuns].start + collapsedRuns[passedRuns].length <= blockOffset) {
      removedCharacters += collapsedRuns[passedRuns].length - 1;
      passedRuns += 1;
    }
    const run = collapsedRuns[passedRuns];
    // An offset inside a collapsed run lands just behind the space that replaced it.
    return run !== undefined && blockOffset > run.start ? run.start - removedCharacters + 1 : blockOffset - removedCharacters;
  };

  const firstMatchStart = toTextOffset(firstMatchInBlock);
  const indentation = text.length - text.trimStart().length;
  let windowStart = Math.min(indentation, firstMatchStart);
  if (text.length - windowStart > SNIPPET_MAXIMUM_LENGTH) {
    windowStart = Math.max(windowStart, firstMatchStart - SNIPPET_CONTEXT_BEFORE_MATCH);
  }
  const windowEnd = Math.min(text.length, windowStart + SNIPPET_MAXIMUM_LENGTH);
  const prefix = windowStart > indentation ? '…' : '';
  const snippet = `${prefix}${text.slice(windowStart, windowEnd)}${windowEnd < text.length ? '…' : ''}`;

  const highlights: FileContentMatch['highlights'] = [];
  for (let index = 0; index < submatches.length; index += 1) {
    const start = index === 0 ? firstMatchStart : toTextOffset(toCharacterOffset(submatches[index].start));
    if (start >= windowEnd) break;
    const end = Math.min(toTextOffset(toCharacterOffset(submatches[index].end)), windowEnd);
    if (end > start) {
      highlights.push({ start: start - windowStart + prefix.length, end: end - windowStart + prefix.length });
    }
  }

  return { character: firstMatchInBlock - matchLineStart, lineOffset, snippet, highlights };
}

/** Turns one line of `rg --json` output into a match; every other kind of line is `null`. */
function parseMatchLine(outputLine: string, folderPath: string, rootIndex: number): FileContentMatch | null {
  if (!outputLine.includes('"type":"match"')) return null;

  let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number | null; submatches?: RipgrepSubmatch[] } };
  try {
    event = JSON.parse(outputLine);
  } catch {
    // The last line of a killed process can be cut off halfway.
    return null;
  }

  const filePath = event.data?.path?.text;
  // Every line the match touches: one line, or several for a phrase that wraps.
  const matchedText = event.data?.lines?.text;
  // A path or line that is not valid UTF-8 arrives as base64 under `bytes` and has nothing to show.
  if (event.type !== 'match' || typeof filePath !== 'string' || typeof matchedText !== 'string') return null;

  const relativePath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const { lineOffset, ...snippet } = buildSnippet(matchedText, event.data?.submatches ?? []);
  return {
    path: path.join(folderPath, ...relativePath.split('/')),
    relativePath,
    rootPath: folderPath,
    rootIndex,
    line: (event.data?.line_number ?? 1) + lineOffset,
    ...snippet,
  };
}

/** ripgrep explains a bad pattern or glob over several lines; the last one names the problem. */
function readRipgrepError(errorOutput: string): string {
  const lines = errorOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1].replace(/^(rg|error): /, '');
}

/**
 * Searches inside files by running ripgrep once per project folder, with no
 * index to build or keep in sync: a warm search of a 16,000-file Unity project
 * takes about 0.4 s, and matches are reported while the processes still run.
 * Used by the File Tree module's composition root and the content search tests.
 */
export function createFileContentSearch(dependencies: FileTreeContentSearchDependencies): FileTreeContentSearch {
  return {
    async search(folderPaths, query, options, run) {
      const rootIndexes = resolveRootIndexes(folderPaths.length, options.rootIndexes);
      // Aborts every ripgrep process: on the caller's abort, at the result limit, and when one folder fails.
      const stopper = new AbortController();
      const stop = (): void => stopper.abort();
      if (run.signal.aborted) return { truncated: false };
      run.signal.addEventListener('abort', stop, { once: true });

      let matchCount = 0;
      let truncated = false;

      try {
        await Promise.all(rootIndexes.map(async (rootIndex) => {
          const folderPath = folderPaths[rootIndex];
          const { exitCode, errorOutput } = await dependencies.runRipgrep(
            folderPath,
            buildRipgrepArguments(folderPath, folderPaths, query, options),
            {
              signal: stopper.signal,
              onLines(outputLines) {
                if (stopper.signal.aborted) return;
                const matches: FileContentMatch[] = [];
                for (const outputLine of outputLines) {
                  const match = parseMatchLine(outputLine, folderPath, rootIndex);
                  if (!match) continue;
                  if (matchCount >= options.limit) {
                    truncated = true;
                    stopper.abort();
                    break;
                  }
                  matchCount += 1;
                  matches.push(match);
                }
                if (matches.length > 0) run.onMatches(matches);
              },
            },
          );

          // Unreadable files also exit with 2, but `--no-messages` keeps those quiet: output here is a rejected pattern or glob.
          if (!stopper.signal.aborted && exitCode === 2 && errorOutput.trim()) {
            throw new AppError(readRipgrepError(errorOutput), { code: 'INVALID_CONTENT_SEARCH', statusCode: 400 });
          }
        }));
      } finally {
        run.signal.removeEventListener('abort', stop);
        stopper.abort();
      }

      return { truncated };
    },
  };
}
