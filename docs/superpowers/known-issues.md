# Known issues

Tracked defects surfaced during development that are out of scope for the piece that found them.

## DeleteBlock panics when tearing down a spawned worker tab

**Surfaced:** 2026-07-04, Channels Runs Piece 1 e2e (`scripts/cdp-e2e-runs.mjs`).

**Symptom:** Deleting the block of a freshly-spawned background worker tab panics backend-side:
`runtime error: invalid memory address or nil pointer dereference`.

**Stack:**
```
pkg/wcore/layout.go:79            (nil deref)
pkg/wcore/layout.go:108           QueueLayoutActionForTab
pkg/wshrpc/wshserver/wshserver.go:498  (*WshServer).DeleteBlockCommand
```

**Details:** The block and its (now-empty) parent tab are deleted successfully first — the log shows
`DeleteBlock: parentBlockCount: 0` then `deleting tab <id>`. The panic occurs *afterward*, when the
delete path queues a layout action for the tab. The worker tab was created via `wcore.CreateTab` in
`jarvis.SpawnClaudeWorker` and has no initialized layout state, so `QueueLayoutActionForTab` dereferences
nil. No data loss (delete already committed); the panic surfaces to the caller as an RPC error.

**Not caused by** the run engine — this is a pre-existing `DeleteBlock` robustness gap. But the
run→worker teardown path hits it, so fix it before Piece 2 wires worker cleanup: guard
`QueueLayoutActionForTab` (and the `layout.go:79` access) against a missing layout state.

**Related:** closing a worker's `pwsh` shell controller does not cascade-kill the child `claude.exe`
(orphaned process) — relevant to worker-kill semantics in a later piece.
