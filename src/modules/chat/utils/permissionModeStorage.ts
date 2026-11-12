/**
 * The permission mode per chat, remembered in this browser.
 *
 * A chat with a session id reads only its own key: falling back to a mode
 * picked in another chat would show (and send) that chat's mode instead. The
 * per-provider "last" key is for a brand-new chat, which has no session id
 * until its first send, and is copied onto the session key the moment the id
 * exists. The server records every chat's mode as well, and its answer wins
 * once it arrives, so another device's switch is shown here too.
 */

const sessionKey = (sessionId: string): string => `permissionMode-${sessionId}`;
const lastKey = (provider: string): string => `permissionMode-last-${provider}`;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The mode still holds for this page; it is just not remembered.
  }
}

export const readSessionPermissionMode = (sessionId: string): string | null => readStored(sessionKey(sessionId));

export const writeSessionPermissionMode = (sessionId: string, mode: string): void => writeStored(sessionKey(sessionId), mode);

export const readLastPermissionMode = (provider: string): string | null => readStored(lastKey(provider));

export const writeLastPermissionMode = (provider: string, mode: string): void => writeStored(lastKey(provider), mode);
