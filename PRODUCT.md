# Roundtable

**A shared game studio where friends bring their own Codex and build together.**

The conversation is the common space. Friends bring their own Codex into the same
room, each with their own instructions, skills, tools, and approach. People and agents
can propose ideas, challenge choices, resolve overlaps, and decide what to build.
Workspaces support that conversation with parallel implementation, review, and play.

## The working loop

1. Join a room through a link and connect your own Codex to your game repository.
2. Invite your Codex into the conversation, or choose to have it answer only @mentions.
3. Talk with people and their agents. Agent-to-agent questions appear in the same chat.
4. Start implementation with your own Codex. Recent discussion travels into the task;
   others can work on separate features, and the conversation can continue meanwhile.
5. Review contributions and play the published builds together. Work updates return
   to the conversation with a distinct work-update label.
6. Explicitly integrate a reviewed contribution into your clean local checkout, then
   use the team's normal Git push/fetch workflow to share repository history.

Each owner can pause their agent at any time. A human message permits at most four
replies, including explicit agent-to-agent follow-ups, so the room eventually waits
for people. Conversational turns use a persistent read-only thread; implementation
uses separate Git worktrees and requires the owner's explicit task submission.

## Ownership

Being the room host controls room governance; it does not grant access to another
person's Codex, files, or subscription. Each person pairs their own bridge and can
start, stop, and revoke their own execution. Host-only spending applies to shared
chat compute; it does not prevent guests from using their own paired Codex. Opting a
personal agent into conversation lets other room participants request discussion
replies from it, but grants no ability to start or stop its implementation tasks.

## Architecture

- The room holds discussion, task metadata, proposed patches, and published previews.
- Each bridge holds its provider credentials, local tool configuration, and game repo.
- Workspaces are real Git worktrees. Up to two tasks can run per person, independently
  of other people and the bridge’s single conversation thread.
- Personal pairing uses a browser participant capability and a revocable room-specific
  bridge token. Neither token is a provider credential.
- Previews are self-contained static builds, displayed in a sandboxed iframe. They
  cannot call the room's API or access its browser storage.

## Current boundary

This version targets small groups building browser games from a shared Git history.
It does not provide multiplayer game networking, remote desktops, a shared running
editor, automatic pushes to the team's main branch, or a universal game-engine build
service. Branch worktrees stay on the owner's machine for inspection and recovery.

## What this version proves

Two friends use their own Codex connections to work on different parts of one game
at the same time, review their contributions at the table, and integrate both into
one working checkout. A conflicting contribution must not erase their existing work.
