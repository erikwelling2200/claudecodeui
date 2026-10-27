import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getFolderName } from '@/shared/utils';

type GitFolderSelectProps = {
  folders: string[];
  activeFolder: string;
  isMobile: boolean;
  onChange: (folder: string) => void;
};

// Labels each folder by its name, falling back to `parent/name` where two
// folders share a name so the options stay distinguishable.
function getFolderLabels(folders: string[]): string[] {
  const names = folders.map(getFolderName);
  return folders.map((folder, index) => {
    if (names.filter((name) => name === names[index]).length < 2) {
      return names[index];
    }
    const segments = folder.replace(/[\\/]+$/, '').split(/[\\/]/);
    return segments.slice(-2).join('/');
  });
}

/** Rendered by GitPanelHeader (and by GitPanel while the chosen folder has no repository) to switch between the folders of a multi-folder project. */
export default function GitFolderSelect({ folders, activeFolder, isMobile, onChange }: GitFolderSelectProps) {
  const { t } = useTranslation();
  const labels = useMemo(() => getFolderLabels(folders), [folders]);

  return (
    <select
      value={activeFolder}
      onChange={(event) => onChange(event.target.value)}
      aria-label={t('git:header.folder')}
      title={activeFolder}
      className={`min-w-0 max-w-40 truncate rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring ${
        isMobile ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm'
      }`}
    >
      {folders.map((folder, index) => (
        <option key={folder} value={folder} title={folder}>
          {labels[index]}
        </option>
      ))}
    </select>
  );
}
