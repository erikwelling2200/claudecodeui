import { sessionsDb, userDb } from '@/modules/database/index.js';
import { claudeBilling } from '@/modules/usage/index.js';
import type { ClaudeBillingSwitchEvent } from '@/modules/usage/index.js';
import { chatRunRegistry, onRunSettled, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

const CONTINUE_MESSAGE = 'continue';
// A continue that hits the same wall again within this window is not retried, so a stuck switch cannot loop.
const RETRY_GUARD_MS = 2 * 60_000;
// A limit hit in a turn the CLI started itself has no run whose settling would send the continue.
const SETTLE_FALLBACK_MS = 5_000;

type BillingSwitches = Pick<typeof claudeBilling, 'onSwitch' | 'resolve'>;

let unsubscribeSwitch: (() => void) | null = null;
let unsubscribeSettled: (() => void) | null = null;
/** Chats stopped by the plan's limit whose turn has not settled yet. */
const pendingContinues = new Set<string>();
const lastContinueAt = new Map<string, number>();

/** Runs `continue` in the chat on the model, effort and permission mode it last ran with. */
async function sendContinue(sessionId: string, runtime: ProviderRuntimeGateway, interruptActiveRun: boolean): Promise<void> {
  const last = lastContinueAt.get(sessionId) ?? 0;
  if (Date.now() - last < RETRY_GUARD_MS) {
    console.warn(`[LimitContinue] Not continuing chat ${sessionId} again so soon after the last automatic continue.`);
    return;
  }
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) return;
  lastContinueAt.set(sessionId, Date.now());
  const options = {
    ...(session.model ? { model: session.model } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    ...(session.permission_mode ? { permissionMode: session.permission_mode } : {}),
  };
  const result = await runDetachedChatTurn(
    { sessionId, userId: userDb.getFirstUser()?.id ?? null, content: CONTINUE_MESSAGE, options, interruptActiveRun },
    { runtime },
  );
  if (result.error) console.error(`[LimitContinue] Continuing chat ${sessionId} failed: ${result.error}`);
}

/**
 * Moves chats between the plan and the API key without the user sending anything. A chat stopped by the plan's
 * limit is continued once its turn has settled, if the user armed the switch to the key. A turn running on the key
 * is interrupted and continued on the plan once the runtime reports the plan back.
 */
export function initializeLimitContinue(runtime: ProviderRuntimeGateway, billing: BillingSwitches = claudeBilling): void {
  closeLimitContinue();
  const continueSoon = (sessionId: string, interruptActiveRun: boolean) => {
    sendContinue(sessionId, runtime, interruptActiveRun).catch((error: unknown) => {
      console.error(`[LimitContinue] Continuing chat ${sessionId} failed:`, error instanceof Error ? error.message : error);
    });
  };

  unsubscribeSwitch = billing.onSwitch((event: ClaudeBillingSwitchEvent) => {
    if (event.type === 'subscription-back') {
      continueSoon(event.sessionId, true);
      return;
    }
    if (billing.resolve().mode !== 'api_key') return;
    pendingContinues.add(event.sessionId);
    setTimeout(() => {
      if (pendingContinues.has(event.sessionId) && !chatRunRegistry.isProcessing(event.sessionId)) {
        pendingContinues.delete(event.sessionId);
        continueSoon(event.sessionId, false);
      }
    }, SETTLE_FALLBACK_MS).unref?.();
  });

  unsubscribeSettled = onRunSettled((sessionId) => {
    if (pendingContinues.delete(sessionId)) continueSoon(sessionId, false);
  });
}

export function closeLimitContinue(): void {
  unsubscribeSwitch?.();
  unsubscribeSettled?.();
  unsubscribeSwitch = null;
  unsubscribeSettled = null;
  pendingContinues.clear();
}
