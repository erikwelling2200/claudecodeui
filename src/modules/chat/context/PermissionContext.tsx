import { createContext, useContext } from 'react';

import type { PendingPermissionRequest } from '@/shared/types';

export type PermissionContextValue = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  /** Approves a pending plan and leaves plan mode for the mode the build runs in. */
  handlePlanBuild: (requestId: string) => void;
};

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;
