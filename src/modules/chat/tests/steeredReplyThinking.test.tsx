import assert from 'node:assert/strict';

import React from 'react';
import { render } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

// The model often answers a message sent mid-turn only in its thinking, so the
// thought right after such a message is shown open; any other stays closed.
const thought: ChatMessage = {
  type: 'assistant',
  content: 'I will add the lessons to CLAUDE.md after this booking.',
  timestamp: '2026-10-29T14:23:40.000Z',
  isThinking: true,
};

const renderThought = (prevMessage: ChatMessage) => render(
  <UiPreferencesProvider>
    <MessageComponent message={thought} prevMessage={prevMessage} createDiff={() => []} provider="claude" showThinking />
  </UiPreferencesProvider>,
);

test('the thought after a message sent mid-turn is open, the one after an ordinary prompt is not', () => {
  const [steered] = normalizedToChatMessages([{
    id: 'local_steer_x_0', sessionId: 'session-1', timestamp: '2026-10-29T14:23:33.000Z', provider: 'claude',
    kind: 'text', role: 'user', content: 'Remember the improvements', steerId: 'stdin-uuid',
  }]);
  assert.equal(steered?.steerId, 'stdin-uuid');

  const open = renderThought(steered!);
  assert.ok(open.container.querySelector('[data-state="open"]'), 'shown open');
  open.unmount();

  const closed = renderThought({ type: 'user', content: 'Book the invoices', timestamp: '2026-10-29T14:23:00.000Z' });
  assert.equal(closed.container.querySelector('[data-state="open"]'), null, 'left closed');
  assert.ok(closed.container.querySelector('[data-state="closed"]'));
});
