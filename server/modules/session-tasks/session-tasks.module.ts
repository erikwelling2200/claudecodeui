import { sessionsDb } from '@/modules/database/index.js';
import type { SessionTasksServices } from '@/shared/types.js';
import { readSessionTasks } from '@/modules/session-tasks/services/session-tasks.service.js';
import { createSessionTasksRouter } from '@/modules/session-tasks/session-tasks.routes.js';

/** Production composition of the session-tasks services. */
const sessionTasksServices: SessionTasksServices = {
  // The CLI names the task directory after its own session id, which a chat started in the app only gets once its CLI reports it.
  listTasks: (sessionId) => readSessionTasks(sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId),
};

/** Session-tasks router, mounted by the server entrypoint at `/api/session-tasks`. */
export const sessionTasksRoutes = createSessionTasksRouter(sessionTasksServices);
