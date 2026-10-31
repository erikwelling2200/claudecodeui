import { findFirstRowInView } from '@/modules/chat/hooks/useTranscriptScrollAnchor';

/**
 * Where the user was reading in a chat they scrolled up in, so switching to
 * another chat and back returns them there. A chat left at the bottom has no
 * entry, and reopens at the bottom with whatever arrived since.
 */
export type ReadingPosition = {
  /** `data-row-key` of the first transcript row in view. */
  rowKey: string;
  /** That row's top edge relative to the scroll container's top edge. */
  offset: number;
  /** History messages loaded, newest first: reopening fetches at least this many, so the row is there again. */
  loadedCount: number;
  /** The transcript's render window (`visibleMessageCount`) at the time. */
  visibleCount: number;
};

const MAX_REMEMBERED_CHATS = 200;

// Module scope rather than hook state: the chat view remounts when the user
// navigates to another project, and the positions must outlive that.
const positions = new Map<string, ReadingPosition>();

/** `chatKey` is null for a chat that has no session yet, which has nothing to return to. */
export function recallReadingPosition(chatKey: string | null): ReadingPosition | undefined {
  return chatKey === null ? undefined : positions.get(chatKey);
}

/** Records `position` for the chat, or forgets it when `null` (the user is at the bottom). */
export function rememberReadingPosition(chatKey: string | null, position: ReadingPosition | null) {
  if (chatKey === null) return;
  positions.delete(chatKey);
  if (!position) return;
  positions.set(chatKey, position);
  if (positions.size > MAX_REMEMBERED_CHATS) positions.delete(positions.keys().next().value as string);
}

/** The first keyed row in view and its offset from the container's top edge, or `null` on an empty transcript. */
export function readFirstRowInView(container: HTMLElement): Pick<ReadingPosition, 'rowKey' | 'offset'> | null {
  const rows = container.querySelectorAll<HTMLElement>('[data-row-key]');
  const viewportTop = container.getBoundingClientRect().top;
  const index = findFirstRowInView(rows, viewportTop);
  if (index === -1) return null;
  const row = rows[index];
  return { rowKey: row.dataset.rowKey as string, offset: row.getBoundingClientRect().top - viewportTop };
}

/** Scrolls so the row keyed `rowKey` sits `offset` below the container's top edge; false when that row is not rendered. */
export function scrollRowToOffset(container: HTMLElement, rowKey: string, offset: number): boolean {
  const row = container.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(rowKey)}"]`);
  if (!row) return false;
  const shift = row.getBoundingClientRect().top - container.getBoundingClientRect().top - offset;
  if (Math.abs(shift) >= 0.5) container.scrollTop += shift;
  return true;
}
