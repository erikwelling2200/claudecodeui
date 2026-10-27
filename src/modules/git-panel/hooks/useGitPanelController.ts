import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { FileOpenHandler, GitApiErrorResponse, GitTarget, GitCommitSummary, GitDiffMap, GitFileDiffResponse, GitOperationResponse, GitPanelView, GitRemoteStatus, GitStatusResponse, Project } from '@/shared/types';
import { getAllChangedFiles } from '@/modules/git-panel/utils/gitPanelUtils';
import { useSelectedProvider } from '@/shared/hooks/useSelectedProvider';
import { joinFolderPath } from '@/shared/utils';

const DEFAULT_BRANCH = 'main';
// High enough for the commit graph to show meaningful branch structure.
const RECENT_COMMITS_LIMIT = 50;

type UseGitPanelControllerOptions = {
  selectedProject: Project | null;
  // Absolute path of the non-primary project folder the panel shows; null or
  // absent for the primary folder.
  gitFolder?: string | null;
  activeView: GitPanelView;
  onFileOpen?: FileOpenHandler;
};

type GitPanelController = {
  gitStatus: GitStatusResponse | null;
  gitDiff: GitDiffMap;
  isLoading: boolean;
  isLoadingCommits: boolean;
  currentBranch: string;
  branches: string[];
  localBranches: string[];
  remoteBranches: string[];
  /** Full remote-tracking names (`origin/main`) — the Compare tab offers them as bases. */
  remoteRefs: string[];
  recentCommits: GitCommitSummary[];
  commitDiffs: GitDiffMap;
  remoteStatus: GitRemoteStatus | null;
  isCreatingBranch: boolean;
  isFetching: boolean;
  isPulling: boolean;
  isPushing: boolean;
  isPublishing: boolean;
  isCreatingInitialCommit: boolean;
  isInitializingRepository: boolean;
  operationError: string | null;
  clearOperationError: () => void;
  refreshAll: () => void;
  switchBranch: (branchName: string) => Promise<boolean>;
  createBranch: (branchName: string) => Promise<boolean>;
  deleteBranch: (branchName: string, force?: boolean) => Promise<boolean>;
  handleFetch: () => Promise<void>;
  handlePull: () => Promise<void>;
  handlePush: () => Promise<void>;
  handlePublish: () => Promise<void>;
  discardChanges: (filePath: string) => Promise<void>;
  deleteUntrackedFile: (filePath: string) => Promise<void>;
  stageFiles: (files: string[]) => Promise<boolean>;
  unstageFiles: (files: string[]) => Promise<boolean>;
  fetchCommitDiff: (commitHash: string) => Promise<void>;
  generateCommitMessage: (files: string[]) => Promise<string | null>;
  commitChanges: (message: string, files: string[]) => Promise<boolean>;
  createInitialCommit: () => Promise<boolean>;
  initRepository: () => Promise<boolean>;
  openFile: (filePath: string) => Promise<void>;
};

type GitBranchesResponse = GitApiErrorResponse & {
  branches?: string[];
  localBranches?: string[];
  remoteBranches?: string[];
  remoteRefs?: string[];
};

type GitCommitsResponse = GitApiErrorResponse & {
  commits?: GitCommitSummary[];
};

type GitGenerateMessageResponse = GitApiErrorResponse & {
  message?: string;
};

type GitFileWithDiffResponse = GitApiErrorResponse & {
  oldContent?: string;
  currentContent?: string;
  isDeleted?: boolean;
  isUntracked?: boolean;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  const data = (await response.json()) as T;

  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  return data;
}

// Identifies a (project, folder) pair for stale-response checks.
function getGitTargetKey(target: GitTarget | null): string | null {
  return target ? `${target.projectId}|${target.folder ?? ''}` : null;
}

