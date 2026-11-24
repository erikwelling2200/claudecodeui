import { useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { useSkillReferenceOpener } from '@/modules/skills';
import type { LLMProvider, Project } from '@/shared/types';

// Characters a skill reference can contain: `/plugin:skill-name`, `$skill`, plus the punctuation trimmed afterwards.
const REFERENCE_CHARACTER = /[\w:./$-]/;
const MAXIMUM_REFERENCE_LENGTH = 120;

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

// The run of reference characters under the pointer, read from the text node the caret would land in.
const readReferenceAtPoint = (x: number, y: number): string | null => {
  const caretDocument = document as CaretDocument;
  const position = caretDocument.caretPositionFromPoint?.(x, y);
  const range = position ? null : caretDocument.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset ?? 0;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent ?? '';
  let start = offset;
  let end = offset;
  while (start > 0 && REFERENCE_CHARACTER.test(text[start - 1])) start -= 1;
  while (end < text.length && REFERENCE_CHARACTER.test(text[end])) end += 1;
  return text.slice(start, end) || null;
};

/**
 * Ctrl+click (Cmd+click on macOS) on a skill name anywhere in the transcript opens that skill's file in the editor.
 * Meant for `onClickCapture`, so it runs before a row's own click (expanding a tool call, following a link) and
 * suppresses that only when the click did hit a skill.
 */
export function useSkillReferenceClick(provider: LLMProvider, project: Project | null) {
  const openSkillReference = useSkillReferenceOpener(provider, project);

  return useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return;

    const target = event.target instanceof Element ? event.target : null;
    // Inline code is the common form; its whole text is the fallback where the browser has no caret lookup.
    const candidates = [
      readReferenceAtPoint(event.clientX, event.clientY),
      target?.closest('code')?.textContent ?? null,
    ];
    const opened = candidates.some((candidate) => (
      candidate !== null && candidate.length <= MAXIMUM_REFERENCE_LENGTH && openSkillReference(candidate)
    ));
    if (!opened) return;

    event.preventDefault();
    event.stopPropagation();
  }, [openSkillReference]);
}
