import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type CodeEditorExternalChangeDialogProps = {
  fileName: string;
  // The disk text that changed under unsaved edits; null keeps the dialog closed.
  diskContent: string | null;
  onKeepEditor: (diskContent: string) => void;
  onKeepFile: (diskContent: string) => void;
};

/**
 * Rendered by CodeEditor when the open file changes on disk while the buffer has unsaved edits.
 *
 * Keeping the editor comes first in the DOM so Dialog's open-focus lands on it, and Esc or a click outside picks it
 * too: it discards nothing until the next save, while keeping the file throws the edits away.
 */
export default function CodeEditorExternalChangeDialog({ fileName, diskContent, onKeepEditor, onKeepFile }: CodeEditorExternalChangeDialogProps) {
  const { t } = useTranslation('codeEditor');

  return (
    <Dialog
      open={diskContent !== null}
      onOpenChange={(open) => {
        if (!open && diskContent !== null) onKeepEditor(diskContent);
      }}
    >
      <DialogContent aria-describedby="external-change-dialog-description" className="p-5">
        <DialogTitle className="not-sr-only text-base font-semibold text-foreground">
          {t('externalChange.title', { defaultValue: '{{fileName}} changed on disk', fileName })}
        </DialogTitle>

        <p id="external-change-dialog-description" className="mt-3 text-sm text-muted-foreground">
          {t('externalChange.description', { defaultValue: 'The editor has unsaved changes.' })}
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="default" onClick={() => diskContent !== null && onKeepEditor(diskContent)}>
            {t('externalChange.keepEditor', { defaultValue: 'Keep editor content' })}
          </Button>
          <Button type="button" variant="destructive" onClick={() => diskContent !== null && onKeepFile(diskContent)}>
            {t('externalChange.keepFile', { defaultValue: 'Keep file content' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
