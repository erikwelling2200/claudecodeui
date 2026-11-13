import { useContext } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { HeaderActionsSlotContext } from '@/modules/code-editor/utils/headerActionsSlot';

/** Rendered by a file-type view inside CodeEditorFrame to add its own buttons to the shared header, left of the layout toggles. */
export default function CodeEditorHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderActionsSlotContext);
  return slot ? createPortal(children, slot) : null;
}
