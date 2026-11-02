import { useTranslation } from 'react-i18next';
import { ArrowUpIcon, XIcon } from 'lucide-react';

type PendingSteerCardProps = {
  content: string;
  attachmentCount?: number;
  interrupting: boolean;
  cancelling: boolean;
  onSendNow: () => void;
  onCancel: () => void;
};

/**
 * Rendered by chat's ChatComposer for a message sent while Claude works, until
 * the CLI takes it into the turn at its next step. The arrow interrupts the
 * step in progress so the message goes in at once; the cross drops it unsent.
 */
export default function PendingSteerCard({
  content,
  attachmentCount = 0,
  interrupting,
  cancelling,
  onSendNow,
  onCancel,
}: PendingSteerCardProps) {
  const { t } = useTranslation('chat');
  const busy = interrupting || cancelling;
  const buttonClassName = 'shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground '
    + 'disabled:pointer-events-none disabled:opacity-40';

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
            <span>{t('input.steer.label', { defaultValue: 'Pending' })}</span>
            <span className="normal-case text-muted-foreground/60">
              · {cancelling
                ? t('input.steer.cancelling', { defaultValue: 'Cancelling' })
                : interrupting
                  ? t('input.steer.interrupting', { defaultValue: 'Interrupting' })
                  : t('input.steer.nextStep', { defaultValue: 'Sends at the next step' })}
            </span>
          </div>
          <p
            tabIndex={0}
            className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-sm text-sm text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {content}
          </p>
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('input.steer.attachments', { count: attachmentCount, defaultValue: '{{count}} attached' })}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onSendNow}
          disabled={busy}
          aria-label={t('input.steer.sendNow', { defaultValue: 'Interrupt and send now' })}
          title={t('input.steer.sendNow', { defaultValue: 'Interrupt and send now' })}
          className={buttonClassName}
        >
          <ArrowUpIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label={t('input.steer.cancel', { defaultValue: 'Cancel pending message' })}
          title={t('input.steer.cancel', { defaultValue: 'Cancel pending message' })}
          className={`-ml-1.5 ${buttonClassName}`}
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
