import { useEffect, useMemo, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ChatMessage, NormalizedMessage, SessionPrompt, SessionPromptBookends } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';

// Every history read parses the whole transcript on the server, so the search walks in large pages and gives up after a few.
const PROMPT_SEARCH_PAGE_SIZE = 100;
const PROMPT_SEARCH_MAX_PAGES = 10;

type HistoryPage = { messages: NormalizedMessage[]; total: number };

function toPrompt(message: ChatMessage): SessionPrompt {
  return { text: String(message.content), timestamp: String(message.timestamp) };
}

function userPrompts(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.type === 'user' && typeof message.content === 'string' && message.content.trim());
}

async function readHistoryPage(sessionId: string, limit: number, offset: number): Promise<HistoryPage> {
  const payload = await readApiJson<{ data: HistoryPage }>(await api.providers.sessionMessages(sessionId, { limit, offset }));
  return payload.data;
}

function firstPromptIn(messages: NormalizedMessage[]): SessionPrompt | null {
  const found = userPrompts(normalizedToChatMessages(messages))[0];
  return found ? toPrompt(found) : null;
}

function lastPromptIn(messages: NormalizedMessage[]): SessionPrompt | null {
  const found = userPrompts(normalizedToChatMessages(messages)).at(-1);
  return found ? toPrompt(found) : null;
}

/**
 * Reads the first and last user message from the server, walking in from each end of the transcript. The total comes
 * from the newest page itself, because the chat's own count can still belong to the previous session right after a switch.
 */
async function readPromptBookends(sessionId: string): Promise<SessionPromptBookends> {
  const newest = await readHistoryPage(sessionId, PROMPT_SEARCH_PAGE_SIZE, 0);
  const total = newest.total;

  let last = lastPromptIn(newest.messages);
  for (let page = 1; !last && page < PROMPT_SEARCH_MAX_PAGES && page * PROMPT_SEARCH_PAGE_SIZE < total; page += 1) {
    last = lastPromptIn((await readHistoryPage(sessionId, PROMPT_SEARCH_PAGE_SIZE, page * PROMPT_SEARCH_PAGE_SIZE)).messages);
  }

  // `offset` counts back from the newest message, so the oldest page lies `total - PAGE` messages back.
  let first: SessionPrompt | null = null;
  for (let page = 0; !first && page < PROMPT_SEARCH_MAX_PAGES; page += 1) {
    const pageEndFromNewest = total - page * PROMPT_SEARCH_PAGE_SIZE;
    if (pageEndFromNewest <= 0) break;
    const offset = Math.max(0, pageEndFromNewest - PROMPT_SEARCH_PAGE_SIZE);
    const messages = total <= PROMPT_SEARCH_PAGE_SIZE ? newest.messages : (await readHistoryPage(sessionId, pageEndFromNewest - offset, offset)).messages;
    first = firstPromptIn(messages);
  }

  return { first, last };
}

type UseSessionPromptBookendsArgs = {
  sessionId: string | null;
  chatMessages: ChatMessage[];
  hasMoreMessages: boolean;
};

/**
 * The first and last message the user sent in this chat. While the whole transcript is loaded both come from it; once
 * only its tail is, they are read from the server once per session, and a newer prompt in the loaded tail replaces the last.
 */
export function useSessionPromptBookends({ sessionId, chatMessages, hasMoreMessages }: UseSessionPromptBookendsArgs): SessionPromptBookends {
  const loadedPrompts = useMemo(() => userPrompts(chatMessages), [chatMessages]);
  // Bookends read from the server, tagged with the session they were read for so a switch discards them.
  const [fetched, setFetched] = useState<{ sessionId: string; bookends: SessionPromptBookends } | null>(null);

  useEffect(() => {
    if (!sessionId || !hasMoreMessages || fetched?.sessionId === sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const bookends = await readPromptBookends(sessionId);
        if (!cancelled) setFetched({ sessionId, bookends });
      } catch (error) {
        console.warn('Could not read the first and last prompt:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, hasMoreMessages, fetched]);

  const fetchedBookends = fetched?.sessionId === sessionId ? fetched.bookends : null;
  const loadedFirst = loadedPrompts[0];
  const loadedLast = loadedPrompts.at(-1);
  const first = hasMoreMessages ? fetchedBookends?.first ?? null : loadedFirst ? toPrompt(loadedFirst) : null;
  const last = loadedLast ? toPrompt(loadedLast) : hasMoreMessages ? fetchedBookends?.last ?? null : null;

  // Keyed on the values, not the message list, so streaming replies do not report unchanged bookends again.
  return useMemo(
    () => ({ first, last }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [first?.text, first?.timestamp, last?.text, last?.timestamp],
  );
}
