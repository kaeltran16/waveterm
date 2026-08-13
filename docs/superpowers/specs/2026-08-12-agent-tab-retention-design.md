# Agent Tab Retention — Auto-Close Design

Date: 2026-08-12
Status: Approved (brainstorming, 2026-08-12)

## Problem

Agent-session tabs accumulate unbounded. Every agent run launched through WaveTerm
creates a tab (`claude` ×136, `pi` ×23, `codex` ×18, `opencode` ×5 observed in a
single workspace), and nothing ever removes them after the agent exits:

- `checkCloseOnExit` (`pkg/blockcontroller/shellcontroller.go`) only deletes a block
  when the opt-in `cmd:closeonexit` meta flag is set (and exit code == 0, unless
  `cmd:closeonexitforce`).
- No launcher sets `cmd:closeonexit` (pi extension `waveterm-tools.ts`, jarvis
  `runexec.go`, cockpit launch paths all omit it).
- There is no retention/GC for idle agent tabs. The only cleanup, `CleanupOrphanedBlocks`,
  removes blocks whose *tab* is already gone — it does not apply here.

Cost of accumulation: 187 tabs ≈ 187 blocks, 752k persisted terminal events,
~65 MB WAL / 170 MB DB, constant WOS propagation across all blocks, and a busy
renderer. This was the measured cause of system-wide 100% CPU and pi lag.

## Goals

1. Agent-session tabs close automatically when the agent process exits.
2. No session data is lost: run records (`db_run` + evidence), transcript files, and
   the `agent:transcriptpath` stamp all persist independently of the tab.
3. Manual terminals and non-agent blocks keep their existing behavior exactly.
4. Users can still opt out per-block when they want to keep a session in place.

## Non-goals

- No retention sweep / GC goroutine. Once exit-triggered close exists, the window for
  stragglers is tiny; add a sweep only if evidence shows accumulation returns.
- No UI affordance for the opt-out flag (meta key only, documented below).
- No change to `cmd:closeonexit` semantics for non-agent blocks.
- No codegen changes (new meta key is freeform in `MetaMapType`; no `wtypemeta` field,
  no `task generate`).

## Design

### 1. Behavior

- A block whose **tab** carries `session:agent` meta (claude / pi / codex / opencode / …)
  closes automatically **2 seconds** after the agent process exits, **regardless of exit
  code** (interrupts and crashes close too — those are exactly the tabs that would
  otherwise keep accumulating).
- **Opt-out:** `cmd:keeponexit: true` on the block keeps it after exit.
- **Non-agent blocks:** unchanged — existing `cmd:closeonexit` opt-in semantics.
  `cmd:closeonexitforce` still forces close for any block.
- Grace duration: the existing `cmd:closeonexitdelay` (default 2000 ms).

### 2. Implementation — `pkg/blockcontroller/shellcontroller.go`

- Extend the decision in `checkCloseOnExit`:
  - Agent block → close unless `cmd:keeponexit` (any exit code).
  - Non-agent block → today's logic (`closeonexit` opt-in, `closeonexitforce` override).
- `checkCloseOnExit` currently reads only block meta; it will look up the tab via the
  existing `DBFindTabForBlockId` + `DBMustGet[*waveobj.Tab]` pattern (already used by
  `emitAgentIdleOnExit`) to read `session:agent`. If the tab is already gone, return
  (nothing to close).
- Extract a **pure decision helper**, e.g.
  `agentShouldCloseOnExit(blockMeta, tabMeta, exitCode) bool`, mirroring the
  `idleOnExitEvent` style (pure, no I/O) so it is unit-testable.
- New constant `MetaKey_CmdKeepOnExit = "cmd:keeponexit"` in `pkg/waveobj/metaconsts.go`.
  No typed `wtypemeta` field and no `task generate` — `MetaMapType` keys are freeform
  strings; `GetBool("cmd:keeponexit", false)` reads it.

### 3. Roster / status interaction

- On exit, the existing flow already fires in the right order:
  `emitAgentIdleOnExit` publishes the idle event immediately (roster shows the row idle
  for the 2 s grace), then the block+tab delete removes the row. `DeleteBlock` recursive
  already deletes the now-empty parent tab (`wcore/block.go`).
- No race with jarvis's `AgentOutcomeHook`/`OnWorkerExit`: it reads the block's
  transcript stamp synchronously at exit, well before the 2 s-delayed close.
- Review surface after close: Runs/Channels view (db_run evidence), transcript files
  (`~/.claude/projects/…`, `~/.pi/agent/sessions/…`), and `claude --resume <id>`.

### 4. Testing

- Unit tests on `agentShouldCloseOnExit` (in `pkg/blockcontroller/shellcontroller_test.go`,
  matching the existing `idleOnExitEvent` tests):
  - agent + exit 0 → close
  - agent + nonzero exit → close
  - agent + `cmd:keeponexit` → keep
  - agent + `closeonexitforce` → close even with keeponexit
  - non-agent + no flags → no close
  - non-agent + `closeonexit` + exit 0 → close (unchanged)
  - non-agent + `closeonexit` + nonzero → no close (unchanged)
- Dev-app verification: launch a short agent session in a block, confirm the tab closes
  ~2 s after exit; confirm a manual terminal is unaffected.

## Out of scope / follow-ups

- Backfilling history: existing idle agent tabs are not auto-removed by this change
  (one-time cleanup was done manually on 2026-08-12).
- `cmd:keeponexit` documentation for launchers (pi extension / orchestrator) can set it
  when a session should stay visible.
