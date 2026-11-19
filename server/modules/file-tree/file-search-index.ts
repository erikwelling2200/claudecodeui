import path from 'node:path';

import ignore from 'ignore';

import type {
  FileSearchResult,
  FileTreeFileIndex,
  FileTreeFileIndexDependencies,
} from '@/shared/types.js';
import { SEARCH_SKIPPED_FOLDER_NAMES, getPathComparisonKey, isPathInsideFolder } from '@/shared/utils.js';

// Without a search for this long, a folder's index and its watcher are dropped.
const IDLE_DISPOSE_MILLISECONDS = 10 * 60 * 1000;
// Changes are batched into one rebuild; a checkout touches thousands of files at once.
const REBUILD_DEBOUNCE_MILLISECONDS = 400;
// Where no watcher could be started, an index older than this is rebuilt before a search.
const UNWATCHED_MAXIMUM_AGE_MILLISECONDS = 30 * 1000;

const ALWAYS_SKIPPED_SEGMENTS = new Set(SEARCH_SKIPPED_FOLDER_NAMES);

type IndexEntry = {
  relativePath: string;
  relativePathLower: string;
  nameLower: string;
  name: string;
  type: 'file' | 'directory';
};

type FolderIndex = {
  folderPath: string;
  entries: IndexEntry[];
  builtAt: number;
  building: Promise<void> | null;
  stale: boolean;
  watched: boolean;
  stopWatching: (() => void) | null;
  rebuildTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  isIgnored: (relativePath: string) => boolean;
};

/** Files plus every directory that holds one, so a folder name is searchable too. */
function createEntries(relativeFilePaths: string[]): IndexEntry[] {
  const directories = new Set<string>();
  const entries: IndexEntry[] = [];
  for (const relativePath of relativeFilePaths) {
    let slash = relativePath.lastIndexOf('/');
    while (slash > 0) {
      const directory = relativePath.slice(0, slash);
      if (directories.has(directory)) break;
      directories.add(directory);
      slash = directory.lastIndexOf('/');
    }
    entries.push(createEntry(relativePath, 'file'));
  }
  for (const directory of directories) {
    entries.push(createEntry(directory, 'directory'));
  }
  return entries;
}

function createEntry(relativePath: string, type: 'file' | 'directory'): IndexEntry {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return { relativePath, relativePathLower: relativePath.toLowerCase(), name, nameLower: name.toLowerCase(), type };
}

/** True when every character of `query` occurs in `text` in order. */
function isSubsequence(query: string, text: string): boolean {
  let queryIndex = 0;
  for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
    if (text.charCodeAt(textIndex) === query.charCodeAt(queryIndex)) queryIndex += 1;
  }
  return queryIndex === query.length;
}

function isLetterOrDigit(character: string): boolean {
  return /[\p{L}\p{N}]/u.test(character);
}

