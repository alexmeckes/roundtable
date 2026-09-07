// Roundtable room server.
// Server-authoritative room state, websocket fanout.
//
// Two layers:
//   Brains  — compute attached by hosts: bridges (server-wide or per-room)
//             plus the ANTHROPIC_API_KEY house adapter. Interchangeable.
//   Agents  — named personas at the table, created and modified in chat
//             (/agent Name: brief). Each has its own color, brief, and memory;
//             runs are served by whatever brains are attached.
//
// Agents take turns (runs serialized per room) and can hand to each other by
// @mention, with a hop budget so they can't loop forever.

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { runHouseAgent, houseAvailable } from './agents/house.js';
import { sanitizeCanvas, sanitizeActions, serializeCanvas } from './agents/prompt.js';
import { createWorkspaces } from './workspace/server.js';
import {catchupSummary,markSeen} from './workspace/catchup.js';
import {taskPeople,taskAgents} from './workspace/tasks.js';
import {contextSummary} from './workspace/context.js';

const PORT = process.env.PORT || 3131;
const BRIDGE_TASK_TIMEOUT_MS = 3.5 * 60 * 1000;
const DATA_FILE = process.env.ROUNDTABLE_DATA || 'data/rooms.json';
const CHAT_KEEP = 400;   // messages retained per room, in memory and on disk
const MAX_HOPS = 3;      // agent-triggered agent runs allowed per human message
const MAX_AGENTS = 6;

/* Abuse guards — the URL is public and agent runs spend the host's
subscription, so everything spendable or growable is bounded. */
const MAX_ROOMS = Number(process.env.ROUNDTABLE_MAX_ROOMS || 500);
const MAX_PEOPLE_PER_ROOM = 30;
const MAX_FRAME_BYTES = 64 * 1024;           // largest accepted ws message
const WS_RATE = { max: 60, windowMs: 30_000 };        // any inbound messages, per connection
const ROOM_RUNS = { max: 30, windowMs: 60 * 60_000 }; // agent runs per room per hour
const GLOBAL_RUNS = { max: 150, windowMs: 60 * 60_000 }; // agent runs server-wide per hour
const IDLE_EVICT_MS = 30 * 24 * 60 * 60_000; // empty rooms with content expire after 30 days
const GC_EVERY_MS = 10 * 60_000;
const MAX_CONN_PER_IP = Number(process.env.ROUNDTABLE_MAX_CONN_PER_IP || 20);
const HEARTBEAT_MS = 30_000;
// Extra browser origins allowed to open sockets (comma-separated), beyond
// same-host and localhost. Bridges/CLIs send no Origin and are always allowed.
const EXTRA_ORIGINS = (process.env.ROUNDTABLE_ALLOWED_ORIGINS || '')
  .split(',').map((x) => x.trim()).filter(Boolean);
// Bridges must present this secret to attach (if set). Empty = open (local dev).
const BRIDGE_SECRET = process.env.ROUNDTABLE_BRIDGE_SECRET || '';
// Trusted proxy hops in front of us — the rightmost N X-Forwarded-For entries
// are proxy-added and trustworthy; anything a client prepends is not. Railway = 1.
const PROXY_HOPS = Number(process.env.ROUNDTABLE_PROXY_HOPS || 0);
// Default governance for new rooms. Code default is friendly (open, shared
// spend) for local/self-host; a shared-bridge deployment should set these to
// something wallet-safe (e.g. managed + host-only spend).
const DEFAULT_ACCESS = ['open', 'managed', 'view'].includes(process.env.ROUNDTABLE_DEFAULT_ACCESS)
  ? process.env.ROUNDTABLE_DEFAULT_ACCESS : 'open';
const DEFAULT_HOST_ONLY_SPEND = process.env.ROUNDTABLE_DEFAULT_HOST_ONLY_SPEND === '1';
// Only the server operator can authorize use of shared compute. Creating a
// table and claiming its host role never grants access to an existing bridge.
const SHARED_ROOMS = new Set((process.env.ROUNDTABLE_SHARED_ROOMS || '')
  .split(',').map((id) => id.trim()).filter(Boolean));

const DEFAULT_AGENT = {
  name: 'Agent',
  brief: 'Distill the discussion, answer what is asked, surface the sharpest facts, risks, and next steps.',
};

/* ---------------- Logging ----------------
Lifecycle events always log. Set ROUNDTABLE_VERBOSE=1 to also log every
inbound ws message (types + sizes, never chat contents). */

const VERBOSE = process.env.ROUNDTABLE_VERBOSE === '1';
const ts = () => new Date().toISOString().slice(11, 23);
const log = (roomId, ...args) => console.log(`${ts()} [${roomId || '-'}]`, ...args);
const vlog = (roomId, ...args) => { if (VERBOSE) log(roomId, ...args); };

/* ---------------- Rooms & brains ---------------- */

const rooms = new Map();          // id -> room
const defaultBridges = new Map(); // ws -> {name, provider} — serve every room

// Tasks in flight to bridges, global so one bridge can serve many rooms.
let taskSeq = 0;
const pendingTasks = new Map();   // id -> {resolve, reject, ws}
const pendingApplies = new Map(); // id -> {room, ws, title, timer}

