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

  return [
    '--json', '--smart-case', '--hidden', '--no-require-git', '--no-messages',
    '--max-count', String(MAXIMUM_MATCHES_PER_FILE),
    ...(options.regex ? [] : ['--fixed-strings']),
    ...options.globs.flatMap((glob) => ['--glob', glob]),
    ...SEARCH_SKIPPED_FOLDER_NAMES.flatMap((folderName) => ['--glob', `!${folderName}`]),
    ...nestedFolderGlobs.flatMap((glob) => ['--glob', glob]),
    '--', query, './',
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
 * Cuts a matching line down to a window around its first match and moves the
 * match ranges into that window. ripgrep counts bytes; the editor and the
 * snippet count UTF-16 units.
 */
function buildSnippet(lineText: string, submatches: RipgrepSubmatch[]): Pick<FileContentMatch, 'character' | 'snippet' | 'highlights'> {
  const text = lineText.replace(/\r?\n$/, '');
  const lineBytes = Buffer.byteLength(lineText, 'utf8') === lineText.length ? null : Buffer.from(lineText, 'utf8');
  let convertedBytes = 0;
  let convertedCharacters = 0;
  // Offsets are asked for in rising order, so each call only decodes the bytes since the previous one.
  const toCharacterOffset = (byteOffset: number): number => {
    if (lineBytes === null) return byteOffset;
    convertedCharacters += lineBytes.toString('utf8', convertedBytes, byteOffset).length;
    convertedBytes = byteOffset;
    return convertedCharacters;
  };

  const firstMatchStart = submatches.length > 0 ? toCharacterOffset(submatches[0].start) : 0;
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
    const start = index === 0 ? firstMatchStart : toCharacterOffset(submatches[index].start);
    if (start >= windowEnd) break;
    const end = Math.min(toCharacterOffset(submatches[index].end), windowEnd);
    if (end > start) {
      highlights.push({ start: start - windowStart + prefix.length, end: end - windowStart + prefix.length });
    }
  }

  return { character: firstMatchStart, snippet, highlights };
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
  const lineText = event.data?.lines?.text;
  // A path or line that is not valid UTF-8 arrives as base64 under `bytes` and has nothing to show.
  if (event.type !== 'match' || typeof filePath !== 'string' || typeof lineText !== 'string') return null;

  const relativePath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return {
    path: path.join(folderPath, ...relativePath.split('/')),
    relativePath,
    rootPath: folderPath,
    rootIndex,
    line: event.data?.line_number ?? 1,
    ...buildSnippet(lineText, event.data?.submatches ?? []),
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
