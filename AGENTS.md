# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Testing the UI: use the sandbox

To see a change working in the browser, run this checkout's own sandbox instead of the instance on port 3001
(that one is the user's, serves a prebuilt `dist/`, and runs their real chats):

```
npm run sandbox                # first run seeds .sandbox/ in this checkout; run it in the background
npm run sandbox -- status      # URL, login and a ready-made auth token
npm run sandbox -- stop
npm run sandbox -- --reset     # throw the data away and seed it fresh, then start
```

It starts the server (`tsx`, from source) and Vite on the first free port pair from 3101 / 5201, so several
worktrees can each run one, and prints the URL. Restarting it is always fine: nobody else uses it.

- **Login** is `sandbox` / `sandbox-password`, with onboarding already done. To skip the form in a browser
  session, run the printed `localStorage.setItem('auth-token', ...)` on the page and reload.
- **Data** is invented: `.sandbox/home` stands in for the home directory (`HOME`, `USERPROFILE`, `APPDATA`),
  with three demo projects (one a git repo with a branch and uncommitted changes) and five Claude chats, one of
  them long. The database is `.sandbox/auth.db`. Credentials and profile pointers (`*TOKEN*`, `*API_KEY*`,
  `CLAUDE_CONFIG_DIR`, ...) are removed from the environment, and the user-level MCP entries are left alone.
- **Chats** run `scripts/sandbox/fake-claude.mjs` instead of Claude Code: scripted replies, no model, no
  network, but real transcripts, so reloads show history. A prompt containing `tool`, `slow`, `long` or
  `error` gets a tool call, a streamed reply, a long markdown reply, or a failed turn.
- **Logs** are in `.sandbox/logs/server.log` and `client.log`.

This keeps the app away from real data by default; it is not a security boundary. The Shell tab and any
absolute path still reach the real disk.
