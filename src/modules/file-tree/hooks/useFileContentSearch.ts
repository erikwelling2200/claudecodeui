import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { FileContentFileMatches, FileContentMatch, FileContentSearchState } from '@/shared/types';

const CONTENT_SEARCH_DEBOUNCE_MS = 200;
const CONTENT_SEARCH_MINIMUM_QUERY_LENGTH = 2;
// Matches arrive in many small batches; the list is redrawn at most this often.
const CONTENT_SEARCH_RENDER_INTERVAL_MS = 60;

const IDLE_STATE: FileContentSearchState = { files: [], matchCount: 0, status: 'idle', truncated: false, error: null };
const NO_FOLDERS_STATE: FileContentSearchState = { ...IDLE_STATE, status: 'done' };

type UseFileContentSearchArgs = {
  projectId: string | undefined;
  query: string;
  regex: boolean;
  // The filter box as typed: comma-separated globs.
  globText: string;
  // Positions of the project folders to search; absent searches every folder.
  rootIndexes: number[] | undefined;
  enabled: boolean;
};

/** Splits the filter box's text on commas, leaving the commas of a `{a,b}` group alone. Exported for its test. */
export function parseContentSearchGlobs(text: string): string[] {
  const globs: string[] = [];
  let current = '';
  let braceDepth = 0;
  for (const character of text) {
    if (character === '{') braceDepth += 1;
    if (character === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (character === ',' && braceDepth === 0) {
      globs.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  globs.push(current);
  return globs.map((glob) => glob.trim()).filter(Boolean);
}

/**
 * Adds a batch of matches to the per-file groups. Files keep the order they
 * were first seen in, and only a group that grew is a new object, so the rows
 * of every other file skip their re-render. Exported for its test.
 */
export function appendContentMatches(files: FileContentFileMatches[], matches: FileContentMatch[]): FileContentFileMatches[] {
  const next = files.slice();
  const positions = new Map(files.map((file, position) => [file.path, position]));
  const grown = new Set<number>();
  for (const match of matches) {
    let position = positions.get(match.path);
    if (position === undefined) {
      position = next.length;
      positions.set(match.path, position);
      next.push({ path: match.path, relativePath: match.relativePath, rootIndex: match.rootIndex, matches: [] });
      grown.add(position);
    } else if (!grown.has(position)) {
      next[position] = { ...next[position], matches: next[position].matches.slice() };
      grown.add(position);
    }
    next[position].matches.push(match);
  }
  return next;
}

/**
 * Searches inside the project's files on the server and collects the matches
 * as they stream in. The results of the previous search stay on screen until
 * the first matches of the next one arrive.
 */
export function useFileContentSearch({
  projectId,
  query,
  regex,
  globText,
  rootIndexes,
  enabled,
}: UseFileContentSearchArgs): FileContentSearchState {
  // The matches received so far and how far the search is; the results list renders straight from it.
  const [state, setState] = useState<FileContentSearchState>(IDLE_STATE);
  // A string, so a new array with the same folders does not restart the search.
  const rootsKey = rootIndexes ? rootIndexes.join(',') : null;
  const hasQuery = enabled && Boolean(projectId) && query.trim().length >= CONTENT_SEARCH_MINIMUM_QUERY_LENGTH;
  // With every folder switched off there is a query but nowhere to look.
  const hasFolders = rootsKey !== '';

  // Dropped during render, not in the effect, so an abandoned search's results never flash back when typing resumes.
  if (!(hasQuery && hasFolders) && state !== IDLE_STATE) {
    setState(IDLE_STATE);
  }

  useEffect(() => {
    if (!hasQuery || !hasFolders || !projectId) {
      return;
    }

    let source: EventSource | null = null;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    const stopRenderTimer = () => {
      if (renderTimer !== null) clearTimeout(renderTimer);
      renderTimer = null;
    };

    const debounceTimer = setTimeout(() => {
      let files: FileContentFileMatches[] = [];
      let matchCount = 0;
      let unrendered: FileContentMatch[] = [];
      const takeUnrendered = () => {
        stopRenderTimer();
        if (unrendered.length === 0) return;
        files = appendContentMatches(files, unrendered);
        matchCount += unrendered.length;
        unrendered = [];
      };

      setState((previous) => ({ ...previous, status: 'searching', error: null }));
      source = new EventSource(api.searchFileContentsUrl(projectId, query, {
        regex,
        globs: parseContentSearchGlobs(globText),
        rootIndexes: rootsKey === null ? undefined : rootsKey.split(',').map(Number),
      }));

      source.addEventListener('matches', (event) => {
        const { matches } = JSON.parse((event as MessageEvent<string>).data) as { matches: FileContentMatch[] };
        unrendered.push(...matches);
        if (renderTimer === null) {
          renderTimer = setTimeout(() => {
            takeUnrendered();
            setState({ files, matchCount, status: 'searching', truncated: false, error: null });
          }, CONTENT_SEARCH_RENDER_INTERVAL_MS);
        }
      });

      source.addEventListener('done', (event) => {
        const { truncated } = JSON.parse((event as MessageEvent<string>).data) as { truncated: boolean };
        takeUnrendered();
        setState({ files, matchCount, status: 'done', truncated, error: null });
        source?.close();
      });

      source.addEventListener('error', (event) => {
        // The server's own `error` event carries its explanation; a failed connection is a bare event.
        const data = (event as MessageEvent<string | undefined>).data;
        stopRenderTimer();
        setState({
          ...IDLE_STATE,
          status: 'error',
          error: typeof data === 'string' ? (JSON.parse(data) as { error: string }).error : null,
        });
        // Left open, an EventSource reconnects and runs the whole search again.
        source?.close();
      });
    }, CONTENT_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceTimer);
      stopRenderTimer();
      // Closing the connection is what makes the server kill its ripgrep processes.
      source?.close();
    };
  }, [globText, hasFolders, hasQuery, projectId, query, regex, rootsKey]);

  if (!hasQuery) return IDLE_STATE;
  // Nowhere to look is a finished search without matches.
  return hasFolders ? state : NO_FOLDERS_STATE;
}
