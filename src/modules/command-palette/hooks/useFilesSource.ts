import { api } from '@/shared/api';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';
import type { FileSearchResult } from '@/shared/types';

export type FileResult = {
  path: string;
  name: string;
};

const MAX_FILES = 500;

/** The project's files matching `search`, ranked by the server's file index. */
export function useFilesSource(projectId: string | undefined, search: string, enabled: boolean) {
  return useApiSource<FileResult, { results?: FileSearchResult[] }>({
    enabled: enabled && !!projectId,
    deps: [projectId, search],
    fetcher: (signal) => api.searchFiles(projectId!, search, { limit: MAX_FILES, type: 'file' }, { signal }),
    parse: (data) => (data.results ?? []).map((result) => ({ path: result.path, name: result.name })),
  });
}
