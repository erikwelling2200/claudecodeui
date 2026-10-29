import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { api } from '@/shared/api';
import type { ArchivedSessionListItem, SnippetHighlight } from '@/shared/types';
import { Dialog, DialogContent, DialogTitle, HighlightedSnippet, LLMProviderLogo } from '@/shared/ui';
import { formatCompactAge } from '@/shared/utils';

type ArchivedSessionsPayload = {
  data?: { sessions?: ArchivedSessionListItem[] };
};

/** The first message the user typed into an archived session that matches the search. */
type MessageMatch = {
  sessionId: string;
  snippet: string;
  highlights: SnippetHighlight[];
};

type MessageMatchesPayload = {
  data?: { sessions?: MessageMatch[] };
};

/** The server rejects transcript searches shorter than this. */
const MIN_MESSAGE_QUERY_LENGTH = 2;
const MESSAGE_SEARCH_DEBOUNCE_MS = 250;
const NO_MESSAGE_MATCHES: ReadonlyMap<string, MessageMatch> = new Map();

type ArchivedChatsModalProps = {
  onClose: () => void;
};

/**
 * Lists archived chats, most recent turn first, and reopens the one picked:
 * it is restored to the sidebar and navigated to. The search matches titles
 * locally and the user's own messages through the server.
 */
export default function ArchivedChatsModal({ onClose }: ArchivedChatsModalProps) {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();

  // Archived sessions as the server orders them (latest turn first); null until loaded.
  const [sessions, setSessions] = useState<ArchivedSessionListItem[] | null>(null);
  // The search box text, driving both the title filter and the message search.
  const [searchQuery, setSearchQuery] = useState('');
  // The last finished message search, tagged with its query so a stale answer is never shown for a newer one.
  const [messageSearch, setMessageSearch] = useState<{ query: string; matches: ReadonlyMap<string, MessageMatch> } | null>(null);
  // The session being restored, so its row shows progress and a double click cannot restore twice.
  const [reopeningSessionId, setReopeningSessionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await api.getArchivedSessions();
      if (!response.ok) {
        throw new Error(`Failed to load archived sessions: ${response.status}`);
      }
      const payload = (await response.json()) as ArchivedSessionsPayload;
      if (!cancelled) {
        setSessions(payload.data?.sessions ?? []);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedQuery = searchQuery.trim();
  const searchesMessages = trimmedQuery.length >= MIN_MESSAGE_QUERY_LENGTH;
  const messageMatches = messageSearch?.query === trimmedQuery ? messageSearch.matches : NO_MESSAGE_MATCHES;
  const isSearchingMessages = searchesMessages && messageSearch?.query !== trimmedQuery;

  useEffect(() => {
    if (trimmedQuery.length < MIN_MESSAGE_QUERY_LENGTH) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await api.searchArchivedSessions(trimmedQuery, controller.signal);
          if (!response.ok) {
            throw new Error(`Archived message search failed: ${response.status}`);
          }
          const payload = (await response.json()) as MessageMatchesPayload;
          const matches = new Map((payload.data?.sessions ?? []).map((match) => [match.sessionId, match]));
          setMessageSearch({ query: trimmedQuery, matches });
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          console.error('[ArchivedChats] Message search failed:', error);
          setMessageSearch({ query: trimmedQuery, matches: NO_MESSAGE_MATCHES });
        }
      })();
    }, MESSAGE_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery]);

  const visibleSessions = useMemo(() => {
    if (!sessions || !trimmedQuery) {
      return sessions ?? [];
    }

    const loweredQuery = trimmedQuery.toLocaleLowerCase();
    return sessions.filter((session) =>
      session.sessionTitle.toLocaleLowerCase().includes(loweredQuery) || messageMatches.has(session.sessionId));
  }, [messageMatches, sessions, trimmedQuery]);

  const reopenSession = async (sessionId: string) => {
    if (reopeningSessionId) {
      return;
    }

    setReopeningSessionId(sessionId);
    try {
      const response = await api.restoreSession(sessionId);
      if (!response.ok) {
        throw new Error(`Failed to restore session: ${response.status}`);
      }
      onClose();
      navigate(`/session/${sessionId}`);
    } catch (error) {
      console.error('[ArchivedChats] Reopen failed:', error);
      alert(t('archivedChats.reopenFailed', { defaultValue: 'Could not reopen this chat.' }));
    } finally {
      setReopeningSessionId(null);
    }
  };

  const currentTime = new Date();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <DialogTitle>{t('archivedChats.title', { defaultValue: 'Archived chats' })}</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border/60 px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('archivedChats.search', { defaultValue: 'Search archived chats' })}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {isSearchingMessages && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>

        <div className="max-h-[min(60dvh,28rem)] overflow-y-auto p-1.5">
          {sessions === null ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : visibleSessions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {trimmedQuery
                ? t('archivedChats.noMatches', { defaultValue: 'No matching chats' })
                : t('archivedChats.empty', { defaultValue: 'No archived chats' })}
            </p>
          ) : (
            visibleSessions.map((session) => {
              const messageMatch = messageMatches.get(session.sessionId);
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  disabled={reopeningSessionId !== null}
                  onClick={() => void reopenSession(session.sessionId)}
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent disabled:cursor-wait"
                >
                  <LLMProviderLogo provider={session.provider} className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm text-foreground">{session.sessionTitle}</span>
                      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {reopeningSessionId === session.sessionId
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : formatCompactAge(session.lastActivity, currentTime)}
                      </span>
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">{session.projectDisplayName}</p>
                    {messageMatch && (
                      <div className="mt-1 flex">
                        <HighlightedSnippet snippet={messageMatch.snippet} highlights={messageMatch.highlights} />
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
