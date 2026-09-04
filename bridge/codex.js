#!/usr/bin/env node
// Codex bridge: lends your Codex subscription's brain to a Roundtable room.
//
//   node bridge/codex.js http://localhost:3131/s/<room>
//
// Spawns `codex app-server` locally (JSON-RPC over stdio, your ChatGPT login),
// connects to the room as a bridge client, and answers agent tasks with
// { note, section }. Credentials never leave this machine — the room server
// only ever sees finished text.
//
// Each room agent (Scout, Grill, ...) gets its own persistent Codex thread,
// so an agent keeps its context across tasks within one bridge session.

import { spawn, execFile } from 'child_process';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { buildAgentPrompt, AGENT_OUTPUT_SCHEMA, parseAgentReply } from '../agents/prompt.js';

const args = process.argv.slice(2);
const nameIdx = args.indexOf('--name');
const agentName = nameIdx !== -1 ? args.splice(nameIdx, 2)[1] : null;
const applyIdx = args.indexOf('--allow-apply');
const allowApply = applyIdx !== -1 && (args.splice(applyIdx, 1), true);
const confirmIdx = args.indexOf('--confirm-apply');
const confirmApply = confirmIdx !== -1 && (args.splice(confirmIdx, 1), true);
const roomUrl = args[0];
if (!roomUrl) {
  console.error(`Usage: node bridge/codex.js <server or room url> [--name Ada] [--allow-apply]
  node bridge/codex.js http://localhost:3131            # serve operator-approved rooms
  node bridge/codex.js http://localhost:3131/s/abc123   # serve one room
  --name gives this brain its name at the table (default: codex)
  --allow-apply lets the room's HOST apply diff blocks to this machine,
  via git apply in ${process.cwd()} — only add it when you want that.
  --confirm-apply additionally asks y/N in this terminal for every apply.`);
  process.exit(1);
}
const parsed = new URL(roomUrl);
const roomMatch = parsed.pathname.match(/^\/s\/([^/]+)/);
const roomId = roomMatch ? roomMatch[1] : '*'; // '*' = shared bridge; server allowlist selects rooms
const wsUrl = (parsed.protocol === 'https:' ? 'wss://' : 'ws://') + parsed.host;
const TURN_TIMEOUT_MS = 3 * 60 * 1000;

// A separate cwd avoids working in the bridge's project by accident. Read-only
// prevents writes, not reads outside this directory. This is NOT a filesystem
// read boundary: use an isolated account/container for untrusted room content.
// --allow-apply separately opts into git apply in process.cwd().
const AGENT_WORKSPACE = join(homedir(), '.roundtable-bridge', 'workspace');
mkdirSync(AGENT_WORKSPACE, { recursive: true });

// Set ROUNDTABLE_VERBOSE=1 to trace every JSON-RPC exchange with codex
// (delta notifications are summarized, not dumped).
const VERBOSE = process.env.ROUNDTABLE_VERBOSE === '1';
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);
const vlog = (...a) => { if (VERBOSE) console.log(ts(), '[rpc]', ...a); };

/* ---------------- Codex app-server (JSON-RPC over stdio) ---------------- */

const codex = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
codex.on('exit', (code) => {
  log(`codex app-server exited (${code}); bridge shutting down.`);
  process.exit(1);
});

let nextId = 1;
const pendingRpc = new Map();       // id -> {resolve, reject}
const notificationHandlers = [];    // fn(method, params)

function rpc(method, params) {
  const id = nextId++;
  vlog(`-> #${id} ${method}`);
  codex.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => pendingRpc.set(id, { resolve, reject, method }));
}
const notify = (method, params) =>
  codex.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');

createInterface({ input: codex.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pendingRpc.get(msg.id);
    if (p) {
      pendingRpc.delete(msg.id);
      if (msg.error) {
        log(`rpc #${msg.id} ${p.method} error: ${msg.error.message || JSON.stringify(msg.error)}`);
        p.reject(new Error(msg.error.message || 'codex rpc error'));
      } else {
        vlog(`<- #${msg.id} ${p.method} ok`);
        p.resolve(msg.result);
      }
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // Server-initiated request (approvals etc.). We run read-only with
    // approvalPolicy "never", so decline anything that slips through.
    log(`declining codex server request: ${msg.method}`);
    codex.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'denied' } }) + '\n');
    return;
  }
  if (msg.method) {
    if (!msg.method.includes('Delta') && !msg.method.includes('/delta')) vlog(`<- ${msg.method}`);
    notificationHandlers.forEach((fn) => fn(msg.method, msg.params || {}));
  }
});

/* ---------------- Turns ---------------- */

const threads = new Map();          // roomId -> threadId (one persistent codex thread per room's agent)
const turnWaiters = new Map();      // threadId -> {resolve, reject, texts: []}

