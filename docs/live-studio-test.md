# Live studio test — 2026-09-04

Tested the merged personal-workspace implementation using the actual room UI,
two independent browser identities, two local Git clones, and two real personal
bridge processes. All seven model tasks used `gpt-6-astra` with Codex CLI 0.153.3.
Both bridge processes used the same local Codex account. Separate machines,
separate accounts, and internet connectivity were not tested.

The disposable browser game used ES modules, a dependency-free build script,
and `npm test && npm run build` as each owner's check command. Task submission,
patch review, acceptance, integration, preview interaction, and cancellation
were performed through the room UI.

## Parallel contributions: passed

- Alice implemented dash movement in `movement.js`; Bob implemented coin
  collection in `coins.js`. Both tasks were observed running simultaneously.
- Both contributions passed checks, changed only their requested file, and
  left the original checkouts clean at the common baseline.
- Played each sandboxed contribution: dash moved 50 units; moving to position
  110 collected exactly one coin.
- Reviewed and integrated both patches into Alice's checkout. The combined
  published build reached position 100 and collected one coin after two dashes.
- Refreshing and rejoining Bob's room preserved his bridge and task ownership.

## Conflicting contributions: passed

- Synchronized Bob's clone to Alice's combined commit using local Git fetch and
  fast-forward, then started two real tasks from that identical baseline.
- Alice changed speed from 10 to 20; Bob changed the same line from 10 to 30.
- Integrated Alice's change, then attempted Bob's through the review dialog.
- The UI reported a conflict. Alice's HEAD stayed unchanged, her checkout stayed
  clean with speed 20, and the retained integration worktree contained the
  unresolved `movement.js` conflict.

## Cancellation: failure found, fixed, and retested

The original implementation marked a task interrupted but only interrupted its
model turn. A running terminal wrote `finished.txt` after its 45-second delay,
even though the owner had pressed Stop after `started.txt` appeared.

The bridge now calls `thread/backgroundTerminals/clean` after `turn/interrupt`
and waits for cleanup before releasing the local task. This cleanup is scoped
to the cancelled thread. Cleanup failures are surfaced to the caller.

Repeated the same real Astra task after the fix and waited past its original
deadline: `finished.txt` was absent. A second task running on the same bridge
completed its delayed command, published a contribution, and passed checks.
The original checkout remained unchanged.

The automated regression models the delayed turn-start response, a terminal
that survives turn interruption, asynchronous cleanup, and an independent
sibling turn. The full 27-test suite passes.
