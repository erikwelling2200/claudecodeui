// Builds the sandbox's fake home directory: demo projects plus Claude transcripts that point at them.
// Everything here is invented, so an agent can open, edit and break it without touching real data.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Claude Code names a project's transcript folder after its cwd with every non-alphanumeric character replaced by '-'. */
export function encodeClaudeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function git(cwd, args, env = {}) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: path.join(cwd, '..', '..', '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function commit(cwd, message, date) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() });
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000);
}

function seedWebshop(dir) {
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-webshop', version: '0.1.0', type: 'module', scripts: { start: 'node src/server.js' } }, null, 2) + '\n');
  write(path.join(dir, 'README.md'), '# Demo webshop\n\nA tiny made-up shop used as sandbox data.\n');
  write(path.join(dir, 'src', 'cart.js'), [
    'export function cartTotal(items) {',
    '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
    '}',
    '',
  ].join('\n'));
  write(path.join(dir, 'src', 'server.js'), [
    "import http from 'node:http';",
    "import { cartTotal } from './cart.js';",
    '',
    'http.createServer((req, res) => {',
    "  res.end(String(cartTotal([{ price: 2.5, quantity: 4 }])));",
    '}).listen(8080);',
    '',
  ].join('\n'));
  git(dir, ['init', '-q', '-b', 'main']);
  commit(dir, 'Initial shop skeleton', hoursAgo(72));

  write(path.join(dir, 'src', 'discount.js'), [
    'export function applyDiscount(total, percent) {',
    '  if (percent < 0 || percent > 100) throw new RangeError(`percent out of range: ${percent}`);',
    '  return total * (1 - percent / 100);',
    '}',
    '',
  ].join('\n'));
  commit(dir, 'Add discount helper', hoursAgo(48));

  git(dir, ['switch', '-q', '-c', 'feature/checkout']);
  write(path.join(dir, 'src', 'checkout.js'), "export const checkoutSteps = ['cart', 'address', 'payment', 'done'];\n");
  commit(dir, 'Sketch checkout steps', hoursAgo(30));
  git(dir, ['switch', '-q', 'main']);

  // Leave the tree dirty so the git panel has something to show.
  fs.appendFileSync(path.join(dir, 'README.md'), '\n## Running\n\n`npm start`, then open http://localhost:8080.\n');
  write(path.join(dir, 'src', 'untracked-idea.js'), '// TODO: wishlist\n');
}

function seedApi(dir) {
  write(path.join(dir, 'app.py'), [
    'from dataclasses import dataclass',
    '',
    '',
    '@dataclass',
    'class Order:',
    '    id: int',
    '    total: float',
    '',
    '',
    'def list_orders() -> list[Order]:',
    '    return [Order(1, 9.95), Order(2, 120.0)]',
    '',
  ].join('\n'));
  write(path.join(dir, 'requirements.txt'), 'fastapi==0.110.0\nuvicorn==0.29.0\n');
  write(path.join(dir, 'tests', 'test_app.py'), 'from app import list_orders\n\n\ndef test_has_orders():\n    assert len(list_orders()) == 2\n');
  git(dir, ['init', '-q', '-b', 'main']);
  commit(dir, 'Order listing', hoursAgo(20));
}

function seedNotes(dir) {
  write(path.join(dir, 'ideas.md'), '# Ideas\n\n- Dark mode for the shop\n- Export orders as CSV\n');
  write(path.join(dir, 'meeting-2026-10-01.md'), '# Planning\n\nAttendees: Alex, Sam\n\n1. Ship checkout\n2. Fix totals rounding\n');
  write(path.join(dir, 'data', 'orders.csv'), 'id,total,status\n1,9.95,paid\n2,120.00,open\n3,42.10,refunded\n');
}

