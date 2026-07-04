# Channels Runs — Piece 1 backend acceptance

End-to-end verification of the backend Run engine (commit `bddcca2a`), run **2026-07-04** against
the live tauri dev app over CDP via `scripts/cdp-e2e-runs.mjs`. Worker cwd was an isolated temp dir
(not the repo); each spawned worker was torn down after the step.

**Result: 5/5 steps passed.**

| Step | RPC | Observed |
|---|---|---|
| 1 | `CreateRun` | 3 phases; p0 `running` with a worker tab; status `planning`. Worker block meta = `controller=cmd`, `cmd=claude`, `cmd:args=[brainstorm prompt]`, `cmd:cwd=<isolated>`, `cmd:jwt=true`, `cmd:shell=false`. |
| 2 | `AdvanceRun{complete, phaseidx:0}` | p0 `done` (artifact recorded), p1 `running` with its own worker tab; status `planning`. |
| 3 | `AdvanceRun{complete, phaseidx:1}` | p1 `done`, p2 `pending`, **no new worker**; status `awaiting-review` (gate halt). |
| 4 | `AdvanceRun{approve}` | p2 `running` with a worker tab; status `executing`. |
| 5 | `CancelRun` | status `cancelled`; p2 `skipped`. |

A successful `CreateRun`/`AdvanceRun` is itself proof `ResyncController(force=true)` launched the
claude worker (the RPC errors otherwise). The state machine, gate halt/approve, and real backend-owned
tab spawning are confirmed.

## Known issue surfaced (out of Piece 1 scope)

Deleting a freshly-spawned worker tab's block panics backend-side: `nil pointer dereference` at
`pkg/wcore/layout.go:79` via `DeleteBlockCommand` → `QueueLayoutActionForTab` (`wshserver.go:498`).
The block and tab **are** deleted first (log: "deleting tab …"); the panic occurs afterward in the
layout-action update and surfaces to the caller as an RPC error. Pre-existing `DeleteBlock` robustness
gap (the spawned worker tab has no layout state), not caused by the run engine — but the run→worker
teardown path will hit it. Worth fixing when Piece 2 wires worker cleanup.

Separately, closing a worker's `pwsh` shell controller does not cascade-kill the child `claude.exe`
(orphaned process). Relevant to worker-kill semantics in a later piece.
