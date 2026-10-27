import { sessionsDb } from '@/modules/database/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { killShellSessionsForChat } from '@/modules/websocket/services/shell-websocket.service.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * Stops every process the app itself runs for one app session: an active chat
 * run, a provider process kept between turns (with or without background
 * work), and any Shell-tab pty resumed on the session.
 *
 * Used by the providers module's sessions service (wired in `server/index.ts`)
 * before it archives or deletes a session on request.
 * @returns True when anything was stopped, so the caller knows to let the transcript settle.
 */
export async function stopAppSessionProcesses(
  sessionId: string,
  runtime: Pick<ProviderRuntimeGateway, 'abort' | 'hasBackgroundWork' | 'releaseIdleProcess'>,
): Promise<boolean> {
  let stopped = false;

  const run = chatRunRegistry.getRun(sessionId);
  if (run?.status === 'running') {
    // Same sequence as `chat.abort`, so subscribed clients get the aborted complete.
    const aborted = await runtime.abort(run.provider, sessionId);
    chatRunRegistry.completeRun(sessionId, { exitCode: aborted ? 0 : 1, aborted: true });
    stopped = true;
  } else if (runtime.hasBackgroundWork(sessionId)) {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" holds background work but has no session row.`);
    }
    stopped = await runtime.abort(session.provider as LLMProvider, sessionId);
  } else {
    stopped = runtime.releaseIdleProcess(sessionId);
  }

  const killedShells = await killShellSessionsForChat(sessionId);
  return stopped || killedShells > 0;
}