// Room -> thread mapping survives bridge restarts: codex stores the threads,
// we store the ids and resume them (thread/resume) on the next task.
const THREADS_FILE = new URL('.threads.json', import.meta.url);
let savedThreads = {};
try { savedThreads = JSON.parse(readFileSync(THREADS_FILE, 'utf8')); } catch { /* first run */ }
// Key includes the agent name so multiple named bridges on one machine keep
// separate threads for the same room.
const threadKey = (roomId) => `${wsUrl}/${roomId}#${agentName || 'codex'}`;
function rememberThread(roomId, threadId) {
  threads.set(roomId, threadId);
  // Re-read before writing: other bridge processes share this file.
  try { savedThreads = { ...JSON.parse(readFileSync(THREADS_FILE, 'utf8')), ...savedThreads }; } catch { /* fine */ }
  savedThreads[threadKey(roomId)] = threadId;
  try { writeFileSync(THREADS_FILE, JSON.stringify(savedThreads, null, 1)); } catch (err) {
    log(`could not save thread map: ${err.message}`);
  }
}

notificationHandlers.push((method, params) => {
  const w = turnWaiters.get(params.threadId);
  if (!w) return;
  if (method === 'item/completed' && params.item?.type === 'agentMessage') {
    w.texts.push(params.item.text);
  } else if (method === 'turn/completed') {
    turnWaiters.delete(params.threadId);
    const turn = params.turn || {};
    if (turn.status === 'failed') {
      w.reject(new Error(turn.error?.message || 'codex turn failed'));
    } else {
      const fromTurn = (turn.items || [])
        .filter((i) => i.type === 'agentMessage')
        .map((i) => i.text);
      const texts = w.texts.length ? w.texts : fromTurn;
      w.resolve(texts[texts.length - 1] || '');
    }
  } else if (method === 'error') {
    turnWaiters.delete(params.threadId);
    log(`codex error notification: ${JSON.stringify(params).slice(0, 400)}`);
    w.reject(new Error(params.message || params.error?.message || 'codex error'));
  }
});

async function threadFor(roomId) {
  if (threads.has(roomId)) return threads.get(roomId);

  // A previous bridge run may have a thread for this room — resume it so the
  // agent keeps its memory of the table.
  const saved = savedThreads[threadKey(roomId)];
  if (saved) {
    try {
      const res = await rpc('thread/resume', { threadId: saved, cwd: AGENT_WORKSPACE });
      log(`thread ${saved.slice(0, 8)}… resumed for room ${roomId} (model ${res.model})`);
      threads.set(roomId, saved);
      return saved;
    } catch (err) {
      log(`thread ${saved.slice(0, 8)}… could not resume (${err.message}); starting fresh`);
    }
  }

  const res = await rpc('thread/start', {
    sandbox: 'read-only',
    approvalPolicy: 'never',
    cwd: AGENT_WORKSPACE,
    model: process.env.ROUNDTABLE_CODEX_MODEL || null,
  });
  log(`thread ${res.thread.id.slice(0, 8)}… started for room ${roomId} (model ${res.model})`);
  rememberThread(roomId, res.thread.id);
  return res.thread.id;
}

async function runTask(task) {
  // One codex thread per room + persona, so each agent keeps its own memory.
  const taskKey = `${task.room || '?'}#${task.agentName || 'agent'}`;
  const threadId = await threadFor(taskKey);
  const prompt = buildAgentPrompt(task);

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      turnWaiters.delete(threadId);
      rpc('turn/interrupt', { threadId }).catch(() => {});
      threads.delete(taskKey); // thread state unknown; start fresh next time
      reject(new Error('codex turn timed out'));
    }, TURN_TIMEOUT_MS);
    turnWaiters.set(threadId, {
      texts: [],
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      outputSchema: AGENT_OUTPUT_SCHEMA,
      model: task.model || null,       // per-agent overrides from the room
      effort: task.effort || null,
    }).catch((e) => {
      clearTimeout(timer);
      turnWaiters.delete(threadId);
      reject(e);
    });
  });

  return parseAgentReply(reply);
}

/* ---------------- Applying diffs (host-approved, opt-in) ----------------
Only reachable when this bridge was started with --allow-apply, and the server
only forwards apply requests from the room's host. `git apply` refuses paths
outside the repo, so the blast radius is this working tree. */

function gitApply(diffText, extraArgs, cb) {
  const file = join(mkdtempSync(join(tmpdir(), 'rt-diff-')), 'block.diff');
  writeFileSync(file, diffText.endsWith('\n') ? diffText : diffText + '\n');
  execFile('git', ['apply', '--whitespace=nowarn', ...extraArgs, file],
    { cwd: process.cwd(), timeout: 15_000 },
    (err, _stdout, stderr) => cb(err ? (stderr || err.message).trim() : null));
}

