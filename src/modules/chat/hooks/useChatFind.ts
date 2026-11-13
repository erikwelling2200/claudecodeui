import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { ChatMessage } from '@/shared/types';
import { getSearchableText } from '@/modules/chat/utils/searchTargetLocator';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

/** Names in the CSS highlight registry; styled by `::highlight(...)` rules in index.css. */
const MATCH_HIGHLIGHT_NAME = 'chat-find-match';
const CURRENT_HIGHLIGHT_NAME = 'chat-find-current';

const ROW_SELECTOR = '[data-message-timestamp]';

/** Frames the current occurrence must hold still before a jump counts as landed, and the most frames a jump may take. */
const SCROLL_SETTLED_FRAMES = 5;
const SCROLL_MAX_FRAMES = 120;
/** After this many frames without an exact row, a hit folded into a tool group settles for the nearest row. */
const EXACT_ROW_FRAMES = 20;

/** One occurrence of the query: the `occurrence`-th hit (0-based, in text order) inside `message`. */
export type FindHit = {
  message: ChatMessage;
  occurrence: number;
};

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

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) count += 1;
  return count;
}

function isOwnPrompt(message: ChatMessage): boolean {
  return message.type === 'user';
}

/**
 * Every occurrence of `query` (case-insensitive) across `messages`, oldest first; with `promptsOnly`, only in the
 * user's own messages. Exported for tests.
 */
export function findHits(messages: ChatMessage[], query: string, promptsOnly = false): FindHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: FindHit[] = [];
  for (const message of messages) {
    if (promptsOnly && !isOwnPrompt(message)) continue;
    const count = countOccurrences(getCachedSearchableText(message), needle);
    for (let occurrence = 0; occurrence < count; occurrence += 1) hits.push({ message, occurrence });
  }
  return hits;
}

function hitKey(hit: FindHit): string {
  return `${getIntrinsicMessageKey(hit.message) ?? String(hit.message.timestamp)}#${hit.occurrence}`;
}

function supportsHighlights(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

function clearHighlights() {
  if (!supportsHighlights()) return;
  CSS.highlights.delete(MATCH_HIGHLIGHT_NAME);
  CSS.highlights.delete(CURRENT_HIGHLIGHT_NAME);
}

/** A row's wrapper and the message inside it both carry the timestamp attribute; only the outer one is a row. */
function getRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
    .filter((row) => !row.parentElement?.closest(ROW_SELECTOR));
}

function findRow(container: HTMLElement, timestamp: string, allowNearest: boolean): HTMLElement | null {
  const rows = getRows(container);
  const exact = rows.find((row) => row.getAttribute('data-message-timestamp') === timestamp);
  if (exact || !allowNearest) return exact ?? null;

  const targetTime = new Date(timestamp).getTime();
  let nearest: HTMLElement | null = null;
  let nearestDistance = Infinity;
  for (const row of rows) {
    const distance = Math.abs(new Date(row.getAttribute('data-message-timestamp') ?? '').getTime() - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = row;
    }
  }
  return nearest;
}

/**
 * The visible occurrences of `needle` in one row, in document order. Works on the DOM rather than the message data
 * because markdown rendering changes the text; hidden text (collapsed details, copy sources) is skipped.
 */
