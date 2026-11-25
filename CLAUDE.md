# Claude Code notes

Repository-wide guidance lives in `AGENTS.md`.

## After a merge or a finished change, make the result visible

The instance in daily use runs from this checkout (`C:\Tools\claudecodeui`), and the server on port 3001
serves the **prebuilt** frontend from `dist/`, not the source. A merge that is not rebuilt changes nothing
in the browser, while the Vite dev server (port 5173) already shows it, so testing there proves nothing
about what the user sees.

So every merge, in either direction (a branch into `main`, or `main` into the checked-out branch), and every finished
change ends with whatever makes it live, without asking:

- **Changes under `src/`** (or `index.html`, `public/`, `vite.config.*`): run `npm run build:client`, then
  confirm the new `dist/` contains the change. No server restart is needed; it serves `dist/` from disk.
  Tell the user to hard-reload (Ctrl+Shift+R).
- **Changes under `server/` or `shared/`**: the server runs from source through `tsx`, so it needs a
  restart, not a build. A restart ends the chats running in it, so ask before restarting.

## Restarting and starting the server

The sidebar's restart button (next to Settings) calls `POST /api/system/restart`. The server answers, shuts down
cleanly and comes back in one of two ways:

- **Supervised**: started by `scripts/autostart/server-loop.ps1`, which sets `CLOUDCLI_SUPERVISED=1` and starts it
  again after every exit. `npm run autostart:install` registers that loop as a per-user logon task (Windows only,
  no admin rights), so the server is also up after a reboot and back after a crash; `npm run autostart:uninstall`
  removes the task and stops the server. Output goes to `~/.cloudcli/logs/server-<port>.log`.
- **Unsupervised** (started by hand with `npm run server:dev`): the server spawns a detached copy of itself with
  `CLOUDCLI_REPLACES_PID` set, which retries the port until the old process has released it. The copy has no
  terminal, so its output goes to the same log file.

The service worker's offline page polls `/health` and reloads by itself once the server answers, and names the
autostart command for the cold case. `/health` carries `startedAt`, which the restart button uses to tell the new
process from the old one before reloading.
