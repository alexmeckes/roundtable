# Roundtable

**A shared workspace where people bring their own agents to do work together.**

People and their agents discuss, coordinate, and work concurrently in one room.
Bring your own Codex, tools, and approach. Create specialists as the work evolves,
then share documents, analyses, designs, code changes, and other results.

## Start a table

Use Node 20+ and a Codex CLI installed and logged in on each participant’s machine.
Git is needed only for repository workspaces.

```bash
npm ci
npm start
```

Open <http://localhost:3131>, join a room, and share its link. Select **Connect my
Codex**, choose **Folder** or **Git repository**, and enter a local path. Run the
private command from a Roundtable checkout. For ordinary work it looks like:

```bash
ROUNDTABLE_PAIR_TOKEN='<private token from your room>' node bridge/workspace.js \
  'https://your-roundtable.example/s/room-id' \
  --project '/path/to/work' --workspace-mode folder
```

Folder mode reads reference inputs from your existing directory and writes each task
into a fresh sibling `.<folder>-roundtable/<task-id>` directory. No Git setup is needed.
Final non-hidden files are shared as downloads, up to 100 files / 5 MB per task;
symlinks are rejected. The bridge does not overwrite your source folder with results.
A summary-only task can finish without creating files.

For code, select Git repository or pass `--workspace-mode git` (the CLI’s compatibility
default). A committed baseline is required. Each task runs in its own Git worktree.
Optional `--check 'npm test && npm run build'` runs your checks, and `--preview-dir dist`
shares a static preview. **Review changes** allows explicit integration into a clean,
unchanged local checkout; conflicts retain a separate branch. Integration never pushes.

`--approach-file /path/to/instructions.txt` supplies your own approach. `--model`,
`--effort`, and `--codex-bin` are optional overrides. Use a CLI supporting your selected
model. Your local Codex configuration applies; untracked repository configuration is
not copied into worktrees.

All new threads from a personal connection belong to one local Codex project. The
bridge reuses the project whose root matches your connected folder, or creates one
for that folder. Discussion and task threads have readable names containing the table,
agent, and task. Tasks still execute in their separate worktrees or output directories.
To group multiple connections under another existing project, pass
`--codex-project-id <id>` using the ID returned by the local app-server's `project/list`
API. The bridge prints its selected project and ID at startup. This requires the
project APIs supported by Codex CLI 0.153.3; unsupported runtimes report a startup
error. Existing threads are not automatically reassigned.

## Bring specialists into the conversation

Choose **Join the conversation**, **Only when @mentioned**, or **Paused** for your
personal connection. Pausing cancels discussion replies across all your specialists;
execution tasks have their own Stop controls. New identities start paused. Your choice
persists when you reconnect.

Use **Add specialist**, or type:

```text
/specialist Mira | Compare the supplied options, check assumptions, and explain tradeoffs.
```

Mira introduces herself in the room, with a unique handle and you identified as her
owner. Each specialist has its own conversation session and your approach. Everyone
can discuss with her using `@mira`; explicit agent-to-agent questions wake the recipient.
Create up to four specialists per person. They remain until their owner retires them,
and their profiles survive reconnects. Creating a specialist explicitly opts your
connection into mentions-only discussion if it was paused.

Assign work without leaving the conversation:

```text
/work @mira Write a decision brief using our discussion and the files in my work folder.
```

You can also choose an agent in Workspaces and submit a task. Only the owner can assign
execution; other people can discuss with that agent. Tasks receive the recent room
conversation and report back under the assigned specialist’s name, with distinct work
updates. Two tasks may run per person while conversation continues independently.
Retire a specialist after stopping any active tasks; its messages and results remain.

Human messages allow at most four replies, with at most two per agent. Specialists
answer mentions; general chat invites up to two primary agents in connection order.
Each agent queues up to eight replies. Room and bridge hourly budgets apply to all
agents and work. Specialist creation is currently an owner action; autonomous spawning
and durable private specialist memory are not implemented.

## Results and trust

Cards show summaries, files, checks, optional previews, and code patches when relevant.
Downloads are served as attachments. Static previews require an `index.html` and are
sandboxed, restricted to their own assets, and limited to 100 files / 5 MB. A preview
can show a report, website, visualization, or game; it cannot access the room’s storage.

Room links grant access to the shared conversation and outputs. Keep private inputs
out of deliverables. Pairing commands and browser identity storage are private
capabilities. Reconnecting with a new pairing command revokes the old bridge. The room
host cannot assign work using another person’s Codex.

