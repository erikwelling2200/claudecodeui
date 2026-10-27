import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** A transcript row and how far its top edge sat below the viewport's top edge. */
type ScrollAnchor = {
  row: HTMLElement;
  offset: number;
};

/**
 * The first row still (partly) inside the viewport. Rows are in document order,
 * so a binary search keeps this to a handful of rect reads on a long transcript.
 */
function findAnchorRow(container: HTMLElement): ScrollAnchor | null {
  const rows = container.querySelectorAll<HTMLElement>('[data-transcript-row]');
  const viewportTop = container.getBoundingClientRect().top;
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
  if (found === -1) return null;
  return { row: rows[found], offset: rows[found].getBoundingClientRect().top - viewportTop };
}

/**
 * Keeps the transcript row the user is reading at the same screen position
 * while content above it changes height: an older page prepended, the
 * loading indicator swapped for the "showing X of Y" line, a lazy row mounting
 * over its estimated placeholder, or a `content-visibility: auto` row getting
 * its real height.
 *
 * Browser scroll anchoring covers some of this, but not at scrollTop 0 (which
 * is exactly where an older page loads) and not in Safari, so the transcript
 * does its own: the anchor row is recorded on every scroll, and a
 * ResizeObserver on the transcript content puts it back before the frame
 * paints. The correction is measured, so it is a no-op whenever the browser
 * already anchored correctly.
 *
 * The caller captures the anchor while the user reads history and clears it
 * while following the bottom. `shouldHoldAnchor` is read at resize time; it
 * must return false while something else owns the scroll position (the
 * initial scroll, a search jump). A change of `anchorResetKey` (the session)
 * drops the recorded anchor.
 */
export function useTranscriptScrollAnchor(
  scrollContainerRef: RefObject<HTMLDivElement>,
  shouldHoldAnchor: () => boolean,
  anchorResetKey: unknown,
) {
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const shouldHoldAnchorRef = useRef(shouldHoldAnchor);
  shouldHoldAnchorRef.current = shouldHoldAnchor;

  const captureAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    anchorRef.current = container ? findAnchorRow(container) : null;
  }, [scrollContainerRef]);

  const clearAnchor = useCallback(() => {
    anchorRef.current = null;
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
      const anchor = anchorRef.current;
      if (!container || !anchor?.row.isConnected || !shouldHoldAnchorRef.current()) return;
      const offset = anchor.row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      const drift = offset - anchor.offset;
      if (Math.abs(drift) >= 0.5) container.scrollTop += drift;
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
    anchorRef.current = null;
  }, [anchorResetKey]);

  return { captureAnchor, clearAnchor };
}
