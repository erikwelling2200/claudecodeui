import { sessionsDb } from '@/modules/database/index.js';
import type { SessionTasksServices } from '@/shared/types.js';
import { createSessionTask, readSessionTasks, updateSessionTask } from '@/modules/session-tasks/services/session-tasks.service.js';
import { createSessionTasksRouter } from '@/modules/session-tasks/session-tasks.routes.js';

// The CLI names the task directory after its own session id, which a chat started in the app only gets once its CLI reports it.
function taskListId(sessionId: string): string {
  return sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;
}

/** Production composition of the session-tasks services. */
export const sessionTasksServices: SessionTasksServices = {
  listTasks: (sessionId) => readSessionTasks(taskListId(sessionId)),
  createTask: (sessionId, input) => createSessionTask(taskListId(sessionId), input),
  updateTask: (sessionId, taskId, update) => updateSessionTask(taskListId(sessionId), taskId, update),
};

/** Session-tasks router, mounted by the server entrypoint at `/api/session-tasks`. */
export const sessionTasksRoutes = createSessionTasksRouter(sessionTasksServices);
