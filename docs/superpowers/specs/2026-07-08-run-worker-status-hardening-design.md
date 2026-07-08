# Run-worker status hardening (idle-on-exit + hook routing)

**Date:** 2026-07-08
**Status:** Design — awaiting user review
**Surface:** `pkg/blockcontroller` + `pkg/jarvis` + `cmd/wsh` + `src-tauri`
**Parent:** `docs/agents/runs-pipeline-known-issues.md` (residual A + open B)

## Problem

The cockpit roster can lie about a run worker's state in two ways, both traced to
over-reliance on the external Claude Code reporter hook for lifecycle transitions the
backend already owns.

1. **A finished worker lingers as "working."** `SpawnClaudeWorker` publishes a retained
   `agent:status = working` at spawn (`pkg/jarvis/runexec.go:74`) so the worker enters the
   roster immediately without waiting on the hook. Nothing on the backend ever publishes the
   matching `idle`. The only thing that clears the retained `working` is the hook's `Stop`
   event — and if that hook never fires (or routes to a wavesrv the user isn't watching), the
   roster shows the worker as "working" indefinitely. The frontend confirms the trap:
   `liveAgentBaseAtom` keeps any running session-row whose block status atom has a truthy
   `state` (`frontend/app/view/agents/liveagents.ts:41-42`), and only an `idle` event clears
   state/subagents (`agentstatusstore.ts:147-155`).

2. **Hook routing is assumed fragile across coexisting installs.** The known-issues doc
   hypothesizes that when `~/.claude/settings.json` hooks are stamped with a *different*
   install's `wsh` path, status never reaches the cockpit. Code tracing shows routing is more
   robust than that (see Background), so the concrete defects are narrower: the hook is
   undiagnosable when it fails silently, and `install-agent-hooks` clobbers a working config
   on every launch when two installs coexist.

## Background (what the code actually does)

Establishes the facts the fix relies on; verified by tracing, not assumed.

- **Worker env carries an absolute, unambiguous route.** The local cmd controller mints the
  worker's JWT with `SockName = wavebase.GetDomainSocketName()`, an **absolute** path
  (`WAVETERM_DATA_HOME/waveterm.sock`), plus `BlockId = bc.BlockId`, and injects the signed
  JWT into the worker's env (`pkg/blockcontroller/shellcontroller.go:495-506`). Data homes are
  per-install (dev = `waveterm-dev`), so each worker's JWT points unambiguously at the wavesrv
  that spawned it.
- **The hook routes by that JWT, not by its own binary.** `agent-hook` reads
  `WAVETERM_BLOCKID` + the JWT from env (inherited from the Claude process, which Claude passes
  to hook subprocesses), then connects via `setupRpcClient(nil, jwt)` →
  `ExtractUnverifiedSocketName(jwt)` → `SetupDomainSocketRpcClient(sockName, …)`
  (`cmd/wsh/cmd/wshcmd-agenthook.go:294-304`, `cmd/wsh/cmd/wshcmd-root.go:153-164`). Because
  the socket path is absolute and embedded in the JWT, **whichever `wsh` binary runs the hook
  reaches the correct wavesrv** — as long as the worker env was inherited intact.
- **The exit signal is already observed.** The cmd process wait-loop's `defer` flips
  `ProcStatus → Status_Done` on exit/kill/crash (`shellcontroller.go:591-598`), and the loop
  already dispatches `go checkCloseOnExit(bc.BlockId, exitCode)` in a fresh context. This is the
  deterministic seam for an idle-on-exit emit.
- **The owning tab is resolvable from a block id.** `wstore.DBFindTabForBlockId(ctx, blockId)`
  returns the tab; its meta carries `session:agent` (set by both `SpawnClaudeWorker` and the
  frontend `launchAgent`).

**Conclusion:** cross-install status routing is correct by construction. The genuine defects
are the missing `idle` (Part 1), the hook's silent failure (Part 2a), and the install churn
(Part 2c). Part 2b exists to falsify the "routing works" conclusion with a live test before we
declare it fixed — not to presume a routing bug that the code does not exhibit.

## Goals

- Run-worker coarse lifecycle (working → idle) is fully backend-owned, independent of the
  external reporter hook. The hook becomes pure enrichment (model, title, per-tool detail).
- Hook failures are diagnosable: a single opt-in log tells you which branch a hook took and the
  socket/route it resolved.
- Coexisting installs stop overwriting each other's `~/.claude/settings.json` hook config on
  every launch.
- A live cross-install run confirms (or refutes) that a manually-launched agent from a
  non-owning install still reports status correctly.

## Non-goals

- **No new terminal `agent:status` state.** Exit emits the existing `idle`, reusing the
  frontend's turn-ended handling; no distinct "done"/"exited" state, which would need FE work.
- **No wire-protocol / object-model change.** No new `agent:status` fields, no `waveobj` type
  change, so no `task generate` and no DB migration.
- **No change to non-agent block behavior.** Plain shells and cmd blocks that were never agent
  sessions emit nothing new.
- **No redesign of the reporter hook or JWT scheme.** The hook stays as-is except for
  diagnostics; routing is not re-architected (the trace shows it is sound).
- **No run-inspector / observability UI.** Out of scope (a separate deferred idea).

## Architecture

### Part 1 — Deterministic idle-on-exit (backend backstop)

When an **agent-session** block's cmd process exits, publish a retained
`agent:status = idle` for that block, mirroring the `working` emitted at spawn.

- **Emit site:** the cmd process wait-loop in `shellcontroller.go`. Add the emit alongside the
  existing `go checkCloseOnExit(...)` dispatch (~`shellcontroller.go:619`), in its own goroutine
  with a fresh timeout context, so it never blocks teardown and matches the existing async-on-exit
  pattern. Using the wait-loop (not `Stop()`) guarantees it fires on graceful exit, kill, and
  crash alike.
- **Scope guard:** emit only when the block is an agent session. Resolve the tab via
  `wstore.DBFindTabForBlockId(ctx, blockId)` and require its meta `session:agent` to be set.
  Without the guard, every plain-terminal exit would publish a status and the frontend would
  promote a plain shell to an idle "agent" in the roster (truthy `state`).
- **Payload:** a retained (`Persist:1`) `agent:status` with `State = idle`, `Agent` read from
  the resolved tab meta `session:agent` (so codex vs. claude is preserved), block oref scope,
  and `Ts = now`. Reuse the event shape currently inlined in `initialWorkerStatusEvent`.
- **Shared helper:** extract a single constructor used by both spawn and exit so the two events
  stay consistent. `initialWorkerStatusEvent` (`pkg/jarvis/runexec.go`) becomes a caller of it.
  Placement: since the exit emit lives in `pkg/blockcontroller` and the spawn emit in
  `pkg/jarvis`, the helper belongs in a package both already import — `pkg/baseds` (which defines
  `AgentStatusData` and the state constants) is the natural home for a
  `baseds.AgentStatusEvent(blockOref, state, agent, ts)` returning the `wps.WaveEvent`. If
  `pkg/baseds` must stay free of a `pkg/wps` dependency, keep the helper in `pkg/blockcontroller`
  and have `pkg/jarvis` call it (jarvis already imports blockcontroller). Decide in the plan by
  checking the import graph; do not create a new package for one helper.

**Effect:** working@spawn → idle@exit is a closed backend loop. A finished/killed/crashed worker
can no longer linger as "working," regardless of whether the hook ever fired.

### Part 2 — Hook diagnostics, live verification, churn fix

#### 2a. `agent-hook` observability (certain deliverable)

`agentHookRun` returns `nil` on every failure path silently — no `WAVETERM_BLOCKID`, no JWT,
RPC-setup failure, block-resolve failure, publish failure
(`cmd/wsh/cmd/wshcmd-agenthook.go:279-333`). Nothing distinguishes "not in an Arc block"
(expected no-op) from "couldn't reach wavesrv" (real failure).

- Add opt-in diagnostic logging gated by an env flag (e.g. `WAVETERM_HOOK_DEBUG`). When set,
  append one structured line per invocation to a file **under the resolved data dir** (never
  stdout/stderr — a hook must stay silent to Claude, or it corrupts the turn), recording: event
  name, which early-return branch was taken (or "published"), the resolved socket name, the
  block oref, and any RPC error. When the flag is unset, behavior is byte-for-byte unchanged
  (near-instant no-op preserved).
- The file path is derived independently of the RPC connection (from the JWT's socket path or a
  data-dir env), so logging works even when the RPC connect itself fails — that is precisely the
  case being diagnosed.

#### 2b. Live cross-install reproduction + root-cause fix (contingent deliverable)

With 2a in place, drive the failing scenario and read the log:

1. Ensure a second install is the last writer of `~/.claude/settings.json` hooks (its `wsh`
   path stamped in).
2. Launch a manual (non-run) agent in the app under test; take a normal turn.
3. Read the hook debug log: did the hook run, inherit `WAVETERM_BLOCKID` + JWT, resolve the
   right socket, and publish? Determine the exact break point (env not inherited / resolve
   fail / connect fail / published-but-not-shown).
4. **Fix the real root cause found.** If the log shows the chain completes and status is
   published — i.e. routing works and the earlier "sometimes" was the missing `idle` now fixed
   by Part 1 — record that finding in the acceptance doc and add no speculative routing fix.
   Bounded outcome: fix a confirmed break, or document that none exists.

#### 2c. Stop the install churn (certain deliverable)

`src-tauri/src/main.rs` re-runs `install-agent-hooks` every launch
(`main.rs:166`), last-writer-wins. `install-agent-hooks` unconditionally rewrites the managed
groups with the running install's `os.Executable()` path
(`cmd/wsh/cmd/wshcmd-installhooks.go:238-277`), so two coexisting installs overwrite each
other's config on every launch.

- Make the install a **no-op when the existing config is already healthy**: if every managed
  hook group is present, managed (`isManagedCommand`), **and** its `wsh` exe path exists on
  disk, skip the rewrite (leave the file untouched) and report "already installed." Extend the
  existing `isManagedCommand` check with an exe-exists test; heal (rewrite) only when a managed
  hook is stale (exe missing) or absent. This keeps self-healing on app update while stopping a
  healthy config from being churned by a coexisting install.
- Same treatment for the managed `statusLine` wrapper (`mergeStatusLine`), for consistency.
- No change to `main.rs` unless 2b surfaces a launch-side cause; the fire-and-forget call stays.

## Data flow (run worker, happy path, after fix)

1. `SpawnClaudeWorker` → retained `agent:status = working` (unchanged) → roster shows the worker.
2. Worker runs; hook events (if they arrive) refine detail/model/title — pure enrichment.
3. Worker process exits (complete, killed, or crashed) → wait-loop `defer` sets `ProcStatus =
   Done` → new goroutine resolves the tab, sees `session:agent`, publishes retained
   `agent:status = idle` → roster row goes idle, subagents cleared. No hook required.

## Error handling / edge cases

- **Tab resolve fails on exit** (block already torn down): log and skip the emit — the roster row
  is gone anyway, so a stale `working` cannot persist.
- **Non-agent block exits:** `session:agent` absent → no emit (the guard).
- **Double emit** (hook `Stop` also fires): both are `idle`, retained, last-write-wins; the
  frontend is idempotent on repeated `idle`.
- **Worker killed via Cancel (`CancelRun`):** kills the tab/controller → wait-loop runs →
  idle-on-exit fires. Consistent with normal exit; no separate path.
- **`install-agent-hooks` on a partially-managed config:** heal only the stale/missing groups;
  never touch non-managed hook groups or unrelated keys (existing `mergeAgentHooks` behavior
  preserved).
- **Hook debug flag unset:** no file opened, no perf cost; the silent-no-op contract holds.

## Testing

**Go unit (`pkg/blockcontroller` / `pkg/jarvis` / `pkg/baseds`):**
- The shared status-event helper produces spawn (`working`) and exit (`idle`) events with matching
  shape (retained, correct scope oref, agent preserved).
- Idle-on-exit emits for a block whose tab has `session:agent`; emits nothing for a plain shell
  block (no `session:agent`).

**Go unit (`cmd/wsh`):**
- `install-agent-hooks` skips the rewrite (file bytes unchanged) when all managed hooks are
  present and their exe exists; rewrites when a managed hook's exe is missing or a group is
  absent.
- `agent-hook` with the debug flag set writes one log line recording the branch taken; with the
  flag unset writes nothing and returns nil on every path (existing behavior).

**Live (CDP against the dev app, per CLAUDE.md visual-verification flow):**
- Spawn a run worker, let it finish, confirm the roster row transitions to idle with the reporter
  hook disabled/absent (proves the backend backstop).
- The 2b cross-install reproduction, using the hook debug log as the evidence artifact. Record the
  outcome (routing confirmed working, or the specific break fixed) in
  `docs/agents/runs-pipeline-known-issues.md`.

## Files touched (indicative)

- `pkg/blockcontroller/shellcontroller.go` — idle-on-exit emit in the cmd wait-loop, scoped to
  `session:agent`.
- `pkg/jarvis/runexec.go` — `initialWorkerStatusEvent` calls the shared helper.
- `pkg/baseds/baseds.go` **or** `pkg/blockcontroller` — shared `agent:status` event constructor
  (placement decided by import graph in the plan).
- `cmd/wsh/cmd/wshcmd-agenthook.go` — opt-in diagnostic logging.
- `cmd/wsh/cmd/wshcmd-installhooks.go` — exe-exists guard so a healthy config is not rewritten.
- `docs/agents/runs-pipeline-known-issues.md` — update residual A (fixed) and record the 2b
  finding.
