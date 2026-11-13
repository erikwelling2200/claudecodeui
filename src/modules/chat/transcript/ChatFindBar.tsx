import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import type { RefObject } from 'react';

type ChatFindBarProps = {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  onQueryChange: (query: string) => void;
  matchCount: number;
  /** 1-based position of the current match; 0 when there is none. */
  currentMatchNumber: number;
  isLoadingTranscript: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
};

const BUTTON_CLASS = 'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent';

/** The Ctrl+F bar floating over the top of a chat's transcript; state lives in useChatFind. */
export default function ChatFindBar({
  inputRef,
  query,
  onQueryChange,
  matchCount,
  currentMatchNumber,
  isLoadingTranscript,
  onNext,
  onPrevious,
  onClose,
}: ChatFindBarProps) {
  const { t } = useTranslation('chat');
  const hasQuery = query.trim().length > 0;

  return (
    <div
      role="search"
      className="absolute right-4 top-2 z-30 flex items-center gap-1 rounded-md border border-border bg-card py-1 pl-2 pr-1 shadow-md"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={t('find.placeholder', { defaultValue: 'Find in chat' })}
        aria-label={t('find.placeholder', { defaultValue: 'Find in chat' })}
        className="w-44 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground sm:w-56"
      />
      <span className="min-w-14 text-right text-xs tabular-nums text-muted-foreground" aria-live="polite">
        {isLoadingTranscript && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden />}
        {hasQuery && `${matchCount === 0 ? 0 : currentMatchNumber}/${matchCount}`}
      </span>
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={onPrevious}
        disabled={matchCount === 0}
        title={t('find.previous', { defaultValue: 'Previous match (Shift+Enter)' })}
        aria-label={t('find.previous', { defaultValue: 'Previous match (Shift+Enter)' })}
      >
        <ChevronUp className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={onNext}
        disabled={matchCount === 0}
        title={t('find.next', { defaultValue: 'Next match (Enter)' })}
        aria-label={t('find.next', { defaultValue: 'Next match (Enter)' })}
      >
        <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={onClose}
        title={t('find.close', { defaultValue: 'Close (Esc)' })}
        aria-label={t('find.close', { defaultValue: 'Close (Esc)' })}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
