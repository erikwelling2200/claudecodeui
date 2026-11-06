import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * Regression guard: what a file reference in a chat message hands to the
 * editor. Both suffix helpers are anchored at the end of the string, so a
 * reference picked up from the link text — which, unlike the href, keeps the
 * whitespace around it — used to reach the API with `:12 ` still attached and
 * answer a 404.
 */

const openFileInEditor = vi.fn();
const openDirectory = vi.fn();

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory }),
}));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');

const clickReference = (markdown: string, linkText: string) => {
  openFileInEditor.mockReset();
  openDirectory.mockReset();
  render(<Markdown>{markdown}</Markdown>);
  fireEvent.click(screen.getByText(linkText));
};

test('a `path:line` reference opens the path without its suffix, at that line', () => {
  clickReference('See [src/foo.ts:130](src/foo.ts:130).', 'src/foo.ts:130');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 130]);
});

test('whitespace around a reference taken from the link text is dropped', () => {
  clickReference('See [`src/foo.ts:12` ]().', 'src/foo.ts:12');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 12]);
});

test('a directory reference goes to the file tree, not the editor', () => {
  clickReference('See [decisions/](decisions/).', 'decisions/');
  assert.equal(openFileInEditor.mock.calls.length, 0);
  assert.deepEqual(openDirectory.mock.calls[0], ['decisions/']);
});

test('a plain file reference opens with no line', () => {
  clickReference('See [src/foo.ts](src/foo.ts).', 'src/foo.ts');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', null]);
});

test('a file name in inline code opens it', () => {
  clickReference('Location: `NPCGenerateConditionDate.cs`', 'NPCGenerateConditionDate.cs');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['NPCGenerateConditionDate.cs', null]);
});

test('a path with a line suffix in inline code opens at that line', () => {
  clickReference('See `src/foo.ts:42`.', 'src/foo.ts:42');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 42]);
});

test('an absolute path with a space in inline code opens it', () => {
  const sqlPath = 'C:/Web apps/AdminApp/migrations/2026-11-02_build_changelog.sql';
  clickReference(`Run \`${sqlPath}\` first.`, sqlPath);
  assert.deepEqual(openFileInEditor.mock.calls[0], [sqlPath, null]);
  clickReference('See `/home/me/My Notes/todo.md:3`.', '/home/me/My Notes/todo.md:3');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['/home/me/My Notes/todo.md', 3]);
});

test('commands and relative paths with a space in inline code stay plain code', () => {
  for (const snippet of ['git add src/foo.ts', 'src/My Notes/todo.md', '/compact notes.md', 'cat ~/notes.md']) {
    const { container, unmount } = render(<Markdown>{`run \`${snippet}\` now`}</Markdown>);
    assert.equal(container.querySelector('a'), null, snippet);
    unmount();
  }
});

test('identifiers in inline code stay plain code', () => {
  for (const identifier of ['NPCGenerateConditionDate.Eval', 'Date.KingsDay', 'obj.length', 'KingsDay', '*.cs', '.cs']) {
    const { container, unmount } = render(<Markdown>{`the \`${identifier}\` case`}</Markdown>);
    assert.equal(container.querySelector('a'), null, identifier);
    unmount();
  }
});

test('inline code inside a link does not nest a second link', () => {
  const { container } = render(<Markdown>{'See [`src/foo.ts`](src/foo.ts).'}</Markdown>);
  assert.equal(container.querySelectorAll('a').length, 1);
});

test('a code block holding only an absolute path opens that file', () => {
  const filePath = String.raw`C:\Users\erikw\AppData\Local\Temp\claude\scratchpad\investigation-impact.md`;
  clickReference(`Saved to:\n\n\`\`\`\n${filePath}\n\`\`\``, filePath);
  assert.deepEqual(openFileInEditor.mock.calls[0], [filePath, null]);
});

test('each line of a code block holding several paths opens its own file', () => {
  const first = String.raw`C:\Temp\scratchpad\excel\formula_edits.json`;
  const second = String.raw`C:\Temp\scratchpad\excel\text\text-edits-log.json`;
  clickReference(`\`\`\`\n${first}\n${second}\n\`\`\``, second);
  fireEvent.click(screen.getByText(first));
  assert.deepEqual(openFileInEditor.mock.calls, [[second, null], [first, null]]);
});

test('a code block holding a command, or a path next to a command, stays highlighted code', () => {
  for (const block of ['git add src/foo.ts', 'src/foo.ts\nnpm run build']) {
    const { container, unmount } = render(<Markdown>{`\`\`\`\n${block}\n\`\`\``}</Markdown>);
    assert.equal(container.querySelector('a'), null, block);
    unmount();
  }
});
