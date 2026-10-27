# Claude Code notes

Repository-wide guidance lives in `AGENTS.md`.

## After merging into `main`, make the result visible

The instance in daily use runs from this checkout (`C:\Tools\claudecodeui`), and the server on port 3001
serves the **prebuilt** frontend from `dist/`, not the source. A merge that is not rebuilt changes nothing
in the browser, while the Vite dev server (port 5173) already shows it, so testing there proves nothing
about what the user sees.

So every merge into `main` ends with whatever makes it live, without asking:

- **Changes under `src/`** (or `index.html`, `public/`, `vite.config.*`): run `npm run build:client`, then
  confirm the new `dist/` contains the change. No server restart is needed; it serves `dist/` from disk.
  Tell the user to hard-reload (Ctrl+Shift+R).
- **Changes under `server/` or `shared/`**: the server runs from source through `tsx`, so it needs a
  restart, not a build. A restart ends the chats running in it, so ask before restarting.