function collectRowRanges(row: HTMLElement, needle: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? '';
    if (!text.includes(needle) || !node.parentElement?.checkVisibility({ visibilityProperty: true })) continue;
    for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * The range of the current hit inside its row. The message data and the rendered text can disagree on how many
 * occurrences a message has (a collapsed tool result renders none), so the index is clamped to what is on screen.
 */
function pickCurrentRange(ranges: Range[], occurrence: number): Range | null {
  return ranges.length === 0 ? null : ranges[Math.min(occurrence, ranges.length - 1)];
}

/** `rowTimestamps`, when given, limits painting to those rows (the user's prompts in prompts-only mode). */
function paintHighlights(container: HTMLElement, needle: string, current: FindHit | null, rowTimestamps: Set<string> | null) {
  const matchHighlight = new Highlight();
  const currentHighlight = new Highlight();
  const currentRow = current ? findRow(container, String(current.message.timestamp), false) : null;

  for (const row of getRows(container)) {
    if (rowTimestamps && !rowTimestamps.has(row.getAttribute('data-message-timestamp') ?? '')) continue;
    const ranges = collectRowRanges(row, needle);
    const currentRange = row === currentRow && current ? pickCurrentRange(ranges, current.occurrence) : null;
    for (const range of ranges) (range === currentRange ? currentHighlight : matchHighlight).add(range);
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
  /** Widens the render window so the message has a row; the scroll is aimed here, at the occurrence. */
  ensureMessageRendered: (message: ChatMessage) => void;
  sessionId: string | null;
};

/**
 * In-chat find (Ctrl+F): steps through every occurrence in the whole transcript, including messages never loaded
 * into view, one at a time.
 */
export function useChatFind({
  isActive,
  rootRef,
  scrollContainerRef,
  chatMessages,
  loadFullTranscript,
  ensureMessageRendered,
  sessionId,
}: UseChatFindArgs) {
  // Whether the find bar is shown; Ctrl+F opens it and Escape closes it.
  const [isOpen, setIsOpen] = useState(false);
  // The text typed into the find bar.
  const [query, setQuery] = useState('');
  // Identity of the hit the user is on, kept as a key rather than an index so it survives older messages being
  // prepended when the full transcript arrives.
  const [currentHitKey, setCurrentHitKey] = useState<string | null>(null);
  // Limits the search to the user's own prompts; kept across closing the bar, like a find dialog's options.
  const [promptsOnly, setPromptsOnly] = useState(false);
  // True while the rest of the transcript is being fetched; the count is incomplete until it lands.
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped by every jump, so a scroll loop from an earlier jump stops aiming.
  const scrollJobRef = useRef(0);

  const deferredQuery = useDeferredValue(query);
  const needle = deferredQuery.trim().toLowerCase();
  const hits = useMemo(() => findHits(chatMessages, deferredQuery, promptsOnly), [chatMessages, deferredQuery, promptsOnly]);
  const promptRowTimestamps = useMemo(
    () => (promptsOnly ? new Set(chatMessages.filter(isOwnPrompt).map((message) => String(message.timestamp))) : null),
    [chatMessages, promptsOnly],
  );

  const keyedIndex = currentHitKey === null ? -1 : hits.findIndex((hit) => hitKey(hit) === currentHitKey);
  // With no explicit position yet, the newest hit is the natural place to start in a chat.
  const currentIndex = keyedIndex >= 0 ? keyedIndex : hits.length - 1;
  const currentHit = currentIndex >= 0 ? hits[currentIndex] : null;

  /** Scrolls until the hit's occurrence (or, before its text mounts, its row) sits centred and holds still. */
  const scrollToHit = useCallback((hit: FindHit) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    ensureMessageRendered(hit.message);

    const job = ++scrollJobRef.current;
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    container.addEventListener('wheel', cancel, { once: true, passive: true });
    container.addEventListener('touchstart', cancel, { once: true, passive: true });
    const finish = () => {
      container.removeEventListener('wheel', cancel);
      container.removeEventListener('touchstart', cancel);
    };

    let frames = 0;
    let stillFrames = 0;
    const step = () => {
      if (cancelled || job !== scrollJobRef.current || frames >= SCROLL_MAX_FRAMES) {
        finish();
        return;
      }
      frames += 1;
      const row = findRow(container, String(hit.message.timestamp), frames > EXACT_ROW_FRAMES);
      if (!row) {
        requestAnimationFrame(step);
        return;
      }

      const range = pickCurrentRange(collectRowRanges(row, needle), hit.occurrence);
      const view = container.getBoundingClientRect();
      const rect = (range ?? row).getBoundingClientRect();
      const offset = !range && rect.height > view.height
        ? rect.top - view.top
        : rect.top + rect.height / 2 - (view.top + view.height / 2);
      const before = container.scrollTop;
      if (Math.abs(offset) >= 1) container.scrollTop += offset;
      // Rows mount and resize as the scroll passes them, so the aim holds only once the position stops changing.
      stillFrames = range && Math.abs(container.scrollTop - before) < 1 ? stillFrames + 1 : 0;
      if (stillFrames >= SCROLL_SETTLED_FRAMES) {
        finish();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [ensureMessageRendered, needle, scrollContainerRef]);

  const open = useCallback(() => {
    setIsOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setCurrentHitKey(null);
    scrollJobRef.current += 1;
    clearHighlights();
  }, []);

  const goTo = useCallback((index: number) => {
    if (hits.length === 0) return;
    const target = hits[(index + hits.length) % hits.length];
    setCurrentHitKey(hitKey(target));
    scrollToHit(target);
  }, [hits, scrollToHit]);

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

  // A new query or scope jumps to its newest hit; streaming replies under an unchanged query do not move the view.
  useEffect(() => {
    setCurrentHitKey(null);
    if (!isOpen || !needle) return;
    const newest = findHits(chatMessages, deferredQuery, promptsOnly).at(-1);
    if (newest) scrollToHit(newest);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, isOpen, promptsOnly]);

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
        paintHighlights(container, needle, currentHit, promptRowTimestamps);
      });
    };

    schedulePaint();
    const observer = new MutationObserver(schedulePaint);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [currentHit, isActive, isOpen, needle, promptRowTimestamps, scrollContainerRef]);

  useEffect(() => () => clearHighlights(), []);

  return {
    isOpen,
    query,
    setQuery,
    promptsOnly,
    setPromptsOnly,
    matchCount: hits.length,
    currentMatchNumber: currentIndex + 1,
    isLoadingTranscript,
    inputRef,
    close,
    goToNext,
    goToPrevious,
  };
}