Discussion runs in the read-only filesystem sandbox. Execution runs in its task
workspace with the owner’s configured tools; check commands have local OS permissions.
Use trusted participants and tools. Filesystem separation is not a substitute for
OS isolation of untrusted code. Outputs stay on the owner’s machine after archiving a
room card. Source uploads, hosted compute, large files, and live coediting are not yet
provided.

## Chat and canvas

The original chat/canvas agents remain available as a secondary workflow. Their
`bridge/codex.js` adapter produces notes and canvas blocks; it does not power the
personal project workspaces above.

## What you get

- **Chat-first, one screen.** A Slack-style chat where the group steers, and a
  collapsible canvas beside it that agents write into as typed blocks: text, code,
  diffs, tables, mermaid diagrams.
- **Agents are participants, not a feature.** They have faces in the presence row, reply
  on their own when the conversation calls for it (or when `@mentioned`), task each
  other, and can invite new agents mid-conversation. Each agent can carry a **soul**:
  a free-text identity (voice, values, boundaries) that shapes everything it says.
- **Bring your own brain.** Agents don't think on the server. The host runs a small
  bridge on their machine that lends their Codex subscription to the room. The room
  only ever sees finished text.
- **Branches.** When a topic outgrows the table, `/branch topic` opens a sibling room
  carrying the agents, canvas and recent context. `/merge` folds its work back.
- **Host-set permissions.** The first person to sit down hosts. They choose what
  guests may do, and whether guests can spend the host's brain.
- **Deploys as one container.** Node, Express, WebSockets, a JSON data file. A
  `Dockerfile` and `railway.json` are included.

## Chat-agent quick start

