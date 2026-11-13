import { createContext, useContext, useEffect } from 'react';

import type { FileSearchProvider } from '@/modules/code-editor/utils/fileSearch';

export type FileSearchRegistry = {
  register: (provider: FileSearchProvider) => () => void;
};

/** Provided by CodeEditorFrame; null outside a frame, where a view has no find bar to answer. */
export const FileSearchRegistryContext = createContext<FileSearchRegistry | null>(null);

/**
 * Called by a file view that searches its own content instead of the frame's rendered text, such as the virtualised
 * text editor and CSV table. A new provider object re-runs the open search, so views rebuild it when their content changes.
 */
export const useFileSearchProvider = (provider: FileSearchProvider | null) => {
  const registry = useContext(FileSearchRegistryContext);
  useEffect(() => {
    if (!registry || !provider) return undefined;
    return registry.register(provider);
  }, [provider, registry]);
};
