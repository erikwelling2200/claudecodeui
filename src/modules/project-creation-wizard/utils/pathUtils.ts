const SSH_PREFIXES = ['git@', 'ssh://'];
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:\\?$/;

export const isSshGitUrl = (url: string): boolean => {
  const trimmedUrl = url.trim();
  return SSH_PREFIXES.some((prefix) => trimmedUrl.startsWith(prefix));
};

export const shouldShowGithubAuthentication = (githubUrl: string): boolean =>
  githubUrl.trim().length > 0 && !isSshGitUrl(githubUrl);

export const isCloneWorkflow = (githubUrl: string): boolean =>
  githubUrl.trim().length > 0;

// Handles root edge cases for Unix-like and Windows paths.
export const getParentPath = (currentPath: string): string | null => {
  if (currentPath === '~' || currentPath === '/' || WINDOWS_DRIVE_PATTERN.test(currentPath)) {
    return null;
  }

  const lastSeparatorIndex = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  if (lastSeparatorIndex <= 0) {
    return '/';
  }

  if (lastSeparatorIndex === 2 && /^[A-Za-z]:/.test(currentPath)) {
    return `${currentPath.slice(0, 2)}\\`;
  }

  return currentPath.slice(0, lastSeparatorIndex);
};

// The extra folders a form actually submits: trimmed, blank rows dropped and
// exact repeats removed. The server does the real validation.
export const getSubmittedFolders = (folders: string[]): string[] =>
  Array.from(new Set(folders.map((folder) => folder.trim()).filter(Boolean)));
