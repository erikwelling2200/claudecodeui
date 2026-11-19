import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/shared/api';

type ResolvedChat = {
  sessionId: string;
  name: string;
};

// One lookup per id for the whole page: a transcript can mention the same chat many times.
const resolvedChats = new Map<string, Promise<ResolvedChat | null>>();

const resolveChat = (chatId: string): Promise<ResolvedChat | null> => {
  const cached = resolvedChats.get(chatId);
  if (cached) {
    return cached;
  }
  const lookup = api.sessionDetails(chatId).then(async (response) => {
    // A 404 is the common case: most UUIDs in a transcript are not chats.
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { data?: { sessionId?: string; summary?: string } };
    const sessionId = payload.data?.sessionId;
    return sessionId ? { sessionId, name: payload.data?.summary?.trim() || chatId.slice(0, 8) } : null;
  });
  // A network failure is not an answer, so the next render may try again.
  lookup.catch(() => resolvedChats.delete(chatId));
  resolvedChats.set(chatId, lookup);
  return lookup;
};

/** The chat a Claude session id names, or null while it is looked up and when it names none. */
function useResolvedChat(chatId: string): ResolvedChat | null {
  // The server's answer for an id, kept with that id so a changed prop never shows the previous chat.
  const [lookup, setLookup] = useState<{ chatId: string; chat: ResolvedChat | null } | null>(null);

  useEffect(() => {
    let active = true;
    resolveChat(chatId).then(
      (resolved) => active && setLookup({ chatId, chat: resolved }),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [chatId]);

  return lookup?.chatId === chatId ? lookup.chat : null;
}

type ChatReferenceProps = {
  chatId: string;
  /** Rendered while the id is being looked up, and for good when it is not a known chat. */
  fallback: ReactNode;
};

/** Used by Markdown to turn a chat id an agent wrote into a button that opens that chat. */
export function ChatReference({ chatId, fallback }: ChatReferenceProps) {
  const navigate = useNavigate();
  const chat = useResolvedChat(chatId);

  if (!chat) {
    return <>{fallback}</>;
  }

  return (
    <button
      type="button"
      title={chatId}
      onClick={() => navigate(`/session/${chat.sessionId}`)}
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-muted px-1.5 py-0.5 align-baseline text-[0.875em] text-blue-600 hover:underline dark:text-blue-400"
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{chat.name}</span>
    </button>
  );
}

type ChatAvatarReferenceProps = {
  chatId: string;
  className: string;
  /** Shown on hover until the chat is resolved, and when it never is. */
  title: string;
};

/** Used by MessageComponent as the avatar of a message another chat sent: opens that chat once it is known. */
export function ChatAvatarReference({ chatId, className, title }: ChatAvatarReferenceProps) {
  const navigate = useNavigate();
  const chat = useResolvedChat(chatId);
  const icon = <MessageSquare className="h-4 w-4" aria-hidden />;

  if (!chat) {
    return <div title={title} className={className}>{icon}</div>;
  }

  return (
    <button
      type="button"
      title={chat.name}
      aria-label={chat.name}
      onClick={() => navigate(`/session/${chat.sessionId}`)}
      className={`${className} cursor-pointer hover:ring-2 hover:ring-purple-300`}
    >
      {icon}
    </button>
  );
}
