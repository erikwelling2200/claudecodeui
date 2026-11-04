import { useEffect } from 'react';

import { usePaletteOpsRegister } from '@/modules/command-palette';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import { useProjectEffectsState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { applyAppBadge, countSessionsNeedingUser } from '@/modules/project-workspace/utils/appBadge';
import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import type { LLMProvider, ProjectWorkspaceShellProps } from '@/shared/types';

/** Headless controller rendered by ProjectWorkspaceShell to register palette operations, handle service-worker navigation messages and keep the app icon badge current. */
export default function ProjectEffects({
  navigate,
}: Pick<ProjectWorkspaceShellProps, 'navigate'>) {
  const {
    openSettings,
    refreshProjectsSilently,
    setActiveTab,
    setSidebarOpen,
    attentionSessionIds,
    unreadSessionIds,
  } = useProjectEffectsState();
  const busySessionIds = useBusySessionIdSet();
  const badgeCount = countSessionsNeedingUser(attentionSessionIds, unreadSessionIds, busySessionIds);

  useEffect(() => {
    applyAppBadge(badgeCount);
  }, [badgeCount]);

  useEffect(() => () => applyAppBadge(0), []);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        writeSelectedProvider(message.provider as LLMProvider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  return null;
}
