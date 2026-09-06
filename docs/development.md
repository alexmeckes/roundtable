# Development

[Back to Roundtable](../README.md)

## Run and test

```bash
npm ci
npm start
npm test
```

The automated suite uses simulated bridges and does not spend model usage. The
[latest recorded run](evidence/shared-context/unit-tests.txt) passed 44 tests,
covering authorization, concurrent work, cancellation, downloads, Git integration,
context history, proposal approval, and skill adoption.

`node scripts/setup-work-demo.mjs` creates a disposable folder with fictional source
data and an approach file. Use its printed path with a personal connection to try
document work. Live Codex tests use the connected person's model allowance.

## Architecture

The server coordinates rooms and publishes reviewed outputs. Personal bridges run
Codex locally; the browser displays shared conversation, context, work, and canvas.

| Area | Files |
| --- | --- |
| Room state, WebSockets, permissions, persistence | [`server.js`](../server.js) |
| Personal pairing, work dispatch, downloads | [`workspace/server.js`](../workspace/server.js) |
| Agent conversation queues and handoffs | [`workspace/conversation.js`](../workspace/conversation.js) |
| Context revisions, proposals, retrieval, skill adoption | [`workspace/context.js`](../workspace/context.js) |
| Personal bridge and local Codex transport | [`bridge/workspace.js`](../bridge/workspace.js), [`bridge/app-server.js`](../bridge/app-server.js) |
| Folder outputs and Git integration | [`bridge/folder.js`](../bridge/folder.js), [`bridge/worktree.js`](../bridge/worktree.js) |
| Codex project grouping and context tools | [`bridge/thread-project.js`](../bridge/thread-project.js), [`bridge/context-tools.js`](../bridge/context-tools.js) |
| Browser interface | [`public/room.html`](../public/room.html), [`public/workspace.js`](../public/workspace.js), [`public/context.js`](../public/context.js) |
| Legacy canvas adapters and output contract | [`bridge/codex.js`](../bridge/codex.js), [`agents/prompt.js`](../agents/prompt.js), [`agents/house.js`](../agents/house.js) |

The client is a plain HTML/JavaScript page. Mermaid is vendored and loaded when
needed. The server uses Express and WebSockets with a JSON persistence file; keep
one replica. See [hosting](hosting.md) for operational details.

## Protocol notes

People and bridges exchange typed WebSocket messages. The personal bridge uses
`workspace_bridge_join`, receives discussion or work jobs, and publishes results
through authenticated HTTP uploads. Shared-context tool requests are checked
against the connected room and active run. The handlers in
[`workspace/server.js`](../workspace/server.js) define the current contract.

Context entries use version checks to prevent stale saves from overwriting newer
edits. Proposals become accepted context only through a human action. Skills are
adopted for one owner and one version; updates invalidate that adoption.

Canvas edits use server-issued block IDs and compare original content before
saving. Agent canvas updates and branch merges are accepted only if the target
canvas has not changed since their starting snapshot. Conflicts preserve a draft
for recovery; there is no CRDT or automatic conflict merge. Reload browser tabs
when upgrading so the client and server use the same protocol.

The legacy agent output is a strict JSON object containing `note`, `canvas`, and
`actions`. Its supported actions are `create_agent` and `update_soul`; they belong
to the [legacy canvas workflow](legacy-canvas.md), not personal specialists.

## Recorded evidence

- [Shared context](evidence/shared-context/README.md): retrieval, human review,
  versioned skills, server/bridge restart, and an actual Markdown deliverable.
- [General work](evidence/general-work/README.md): named specialists discussing
  options and producing Markdown and CSV in parallel.
- [Codex project grouping](evidence/thread-project/README.md): separate execution
  directories sharing one local project assignment.
- [Shared conversation](evidence/shared-conversation/README.md): agent handoffs,
  work updates, and owner pause.
- [Cancellation rerun](evidence/studio-rerun/README.md): background terminal cleanup
  and cancellation behavior.

Evidence captures are historical records of their tested revision. The latest
shared-context run used one local owner and two specialists; it does not establish
multi-machine reliability. See [PRODUCT.md](../PRODUCT.md) for product direction.
