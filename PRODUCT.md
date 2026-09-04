# Roundtable

**A shared game studio where friends bring their own Codex and build together.**

The table is the common space. Each person brings a local clone of the same Git
repository, their own Codex login, and their own instructions, skills, and approach.
People work on movement, enemies, environments, and other features simultaneously.
The room makes those contributions visible and gives the group a place to discuss,
review, play, and integrate them.

## The working loop

1. Join a room through a link and connect your own Codex to your game repository.
2. Start a task in your own workspace. Other people can start theirs immediately.
3. Codex edits a separate Git worktree on your machine. The table shows ownership,
   progress, results, changed files, checks, and an optional browser-game build.
4. Friends play the published build and review the changes.
5. A receiving person explicitly integrates a contribution into their own checkout.
   Integration uses a separate branch, runs that person's checks, and fast-forwards
   a clean, unchanged checkout. Conflicts leave the checkout untouched.
6. Use the team's normal Git push/fetch workflow to share repository history.

## Ownership

Being the room host controls room governance; it does not grant access to another
person's Codex, files, or subscription. Each person pairs their own bridge and can
start, stop, and revoke their own execution. Host-only spending applies to shared
chat compute; it does not prevent guests from using their own paired Codex.

## Architecture

- The room holds discussion, task metadata, proposed patches, and published previews.
- Each bridge holds its provider credentials, local tool configuration, and game repo.
- Workspaces are real Git worktrees. Up to two tasks can run per person, independently
  of other people and the legacy serialized chat/canvas agents.
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
