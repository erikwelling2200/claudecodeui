import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { test, vi } from 'vitest';

import type { CodeEditorFile, Project } from '@/shared/types';

/**
 * Regression guard for #870: the editor closed on an X or a click on another
 * file and silently threw away whatever had been typed. A dirty buffer now asks
 * first; a clean one — including right after a save — still closes without a word.
 * Files close from their tab only, so closing is exercised through EditorSidebar.
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

// A textarea is enough of CodeMirror here: the guard only cares that typing
// reaches `onChange`.
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

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');
const { useEditorSidebar } = await import('@/modules/code-editor/hooks/useEditorSidebar');
const { default: EditorSidebar } = await import('@/modules/code-editor/EditorSidebar');

globalThis.ResizeObserver ??= class {
  observe() {}

  unobserve() {}

  disconnect() {}
} as unknown as typeof ResizeObserver;

const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };
const otherFile: CodeEditorFile = { name: 'b.txt', path: '/repo/b.txt', projectId: 'p1' };

const renderEditor = async (onUnsavedChangesChange?: (dirty: boolean) => void) => {
  render(<CodeEditor file={file} onUnsavedChangesChange={onUnsavedChangesChange} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'hello'));
  return { editor };
};

// The sidebar is told which tabs are dirty by its owner, so this plays that owner.
function SidebarHarness({ onCloseTab }: { onCloseTab: (tabKey: string) => void }) {
  const tabKey = 'p1|/repo/a.txt';
  const [dirtyTabKeys, setDirtyTabKeys] = useState<ReadonlySet<string>>(new Set());
  // Stable, as the real owner's is: a new callback per render would re-run the editor's report effect forever.
  const handleUnsavedChangesChange = useCallback(
    (key: string, dirty: boolean) => setDirtyTabKeys(dirty ? new Set([key]) : new Set()),
    [],
  );
  return (
    <EditorSidebar
      tabs={[{ key: tabKey, file, gotoTarget: null }]}
      activeTabKey={tabKey}
      dirtyTabKeys={dirtyTabKeys}
      isMobile={false}
      editorExpanded={false}
      editorHidden={false}
      editorWidth={600}
      resizeHandleRef={{ current: null }}
      onResizeStart={() => undefined}
      onActivateTab={() => undefined}
      onCloseTab={onCloseTab}
      onToggleEditorExpand={() => undefined}
      onUnsavedChangesChange={handleUnsavedChangesChange}
      projectPath="/repo"
    />
  );
}

const renderSidebarWithTab = async () => {
  const onClose = vi.fn();
  render(<SidebarHarness onCloseTab={onClose} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'hello'));
  return { onClose, editor };
};

const typeInto = (editor: HTMLTextAreaElement, value: string) => {
  fireEvent.change(editor, { target: { value } });
};

// No i18n instance is initialised here, so labels without a default render as their key.
const pressClose = () => {
  fireEvent.click(screen.getByLabelText('tabs.close a.txt'));
};

// Compared as a boolean rather than against the element: a failed
// `assert.equal(<jsdom node>, null)` inspects the whole node tree and takes the
// test runner down with it.
const isDirtyDotShown = () => screen.queryByLabelText('Unsaved changes') !== null;

test('closing with unsaved edits asks first and stays open when declined', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { onClose, editor } = await renderSidebarWithTab();

  typeInto(editor, 'hello edited');
  pressClose();

  assert.equal(confirm.mock.calls.length, 1);
  assert.match(String(confirm.mock.calls[0][0]), /unsaved changes/i);
  assert.equal(onClose.mock.calls.length, 0);
  // The edit is still there to be saved.
  assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, 'hello edited');
});

test('closing with unsaved edits closes once the user accepts', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { onClose, editor } = await renderSidebarWithTab();

  typeInto(editor, 'hello edited');
  pressClose();

  assert.equal(confirm.mock.calls.length, 1);
  assert.equal(onClose.mock.calls.length, 1);
});

test('closing a clean buffer does not ask', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { onClose } = await renderSidebarWithTab();

  pressClose();

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(onClose.mock.calls.length, 1);
});

test('Escape never closes the editor', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { onClose, editor } = await renderSidebarWithTab();

  fireEvent.keyDown(document, { key: 'Escape' });
  typeInto(editor, 'hello edited');
  fireEvent.keyDown(editor, { key: 'Escape' });

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(onClose.mock.calls.length, 0);
});

// A macrotask boundary lets a released request's whole promise chain settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a CRLF file is not dirty just because CodeMirror reports LF', async () => {
  readFile.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: 'first\r\nsecond' }) }));

  render(<CodeEditor file={file} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  // Like CodeMirror, a textarea reports the document with LF line endings.
  await waitFor(() => assert.equal(editor.value, 'first\nsecond'));
  assert.equal(isDirtyDotShown(), false);

  typeInto(editor, 'first\nsecond edited');
  assert.equal(isDirtyDotShown(), true);

  // Undone by hand: the buffer matches the file again, CRLF or not.
  typeInto(editor, 'first\nsecond');

  assert.equal(isDirtyDotShown(), false);
});

test('a save still in flight when another file opens leaves that file clean', async () => {
  let releaseSave: (() => void) | null = null;
  saveFile.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { releaseSave = resolve; });
    return { ok: true, json: async () => ({ success: true }) };
  });
  readFile.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: 'hello' }) }));
  readFile.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: 'other file' }) }));

  const onUnsavedChangesChange = vi.fn();
  const { rerender } = render(<CodeEditor file={file} onUnsavedChangesChange={onUnsavedChangesChange} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'hello'));

  typeInto(editor, 'hello edited');
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));

  // The user accepts the switch while the write is still on the wire.
  rerender(<CodeEditor file={otherFile} onUnsavedChangesChange={onUnsavedChangesChange} />);
  await waitFor(() => assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, 'other file'));

  await act(async () => {
    releaseSave?.();
    await settle();
  });
  // The old file's baseline was not allowed to land on the file that is open now.
  assert.equal(isDirtyDotShown(), false);
  assert.equal(onUnsavedChangesChange.mock.calls.at(-1)?.[0], false);
});

test('a slow read of the previous file never replaces the one open now', async () => {
  let releaseFirstRead: (() => void) | null = null;
  readFile.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    return { ok: true, json: async () => ({ content: 'hello' }) };
  });
  readFile.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: 'other file' }) }));

  const { rerender } = render(<CodeEditor file={file} />);
  rerender(<CodeEditor file={otherFile} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'other file'));
  typeInto(editor, 'other file edited');

  await act(async () => {
    releaseFirstRead?.();
    await settle();
  });

  assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, 'other file edited');
  assert.equal(isDirtyDotShown(), true);
});

test('a failed save of the previous file is not reported on the one open now', async () => {
  let failSave: ((error: Error) => void) | null = null;
  saveFile.mockImplementationOnce(async () => {
    await new Promise<void>((_resolve, reject) => { failSave = reject; });
    return { ok: true, json: async () => ({ success: true }) };
  });
  readFile.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: 'hello' }) }));
  readFile.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: 'other file' }) }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  const { rerender } = render(<CodeEditor file={file} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'hello'));
  typeInto(editor, 'hello edited');
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));

  rerender(<CodeEditor file={otherFile} />);
  await waitFor(() => assert.equal(screen.getByTestId<HTMLTextAreaElement>('editor').value, 'other file'));
  await act(async () => {
    failSave?.(new Error('disk full'));
    await settle();
  });

  assert.equal(screen.queryByText('disk full') !== null, false);
  // The open file can be saved straight away rather than waiting on the old write.
  typeInto(screen.getByTestId<HTMLTextAreaElement>('editor'), 'other file edited');
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 2));
});

test('a successful save clears the dirty state', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { onClose, editor } = await renderSidebarWithTab();

  typeInto(editor, 'hello edited');
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
  // The dot in the header goes away once the write has landed.
  await waitFor(() => assert.equal(isDirtyDotShown(), false));

  pressClose();

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(onClose.mock.calls.length, 1);
});

test('the header shows a dirty indicator only while there are unsaved edits', async () => {
  const { editor } = await renderEditor();
  assert.equal(isDirtyDotShown(), false);

  typeInto(editor, 'hello edited');
  assert.equal(isDirtyDotShown(), true);

  // Undoing the edit by hand makes the buffer match the disk again.
  typeInto(editor, 'hello');
  assert.equal(isDirtyDotShown(), false);
});

test('leaving the page is only intercepted while there are unsaved edits', async () => {
  const { editor } = await renderEditor();

  const askClean = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(askClean);
  assert.equal(askClean.defaultPrevented, false);

  typeInto(editor, 'hello edited');
  const askDirty = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(askDirty);
  assert.equal(askDirty.defaultPrevented, true);
});

test('dirtiness is reported upward and reset when the editor unmounts', async () => {
  const onUnsavedChangesChange = vi.fn();
  const { unmount } = render(<CodeEditor file={file} onUnsavedChangesChange={onUnsavedChangesChange} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'hello'));

  typeInto(editor, 'hello edited');
  assert.equal(onUnsavedChangesChange.mock.calls.at(-1)?.[0], true);

  unmount();
  assert.equal(onUnsavedChangesChange.mock.calls.at(-1)?.[0], false);
});

const project: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/repo', path: '/repo' };

test('opening another file while one is dirty opens it in a new tab and keeps both', () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

  act(() => result.current.handleFileOpen('/repo/a.txt'));
  act(() => result.current.handleUnsavedChangesChange(result.current.activeTabKey!, true));
  let opened: boolean | null = null;
  act(() => { opened = result.current.handleFileOpen('/repo/b.txt'); });

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(opened, true);
  assert.deepEqual(result.current.tabs.map((tab) => tab.file.path), ['/repo/a.txt', '/repo/b.txt']);
  assert.equal(result.current.editingFile?.path, '/repo/b.txt');
  assert.equal(result.current.dirtyTabKeys.size, 1);
});

test('re-opening an open file switches to its tab and keeps its buffer', () => {
  const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

  act(() => result.current.handleFileOpen('/repo/a.txt'));
  const firstFile = result.current.editingFile;
  act(() => result.current.handleFileOpen('/repo/b.txt'));
  // Another spelling of the same path still finds the tab.
  act(() => result.current.handleFileOpen('a.txt', null, 12, 4));

  assert.equal(result.current.tabs.length, 2);
  assert.equal(result.current.editingFile, firstFile, 'the file object is kept, so the buffer is not reloaded');
  assert.deepEqual(result.current.tabs[0].gotoTarget, { line: 12, character: 4 });
});

test('a new tab opens right of the active one, and closing the active tab activates its right neighbour', () => {
  const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

  act(() => result.current.handleFileOpen('/repo/a.txt'));
  act(() => result.current.handleFileOpen('/repo/c.txt'));
  act(() => result.current.handleActivateTab(result.current.tabs[0].key));
  act(() => result.current.handleFileOpen('/repo/b.txt'));
  assert.deepEqual(result.current.tabs.map((tab) => tab.file.name), ['a.txt', 'b.txt', 'c.txt']);

  act(() => result.current.handleCloseTab(result.current.activeTabKey!));
  assert.equal(result.current.editingFile?.name, 'c.txt');

  act(() => result.current.handleCloseTab(result.current.activeTabKey!));
  assert.equal(result.current.editingFile?.name, 'a.txt');

  act(() => result.current.handleCloseTab(result.current.activeTabKey!));
  assert.equal(result.current.editingFile, null);
});

test('re-opening a dirty tab with a diff payload reloads the buffer, so it asks first', () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

  act(() => result.current.handleFileOpen('/repo/a.txt'));
  act(() => result.current.handleUnsavedChangesChange(result.current.activeTabKey!, true));
  act(() => result.current.handleFileOpen('/repo/a.txt', { old_string: 'a', new_string: 'b' }));

  assert.equal(confirm.mock.calls.length, 1);
  assert.equal(result.current.editingFile?.diffInfo, null);

  confirm.mockReturnValue(true);
  act(() => result.current.handleFileOpen('/repo/a.txt', { old_string: 'a', new_string: 'b' }));
  assert.deepEqual(result.current.editingFile?.diffInfo, { old_string: 'a', new_string: 'b' });
  assert.equal(result.current.tabs.length, 1);
});

test('the same path in another project is a different file, so it gets its own tab', () => {
  // Nested projects list the same absolute paths, and the editor re-reads the
  // file whenever its project changes.
  const nestedProject: Project = { projectId: 'p2', displayName: 'sub', fullPath: '/repo/sub', path: '/repo/sub' };
  const { result, rerender } = renderHook(
    ({ selectedProject }) => useEditorSidebar({ selectedProject, isMobile: false }),
    { initialProps: { selectedProject: project } },
  );

  act(() => result.current.handleFileOpen('/repo/sub/a.txt'));
  rerender({ selectedProject: nestedProject });
  act(() => result.current.handleFileOpen('/repo/sub/a.txt'));

  assert.deepEqual(result.current.tabs.map((tab) => tab.file.projectId), ['p1', 'p2']);
});
