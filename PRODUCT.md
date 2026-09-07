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
   recent conversation and accepted context, and works independently while discussion continues.
5. Review its report and download its deliverables. For Git projects, review and
   integrate patches. Open a preview when the result includes one.
6. Keep a specialist around for more work, or retire it while retaining its messages
   and results. Pause all your agents’ discussion whenever needed.

## Agents and ownership

A participant can create up to four specialists under their own Codex connection.
Specialists have unique handles, roles, and separate conversation sessions. Their
profiles persist with the room and return when the owner reconnects. Thread handles
are saved locally and restored after a bridge restart. Each new turn also receives recent room
context and shared project memory. Retirement removes the active profile, not previous messages or outputs.

This version creates specialists through the owner’s chat command or Add specialist
control. Autonomous agent-created specialists
are future work. Room participants can discuss with an opted-in agent; only its owner
can assign execution, retire it, or stop its tasks. There is no mandatory lead agent.

Each person can run two execution tasks concurrently. A bridge supports its primary
conversation and four specialist conversations, sharing its hourly budget. Human
messages permit up to four replies, at most two per agent. Specialists answer explicit
mentions; the primary agent can opt into general chat. Agent handoffs stay visible.

## Shared context and learning

The Context panel holds the team's brief, reference sources, accepted decisions,
learnings, and optional shared skills. People can save material directly or capture a
chat message with its original attribution. Agent contributions enter as proposals;
a person accepts, revises, or dismisses them. Accepted context is not the same as an
agent's unreviewed claim, and accepted items can later be corrected or retired.

Every personal agent turn receives the current accepted index and can retrieve full
entries as needed. Source revisions, evidence references, authors, and edit history
remain visible. Stale edits are rejected without discarding the person's draft.
This shared knowledge survives restarts independently of private agent sessions.

A shared skill is a set of instructions, adopted separately by each person for their
agents. Adoption pins the current version and must be renewed after edits. It does
not install software, enable tools, or expand local permissions. People continue to
bring their own approaches and local skills.

The first version accepts pasted sources and reference links, including existing
work deliverables. It does not automatically import external documents or synchronize
source contents. The owner remains responsible for deciding what to share.

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

## Shared project interface

Roundtable is a multiplayer work environment for people and their agents. A project
sidebar connects the common conversation, people and agents, task threads, and
shared resources. The main area shows the selected conversation, task, context,
canvas, or output in a tab. Connection setup belongs to the participant’s Codex
settings. There is one task workflow instead of a competing execution prompt.

Task discussion is shared with the table; agent profiles link assigned work. These
views do not create new private chats or change who can start an agent.
