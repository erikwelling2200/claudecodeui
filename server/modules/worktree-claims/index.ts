// worktreeClaimsRoutes: used by the server entrypoint to mount lockstep groups, group worktrees and chat claims at `/api/worktree-claims`.
export { worktreeClaimsRoutes } from './worktree-claims.module.js';
// chatWorktreeLocks: used by the chat-tools MCP routes so an agent can list and release its own worktree locks.
export { chatWorktreeLocks } from './worktree-claims.module.js';
// recordSessionWorktreeClaim: used by the chat-tools MCP routes when the worktree-lock hook reports a granted claim.
// mapFoldersToSessionWorktrees: used by the File Tree module to read and write in the worktree a chat works in.
export { recordSessionWorktreeClaim } from './services/session-worktrees.service.js';
export { mapFoldersToSessionWorktrees } from './services/session-folders.js';
// readSuffix, readUnitKey: shared validation of worktree claim fields, used by the chat-tools MCP routes.
export { readSuffix, readUnitKey } from './services/unit-keys.js';
