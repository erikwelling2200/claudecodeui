import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';
import { isBinaryFile } from '@/modules/code-editor/utils/binaryFile';

/** Whether a file's view can be changed in place; the find bar offers replace only on read-write files. */
export type FileAccess = 'read-only' | 'read-write';

export type FileSearchOptions = {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export type FileSearchQuery = FileSearchOptions & { text: string };

/** What one file view answers to the editor's find bar. Each view registers its own through useFileSearchProvider. */
export type FileSearchProvider = {
  /** Runs the query and paints every hit; returns the number of hits. An empty query clears the paint. */
  search: (query: FileSearchQuery) => number;
  /** Marks hit `index` (0-based, in document order) as the current one; `scroll` also brings it into view and selects it. */
  reveal: (index: number, scroll: boolean) => void;
  /** Hit to start from when a query changes: the first hit at or after the caret, where the view has one. */
  getStartIndex?: () => number;
  /** Replaces hit `index`; present only on views that can edit. */
  replace?: (index: number, replacement: string) => void;
  replaceAll?: (replacement: string) => void;
  /** Removes every highlight; called when the bar closes or the view goes away. */
  clear: () => void;
};

/**
 * Read-only for every file type the editor only previews (PDF, images, audio, video) or cannot show (other binaries);
 * read-write for everything else, since the rest opens as text.
 */
export const getFileAccess = (fileName: string): FileAccess => (
  getPreviewKind(fileName) || isBinaryFile(fileName) ? 'read-only' : 'read-write'
);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The query as a global RegExp, or null when it is empty or an invalid pattern. */
export const buildSearchPattern = (query: FileSearchQuery): RegExp | null => {
  if (!query.text) return null;
  let source = query.regex ? query.text : escapeRegExp(query.text);
  if (query.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, query.matchCase ? 'gu' : 'giu');
  } catch {
    return null;
  }
};

export type TextMatch = { from: number; to: number };

/** Every non-empty match of `pattern` in `text`, in order. */
export const findTextMatches = (text: string, pattern: RegExp): TextMatch[] => {
  const matches: TextMatch[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return matches;
};

/** The replacement text for one match; `$1`-style groups expand only in regex mode. */
export const expandReplacement = (matched: string, query: FileSearchQuery, replacement: string): string => {
  if (!query.regex) return replacement;
  const pattern = buildSearchPattern(query);
  if (!pattern) return replacement;
  return matched.replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement);
};
