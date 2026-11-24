import { sessionsDb, userDb } from '@/modules/database/index.js';
import { claudeBilling, claudeBillingAccountId } from '@/modules/usage/index.js';
import type { ClaudeBillingSwitchEvent } from '@/modules/usage/index.js';
import { chatRunRegistry, onRunSettled, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

const CONTINUE_MESSAGE = 'continue';
// A continue onto the same credential is not repeated within this window, so a switch that does not take cannot loop.
const RETRY_GUARD_MS = 2 * 60_000;
// A limit hit in a turn the CLI started itself has no run whose settling would send the continue.
const SETTLE_FALLBACK_MS = 5_000;

type BillingSwitches = Pick<typeof claudeBilling, 'onSwitch' | 'resolve'>;

let unsubscribeSwitch: (() => void) | null = null;
let unsubscribeSettled: (() => void) | null = null;
/** Chats stopped by a plan's limit whose turn has not settled yet, with the credential they move to. */
const pendingContinues = new Map<string, string>();
const lastContinueAt = new Map<string, number>();

/** Runs `continue` in the chat on the model, effort and permission mode it last ran with. */
async function sendContinue(sessionId: string, target: string, runtime: ProviderRuntimeGateway, interruptActiveRun: boolean): Promise<void> {
  const guardKey = `${sessionId}:${target}`;
  if (Date.now() - (lastContinueAt.get(guardKey) ?? 0) < RETRY_GUARD_MS) {
    console.warn(`[LimitContinue] Not continuing chat ${sessionId} on ${target} again so soon after the last automatic continue.`);
    return;
  }
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) return;
  lastContinueAt.set(guardKey, Date.now());
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
 * Moves chats between subscriptions and the API key without the user sending anything. A chat stopped by a plan's
 * limit is continued once its turn has settled, on the next subscription with room, or on the key when the user
 * armed it. A turn is interrupted and continued on a subscription earlier in the order once the runtime reports
 * that one back.
 */
export function initializeLimitContinue(runtime: ProviderRuntimeGateway, billing: BillingSwitches = claudeBilling): void {
  closeLimitContinue();
  const continueSoon = (sessionId: string, target: string, interruptActiveRun: boolean) => {
    sendContinue(sessionId, target, runtime, interruptActiveRun).catch((error: unknown) => {
      console.error(`[LimitContinue] Continuing chat ${sessionId} failed:`, error instanceof Error ? error.message : error);
    });
  };

  unsubscribeSwitch = billing.onSwitch((event: ClaudeBillingSwitchEvent) => {
    const target = claudeBillingAccountId(billing.resolve());
    if (!target || target === event.accountId) return;
    if (event.type === 'subscription-back') {
      continueSoon(event.sessionId, target, true);
      return;
    }
    pendingContinues.set(event.sessionId, target);
    setTimeout(() => {
      if (pendingContinues.has(event.sessionId) && !chatRunRegistry.isProcessing(event.sessionId)) {
        pendingContinues.delete(event.sessionId);
        continueSoon(event.sessionId, target, false);
      }
    }, SETTLE_FALLBACK_MS).unref?.();
  });

  unsubscribeSettled = onRunSettled((sessionId) => {
    const target = pendingContinues.get(sessionId);
    if (!target) return;
    pendingContinues.delete(sessionId);
    continueSoon(sessionId, target, false);
  });
}

export function closeLimitContinue(): void {
  unsubscribeSwitch?.();
  unsubscribeSettled?.();
  unsubscribeSwitch = null;
  unsubscribeSettled = null;
  pendingContinues.clear();
}