const COLORS = ['#FF6B5E', '#3E8FFF', '#2FBF71', '#F5A623', '#F25EA2'];
const AGENT_COLORS = ['#9B6BFF', '#00A3A3', '#D2699E', '#5A7BD8', '#B08968', '#7A9E4E'];
const ADJ = ['Swift', 'Sly', 'Brave', 'Cosmic', 'Lucky', 'Quiet', 'Wild', 'Neon'];
const CRITTER = ['Otter', 'Fox', 'Heron', 'Lynx', 'Crow', 'Newt', 'Ibex', 'Mole'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function makeAgent(room, name, brief) {
  const used = new Set(room.agents.map((a) => a.color));
  const color = AGENT_COLORS.find((c) => !used.has(c)) || AGENT_COLORS[room.agents.length % AGENT_COLORS.length];
  return { name, brief, color };
}

function makeRoom(id = randomBytes(6).toString('base64url')) {
  const room = {
    id,
    title: 'Untitled table',
    problem: '',
    canvas: [],          // typed blocks: {type: text|code|diff, title, content, lang?}
    canvasRevision: 0,
    chat: [],            // {author, kind, text, color}
    agents: [],          // personas: {name, brief, color}
    hostKey: randomBytes(9).toString('base64url'),
    hostClaimed: false,  // first person to join claims host
    // Access tiers — what a guest (non-host) may do:
    //   open    anyone talks, tasks agents, and manages them (default)
    //   managed anyone talks and tasks agents; only the host configures them
    //   view    guests watch; only the host can speak
    access: DEFAULT_ACCESS,
    hostOnlySpend: DEFAULT_HOST_ONLY_SPEND, // when true, only the host may trigger agent runs
    auto: true,          // agents reply to conversation without being @mentioned
    autoT: null,         // debounce timer for auto replies
    queue: [],           // pending agent runs: {name, directTask}
    running: null,       // name of the agent currently holding the floor
    hops: 0,             // agent-triggered runs since the last human message
    people: new Map(),   // ws -> {name, color}
    bridges: new Map(),  // ws -> {name, provider} — room-scoped brains
    colorIdx: 0,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    runWindow: { start: 0, count: 0, notified: false },
  };
  room.agents.push(makeAgent(room, DEFAULT_AGENT.name, DEFAULT_AGENT.brief));
  workspace.init(room);
  rooms.set(id, room);
  log(id, `room created (${rooms.size} total)`);
  return room;
}

// Room creation is capped: sweep dead rooms first, refuse if genuinely full.
function getOrCreateRoom(id) {
  const existing = rooms.get(id);
  if (existing) return existing;
  if (rooms.size >= MAX_ROOMS) {
    gcRooms();
    if (rooms.size >= MAX_ROOMS) {
      log('-', `room cap reached (${MAX_ROOMS}); refusing new room ${id}`);
      return null;
    }
  }
  return makeRoom(id);
}

// Sweep: empty rooms with nothing in them go immediately; empty rooms with
// content expire after IDLE_EVICT_MS.
function gcRooms() {
  const now = Date.now();
  let dropped = 0;
  for (const [id, r] of rooms) {
    if (r.people.size > 0 || r.bridges.size > 0 || r.personalBridges?.size > 0) continue;
    if (!roomHasContent(r) || now - (r.lastActivity || r.createdAt) > IDLE_EVICT_MS) {
      rooms.delete(id);
      dropped++;
    }
  }
  if (dropped) {
    log('-', `gc: dropped ${dropped} idle room(s) (${rooms.size} remain)`);
    schedulePersist();
  }
}
setInterval(gcRooms, GC_EVERY_MS).unref();

// Budget check for anything that spends a brain turn.
const globalRuns = { start: 0, count: 0 };
function allowRun(room) {
  const now = Date.now();
  if (now - globalRuns.start > GLOBAL_RUNS.windowMs) { globalRuns.start = now; globalRuns.count = 0; }
  if (now - room.runWindow.start > ROOM_RUNS.windowMs) {
    room.runWindow.start = now; room.runWindow.count = 0; room.runWindow.notified = false;
  }
  if (room.runWindow.count >= ROOM_RUNS.max || globalRuns.count >= GLOBAL_RUNS.max) {
    if (!room.runWindow.notified) {
      room.runWindow.notified = true;
      const which = room.runWindow.count >= ROOM_RUNS.max ? 'this table' : 'the whole server';
      say(room, { kind: 'system', text: `Agent-run budget for ${which} is used up for now — runs resume within the hour.` });
      log(room.id, `run budget exhausted (room ${room.runWindow.count}/${ROOM_RUNS.max}, global ${globalRuns.count}/${GLOBAL_RUNS.max})`);
    }
    return false;
  }
  room.runWindow.count++;
  globalRuns.count++;
  return true;
}
const nextColor = (room) => COLORS[room.colorIdx++ % COLORS.length];

// The compute pool serving a room: room bridges, then server-wide bridges,
// then the house key.
function brainsFor(room) {
  const pool = [];
  for (const [ws, b] of room.bridges) pool.push({ ...b, ws });
  if (SHARED_ROOMS.has(room.id)) {
    // Applying files requires a bridge explicitly attached to this room.
    for (const [ws, b] of defaultBridges) pool.push({ ...b, ws, canApply: false });
    if (houseAvailable()) pool.push({ name: 'house', provider: 'anthropic api', ws: null });
  }
  return pool;
}

const publicBrains = (room) => brainsFor(room).map(({ name, provider, models, canApply }) =>
  ({ name, provider, models: models || [], canApply: !!canApply }));

// The brain that would serve an agent right now: its pin if attached,
// otherwise its slot in the pool spread.
function effectiveBrain(room, agent, pool = brainsFor(room)) {
  if (!pool.length) return null;
  const pinned = agent.brain && pool.find((b) => b.name.toLowerCase() === agent.brain.toLowerCase());
  return pinned || pool[room.agents.indexOf(agent) % pool.length];
}

const publicAgents = (room) => {
  const pool = brainsFor(room);
  return room.agents.map((a) => ({
    name: a.name, brief: a.brief, color: a.color, soul: a.soul || '',
    model: a.model, effort: a.effort, brain: a.brain,
    via: effectiveBrain(room, a, pool)?.name || null,
    busy: room.running === a.name,
  }));
};

const branchesOf = (room) =>
  [...rooms.values()]
    .filter((r) => r.parent?.id === room.id)
    .map((r) => ({ id: r.id, title: r.title }));

function publicState(room) {
  return {
    id: room.id,
    work: workspace.publicWork(room),
    connections: workspace.connections(room),
    workspaceRoster:workspace.roster(room),
    sharedContext: room.sharedContext,
    tasks:room.tasks,taskPeople:taskPeople(room),taskAgents:taskAgents(room),
    title: room.title,
    branches: branchesOf(room),
    problem: room.problem,
    canvas: room.canvas,
    canvasRevision: room.canvasRevision,
    chat: room.chat.slice(-100),
    auto: room.auto,
    access: room.access,
    hostOnlySpend: room.hostOnlySpend,
    parent: room.parent || null,
    agents: publicAgents(room),
    brains: publicBrains(room),
    people: [...room.people.values()].map(({ name, color }) => ({ name, color })),
  };
}

// Private notice to one connection — not persisted, not broadcast.
const tell = (ws, text) => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'chat', entry: { kind: 'system', text } }));
};

const canManage = (room, you) => room.access === 'open' || !!you?.isHost;
const canSpeak = (room, you) => room.access !== 'view' || !!you?.isHost;
const canSpend = (room, you) => !room.hostOnlySpend || !!you?.isHost;
const ACCESS_TIERS = ['open', 'managed', 'view'];
const ACCESS_BLURB = {
  open: 'anyone can talk, task agents, and manage them',
  managed: 'anyone can talk and task agents; only the host configures them',
  view: 'guests can watch; only the host can speak',
};

function broadcast(room, msg, except) {
  const asOf=Date.now(),data = JSON.stringify({...msg,asOf});
  for (const ws of room.people.keys()) {
    if (ws !== except && ws.readyState === 1) {ws.deliveredThrough=asOf;ws.send(data);}
  }
}

function say(room, entry) {
  entry.id ||= randomBytes(12).toString('base64url');
  entry.ts = Date.now();
  room.lastActivity = entry.ts;
  room.chat.push(entry);
  if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
  broadcast(room, { t: 'chat', entry });
  schedulePersist();
}

const announceAgents = (room) => broadcast(room, { t: 'agents', agents: publicAgents(room) });
const announceBrains = (room) => broadcast(room, { t: 'brains', brains: publicBrains(room) });

const identifyCanvas = (blocks) => blocks.map((block) => ({
  ...block, id: randomBytes(12).toString('base64url'),
}));
const canvasMessage = (room, animate = false) => ({
  t: 'canvas', blocks: room.canvas, revision: room.canvasRevision, animate,
});

// Agent turns and branch merges use optimistic concurrency. A late result
// cannot replace work accepted since its snapshot was taken.
function commitCanvas(room, blocks, baseRevision) {
  if (room.canvasRevision !== baseRevision) return false;
  const withoutIds = (canvas) => canvas.map(({ id, ...block }) => block);
  if (JSON.stringify(withoutIds(room.canvas)) !== JSON.stringify(withoutIds(blocks))) {
    room.canvas = identifyCanvas(blocks);
    room.canvasRevision++;
    broadcast(room, canvasMessage(room, true));
    schedulePersist();
  }
  return true;
}

/* ---------------- Persistence ----------------
Rooms with any real content are saved to DATA_FILE (debounced) and loaded on
boot, so chat, doc, problem, and the agent roster survive restarts. People
and bridges are live connections and never persist. */

