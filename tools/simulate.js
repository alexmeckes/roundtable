#!/usr/bin/env node
// Simulate people joining a room and talking, to see multiplayer live.
//
//   node tools/simulate.js http://localhost:3131/s/<room>
//
// Spawns three scripted participants over plain websockets — exactly what
// real browsers speak — with staggered joins and human-ish timing. Watch the
// room in your own browser while it runs: faces appear, messages flow, and
// (with Auto on) the agent chimes in on its own.

import WebSocket from 'ws';

const roomUrl = process.argv[2];
if (!roomUrl) {
  console.error('Usage: node tools/simulate.js http://localhost:3131/s/<room>');
  process.exit(1);
}
const parsed = new URL(roomUrl);
const roomId = parsed.pathname.split('/').pop();
const wsUrl = (parsed.protocol === 'https:' ? 'wss://' : 'ws://') + parsed.host;
const ts = () => new Date().toISOString().slice(11, 19);

// [persona index, ms after start, text]
const SCRIPT = [
  [0,     0, 'ok so the plan is to demo roundtable to the team on friday'],
  [1,  3500, 'nice. do we show the codex bridge live or pre-record it?'],
  [2,  7500, 'live demos always break. at minimum pre-record a backup'],
  [0, 11500, "fair. what's the riskiest part of the live path?"],
  [1, 15500, 'the bridge reconnect stuff — if the wifi hiccups mid-demo'],
  [2, 19500, 'we should also decide who drives. one laptop, one narrator'],
  [0, 24000, '@agent capture the demo plan and the risks in the doc'],
];
const JOIN_AT = [0, 1200, 2600];      // staggered arrivals
const LINGER_MS = 40000;               // stay seated to see the agent's replies
const JITTER = () => Math.random() * 800;

const people = [];

function spawnPerson(i) {
  const ws = new WebSocket(wsUrl);
  const p = { ws, name: `#${i}` };
  people.push(p);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: roomId })));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'welcome') {
      p.name = m.you.name;
      console.log(`${ts()} joined as ${p.name}`);
    }
    // Only persona 0 narrates the room, so events print once, not three times.
    if (i === 0 && m.t === 'chat' && m.entry.kind !== 'system') {
      console.log(`${ts()}   ${m.entry.author}: ${m.entry.text}`);
    }
    if (i === 0 && m.t === 'doc' && m.animate) {
      console.log(`${ts()}   [doc updated by agent: ${m.text.length}ch]`);
    }
  });
  ws.on('error', (err) => console.error(`${ts()} ws error (${p.name}): ${err.message}`));
  return p;
}

console.log(`Simulating 3 people in room ${roomId} — watch it live in your browser.`);
JOIN_AT.forEach((delay, i) => setTimeout(() => spawnPerson(i), delay));

for (const [who, at, text] of SCRIPT) {
  setTimeout(() => {
    const p = people[who];
    if (p?.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'chat', text }));
  }, 3000 + at + JITTER());
}

const end = 3000 + SCRIPT[SCRIPT.length - 1][1] + LINGER_MS;
setTimeout(() => {
  console.log(`${ts()} simulation over — everyone leaves.`);
  people.forEach((p, i) => setTimeout(() => p.ws.close(), i * 700));
  setTimeout(() => process.exit(0), 3000);
}, end);