/** Writes one transcript in the JSONL layout Claude Code uses, so the server indexes and renders it like a real session. */
class TranscriptWriter {
  constructor(home, cwd, startedAt) {
    this.sessionId = randomUUID();
    this.cwd = cwd;
    this.time = startedAt.getTime();
    this.parentUuid = null;
    this.lines = [];
    this.filePath = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd), `${this.sessionId}.jsonl`);
  }

  push(entry) {
    this.time += 4000;
    const uuid = randomUUID();
    this.lines.push({
      parentUuid: this.parentUuid, isSidechain: false, userType: 'external', cwd: this.cwd, sessionId: this.sessionId,
      version: '2.1.0', gitBranch: 'main', uuid, timestamp: new Date(this.time).toISOString(), ...entry,
    });
    this.parentUuid = uuid;
    return this;
  }

  user(text) {
    return this.push({ type: 'user', message: { role: 'user', content: text } });
  }

  assistant(content) {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    return this.push({
      type: 'assistant',
      message: {
        id: `msg_sandbox_${randomUUID().slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-sandbox', content: blocks,
        stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  }

  /** One tool call and its result, as two consecutive entries. */
  tool(name, input, result, isError = false) {
    const id = `toolu_sandbox_${randomUUID().slice(0, 12)}`;
    this.assistant([{ type: 'tool_use', id, name, input }]);
    return this.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } });
  }

  save(title) {
    if (title) this.lines.push({ type: 'ai-title', aiTitle: title, sessionId: this.sessionId });
    write(this.filePath, this.lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const touched = new Date(this.time);
    fs.utimesSync(this.filePath, touched, touched);
    return this;
  }
}

function seedTranscripts(home, projects) {
  const { webshop, api, notes } = projects;
  const sessions = [];

  sessions.push(new TranscriptWriter(home, webshop, hoursAgo(3))
    .user('The cart total is wrong when quantity is 0, can you check?')
    .assistant([{ type: 'thinking', thinking: 'Look at cartTotal first.', signature: 'sandbox' }, { type: 'text', text: 'Let me look at the cart code.' }])
    .tool('Read', { file_path: path.join(webshop, 'src', 'cart.js') }, '1\texport function cartTotal(items) {\n2\t  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n3\t}')
    .assistant('`cartTotal` multiplies price by quantity, so a quantity of 0 already contributes 0. The total is correct; the bug is probably in how the UI sends the quantity.')
    .user('Add a test for it anyway.')
    .tool('Write', { file_path: path.join(webshop, 'src', 'cart.test.js'), content: "import { cartTotal } from './cart.js';\n" }, 'File created successfully.')
    .tool('Bash', { command: 'node --test src', description: 'Run the tests' }, '✔ cartTotal ignores zero quantities (0.4ms)\nℹ tests 1\nℹ pass 1')
    .assistant('Added `src/cart.test.js`; it passes.')
    .save('Cart total with zero quantity'));

  sessions.push(new TranscriptWriter(home, webshop, hoursAgo(26))
    .user('Sketch the checkout flow on a new branch.')
    .tool('Bash', { command: 'git switch -c feature/checkout', description: 'Create branch' }, "Switched to a new branch 'feature/checkout'")
    .tool('Edit', { file_path: path.join(webshop, 'src', 'checkout.js'), old_string: '', new_string: "export const checkoutSteps = ['cart', 'address', 'payment', 'done'];" }, 'The file has been updated.')
    .tool('Bash', { command: 'npm run lint', description: 'Lint' }, 'npm ERR! Missing script: "lint"', true)
    .assistant('The checkout steps are on `feature/checkout`. There is no lint script in this project, so I skipped linting.')
    .save('Checkout flow sketch'));

  // A long session, for testing scrolling and history paging.
  const long = new TranscriptWriter(home, api, hoursAgo(8)).user('Walk me through the order model, step by step.');
  for (let step = 1; step <= 40; step++) {
    long.assistant(`Step ${step}: ${'The order model keeps an id and a total. '.repeat(1 + (step % 4))}`);
    long.user(`ok, next (${step})`);
  }
  long.assistant('That covers the whole model.');
  sessions.push(long.save('Order model walkthrough'));

  sessions.push(new TranscriptWriter(home, api, hoursAgo(50))
    .user('Why does the test fail?')
    .tool('Bash', { command: 'pytest -q', description: 'Run tests' }, 'E   ModuleNotFoundError: No module named \'fastapi\'\n1 error in 0.12s', true)
    .assistant('FastAPI is not installed. Run `pip install -r requirements.txt` first.')
    .save('Failing pytest run'));

  sessions.push(new TranscriptWriter(home, notes, hoursAgo(100))
    .user('Summarise my notes in three bullets.')
    .tool('Glob', { pattern: '**/*.md', path: notes }, `${path.join(notes, 'ideas.md')}\n${path.join(notes, 'meeting-2026-10-01.md')}`)
    .assistant('- Ship checkout\n- Fix totals rounding\n- Consider dark mode and CSV export')
    .save('Notes summary'));

  const history = sessions.map((session) => JSON.stringify({ display: session.lines[0].message.content, sessionId: session.sessionId, project: session.cwd }));
  write(path.join(home, '.claude', 'history.jsonl'), history.join('\n') + '\n');
}

/** Creates `<root>/home` from scratch. The caller decides whether an existing one may be replaced. */
export function seedSandbox(root) {
  const home = path.join(root, 'home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });

  write(path.join(home, '.gitconfig'), '[user]\n\tname = Sandbox User\n\temail = sandbox@example.invalid\n[init]\n\tdefaultBranch = main\n[safe]\n\tdirectory = *\n');
  write(path.join(home, '.claude', 'settings.json'), '{}\n');
  // Makes the UI show Claude as signed in. The token is fake; chats run scripts/sandbox/fake-claude.mjs, which never calls an API.
  write(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ email: 'sandbox@example.invalid', claudeAiOauth: { accessToken: 'sandbox-not-a-real-token' } }, null, 2) + '\n');
  // The CLI's onboarding flag; the server reads it when deciding whether Claude is set up.
  write(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }, null, 2) + '\n');

  const projects = {
    webshop: path.join(home, 'projects', 'demo-webshop'),
    api: path.join(home, 'projects', 'demo-api'),
    notes: path.join(home, 'projects', 'demo-notes'),
  };
  seedWebshop(projects.webshop);
  seedApi(projects.api);
  seedNotes(projects.notes);
  seedTranscripts(home, projects);
  return { home, projects };
}
