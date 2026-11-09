#!/usr/bin/env node
// Runs this checkout's server and Vite client against invented data in `<checkout>/.sandbox`, with a known login,
// free ports and a fake Claude CLI. Meant for agents testing UI changes without a login prompt, a restart of the
// instance in daily use, or access to real projects and chats.
//
//   npm run sandbox                start (seeds on first run), stays in the foreground until stopped
//   npm run sandbox -- --reset     wipe the data and seed it again before starting
//   npm run sandbox -- status      print the running sandbox's URL and login, from .sandbox/state.json
//   npm run sandbox -- stop        stop the sandbox started from this checkout
//   npm run sandbox -- reset       wipe the data without starting
//
// Options: --server-port N, --client-port N (defaults: the first free pair from 3101 / 5201).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedSandbox } from './seed.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SANDBOX_ROOT = path.join(REPO_ROOT, '.sandbox');
const STATE_PATH = path.join(SANDBOX_ROOT, 'state.json');
const LOG_DIR = path.join(SANDBOX_ROOT, 'logs');
const HOME = path.join(SANDBOX_ROOT, 'home');
const USERNAME = 'sandbox';
const PASSWORD = 'sandbox-password';

// Credentials and pointers into the real profile that must not reach the sandbox processes.
const STRIPPED_ENV = /TOKEN|SECRET|PASSWORD|API_KEY|^CLAUDE_CONFIG_DIR$|^CODEX_HOME$|^OPENCODE_|^CLOUDCLI_|^CLAUDECODE$|^CLAUDE_CODE_|^GIT_CONFIG_|^VITE_IS_PLATFORM$|^WORKSPACES_ROOT$|^CSHARP_SOURCE_PROJECTS$/i;

function parseArgs(argv) {
  const options = { command: 'start', reset: false, serverPort: undefined, clientPort: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--reset') options.reset = true;
    else if (arg === '--server-port') options.serverPort = Number(argv[++index]);
    else if (arg === '--client-port') options.clientPort = Number(argv[++index]);
    else if (['start', 'stop', 'status', 'reset'].includes(arg)) options.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function pickPorts(options) {
  if (options.serverPort && options.clientPort) return { serverPort: options.serverPort, clientPort: options.clientPort };
  for (let offset = 0; offset < 100; offset++) {
    const serverPort = options.serverPort ?? 3101 + offset;
    const clientPort = options.clientPort ?? 5201 + offset;
    if (await isPortFree(serverPort) && await isPortFree(clientPort)) return { serverPort, clientPort };
  }
  throw new Error('No free port pair found between 3101/5201 and 3200/5300');
}

function sandboxEnv(serverPort, clientPort) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !STRIPPED_ENV.test(key)));
  return {
    ...env,
    HOME,
    USERPROFILE: HOME,
    APPDATA: path.join(HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(HOME, '.config'),
    DATABASE_PATH: path.join(SANDBOX_ROOT, 'auth.db'),
    WORKSPACES_ROOT: HOME,
    // Set to a path that does not exist, so a value in the checkout's .env (which only fills unset keys) cannot apply.
    CSHARP_SOURCE_PROJECTS: path.join(HOME, 'no-csharp-projects'),
    JWT_SECRET: 'cloudcli-sandbox-jwt-secret',
    CLAUDE_CLI_PATH: path.join(REPO_ROOT, 'scripts', 'sandbox', 'fake-claude.mjs'),
    CLOUDCLI_REGISTER_USER_MCP: 'false',
    CLOUDCLI_SANDBOX: 'true',
    HOST: '127.0.0.1',
    SERVER_PORT: String(serverPort),
    PORT: String(serverPort),
    VITE_PORT: String(clientPort),
  };
}

function startChild(name, args, env) {
  const log = fs.createWriteStream(path.join(LOG_DIR, `${name}.log`), { flags: 'w' });
  // stdin stays an open pipe: Vite shuts down as soon as its stdin ends.
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      log.write(chunk);
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) process.stdout.write(`[${name}] ${line}\n`);
    });
  }
  return child;
}

