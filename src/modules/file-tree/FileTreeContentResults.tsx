import { memo, useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Loader2, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FileContentFileMatches, FileContentMatch, FileContentSearchState } from '@/shared/types';
import { HighlightedSnippet } from '@/shared/ui';
import { cn } from '@/shared/utils';
import FileTreeEmptyState from '@/modules/file-tree/FileTreeEmptyState';

type FileTreeContentResultsProps = {
  search: FileContentSearchState;
  // Names of the project folders by position; empty for a single-folder project.
  folderNames: string[];
  renderFileIcon: (filename: string) => ReactNode;
  onOpenMatch: (match: FileContentMatch) => void;
};

type ContentResultFileProps = {
  file: FileContentFileMatches;
  folderName: string | undefined;
  collapsed: boolean;
  onToggle: (filePath: string) => void;
  renderFileIcon: (filename: string) => ReactNode;
  onOpenMatch: (match: FileContentMatch) => void;
};

// Memoized: while matches stream in, only the files that gained a line are drawn again.
const ContentResultFile = memo(function ContentResultFile({
  file,
  folderName,
  collapsed,
  onToggle,
  renderFileIcon,
  onOpenMatch,
}: ContentResultFileProps) {
  const lastSlash = file.relativePath.lastIndexOf('/');
  const fileName = file.relativePath.slice(lastSlash + 1);
  const directory = [folderName, lastSlash > 0 ? file.relativePath.slice(0, lastSlash) : '']
    .filter(Boolean)
    .join('/');

  return (
    <div className="select-none">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-sm py-[3px] pl-1 pr-2 text-left transition-colors duration-100 hover:bg-accent/60"
        onClick={() => onToggle(file.path)}
        aria-expanded={!collapsed}
        title={file.path}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70 transition-transform duration-150', !collapsed && 'rotate-90')}
        />
        <span className="flex flex-shrink-0 items-center">{renderFileIcon(fileName)}</span>
        <span className="min-w-0 truncate text-[13px] font-medium leading-tight text-foreground">{fileName}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{directory}</span>
        <span className="flex-shrink-0 rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {file.matches.length}
        </span>
      </button>

      {!collapsed && file.matches.map((match) => (
        <button
          key={`${match.line}:${match.character}`}
          type="button"
          className="flex w-full items-start gap-2 rounded-sm py-[2px] pl-7 pr-2 text-left transition-colors duration-100 hover:bg-accent/60"
          onClick={() => onOpenMatch(match)}
        >
          <span className="w-8 flex-shrink-0 text-right text-xs tabular-nums leading-relaxed text-muted-foreground/70">
            {match.line}
          </span>
          <HighlightedSnippet
            snippet={match.snippet}
            highlights={match.highlights}
            // The marks lose their side padding: in code it reads as a space that is not there.
            className="whitespace-pre-wrap break-all font-mono text-foreground/90 [&_mark]:px-0"
          />
        </button>
      ))}
    </div>
  );
});

/** Rendered by FileTree in place of the tree while a content search has something to show: the matching lines, grouped per file. */
export default function FileTreeContentResults({ search, folderNames, renderFileIcon, onOpenMatch }: FileTreeContentResultsProps) {
  const { t } = useTranslation();
  // Files the user folded shut in the results; a file not listed here shows its lines.
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());

  const toggleFile = useCallback((filePath: string) => {
    setCollapsedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  if (search.status === 'error') {
    return (
      <FileTreeEmptyState
        icon={AlertTriangle}
        title={t('fileTree.contentSearchFailed')}
        description={search.error ?? t('fileTree.contentSearchNoAnswer')}
      />
    );
  }

  if (search.files.length === 0) {
    return search.status === 'searching' ? (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('fileTree.contentSearchSearching')}
      </div>
    ) : (
      <FileTreeEmptyState
        icon={Search}
        title={t('fileTree.noMatchesFound')}
        description={t('fileTree.tryDifferentSearch')}
      />
    );
  }

  return (
    <>
      <div className="flex items-center gap-1.5 px-1 pb-1 text-xs text-muted-foreground">
        <span>
          {t('fileTree.contentSearchMatches', { count: search.matchCount, shown: `${search.matchCount}${search.truncated ? '+' : ''}` })}
          {' · '}
          {t('fileTree.contentSearchFiles', { count: search.files.length })}
        </span>
        {search.status === 'searching' && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      {search.files.map((file) => (
        <ContentResultFile
          key={file.path}
          file={file}
          folderName={folderNames[file.rootIndex]}
          collapsed={collapsedFiles.has(file.path)}
          onToggle={toggleFile}
          renderFileIcon={renderFileIcon}
          onOpenMatch={onOpenMatch}
        />
      ))}
    </>
  );
}