const roomHasContent = (r) =>
  r.work?.length > 0 || r.members?.length > 0 || r.chat.length > 0 || r.canvas.length > 0 || r.problem || r.title !== 'Untitled table' ||
  r.agents.length !== 1 || r.agents[0].name !== DEFAULT_AGENT.name;

let persistT = null;
function schedulePersist() {
  if (persistT) return;
  persistT = setTimeout(() => {
    persistT = null;
    const data = [...rooms.values()].filter(roomHasContent).map((r) => ({
      id: r.id, title: r.title, problem: r.problem, canvas: r.canvas, canvasRevision: r.canvasRevision, auto: r.auto,
      hostKey: r.hostKey, hostClaimed: r.hostClaimed,
      access: r.access, hostOnlySpend: r.hostOnlySpend,
      parent: r.parent || null,
      agents: r.agents, chat: r.chat.slice(-CHAT_KEEP), members:r.members, work:r.work,specialists:r.specialists,sharedContext:r.sharedContext,tasks:r.tasks,
      colorIdx: r.colorIdx, createdAt: r.createdAt, lastActivity: r.lastActivity,
    }));
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      writeFileSync(DATA_FILE, JSON.stringify(data));
      vlog('-', `persisted ${data.length} room(s)`);
    } catch (err) {
      log('-', `persist FAILED: ${err.message}`);
    }
  }, 1000);
}

function loadRooms() {
  let data;
  try {
    data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return; // first boot, or no data file
  }
  for (const r of data) {
    rooms.set(r.id, {
      id: r.id, title: r.title, problem: r.problem,
      // Migrate pre-canvas rooms: the old doc string becomes one text block.
      canvas: identifyCanvas(Array.isArray(r.canvas) ? r.canvas
        : r.doc ? [{ type: 'text', title: 'Notes', content: r.doc }] : []),
      canvasRevision: Number.isSafeInteger(r.canvasRevision) ? r.canvasRevision : 0,
      auto: r.auto !== false,
      hostKey: r.hostKey || randomBytes(9).toString('base64url'),
      hostClaimed: !!r.hostClaimed,
      // Pre-tier rooms stored a `locked` boolean; locked === host-managed.
      access: ACCESS_TIERS.includes(r.access) ? r.access : (r.locked ? 'managed' : 'open'),
      hostOnlySpend: !!r.hostOnlySpend,
      parent: r.parent || null,
      agents: Array.isArray(r.agents) && r.agents.length ? r.agents : [{ ...DEFAULT_AGENT, color: AGENT_COLORS[0] }],
      members:r.members || [], specialists:r.specialists || [],sharedContext:r.sharedContext,tasks:(r.tasks || []).map(t=>t.status==='working'?{...t,status:'blocked',version:t.version+1,updatedAt:Date.now()}:t), work:(r.work || []).map(w => ['running','integrating'].includes(w.status) ? {...w,status:'interrupted',updatedAt:Date.now(),message:'Server restarted. Reconnect the original machine and project to resume retained work.'}:w), personalBridges:new Map(),
      chat: r.chat || [], autoT: null, queue: [], running: null, hops: 0,
      people: new Map(), bridges: new Map(),
      colorIdx: r.colorIdx || 0, createdAt: r.createdAt || Date.now(),
      lastActivity: r.lastActivity || r.createdAt || Date.now(),
      runWindow: { start: 0, count: 0, notified: false },
    });
  }
  log('-', `restored ${rooms.size} room(s) from ${DATA_FILE}`);
}

/* ---------------- Agent runs ---------------- */

function snapshotFor(room, agent, directTask) {
  return {
    sharedContext:contextSummary(room),
    agentName: agent.name,
    brief: agent.brief,
    soul: agent.soul || '',
    model: agent.model || null,
    effort: agent.effort || null,
    otherAgents: room.agents.filter((a) => a.name !== agent.name).map((a) => a.name),
    title: room.title,
    problem: room.problem,
    canvas: structuredClone(room.canvas),
    chat: room.chat.slice(-14),
    directTask,
  };
}

