import { useTranslation } from 'react-i18next';
import { PinIcon } from 'lucide-react';

import { useTranscriptSessionId } from '@/modules/chat/context/TranscriptSessionContext';
import { togglePinnedMessage, usePinnedMessages } from '@/modules/chat/utils/pinnedMessages';

type MessagePinControlProps = {
  text: string;
  timestamp: string;
};

/** Rendered in a message's footer by MessageComponent; pins the message to the sidebar beside the chat, or unpins it. */
export default function MessagePinControl({ text, timestamp }: MessagePinControlProps) {
  const { t } = useTranslation('chat');
  const sessionId = useTranscriptSessionId();
  const pins = usePinnedMessages(sessionId);
  if (!sessionId) return null;

  const pinned = pins.some((pin) => pin.timestamp === timestamp);
  const label = pinned ? t('message.unpin', { defaultValue: 'Unpin' }) : t('message.pin', { defaultValue: 'Pin to sidebar' });

  return (
    <button
      type="button"
      onClick={() => togglePinnedMessage(sessionId, { text, timestamp })}
      title={label}
      aria-label={label}
      aria-pressed={pinned}
      // A pinned message keeps its pin visible, so the transcript shows what is pinned without hovering. The named group
      // is the whole message, which an assistant reply's tool cards (with groups of their own) sit inside.
      className={`rounded p-1 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover/message:opacity-100 ${pinned ? 'text-primary opacity-100' : 'opacity-0'}`}
    >
      <PinIcon className={`h-3.5 w-3.5 ${pinned ? 'fill-current' : ''}`} />
    </button>
  );
}
