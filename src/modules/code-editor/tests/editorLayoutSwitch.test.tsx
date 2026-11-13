import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

/**
 * Regression guard for #870: `EditorSidebar` used to return a different root
 * element for the floating layout (mobile or popped out) than for the docked
 * one, so every switch unmounted `CodeEditor`, re-read the file from disk and
 * threw the unsaved buffer away without asking — reachable from the editor's
 * own pop-out button, from a container too narrow to split, and from the mobile
 * breakpoint. There is one editor element in one tree position now; only the
 * wrappers around it change.
 */

const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: 'hello' }) }));
const saveFile = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
    return (
      <textarea
        data-testid="editor"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  }

  return { default: CodeMirrorStub };
});

// The header's open-in-modal button; absent wherever the editor already floats.
const OPEN_IN_MODAL = 'Open in modal';
const hasOpenInModal = () => screen.queryByTitle(OPEN_IN_MODAL) !== null;

const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };

// The width the sidebar's ResizeObserver/resize handler reads off the parent.
let containerWidth = 1400;

Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get: () => containerWidth,
});

globalThis.ResizeObserver = class {
  observe() {}

  unobserve() {}

  disconnect() {}
} as unknown as typeof ResizeObserver;

const onUnsavedChangesChange = vi.fn();

const sidebar = (isMobile: boolean, editorHidden = false) => (
  <div>
    <EditorSidebar
      tabs={[{ key: 'p1|/repo/a.txt', file, gotoTarget: null }]}
      activeTabKey="p1|/repo/a.txt"
      dirtyTabKeys={new Set()}
      isMobile={isMobile}
      editorExpanded={false}
      editorHidden={editorHidden}
      editorWidth={600}
      resizeHandleRef={{ current: null }}
      onResizeStart={() => undefined}
      onActivateTab={() => undefined}
      onCloseTab={() => undefined}
      onToggleEditorExpand={() => undefined}
      onUnsavedChangesChange={onUnsavedChangesChange}
      projectPath="/repo"
    />
  </div>
);

const renderSidebar = async (isMobile = false) => {
  containerWidth = 1400;
  const view = render(sidebar(isMobile));
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'hello'));
  return { ...view, editor };
};

const typeInto = (editor: HTMLTextAreaElement, value: string) => {
  fireEvent.change(editor, { target: { value } });
};

/** The docked layout is the only one with a drag handle beside the editor. */
const isDocked = () => screen.queryByTitle('Drag to resize') !== null;

/** The floating layout is the modal one: a full-viewport overlay. */
const isFloating = (container: HTMLElement) => container.querySelector('.fixed.inset-0') !== null;

// Everything a layout switch must not destroy, in one assertion.
const assertBufferSurvived = () => {
  assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, 'hello edited');
  assert.ok(screen.getByLabelText('Unsaved changes'), 'the dirty dot is still shown');
  assert.equal(readFile.mock.calls.length, 1, 'the file was not re-read from disk');
  assert.deepEqual(onUnsavedChangesChange.mock.calls.at(-1), ['p1|/repo/a.txt', true]);
};

test('the pop-out button keeps the unsaved buffer and the dirty dot', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { container, editor } = await renderSidebar();
  assert.ok(isDocked());

  typeInto(editor, 'hello edited');

  fireEvent.click(screen.getByTitle(OPEN_IN_MODAL));

  await waitFor(() => assert.ok(isFloating(container)));
  assert.equal(isDocked(), false);
  assertBufferSurvived();
  // The buffer was kept, so nothing had to be confirmed away.
  assert.equal(confirm.mock.calls.length, 0);
  // Inside the modal the same header offers no way into the modal, and its fullscreen toggle now sizes the modal.
  assert.equal(hasOpenInModal(), false);
  assert.ok(screen.getByTitle('actions.fullscreen'));
});

test('a container too narrow to split pops the editor out without losing edits', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { container, editor } = await renderSidebar();

  typeInto(editor, 'hello edited');

  // Below MIN_LEFT_CONTENT_WIDTH + MIN_EDITOR_WIDTH the sidebar pops out by itself.
  containerWidth = 300;
  act(() => { window.dispatchEvent(new Event('resize')); });

  await waitFor(() => assert.ok(isFloating(container)));
  assertBufferSurvived();
  assert.equal(confirm.mock.calls.length, 0);

  // Widening again leaves the editor floating (it always has), and the text is
  // still there either way.
  containerWidth = 1400;
  act(() => { window.dispatchEvent(new Event('resize')); });
  assertBufferSurvived();
});

test('crossing the mobile breakpoint in both directions keeps the unsaved buffer', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { container, editor, rerender } = await renderSidebar();

  typeInto(editor, 'hello edited');

  // Window narrowed past 768px: the workspace reports mobile.
  rerender(sidebar(true));
  await waitFor(() => assert.ok(isFloating(container)));
  assert.equal(isDocked(), false);
  assertBufferSurvived();

  // ...and widened back to desktop, which docks the editor again.
  rerender(sidebar(false));
  await waitFor(() => assert.ok(isDocked()));
  assert.equal(isFloating(container), false);
  assertBufferSurvived();
  assert.ok(hasOpenInModal());

  assert.equal(confirm.mock.calls.length, 0);
});

test('an editor opened on mobile is floating from the start', async () => {
  const { container } = await renderSidebar(true);

  assert.ok(isFloating(container));
  assert.equal(isDocked(), false);
  assert.equal(hasOpenInModal(), false);
});

test('the docked panel keeps one width whichever tab is active', async () => {
  containerWidth = 1400;
  const otherFile: CodeEditorFile = { name: 'b.txt', path: '/repo/b.txt', projectId: 'p1' };
  const tabs = [
    { key: 'p1|/repo/a.txt', file, gotoTarget: null },
    { key: 'p1|/repo/b.txt', file: otherFile, gotoTarget: null },
  ];
  const renderWithActive = (activeTabKey: string) => (
    <div>
      <EditorSidebar
        tabs={tabs}
        activeTabKey={activeTabKey}
        dirtyTabKeys={new Set()}
        isMobile={false}
        editorExpanded={false}
        editorHidden={false}
        editorWidth={600}
        resizeHandleRef={{ current: null }}
        onResizeStart={() => undefined}
        onActivateTab={() => undefined}
        onCloseTab={() => undefined}
        onToggleEditorExpand={() => undefined}
        onUnsavedChangesChange={() => undefined}
        projectPath="/repo"
      />
    </div>
  );
  const panelWidth = (container: HTMLElement) => container.querySelector<HTMLElement>('.border-l')?.style.width;

  const { container, rerender } = render(renderWithActive('p1|/repo/a.txt'));
  assert.equal(panelWidth(container), '600px');

  rerender(renderWithActive('p1|/repo/b.txt'));
  assert.equal(panelWidth(container), '600px');
});

test('hiding the docked editor takes it off screen and keeps the unsaved buffer', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { container, editor, rerender } = await renderSidebar();
  typeInto(editor, 'hello edited');

  rerender(sidebar(false, true));
  assert.equal(isDocked(), false, 'no drag handle beside a hidden panel');
  assert.ok(container.querySelector('.hidden [data-testid="editor"]'), 'the editor is still mounted, only hidden');

  rerender(sidebar(false, false));
  assert.ok(isDocked());
  assertBufferSurvived();
});
