import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, NormalizedMessage } from '@/shared/types';
import { useSessionPromptBookends } from '@/modules/chat/hooks/useSessionPromptBookends';

// A 250-row transcript: user prompts at rows 0 and 120, everything else assistant text.
const TRANSCRIPT: NormalizedMessage[] = Array.from({ length: 250 }, (_, index) => ({
  id: `m${index}`,
  sessionId: 's1',
  provider: 'claude',
  kind: 'text',
  role: index === 0 || index === 120 ? 'user' : 'assistant',
  content: `row ${index}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
} as NormalizedMessage));

const sessionMessages = vi.fn((_sessionId: string, { limit, offset }: { limit: number; offset: number }) => {
  // The server slices back from the newest row, exactly like this.
  const end = TRANSCRIPT.length - offset;
  const messages = TRANSCRIPT.slice(Math.max(0, end - limit), end);
  return Promise.resolve(new Response(JSON.stringify({ success: true, data: { messages, total: TRANSCRIPT.length } })));
});

vi.mock('@/shared/api', () => ({
  api: { providers: { sessionMessages: (...args: [string, { limit: number; offset: number }]) => sessionMessages(...args) } },
  readApiJson: async (response: Response) => response.json(),
}));

const assistantTail: ChatMessage[] = [{ type: 'assistant', content: 'row 249', timestamp: TRANSCRIPT[249].timestamp }];

describe('useSessionPromptBookends', () => {
  beforeEach(() => { sessionMessages.mockClear(); });

  it('reads both bookends from the server when the loaded tail holds neither', async () => {
    const { result } = renderHook(() => useSessionPromptBookends({ sessionId: 's1', chatMessages: assistantTail, hasMoreMessages: true }));

    await waitFor(() => expect(result.current.first).not.toBeNull());
    expect(result.current.first?.text).toBe('row 0');
    expect(result.current.last?.text).toBe('row 120');
  });

  it('takes a newer prompt from the loaded tail over the one read from the server', async () => {
    const tail: ChatMessage[] = [...assistantTail, { type: 'user', content: 'just sent', timestamp: '2026-01-02T00:00:00.000Z' }];
    const { result } = renderHook(() => useSessionPromptBookends({ sessionId: 's1', chatMessages: tail, hasMoreMessages: true }));

    await waitFor(() => expect(result.current.first).not.toBeNull());
    expect(result.current.last?.text).toBe('just sent');
  });

  it('uses the loaded messages alone when the whole transcript is loaded', () => {
    const all: ChatMessage[] = [
      { type: 'user', content: 'hello', timestamp: 't1' },
      { type: 'assistant', content: 'hi', timestamp: 't2' },
      { type: 'user', content: 'bye', timestamp: 't3' },
    ];
    const { result } = renderHook(() => useSessionPromptBookends({ sessionId: 's1', chatMessages: all, hasMoreMessages: false }));

    expect(result.current).toEqual({ first: { text: 'hello', timestamp: 't1' }, last: { text: 'bye', timestamp: 't3' } });
    expect(sessionMessages).not.toHaveBeenCalled();
  });
});
