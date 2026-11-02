import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SessionPrompt, SessionPromptBookends } from '@/shared/types';

type PromptItemProps = {
  label: string;
  prompt: SessionPrompt;
  onJump: (timestamp: string) => void;
};

function PromptItem({ label, prompt, onJump }: PromptItemProps) {
  const { t } = useTranslation();
  const textRef = useRef<HTMLSpanElement | null>(null);
  // Whether the full text is shown instead of the first three lines.
  const [expanded, setExpanded] = useState(false);
  // Whether the clamped text hides anything, which is what decides if the fold-out toggle is offered at all.
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [prompt.text, expanded]);

  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <button
        type="button"
        onClick={() => onJump(prompt.timestamp)}
        title={t('sessionPrompts.jump')}
        className="mt-0.5 block w-full rounded px-1 py-0.5 text-left text-xs text-foreground hover:bg-accent"
      >
        {/* The clamp sits on a span: Chrome does not clamp a button's own content. */}
        <span ref={textRef} className={`whitespace-pre-line break-words ${expanded ? 'block' : 'line-clamp-3'}`}>
          {prompt.text}
        </span>
      </button>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-0.5 px-1 text-[11px] text-primary hover:underline"
        >
          {expanded ? t('sessionPrompts.showLess') : t('sessionPrompts.showMore')}
        </button>
      )}
    </div>
  );
}

type SessionPromptsSectionProps = {
  bookends: SessionPromptBookends;
  onJump: (timestamp: string) => void;
};

/** Used by the project-workspace module to quote the chat's first and last user message in the sidebar beside the chat, each a link back to it. */
export function SessionPromptsSection({ bookends, onJump }: SessionPromptsSectionProps) {
  const { t } = useTranslation();
  const { first, last } = bookends;
  // With a single prompt the two bookends are the same message.
  const showLast = last && last.timestamp !== first?.timestamp;

  return (
    <section className="space-y-2">
      {first && <PromptItem label={t('sessionPrompts.first')} prompt={first} onJump={onJump} />}
      {showLast && <PromptItem label={t('sessionPrompts.last')} prompt={last} onJump={onJump} />}
    </section>
  );
}
