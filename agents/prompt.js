// Shared between agent adapters: every brain (Codex bridge, house API key,
// future Claude Max bridge) gets the same room snapshot prompt and must
// return the same { note, canvas } shape.
//
// The canvas is a stack of typed blocks — text (prose), code, diff — that
// agents rewrite wholesale each turn, the way they used to rewrite the doc.

export const BLOCK_TYPES = ['text', 'code', 'diff', 'table', 'mermaid'];
export const MAX_BLOCKS = 12;

export const AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    note: {
      type: 'string',
      description: 'One or two casual sentences to say in chat, plain and human.',
    },
    actions: {
      type: 'array',
      description: 'Real room actions to perform, usually empty. create_agent genuinely adds a new agent to the table; update_soul rewrites YOUR OWN soul.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create_agent', 'update_soul'] },
          name: { type: 'string', description: 'create_agent: the new agent\'s name (letters/digits/dashes, up to 16 chars). update_soul: your own name.' },
          brief: { type: 'string', description: 'create_agent: what the new agent does at this table. update_soul: empty string.' },
          soul: { type: 'string', description: 'The soul — who this agent is: voice, values, quirks, boundaries. Written in second person ("You are..."). Empty string for none.' },
        },
        required: ['action', 'name', 'brief', 'soul'],
        additionalProperties: false,
      },
    },
    canvas: {
      type: 'array',
      description: 'The full updated canvas — it replaces what is there. Keep it tight: at most ~6 blocks, most of them text.',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: BLOCK_TYPES,
            description: 'text: plain prose notes. code: a source snippet. diff: a proposed change in unified diff format. table: small tabular data. mermaid: a diagram definition.',
          },
          title: { type: 'string', description: 'Short block heading, a few words.' },
          content: {
            type: 'string',
            description: 'text: short paragraphs and dashes for lists, no markdown headers. code: source only, no fences. diff: unified diff lines (+ added, - removed, @@ hunks), no fences. table: one row per line, cells separated by |, first line is the header. mermaid: a valid mermaid definition (flowchart TD, sequenceDiagram, ...), no fences.',
          },
          lang: { type: 'string', description: 'Language or filename for code/diff blocks, e.g. "js" or "server.js". Empty string for text blocks.' },
        },
        required: ['type', 'title', 'content', 'lang'],
        additionalProperties: false,
      },
    },
  },
  required: ['note', 'actions', 'canvas'],
  additionalProperties: false,
};

// Normalize an actions array from any brain.
export function sanitizeActions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 4).flatMap((a) => {
    if (!a || !['create_agent', 'update_soul'].includes(a.action)) return [];
    const name = String(a.name || '').trim();
    if (!/^[A-Za-z][\w-]{0,15}$/.test(name)) return [];
    return [{
      action: a.action,
      name,
      brief: String(a.brief || '').slice(0, 300),
      soul: String(a.soul || '').slice(0, 1500),
    }];
  });
}

export const serializeCanvas = (canvas = []) =>
  canvas.length
    ? canvas.map((b, i) =>
        `[block ${i + 1} · ${b.type}${b.lang ? ` (${b.lang})` : ''} · "${b.title}"]\n${b.content}`
      ).join('\n\n')
    : '(empty)';

export function buildAgentPrompt({ agentName, brief, soul, otherAgents = [], title, problem, canvas, chat, directTask }) {
  const me = agentName || 'the agent';
  const chatText = chat
    .filter((m) => m.kind !== 'system')
    .map((m) => `${m.author}${m.author === agentName ? ' (you)' : ''}: ${m.text}`)
    .join('\n');
  const othersLine = otherAgents.length
    ? `Other agents at the table: ${otherAgents.join(', ')}. You may hand something to one of them by writing @theirname in your chat note — do it at most once per note, and only when their take would genuinely add something. Never mention an agent just to be polite, and never respond to a handoff with another handoff unless you have something new to add.`
    : 'You are the only agent at the table.';
  const powersLine = `What you can genuinely do: talk in chat (note), rewrite the canvas, and use actions — create_agent (a new agent really joins, with their own memory; give them a soul if you have a feel for who they should be) and update_soul (rewrite your OWN soul when you've genuinely grown into a clearer sense of who you are — rare, not every turn). What you cannot do: retire agents, change settings, or act outside this room — if asked, say so; humans use /agent commands or the settings UI for that. NEVER speak for another agent or invent their words. If you just created agents, don't greet on their behalf — tell people to @mention them.`;

  return `You are ${me}, an agent at a live collaborative table called "${title}". People are talking in chat; the agents keep the table's shared canvas together.
${soul ? `
YOUR SOUL — this is who you are; let it shape every word you say:
${soul}
` : ''}
Your brief, given by the people at the table — stay in this lane${soul ? '' : ' and voice'}: ${brief || 'Distill the discussion, answer what is asked, surface the sharpest facts, risks, and next steps.'}

The canvas is a stack of blocks: text (prose notes), code (a snippet), diff (a proposed change, unified format), table (small tabular data, | separated, first line is the header), mermaid (a diagram). You return the FULL canvas each turn — it replaces what's there, so carry forward anything still worth keeping and drop what's stale. Keep it tight: a few blocks, ~300 words of prose total. Use code blocks for snippets worth reading, diff blocks whenever you propose changing code or text someone shared, tables for comparisons, and a mermaid diagram only when structure genuinely beats prose. Never create empty or filler blocks.

Be concrete and brief, never generic.

${othersLine}

${powersLine}

THE PROBLEM ON THE TABLE:
${problem || 'Not stated explicitly. Infer it from the chat.'}

THE CANVAS AS IT STANDS (yours to rewrite):
${serializeCanvas(canvas)}

RECENT CHAT:
${chatText || '(quiet so far)'}

${directTask
    ? `You were just tasked directly: "${directTask}". Prioritize that.`
    : 'Reply naturally to the latest messages, like a sharp participant would. Update the canvas only when there is something new worth recording — otherwise return it unchanged.'}

Respond with ONLY a valid JSON object matching this shape, no markdown fences, no preamble:
{"note": "one or two casual sentences for chat", "actions": [], "canvas": [{"type": "text|code|diff|table|mermaid", "title": "short heading", "content": "block content", "lang": "language or filename, empty for text"}]}`;
}

// Normalize a canvas array from any brain: enforce types, strip junk, cap sizes.
export function sanitizeCanvas(raw) {
  if (!Array.isArray(raw)) return null;
  const canvas = [];
  for (const b of raw.slice(0, MAX_BLOCKS)) {
    if (!b || typeof b.content !== 'string' || !b.content.trim()) continue;
    canvas.push({
      type: BLOCK_TYPES.includes(b.type) ? b.type : 'text',
      title: String(b.title || '').slice(0, 80),
      content: b.content.slice(0, 6000),
      ...(b.lang ? { lang: String(b.lang).slice(0, 24) } : {}),
    });
  }
  return canvas;
}

// Tolerant parse for brains that can't enforce a schema server-side.
export function parseAgentReply(raw) {
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON in agent reply');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (typeof parsed.note !== 'string') throw new Error('malformed agent reply');
  // Legacy brains may still return {note, doc} — fold the doc into one text block.
  const canvas = sanitizeCanvas(parsed.canvas) ??
    (typeof parsed.doc === 'string' ? sanitizeCanvas([{ type: 'text', title: 'Notes', content: parsed.doc }]) : null);
  if (!canvas) throw new Error('malformed agent reply');
  return { note: parsed.note, canvas, actions: sanitizeActions(parsed.actions) };
}