function handleApply(msg) {
  const reply = (ok, output) =>
    ws.send(JSON.stringify({ t: 'apply_result', id: msg.id, ok, output: String(output || '').slice(0, 400) }));
  if (!allowApply) { reply(false, 'this bridge was not started with --allow-apply'); return; }
  log(`apply #${msg.id} [${msg.room}] "${msg.title}" (${msg.diff.length}ch) to ${process.cwd()}`);
  if (confirmApply) {
    confirmInTerminal(`Apply "${msg.title}" from room ${msg.room} to ${process.cwd()}? [y/N] `, (yes) => {
      if (!yes) { log(`apply #${msg.id} denied at the terminal`); reply(false, 'denied at the bridge terminal'); return; }
      doApply();
    });
    return;
  }
  doApply();
  function doApply() {
  gitApply(msg.diff, ['--check'], (checkErr) => {
    if (checkErr) {
      log(`apply #${msg.id} rejected by --check: ${checkErr}`);
      reply(false, checkErr);
      return;
    }
    gitApply(msg.diff, [], (err) => {
      log(`apply #${msg.id} ${err ? 'FAILED: ' + err : 'applied cleanly'}`);
      reply(!err, err || `applied cleanly in ${process.cwd()}`);
    });
  });
  }
}

// y/N prompt on the bridge terminal with a 60s timeout defaulting to No.
function confirmInTerminal(question, cb) {
  if (!process.stdin.isTTY) { cb(false); return; }
  process.stdout.write(question);
  const timer = setTimeout(() => { process.stdin.pause(); cb(false); }, 60_000);
  process.stdin.resume();
  process.stdin.once('data', (d) => {
    clearTimeout(timer);
    process.stdin.pause();
    cb(/^y(es)?$/i.test(String(d).trim()));
  });
}

/* ---------------- Room connection ---------------- */

// The server enforces budgets too, but the bridge is where the money is —
// enforce our own ceiling regardless of what the server asks for.
const BRIDGE_RUNS_PER_HOUR = Number(process.env.ROUNDTABLE_BRIDGE_RUNS || 60);
const runWindow = { start: 0, count: 0 };
function allowBridgeRun() {
  const now = Date.now();
  if (now - runWindow.start > 60 * 60_000) { runWindow.start = now; runWindow.count = 0; }
  if (runWindow.count >= BRIDGE_RUNS_PER_HOUR) return false;
  runWindow.count++;
  return true;
}

let ws;
let availableModels = []; // [{id, efforts}] — reported to the server for its settings UI
function connect() {
  ws = new WebSocket(wsUrl);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'bridge_join', room: roomId, provider: 'codex',
      name: agentName || 'codex', models: availableModels, canApply: allowApply,
      secret: process.env.ROUNDTABLE_BRIDGE_SECRET || undefined }));
    log(roomId === '*'
      ? `bridge connected to ${wsUrl} as "${agentName || 'codex'}", serving operator-approved rooms (ROUNDTABLE_SHARED_ROOMS on the server).`
      : `bridge connected to room ${roomId} at ${wsUrl} as "${agentName || 'codex'}" (your Codex subscription).`);
  });
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.t === 'apply' && (roomId === '*' || msg.room !== roomId)) return;
    if (roomId !== '*' && msg.room !== roomId) return;
    if (msg.t === 'apply') { handleApply(msg); return; }
    if (msg.t !== 'task') return;
    if (!allowBridgeRun()) {
      log(`task #${msg.id} REFUSED: bridge run budget (${BRIDGE_RUNS_PER_HOUR}/hour) exhausted`);
      ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: 'bridge hourly run budget exhausted' }));
      return;
    }
    const started = Date.now();
    const opts = [msg.model && `model=${msg.model}`, msg.effort && `effort=${msg.effort}`].filter(Boolean).join(' ') || 'defaults';
    log(`task #${msg.id} [${msg.room}] ${msg.agentName || ''} (${opts}), prompt inputs: problem ${msg.problem.length}ch, ${(msg.canvas || []).length} block(s), ${msg.chat.length} chat msg(s)`);
    try {
      const { note, canvas, actions } = await runTask(msg);
      ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, note, canvas, actions }));
      log(`task #${msg.id} done in ${((Date.now() - started) / 1000).toFixed(1)}s${actions?.length ? ` (+${actions.length} action(s))` : ''}: ${note}`);
    } catch (err) {
      ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: err.message }));
      log(`task #${msg.id} FAILED in ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message}`);
    }
  });
  ws.on('close', () => {
    log('room connection lost; retrying in 3s...');
    setTimeout(connect, 3000);
  });
  ws.on('error', (err) => vlog(`ws error: ${err.message}`));
}

/* ---------------- Boot ---------------- */

const init = await rpc('initialize', {
  clientInfo: { name: 'roundtable-bridge', version: '0.1.0' },
  capabilities: { experimentalApi: true },
});
notify('initialized');
log(`codex app-server up (${init.userAgent}).`);
try {
  const res = await rpc('model/list', {});
  const list = Array.isArray(res) ? res : res.data || res.models || [];
  availableModels = list
    .filter((m) => !m.hidden)
    .map((m) => ({
      id: m.id || m.model,
      efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort),
    }));
  log(`models available: ${availableModels.map((m) => m.id).join(', ') || 'none reported'}`);
} catch (err) {
  log(`model/list failed (${err.message}); settings UI will fall back to free-text`);
}
connect();
