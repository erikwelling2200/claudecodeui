import { useEffect, useRef } from 'react';
import { PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CodeEditorTab } from '@/shared/types';

type CodeEditorTabsProps = {
  tabs: CodeEditorTab[];
  activeTabKey: string | null;
  dirtyTabKeys: ReadonlySet<string>;
  onActivateTab: (tabKey: string) => void;
  // Asks before discarding a dirty tab; the owner decides.
  onRequestCloseTab: (tabKey: string) => void;
  // Hides the docked panel; null while the editor floats, where there is no panel to hide.
  onHide: (() => void) | null;
};

/** Rendered by CodeEditor, above the active file, from the tabs EditorSidebar keeps: one per open file. */
export default function CodeEditorTabs({ tabs, activeTabKey, dirtyTabKeys, onActivateTab, onRequestCloseTab, onHide }: CodeEditorTabsProps) {
  const { t } = useTranslation('codeEditor');
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  // A tab opened off-screen, such as by go to definition, scrolls into view.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabKey]);

  return (
    <div className="flex flex-shrink-0 border-b border-border bg-muted/40 text-xs">
      <div role="tablist" className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:thin]">
        {tabs.map((tab) => {
          const isActive = tab.key === activeTabKey;
          const isDirty = dirtyTabKeys.has(tab.key);
          return (
            <div
              key={tab.key}
              ref={isActive ? activeTabRef : undefined}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              title={tab.file.path}
              onClick={() => onActivateTab(tab.key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onActivateTab(tab.key);
              }}
              // Middle-click closes, as in VS Code.
              onAuxClick={(event) => {
                if (event.button === 1) onRequestCloseTab(tab.key);
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              className={`group flex max-w-[220px] flex-shrink-0 cursor-pointer items-center gap-1.5 border-r border-border py-1.5 pl-3 pr-1.5 ${
                isActive
                  ? 'bg-background text-foreground shadow-[inset_0_-2px_0_hsl(var(--primary))]'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <span className="truncate">{tab.file.name}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRequestCloseTab(tab.key);
                }}
                className="relative flex h-4 w-4 flex-shrink-0 items-center justify-center rounded hover:bg-muted-foreground/20"
                title={t('tabs.close')}
                aria-label={`${t('tabs.close')} ${tab.file.name}`}
              >
                {isDirty && (
                  <span aria-hidden="true" className="absolute h-2 w-2 rounded-full bg-current group-hover:hidden" />
                )}
                <svg
                  aria-hidden="true"
                  className={`h-3 w-3 ${isDirty ? 'hidden group-hover:block' : isActive ? '' : 'invisible group-hover:visible'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      {onHide && (
        <button
          type="button"
          onClick={onHide}
          className="flex w-8 flex-shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('tabs.hideEditor')}
          aria-label={t('tabs.hideEditor')}
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