async function waitForServer(serverPort, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}; see ${path.join(LOG_DIR, 'server.log')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/api/auth/status`);
      if (response.ok) return response.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Server did not answer within 120 s');
}

async function postJson(url, body, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

/** Logs in as the sandbox user, creating it and finishing the onboarding wizard on a fresh database. */
async function login(serverPort, status) {
  const api = `http://127.0.0.1:${serverPort}/api`;
  if (status.needsSetup) await postJson(`${api}/auth/register`, { username: USERNAME, password: PASSWORD });
  const result = await postJson(`${api}/auth/login`, { username: USERNAME, password: PASSWORD });
  if (!result.token) throw new Error(`Login returned no token: ${JSON.stringify(result)}`);
  if (status.needsSetup) {
    await postJson(`${api}/user/git-config`, { gitName: 'Sandbox User', gitEmail: 'sandbox@example.invalid' }, result.token);
    await postJson(`${api}/user/complete-onboarding`, {}, result.token);
  }
  return result.token;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

function printState(state) {
  console.log([
    '',
    `Sandbox running from ${REPO_ROOT}`,
    `  UI (Vite, live source):  ${state.clientUrl}`,
    `  API server:              ${state.serverUrl}`,
    `  Login:                   ${state.username} / ${state.password}`,
    `  Skip the login form:     run this in the page, then reload:`,
    `    localStorage.setItem('auth-token', '${state.token}')`,
    `  Data:                    ${SANDBOX_ROOT}`,
    `  Logs:                    ${LOG_DIR}`,
    `  Stop:                    npm run sandbox -- stop`,
    '',
  ].join('\n'));
}

function reset() {
  fs.rmSync(path.join(SANDBOX_ROOT, 'auth.db'), { force: true });
  for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(SANDBOX_ROOT, `auth.db${suffix}`), { force: true });
  seedSandbox(SANDBOX_ROOT);
  console.log(`Seeded fresh sandbox data in ${SANDBOX_ROOT}`);
}

async function start(options) {
  const running = readState();
  if (running && isAlive(running.pid)) {
    console.log('A sandbox from this checkout is already running.');
    printState(running);
    return;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (options.reset || !fs.existsSync(HOME)) reset();

  const { serverPort, clientPort } = await pickPorts(options);
  const env = sandboxEnv(serverPort, clientPort);
  const tsx = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const vite = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(tsx) || !fs.existsSync(vite)) throw new Error(`Dependencies missing in ${REPO_ROOT}; run npm install first`);

  const server = startChild('server', [tsx, '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], env);
  const client = startChild('client', [vite, '--port', String(clientPort), '--strictPort'], env);
  const children = [server, client];
  const shutdown = () => {
    for (const child of children) if (child.exitCode === null) killTree(child.pid);
    const state = readState();
    if (state?.pid === process.pid) fs.rmSync(STATE_PATH, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  for (const child of children) child.on('exit', (code) => {
    console.log(`A sandbox process exited (code ${code}); stopping the sandbox.`);
    shutdown();
  });

  const status = await waitForServer(serverPort, server);
  const token = await login(serverPort, status);
  const state = {
    pid: process.pid, serverPort, clientPort, serverUrl: `http://localhost:${serverPort}`, clientUrl: `http://localhost:${clientPort}`,
    username: USERNAME, password: PASSWORD, token, startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  printState(state);
}

function stop() {
  const state = readState();
  if (!state || !isAlive(state.pid)) {
    console.log('No sandbox from this checkout is running.');
    fs.rmSync(STATE_PATH, { force: true });
    return;
  }
  killTree(state.pid);
  // The launcher's own shutdown handler does not run under a forced kill, so free its children's ports here.
  for (const port of [state.serverPort, state.clientPort]) killListener(port);
  fs.rmSync(STATE_PATH, { force: true });
  console.log('Sandbox stopped.');
}

function killListener(port) {
  if (process.platform !== 'win32') return;
  const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[3] === 'LISTENING' && columns[1]?.endsWith(`:${port}`)) killTree(Number(columns[4]));
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.command === 'status') {
  const state = readState();
  if (state && isAlive(state.pid)) printState(state);
  else console.log('No sandbox from this checkout is running.');
} else if (options.command === 'stop') {
  stop();
} else if (options.command === 'reset') {
  const state = readState();
  if (state && isAlive(state.pid)) throw new Error('Stop the running sandbox first: npm run sandbox -- stop');
  reset();
} else {
  await start(options);
}
