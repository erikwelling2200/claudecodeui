import assert from 'node:assert/strict';
import { fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';
import type { TFunction } from 'i18next';

const restartSession = vi.fn(async (_sessionId: string) => new Response('{}', { status: 200 }));
vi.mock('@/shared/api', () => ({
  api: {
    restartSession: (sessionId: string) => restartSession(sessionId),
    providerSessionId: async () => new Response(JSON.stringify({ data: { sessionId: 'provider-1' } }), { status: 200 }),
  },
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
const { default: SessionOptions } = await import('@/modules/sidebar/SessionOptions');
const noop = () => {};

function renderRow(isEditing = false) {
  return render(
    <div>
      <a href="/session/session-1">Fix login</a>
      <SessionOptions
        sessionId="session-1"
        sessionName="Fix login"
        provider="claude"
        projectId="project-1"
        isProcessing={false}
        isEditing={isEditing}
        renameDraft=""
        onRenameDraftChange={noop}
        onStartEditingSession={noop}
        onCancelEditingSession={noop}
        onSaveEditingSession={noop}
        onDeleteSession={noop}
        t={((key: string) => key) as TFunction}
      />
    </div>,
  );
}

test('right-clicking the row opens the options menu instead of the browser menu', () => {
  const { getByText, queryByRole } = renderRow();
  assert.equal(queryByRole('menu'), null);
  const event = fireEvent.contextMenu(getByText('Fix login'), { clientX: 40, clientY: 50 });
  assert.equal(event, false, 'the browser menu should be prevented');
  const menu = queryByRole('menu');
  assert.ok(menu);
  assert.ok(menu.textContent?.includes('Restart session'));
  assert.ok(menu.textContent?.includes('Rename session'));
});

test('while renaming, right-click keeps the browser menu', () => {
  const { getByText, queryByRole } = renderRow(true);
  const event = fireEvent.contextMenu(getByText('Fix login'));
  assert.equal(event, true);
  assert.equal(queryByRole('menu'), null);
});

test('restart asks the server to restart the session and reports it', async () => {
  const { getByText, getByRole } = renderRow();
  fireEvent.contextMenu(getByText('Fix login'));
  fireEvent.click(getByText('Restart session'));
  await waitFor(() => assert.ok(getByRole('menu').textContent?.includes('Session restarted')));
  assert.deepEqual(restartSession.mock.calls, [['session-1']]);
});