export function useGitPanelController({
  selectedProject,
  gitFolder = null,
  activeView,
  onFileOpen,
}: UseGitPanelControllerOptions): GitPanelController {
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  // Separate from `isLoading` (status) so History never flashes "No commits
  // found" while the commits request is still in flight.
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [hasLoadedCommits, setHasLoadedCommits] = useState(false);
  const [commitDiffs, setCommitDiffs] = useState<GitDiffMap>({});
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  // Unambiguous remote-tracking refs for the Compare tab's base selector;
  // `remoteBranches` strips the remote prefix and drops names shadowed by a
  // local branch, so it cannot serve as a diff base.
  const [remoteRefs, setRemoteRefs] = useState<string[]>([]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const [isInitializingRepository, setIsInitializingRepository] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const clearOperationError = useCallback(() => setOperationError(null), []);
  const projectId = selectedProject?.projectId ?? null;
  // The repository every request addresses: the project plus, for a
  // non-primary folder, that folder.
  const gitTarget = useMemo<GitTarget | null>(
    () => (projectId ? { projectId, folder: gitFolder } : null),
    [gitFolder, projectId],
  );
  const gitTargetKey = getGitTargetKey(gitTarget);
  // Tracks the (project, folder) pair so async requests can detect stale
  // responses when the user switches projects or folders mid-flight.
  const gitTargetKeyRef = useRef<string | null>(gitTargetKey);

  useEffect(() => {
    gitTargetKeyRef.current = gitTargetKey;
  }, [gitTargetKey]);

  const provider = useSelectedProvider();

  const fetchFileDiff = useCallback(
    async (filePath: string, signal?: AbortSignal) => {
      if (!gitTarget) {
        return;
      }

      const requestTargetKey = getGitTargetKey(gitTarget);

      try {
        const response = await api.git.diff(gitTarget, filePath, { signal });
        const data = await readJson<GitFileDiffResponse>(response, signal);

        if (
          signal?.aborted ||
          gitTargetKeyRef.current !== requestTargetKey
        ) {
          return;
        }

        if (!data.error && data.diff) {
          setGitDiff((previous) => ({
            ...previous,
            [filePath]: data.diff as string,
          }));
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        console.error('Error fetching file diff:', error);
      }
    },
    [gitTarget],
  );

  const fetchGitStatus = useCallback(async (signal?: AbortSignal) => {
    if (!gitTarget) {
      return;
    }

    const requestTargetKey = getGitTargetKey(gitTarget);

    setIsLoading(true);
    try {
      const response = await api.git.status(gitTarget, { signal });
      const data = await readJson<GitStatusResponse>(response, signal);

      if (
        signal?.aborted ||
        gitTargetKeyRef.current !== requestTargetKey
      ) {
        return;
      }

      if (data.error) {
        // A missing repository is an expected state, not an error.
        if (!data.notGitRepository) {
          console.error('Git status error:', data.error);
        }
        setGitStatus({
          error: data.error,
          details: data.details,
          notGitRepository: data.notGitRepository,
        });
        setCurrentBranch('');
        return;
      }

      setGitStatus(data);
      setCurrentBranch(data.branch || DEFAULT_BRANCH);

      const changedFiles = getAllChangedFiles(data);
      changedFiles.forEach((filePath) => {
        void fetchFileDiff(filePath, signal);
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }

      if (
        gitTargetKeyRef.current !== requestTargetKey
      ) {
        return;
      }

      console.error('Error fetching git status:', error);
      setGitStatus({ error: 'Git operation failed', details: String(error) });
      setCurrentBranch('');
    } finally {
      setIsLoading(false);
    }
  }, [fetchFileDiff, gitTarget]);

  const fetchBranches = useCallback(async () => {
    if (!gitTarget) {
      return;
    }

    try {
      const response = await api.git.branches(gitTarget);
      const data = await readJson<GitBranchesResponse>(response);

      if (!data.error && data.branches) {
        setBranches(data.branches);
        setLocalBranches(data.localBranches ?? data.branches);
        setRemoteBranches(data.remoteBranches ?? []);
        setRemoteRefs(data.remoteRefs ?? []);
        return;
      }

      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
      setRemoteRefs([]);
    } catch (error) {
      console.error('Error fetching branches:', error);
      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
      setRemoteRefs([]);
    }
  }, [gitTarget]);

  const fetchRemoteStatus = useCallback(async () => {
    if (!gitTarget) {
      return;
    }

    try {
      const response = await api.git.remoteStatus(gitTarget);
      const data = await readJson<GitRemoteStatus | GitApiErrorResponse>(response);

      if (!data.error) {
        setRemoteStatus(data as GitRemoteStatus);
        return;
      }

      setRemoteStatus(null);
    } catch (error) {
      console.error('Error fetching remote status:', error);
      setRemoteStatus(null);
    }
  }, [gitTarget]);

  const switchBranch = useCallback(
    async (branchName: string) => {
      if (!gitTarget) {
        return false;
      }

      try {
        const response = await api.git.checkout(gitTarget, branchName);

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          console.error('Failed to switch branch:', data.error);
          return false;
        }

        setCurrentBranch(branchName);
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error switching branch:', error);
        return false;
      }
    },
    [fetchGitStatus, gitTarget],
  );

  const createBranch = useCallback(
    async (branchName: string) => {
      const trimmedBranchName = branchName.trim();
      if (!gitTarget || !trimmedBranchName) {
        return false;
      }

      setIsCreatingBranch(true);
      try {
        const response = await api.git.createBranch(gitTarget, trimmedBranchName);

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          console.error('Failed to create branch:', data.error);
          return false;
        }

        setCurrentBranch(trimmedBranchName);
        void fetchBranches();
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error creating branch:', error);
        return false;
      } finally {
        setIsCreatingBranch(false);
      }
    },
    [fetchBranches, fetchGitStatus, gitTarget],
  );

  const deleteBranch = useCallback(
    async (branchName: string, force = false) => {
      if (!gitTarget) return false;

      try {
        const response = await api.git.deleteBranch(gitTarget, branchName, force);

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Delete branch failed');
          return false;
        }

        void fetchBranches();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Delete branch failed');
        return false;
      }
    },
    [fetchBranches, gitTarget],
  );

  const handleFetch = useCallback(async () => {
    if (!gitTarget) {
      return;
    }

    setIsFetching(true);
    try {
      const response = await api.git.fetch(gitTarget);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        void fetchBranches();
        return;
      }

      setOperationError(data.error ?? 'Fetch failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Fetch failed');
    } finally {
      setIsFetching(false);
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, gitTarget]);

  const handlePull = useCallback(async () => {
    if (!gitTarget) {
      return;
    }

    setIsPulling(true);
    try {
      const response = await api.git.pull(gitTarget);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Pull failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Pull failed');
    } finally {
      setIsPulling(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, gitTarget]);

  const handlePush = useCallback(async () => {
    if (!gitTarget) {
      return;
    }

    setIsPushing(true);
    try {
      const response = await api.git.push(gitTarget);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Push failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Push failed');
    } finally {
      setIsPushing(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, gitTarget]);

  const handlePublish = useCallback(async () => {
    if (!gitTarget) {
      return;
    }

    setIsPublishing(true);
    try {
      const response = await api.git.publish(gitTarget, currentBranch);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      console.error('Publish failed:', data.error);
    } catch (error) {
      console.error('Error publishing branch:', error);
    } finally {
      setIsPublishing(false);
    }
  }, [currentBranch, fetchGitStatus, fetchRemoteStatus, gitTarget]);

  const discardChanges = useCallback(
    async (filePath: string) => {
      if (!gitTarget) {
        return;
      }

      try {
        const response = await api.git.discard(gitTarget, filePath);

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Discard failed:', data.error);
      } catch (error) {
        console.error('Error discarding changes:', error);
      }
    },
    [fetchGitStatus, gitTarget],
  );

  const deleteUntrackedFile = useCallback(
    async (filePath: string) => {
      if (!gitTarget) {
        return;
      }

      try {
        const response = await api.git.deleteUntracked(gitTarget, filePath);

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Delete failed:', data.error);
      } catch (error) {
        console.error('Error deleting untracked file:', error);
      }
    },
    [fetchGitStatus, gitTarget],
  );

  const stageFiles = useCallback(
    async (files: string[]) => {
      if (!gitTarget || files.length === 0) {
        return false;
      }

      try {
        const response = await api.git.stage(gitTarget, files);

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Stage failed');
          return false;
        }

        // Refresh so the Staged section re-syncs from the real index.
        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Stage failed');
        return false;
      }
    },
    [fetchGitStatus, gitTarget],
  );

  const unstageFiles = useCallback(
    async (files: string[]) => {
      if (!gitTarget || files.length === 0) {
        return false;
      }

      try {
        const response = await api.git.unstage(gitTarget, files);

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Unstage failed');
          return false;
        }

        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Unstage failed');
        return false;
      }
    },
    [fetchGitStatus, gitTarget],
  );

  const fetchRecentCommits = useCallback(async () => {
    if (!gitTarget) {
      return;
    }

    const requestTargetKey = getGitTargetKey(gitTarget);

    setIsLoadingCommits(true);
    try {
      const response = await api.git.commits(gitTarget, { limit: RECENT_COMMITS_LIMIT });
      const data = await readJson<GitCommitsResponse>(response);

      if (gitTargetKeyRef.current !== requestTargetKey) {
        return;
      }

      if (!data.error && data.commits) {
        setRecentCommits(data.commits);
      }
    } catch (error) {
      console.error('Error fetching commits:', error);
    } finally {
      if (gitTargetKeyRef.current === requestTargetKey) {
        setIsLoadingCommits(false);
        setHasLoadedCommits(true);
      }
    }
  }, [gitTarget]);

  const fetchCommitDiff = useCallback(
    async (commitHash: string) => {
      if (!gitTarget) {
        return;
      }

      try {
        const response = await api.git.commitDiff(gitTarget, commitHash);
        const data = await readJson<GitFileDiffResponse>(response);

        if (!data.error && data.diff) {
          setCommitDiffs((previous) => ({
            ...previous,
            [commitHash]: data.diff as string,
          }));
        }
      } catch (error) {
        console.error('Error fetching commit diff:', error);
      }
    },
    [gitTarget],
  );

  const generateCommitMessage = useCallback(
    async (files: string[]) => {
      if (!gitTarget || files.length === 0) {
        return null;
      }

      try {
        const response = await api.git.generateCommitMessage(
          gitTarget,
          files,
          provider,
        );

        const data = await readJson<GitGenerateMessageResponse>(response);
        if (data.message) {
          return data.message;
        }

        console.error('Failed to generate commit message:', data.error);
        return null;
      } catch (error) {
        console.error('Error generating commit message:', error);
        return null;
      }
    },
    [provider, gitTarget],
  );

  const commitChanges = useCallback(
    async (message: string, files: string[]) => {
      if (!gitTarget || !message.trim() || files.length === 0) {
        return false;
      }

      try {
        const response = await api.git.commit(gitTarget, message, files);

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          void fetchRemoteStatus();
          return true;
        }

        console.error('Commit failed:', data.error);
        return false;
      } catch (error) {
        console.error('Error committing changes:', error);
        return false;
      }
    },
    [fetchGitStatus, fetchRemoteStatus, gitTarget],
  );

  const createInitialCommit = useCallback(async () => {
    if (!gitTarget) {
      throw new Error('No project selected');
    }

    setIsCreatingInitialCommit(true);
    try {
      const response = await api.git.initialCommit(gitTarget);

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return true;
      }

      throw new Error(data.error || 'Failed to create initial commit');
    } catch (error) {
      console.error('Error creating initial commit:', error);
      throw error;
    } finally {
      setIsCreatingInitialCommit(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, gitTarget]);

  const initRepository = useCallback(async () => {
    if (!gitTarget) {
      return false;
    }
    const requestTargetKey = getGitTargetKey(gitTarget);

    setIsInitializingRepository(true);
    try {
      const response = await api.git.init(gitTarget);

      const data = await readJson<GitOperationResponse>(response);
      if (gitTargetKeyRef.current !== requestTargetKey) {
        return false;
      }
      if (!data.success) {
        setOperationError(data.error ?? 'Failed to initialize repository');
        return false;
      }

      void fetchGitStatus();
      void fetchBranches();
      void fetchRemoteStatus();
      return true;
    } catch (error) {
      if (gitTargetKeyRef.current === requestTargetKey) {
        setOperationError(error instanceof Error ? error.message : 'Failed to initialize repository');
      }
      return false;
    } finally {
      setIsInitializingRepository(false);
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, gitTarget]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!onFileOpen) {
        return;
      }

      // Git reports paths relative to the repository; the editor resolves
      // relative paths against the primary folder, so a file of another
      // folder is opened by its absolute path.
      const editorPath = gitFolder ? joinFolderPath(gitFolder, filePath) : filePath;

      if (!gitTarget) {
        onFileOpen(editorPath);
        return;
      }

      try {
        const response = await api.git.fileWithDiff(gitTarget, filePath);
        const data = await readJson<GitFileWithDiffResponse>(response);

        if (data.error) {
          console.error('Error fetching file with diff:', data.error);
          onFileOpen(editorPath);
          return;
        }

        onFileOpen(editorPath, {
          old_string: data.oldContent || '',
          new_string: data.currentContent || '',
        });
      } catch (error) {
        console.error('Error opening file:', error);
        onFileOpen(editorPath);
      }
    },
    [gitFolder, gitTarget, onFileOpen],
  );

  const refreshAll = useCallback(() => {
    void fetchGitStatus();
    void fetchBranches();
    void fetchRemoteStatus();
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus]);

  useEffect(() => {
    const controller = new AbortController();

    // Reset repository-scoped state when the project or folder changes to avoid stale UI.
    setCurrentBranch('');
    setBranches([]);
    setLocalBranches([]);
    setRemoteBranches([]);
    setRemoteRefs([]);
    setGitStatus(null);
    setRemoteStatus(null);
    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});
    setIsLoading(false);
    setIsLoadingCommits(false);
    setHasLoadedCommits(false);
    setOperationError(null);

    if (!gitTarget) {
      return () => {
        controller.abort();
      };
    }

    void fetchGitStatus(controller.signal);
    void fetchBranches();
    void fetchRemoteStatus();

    return () => {
      controller.abort();
    };
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, gitTarget]);

  useEffect(() => {
    if (!gitTarget || activeView !== 'history') {
      return;
    }
    void fetchRecentCommits();
  }, [activeView, fetchRecentCommits, gitTarget]);

  return {
    gitStatus,
    gitDiff,
    isLoading,
    // History is "loading" until the first commits response for this project
    // lands, so an empty list never renders before the data exists.
    isLoadingCommits: isLoadingCommits || !hasLoadedCommits,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    remoteRefs,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    isInitializingRepository,
    operationError,
    clearOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    initRepository,
    openFile,
  };
}
