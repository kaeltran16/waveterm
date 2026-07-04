# Known issues

Tracked defects surfaced during development that are out of scope for the piece that found them.

## DeleteBlock panicked when tearing down a spawned worker tab — RESOLVED 2026-07-04

**Surfaced:** 2026-07-04, Channels Runs Piece 1 e2e (`scripts/cdp-e2e-runs.mjs`).

**Symptom:** Deleting the block of a freshly-spawned background worker tab panicked backend-side:
`runtime error: invalid memory address or nil pointer dereference`.

**Root cause:** A worker tab is a single-block tab. `DeleteBlockCommand` captures `tabId`, then
`wcore.DeleteBlock(..., recursive=true)` deletes the block and — because it was the last block —
cascade-deletes the whole tab (`DeleteTab`, incl. its LayoutState). `DeleteBlockCommand` then queued a
layout-remove action for the now-deleted tab: `GetLayoutIdForTab` → `DBGet[*Tab]` returns `(nil, nil)`
for the missing row (unlike `DBMustGet`, `DBGet` does not guard nil), so `tabObj.LayoutState`
dereferenced nil. Not run-engine-specific — deleting the last block of *any* tab hit it; worker tabs
just always have exactly one block.

**Fix:**
- `pkg/wcore/layout.go` `GetLayoutIdForTab`: return an error instead of dereferencing a nil tab.
- `pkg/wshrpc/wshserver/wshserver.go` `DeleteBlockCommand`: only queue the layout-remove action if the
  tab survived the (possibly cascading) block delete, and stop ignoring that call's error.

**Verified:** e2e `worker kills` now all return `killed …` (were `kill-fail <panic>`); 5/5 steps pass;
no orphaned worker processes; `go test ./pkg/{wcore,wstore,wshrpc,jarvis}/...` green.

**Still open — closing a shell-controller worker does not cascade-kill child `claude.exe`:** relevant
only if a future worker launches claude *under* a shell (`pwsh`). The current run workers run
`controller=cmd` with `cmd=claude` directly, so `DestroyBlockController` kills claude directly (no
orphan) — confirmed by the e2e leaving no stray processes. Revisit for worker-kill semantics if that
launch shape changes.
