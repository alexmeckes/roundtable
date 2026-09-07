# Workspace guide

[Back to Roundtable](../README.md)

Detailed setup, agent controls, shared context, and limits for personal Codex connections.

## Connect your Codex

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

Discussion runs in the read-only filesystem sandbox. Execution runs in its task
workspace with the owner’s configured tools; check commands have local OS permissions.
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

Restart the same private bridge command to reconnect. Use the same table URL,
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