function bridgeTask(bridgeWs, room, snapshot) {
  return new Promise((resolve, reject) => {
    const id = ++taskSeq;
    const timer = setTimeout(() => {
      pendingTasks.delete(id);
      log(room.id, `bridge task #${id} timed out after ${BRIDGE_TASK_TIMEOUT_MS / 1000}s`);
      reject(new Error('bridge timed out'));
    }, BRIDGE_TASK_TIMEOUT_MS);
    pendingTasks.set(id, {
      ws: bridgeWs,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    bridgeWs.send(JSON.stringify({ t: 'task', id, room: room.id, ...snapshot }));
  });
}

// One agent holds the floor at a time; everything else queues. Keeps chat
// turn-based and the doc free of concurrent rewrites.
function enqueueAgentRun(room, name, directTask) {
  // Coalesce automatic replies; explicit follow-ups each keep their task.
  if (!directTask && room.queue.some((q) => q.name === name)) return;
  if (!allowRun(room)) return;
  room.queue.push({ name, directTask });
  pumpQueue(room);
}

async function pumpQueue(room) {
  if (room.running) return;
  const next = room.queue.shift();
  if (!next) return;
  room.running = next.name;
  try {
    await runAgent(room, next.name, next.directTask);
  } finally {
    room.running = null;
    pumpQueue(room);
  }
}

async function runAgent(room, name, directTask) {
  const agent = room.agents.find((a) => a.name === name);
  if (!agent) {
    vlog(room.id, `agent ${name} was retired before their turn; run dropped`);
    return;
  }
  // Spread personas across the brain pool so two agents don't share one
  // brain's context; stable per-agent while the pool is unchanged.
  const pool = brainsFor(room);
  if (!pool.length) {
    say(room, { kind: 'system', text: `${name} has no brain to think with — attach a bridge to this room: node bridge/codex.js <server url>/s/${room.id}` });
    return;
  }
  // A pinned brain wins; otherwise spread personas across the pool.
  if (agent.brain && !pool.some((b) => b.name.toLowerCase() === agent.brain.toLowerCase())) {
    say(room, { kind: 'system', text: `${agent.name} is pinned to brain "${agent.brain}", which isn't attached — using another.` });
  }
  const brain = effectiveBrain(room, agent, pool);

  broadcast(room, { t: 'agent_state', name: agent.name, busy: true });
  const started = Date.now();
  const opts = [agent.model && `model=${agent.model}`, agent.effort && `effort=${agent.effort}`].filter(Boolean).join(' ');
  log(room.id, `run ${agent.name} on ${brain.name} (${brain.provider})${opts ? ` ${opts}` : ''}${directTask ? ' (direct)' : ''} [hops ${room.hops}/${MAX_HOPS}]`);
  try {
    const baseRevision = room.canvasRevision;
    const snapshot = snapshotFor(room, agent, directTask);
    const result = brain.ws
      ? await bridgeTask(brain.ws, room, snapshot)
      : await runHouseAgent(snapshot);

    log(room.id, `run ${agent.name} done in ${((Date.now() - started) / 1000).toFixed(1)}s (note ${result.note.length}ch, ${result.canvas.length} block(s))`);
    say(room, { author: agent.name, kind: 'agent', text: result.note, color: agent.color, via: brain.name });
    if (!commitCanvas(room, result.canvas, baseRevision)) {
      say(room, { kind: 'system', text: `${agent.name}'s canvas update was not applied because the canvas changed during its turn. Your newer work is preserved; ask the agent to try again.` });
    }

    // Real room actions the agent asked for.
    for (const act of result.actions || []) {
      if (room.access !== 'open') {
        say(room, { kind: 'system', text: `${agent.name} tried to ${act.action === 'update_soul' ? 'update its soul' : `invite ${act.name}`}, but only the host manages agents at this table.` });
        continue;
      }
      if (act.action === 'create_agent') {
        const err = upsertAgent(room, { name: agent.name }, act.name, act.brief, {}, act.soul || undefined);
        if (err) say(room, { kind: 'system', text: `${agent.name} tried to invite ${act.name}: ${err}` });
      } else if (act.action === 'update_soul') {
        // An agent may only rewrite its own soul.
        if (act.name.toLowerCase() !== agent.name.toLowerCase() || !act.soul.trim()) continue;
        agent.soul = act.soul.trim().slice(0, 1500);
        log(room.id, `${agent.name} updated its own soul (${agent.soul.length}ch)`);
        say(room, { kind: 'system', text: `${agent.name} updated its soul.` });
        announceAgents(room);
        schedulePersist();
      }
    }

    // Did this agent hand the floor to another agent?
    const others = room.agents.filter((a) => a.name !== agent.name);
    const mentioned = others.find((a) => result.note.toLowerCase().includes('@' + a.name.toLowerCase()));
    if (mentioned) {
      if (room.hops < MAX_HOPS) {
        room.hops++;
        log(room.id, `${agent.name} handed to ${mentioned.name} (hop ${room.hops}/${MAX_HOPS})`);
        enqueueAgentRun(room, mentioned.name, `${agent.name} said to you: "${result.note}"`);
      } else {
        log(room.id, `${agent.name} mentioned ${mentioned.name} but the hop budget is spent`);
        say(room, { kind: 'system', text: `Agents paused — they'll pick it back up after the next human message.` });
      }
    }
  } catch (err) {
    log(room.id, `run ${agent.name} FAILED in ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message}`);
    say(room, { kind: 'system', text: `${agent.name} hit a snag (${err.message}). Try again.` });
  } finally {
    broadcast(room, { t: 'agent_state', name: agent.name, busy: false });
  }
}

// Merge a branch's work back into its parent: one agent turn that edits the
// PARENT canvas, using the branch's canvas and chat as source material.
async function runMerge(room, you) {
  const parent = room.parent && rooms.get(room.parent.id);
  if (!parent) { say(room, { kind: 'system', text: 'This table has no parent to merge into.' }); return; }
  if (!canManage(room, you)) { say(room, { kind: 'system', text: 'Only the host can merge at this table.' }); return; }
  if (!canSpend(room, you) || !canSpeak(parent, you) || !canManage(parent, you) || !canSpend(parent, you)) {
    say(room, { kind: 'system', text: 'You do not have permission to spend compute and merge into the parent table.' });
    return;
  }
  if (room.running || room.queue.length) { say(room, { kind: 'system', text: 'Agents are mid-run — try /merge again in a moment.' }); return; }
  if (!allowRun(room)) return;
  const agent = room.agents[0];
  const pool = brainsFor(room);
  if (!agent || !pool.length) { say(room, { kind: 'system', text: 'No agent or brain available to merge with.' }); return; }
  const brain = effectiveBrain(room, agent, pool);

  room.running = agent.name;
  broadcast(room, { t: 'agent_state', name: agent.name, busy: true });
  const started = Date.now();
  log(room.id, `merge into ${parent.id} by ${you.name}, via ${agent.name} on ${brain.name}`);
  try {
    const baseRevision = parent.canvasRevision;
    const snapshot = {
      agentName: agent.name,
      brief: agent.brief,
      soul: agent.soul || '',
      model: agent.model || null,
      effort: agent.effort || null,
      otherAgents: [],
      title: parent.title,
      problem: parent.problem,
      canvas: structuredClone(parent.canvas), // the canvas being edited is the PARENT's
      chat: room.chat.slice(-14),
      directTask: `Fold this branch's work back into the parent table's canvas. The canvas above is the PARENT's — rewrite it to integrate what branch "${room.title}" concluded. Branch canvas:\n\n${serializeCanvas(room.canvas)}\n\nKeep whatever in the parent canvas is still current, integrate the branch's conclusions, drop duplicates. Your chat note will be posted to the parent table — one or two sentences on what came back.`,
    };
    const result = brain.ws
      ? await bridgeTask(brain.ws, room, snapshot)
      : await runHouseAgent(snapshot);

    log(room.id, `merge done in ${((Date.now() - started) / 1000).toFixed(1)}s (parent canvas ${result.canvas.length} block(s))`);
    if (!commitCanvas(parent, result.canvas, baseRevision)) {
      say(room, { kind: 'system', text: 'Merge was not applied because the parent canvas changed. Its newer work is preserved; try merging again.' });
      return;
    }
    say(parent, { kind: 'system', text: `${you.name} merged branch "${room.title}" back`, room: room.id });
    say(parent, { author: agent.name, kind: 'agent', text: result.note, color: agent.color, via: brain.name });
    say(room, { kind: 'system', text: `Merged into "${parent.title}"`, room: parent.id });
    schedulePersist();
  } catch (err) {
    log(room.id, `merge FAILED in ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message}`);
    say(room, { kind: 'system', text: `Merge hit a snag (${err.message}). Try again.` });
  } finally {
    room.running = null;
    broadcast(room, { t: 'agent_state', name: agent.name, busy: false });
    pumpQueue(room);
  }
}

// Auto mode: the first agent replies to conversation without a mention.
// Debounced so a burst of messages produces one reply with all in context.
function scheduleAutoRun(room) {
  if (!room.agents.length || !brainsFor(room).length) return;
  clearTimeout(room.autoT);
  room.autoT = setTimeout(() => {
    if (room.agents.length) enqueueAgentRun(room, room.agents[0].name);
  }, 1200);
}

// @mentions in a human message: task each mentioned agent. "@agent" is
// shorthand for the first one.
function humanMentions(room, text) {
  const lower = text.toLowerCase();
  const hit = room.agents.filter((a) => lower.includes('@' + a.name.toLowerCase()));
  if (!hit.length && lower.includes('@agent') && room.agents.length) hit.push(room.agents[0]);
  return hit;
}

/* ---------------- Chat commands ----------------
/agent Name: brief                      — invite a new agent, or re-brief one
/agent Name model=… effort=… brain=…    — change an agent's settings
/agents                                 — list the roster with settings
/retire Name                            — remove an agent from the table */

const SETTING_KEYS = ['model', 'effort', 'brain'];
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const agentCard = (a) => {
  const bits = ['model', 'effort', 'brain'].filter((k) => a[k]).map((k) => `${k}=${a[k]}`);
  return `${a.name} — "${a.brief}"${bits.length ? ` (${bits.join(', ')})` : ''}`;
};

// Shared by chat commands, the settings UI, and agent create_agent actions.
// `settings` values: string sets, empty string clears, undefined leaves alone.
// `soul` follows the same tri-state. Returns an error string or null.
function upsertAgent(room, actor, rawName, brief, settings = {}, soul = undefined) {
  const name = rawName[0].toUpperCase() + rawName.slice(1);
  if (['agents', 'house'].includes(name.toLowerCase())) return `"${name}" is reserved — pick another name.`;
  if (settings.effort && !EFFORTS.includes(settings.effort)) {
    return `Unknown effort "${settings.effort}". Try: ${EFFORTS.join(', ')}.`;
  }
  if (settings.brain && !brainsFor(room).some((b) => b.name.toLowerCase() === settings.brain.toLowerCase())) {
    const have = brainsFor(room).map((b) => b.name).join(', ') || 'none attached';
    return `No brain named "${settings.brain}" here (attached: ${have}).`;
  }
  if (settings.model) {
    // Only enforceable when every attached brain reports its model list.
    const pool = brainsFor(room);
    const lists = pool.map((b) => b.models || []);
    if (pool.length && lists.every((l) => l.length)) {
      const known = new Set(lists.flat().map((m) => m.id));
      if (!known.has(settings.model)) {
        return `Model "${settings.model}" isn't served by any attached brain. Available: ${[...known].join(', ')}.`;
      }
    }
  }

  const existing = room.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!existing && !brief) return `No agent named "${name}" yet — give them a brief to invite them.`;

  let agent = existing;
  const changes = [];
  if (!existing) {
    if (room.agents.length >= MAX_AGENTS) return `The table is full (${MAX_AGENTS} agents). Retire someone first.`;
    agent = makeAgent(room, name, brief.trim().slice(0, 300));
    room.agents.push(agent);
    changes.push('invited');
  } else if (brief && brief.trim() !== agent.brief) {
    agent.brief = brief.trim().slice(0, 300);
    changes.push('re-briefed');
  }
  for (const k of SETTING_KEYS) {
    if (settings[k] === undefined || settings[k] === (agent[k] || '')) continue;
    if (settings[k]) { agent[k] = String(settings[k]).slice(0, 64); changes.push(`${k}=${agent[k]}`); }
    else { delete agent[k]; changes.push(`${k} cleared`); }
  }
  if (soul !== undefined && soul.trim() !== (agent.soul || '')) {
    if (soul.trim()) { agent.soul = soul.trim().slice(0, 1500); changes.push('soul updated'); }
    else { delete agent.soul; changes.push('soul cleared'); }
  }
  if (changes.length) {
    log(room.id, `agent ${agent.name} ${changes.join(', ')} by ${actor.name}`);
    say(room, { kind: 'system', text: `${actor.name}: ${agent.name} ${changes.join(', ')}. Now: ${agentCard(agent)}` });
    announceAgents(room);
    schedulePersist();
  }
  return null;
}

function retireAgent(room, actor, rawName) {
  const idx = room.agents.findIndex((a) => a.name.toLowerCase() === rawName.toLowerCase());
  if (idx === -1) return `No agent named "${rawName}" at this table.`;
  const [gone] = room.agents.splice(idx, 1);
  room.queue = room.queue.filter((q) => q.name !== gone.name);
  log(room.id, `agent ${gone.name} retired by ${actor.name}`);
  say(room, { kind: 'system', text: `${actor.name} retired ${gone.name} from the table.` });
  announceAgents(room);
  schedulePersist();
  return null;
}

function handleCommand(room, you, text) {
  const cmd = text.match(/^\/agent\s+([A-Za-z][\w-]{0,15})((?:\s+[a-z]+=\S*)*)\s*(?::\s*([\s\S]{1,300}))?$/);
  if (cmd) {
    const [, rawName, settingsRaw, brief] = cmd;
    const settings = {};
    for (const [, k, v] of settingsRaw.matchAll(/([a-z]+)=(\S*)/g)) {
      if (!SETTING_KEYS.includes(k)) {
        say(room, { kind: 'system', text: `Unknown setting "${k}". Settings: ${SETTING_KEYS.join(', ')}.` });
        return true;
      }
      settings[k] = v;
    }
    if (!brief && !Object.keys(settings).length) {
      const agent = room.agents.find((a) => a.name.toLowerCase() === rawName.toLowerCase());
      say(room, { kind: 'system', text: agent ? agentCard(agent)
        : `No agent named "${rawName}" yet — invite them with a brief: /agent ${rawName}: <brief>` });
      return true;
    }
    const err = upsertAgent(room, you, rawName, brief, settings);
    if (err) say(room, { kind: 'system', text: err });
    return true;
  }

  const branch = text.match(/^\/branch\s+(.{1,40})$/);
  if (branch) {
    if (!canManage(room, you)) {
      say(room, { kind: 'system', text: 'Only the host can branch this table.' });
      return true;
    }
    const topic = branch[1].trim();
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!slug) {
      say(room, { kind: 'system', text: 'Give the branch a topic: /branch pricing debate' });
      return true;
    }
    let id = slug, i = 2;
    while (rooms.has(id) && roomHasContent(rooms.get(id))) id = `${slug}-${i++}`;
    const b = getOrCreateRoom(id);
    if (!b) { say(room, { kind: 'system', text: 'The server is at its room limit; the branch was not created.' }); return true; }
    // The branch starts warm: same problem, canvas snapshot, and agent roster
    // (souls and settings included) — but a fresh chat. Governance is inherited
    // too: same lock state and the same host key, so the parent's host is the
    // branch's host (their browser re-presents the parent key on arrival).
    b.title = topic;
    b.problem = room.problem;
    b.canvas = identifyCanvas(room.canvas);
    b.canvasRevision = 0;
    b.agents = room.agents.map((a) => ({ ...a }));
    b.auto = room.auto;
    b.access = room.access;
    b.hostOnlySpend = room.hostOnlySpend;
    b.hostKey = room.hostKey;
    b.hostClaimed = true; // no first-comer claim on branches — hostship is inherited
    b.parent = { id: room.id, title: room.title };
    // The live tail of the talk travels too: the canvas lags the conversation,
    // so the branch gets the last few real messages as dimmed context.
    b.chat = room.chat.filter((m) => m.kind === 'human' || m.kind === 'agent')
      .slice(-12).map((m) => ({ ...m, ctx: true }));
    log(room.id, `branched "${topic}" -> ${id} by ${you.name}`);
    say(b, { kind: 'branch', label: room.title, room: room.id, sub: 'branched from here — agents, canvas, and the recent chat above carried over', back: true });
    say(room, { kind: 'branch', label: topic, room: id, sub: `branched by ${you.name} — agents, canvas, and recent chat carried over` });
    broadcast(room, { t: 'branches', branches: branchesOf(room) });
    return true;
  }

  if (/^\/merge\s*$/.test(text)) {
    runMerge(room, you);
    return true;
  }

  if (/^\/agents\s*$/.test(text)) {
    const brains = brainsFor(room).map((b) => `${b.name} (${b.provider})`).join(', ') || 'none';
    const lines = room.agents.map(agentCard).join('\n') || 'No agents at the table.';
    say(room, { kind: 'system', text: `${lines}\nBrains: ${brains}` });
    return true;
  }

  const retire = text.match(/^\/retire\s+([A-Za-z][\w-]{0,15})\s*$/);
  if (retire) {
    const err = retireAgent(room, you, retire[1]);
    if (err) say(room, { kind: 'system', text: err });
    return true;
  }

  if (text.startsWith('/')) {
    say(room, { kind: 'system', text: 'Commands: /agent Name: brief · /agent Name model=… effort=… brain=… · /agents · /retire Name · /branch topic · /merge' });
    return true;
  }
  return false;
}

