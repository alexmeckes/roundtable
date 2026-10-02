# Workspace guide

[Back to Roundtable](../README.md)

Detailed setup, agent controls, shared context, and limits for personal Codex connections.

## Hosted room connection

Each participant needs Node 20+, the Codex CLI, and a running local connector on
their own computer. From a Roundtable checkout:

```bash
npm ci
npm run connect
```

Open the [hosted room](https://roundtable-plugin-trial.ameckes.chatgpt.site/s/sites-trial)
with your own approved Site access and select **Connect my AI**. Choose
**Continue with ChatGPT** for ChatGPT plan usage or **Use Codex login** for the
ChatGPT account already signed in to Codex. API-key logins are not accepted by
this connection. The local companion shows the room, participant, and approved
backend before you click Connect. Sign-in opens your system browser only when
needed and after this confirmation.

Wait for **Your AI is connected**, then return to the room. The status appears
after the local runtime initializes, the backend accepts the pairing, and saved
room conversations are loaded. A saved conversation count means those local
session references are available; the next reply resumes its existing thread.
Connecting does not execute a task. It enables replies to explicit mentions or
the room's **My AI** composer. Other people can discuss with your AI, while only
you can start its assigned work.

The companion listens only at `http://127.0.0.1:4146`. This trial trusts its
configured hosted backend. The short-lived pairing grant travels in a URL
fragment, is cleared from browser history, and is consumed by the backend.
No monitoring prompt or private command needs copying. Keep the connector
running and the authenticated room open for replies. A five-minute access lease
is renewed only by authenticated Site requests; expired access stops the runtime. Use **Disconnect my AI** in the room or local
companion to stop the connection; reconnect from the room with a fresh grant.

Discussion uses the latest 40 human and AI room messages, accepted shared
context, and your agent's saved local conversation. A read-only history tool can
retrieve older discussion within the 400 retained messages. It does not import your
private ChatGPT history. Discussion threads have local commands and inherited
MCP apps disabled; project inspection and execution require an owner-started
task. The default task folder is `~/Documents/Roundtable/<room-id>`, created
when you connect. Change it under **Local project access** before connecting
if a task needs another folder. Folder tasks publish outputs from their separate
task directory for human review.

Use the same computer, local account profile, and project folder when returning.
Room-side disconnect retains saved conversation references and task files.
Request changes records feedback and resumes the reviewed task's original thread
and files. If its checkpoint is unavailable, reconnect the original setup or
create a new task; the system does not silently discard prior work.
Codex-login identity is scoped by a local hash of the authenticated email. Old
unscoped Codex-login sessions are not automatically migrated across accounts.
Restarting the companion requires a fresh connection from the room; that
connection restores the references instead of importing unrelated private chats.

## Advanced local server and CLI setup

Use Node 20+ and a Codex CLI installed on each participant’s machine. The default
uses your existing local Codex ChatGPT login; the optional ChatGPT plan preview
has its own local sign-in. API-key authentication is not accepted. Git is needed
only for repository workspaces.

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

### ChatGPT plan preview

In **Connect my Codex**, select **ChatGPT plan (preview)** to add
`--auth chatgpt-plan` to the connection command. This uses eligible ChatGPT Plus or
Pro plan usage through [Continue with ChatGPT](https://developers.openai.com/siwc).
When needed, running the command opens sign-in in your system browser and returns
to the local bridge. Joining a room does not require this sign-in. Node and the
local Codex runtime are still required; project files, tools, and execution stay
on your machine.

Manage the preview's accounts from your Roundtable checkout:

```bash
node bridge/chatgpt-auth-cli.js login
node bridge/chatgpt-auth-cli.js status
node bridge/chatgpt-auth-cli.js accounts
node bridge/chatgpt-auth-cli.js select <id>
node bridge/chatgpt-auth-cli.js logout [id]
```

The `accounts` command supplies the local account IDs used by `select` and
`logout`. Omit the ID from `logout` to use the current selection. You can pin a
connection to a saved account with `--chatgpt-account <id>` alongside
`--auth chatgpt-plan`. Use the original account and local profile when resuming
existing work.

Tokens are stored in protected local files under `~/.config/roundtable/chatgpt`.
They are passed only to the local runtime and OpenAI, never to room participants,
the room browser, or the Roundtable server. The room receives only the safe
`codex` or `chatgpt-plan` mode label. **Using ChatGPT plan** and **Manage usage**
appear beside your connected workspace and conversation controls; usage is
managed at [ChatGPT settings](https://chatgpt.com/settings/usage).

Run `npm run check:chatgpt-runtime` to check your installed Codex's project APIs
and token exclusion from agent shell environments. This uses a dummy credential
and does not sign in, create an agent thread, or spend model usage.

Token renewal waits until current turns finish before restarting the local runtime
and resuming saved local threads. Login or renewal errors do not replace your
existing Codex login; reconnect with **Existing Codex login** to use that path.
If a token expires during a long execution, the run can fail with its local files
retained. After renewal, use **Resume my agent** to continue that task.
Stop the account's bridges before using the local `logout` command.
The preview does not support the `tool_search` tool.

OpenAI currently documents this plan-usage flow for open-source and locally hosted
apps. Paid or remotely hosted apps require completing its interest form. Roundtable
keeps this runtime local even when the shared room is hosted; confirm eligibility
with OpenAI before offering paid or remotely hosted execution. See the
[official eligibility guidance](https://developers.openai.com/siwc/token-sharing-open-source).

## Shared context

Open **Context** beside the conversation to maintain a shared brief, sources,
decisions, learnings, and skills. Paste relevant source text and optional reference
links. **Save to context** on a chat message preserves the original message and its
author; completed deliverables also have a save-to-context action.

People with permission to speak can create or edit accepted context and review
agent proposals. Proposals remain separate until a person accepts them. Retiring an
item removes it from the agents' accepted context without erasing its history.
Entries retain authors, revisions, timestamps, and cited evidence versions.
Concurrent edits use version checks: an outdated save is rejected and its draft
stays in the editor for recovery.

Personal Codex agents receive a compact accepted-context index on every discussion
or execution turn. They can retrieve current details with `roundtable_context_read`
and suggest sources, decisions, learnings, or skills through
`roundtable_context_propose`. Tool access belongs to the active run and connected
table; stopping or disconnecting a run revokes it. Agents cannot accept their own
proposals. The legacy canvas agents receive the accepted overview only.

Shared skills are instructions that each person explicitly opts into with **Use for
my agents**. Adoption applies to that version; editing the skill requires a fresh
opt-in. Sharing or adopting a skill does not install plugins, execute code, or change
local tool permissions. Existing local Codex skills and configuration still apply.

Context persists with room state across server and bridge restarts. This is shared
project memory, not private agent thread history. Sources are pasted text, reference
links, or links to existing deliverables; this version does not upload arbitrary
files, crawl websites, or automatically synchronize external documents. Links to
work outputs depend on that work card remaining available.

Limits: 100 context items per table, 6,000 characters per item, 30 saved historical
versions per item, up to eight full entries per agent read, and four proposals / 32
context calls per agent turn. Retired items still count toward the table limit.

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
is not implemented. Private specialist threads are now restored from the owner’s local session store.

## Results and trust

Cards show summaries, files, checks, optional previews, and code patches when relevant.
Downloads are served as attachments. Static previews require an `index.html` and are
sandboxed, restricted to their own assets, and limited to 100 files / 5 MB. A preview
can show a report, website, visualization, or game; it cannot access the room’s storage.

Room links grant access to the shared conversation and outputs. Keep private inputs
out of deliverables. Pairing commands and browser identity storage are private
capabilities. Reconnecting with a new pairing command revokes the old bridge. The room
host cannot assign work using another person’s Codex.

Discussion uses the shared transcript and accepted context, with local commands
and inherited MCP apps disabled. Execution runs in its task workspace with the
owner’s configured tools; check commands have local OS permissions.
Use trusted participants and tools. Filesystem separation is not a substitute for
OS isolation of untrusted code. Outputs stay on the owner’s machine after archiving a
room card. Source uploads, hosted compute, large files, and live coediting are not yet
provided.


## Shared tasks

Open **Tasks**, or choose **Create task** under a conversation message. Give the
task a title, instructions, owner, and one of that owner's agents. You can also
link accepted context and up to ten prerequisite tasks. A task created from a
message keeps its original author and text.

Everyone who can speak can plan, assign, discuss, and review tasks. Assignment
never starts another person's Codex: the owner chooses **Start my agent**. Work
runs in the owner's existing isolated workspace, using the same concurrency limits.

Tasks move through **Planned → Working → Needs review → Done**. Successful agent
runs request human review; a person marks the task done. Failures, cancellation,
disconnects, and server restarts leave active tasks **Blocked**, ready to retry.
Reopen reviewed work as Planned to run another iteration. All runs stay linked.

A prerequisite must be **Done** before dependent work can start. Reviewed text
deliverables are supplied as reference inputs to the next run (up to 20 files,
32 KB per file, 96 KB total). Larger files and binary formats receive download links. Dependencies
cannot form cycles. Reopen dependent work before reopening a completed prerequisite
that already has working or reviewed dependents. Two people editing the same task
cannot silently overwrite each other: the stale editor keeps their draft and must
reopen the current task.

Open a task to download deliverables, review a patch, or discuss it. Task comments
also appear in the main conversation, and @mentioned agent replies stay linked to
the task. Agents receive the open task list alongside shared context; their work
results update task status automatically. They cannot independently assign or start
tasks on another person's behalf.

The prototype retains up to 100 tasks and 48 execution cards per table. Runs linked
to tasks cannot be archived, so their deliverables remain available. Unlinked
execution cards can still be archived. Task history and deliverables persist on
the server; private Codex conversation references and execution checkpoints are saved locally.

## Leave and return

For the hosted connector, restart `npm run connect` and create a fresh connection
from the room. For the advanced reusable CLI pairing, restart the same private
bridge command. Use the same table URL,
local project, Codex project, and Codex profile. The bridge restores its local
session references before accepting new work. Each agent’s next conversation
turn reopens its existing Codex thread, with read-only conversation permissions
reapplied. Reconnecting does not replay interrupted messages or start tasks.

The roster keeps disconnected agents visible as **Offline**. Connected owners
show **Reconnecting**, **Connected**, or **Working**, with their saved conversation
count. A lost socket is detected by the existing server heartbeat.

An interrupted task stays **Blocked**. Reconnect its original owner, machine,
and project, then select **Resume my agent**. Resume keeps the original output
folder or Git worktree, including partial files and its Codex thread when one was
created. It runs the current task instructions and configured checks, publishes
a new reviewable result, and retains earlier attempts. Update the instructions
before resuming if the task should proceed differently.

**Start fresh** creates a separate workspace. Use it when you intentionally want
a new attempt, or when the original local checkpoint is unavailable. Runs made
before this feature do not have checkpoints. Git integration attempts are not
resumed automatically; use the existing review/integration flow.

On returning to a table or a background tab, **Since your last visit** summarizes
recent task changes, context updates (including decisions and proposals), and
messages. Open an item to review it and use **Mark caught up** when finished.
Read positions are stored per member on the server and advance only for delivered
updates. The summary uses retained history and current item states, not a complete
audit of every intermediate edit.

Session references are stored under `$CODEX_HOME/roundtable/sessions` (normally
`~/.codex/roundtable/sessions`) in private files. Scope includes the table origin,
room, owner, canonical project path, workspace mode, and Codex project. Connection
status shares only public agent/run IDs; private thread IDs and checkpoint paths
remain in the local registry. A local lock prevents two
bridge processes from writing the same session store. Missing or corrupt state
raises an error rather than silently replacing a saved conversation.

Resume preserves files and conversation; it cannot guarantee exactly-once external
actions. A missing Codex thread requires recovery in the original profile or a new
specialist. Changing machines does not copy private threads or checkpoints.

The integration uses Codex’s documented [thread resume lifecycle](https://learn.chatgpt.com/docs/app-server).
See the [single-owner local evidence](evidence/session-continuity/README.md).
