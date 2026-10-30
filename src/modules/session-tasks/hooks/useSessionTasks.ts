import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { SessionTask } from '@/shared/types';

// The CLI writes task files as it goes and announces nothing, so the list is polled like the claims beside it.
const REFRESH_INTERVAL_MS = 5000;

/** Polls the task list the chat's CLI keeps, so the panel can hide itself while there is none. */
export function useSessionTasks(sessionId: string | null): SessionTask[] {
  const [tasks, setTasks] = useState<SessionTask[]>([]);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setTasks([]);
      return;
    }
    try {
      const payload = await readApiJson<{ data: { tasks: SessionTask[] } }>(await api.sessionTasks.list(sessionId));
      setTasks(payload.data.tasks);
    } catch (error) {
      console.warn('Could not read session tasks:', error);
      setTasks([]);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  return tasks;
}