/* ---------------- Bridge lifecycle ---------------- */

function attachBridge(ws, { room, name, provider, models, canApply }) {
  const entry = { name, provider, models, canApply };
  if (room) {
    room.bridges.set(ws, entry);
    log(room.id, `brain attached: ${name} (${provider})`);
    say(room, { kind: 'system', text: `A ${provider} brain ("${name}") plugged in — agents can think now.` });
    announceBrains(room);
    announceAgents(room); // brain assignments may have shifted
  } else {
    defaultBridges.set(ws, entry);
    log('*', `default brain attached: ${name} (${provider}) — serves operator-approved rooms`);
    for (const r of rooms.values()) {
      if (r.people.size > 0 && SHARED_ROOMS.has(r.id)) {
        say(r, { kind: 'system', text: `A ${provider} brain ("${name}") plugged in — agents can think now.` });
        announceBrains(r);
        announceAgents(r);
      }
    }
  }
}

function detachBridgeWs(ws) {
  let dropped = 0;
  for (const [id, p] of pendingTasks) {
    if (p.ws === ws) { pendingTasks.delete(id); dropped++; p.reject(new Error('bridge disconnected')); }
  }
  const entry = defaultBridges.get(ws) || [...rooms.values()].find((r) => r.bridges.has(ws))?.bridges.get(ws);
  const wasDefault = defaultBridges.delete(ws);
  const affected = [];
  for (const room of rooms.values()) {
    if (room.bridges.delete(ws) || (wasDefault && SHARED_ROOMS.has(room.id) && room.people.size > 0)) affected.push(room);
  }
  if (!entry) return;
  log('*', `brain detached: ${entry.name} (${dropped} pending task(s) dropped)`);
  for (const room of affected) {
    say(room, { kind: 'system', text: `The ${entry.provider} brain ("${entry.name}") unplugged.` });
    announceBrains(room);
    announceAgents(room); // brain assignments may have shifted
  }
}

