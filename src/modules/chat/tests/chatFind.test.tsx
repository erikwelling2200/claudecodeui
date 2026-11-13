import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';

import { findMessageMatches, useChatFind } from '@/modules/chat/hooks/useChatFind';
import type { ChatMessage } from '@/shared/types';

const message = (content: string, timestamp: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp,
  ...extra,
});

test('findMessageMatches is case-insensitive, oldest first, and covers tool results', () => {
  const messages = [
    message('Alpha bravo', '2026-01-01T00:00:00Z'),
    message('nothing here', '2026-01-01T00:00:01Z'),
    message('', '2026-01-01T00:00:02Z', { toolResult: { content: 'error: BRAVO failed' } as ChatMessage['toolResult'] }),
  ];

  expect(findMessageMatches(messages, 'bravo')).toEqual([messages[0], messages[2]]);
  expect(findMessageMatches(messages, '   ')).toEqual([]);
});

function renderFind(chatMessages: ChatMessage[]) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const rootRef = { current: root };
  const loadFullTranscript = vi.fn(async () => chatMessages);
  const revealMessage = vi.fn();
  const hook = renderHook((props: { chatMessages: ChatMessage[] }) => useChatFind({
    isActive: true,
    rootRef,
    scrollContainerRef: createRef<HTMLElement>(),
    chatMessages: props.chatMessages,
    loadFullTranscript,
    revealMessage,
    sessionId: 'session-1',
  }), { initialProps: { chatMessages } });
  return { hook, loadFullTranscript, revealMessage };
}

test('Ctrl+F opens the bar and loads the full transcript; navigation starts at the newest match and wraps', async () => {
  const messages = [
    message('find me first', '2026-01-01T00:00:00Z'),
    message('unrelated', '2026-01-01T00:00:01Z'),
    message('find me last', '2026-01-01T00:00:02Z'),
  ];
  const { hook, loadFullTranscript, revealMessage } = renderFind(messages);

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
  });
  expect(hook.result.current.isOpen).toBe(true);
  expect(loadFullTranscript).toHaveBeenCalledTimes(1);

  await act(async () => hook.result.current.setQuery('FIND ME'));
  expect(hook.result.current.matchCount).toBe(2);
  expect(hook.result.current.currentMatchNumber).toBe(2);
  expect(revealMessage).toHaveBeenLastCalledWith(messages[2]);

  act(() => hook.result.current.goToNext());
  expect(hook.result.current.currentMatchNumber).toBe(1);
  expect(revealMessage).toHaveBeenLastCalledWith(messages[0]);

  act(() => hook.result.current.goToPrevious());
  expect(hook.result.current.currentMatchNumber).toBe(2);
});

test('the current match stays put when older messages arrive in front of it', async () => {
  const tail = [message('needle new', '2026-01-01T00:00:05Z'), message('needle newer', '2026-01-01T00:00:06Z')];
  const { hook } = renderFind(tail);

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
  });
  await act(async () => hook.result.current.setQuery('needle'));
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