function isUpper(character: string): boolean {
  return character !== character.toLowerCase() && character === character.toUpperCase();
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

/** Whether a word begins at `index`: after a separator, at a camelCase hump, or where digits start. */
function isWordStart(text: string, index: number): boolean {
  const current = text[index];
  if (!isLetterOrDigit(current)) return false;
  if (index === 0) return true;
  const previous = text[index - 1];
  if (!isLetterOrDigit(previous)) return true;
  if (isDigit(current) !== isDigit(previous)) return true;
  if (isUpper(current) && !isUpper(previous)) return true;
  // The `P` of `XMLParser`.
  return isUpper(current) && isUpper(previous) && index + 1 < text.length && !isUpper(text[index + 1]) && !isDigit(text[index + 1]);
}

/**
 * Matches `query` as runs of characters that each begin at a word start of
 * `text` and continue within it: `acout` matches **Ac**tion**Out**line. Returns
 * the matched indices of `text`, or null. `query` and `textLower` are lowercase.
 */
function matchWordStarts(query: string, text: string, textLower: string): number[] | null {
  if (!isSubsequence(query, textLower)) return null;
  const failed = new Set<number>();

  // `continuesRun`: the previous query character matched at `textIndex - 1`.
  const match = (queryIndex: number, textIndex: number, continuesRun: boolean): number[] | null => {
    if (queryIndex === query.length) return [];
    const key = (queryIndex * (text.length + 1) + textIndex) * 2 + (continuesRun ? 1 : 0);
    if (failed.has(key)) return null;
    const wanted = query[queryIndex];
    if (continuesRun && textIndex < text.length && textLower[textIndex] === wanted) {
      const rest = match(queryIndex + 1, textIndex + 1, true);
      if (rest) return [textIndex, ...rest];
    }
    for (let candidate = textIndex; candidate < text.length; candidate += 1) {
      if (textLower[candidate] !== wanted) continue;
      // A separator in the query, such as the `/` of `scr/pl`, matches wherever it occurs.
      if (isLetterOrDigit(wanted) && !isWordStart(text, candidate)) continue;
      const rest = match(queryIndex + 1, candidate + 1, true);
      if (rest) return [candidate, ...rest];
    }
    failed.add(key);
    return null;
  };

  return match(0, 0, false);
}

/** Matched indices as `[start, end)` ranges. */
function toRanges(indices: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

type EntryMatch = {
  // Higher is better.
  score: number;
  // The matched characters of `relativePath`, as `[start, end)` ranges.
  ranges: Array<[number, number]>;
};

/**
 * A query holding a slash is matched against the whole relative path, any
 * other query against the name first. Null when the entry does not match.
 */
function matchEntry(entry: IndexEntry, query: string, matchesPath: boolean): EntryMatch | null {
  const nameStart = entry.relativePath.length - entry.name.length;
  const inName = (start: number): Array<[number, number]> => [[nameStart + start, nameStart + start + query.length]];
  if (!matchesPath) {
    if (entry.nameLower === query) return { score: 1000, ranges: inName(0) };
    if (entry.nameLower.startsWith(query)) return { score: 800, ranges: inName(0) };
    const nameIndex = entry.nameLower.indexOf(query);
    if (nameIndex >= 0) return { score: 600, ranges: inName(nameIndex) };
  }
  const pathIndex = entry.relativePathLower.indexOf(query);
  if (pathIndex >= 0) return { score: 400, ranges: [[pathIndex, pathIndex + query.length]] };
  if (!matchesPath) {
    const nameIndices = matchWordStarts(query, entry.name, entry.nameLower);
    if (nameIndices) return { score: 300, ranges: toRanges(nameIndices.map((index) => nameStart + index)) };
  }
  const pathIndices = matchWordStarts(query, entry.relativePath, entry.relativePathLower);
  if (pathIndices) return { score: 200, ranges: toRanges(pathIndices) };
  return null;
}

function createIgnoreMatcher(gitignoreContent: string | null): (relativePath: string) => boolean {
  const matcher = gitignoreContent === null ? null : ignore().add(gitignoreContent);
  return (relativePath) => {
    if (relativePath.split('/').some((segment) => ALWAYS_SKIPPED_SEGMENTS.has(segment))) return true;
    return matcher !== null && matcher.ignores(relativePath);
  };
}

/**
 * Keeps an in-memory list of every file of each project folder, so a search is
 * a scan over strings instead of a walk of the disk. A folder is listed once,
 * on first use, and relisted after a debounce whenever its watcher reports a
 * change that its root `.gitignore` does not exclude.
 */
export function createFileSearchIndex(dependencies: FileTreeFileIndexDependencies): FileTreeFileIndex {
  const folders = new Map<string, FolderIndex>();

  function getFolder(folderPath: string): FolderIndex {
    const key = getPathComparisonKey(folderPath);
    let folder = folders.get(key);
    if (!folder) {
      folder = {
        folderPath,
        entries: [],
        builtAt: 0,
        building: null,
        stale: true,
        watched: false,
        stopWatching: null,
        rebuildTimer: null,
        idleTimer: null,
        isIgnored: createIgnoreMatcher(null),
      };
      folders.set(key, folder);
    }
    scheduleIdleDispose(key, folder);
    return folder;
  }

  function scheduleIdleDispose(key: string, folder: FolderIndex): void {
    if (folder.idleTimer) clearTimeout(folder.idleTimer);
    folder.idleTimer = setTimeout(() => {
      folder.stopWatching?.();
      if (folder.rebuildTimer) clearTimeout(folder.rebuildTimer);
      folders.delete(key);
    }, IDLE_DISPOSE_MILLISECONDS);
    folder.idleTimer.unref?.();
  }

  function startWatching(folder: FolderIndex): void {
    if (folder.stopWatching) return;
    try {
      folder.stopWatching = dependencies.watchFolder(folder.folderPath, (relativePath) => {
        if (relativePath !== null && folder.isIgnored(relativePath.split(path.sep).join('/'))) return;
        folder.stale = true;
        if (folder.rebuildTimer) clearTimeout(folder.rebuildTimer);
        folder.rebuildTimer = setTimeout(() => {
          folder.rebuildTimer = null;
          void build(folder);
        }, REBUILD_DEBOUNCE_MILLISECONDS);
        folder.rebuildTimer.unref?.();
      }, () => {
        folder.stopWatching = null;
        folder.watched = false;
      });
      folder.watched = true;
    } catch (error) {
      dependencies.logger.error(`Could not watch "${folder.folderPath}" for file search`, error);
      folder.watched = false;
    }
  }

  function build(folder: FolderIndex): Promise<void> {
    if (folder.building) return folder.building;
    folder.stale = false;
    folder.building = (async () => {
      try {
        let gitignoreContent: string | null = null;
        try {
          gitignoreContent = await dependencies.readTextFile(path.join(folder.folderPath, '.gitignore'));
        } catch {
          // A folder without a .gitignore has only the always-skipped directories filtered.
        }
        folder.isIgnored = createIgnoreMatcher(gitignoreContent);
        startWatching(folder);
        const relativeFilePaths = await dependencies.listFiles(folder.folderPath);
        folder.entries = createEntries(relativeFilePaths);
        folder.builtAt = Date.now();
      } catch (error) {
        dependencies.logger.error(`Could not index "${folder.folderPath}" for file search`, error);
      } finally {
        folder.building = null;
      }
    })();
    return folder.building;
  }

  /** Waits only when there is nothing to answer from yet; a stale index answers while it is rebuilt. */
  async function ready(folder: FolderIndex): Promise<void> {
    const expired = !folder.watched && Date.now() - folder.builtAt > UNWATCHED_MAXIMUM_AGE_MILLISECONDS;
    if (folder.builtAt === 0 || expired) {
      await build(folder);
      return;
    }
    if (folder.stale && !folder.rebuildTimer) void build(folder);
  }

  return {
    warm(folderPaths) {
      for (const folderPath of folderPaths) {
        void ready(getFolder(folderPath));
      }
    },

    async search(folderPaths, query, options) {
      const indexes = folderPaths.map(getFolder);
      await Promise.all(indexes.map(ready));

      const normalizedQuery = query.trim().toLowerCase().replace(/\\/g, '/');
      const matchesPath = normalizedQuery.includes('/');
      // Kept light: a one-letter query matches nearly every entry, and only `limit` of them become results.
      const matches: Array<{ entry: IndexEntry; rootIndex: number; score: number; ranges: Array<[number, number]> }> = [];

      indexes.forEach((folder, rootIndex) => {
        // Entries of a project folder nested in this one belong to that folder's own node.
        const nestedPrefixes = folderPaths
          .filter((other) => isPathInsideFolder(folder.folderPath, other))
          .map((other) => `${path.relative(folder.folderPath, other).split(path.sep).join('/')}/`.toLowerCase());

        for (const entry of folder.entries) {
          if (options.type === 'file' && entry.type !== 'file') continue;
          const match = normalizedQuery ? matchEntry(entry, normalizedQuery, matchesPath) : { score: 1, ranges: [] };
          if (!match) continue;
          if (nestedPrefixes.length > 0 && nestedPrefixes.some((prefix) => `${entry.relativePathLower}/`.startsWith(prefix))) continue;
          matches.push({ entry, rootIndex, ...match });
        }
      });

      matches.sort((left, right) => (
        right.score - left.score
        || left.entry.relativePath.length - right.entry.relativePath.length
        || (left.entry.relativePath < right.entry.relativePath ? -1 : left.entry.relativePath > right.entry.relativePath ? 1 : 0)
      ));
      return {
        results: matches.slice(0, options.limit).map(({ entry, rootIndex, ranges }): FileSearchResult => {
          const folderPath = indexes[rootIndex].folderPath;
          return {
            name: entry.name,
            path: path.join(folderPath, ...entry.relativePath.split('/')),
            relativePath: entry.relativePath,
            type: entry.type,
            rootPath: folderPath,
            rootIndex,
            matchRanges: ranges,
          };
        }),
        truncated: matches.length > options.limit,
      };
    },
  };
}
