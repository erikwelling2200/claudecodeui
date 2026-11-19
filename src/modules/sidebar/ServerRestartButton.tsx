import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';

import { useServerRestart } from '@/modules/sidebar/hooks/useServerRestart';
import { Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';

// A click arms the button; a second click within this window restarts. Long enough to read the hint, short enough
// that a stray click does not leave a red "Restart?" sitting in the sidebar.
const CONFIRM_WINDOW_MS = 5000;

type ServerRestartButtonProps = {
  t: TFunction;
  className?: string;
};

/** Rendered by SidebarFooter next to Settings: restarts the server process after a rebuild, with a two-click confirm. */
export default function ServerRestartButton({ t, className }: ServerRestartButtonProps) {
  const { status, restart } = useServerRestart();
  // True between the first click and either the confirming click or the window running out.
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (status === 'restarting') {
    return (
      <Tooltip content={t('server.restarting')} position="top">
        <span className={cn('flex h-7 w-7 items-center justify-center text-muted-foreground', className)} aria-live="polite">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </span>
      </Tooltip>
    );
  }

  if (status === 'failed') {
    return (
      <Tooltip content={t('server.failed')} position="top">
        <button
          type="button"
          className={cn('flex h-7 w-7 items-center justify-center rounded-lg text-amber-500 hover:bg-accent/60', className)}
          onClick={() => window.location.reload()}
          aria-label={t('server.failed')}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    );
  }

  if (armed) {
    return (
      <Tooltip content={t('server.confirmHint')} position="top">
        <button
          type="button"
          className={cn('flex h-7 items-center gap-1 rounded-lg bg-destructive/10 px-2 text-xs font-medium text-destructive hover:bg-destructive/20', className)}
          onClick={() => { setArmed(false); void restart(); }}
          onBlur={() => setArmed(false)}
          autoFocus
        >
          <RotateCw className="h-3.5 w-3.5" />
          {t('server.confirm')}
        </button>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={t('server.restart')} position="top">
      <button
        type="button"
        className={cn('flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground', className)}
        onClick={() => setArmed(true)}
        aria-label={t('server.restart')}
      >
        <RotateCw className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}
