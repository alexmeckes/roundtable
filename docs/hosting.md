# Hosting and security

[Back to Roundtable](../README.md)

## Run the server

Roundtable uses one Node.js process for HTTP, WebSockets, and in-memory room state.
Run it as a persistent service or container with **one replica**. Rooms are saved
to the JSON file specified by `ROUNDTABLE_DATA`; mount persistent storage so they
survive redeployments. A serverless function or multiple independent replicas do
not provide the required shared state.

The repository includes a [Dockerfile](../Dockerfile) and
[Railway configuration](../railway.json). The container uses
`ROUNDTABLE_DATA=/data/rooms.json`; mount a volume at `/data`. Personal Codex bridges
run on participants' machines and connect outward to the server's public room URL.

For a hosted deployment:

1. Build and run the repository's container with one replica and persistent `/data` storage.
2. Set `ROUNDTABLE_PROXY_HOPS` to the number of trusted reverse proxies in front of
   the service; the existing Railway setup uses `1`.
3. Set `ROUNDTABLE_DEFAULT_ACCESS=managed` and
   `ROUNDTABLE_DEFAULT_HOST_ONLY_SPEND=1` for the legacy shared-compute workflow.
4. Set a `ROUNDTABLE_BRIDGE_SECRET` to authenticate any legacy bridges. Personal
   workspace connections use the private pairing token generated in the room.
5. Expose a reachable HTTPS URL. Open it, claim your table, and have each participant
   use **Connect my Codex** to generate their own local bridge command.

Leave `ROUNDTABLE_SHARED_ROOMS` empty unless you intend to authorize specific rooms
to use server-wide legacy bridges or the house adapter. Creating a room or becoming
its host does not grant access to that compute pool. Claim a room before adding it
to the allowlist; branches need their own authorization or room-scoped bridge.

All environment variables are documented in [`.env.example`](../.env.example).
The server does not automatically load that file; set variables in your environment
or hosting provider's settings.

## Security and access

**Room links grant access to shared content.** Generated room IDs are harder to guess
than names such as `/s/demo`, but they are not account-based authentication. Keep
private material out of shared sources and deliverables. Browser identity storage
and pairing commands are private capabilities.

**Each person controls their own Codex.** Other participants can discuss work with an
opted-in agent; only its owner can assign execution, cancel tasks, or retire its
specialists. Generating a new pairing command revokes the old connection. Context
changes respect room speaking permissions. Agents can propose knowledge, but only
people can accept it. Shared skills require a separate opt-in per person and version.

**Local execution requires trust.** Personal discussion uses Codex's read-only
filesystem sandbox. Execution tasks use separate worktrees or output directories,
while configured check commands run with local OS permissions. A separate directory
does not isolate filesystem reads or connected tools. Use a separately isolated OS
account or container for untrusted work, and verify its access before connecting.

**Shared artifacts have limits.** Downloads are served as attachments. Static
previews are sandboxed and restricted to their own assets; file paths, sizes, and
counts are checked. Archiving a work card removes its server artifacts, so links to
those artifacts in Context will stop working. Local task outputs remain on the owner’s machine.

**Shared-brain controls are separate.** The legacy adapter uses
`~/.roundtable-bridge/workspace` with read-only turns. Its `--allow-apply` flag permits
the room host to apply checked diffs in the bridge's launch directory;
`--confirm-apply` adds terminal review. Application is available only through a
room-scoped bridge. These flags do not configure personal workspaces.

In personal/bridge-only use, model-provider credentials stay on participants'
machines. The room server still holds room host keys and bridge authentication
data. Leave `ANTHROPIC_API_KEY` unset on a public server: enabling the optional house
adapter places provider credentials and billable inference on that server.

The server also enforces room/bridge run budgets, browser origin checks, connection
and frame limits, heartbeats, idle-room cleanup, and content security headers.
These controls do not replace participant authentication or OS-level isolation.
