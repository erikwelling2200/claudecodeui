import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * A transcript row and where its top edge sat within the transcript content.
 * Measured against the content rather than the viewport, so the user's own
 * scrolling never reads as a shift to correct.
 */
type ScrollAnchor = {
  row: HTMLElement;
  contentOffset: number;
};

/**
 * Rows recorded per anchor. Prepending a page re-keys the rows at the old top
 * (a tool run that gains members becomes a new group element), so the first
 * visible row can be replaced; the next ones survive.
 */
const ANCHOR_CANDIDATE_COUNT = 8;

/** Index of the first row whose bottom edge is below `viewportTop`, or -1 when there is none. */
export function findFirstRowInView(rows: NodeListOf<HTMLElement>, viewportTop: number): number {
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().bottom > viewportTop) {
      found = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

/**
 * Rows starting inside the viewport, with the row cut off at its top edge and
 * the transcript's first row as a last resort: either can change its own
 * height, which moves everything below it without moving its own top. Rows are in document order,
 * so a binary search keeps this to a handful of rect reads on a long transcript.
 */
function findAnchorRows(container: HTMLElement, content: Element): ScrollAnchor[] {
  const rows = container.querySelectorAll<HTMLElement>('[data-transcript-row]');
  const viewportTop = container.getBoundingClientRect().top;
  const found = findFirstRowInView(rows, viewportTop);
  if (found === -1) return [];
  const candidates = Array.from(rows).slice(found, found + ANCHOR_CANDIDATE_COUNT + 1);
  // The transcript's first row is re-rendered when an older page lands above
  // it (it drops its sender header next to a same-sender predecessor), so it
  // changes height exactly when anchoring matters most.
  const unstable = (row: HTMLElement) => row === rows[0] || row.getBoundingClientRect().top < viewportTop;
  candidates.sort((a, b) => Number(unstable(a)) - Number(unstable(b)));
  const contentTop = content.getBoundingClientRect().top;
  return candidates.map((row) => ({ row, contentOffset: row.getBoundingClientRect().top - contentTop }));
}

/**
 * Keeps the transcript row the user is reading at the same screen position
 * while content above it changes height: an older page prepended, the
 * loading indicator swapped for the "showing X of Y" line, or a lazy row
 * mounting over its estimated placeholder.
 *
 * Browser scroll anchoring covers some of this, but not at scrollTop 0 (which
 * is exactly where an older page loads) and not in Safari, so the transcript
 * does its own: the anchor rows are recorded on every scroll, and a
 * ResizeObserver on the transcript content puts the first surviving one back
 * at the same place within the content before the frame paints. The pane sets `overflow-anchor: none`, because the
 * browser picks its own anchor node and the two corrections then add up.
 *
 * The caller captures the anchor on every scroll while the user reads history
 * and clears it while following the bottom. `shouldHoldAnchor` is read at each
 * correction; it
 * must return false while something else owns the scroll position (the
 * initial scroll, a search jump). A change of `anchorResetKey` (the session)
 * drops the recorded anchor.
 */
export function useTranscriptScrollAnchor(
  scrollContainerRef: RefObject<HTMLDivElement>,
  shouldHoldAnchor: () => boolean,
  anchorResetKey: unknown,
) {
  const anchorsRef = useRef<ScrollAnchor[]>([]);
  const shouldHoldAnchorRef = useRef(shouldHoldAnchor);
  shouldHoldAnchorRef.current = shouldHoldAnchor;

  // Offsets within the content do not change when the user scrolls, so any
  // difference from the recorded one is a content shift not yet corrected.
  // Checked here as well as on resize: a row mounting in the same frame as a
  // scroll event would otherwise be re-recorded as the new normal.
  const settleAnchor = useCallback((container: HTMLElement, content: Element) => {
    const anchor = anchorsRef.current.find((candidate) => candidate.row.isConnected);
    if (anchor && shouldHoldAnchorRef.current()) {
      const shift = anchor.row.getBoundingClientRect().top - content.getBoundingClientRect().top - anchor.contentOffset;
      if (Math.abs(shift) >= 0.5) container.scrollTop += shift;
    }
    anchorsRef.current = findAnchorRows(container, content);
  }, []);

  const captureAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    const content = container?.querySelector('[data-transcript-content]');
    if (!container || !content) {
      anchorsRef.current = [];
      return;
    }
    settleAnchor(container, content);
  }, [scrollContainerRef, settleAnchor]);

  const clearAnchor = useCallback(() => {
    anchorsRef.current = [];
  }, []);

  const observerRef = useRef<ResizeObserver | null>(null);
  const observedContentRef = useRef<Element | null>(null);

  // Checked after every render rather than once per session: the content
  // element is absent while a chat is still loading and mounts later, and an
  // observer attached only on session change then watches nothing.
  useEffect(() => {
    const content = scrollContainerRef.current?.querySelector('[data-transcript-content]') ?? null;
    if (content === observedContentRef.current) return;
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedContentRef.current = content;
    if (!content || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const container = scrollContainerRef.current;
      if (container && anchorsRef.current.length > 0) settleAnchor(container, content);
    });
    observer.observe(content);
    observerRef.current = observer;
  });

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedContentRef.current = null;
  }, []);

  useEffect(() => {
    anchorsRef.current = [];
  }, [anchorResetKey]);

  return { captureAnchor, clearAnchor };
}
