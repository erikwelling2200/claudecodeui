import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { togglePinnedMessage, usePinnedMessages } from '@/modules/chat/utils/pinnedMessages';

const early = { text: 'early', timestamp: '2026-01-01T00:00:01.000Z' };
const late = { text: 'late', timestamp: '2026-01-01T00:00:09.000Z' };

describe('pinned messages', () => {
  it('keeps pins in transcript order, per session, and survives a re-read from storage', () => {
    const { result } = renderHook(() => usePinnedMessages('pin-s1'));
    act(() => togglePinnedMessage('pin-s1', late));
    act(() => togglePinnedMessage('pin-s1', early));

    expect(result.current.map((pin) => pin.text)).toEqual(['early', 'late']);
    expect(JSON.parse(window.localStorage.getItem('chat-pinned-messages:pin-s1') as string)).toHaveLength(2);
    expect(renderHook(() => usePinnedMessages('pin-s2')).result.current).toEqual([]);
  });

  it('unpins on a second toggle and clears the storage entry with the last pin', () => {
    const { result } = renderHook(() => usePinnedMessages('pin-s3'));
    act(() => togglePinnedMessage('pin-s3', early));
    act(() => togglePinnedMessage('pin-s3', { text: 'edited text, same message', timestamp: early.timestamp }));

    expect(result.current).toEqual([]);
    expect(window.localStorage.getItem('chat-pinned-messages:pin-s3')).toBeNull();
  });
});
