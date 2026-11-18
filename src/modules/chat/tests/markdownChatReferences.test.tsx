import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';

const KNOWN_ID = 'f357c5d4-4d79-4f69-923f-9ba3e5c9fb93';
const UNKNOWN_ID = '8952d921-3e2c-4b18-b44e-b1d40c9c3c45';

const { sessionDetails } = vi.hoisted(() => ({
  sessionDetails: vi.fn(async (id: string) => (id === 'f357c5d4-4d79-4f69-923f-9ba3e5c9fb93'
    ? new Response(JSON.stringify({ data: { sessionId: 'app-session-1', summary: 'Audit PR 220' } }), { status: 200 })
    : new Response('{}', { status: 404 }))),
}));

vi.mock('@/shared/api', () => ({ api: { sessionDetails } }));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }),
}));

const OpenedSession = () => <div>opened {useParams().sessionId}</div>;

const renderAt = (markdown: string) => render(
  <MemoryRouter>
    <Routes>
      <Route path="/" element={<Markdown>{markdown}</Markdown>} />
      <Route path="/session/:sessionId" element={<OpenedSession />} />
    </Routes>
  </MemoryRouter>,
);

test('a chat id in inline code becomes a button named after the chat that opens it', async () => {
  const view = renderAt(`- **\`${KNOWN_ID}\`**: the audit.`);
  fireEvent.click(await view.findByRole('button', { name: 'Audit PR 220' }));
  await view.findByText('opened app-session-1');
});

test('a bare chat id in prose becomes a button too', async () => {
  const view = renderAt(`See ${KNOWN_ID}.`);
  await view.findByRole('button', { name: 'Audit PR 220' });
});

test('an id that is no chat, or sits inside a path, stays plain text', async () => {
  const view = renderAt(`Thread ${UNKNOWN_ID} and C:\\Temp\\${KNOWN_ID}\\scratchpad`);
  await vi.waitFor(() => assert.ok(sessionDetails.mock.calls.some(([id]) => id === UNKNOWN_ID)));
  assert.equal(view.queryByRole('button'), null);
  assert.ok(view.container.textContent?.includes(UNKNOWN_ID));
});
