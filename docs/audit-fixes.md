# Collaboration audit fixes

2026-10-02. The audited implementation now includes:

- Runtime-authenticated prerequisite and patch downloads, restricted to the paired room with redirects rejected.
- Human revision feedback and continuation of the original task thread and files. Missing checkpoints fail before execution rather than silently starting over.
- Five-minute runtime access leases renewed only by authenticated Site requests. Expiry blocks reads, replies, result publication and reconnects; active work is interrupted. Legacy pairing cannot bypass this rule. Results stage privately and authorization is checked again before publication.
- Cancelled reconnect timers on shutdown and recovery of the original companion owner's control cookie after an hour away.
- Codex-login session isolation using a local hash of the authenticated account email, checked before each turn. Old unscoped Codex sessions are not automatically migrated. ChatGPT-plan session scopes are preserved.
- Read-only search and pagination through retained room history. The 400-message retention limit remains.
- Runtime-aware task controls, owner-only local Stop, inline revision feedback, and removal of generated native-chat handoff prompts. The local stdio plugin opens room controls for connection and execution.
- An installable connector archive and `roundtable-connect` executable with `--help` and `--check`.

## Verification

All 189 backend, runtime, task and UI tests pass. The separate Site passes TypeScript checking and its production build. Built-Worker/D1 checks pass authentication denial, two synthetic participant identities, runtime pairing, inline publication, task review feedback, `/api/access` renewal, protected downloads and request limits. Browser QA saved review feedback and verified that the prior result remains visible. The archive installs into a clean temporary directory and serves the loopback connector outside a checkout without authentication or model execution.

The additional runtime tests use the real bridge subprocess with a fake app server to verify preserved task directories, files, thread IDs, review feedback, authenticated downloads and shutdown behavior. They do not claim a new real-model or two-computer trial.

## Publication status

The original trial's owner account was unavailable to this session, so its prepared update was not deployed there. At the user's request, a separate owner-private Codex trial was published on 2026-10-02 with the audited backend and Site. The Site source is now included in `sites/roundtable/`; see [the Codex trial notes](codex-trial.md) for deployment and connection status. The original trial and its audience were left unchanged.

Keep the authenticated room open while its AI runs. The main room polls while backgrounded; settings renews access every minute. If renewal fails for five minutes, reconnect through the room. Access revocation is bounded by that lease, not an instant cross-platform revocation webhook.

A second person with their own account and computer still needs to test the full workflow. The implementation remains a shared room for local app-server agents, not an import of existing Dots or private ChatGPT history. A graphical connector installer and always-on hosted agents are outside this fix.
