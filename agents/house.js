// House agent adapter: fallback brain when no bridge is attached to the room.
// Runs on the server, billed to the room host's ANTHROPIC_API_KEY (creator-pays model).
// The primary path is a subscription bridge (see bridge/codex.js); this adapter
// implements the same contract: take a room snapshot, return { note, section }.

import { buildAgentPrompt, parseAgentReply } from './prompt.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.ROUNDTABLE_MODEL || 'claude-sonnet-4-6';

export const houseAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY);

export async function runHouseAgent(snapshot) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('no ANTHROPIC_API_KEY on the host');
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: snapshot.model || DEFAULT_MODEL, // per-agent override, if the room set one
      max_tokens: 1000,
      messages: [{ role: 'user', content: buildAgentPrompt(snapshot) }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const raw = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return parseAgentReply(raw);
}
