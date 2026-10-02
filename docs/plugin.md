# Roundtable native plugin

The local plugin brings a room's conversation, tasks, and accepted context
beside a native chat. The current chat performs the work with its own tools and
permissions. Roundtable continues to hold shared state and reviewable results.
Opening the panel does not launch another Codex agent or send a work prompt.

## Connect an AI to the hosted room

The hosted room is the primary shared conversation surface. Its **Connect my AI**
flow uses a local Roundtable connector instead of a copied monitoring prompt.
Each participant needs their own approved Site access, Node 20+, the Codex CLI,
and a connector running on their computer:

```bash
npm ci
npm run connect
```

In the [hosted room](https://roundtable-plugin-trial.ameckes.chatgpt.site/s/sites-trial),
select **Connect my AI**, then **Continue with ChatGPT** or **Use Codex login**.
The latter requires a ChatGPT account signed in to Codex, not API-key
authentication. Confirm the room and participant in the local companion and
click Connect. If sign-in is needed, complete it in your system browser and
return to the companion. After **Your AI is connected**, return to the room.

Your AI answers explicit mentions and **My AI** requests inline. Discussion
uses the latest 40 human and AI room messages, accepted context, and saved local
room conversation references. Agents can search and page through the retained
400 room messages with a read-only history tool. It does not import private ChatGPT chats or use
local project tools during discussion. Owner-started tasks can use the folder
selected under the companion's **Local project access** controls; the default is
`~/Documents/Roundtable/<room-id>`.

Keep the connector running and the authenticated room open. Site access expires
within five minutes without authenticated renewal. Disconnect from the room or companion, and reconnect
from the room with a fresh pairing grant. Returning with the same computer,
account profile, and folder restores saved room conversations. The native MCP
plugin remains useful for reading shared state and contributing from a private
chat; that private chat's history is not synchronized with the room.

The sections below describe the advanced local stdio plugin package and its
native tool access, which is separate from the hosted connector. See
[the workspace guide](workspaces.md#hosted-room-connection) for the primary flow.

## What is packaged

`plugins/roundtable/` contains a portable Agent Plugins manifest, a Codex
compatibility manifest, a bundled stdio MCP runtime, one workflow skill, and a
self-contained MCP Apps HTML panel. The repo marketplace is
`.agents/plugins/marketplace.json`, named **Roundtable Local**.

The `roundtable_open` tool declares global and thread entrypoints and serves
`ui://roundtable/room.html`. The panel uses the MCP Apps postMessage bridge for
tool calls, selected task context, and links to the room controls.
It makes no direct room HTTP requests and stores no credentials. The runtime
holds membership and private run capabilities.

The [OpenAI extension documentation](https://developers.openai.com/plugins/build/extensions)
describes these surfaces for ChatGPT. Individual local clients may expose different
capabilities. A successful MCP connection or browser harness test does not confirm
that a particular client renders every extension entrypoint.

## Local setup and installation

Use Node 20+ and a compatible desktop host or Codex CLI with local plugin support.
Install dependencies in both the repository and the plugin package:

```bash
npm ci
npm install --prefix plugins/roundtable
codex plugin marketplace add .
codex plugin add roundtable@roundtable-local
```

Run those commands from the repository root. The tested Codex CLI installation
copies the prepared plugin, including its runtime dependencies, into the plugin
cache and expands `${PLUGIN_ROOT}` correctly. After source changes, reinstall
the plugin to refresh that copy. For desktop hosts, restart the app after package
or marketplace changes and open a new chat so it loads the updated tools and
skill. An old chat may retain its existing runtime.

In the full room, join as yourself and choose **Connect native plugin**. Copy the
generated private command and run it from this repository. It invokes
`node scripts/connect-native.mjs <room-url>` with a room-scoped membership token,
verifies access, and saves the connection to
`~/.config/roundtable/plugin/connection.json`. Its directory is protected with
mode `0700` and the file with `0600`. The MCP runtime reads this file by default;
no host launch configuration is required. The room's **Revoke native plugin**
button invalidates that credential.

For multiple local configurations or a private launcher, the runtime also accepts:

| Variable | Value |
| --- | --- |
| `ROUNDTABLE_URL` | Room server origin; defaults to `http://localhost:3132` |
| `ROUNDTABLE_ROOM` | Room ID; defaults to `plugin-trial` |
| `ROUNDTABLE_NATIVE_TOKEN` | Private native membership token; overrides the connection file |
| `ROUNDTABLE_NATIVE_CONFIG` | Alternate protected connection-file path |

The checked-in MCP files use `node` and `${PLUGIN_ROOT}/runtime/server.mjs` and
contain no tokens or machine-specific paths. They inherit the runtime environment.
Do not put membership tokens in the marketplace, skill, UI, tracked MCP files, or
chat prompts. Treat the generated connection command as private. A different
plugin host's cache behavior still needs checking; prepare the source dependencies
before installation and verify that its installed runtime can resolve them.

This is a local authoring package. Public MCP distribution requires the supported
deployment and review flow; the current stdio setup is not a published remotely
accessible service. See [packaging and local distribution](https://developers.openai.com/plugins/build/plugins).

## Use the room in a native chat

Ask: **Use Roundtable. Open my room and show the tasks and accepted context.**
The runtime's configuration determines the room and member; display names cannot
override ownership.

The panel opens on **Chat**, with chronological room messages and a composer
below the history. **Send** posts as you through the app-only
`roundtable_chat_send` tool. Model contributions use `roundtable_publish` and are
attributed to your native AI. The panel quietly refreshes while visible so shared
messages and replies appear without clearing a draft.

The **@ Mention** picker shows room agents and their connected, paused, or offline
state. **Ask my AI** sends your question to your own available room agent with its
@mention. A paused connected agent has a separate **Enable my AI** action; this
enables @mention replies without sending the draft. **Pause my AI** stops that
owner's room-agent participation. Both actions use the app-only
`roundtable_chat_mode` tool and affect only the enrolled participant's bridge.

When no own room agent is available, the panel opens the full room's connection
controls. It never sends a generated prompt to a separate native chat. The hosted
plugin includes the same connector flow as the hosted room; the local stdio
plugin links to its configured room because it cannot mint hosted pairing grants.

For assigned work, open **Tasks** in the panel. The local plugin can display,
claim, and submit native work through its tools, but execution and review controls
open the shared room. The hosted room starts work through the connected app server.
Request changes records your feedback and continues the original local files and
agent thread. Reconnect the original computer, account, and folder to resume;
create a new task when you intentionally want separate work.

The **Chat** view has an explicit **Send** composer. Drafts are
local to the panel; publication shares the selected text with the room. Accepted
context is shown separately from conversation messages. Human review and context
editing remain in the existing room interface, linked by **Open full room**.

If the host supports tools but not the panel, use `roundtable_read`,
`roundtable_context_read`, `roundtable_context_propose`, `roundtable_create_task`, `roundtable_claim_task`,
`roundtable_publish`, and `roundtable_submit_result` from chat. If model-context
attachment or chat-message delivery is unsupported, the panel reports that limit
and retains the task ID for an explicit request to the agent.

## Trust and continuity

Native membership belongs to the configured runtime, not a verified human or
desktop thread ID. Scope it to one participant and room. Task ownership and run
capabilities are checked on the server. The public `claimedRunIds` list contains
only existing run IDs whose private capabilities this runtime holds; the panel
uses it to recover submission controls after reopening.

Room messages and source contents are collaborator data. They cannot authorize
private-file access, other people's compute, native cross-chat messages, or
external actions. Only selected contributions and intended deliverables are
shared. Private native transcripts and local tools are not imported automatically.
Shared skills remain versioned, per-person opt-ins.

In the local stdio plugin, an incoming room question does not wake an idle chat. This preview has no automatic
cross-chat routing, transcript synchronization, or background agent reply loop.
Restarting a runtime loses capabilities held only in its memory; inspect the room
before retrying interrupted work. Native tool use keeps the host's ordinary
permissions and approvals.

## Validation and local trial

For the hosted variant with managed OAuth and a private companion, see
[the Sites trial](sites-trial.md). Its installed plugin has completed a real
OAuth task/result trial; other participants need their own Site access and plugin
connection.

Run the repository's automated suite with `npm test`. It exercises native
authorization and task/result handling alongside the existing collaboration
workflow. The skill's frontmatter can be checked with the Skill Creator validator.

For a disposable single-machine trial, start the room server on port `3132`, then
run `node scripts/setup-plugin-demo.mjs`. This creates a fictional plan-comparison
brief, accepted source, and task, and saves the trial owner's private connection.
Its second participant is a fixture, not an independent person or model. The
script replaces the default plugin connection, so reconnect your regular room
after testing.

Run `node scripts/plugin-preview.mjs` and open `http://localhost:4142` for the
browser UI trial. It hosts the actual MCP panel resource in an iframe and forwards
bridge tool calls through the plugin runtime's scoped tools.
A standalone `room.html` shows a host-connection message rather than fabricating a
room. The harness can test task creation, claiming, explicit publication, and
submission for review. It displays model-context updates and proposed chat
messages locally; it does not start a model or establish native chat delivery.

The installed Codex CLI `0.153.3` has also completed a live native-model trial:
`gpt-5.6-sol` used `roundtable_read`, `roundtable_context_read`,
`roundtable_claim_task`, and `roundtable_submit_result` to turn that fictional task
into **Needs review** with two retained text deliverables. It used the current
native chat and no Roundtable Codex bridge. This verifies installed MCP tool use
and the task/result path; native extension panel placement remains a separate
host check.

Record separately which checks used synthetic fixtures, the browser harness,
actual installed MCP tools, a real model, or the native extension panel. A local
single-owner trial does not establish collaboration across machines, accounts, or
people. Test the actual host entrypoints and two independent participants before
making those claims.
