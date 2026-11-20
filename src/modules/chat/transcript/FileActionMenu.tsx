import { useCallback, useState } from 'react';
import { AlertCircle, Check, Copy, ExternalLink, FileDiff, FolderOpen } from 'lucide-react';

import { copyTextToClipboard } from '@/shared/utils';
import { ActionMenu } from '@/shared/ui';
import type { ActionMenuItem } from '@/shared/ui/ActionMenu';
import { usePaletteOps } from '@/modules/command-palette';

type ActionState = 'idle' | 'busy' | 'done' | 'error';

type FileActionMenuProps = {
  /** Right-clicking this element opens the menu. */
  target: HTMLElement | null;
  /** The file's path as the transcript shows it, relative or absolute. */
  path: string;
  onOpenFile: () => void;
  /** Adds "Open diff" above "Open file", for a row that carries a change. */
  onOpenDiff?: () => void;
};

/** The right-click menu of a file named in the transcript: a file link in a message, or the file of an Edit/Write row. */
export function FileActionMenu({ target, path, onOpenFile, onOpenDiff }: FileActionMenuProps) {
  const fileOps = usePaletteOps();
  const [copyState, setCopyState] = useState<ActionState>('idle');
  const [revealState, setRevealState] = useState<ActionState>('idle');

  const runAction = async (action: () => Promise<void>, setState: (state: ActionState) => void) => {
    setState('busy');
    try {
      await action();
      setState('done');
    } catch (error) {
      console.error(error);
      setState('error');
    }
  };

  const copyPath = () => runAction(async () => {
    if (!(await copyTextToClipboard(await fileOps.resolveFilePath(path)))) {
      throw new Error('The clipboard refused the path.');
    }
  }, setCopyState);

  const revealFile = () => runAction(() => fileOps.revealFile(path), setRevealState);

  const resetStates = useCallback((open: boolean) => {
    if (!open) {
      setCopyState('idle');
      setRevealState('idle');
    }
  }, []);

  const items: ActionMenuItem[] = [
    ...(onOpenDiff ? [{ key: 'diff', label: 'Open diff', icon: FileDiff, onSelect: onOpenDiff }] : []),
    { key: 'open', label: onOpenDiff ? 'Open file' : 'Open', icon: ExternalLink, onSelect: onOpenFile },
    {
      key: 'reveal',
      label: revealState === 'error' ? 'Could not show in Explorer' : 'Show in Explorer',
      description: revealState === 'error' ? 'Click to try again.' : undefined,
      icon: revealState === 'done' ? Check : revealState === 'error' ? AlertCircle : FolderOpen,
      loading: revealState === 'busy',
      closeOnSelect: false,
      onSelect: () => void revealFile(),
    },
    {
      key: 'copy',
      label: copyState === 'done' ? 'Path copied' : copyState === 'error' ? 'Could not copy path' : 'Copy path',
      description: copyState === 'error' ? 'Click to try again.' : undefined,
      icon: copyState === 'done' ? Check : copyState === 'error' ? AlertCircle : Copy,
      loading: copyState === 'busy',
      closeOnSelect: false,
      onSelect: () => void copyPath(),
    },
  ];

  return (
    <ActionMenu
      label="File options"
      hideTrigger
      portal
      contextMenuTarget={target}
      onOpenChange={resetStates}
      menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
      items={items}
    />
  );
}
