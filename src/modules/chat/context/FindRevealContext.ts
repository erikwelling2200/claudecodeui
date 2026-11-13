import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

import type { ChatMessage } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

/** The message holding the in-chat find's current hit, and a counter that rises with every jump to a hit. */
type FindRevealTarget = { messageKey: string; request: number };

/**
 * Holds the find's reveal target outside React state, so a jump re-renders only the rows it concerns rather than
 * every message in the transcript.
 */
export type FindRevealStore = {
  get: () => FindRevealTarget | null;
  set: (message: ChatMessage) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createFindRevealStore(): FindRevealStore {
  let target: FindRevealTarget | null = null;
  let request = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => target,
    set: (message) => {
      request += 1;
      target = { messageKey: getFindMessageKey(message), request };
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Provided by ChatInterface around the transcript; null where no find bar exists (exports). */
export const FindRevealContext = createContext<FindRevealStore | null>(null);

/** How find identifies a message across re-normalisations of the transcript, which replace the objects. */
export function getFindMessageKey(message: ChatMessage): string {
  return getIntrinsicMessageKey(message) ?? String(message.timestamp);
}

const NO_TARGET = () => 0;
const NO_SUBSCRIPTION = () => () => {};

/** The current reveal request when the find hit is in one of `messages`, else 0; feeds DisclosureRevealContext. */
export function useFindRevealRequest(messages: ChatMessage[]): number {
  const store = useContext(FindRevealContext);
  const getSnapshot = useCallback(() => {
    const target = store?.get();
    if (!target) return 0;
    return messages.some((message) => getFindMessageKey(message) === target.messageKey) ? target.request : 0;
  }, [messages, store]);
  const snapshot = store ? getSnapshot : NO_TARGET;
  // The export renders the transcript to static markup, which needs a server snapshot too.
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIPTION, snapshot, snapshot);
}
