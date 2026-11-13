import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Lock, Regex, Replace, ReplaceAll, WholeWord, X } from 'lucide-react';

import type { FileSearchOptions } from '@/modules/code-editor/utils/fileSearch';
import type { FileFindState } from '@/modules/code-editor/hooks/useFileFind';

type CodeEditorFindBarProps = {
  find: FileFindState;
  isReadOnly: boolean;
  // Bumped by every Ctrl+F, so pressing it again while the bar is open refocuses and selects the query.
  focusRequest: number;
};

const ICON_BUTTON_CLASS = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent';
const FIELD_CLASS = 'flex min-w-0 flex-1 items-center gap-0.5 rounded-md border bg-background py-0.5 pl-2 pr-0.5 transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15';

function OptionToggle({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-sm transition-colors ${
        active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/** Rendered by CodeEditorFrame inside the code-editor module, floating over the top of any file view; state lives in useFileFind. */
export default function CodeEditorFindBar({ find, isReadOnly, focusRequest }: CodeEditorFindBarProps) {
  const { t } = useTranslation('codeEditor');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const toggleOption = (option: keyof FileSearchOptions) => find.setOptions((previous) => ({ ...previous, [option]: !previous[option] }));

  const handleFindKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) find.goToPrevious();
      else find.goToNext();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      find.close();
    } else if (event.altKey && ['c', 'w', 'r'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      toggleOption(({ c: 'matchCase', w: 'wholeWord', r: 'regex' } as const)[event.key.toLowerCase() as 'c' | 'w' | 'r']);
    }
  };

  const handleReplaceKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) find.replaceAll();
      else find.replaceCurrent();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      find.close();
    }
  };

  const hasQuery = find.text.length > 0;
  const noResults = hasQuery && !find.isInvalidPattern && find.matchCount === 0;
  const counter = !hasQuery
    ? ''
    : find.isInvalidPattern
      ? t('find.invalidPattern', 'Invalid pattern')
      : find.matchCount === 0
        ? t('find.noResults', 'No results')
        : t('find.position', '{{current}} of {{count}}', { current: find.currentIndex + 1, count: find.matchCount });
  const fieldBorder = find.isInvalidPattern || noResults ? 'border-red-400/70 dark:border-red-500/60' : 'border-border';

  return (
    <div
      role="search"
      className="absolute right-3 top-2 z-30 flex w-[min(28rem,calc(100%-1.5rem))] items-start gap-1 rounded-lg border border-border bg-card/95 p-1.5 shadow-lg backdrop-blur-sm"
    >
      {find.canReplace ? (
        <button
          type="button"
          className={`${ICON_BUTTON_CLASS} mt-0.5`}
          onClick={() => find.setShowReplace((previous) => !previous)}
          aria-expanded={find.showReplace}
          title={t('find.toggleReplace', 'Toggle replace (Ctrl+H)')}
          aria-label={t('find.toggleReplace', 'Toggle replace (Ctrl+H)')}
        >
          {find.showReplace ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      ) : isReadOnly && (
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground" title={t('find.readOnly', 'Read-only')}>
          <Lock className="h-3.5 w-3.5" aria-label={t('find.readOnly', 'Read-only')} />
        </span>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1">
          <div className={`${FIELD_CLASS} ${fieldBorder}`}>
            <input
              ref={inputRef}
              type="text"
              value={find.text}
              onChange={(event) => find.setText(event.target.value)}
              onKeyDown={handleFindKeyDown}
              placeholder={t('find.placeholder', 'Find')}
              aria-label={t('find.placeholder', 'Find')}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <OptionToggle active={find.options.matchCase} label={t('find.matchCase', 'Match case (Alt+C)')} onClick={() => toggleOption('matchCase')}>
              <CaseSensitive className="h-4 w-4" />
            </OptionToggle>
            <OptionToggle active={find.options.wholeWord} label={t('find.wholeWord', 'Whole word (Alt+W)')} onClick={() => toggleOption('wholeWord')}>
              <WholeWord className="h-4 w-4" />
            </OptionToggle>
            <OptionToggle active={find.options.regex} label={t('find.regex', 'Regular expression (Alt+R)')} onClick={() => toggleOption('regex')}>
              <Regex className="h-3.5 w-3.5" />
            </OptionToggle>
          </div>
          <span
            className={`min-w-[4.5rem] whitespace-nowrap text-right text-xs tabular-nums ${noResults || find.isInvalidPattern ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground'}`}
            aria-live="polite"
          >
            {counter}
          </span>
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={find.goToPrevious}
            disabled={find.matchCount === 0}
            title={t('find.previous', 'Previous match (Shift+Enter)')}
            aria-label={t('find.previous', 'Previous match (Shift+Enter)')}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={find.goToNext}
            disabled={find.matchCount === 0}
            title={t('find.next', 'Next match (Enter)')}
            aria-label={t('find.next', 'Next match (Enter)')}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={find.close}
            title={t('find.close', 'Close (Esc)')}
            aria-label={t('find.close', 'Close (Esc)')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {find.showReplace && (
          <div className="flex items-center gap-1">
            <div className={`${FIELD_CLASS} border-border`}>
              <input
                type="text"
                value={find.replacement}
                onChange={(event) => find.setReplacement(event.target.value)}
                onKeyDown={handleReplaceKeyDown}
                placeholder={t('find.replacePlaceholder', 'Replace')}
                aria-label={t('find.replacePlaceholder', 'Replace')}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent py-0.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <button
              type="button"
              className={ICON_BUTTON_CLASS}
              onClick={find.replaceCurrent}
              disabled={find.matchCount === 0}
              title={t('find.replace', 'Replace (Enter)')}
              aria-label={t('find.replace', 'Replace (Enter)')}
            >
              <Replace className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={ICON_BUTTON_CLASS}
              onClick={find.replaceAll}
              disabled={find.matchCount === 0}
              title={t('find.replaceAll', 'Replace all (Ctrl+Enter)')}
              aria-label={t('find.replaceAll', 'Replace all (Ctrl+Enter)')}
            >
              <ReplaceAll className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
