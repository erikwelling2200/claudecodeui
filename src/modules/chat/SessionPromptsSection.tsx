import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PinIcon, XIcon } from 'lucide-react';

import type { SessionPrompt, SessionPromptBookends } from '@/shared/types';

type PromptItemProps = {
  label: string;
  prompt: SessionPrompt;
  onJump: (timestamp: string) => void;
  /** Offered on a pinned message only. */
  onUnpin?: () => void;
};

function PromptItem({ label, prompt, onJump, onUnpin }: PromptItemProps) {
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
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {onUnpin && <PinIcon className="h-3 w-3 fill-current" />}
        <span className="flex-1">{label}</span>
        {onUnpin && (
          <button
            type="button"
            onClick={onUnpin}
            title={t('sessionPrompts.unpin', { defaultValue: 'Unpin' })}
            aria-label={t('sessionPrompts.unpin', { defaultValue: 'Unpin' })}
            className="rounded p-0.5 hover:bg-accent hover:text-foreground"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>
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
  /** Messages the user pinned in this chat, in transcript order. */
  pinned: SessionPrompt[];
  onJump: (timestamp: string) => void;
  onUnpin: (prompt: SessionPrompt) => void;
};

/**
 * Used by the project-workspace module to quote the chat's first message, its pinned messages and its last message in
 * the sidebar beside the chat, each a link back to it.
 */
export function SessionPromptsSection({ bookends, pinned, onJump, onUnpin }: SessionPromptsSectionProps) {
  const { t } = useTranslation();
  const { first, last } = bookends;
  // With a single prompt the two bookends are the same message.
  const showLast = last && last.timestamp !== first?.timestamp;

  return (
    <section className="space-y-2">
      {first && <PromptItem label={t('sessionPrompts.first')} prompt={first} onJump={onJump} />}
      {pinned.map((prompt) => (
        <PromptItem
          key={prompt.timestamp}
          label={t('sessionPrompts.pinned', { defaultValue: 'Pinned' })}
          prompt={prompt}
          onJump={onJump}
          onUnpin={() => onUnpin(prompt)}
        />
      ))}
      {showLast && <PromptItem label={t('sessionPrompts.last')} prompt={last} onJump={onJump} />}
    </section>
  );
}