/* ---------------- HTTP ---------------- */

const workspace = createWorkspaces({rooms,broadcast,persist:schedulePersist,tell,canSpeak,allowRun,say,dataDir:dirname(DATA_FILE)});
const app = express();
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});
workspace.mount(app);
app.use(express.static('public'));

// Rooms are only ever created by a ws join — HTTP handlers mint nothing, so
// health checks and crawlers hitting these routes can't leak rooms.
app.get('/', (_req, res) => {
  res.redirect(`/s/${randomBytes(6).toString('base64url')}`);
});

app.get('/s/:id', (_req, res) => {
  res.sendFile('room.html', { root: 'public' });
});

const server = createServer(app);

/* ---------------- WebSocket protocol ----------------
People:  join{room}, chat{text}, edit_title{text}, edit_problem{text},
         peek{room,hostKey}, edit_block{index,content}, set_auto{on},
         set_access{tier,hostOnlySpend}, set_name{name},
         agent_upsert{...}, agent_retire{name}
Bridges: bridge_join{room:id|'*',provider,name?,models?} up, then
         task{id,room,...snapshot} down, result{id,ok,note,canvas,error} up
Server -> people: welcome{you,state}, chat{entry}, presence{people},
         title{text}, problem{text}, canvas{blocks,animate}, block{index,content},
         auto{on}, access{access,hostOnlySpend}, you{you}, preview{...},
         agents{agents}, brains{brains}, agent_state{name,busy}
------------------------------------------------------- */

// Origin gate runs at the handshake so cross-site upgrades get a clean 403 and
// never fire 'open' on the client.
const connsPerIp = new Map();
function ipOf(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  // With N trusted hops, the client the nearest trusted proxy saw is the Nth
  // from the right. A client can prepend fakes but can't forge what the proxy adds.
  if (PROXY_HOPS > 0 && xff.length) return xff[Math.max(0, xff.length - PROXY_HOPS)];
  return req.socket.remoteAddress || '?';
}
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_FRAME_BYTES,
  verifyClient: (info) => {
    if (!originAllowed(info.req)) {
      log('-', `ws upgrade rejected: cross-site origin ${info.req.headers.origin}`);
      return false;
    }
    const ip = ipOf(info.req);
    if ((connsPerIp.get(ip) || 0) >= MAX_CONN_PER_IP) {
      log('-', `ws upgrade rejected: too many connections from ${ip}`);
      return false;
    }
    return true;
  },
});

// Browser connections must come from our own pages (no ambient auth exists,
// but cross-site sockets shouldn't get to spend the room budgets either).
// Non-browser clients (bridges, scripts) send no Origin header and pass.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host) return true;
    if (['localhost', '127.0.0.1'].includes(o.hostname)) return true;
    return EXTRA_ORIGINS.includes(origin);
  } catch {
    return false;
  }
}


