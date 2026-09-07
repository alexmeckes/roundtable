# Local Codex project grouping

Verified with installed Codex CLI 0.153.3 and two real `gpt-6-astra` turns on September 6, 2026 (UTC).

The bridge resolved the existing `roundtable` project through `project/list`. It started a Mira discussion thread and a Quinn work thread concurrently, passing the same `projectId` to each `thread/start` request while retaining different working directories. It named both through `thread/name/set`.

After the turns completed, `thread/read` returned the expected project ID and readable name for each thread. A project-filtered `thread/list` included both. The two synthetic test threads were then archived, and their temporary directories removed.

[Verification records](verification.json) contain the actual thread IDs, project assignment, titles, and separate directories. This was a local runtime/API check, not a screenshot-based desktop sidebar check.

The automated suite now passes 38 tests. New cases cover paginated project lookup, canonical/symlink directory matching, explicit project selection, stable project creation requests, and shared project assignment without changing execution directories or read-only discussion settings.

The new bridge startup behavior applies to future personal workspace threads. It does not migrate historical threads. To verify manually, connect a folder, note the project printed by the bridge, create a specialist, and assign it work. The conversation and work should share the selected project's ID while retaining their respective directories.
