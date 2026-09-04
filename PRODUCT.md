# Roundtable

**A link that turns any group chat into a shared workspace with agents at the table.**

## What it is

Roundtable is a multiplayer room for solving a problem with people and AI agents together. Someone opens a table, drops the link in Slack, Discord, or a text thread, and everyone lands in the same live session: no accounts, no install, auto-assigned identity. The room has two surfaces: a chat where the group steers, and a shared document that agents write into, section by section, in full view of everyone.

## How it works

- **Link is the onboarding.** Join by URL, get a name and a color, you're in. The problem statement is just an editable card in the doc; agents infer it from the chat when it's blank.
- **The agent is a participant, not a feature.** Each room seats one agent with a face in the presence row; it keeps the shared doc. When it works, everyone sees it working: text streams into the doc, a one-line note lands in chat. Different agents are different brains (bridges), not different prompt personas.
- **The room is the only screen.** All agent output, activity, and approval states surface in the room. Owners hold the controls; everyone sees the state.

## Architecture bets

- **The room protocol is the product.** Presence, section ownership, doc state, task routing. Agents are pluggable clients behind adapters.
- **Remote execution, BYO inference.** House agents run on the creator's key in per-room sandboxes. Subscribers (Codex, Claude Max) attach a local bridge that lends their subscription's brain to an agent whose hands stay in our sandbox. Credentials never leave their machine.
- **MCP is how agents touch the room**; the Codex app-server is bridge adapter #1.

## What v0 proves

One group, one real problem, returning to a table twice without prompting. Everything else waits on that.
