import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';

import { findHits, useChatFind } from '@/modules/chat/hooks/useChatFind';
import type { ChatMessage } from '@/shared/types';

const message = (content: string, timestamp: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp,
  ...extra,
});

test('findHits yields one hit per occurrence, case-insensitive, oldest first, including tool results', () => {
  const messages = [
    message('Alpha bravo, BRAVO again', '2026-01-01T00:00:00Z'),
    message('nothing here', '2026-01-01T00:00:01Z'),
    message('', '2026-01-01T00:00:02Z', { toolResult: { content: 'error: bravo failed' } as ChatMessage['toolResult'] }),
  ];

  expect(findHits(messages, 'bravo')).toEqual([
    { message: messages[0], occurrence: 0 },
    { message: messages[0], occurrence: 1 },
    { message: messages[2], occurrence: 0 },
  ]);
  expect(findHits(messages, '   ')).toEqual([]);
});

test('prompts-only mode searches only the messages the user sent', () => {
  const messages = [
    message('deploy the build', '2026-01-01T00:00:00Z', { type: 'user' }),
    message('I will deploy it now', '2026-01-01T00:00:01Z'),
  ];

  expect(findHits(messages, 'deploy')).toHaveLength(2);
  expect(findHits(messages, 'deploy', true)).toEqual([{ message: messages[0], occurrence: 0 }]);
});

function renderFind(chatMessages: ChatMessage[]) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const rootRef = { current: root };
  const loadFullTranscript = vi.fn(async () => chatMessages);
  const hook = renderHook((props: { chatMessages: ChatMessage[] }) => useChatFind({
    isActive: true,
    rootRef,
    scrollContainerRef: createRef<HTMLElement>(),
    chatMessages: props.chatMessages,
    loadFullTranscript,
    ensureMessageRendered: vi.fn(),
    sessionId: 'session-1',
  }), { initialProps: { chatMessages } });
  return { hook, loadFullTranscript };
}

async function openWithQuery(hook: ReturnType<typeof renderFind>['hook'], query: string) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
  });
  await act(async () => hook.result.current.setQuery(query));
}

test('Ctrl+F opens the bar and loads the full transcript; navigation steps per occurrence and wraps', async () => {
  const messages = [
    message('find me first, then find me again', '2026-01-01T00:00:00Z'),
    message('unrelated', '2026-01-01T00:00:01Z'),
    message('find me last', '2026-01-01T00:00:02Z'),
  ];
  const { hook, loadFullTranscript } = renderFind(messages);

  await openWithQuery(hook, 'FIND ME');
  expect(hook.result.current.isOpen).toBe(true);
  expect(loadFullTranscript).toHaveBeenCalledTimes(1);
  expect(hook.result.current.matchCount).toBe(3);
  expect(hook.result.current.currentMatchNumber).toBe(3);

  act(() => hook.result.current.goToNext());
  expect(hook.result.current.currentMatchNumber).toBe(1);
  act(() => hook.result.current.goToNext());
  expect(hook.result.current.currentMatchNumber).toBe(2);
  act(() => hook.result.current.goToPrevious());
  act(() => hook.result.current.goToPrevious());
  expect(hook.result.current.currentMatchNumber).toBe(3);
});

test('the current hit stays put when older messages arrive in front of it', async () => {
  const tail = [message('needle new', '2026-01-01T00:00:05Z'), message('needle newer', '2026-01-01T00:00:06Z')];
  const { hook } = renderFind(tail);

  await openWithQuery(hook, 'needle');
  act(() => hook.result.current.goToPrevious());
  expect(hook.result.current.currentMatchNumber).toBe(1);

  hook.rerender({ chatMessages: [message('needle old', '2026-01-01T00:00:00Z'), ...tail] });
  expect(hook.result.current.matchCount).toBe(3);
  expect(hook.result.current.currentMatchNumber).toBe(2);
});

test('Ctrl+F is left to the browser while focus is outside the chat', async () => {
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  outside.focus();
  const { hook } = renderFind([message('x', '2026-01-01T00:00:00Z')]);

  const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true });
  await act(async () => { document.dispatchEvent(event); });
  expect(hook.result.current.isOpen).toBe(false);
  expect(event.defaultPrevented).toBe(false);
  outside.remove();
});
