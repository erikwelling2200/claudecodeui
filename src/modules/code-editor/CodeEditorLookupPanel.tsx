import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodeEditorLookup, CsharpLocation } from '@/shared/types';

type CodeEditorLookupPanelProps = {
  lookup: CodeEditorLookup;
  onOpenLocation: (location: CsharpLocation) => void;
  onClose: () => void;
};

const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;

/**
 * Rendered by CodeEditor, under the active tab, for the definitions and references a C# lookup found. Opening
 * a row leaves the panel open, so the next result is one click away, as in Visual Studio's references window.
 */
export default function CodeEditorLookupPanel({ lookup, onOpenLocation, onClose }: CodeEditorLookupPanelProps) {
  const { t } = useTranslation('codeEditor');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [lookupShown, setLookupShown] = useState(lookup);

  // A new lookup starts with nothing selected.
  if (lookupShown !== lookup) {
    setLookupShown(lookup);
    setSelectedIndex(null);
  }

  const openRow = (index: number, location: CsharpLocation) => {
    setSelectedIndex(index);
    onOpenLocation(location);
  };

  return (
    <div
      className="flex max-h-[40%] min-h-0 flex-shrink-0 flex-col border-t border-border bg-background text-xs"
      // Escape inside the panel closes it rather than the file under it.
      data-escape-layer=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="flex flex-shrink-0 items-center gap-2 px-3 py-1 text-muted-foreground">
        {lookup.kind === 'searching' && (
          <span aria-hidden="true" className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        <span className="truncate">{lookup.text}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded px-1.5 text-sm leading-none hover:bg-muted hover:text-foreground"
          title={t('actions.close')}
          aria-label={t('actions.close')}
        >
          ×
        </button>
      </div>

      {lookup.kind === 'locations' && (
        <div className="min-h-0 overflow-auto">
          <table className="w-full border-collapse font-mono">
            <thead className="sticky top-0 bg-muted text-left font-sans text-muted-foreground">
              <tr>
                <th className="px-3 py-0.5 font-medium">{t('lookup.file')}</th>
                <th className="px-2 py-0.5 text-right font-medium">{t('lookup.line')}</th>
                {lookup.showsAccess && <th className="px-2 py-0.5 font-medium">{t('lookup.kind')}</th>}
                <th className="w-full px-2 py-0.5 font-medium">{t('lookup.code')}</th>
              </tr>
            </thead>
            <tbody>
              {lookup.locations.map((location, index) => (
                <tr
                  key={`${location.filePath}|${location.line}|${location.character}`}
                  onClick={() => openRow(index, location)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openRow(index, location);
                  }}
                  tabIndex={0}
                  title={location.filePath}
                  className={`cursor-pointer whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary ${
                    selectedIndex === index ? 'bg-primary/15' : 'hover:bg-muted'
                  }`}
                >
                  <td className="px-3 py-0.5 font-sans">{fileName(location.filePath)}</td>
                  <td className="px-2 py-0.5 text-right text-muted-foreground">{location.line + 1}</td>
                  {lookup.showsAccess && (
                    <td className="px-2 py-0.5 font-sans text-muted-foreground">
                      {location.access === 'write' ? t('lookup.write') : location.access === 'read' ? t('lookup.read') : ''}
                    </td>
                  )}
                  <td className="max-w-0 truncate px-2 py-0.5">{location.preview}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
