# Design brief — Theme 4: Maintainability & test-gaps

**Date:** 2026-07-17
**Status:** Design approved (brief) — ready for a downstream agent to write spec + plan and execute
**Source:** Net-new improvement scan, `docs/deferred.md` §"Net-new improvement scan (2026-07-17)" Theme 4
**Handoff:** Resolved design-decision record, not the formal spec. A downstream agent expands it into
`docs/superpowers/specs/` + `docs/superpowers/plans/` and implements it.
**Scope chosen:** all six (3 test-gaps + 3 refactors), sequenced tests-first.

## Problem

Three hot files carry genuine single-responsibility debt that is **actively growing** (runbody.tsx
846→881 and agentsviewmodel.ts 933→1023 lines since the 2026-07-17 scan), and three business-critical
logic modules have no test. This slice adds the tests and performs the extract-moves. **All refactors are
pure module moves with no behavior change; all tests are additions.**

## Test-gaps (do these FIRST — "tests in place before refactoring")

1. **`runactions.ts`** (no `runactions.test.ts`). Run lifecycle — silent regression here either kills
   running agents without confirmation or wedges a button forever. Test the pure logic against a jotai
   store + mocked `RpcApi`: `confirmCancelRun` live-worker-count branch (0 → cancel directly; >0 → confirm)
   and singular/plural copy (`:108-123`); `stopRunWorker`'s `tab:` prefix strip + in-flight `Set`
   add/remove in `finally` (`:42-54`); `cancelRun` in-flight tracking (`:91-102`).
2. **`pkg/jarvis/watcher.go` + `onexit.go`** (the only two untested files in the package). `watcher.go`:
   the Gatekeeper auto-answer-vs-escalate decision — the deterministic pre-filter (`handleAsk:98` —
   `len(Questions)!=1 || MultiSelect` → escalate) and the answer index-bounds guard (`:109`); a regression
   auto-answers something that should reach a human, or delivers an out-of-range option. `onexit.go`:
   `outcomeSummary` (`:67-77`) — last-event-text vs task, 160-char truncation — feeds every channel
   outcome message. **Sequence after Theme 3 (A1)** changes `watcher.go`'s `DeliverAnswer` call, so the
   test targets the final signature.
3. **`agentcwdresolve.ts`** (no test; the pure `agentCwd` parser is tested, the fallback orchestration is
   not). Test `resolveCwd` precedence (`:35-62`): block `cmd:cwd` wins, then transcript tail, then head —
   and that the `fromstart:true` head read fires **only** on a tail miss (`:52-58`) — against mocked
   `RpcApi.GetAgentTranscriptCommand` + `WOS.loadAndPinWaveObject`.

## Tech-debt (extract-only; behavior identical, tests move with the code)

4. **`runbody.tsx` (881).** Peel the card family — `ReviewGateCard`, `AskCard`, `CancelSurvivorsCard`,
   `BlockedCard`, `StartingCard` — into a new `runcards.tsx`, and `PlanPreview` into its own module.
   `RunBody` keeps only the live machinery (transcript streams, liveness clock, entrance guard) +
   composition. No prop/behavior change; imports re-point. **Sequence after test-gap #1** lands.
5. **`agentsviewmodel.ts` (1023).** Extract the pure grid-layout cluster — `GRID_*` consts (`:99-103`),
   `distributeColumns`, `CardRect`, `GridLayout`, `computeGridLayout`, `rowHeightsPx`, `resizeRowWeights`,
   `nextFullWidth`, `normalizeWeights` (`:824-958`) — into `cardgridlayout.ts`, **moving the corresponding
   cases out of `agentsviewmodel.test.ts` into `cardgridlayout.test.ts`**. This cluster references no agent
   semantics, so it lifts cleanly. Do not over-extract other clusters in this pass.
6. **`session-models/sessionsidebarmodel.ts`.** Extract one `findSessionTermBlock(tab)` helper (pure over a
   tab's resolved blocks: first `term` block with `cmd:cwd`) and route all 4 duplicate sites through it
   (`:55,115,206,235`). Add a focused test for the helper.

## Sequencing & conflict guidance (important)

- **Tests before refactors** (project rule). Within this slice: #1 → #4, and #2 after Theme 3.
- The two big-file extract-moves (#4 runbody, #5 agentsviewmodel) touch files that **Themes 1–3 and the
  coherence-audit fix passes also edit**. Run them **after** that feature work has landed (or on a
  dedicated branch rebased last) to avoid merge conflicts. The dedup (#6) and the test additions are
  low-conflict and can go anytime.

## Non-goals

- No behavior change in any refactor (pure moves; a diff that alters output is a bug).
- No touching `settingssurface.tsx` (large but cohesive; its one real divergence is coherence-audit F12).
- No further decomposition of `agentsviewmodel.ts` beyond the grid cluster in this pass.

## Acceptance

- Typecheck clean (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`), `npx vitest run`
  green, `go test ./pkg/jarvis/` green.
- Extracted modules export the same symbols; all consumers compile with only import-path changes.
- Each new test **fails** if its guarded behavior is violated (e.g. flip the cancel branch, break the cwd
  precedence, allow an out-of-range gatekeeper index → red).

## Files in play

Tests: `runactions.test.ts` (new), `pkg/jarvis/watcher_test.go` + `onexit_test.go` (new),
`agentcwdresolve.test.ts` (new). Refactors: `runbody.tsx` → `runcards.tsx` + `planpreview.tsx` (new);
`agentsviewmodel.ts` → `cardgridlayout.ts` (+ `cardgridlayout.test.ts`); `sessionsidebarmodel.ts`
(+ helper test). Consumers re-pointing imports as needed.
