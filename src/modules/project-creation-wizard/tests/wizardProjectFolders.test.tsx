import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * The wizard creates a project with an optional name and extra folders. Blank
 * folder rows are dropped, an empty name is not sent (the server names the
 * project after its folder), and a primary folder that is already a project
 * gets a message pointing at Edit project instead of the raw server error.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: ProjectCreationWizard } = await import('@/modules/project-creation-wizard/ProjectCreationWizard');

type CreateResponse = { status: number; body: Record<string, unknown> };

const createRequests: unknown[] = [];
let createResponse: CreateResponse = { status: 200, body: { success: true, project: { projectId: 'p1' } } };
// What the server's folder dialog reports; no desktop session by default.
let folderDialogResponse: Record<string, unknown> = { available: false, cancelled: false, paths: [] };

beforeEach(() => {
  createRequests.length = 0;
  createResponse = { status: 200, body: { success: true, project: { projectId: 'p1' } } };
  folderDialogResponse = { available: false, cancelled: false, paths: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/projects/create-project')) {
      createRequests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(createResponse.body), { status: createResponse.status });
    }
    if (url.startsWith('/api/file-tree/pick-folders')) {
      return new Response(JSON.stringify(folderDialogResponse), { status: 200 });
    }
    // Path autocompletion lookups.
    return new Response(JSON.stringify({ suggestions: [] }), { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fillAndCreate = async ({ name, folders }: { name: string; folders: string[] }) => {
  const onProjectCreated = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={onProjectCreated} />);

  const [primaryInput] = screen.getAllByPlaceholderText('/path/to/project/workspace');
  fireEvent.change(primaryInput, { target: { value: '/work/app' } });
  fireEvent.change(screen.getByLabelText('projectWizard.name.label'), { target: { value: name } });

  for (const [folderIndex, folder] of folders.entries()) {
    fireEvent.click(screen.getByText('projectWizard.folders.add'));
    // The row appears once the server has answered whether it has a folder dialog.
    await waitFor(() => assert.equal(screen.getAllByLabelText('projectWizard.folders.label').length, folderIndex + 1));
    const rows = screen.getAllByLabelText('projectWizard.folders.label');
    fireEvent.change(rows[rows.length - 1], { target: { value: folder } });
  }

  fireEvent.click(screen.getByText('projectWizard.buttons.next'));
  fireEvent.click(await screen.findByText('projectWizard.buttons.createProject'));
  return { onProjectCreated };
};

test('sends the name and the non-blank extra folders with the primary path', async () => {
  const { onProjectCreated } = await fillAndCreate({ name: '  My App  ', folders: ['/work/lib', '  '] });

  await waitFor(() => assert.equal(onProjectCreated.mock.calls.length, 1));
  assert.deepEqual(createRequests, [{ path: '/work/app', customName: 'My App', additionalFolders: ['/work/lib'] }]);
});

test('leaves name and folders out when none were given', async () => {
  const { onProjectCreated } = await fillAndCreate({ name: '', folders: [] });

  await waitFor(() => assert.equal(onProjectCreated.mock.calls.length, 1));
  assert.deepEqual(createRequests, [{ path: '/work/app' }]);
});

test('an existing primary folder points the user to Edit project', async () => {
  createResponse = {
    status: 409,
    body: { success: false, error: { code: 'PROJECT_ALREADY_EXISTS', message: 'Project already exists' } },
  };
  const { onProjectCreated } = await fillAndCreate({ name: '', folders: ['/work/lib'] });

  assert.ok(await screen.findByText('projectWizard.errors.projectExists'));
  assert.equal(onProjectCreated.mock.calls.length, 0);
});

test('folders picked together in the dialog each become a row', async () => {
  folderDialogResponse = { available: true, cancelled: false, paths: ['/work/lib', '/work/tools'] };
  const onProjectCreated = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={onProjectCreated} />);

  const [primaryInput] = screen.getAllByPlaceholderText('/path/to/project/workspace');
  fireEvent.change(primaryInput, { target: { value: '/work/app' } });

  fireEvent.click(screen.getByText('projectWizard.folders.add'));
  await waitFor(() => assert.equal(screen.getAllByLabelText('projectWizard.folders.label').length, 2));

  fireEvent.click(screen.getByText('projectWizard.buttons.next'));
  fireEvent.click(await screen.findByText('projectWizard.buttons.createProject'));

  await waitFor(() => assert.equal(onProjectCreated.mock.calls.length, 1));
  assert.deepEqual(createRequests, [{ path: '/work/app', additionalFolders: ['/work/lib', '/work/tools'] }]);
});
