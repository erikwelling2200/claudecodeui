import type { ReactNode } from 'react';

import type { SnippetHighlight } from '@/shared/types';
import { cn } from '@/shared/utils';

type HighlightedSnippetProps = {
  snippet: string;
  highlights: SnippetHighlight[];
  // Added to the text's own styling, e.g. a monospace font for a line of code.
  className?: string;
};

/**
 * Renders a search-result snippet with its matched ranges marked. Used by the
 * sidebar's conversation search and chat's archived-chats picker, which both
 * show transcript matches returned by the server's session search, and by the
 * file tree's content search for a matching line of a file.
 */
export function HighlightedSnippet({ snippet, highlights, className }: HighlightedSnippetProps) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-800">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className={cn('min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground', className)}>
      {parts}
    </span>
  );
}
