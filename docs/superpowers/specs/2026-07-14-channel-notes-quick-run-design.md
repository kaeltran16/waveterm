# Channel notes + Quick Run — design

**Date:** 2026-07-14
**Status:** approved (brainstorm), pending implementation plan

Two backend follow-ups deferred out of the 2026-07-13 channels/runs merged-surface plan
(`docs/superpowers/plans/2026-07-13-channels-runs-merged-surface.md`). Both were logged in
`docs/deferred.md` as backend-gated; this spec unblocks them.

## Goal

1. **Channel notes** — turn the disabled "Channel notes — coming soon" placeholder in the Channels
   overview strip into a real, persisted, editable notes field.
2. **Quick Run** — make `@quick` create a real one-phase Run object (its own run-strip tab + `Q` badge
   + Done lifecycle) instead of routing through the ad-hoc dispatch transport.

## Non-goals

- Markdown rendering, per-user attribution, or history for notes. Notes are a single plain-text field.
- Multi-runtime Quick (codex/antigravity). Runs spawn a claude worker (`SpawnClaudeWorker`); this
  matches current `@quick` behavior, which is already always claude (`parseComposerCommand` extracts a
  `runtime` only for `@ask`).
- Any change to the pipeline/orchestrator run modes.

---

## Feature A — Channel notes

Storage decision: **`Channel.Meta["channel:notes"]`**, not a dedicated struct field. This mirrors how
channel tier (`SetChannelTierCommand`) and read state (`SetChannelReadCommand`) already persist, keeps
the `waveobj.Channel` schema untouched, and needs no core-type regen (only the new RPC types).

### Backend (`pkg/`)

- **Constant:** `MetaKey_ChannelNotes = "channel:notes"`, added alongside the other `jarvis.MetaKey_*`
  channel-meta keys.
- **RPC:** `SetChannelNotesCommand(ctx, CommandSetChannelNotesData{ChannelId, Notes})` in
  `wshserver.go`, a direct clone of `SetChannelTierCommand` (`wshserver.go:1626`):
  - validate `ChannelId != ""`;
  - `wstore.DBUpdateFn`: init `ch.Meta` if nil; set `ch.Meta[MetaKey_ChannelNotes] = data.Notes`, or
    **delete the key when `data.Notes == ""`** so cleared notes don't leave dead meta;
  - `wcore.SendWaveObjUpdate(...)` so the FE atom re-renders.
- **Type + registration:** `CommandSetChannelNotesData` in `wshrpctypes.go`; register the command; run
  `task generate` to regenerate `wshclient.go` and `frontend/app/store/wshclientapi.ts`.

### Frontend (`frontend/app/view/agents/channelssurface.tsx`, ~lines 880–892)

- Replace the disabled placeholder `<div>` with a controlled `<textarea>` seeded from
  `active.meta?.["channel:notes"] ?? ""`.
- Persist debounced (~600ms, reusing the surface's existing debounce idiom) via
  `RpcApi.SetChannelNotesCommand({ channelid: active.oid, notes })`.
- Collapsed strip line becomes `Overview & notes` with an empty/filled hint (e.g. a subtle dot or
  count) so a channel with notes is distinguishable when collapsed.
- Re-seed local state when the active channel changes (keyed on `active.oid`), so switching channels
  shows the right notes.

---

## Feature B — Quick Run

A Quick run is a **bare single-phase Run**: one `execute` phase, no plan gate, fresh context, no skill
scaffolding. The worker is prompted to do the goal directly and self-report completion.

### Backend (`pkg/jarvis/run.go`, `runexec.go`, `wshserver.go`)

- **Constant:** `RunMode_Quick = "quick"` in the run-modes block (`run.go:34`).
- **Playbook:** `QuickPlaybook()` returns a single phase:
  `[]waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Pending, FreshCtx: true}}`.
  `Gate` stays false (zero value). `NewRun` promotes phase[0] to `running` as usual.
- **Prompt:** `BuildQuickPrompt(goal, principles string) string` — same shape as `BuildPhasePrompt`
  (principles preamble + the "headless, make reasonable assumptions, only AskUserQuestion when
  genuinely consequential" guidance) **minus the skill directive**, and **ending with**
  `` When the goal is fully accomplished, run `wsh jarvis complete`. `` so the single phase reaches
  Done. (Pipeline execute phases advance via the same self-report path; this is proven-safe.)
- **Prompt routing:** `phasePrompt` (`runexec.go:96`) gains a `RunMode_Quick` branch →
  `BuildQuickPrompt(run.Goal, run.Principles)`.
- **Plan resolution:** `resolveRunPlan` (`wshserver.go:1747`): when the resolved `mode == "quick"`,
  return `(RunMode_Quick, jarvis.QuickPlaybook())`, ignoring `reqPlanGate` (quick has no gate). This
  branch sits before the pipeline fallthrough.
- **Doc comment:** update `CommandCreateRunData.Mode` in `wshrpctypes.go` to
  `// quick | pipeline | orchestrator (empty = resolved profile default)`.

Note: `TriageVerdict_Quick` (`run.go:60`) is unrelated (orchestrator per-phase sizing) and untouched.

### Frontend (`frontend/app/view/agents/channelssurface.tsx`, ~lines 735–759)

- In the Launch-face send handler, add a `cmd.mode === "quick"` branch that mirrors the `@run` branch:
  ```ts
  if (cmd.mode === "quick") {
      fireAndForget(async () => {
          const created = await createRun(active.oid, cmd.body, { mode: "quick" });
          setActiveRunId(created.id);
      });
      return;
  }
  ```
- Only `@ask` keeps the `sendChannelMessage` consult transport. The `@quick` dispatch transport line is
  removed.
- The `Q` badge (`channelssurface.tsx:941`, rendered on `r.mode === "quick"`) lights up automatically
  once the backend produces quick-mode runs — no FE change needed there.

---

## Testing

Per repo convention (CLAUDE.md): pure logic gets unit tests; cockpit React is CDP-verified (no jsdom
render harness).

- **Go (`pkg/jarvis/run_test.go`):**
  - `NewRun` with `RunMode_Quick` + `QuickPlaybook()`: exactly one phase, `State == running`,
    `Gate == false`, `FreshCtx == true`, `Status == planning/executing` per `recomputeStatus`.
  - `resolveRunPlan` with `reqMode == "quick"`: returns quick mode + single-phase playbook, and a
    non-nil `reqPlanGate` does not add a gate.
  - `BuildQuickPrompt`: contains the goal, contains `wsh jarvis complete`, and does **not** contain a
    "Use the ... skill" directive (distinguishing it from `BuildPhasePrompt`).
- **Frontend:** no new pure logic (`parseComposerCommand` already tested). The `@quick`→`createRun`
  redirect and the notes textarea are verified in the live dev app over CDP (`scripts/cdp-shot.mjs`),
  injecting a channel scenario if needed.

## Rollout / verification checklist

1. Backend Go tests green (`go test ./pkg/jarvis/...` with CGO+zig per the SQLite-tests memo).
2. `task generate` run; generated TS/Go clients include `SetChannelNotesCommand`.
3. `tsc` clean (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`).
4. CDP dev-app pass: (a) type notes → collapse/reopen → notes persist; switch channels → correct
   notes. (b) `@quick fix X` → a new run-strip tab appears with a `Q` badge, worker spawns, and on
   `wsh jarvis complete` the run goes Done.
5. Update `docs/deferred.md`: mark both items resolved (and the 4 already-shipped stale entries found
   in the 2026-07-14 scan).
