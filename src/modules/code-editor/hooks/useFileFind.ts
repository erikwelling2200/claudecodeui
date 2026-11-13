import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createDomTextSearchProvider } from '@/modules/code-editor/utils/domTextSearch';
import { buildSearchPattern } from '@/modules/code-editor/utils/fileSearch';
import type { FileAccess, FileSearchOptions, FileSearchProvider } from '@/modules/code-editor/utils/fileSearch';
import type { FileSearchRegistry } from '@/modules/code-editor/hooks/useFileSearchProvider';

const DEFAULT_OPTIONS: FileSearchOptions = { matchCase: false, wholeWord: false, regex: false };

type UseFileFindParams = {
  access: FileAccess;
  // The element the file view renders into; searched as rendered text when the view registers no provider of its own.
  body: HTMLElement | null;
};

/** Owned by CodeEditorFrame: the find bar's state, and the search provider of whichever view the frame shows. */
export const useFileFind = ({ access, body }: UseFileFindParams) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [text, setText] = useState('');
  const [replacement, setReplacement] = useState('');
  const [options, setOptions] = useState<FileSearchOptions>(DEFAULT_OPTIONS);
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [registered, setRegistered] = useState<FileSearchProvider[]>([]);
  // Bumped when the fallback view's DOM changes, such as PDF pages rendering in, so the count follows.
  const [domRevision, setDomRevision] = useState(0);

  const registry = useMemo<FileSearchRegistry>(() => ({
    register: (provider) => {
      setRegistered((previous) => [...previous, provider]);
      return () => setRegistered((previous) => previous.filter((candidate) => candidate !== provider));
    },
  }), []);

  const fallbackProvider = useMemo(() => (body ? createDomTextSearchProvider(body) : null), [body]);
  const provider = registered.at(-1) ?? fallbackProvider;
  const canReplace = access === 'read-write' && Boolean(provider?.replace);

  const query = useMemo(() => ({ ...options, text }), [options, text]);
  const isInvalidPattern = text.length > 0 && buildSearchPattern(query) === null;

  // Which query the current hit belongs to: a new query starts from the caret, a refreshed view keeps its place.
  const searchedQueryRef = useRef(query);
  const currentIndexRef = useRef(currentIndex);
  const setCurrent = useCallback((index: number) => {
    currentIndexRef.current = index;
    setCurrentIndex(index);
  }, []);
  // Set by replace, so the hit that slides into the replaced one's place is selected once the view has updated.
  const revealAfterRefreshRef = useRef(false);

  useEffect(() => {
    if (!isOpen || !provider) return undefined;
    const count = provider.search(query);
    setMatchCount(count);
    const isNewQuery = searchedQueryRef.current !== query;
    searchedQueryRef.current = query;
    let index = -1;
    if (count > 0) {
      index = isNewQuery || currentIndexRef.current < 0 ? (provider.getStartIndex?.() ?? 0) : Math.min(currentIndexRef.current, count - 1);
      provider.reveal(index, isNewQuery || revealAfterRefreshRef.current);
    }
    revealAfterRefreshRef.current = false;
    setCurrent(index);
    return () => provider.clear();
  }, [domRevision, isOpen, provider, query, setCurrent]);

  useEffect(() => {
    if (!isOpen || !body || provider !== fallbackProvider) return undefined;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setDomRevision((revision) => revision + 1));
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [body, fallbackProvider, isOpen, provider]);

  const goTo = useCallback((index: number) => {
    if (!provider || matchCount === 0) return;
    const wrapped = ((index % matchCount) + matchCount) % matchCount;
    provider.reveal(wrapped, true);
    setCurrent(wrapped);
  }, [matchCount, provider, setCurrent]);

  const open = useCallback((withReplace: boolean, seed: string) => {
    setIsOpen(true);
    if (withReplace) setShowReplace(true);
    if (seed) setText(seed);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setMatchCount(0);
    setCurrent(-1);
  }, [setCurrent]);

  const replaceCurrent = useCallback(() => {
    if (!canReplace || !provider?.replace || currentIndex < 0) return;
    revealAfterRefreshRef.current = true;
    provider.replace(currentIndex, replacement);
  }, [canReplace, currentIndex, provider, replacement]);

  const replaceAll = useCallback(() => {
    if (!canReplace || !provider?.replaceAll || matchCount === 0) return;
    provider.replaceAll(replacement);
  }, [canReplace, matchCount, provider, replacement]);

  return {
    registry,
    isOpen,
    open,
    close,
    text,
    setText,
    replacement,
    setReplacement,
    options,
    setOptions,
    showReplace: showReplace && canReplace,
    setShowReplace,
    canReplace,
    isInvalidPattern,
    matchCount,
    currentIndex,
    goToNext: () => goTo(currentIndex + 1),
    goToPrevious: () => goTo(currentIndex - 1),
    replaceCurrent,
    replaceAll,
  };
};

export type FileFindState = ReturnType<typeof useFileFind>;
