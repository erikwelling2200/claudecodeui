import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ServerEvent, SessionWorktree } from '@/shared/types';

type UseSessionWorktreesResult = {
  worktrees: SessionWorktree[];
  // Counts up each time the list was read again, so a file tree can reload on a change without comparing lists.
  revision: number;
};

/**
 * The worktrees a chat works in. Read when the chat is opened and again when
 * the server announces a change (`session_worktrees_changed`), which the
 * worktree-lock hook causes from inside the chat's own CLI, and on a reconnect
 * because an announcement sent while the socket was down is lost.
 */
export function useSessionWorktrees(
  sessionId: string | null,
  subscribe?: (listener: (event: ServerEvent) => void) => () => void,
): UseSessionWorktreesResult {
  const [worktrees, setWorktrees] = useState<SessionWorktree[]>([]);
  const [revision, setRevision] = useState(0);
  const activeSessionRef = useRef(sessionId);
  const latestRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const request = ++latestRequestRef.current;
    try {
      const response = await api.worktreeClaims.sessionWorktrees(sessionId);
      const payload = await response.json();
      if (activeSessionRef.current !== sessionId || request !== latestRequestRef.current) return;
      setWorktrees(Array.isArray(payload?.data) ? payload.data : []);
      setRevision((previous) => previous + 1);
    } catch (error) {
      console.error('Failed to load the chat\'s worktrees:', error);
    }
  }, [sessionId]);

  // Cleared during the switch render so the previous chat's worktrees never paint over the new one.
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setWorktrees([]);
  }

  useEffect(() => {
    activeSessionRef.current = sessionId;
    void refresh();
  }, [refresh, sessionId]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.kind === 'websocket_reconnected' || (event.kind === 'session_worktrees_changed' && event.sessionId === sessionId)) {
        void refresh();
      }
    });
  }, [refresh, sessionId, subscribe]);

  return { worktrees, revision };
}
