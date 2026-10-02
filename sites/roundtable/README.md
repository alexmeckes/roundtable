# Roundtable Sites trial

A private shared conversation for people and their own AIs, with a stateless MCP 2.0 plugin. Sites supplies managed sign-in and provisions the plugin. The room, conversation, task permissions, reviews, and text deliverables remain on the existing Node backend in a separate Railway trial environment with a dedicated `/data` volume.

This directory contains the Site source imported from deployed commit `be94229d296fe72f416f0aa2e619a32ba19570f1`. See [the current trial notes](../../docs/codex-trial.md) for its room and connection setup. Local verification below retains the isolated `sites-trial` fixture room.

The hosting project is recorded in `.openai/hosting.json`. Runtime values `ROUNDTABLE_BACKEND_URL`, `ROUNDTABLE_SITES_ROOM`, and secret `ROUNDTABLE_SITES_GATEWAY_SECRET` are managed in Sites, never committed here. The same gateway secret and selected room ID are configured on the trial backend. Neither local room files nor native pairing credentials are uploaded.

## Product flow

Open the Site and sign in. One composer sends to **Everyone** or **My AI**; questions, attributed replies, and request progress live in the room. Tasks and context are secondary. Human task review, requesting changes, and stopping runs happen in the same interface. `/` and `/s/sites-trial` serve the same room; `/s/sites-trial/manage` keeps advanced room controls.

Run `npm run connect` from the repository root on each person's computer. Select **Connect my AI**, then **Continue with ChatGPT** or **Use Codex login**. The local connector confirms the room and starts an actual Codex app-server runtime after the person clicks Connect. ChatGPT-plan credentials and saved agent conversations remain on that computer. Existing Codex login must be a ChatGPT account; API-key accounts are rejected by this flow. The room marks an AI connected only after its authenticated bridge is ready. Disconnect revokes that owner's room connection. Keep the authenticated room open: Site requests renew a five-minute runtime lease, while the local runtime cannot renew its own access. `/manage` uses a same-origin `/api/access` heartbeat.

The Site creates a five-minute, one-use pairing grant bound to its signed-in member. `roundtable_runtime_pair` is app-only: the grant is carried in private UI metadata, never model content or public room state. The connector receives it in a URL fragment, clears the fragment, and exchanges it for a private runtime session through the backend. The connector binds to loopback, pins accepted backend and room origins, and requires its own cookie, exact Origin, and CSRF token for local mutations.

**My AI** reads the shared room conversation and accepted context, then answers in that same chat using the person's saved local app-server conversation. It does not import private ChatGPT or Codex chats. Conversation turns use a read-only sandbox with inherited tools and MCP servers disabled; only explicit Roundtable context, bounded history-reading, and proposal tools are exposed. Starting an assigned task is a separate action that permits work in the selected local folder and returns a result for human review. The connector creates a dedicated per-room folder by default. Request changes captures feedback and resumes the same task thread and files; unavailable checkpoints require reconnecting the original setup or creating a separate task.

The browser uses cookie-authenticated `POST /api/room`; plugin calls use managed OAuth at `POST /mcp`. The browser allowlist permits fourteen panel actions and requires same-origin JSON requests. Four app-only runtime actions pair, disconnect, start an assigned task, and stop it. MCP 2.0 (`2026-07-28`) uses the SDK's per-request HTTP handler; legacy JSON transport remains available for existing clients and the room panel. Discovery and UI resource metadata contain no room data.

## Optional native and event integration

The generated plugin still exposes shared-room tools for native chats. Its authenticated MCP endpoint advertises `roundtable.ai_requested` and implements the webhook subscription lifecycle documented by [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events). These advanced native/event paths are separate from the main app-server connection and do not make a plugin installation or acknowledged webhook equivalent to a running AI.

Reply requests are persisted and correlated by ID. Retrying an ambiguous request reuses that ID; publishing the same answer twice returns the original message. Cancellation prevents late publication. Only the request owner can start and answer it. Requested cloud deliveries survive a restart while still authorized and unexpired; interrupted active replies require a retry. An accepted callback confirms delivery, not model execution: **replying** starts only when the agent calls `roundtable_reply_start`, and completion only when it publishes with the request ID.

Event subscriptions and a bounded outbox remain on the private backend volume. HTTPS callbacks are verified with signed one-use challenges; each connection resolves and rejects non-public addresses, then pins TLS to the validated address. Requests do not follow redirects. Deliveries use Standard Webhooks signatures, fixed IDs across bounded retries, finite subscription lifetimes, and access checks before sending. Callback URLs, signing keys, and credential hashes never appear in room snapshots. Disconnecting in the room stops delivery and fences automatic refresh; stop the monitoring task in its Dot or Work Cloud chat before reconnecting.

Every data-bearing operation uses the trusted Site-scoped authenticated user ID. The backend persists a distinct membership for each ID. A browser session receives a short-lived, one-use ticket for the direct backend WebSocket. Native MCP enrollment does not mint browser tickets. Result downloads go through the authenticated Site proxy.

Task claim capabilities are stored privately in D1 under user, room, and run IDs. Model tools and browser results receive public run IDs only. Submissions acquire a conditional per-run lock. A backend restart interrupts active runs, so a saved D1 token does not resume interrupted execution. If D1 storage fails after a claim starts, stop and reopen that task in Tasks before claiming again.

## Local verification

`npm run build` builds the Worker and packages generated schema migrations. `npx tsc --noEmit` checks the TypeScript source. `scripts/check-roundtable.mjs` checks the built Worker on **loopback port 4144 only**, including identity isolation, one-use runtime pairing and private session exchange, room-context dispatch and inline replies, capability persistence, auth denial, shared-reply retries and isolation, human review, download access, and request limits. Modern discovery and event checks complement legacy-client checks. It deliberately supplies synthetic identity headers and a simulated bridge to a local raw Worker; that is protocol QA, not a test of real model inference or two signed-in people. Production identity headers are provided by Sites.

Use an isolated local Node backend on port 3133 with test-only data and a fixture gateway secret. Apply `drizzle/*.sql` to local D1, then run the built Worker on port 4144 with the corresponding local backend URL, room ID, and fixture secret. The portable dev server on port 4143 uses the starter's local sign-in emulator and an ignored `.dev.vars` file.

## Sharing and rollout

The Site and generated plugin begin private. Broaden the Site audience only when the owner selects recipients. Each person signs into the Site and runs their own local connector with their own ChatGPT account. A plugin connection is optional for the main browser/app-server flow and required to use the native room tools. Verify a second person's member identity, local runtime, and shared replies on another machine before calling this a multi-person live trial. The parent project packages an installable connector with a `roundtable-connect` executable; a graphical installer remains outstanding. Do not distribute another person's pairing grant or credential.
