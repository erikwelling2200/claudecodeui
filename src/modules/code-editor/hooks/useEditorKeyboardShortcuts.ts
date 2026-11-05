import { useEffect } from 'react';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  dependency: string;
  // False for an editor tab that is mounted but hidden, so only the visible one saves.
  enabled?: boolean;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  dependency,
  enabled = true,
}: UseEditorKeyboardShortcutsParams) => {
  useEffect(() => {
    if (!enabled) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dependency, enabled, onSave]);
};
