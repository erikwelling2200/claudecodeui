/**
 * Sessions the user has to come back to: waiting on an answer, or holding
 * output they have not seen. Mirrors the sidebar's dots, which hide the unread
 * marker while a session is still busy, so the badge never counts a chat the
 * sidebar shows as running.
 */
export function countSessionsNeedingUser(
  attentionSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
  busySessionIds: ReadonlySet<string>,
): number {
  let count = attentionSessionIds.size;
  for (const sessionId of unreadSessionIds) {
    if (!attentionSessionIds.has(sessionId) && !busySessionIds.has(sessionId)) {
      count += 1;
    }
  }
  return count;
}

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Shows `count` on the installed app's taskbar / dock icon. The Badging API
 * only exists for an installed PWA in a secure context, so in a plain browser
 * tab this does nothing.
 */
export function applyAppBadge(count: number): void {
  if (typeof navigator === 'undefined') {
    return;
  }

  const badgingNavigator = navigator as BadgingNavigator;
  const request = count > 0 ? badgingNavigator.setAppBadge?.(count) : badgingNavigator.clearAppBadge?.();
  // Rejects when the app is not installed or the permission is withheld; there is nothing to fall back to.
  void request?.catch(() => undefined);
}
