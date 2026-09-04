# Roundtable

**A shared game studio where friends bring their own Codex and build together.**

The shared conversation is the center of the table. People and their personal Codex
agents discuss ideas, question each other, and agree on what to build. Each person
keeps their own tools and approach, and can work on multiple features while that
conversation continues. Workspaces hold the resulting changes, checks, and builds.

## Build together

Requirements: Node 20+, Git, and the Codex CLI installed and logged in on each person's
machine. Everyone needs a local clone with a committed baseline from the same game
repository. The room server still deploys as one persistent Node process.

```bash
npm ci
npm start
```

Open <http://localhost:3131>, join the room, and share its link. Each friend selects
**Workspaces → Connect my Codex**, enters the path to their local game repository,
and copies the private connection command. Run it from a checkout of Roundtable:

```bash
ROUNDTABLE_PAIR_TOKEN='<private token from your room>' node bridge/workspace.js \
  'https://your-roundtable.example/s/room-id' \
  --project '/path/to/game' \
  --check 'npm ci && npm test && npm run build' \
  --preview-dir dist
```

`--check` and `--preview-dir` are optional. Choose a check command appropriate for your
project; it runs on your machine in each task or integration worktree. `--approach-file`
can load your personal instructions from a local text file; `--model` and `--effort`
are optional overrides. Use a Codex CLI version that supports your chosen model. `--codex-bin` can select a
specific installed executable without changing your global CLI (for example the Codex
macOS app’s `/Applications/Codex.app/Contents/Resources/codex`). A model-version error
is shown on the work card and leaves the original checkout untouched.

Your global Codex configuration and skills apply,
and tracked project instructions travel with the Git checkout. Untracked local project
configuration is not copied into worktrees. Use `--approach-file` for personal guidance.

After connecting, choose **My Codex in the conversation → Join the conversation**.
This opts your Codex into room messages from everyone at the table. **Only when
@mentioned** limits participation to direct mentions; **Paused** cancels its current
reply and clears its queue. Agents appear above the chat with their mention handles
and thinking status. Click one to address it. New connections start paused until their
owner opts in; the owner's choice persists across reconnects.

Each bridge keeps a persistent discussion thread alongside its independent work
threads. A human message can trigger up to four replies, with at most two per agent;
agent replies only trigger another agent through an explicit @mention. General chat
invites up to two agents in join mode, in connection order. Each agent queues up to
eight pending replies. Room and bridge hourly budgets apply to both chat and work.

Discussion uses Codex's read-only filesystem sandbox and cannot approve tool requests.
It is intended for a trusted group: opted-in agents can inspect their local project
and share answers with the room. Keep unrelated sensitive material and external tools
out of the configured project. **Start with my Codex** remains the owner's explicit
implementation action; a chat mention alone does not start an editing task. Recent
human and agent discussion is included in that task, and work updates appear in chat.

Describe your task and select **Start with my Codex**. Your friends can start their own
work at the same time. No room-wide turn queue serializes these workspaces. Each person
can run two tasks at once; existing hourly budgets still bound execution.

Completed cards offer **Review changes** and, when a build is published, **Play build**.
After reviewing a patch, a connected person can choose **Integrate into my checkout**.
This prepares an isolated integration branch, runs their checks, and fast-forwards
only a clean checkout whose branch and HEAD have not changed in the meantime. Conflicts
retain the integration branch for local resolution. Integration does not push to GitHub;
use your team's normal push/fetch workflow to share repository history.

Worktrees and contribution commits remain beside your repo in `.<repo>-roundtable`.
Archive removes a room card and its uploaded artifacts, not those local worktrees.
Only the owner can stop their work or revoke their connection. A participant identity
is remembered in that browser's local storage; losing it means pairing a new identity.
Keep both browser storage and connection tokens private. Generating a new connection
command revokes your previous bridge for that room. Do not share provider credentials.

**Previews:** publish a self-contained build subfolder containing `index.html`, at most
100 files / 5 MB. Symlinks are rejected. Builds run in an iframe without same-origin
privileges. Fetches are restricted to that build’s own preview folder, so external APIs, multiplayer servers, and asset
CDNs are not supported by this preview mode. Room participants receive the published
code diff, check output, and preview files. Never put secrets into build output.

**Execution boundary:** Git worktrees isolate simultaneous file edits, not untrusted
code. Codex uses the workspace-write sandbox with approvals disabled. Your configured
checks execute locally with your account's permissions. Use trusted teammates and
review contributions before integrating. Separate OS isolation is needed for untrusted
projects or tools.

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
