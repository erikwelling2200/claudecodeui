import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { ChatMessage } from '@/shared/types';
import { getSearchableText } from '@/modules/chat/utils/searchTargetLocator';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

/** Names in the CSS highlight registry; styled by `::highlight(...)` rules in index.css. */
const MATCH_HIGHLIGHT_NAME = 'chat-find-match';
const CURRENT_HIGHLIGHT_NAME = 'chat-find-current';

/** Lowercasing a long tool result on every keystroke adds up, so each message's text is computed once. */
const searchableTextCache = new WeakMap<ChatMessage, string>();

function getCachedSearchableText(message: ChatMessage): string {
  let text = searchableTextCache.get(message);
  if (text === undefined) {
    text = getSearchableText(message);
    searchableTextCache.set(message, text);
  }
  return text;
}

/** The messages containing `query` (case-insensitive), oldest first. Exported for tests. */
export function findMessageMatches(messages: ChatMessage[], query: string): ChatMessage[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return messages.filter((message) => getCachedSearchableText(message).includes(needle));
}

function messageIdentity(message: ChatMessage): string {
  return getIntrinsicMessageKey(message) ?? String(message.timestamp);
}

function supportsHighlights(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

function clearHighlights() {
  if (!supportsHighlights()) return;
  CSS.highlights.delete(MATCH_HIGHLIGHT_NAME);
  CSS.highlights.delete(CURRENT_HIGHLIGHT_NAME);
}

/**
 * Marks every occurrence of `needle` in the rendered rows. Works on the DOM rather than the message data because
 * markdown rendering changes the text; the Highlight API paints ranges without touching React's nodes.
 */
function paintHighlights(container: HTMLElement, needle: string, currentTimestamp: string | null) {
  const matchHighlight = new Highlight();
  const currentHighlight = new Highlight();

  for (const row of container.querySelectorAll<HTMLElement>('[data-message-timestamp]')) {
    const isCurrentRow = currentTimestamp !== null && row.getAttribute('data-message-timestamp') === currentTimestamp;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.toLowerCase() ?? '';
      for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) {
        const range = new Range();
        range.setStart(node, start);
        range.setEnd(node, start + needle.length);
        (isCurrentRow ? currentHighlight : matchHighlight).add(range);
      }
    }
  }

  CSS.highlights.set(MATCH_HIGHLIGHT_NAME, matchHighlight);
  CSS.highlights.set(CURRENT_HIGHLIGHT_NAME, currentHighlight);
}

type UseChatFindArgs = {
  isActive: boolean;
  /** The chat's outer element; Ctrl+F is taken only while focus is inside it (or on nothing at all). */
  rootRef: RefObject<HTMLElement>;
  scrollContainerRef: RefObject<HTMLElement>;
  chatMessages: ChatMessage[];
  /** Fetches every message of the session into the store, so a search covers what has not been paged in. */
  loadFullTranscript: () => Promise<ChatMessage[]>;
  revealMessage: (message: ChatMessage, highlight?: boolean) => void;
  sessionId: string | null;
};

/**
 * In-chat find (Ctrl+F): matches against the whole transcript, including messages never loaded into view, and
 * scrolls the current match into the render window.
 */
export function useChatFind({
  isActive,
  rootRef,
  scrollContainerRef,
  chatMessages,
  loadFullTranscript,
  revealMessage,
  sessionId,
}: UseChatFindArgs) {
  // Whether the find bar is shown; Ctrl+F opens it and Escape closes it.
  const [isOpen, setIsOpen] = useState(false);
  // The text typed into the find bar.
  const [query, setQuery] = useState('');
  // Identity of the match the user is on, kept as a key rather than an index so it survives older messages being
  // prepended when the full transcript arrives.
  const [currentMatchKey, setCurrentMatchKey] = useState<string | null>(null);
  // True while the rest of the transcript is being fetched; the count is incomplete until it lands.
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const deferredQuery = useDeferredValue(query);
  const matches = useMemo(() => findMessageMatches(chatMessages, deferredQuery), [chatMessages, deferredQuery]);

  const keyedIndex = currentMatchKey === null
    ? -1
    : matches.findIndex((message) => messageIdentity(message) === currentMatchKey);
  // With no explicit position yet, the newest match is the natural place to start in a chat.
  const currentIndex = keyedIndex >= 0 ? keyedIndex : matches.length - 1;
  const currentMatch = currentIndex >= 0 ? matches[currentIndex] : null;

  const open = useCallback(() => {
    setIsOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setCurrentMatchKey(null);
    clearHighlights();
  }, []);

  const goTo = useCallback((index: number) => {
    if (matches.length === 0) return;
    const wrapped = (index + matches.length) % matches.length;
    const target = matches[wrapped];
    setCurrentMatchKey(messageIdentity(target));
    revealMessage(target);
  }, [matches, revealMessage]);

  const goToNext = useCallback(() => goTo(currentIndex + 1), [currentIndex, goTo]);
  const goToPrevious = useCallback(() => goTo(currentIndex - 1), [currentIndex, goTo]);

  // A different chat starts with the bar closed.
  useEffect(() => {
    close();
    setQuery('');
  }, [sessionId, close]);

  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
      const focused = document.activeElement;
      const focusIsInChat = focused === null || focused === document.body || Boolean(rootRef.current?.contains(focused));
      if (!focusIsInChat) return;
      event.preventDefault();
      open();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isActive, open, rootRef]);

  // Opening the bar pulls in the messages that were never paged in, so the count covers the whole chat.
  useEffect(() => {
    if (!isOpen || !sessionId) return;
    let cancelled = false;
    setIsLoadingTranscript(true);
    loadFullTranscript()
      .catch((error) => console.error('Failed to load the full transcript for find:', error))
      .finally(() => {
        if (!cancelled) setIsLoadingTranscript(false);
      });
    return () => { cancelled = true; };
  }, [isOpen, loadFullTranscript, sessionId]);

  // A new query jumps to its newest match; streaming replies under an unchanged query do not move the view.
  useEffect(() => {
    setCurrentMatchKey(null);
    if (!isOpen || !deferredQuery.trim()) return;
    const newest = findMessageMatches(chatMessages, deferredQuery).at(-1);
    if (newest) revealMessage(newest);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery, isOpen]);

  const needle = deferredQuery.trim().toLowerCase();
  const currentTimestamp = currentMatch ? String(currentMatch.timestamp) : null;

  // Rows mount lazily as they near the viewport and replies stream in, so highlights are repainted on DOM changes.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!isOpen || !isActive || !needle || !container || !supportsHighlights()) {
      clearHighlights();
      return;
    }

    let frame: number | null = null;
    const schedulePaint = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        paintHighlights(container, needle, currentTimestamp);
      });
    };

    schedulePaint();
    const observer = new MutationObserver(schedulePaint);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [currentTimestamp, isActive, isOpen, needle, scrollContainerRef]);

  useEffect(() => () => clearHighlights(), []);

  return {
    isOpen,
    query,
    setQuery,
    matchCount: matches.length,
    currentMatchNumber: currentIndex + 1,
    isLoadingTranscript,
    inputRef,
    close,
    goToNext,
    goToPrevious,
  };
}