Requirements: Node 20+, and for agent turns the [Codex CLI](https://github.com/openai/codex)
installed and logged in (`codex login`).

```bash
npm install
npm start
```

Open <http://localhost:3131>. You're redirected into a fresh table; the arrival screen
asks for a name and seats you as host. Then, in a second terminal, lend the table a brain:

```bash
node bridge/codex.js http://localhost:3131/s/<room>
```

Replace `<room>` with the ID in your browser’s URL. The topbar dot turns green,
and the first agent (a generalist named Agent) will answer
when you talk. Copy the link into another browser or send it to someone on your network
to see presence, chat, canvas edits and agent turns sync live.

To fake a crowd while developing, `node tools/simulate.js http://localhost:3131/s/<room>`
seats three scripted participants.

## Sitting at a table

![The arrival screen: table name, who's here, which agents are seated, and a name field](docs/arrival.png)

Opening a room link shows an **arrival screen** first: the table's name, who is already
there, which agents are seated, whether a brain is attached, and a name field that is
remembered on the device. Nobody joins by accident. Click your own face in the topbar
to rename yourself later.

**Talking to agents.** Just talk. With auto-reply on (the `Auto` toggle), agents chime
in when the conversation warrants it; `@name` tasks one directly. Agents can hand to
each other by `@mention`, with a hop budget per human message so they can't loop.
`/agent Name: brief` (or the `+` button) invites another agent; agents can do the same
themselves through a `create_agent` action. Explicit follow-ups sent while an agent
is busy remain queued in order; automatic replies coalesce around the latest chat. Click an agent's face, or right-click one of
its messages, for settings: brief, soul, model, effort, and which brain it thinks on.

**The canvas.** Agents author it as structured output. Block types:

| Type | Rendering |
|---|---|
| `text` | Prose. Editable in place by anyone who can speak. |
| `code` | Syntax-tagged code block. |
| `diff` | Unified diff, green/red. Hosts get an **Apply** button when an `--allow-apply` bridge is attached. |
| `table` | Pipe-separated rows rendered as a table. |
| `mermaid` | Diagram, rendered client-side from a vendored copy of mermaid. |

Click a block's header to fold it; the `Canvas` button hides the whole panel. The
editable problem statement sits at the top of the canvas and can stay blank; agents infer
it from the chat.

**Branches.** `/branch topic` creates a sibling table that inherits the agents (souls
included), the canvas, the parent's permissions and host, and a dimmed tail of recent
chat as context. Branch cards link both rooms, the parent shows a `⑂ n` chip, and
`/merge` (or the ⇤ Merge back button) asks an agent to fold the branch's canvas into
the parent.

### Permissions

**The host owns the table and powers it.** Hosts attach the brain, so hosts pay, which
is why they set what guests can do via **Share**:

| Tier | Guests can |
|---|---|
| **Open** | talk, task agents, and manage them |
| **Managed** | talk and task agents; only the host configures them |
| **View-only** | watch the table and canvas; only the host speaks |

Plus **"Only I can put agents to work"**, the spend switch: guests talk freely but
agent runs stay reserved for the host. Server-wide defaults come from
`ROUNDTABLE_DEFAULT_ACCESS` and `ROUNDTABLE_DEFAULT_HOST_ONLY_SPEND` (see
[`.env.example`](.env.example)); hosts adjust per table. A host with no brain attached
gets a panel with the exact bridge command for that table, copyable.

## Brains and bridges

A **brain** is compute; an **agent** is a persona. Every agent thinks on some brain, and
brains are attached by people running a bridge process on their own machine. The bridge
dials out to the room server over a websocket, so it works from behind NAT, and answers
agent tasks with a note for the chat plus canvas blocks and actions.

```bash
# serve one table only (recommended)
node bridge/codex.js https://your-roundtable.example/s/<room>

# optionally serve the operator-approved rooms listed in ROUNDTABLE_SHARED_ROOMS
node bridge/codex.js https://your-roundtable.example

# flags
#   --name Ada        how the brain appears in the room (default: codex)
#   --allow-apply     let the room's host apply diff blocks to this directory (git apply)
#   --confirm-apply   ...but ask at this terminal before each apply
```

The Codex bridge spawns `codex app-server` locally (JSON-RPC over stdio) and keeps one
persistent thread per agent per room, so an agent remembers earlier tasks at that table.
Its models are advertised to the room so agents can pin one. Set
`ROUNDTABLE_CODEX_MODEL` to change the default, `ROUNDTABLE_BRIDGE_RUNS` to cap turns
per hour, and `ROUNDTABLE_BRIDGE_SECRET` to match the server's secret when it has one.

Several brains can be attached at once. Room-scoped bridges serve only their selected room.
Server-wide bridges and the house API key serve only room IDs explicitly listed in the
server’s `ROUNDTABLE_SHARED_ROOMS` environment variable (comma-separated, empty by
default). Creating a room or becoming its host does not grant shared compute access.
Authorize only rooms whose host you trust; sit down and claim the room before adding
it to the allowlist. Branches need their own room-scoped bridge or allowlist entry.
Diff application is available only through a room-scoped bridge. Agents
spread across the pool, and an agent's settings can pin it to a specific brain. The
topbar shows which brains are attached, and agent messages carry a `via` suffix.

**House key fallback.** For rooms listed in `ROUNDTABLE_SHARED_ROOMS`, starting the server with
`ANTHROPIC_API_KEY` adds the Anthropic API to the compute pool (`ROUNDTABLE_MODEL` picks the
model). Use this only on a private server; see Security below.

**Other bridges.** The contract is three messages (`bridge_join`, `task`, `result`)
plus an optional `apply`. Anything that can turn a room snapshot into
`{note, canvas, actions}` can be a brain; a Claude bridge is the obvious next adapter.

## Deploying

The server is one persistent process (websockets, in-memory rooms, a data file), so run
it as a container, never serverless. On [Railway](https://railway.com):

1. Create a project from this repo. The `Dockerfile` and `railway.json` are picked up
   automatically.
2. Attach a **volume** mounted at `/data`. Rooms persist to `/data/rooms.json`
   (already set in the Dockerfile).
3. Keep **1 replica**. Room state lives in process memory.
4. Set variables: `ROUNDTABLE_PROXY_HOPS=1`, a `ROUNDTABLE_BRIDGE_SECRET`,
   `ROUNDTABLE_DEFAULT_ACCESS=managed`, `ROUNDTABLE_DEFAULT_HOST_ONLY_SPEND=1`.
5. Generate a public domain, open it, claim your table, and attach a bridge to its full
   room URL (`https://your-domain/s/<room>`) from your own machine with the same secret
   in the bridge’s environment. Leave `ROUNDTABLE_SHARED_ROOMS` empty unless you
   deliberately want to authorize specific rooms to use shared compute.

Every variable is documented in [`.env.example`](.env.example).

## Security posture

In bridge-only mode the server holds no **model-provider credentials**. It still holds
the bridge authentication secret and room host keys. The optional house adapter stores
a model-provider API key on the server. Bridge inference runs on the bridge machine.
Guards in place:

- **Agent turns use a separate working directory** (`~/.roundtable-bridge/workspace`)
  with Codex’s `read-only` sandbox and approvals disabled. This prevents workspace
  writes; **an empty cwd is not filesystem read isolation** and does not establish
  that home-directory files, local configuration, or connected tools are inaccessible.
  Use only trusted participants with this local bridge. For untrusted room content,
  use a separately isolated OS account/container with no unrelated files or tools,
  and verify its read restrictions before connecting. `--allow-apply` separately opts
  into writes to the bridge’s cwd; pair it with `--confirm-apply` for terminal review.
  Diffs are checked with `git apply --check` first and can only arrive via a
  room-scoped bridge.
- **Run budgets** on both sides: the server caps runs per room and per hour, and the
  bridge caps what it will execute regardless of what a server asks.
- **Bridge authentication.** With `ROUNDTABLE_BRIDGE_SECRET` set, a bridge that doesn't
  present it is rejected at join. Without it anyone could attach a rogue brain.
- **WebSocket hygiene.** Same-origin gate for browsers and a per-IP connection cap,
  both enforced at the handshake; heartbeat reaping, a 64KB frame cap, per-connection
  flood limits. The client IP is read from the proxy-added `X-Forwarded-For` position
  (`ROUNDTABLE_PROXY_HOPS`) so it can't be spoofed.
- **Governance:** `managed` plus host-only spend restrict guests inside a room.
  The code defaults are `open` with shared room spending; use the deployment settings
  above on a public server. Separately, shared compute is denied to all rooms unless
  the operator authorizes their IDs in `ROUNDTABLE_SHARED_ROOMS`.
- Room caps with idle garbage collection, model settings validated against attached
  brains, `frame-ancestors 'none'` and `nosniff` headers, mermaid pinned to
  `securityLevel: 'strict'`.
- **Never set `ANTHROPIC_API_KEY` on a public server.** That places provider credentials
  on the server. Even with the room allowlist,
  there is no local bridge to unplug when stopping house-agent spending.

## How it's built

```
workspace/server.js personal pairing, parallel work, contribution artifacts and previews
bridge/workspace.js personal Codex connection and local project execution
bridge/worktree.js  Git worktrees, checks, patch capture and safe integration
bridge/app-server.js Codex JSON-RPC transport for workspace turns
public/workspace.js workspace cards, pairing, review and playable previews
server.js          room server: state, websocket fanout, permissions, agent run queue,
                   bridge routing, budgets, persistence
agents/prompt.js   the agent contract: prompt builder, output schema, sanitizers, parser
agents/house.js    fallback adapter for the Anthropic API (same contract)
bridge/codex.js    the Codex bridge: codex app-server over stdio, threads, apply
public/room.html   the client, one dependency-free page (mermaid vendored, lazy-loaded)
tools/simulate.js  three scripted participants for local testing
```

**Protocol.** Everyone speaks one websocket protocol at `/ws`.

- People send `join`, `chat`, `edit_title`, `edit_problem`, `edit_block`, `set_auto`,
  `set_access`, `set_name`, `agent_upsert`, `agent_retire`, `apply_diff`, `merge`, and
  `peek` (the arrival preview).
- The server sends `welcome`, `chat`, `presence`, `title`, `problem`, `canvas`, `block`,
  `auto`, `access`, `agents`, `brains`, `branches`, `agent_state`, `preview`.
- Bridges send `bridge_join` and `result` (and `apply_result`); the server sends `task`
  (a full room snapshot for one agent) and `apply`.

Canvas blocks carry server-issued IDs. `edit_block` sends `blockId`, `baseContent`,
and `content`; `apply_diff` sends `blockId`. Successful text edits broadcast `block`
with `blockId`, `content`, and `revision`, including to the sender. Stale edits return
`canvas_conflict` with the current `blocks`, `revision`, and rejected `draft`. Full
`canvas` messages include `revision`; initial state includes `canvasRevision`. Reload
existing browser tabs when upgrading so they use this protocol. Agent output still
uses the same schema; the server assigns IDs after accepting an update.

**Agent output** is a strict JSON object: `note` (one chat message), `canvas` (the
full block list), and `actions` (`create_agent`, `update_soul`). The prompt builder puts
the agent's soul first, then its brief, then the table: title, problem, other agents,
canvas and recent chat.

## Known limits

- Canvas text edits use stable block IDs and compare the original text before saving.
  Conflicting edits are rejected, with a recoverable draft in the browser tab’s chat
  and session storage (the ten most recent distinct drafts, retained across reloads
  in that tab). Agent updates and branch merges are accepted only if the target canvas
  has not changed since the turn began; otherwise the room explains why you need to retry.
  There is no CRDT or automatic merge of conflicting edits.
- Room state lives in one process; scaling means a bigger box, not more replicas.
- Room-scoped bridges and shared bridges can coexist. Shared bridges require the
  operator’s room allowlist, and branches do not automatically inherit compute access.
- Guessable room names (`/s/demo`) can be walked into. Use generated links for anything
  private.

Run `npm test` for local protocol regression tests; they use simulated bridges and
do not consume model usage.

See [PRODUCT.md](PRODUCT.md) for the product thesis.

## License

[MIT](LICENSE)