// Reap dead connections so idle sockets can't pile up as memory.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS).unref();

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (err) => vlog(null, `websocket error: ${err.message}`));

  let room = null;
  let isBridge = false;
  const rate = { start: Date.now(), count: 0, warned: false };

  ws.on('message', async (raw) => {
    if (raw.length > MAX_FRAME_BYTES) {
      vlog(room?.id, `dropped oversized ws frame (${raw.length}b)`);
      return;
    }
    // Per-connection flood guard (bridges exempt — their traffic is ours).
    if (!isBridge) {
      const now = Date.now();
      if (now - rate.start > WS_RATE.windowMs) { rate.start = now; rate.count = 0; rate.warned = false; }
      if (++rate.count > WS_RATE.max) {
        if (!rate.warned) {
          rate.warned = true;
          log(room?.id, 'connection rate-limited');
          tell(ws, 'Slow down — you are sending too fast. Messages are being dropped for a moment.');
        }
        return;
      }
    }
    let msg;
    try { msg = JSON.parse(raw); } catch {
      vlog(room?.id, `ignored unparseable ws frame (${raw.length}b)`);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    vlog(room?.id, `<- ${isBridge ? 'bridge ' : ''}${msg.t} (${raw.length}b)`);

    if (msg.t === 'peek') {
      // Arrival screen: describe the table without sitting down at it.
      const r = rooms.get(String(msg.room || ''));
      ws.send(JSON.stringify({
        t: 'preview',
        room: String(msg.room || ''),
        exists: !!r,
        title: r ? r.title : 'New table',
        people: r ? [...r.people.values()].map(({ name, color }) => ({ name, color })) : [],
        agents: r ? r.agents.map(({ name, color }) => ({ name, color })) : [],
        brains: r ? publicBrains(r).map((b) => b.name) : [],
        access: r ? r.access : DEFAULT_ACCESS,
        hostOnlySpend: r ? r.hostOnlySpend : DEFAULT_HOST_ONLY_SPEND,
        hostPresent: r ? [...r.people.values()].some((p) => p.isHost) : false,
        // You'd be the host if the table has never been claimed, or you hold the key.
        wouldHost: r ? (!r.hostClaimed || msg.hostKey === r.hostKey) : true,
      }));
      return;
    }

    if (msg.t === 'join') {
      if (isBridge || room) { tell(ws, 'Already joined; open a new connection to join another table.'); return; }
      if (typeof msg.room !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(msg.room)) {
        tell(ws, 'Invalid room name.'); return;
      }
      room = getOrCreateRoom(msg.room);
      if (!room) {
        tell(ws, 'This server is at its room limit — try again later.');
        ws.close();
        return;
      }
      if (room.people.size >= MAX_PEOPLE_PER_ROOM) {
        tell(ws, 'This table is full.');
        ws.close();
        return;
      }
      room.lastActivity = Date.now();
      // A name the person chose (remembered on their device) wins over the
      // auto-assigned critter, unless it collides with someone already here.
      const wanted = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      const clash = wanted && [...room.people.values()].some((p) => p.name.toLowerCase() === wanted.toLowerCase());
      const you = {
        name: (wanted && !clash) ? wanted : `${pick(ADJ)} ${pick(CRITTER)}`,
        color: nextColor(room),
      };
      let membership;
      try { membership=workspace.joinMember(room,msg.memberKey,you.name); }
      catch(error) { tell(ws,error.message); ws.close(); return; }
      you.id=membership.member.id;
      // Host: returning key wins; otherwise the first person to sit down
      // claims the table and their browser keeps the key.
      let hostKeyToSend = null;
      if (msg.hostKey && msg.hostKey === room.hostKey) {
        you.isHost = true;
      } else if (!room.hostClaimed) {
        you.isHost = true;
        room.hostClaimed = true;
        hostKeyToSend = room.hostKey;
        schedulePersist();
      }
      room.people.set(ws, you);
      log(room.id, `join: ${you.name}${you.isHost ? ' (host)' : ''} (${room.people.size} people)`);
      const catchup=catchupSummary(room,membership.member);ws.deliveredThrough=catchup.through;
      membership.member.lastSeenAt ||= catchup.through;
      ws.send(JSON.stringify({
        t: 'welcome',catchup,asOf:catchup.through,
        you: { id:you.id, name: you.name, color: you.color, isHost: !!you.isHost },
        memberKey:membership.memberKey,
        hostKey: hostKeyToSend,
        state: publicState(room),
      }));
      broadcast(room, { t: 'presence', people: [...room.people.values()].map(({ name, color }) => ({ name, color })) }, ws);
      workspace.announce(room);
      say(room, { kind: 'system', text: `${you.name} pulled up a chair.` });
      return;
    }

    if (msg.t === 'workspace_bridge_join') {
      if (isBridge || room) { ws.close(1008,'already joined'); return; }
      const target=rooms.get(msg.room);
      if (!target || !workspace.attach(ws,target,msg.token,msg)) { ws.close(1008,'invalid pairing token'); return; }
      room=target; isBridge=true; return;
    }

    if (msg.t === 'bridge_join') {
      if (isBridge || room) { ws.close(1008, 'already joined'); return; }
      if (BRIDGE_SECRET && msg.secret !== BRIDGE_SECRET) {
        log('-', 'bridge_join rejected: bad or missing secret');
        ws.close(1008, 'bridge auth failed');
        return;
      }
      isBridge = true;
      const provider = String(msg.provider || 'unknown').slice(0, 24);
      const name = String(msg.name || provider).replace(/[^\w-]/g, '').slice(0, 16) || 'brain';
      const models = Array.isArray(msg.models)
        ? msg.models.slice(0, 20).map((m) => ({
            id: String(m.id || '').slice(0, 48),
            efforts: Array.isArray(m.efforts) ? m.efforts.slice(0, 10).map(String) : [],
          })).filter((m) => m.id)
        : [];
      const canApply = !!msg.canApply;
      if (!msg.room || msg.room === '*') {
        attachBridge(ws, { room: null, name, provider, models, canApply });
      } else {
        room = getOrCreateRoom(msg.room);
        if (!room) { ws.close(); return; }
        attachBridge(ws, { room, name, provider, models, canApply });
      }
      return;
    }

    if (isBridge) {
      if (ws.workspaceRoom) {
        if (msg.t === 'workspace_ready') workspace.ready(ws,room,msg);
        if (msg.t === 'workspace_progress') workspace.progress(ws,room,msg);
        if (msg.t === 'workspace_chat_result') workspace.conversation.result(ws,room,msg);
        if (msg.t === 'workspace_context_request') workspace.contextRequest(ws,room,msg);
        return;
      }
      if (msg.t === 'apply_result') {
        const pending = pendingApplies.get(msg.id);
        if (!pending || pending.ws !== ws) return;
        clearTimeout(pending.timer);
        pendingApplies.delete(msg.id);
        const out = String(msg.output || '').slice(0, 400);
        log(pending.room.id, `apply "${pending.title}" ${msg.ok ? 'succeeded' : 'FAILED'}: ${out}`);
        say(pending.room, { kind: 'system', text: msg.ok
          ? `Applied "${pending.title}" on the host's machine — ${out}`
          : `Could not apply "${pending.title}": ${out}` });
        return;
      }
      if (msg.t === 'result') {
        const pending = pendingTasks.get(msg.id);
        if (!pending || pending.ws !== ws) {
          log(room?.id, `bridge result #${msg.id} arrived after timeout/detach; dropped`);
          return;
        }
        pendingTasks.delete(msg.id);
        const canvas = msg.ok ? sanitizeCanvas(msg.canvas) : null;
        if (msg.ok && typeof msg.note === 'string' && canvas) {
          pending.resolve({ note: msg.note, canvas, actions: sanitizeActions(msg.actions) });
        } else {
          pending.reject(new Error(String(msg.error || 'malformed bridge reply').slice(0, 200)));
        }
      }
      return;
    }
    if (!room) return;

    const you = room.people.get(ws);
    if (!you) return;
    if(msg.t==='catchup_request'){const member=room.members.find(m=>m.id===you.id);if(member){const catchup=catchupSummary(room,member);ws.deliveredThrough=catchup.through;ws.send(JSON.stringify({t:'catchup',catchup,asOf:catchup.through}));}return;}
    if(msg.t==='catchup_seen'){const member=room.members.find(m=>m.id===you.id);if(member && markSeen(member,msg.through,ws.deliveredThrough || 0))schedulePersist();return;}
    if (workspace.sharedContext.handle(ws,room,you,msg)) return;
    if (workspace.handle(ws,room,you,msg)) return;
    if (['edit_title', 'edit_problem', 'edit_block', 'merge'].includes(msg.t) && !canSpeak(room, you)) {
      tell(ws, 'This table is view-only — only the host can change it.');
      if (msg.t === 'edit_block') ws.send(JSON.stringify({ ...canvasMessage(room), t: 'canvas_conflict', draft: String(msg.content || '').slice(0, 6000) }));
      return;
    }

    switch (msg.t) {
      case 'chat': {
        const text = String(msg.text || '').slice(0, 2000).trim();
        if (!text) break;
        if (!canSpeak(room, you)) {
          tell(ws, 'This table is view-only — you can watch, but only the host can speak.');
          break;
        }
        if (/^\/(agent|retire)\b/.test(text) && !canManage(room, you)) {
          tell(ws, 'Only the host manages agents at this table.');
          break;
        }
        if(msg.taskId && !room.tasks.some(t=>t.id===msg.taskId)){tell(ws,'Task no longer exists.');break;}
        if (workspace.command(ws,room,you,text)) break;
        if (handleCommand(room, you, text)) break;
        say(room, { author: you.name, kind: 'human', text, taskId:msg.taskId || null, color: you.color });
        const personalConversation=workspace.conversation.human(room,you,text,msg.taskId);
        room.hops = 0; // humans reset the agent-to-agent budget
        const mentioned = humanMentions(room, text);
        if (!canSpend(room, you)) {
          // The host is paying for the brain and has reserved it for themselves.
          if (mentioned.length) tell(ws, 'Only the host can put agents to work at this table.');
          break;
        }
        if (mentioned.length) {
          clearTimeout(room.autoT);
          mentioned.forEach((a) => enqueueAgentRun(room, a.name, text));
        } else if (room.auto && !personalConversation) {
          scheduleAutoRun(room);
        }
        break;
      }
      case 'set_access': {
        if (!you?.isHost) { tell(ws, 'Only the host can change who can do what.'); break; }
        const tier = ACCESS_TIERS.includes(msg.tier) ? msg.tier : 'open';
        const spend = !!msg.hostOnlySpend;
        const changed = tier !== room.access || spend !== room.hostOnlySpend;
        room.access = tier;
        room.hostOnlySpend = spend;
        workspace.conversation.reconcile(room);
        if (changed) {
          log(room.id, `access=${tier} hostOnlySpend=${spend} by ${you.name}`);
          broadcast(room, { t: 'access', access: tier, hostOnlySpend: spend });
          say(room, { kind: 'system', text: `${you.name} set the table to ${tier} — ${ACCESS_BLURB[tier]}${spend ? ', and only the host can put agents to work' : ''}.` });
          schedulePersist();
        }
        break;
      }
      case 'set_name': {
        const nm = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
        if (!nm || nm === you.name) break;
        const taken = [...room.people.values()].some((p) => p !== you && p.name.toLowerCase() === nm.toLowerCase());
        if (taken) { tell(ws, `Someone at this table is already called "${nm}".`); break; }
        const was = you.name;
        you.name = nm;
        const member=room.members.find(m=>m.id===you.id);
        if(member) member.name=nm;
        log(room.id, `rename: ${was} -> ${nm}`);
        ws.send(JSON.stringify({ t: 'you', you: { id:you.id, name: you.name, color: you.color, isHost: !!you.isHost } }));
        broadcast(room, { t: 'presence', people: [...room.people.values()].map(({ name, color }) => ({ name, color })) });
        say(room, { kind: 'system', text: `${was} is now ${nm}.` });
        break;
      }
      case 'set_auto':
        if (!canManage(room, you)) { tell(ws, 'Only the host can change auto-reply at this table.'); break; }
        room.auto = !!msg.on;
        if (!room.auto) clearTimeout(room.autoT);
        log(room.id, `auto-reply ${room.auto ? 'on' : 'off'} (${you.name})`);
        broadcast(room, { t: 'auto', on: room.auto });
        say(room, { kind: 'system', text: room.auto
          ? `${you.name} turned auto-reply on — agents chime in on their own.`
          : `${you.name} turned auto-reply off — summon agents with @name.` });
        schedulePersist();
        break;
      case 'edit_title': {
        room.title = String(msg.text || '').slice(0, 120) || 'Untitled table';
        broadcast(room, { t: 'title', text: room.title }, ws);
        // Keep the parent's branch index in sync with renames.
        const parentRoom = room.parent && rooms.get(room.parent.id);
        if (parentRoom) broadcast(parentRoom, { t: 'branches', branches: branchesOf(parentRoom) });
        schedulePersist();
        break;
      }
      case 'edit_problem':
        room.problem = String(msg.text || '').slice(0, 2000);
        broadcast(room, { t: 'problem', text: room.problem }, ws);
        schedulePersist();
        break;
      case 'apply_diff': {
        // Host-only, and only to a bridge whose owner opted in with --allow-apply.
        if (!you?.isHost) { tell(ws, 'Only the host can apply a diff to their machine.'); break; }
        const block = room.canvas.find((b) => b.id === msg.blockId);
        if (!block || block.type !== 'diff') { tell(ws, 'That block is not a diff.'); break; }
        const brain = brainsFor(room).find((b) => b.ws && b.canApply);
        if (!brain) { tell(ws, 'No attached bridge allows applying — restart one with --allow-apply.'); break; }
        const id = ++taskSeq;
        const timer = setTimeout(() => {
          if (pendingApplies.delete(id)) {
            say(room, { kind: 'system', text: `Applying "${block.title}" timed out.` });
          }
        }, 30_000);
        pendingApplies.set(id, { room, ws: brain.ws, title: block.title || 'diff', timer });
        log(room.id, `apply "${block.title}" requested by ${you.name} -> brain ${brain.name}`);
        say(room, { kind: 'system', text: `${you.name} is applying "${block.title || 'diff'}" via ${brain.name}…` });
        brain.ws.send(JSON.stringify({ t: 'apply', id, room: room.id, title: block.title || 'diff', diff: block.content }));
        break;
      }
      case 'edit_block': {
        // Humans can edit text blocks in place; code/diff blocks are agent-authored.
        const block = room.canvas.find((b) => b.id === msg.blockId);
        if (!block || block.type !== 'text' || typeof msg.baseContent !== 'string' || block.content !== msg.baseContent) {
          ws.send(JSON.stringify({ ...canvasMessage(room), t: 'canvas_conflict', draft: String(msg.content || '').slice(0, 6000) }));
          break;
        }
        block.content = String(msg.content || '').slice(0, 6000);
        room.canvasRevision++;
        broadcast(room, { t: 'block', blockId: block.id, content: block.content, revision: room.canvasRevision });
        schedulePersist();
        break;
      }
      case 'merge':
        runMerge(room, you);
        break;
      case 'agent_upsert': {
        if (!canManage(room, you)) { tell(ws, 'Only the host manages agents at this table.'); break; }
        const rawName = String(msg.name || '').trim();
        if (!/^[A-Za-z][\w-]{0,15}$/.test(rawName)) {
          say(room, { kind: 'system', text: 'Agent names: letters/digits/dashes, up to 16 characters.' });
          break;
        }
        const settings = {};
        for (const k of SETTING_KEYS) if (msg[k] !== undefined) settings[k] = String(msg[k]).trim();
        const err = upsertAgent(room, you, rawName, String(msg.brief || ''), settings,
          msg.soul !== undefined ? String(msg.soul) : undefined);
        if (err) say(room, { kind: 'system', text: err });
        break;
      }
      case 'agent_retire': {
        if (!canManage(room, you)) { tell(ws, 'Only the host manages agents at this table.'); break; }
        const err = retireAgent(room, you, String(msg.name || ''));
        if (err) say(room, { kind: 'system', text: err });
        break;
      }
    }
  });

  ws.on('close', () => {
    const n = (connsPerIp.get(ip) || 1) - 1;
    if (n <= 0) connsPerIp.delete(ip); else connsPerIp.set(ip, n);
    if (isBridge) {
      if (ws.workspaceRoom) workspace.detach(ws);
      else detachBridgeWs(ws);
      return;
    }
    if (!room) return;
    const you = room.people.get(ws);
    room.people.delete(ws);
    if (you) {
      log(room.id, `leave: ${you.name} (${room.people.size} people)`);
      broadcast(room, { t: 'presence', people: [...room.people.values()].map(({ name, color }) => ({ name, color })) });
      say(room, { kind: 'system', text: `${you.name} left the table.` });
    }
  });
});

loadRooms();

server.listen(PORT, () => {
  console.log(`Roundtable listening on http://localhost:${server.address().port}`);
  console.log(`Attach a brain to a room: node bridge/codex.js http://localhost:${server.address().port}/s/<room>`);
  console.log(`Rooms authorized for shared compute: ${[...SHARED_ROOMS].join(', ') || 'none'}`);
  if (houseAvailable()) {
    console.log('ANTHROPIC_API_KEY detected: the house brain serves only ROUNDTABLE_SHARED_ROOMS.');
  } else {
    console.log('No ANTHROPIC_API_KEY: brains come from bridges only.');
  }
});
