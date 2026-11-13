import { buildSearchPattern, findTextMatches } from '@/modules/code-editor/utils/fileSearch';
import type { FileSearchProvider } from '@/modules/code-editor/utils/fileSearch';

/** Names in the CSS highlight registry; styled by `::highlight(...)` rules in index.css. */
const MATCH_HIGHLIGHT_NAME = 'file-find-match';
const CURRENT_HIGHLIGHT_NAME = 'file-find-current';

const supportsHighlights = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

const isVisibleTextNode = (node: Node): boolean => {
  const parent = node.parentElement;
  if (!parent) return false;
  // jsdom has no checkVisibility; there everything counts as visible.
  return typeof parent.checkVisibility !== 'function' || parent.checkVisibility({ visibilityProperty: true });
};

/**
 * Searches the text a file view has rendered into `root` and paints hits with the CSS Custom Highlight API, so it
 * works for any view without that view knowing about search: the markdown preview, the PDF text layer, placeholders.
 * Matches never span two text nodes. It is read-only by nature: there is no source text to write a replacement into.
 */
export const createDomTextSearchProvider = (root: HTMLElement): FileSearchProvider => {
  let ranges: Range[] = [];

  const paint = (current: number) => {
    if (!supportsHighlights()) return;
    CSS.highlights.set(MATCH_HIGHLIGHT_NAME, new Highlight(...ranges));
    const currentRange = ranges[current];
    if (currentRange) CSS.highlights.set(CURRENT_HIGHLIGHT_NAME, new Highlight(currentRange));
    else CSS.highlights.delete(CURRENT_HIGHLIGHT_NAME);
  };

  const clear = () => {
    ranges = [];
    if (!supportsHighlights()) return;
    CSS.highlights.delete(MATCH_HIGHLIGHT_NAME);
    CSS.highlights.delete(CURRENT_HIGHLIGHT_NAME);
  };

  return {
    search: (query) => {
      const pattern = buildSearchPattern(query);
      if (!pattern) {
        clear();
        return 0;
      }
      ranges = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        if (!text || !isVisibleTextNode(node)) continue;
        for (const match of findTextMatches(text, pattern)) {
          const range = document.createRange();
          range.setStart(node, match.from);
          range.setEnd(node, match.to);
          ranges.push(range);
        }
      }
      paint(-1);
      return ranges.length;
    },
    reveal: (index, scroll) => {
      paint(index);
      if (scroll) ranges[index]?.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
    },
    clear,
  };
};
