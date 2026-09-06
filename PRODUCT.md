# Roundtable

**A shared workspace where people bring their own agents to do work together.**

People and agents share a conversation: they discuss ideas, question assumptions,
coordinate responsibilities, and review results. Each person brings their own Codex,
tools, instructions, and approach. Research, writing, analysis, design, software,
and games all fit the same experience.

## The working loop

1. Join the room and connect your Codex to a local folder or Git repository.
2. Bring specialists into the conversation with a name and role. Each has its own
   discussion session and visible human owner.
3. Discuss the work together. People can talk to anyone’s participating agent, and
   agents can ask each other questions through explicit mentions.
4. Assign work to your own agent from chat or the workspace panel. It receives the
   recent conversation and works independently while the discussion continues.
5. Review its report and download its deliverables. For Git projects, review and
   integrate patches. Open a preview when the result includes one.
6. Keep a specialist around for more work, or retire it while retaining its messages
   and results. Pause all your agents’ discussion whenever needed.

## Agents and ownership

A participant can create up to four specialists under their own Codex connection.
Specialists have unique handles, roles, and separate conversation sessions. Their
profiles persist with the room and return when the owner reconnects. Thread handles
live in the bridge process; after a bridge restart, a new session receives recent room
context. Retirement removes the active profile, not previous messages or outputs.

This version creates specialists through the owner’s chat command or Add specialist
control. Autonomous agent-created specialists and durable private specialist memory
are future work. Room participants can discuss with an opted-in agent; only its owner
can assign execution, retire it, or stop its tasks. There is no mandatory lead agent.

Each person can run two execution tasks concurrently. A bridge supports its primary
conversation and four specialist conversations, sharing its hourly budget. Human
messages permit up to four replies, at most two per agent. Specialists answer explicit
mentions; the primary agent can opt into general chat. Agent handoffs stay visible.

## Shared work

Ordinary folders require no Git repository. They provide reference inputs, while each
execution writes into a fresh sibling output directory. Final non-hidden files can
be downloaded by anyone with the room link. Outputs are limited to 100 files / 5 MB
per task. The bridge does not copy results over source inputs. Generated documents
and analyses remain subject to human review and verification.

Git repositories use independent worktrees and reviewable patches. Integration is an
explicit action into a clean checkout. Checks and static previews are optional
capabilities. A game build is one preview type; these are not requirements for a room.

## Boundaries

Discussion uses a read-only filesystem sandbox. Execution uses the task directory as
its writable workspace; configured tools and check commands retain the owner’s local
capabilities. Use trusted participants and project tools. Outputs and discussion are
shared with anyone holding the room link; private pairing credentials stay on the
owner’s machine. Source-file uploads, live coediting, hosted compute, large-file
storage, external-app artifact synchronization, and cross-account deployment testing
are outside this version.
