import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionPermissionModeStore = {
  getSessionById(sessionId: string): { permission_mode: string | null } | null;
  setSessionPermissionMode(sessionId: string, permissionMode: string): void;
};

type SessionPermissionModeServiceDependencies = {
  sessions?: SessionPermissionModeStore;
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
};

/**
 * Keeps the permission mode each session runs in on its session row, so every
 * device shows the mode the chat really runs in instead of the mode last
 * picked in some other chat.
 */
export const createSessionPermissionModeService = (dependencies: SessionPermissionModeServiceDependencies = {}) => {
  const sessions = dependencies.sessions ?? sessionsDb;
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;

  const isKnownMode = (provider: LLMProvider, permissionMode: string): boolean => (
    providerCapabilitiesService.getProviderCapabilities(provider).permissionModes.includes(permissionMode)
  );

  /** Ignores a mode the provider does not offer, and a session the gateway has not created yet. */
  const record = (provider: LLMProvider, sessionId: string, permissionMode: string): void => {
    const normalizedMode = permissionMode.trim();
    if (!isKnownMode(provider, normalizedMode) || !sessions.getSessionById(sessionId)) {
      return;
    }
    sessions.setSessionPermissionMode(sessionId, normalizedMode);
  };

  /**
   * The mode recorded on the session row, else the mode the provider recorded
   * for the session's last prompt, else null when neither knows.
   */
  const resolve = async (provider: LLMProvider, sessionId: string): Promise<string | null> => {
    const recorded = sessions.getSessionById(sessionId)?.permission_mode?.trim();
    if (recorded && isKnownMode(provider, recorded)) {
      return recorded;
    }

    try {
      const providerMode = await resolveProvider(provider).models.getSessionPermissionMode?.(sessionId);
      return providerMode && isKnownMode(provider, providerMode) ? providerMode : null;
    } catch (error) {
      console.warn(`[permission-mode] Could not read the mode of session ${sessionId}:`, (error as Error)?.message || error);
      return null;
    }
  };

  return { record, resolve };
};

export const sessionPermissionModeService = createSessionPermissionModeService();
