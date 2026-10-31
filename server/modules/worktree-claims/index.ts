// worktreeClaimsRoutes: used by the server entrypoint to mount lockstep groups, group worktrees and chat claims at `/api/worktree-claims`.
export { worktreeClaimsRoutes } from './worktree-claims.module.js';
// chatWorktreeLocks: used by the chat-tools MCP routes so an agent can list and release its own worktree locks.
export { chatWorktreeLocks } from './worktree-claims.module.js';
