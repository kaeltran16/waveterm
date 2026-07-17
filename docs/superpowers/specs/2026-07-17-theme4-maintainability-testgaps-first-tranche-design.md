# Theme 4 maintainability and test gaps — first tranche

Date: 2026-07-17
Scope: Theme 4 items #1, #3, and #6 only — run lifecycle tests, cwd-resolution tests, and session terminal-block rule deduplication.
Related: `docs/deferred.md` Theme 4; `docs/superpowers/briefs/2026-07-17-theme4-maintainability-testgaps-brief.md`.

## Problem

Three small but important frontend behaviors lack direct regression coverage:

- Run cancellation and per-worker stopping must maintain their in-flight state even when an RPC fails, and cancellation must never stop live workers without confirmation.
- Agent cwd resolution has a deliberate block → transcript tail → transcript head precedence. The head read is a fallback for Codex session metadata and must not replace the tail's newer cwd.
- Session identity is defined as the first terminal block with a non-empty `cmd:cwd`, but that selection rule is repeated across `sessionsidebarmodel.ts`.

The first two gaps can regress business behavior without a type error. The repeated session rule can drift as the sidebar evolves. This tranche locks down those contracts without changing runtime behavior.

## Scope and sequencing

This tranche implements only the Theme 4 work that is safe before Themes 1–3 land:

1. Add direct tests for `runactions.ts`.
2. Add direct tests for `agentcwdresolve.ts`.
3. Extract and test one pure session terminal-block selector, then route all four existing selection sites through it.

The remaining Theme 4 items stay deferred:

- `pkg/jarvis/watcher.go` tests wait for Theme 3 A1 because that work changes the `agentask.DeliverAnswer` contract being tested. `onexit.go` remains paired with that Jarvis test task.
- `runbody.tsx` and `agentsviewmodel.ts` extractions wait until Themes 1–3 and the coherence-audit passes land, as required by the Theme 4 brief, to avoid high-conflict move-only diffs.

## Design decisions

### Test through existing module boundaries

Use Vitest module mocks for RPC, WOS, modal, and router boundaries, matching existing frontend tests. Do not introduce dependency-injection interfaces or production adapters solely for tests.

Tests use the real exported functions and real jotai atoms from each target module. RPC mocks control pending, resolved, and rejected calls; assertions inspect the atoms while a call is in flight and after its `finally` cleanup.

### Keep the session selector pure

Add `findSessionTermBlock` to `session-models/sessionviewmodel.ts`, the existing pure session-model utility layer. It consumes already-resolved block entries and returns the first block whose metadata has:

- `view === "term"`; and
- a non-empty `cmd:cwd` string.

The return value carries the block id, cwd, and block metadata required by current consumers. It does not read jotai, WOS, or global state.

`sessionsidebarmodel.ts` remains responsible for resolving a tab's block ids through the correct store reader (`get` inside derived atoms or `globalStore.get` in imperative functions). The four call sites then use the shared selector for the identity rule.

The helper belongs in `sessionviewmodel.ts`, rather than the impure sidebar module, so it can be tested without loading RPC, WOS, modal, and workspace-service dependencies.

### Preserve behavior exactly

No production behavior, copy, RPC payload, atom shape, session ordering, or error policy changes. The session selector must retain first-match behavior. The cwd resolver continues returning `null` at its external-error boundary. Run actions continue removing in-flight ids in `finally`.

## Test contracts

### `runactions.test.ts`

Cover the following observable behavior:

- `confirmCancelRun(..., 0)` starts cancellation directly and does not open a modal.
- A positive live-worker count opens `ConfirmModal`, does not cancel before confirmation, and invokes cancellation from `onConfirm`.
- Confirmation copy uses `1 running worker` for one and `<n> running workers` otherwise.
- `stopRunWorker` strips a leading `tab:` only for the in-flight atom key while preserving the original worker oref in the RPC payload.
- `stoppingWorkerIdsAtom` contains the tab id while the RPC is pending and removes it after both resolve and reject paths.
- `cancellingRunIdsAtom` contains the run id while cancellation is pending and removes it after both resolve and reject paths.

Each test resets both atoms and all mocks so the shared `globalStore` cannot leak state between cases.

### `agentcwdresolve.test.ts`

Cover the following precedence and boundary behavior:

- A non-empty block `cmd:cwd` wins and prevents all transcript RPC calls.
- A missing block cwd falls through to the transcript tail.
- A cwd found in the tail wins and prevents the head read.
- A tail miss triggers exactly one head read with `fromstart: true`; its cwd is returned.
- Missing inputs or boundary failures return `null` under the existing error policy.

The test mocks `WOS.loadAndPinWaveObject` and `RpcApi.GetAgentTranscriptCommand`; the pure `agentCwd` parser remains covered by `agentcwd.test.ts`.

### Session terminal-block selector

Add focused cases to `session-models/sessionviewmodel.test.ts`:

- non-terminal blocks are ignored;
- terminal blocks without a non-empty cwd are ignored;
- the first qualifying terminal block is returned with its id, cwd, and metadata;
- no qualifying block returns `undefined`.

After extraction, the following consumers in `sessionsidebarmodel.ts` use the same selector:

- `sessionSidebarViewModelAtom`;
- `sessionCwdsAtom`;
- `findActiveSessionTermBlock`;
- `duplicateSession`'s source-block lookup.

## File touch map

- Create `frontend/app/view/agents/runactions.test.ts` — run cancellation and stop-worker contracts.
- Create `frontend/app/view/agents/agentcwdresolve.test.ts` — cwd orchestration contracts.
- Modify `frontend/app/view/agents/session-models/sessionviewmodel.ts` — pure `findSessionTermBlock` selector and its input/result types if named types improve readability.
- Modify `frontend/app/view/agents/session-models/sessionviewmodel.test.ts` — selector tests.
- Modify `frontend/app/view/agents/session-models/sessionsidebarmodel.ts` — resolve blocks and route the four selection sites through the selector.

No generated files, backend packages, persistence schema, dependencies, or UI components are touched.

## Error handling

- Tests must prove `finally` cleanup rather than changing the current rejection behavior of `stopRunWorker` or `cancelRun`.
- `resolveCwd` retains its `null` fallback when block loading or transcript reads fail.
- The session selector is total over an empty list and nullable block entries; it returns `undefined` when no session terminal exists.

## Verification

Run focused checks first:

```powershell
npx vitest run frontend/app/view/agents/runactions.test.ts frontend/app/view/agents/agentcwdresolve.test.ts frontend/app/view/agents/session-models/sessionviewmodel.test.ts
```

Then run the frontend suite and typecheck:

```powershell
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

No live CDP verification is required because this tranche changes no rendered behavior. The tests must fail if confirmation branching, in-flight cleanup, cwd precedence, or first-terminal selection is violated.

## Non-goals

- No Jarvis watcher or outcome-summary tests in this tranche.
- No `runbody.tsx` or `agentsviewmodel.ts` extraction.
- No behavior changes, UI changes, new abstractions, configuration, dependencies, or generated-code work.
- No cleanup outside the five files listed above.

## Acceptance

- The three target contracts have direct regression coverage.
- All four session identity call sites share one tested selection rule.
- Focused Vitest, full Vitest, and the large-stack TypeScript check pass.
- The diff contains no behavior change and no unrelated refactor.

## Addendum 2026-07-17 — item #2 folded in (supersedes the Jarvis non-goals above)

Theme 3 A1 (atomic ask-claim) landed on main (`dac43d1b`) during execution, satisfying the gate this spec
named for `pkg/jarvis/watcher.go`. Item #2 was therefore added to this tranche, superseding the "No Jarvis
watcher or outcome-summary tests" non-goal. Contract added:

- `askAutoAnswerable(questions)` — the gatekeeper pre-filter (exactly one single-select question is
  auto-answerable; multiple or multi-select escalate). Extracted from `handleAsk`, behavior-preserving.
- `optionIndexInRange(idx, q)` — the delivery bounds guard (an out-of-range classifier index escalates
  rather than injecting a bad selection). Extracted from `handleAsk`, behavior-preserving.
- `outcomeSummary(sess)` — last-event-text vs task, 160-char truncation (already standalone in `onexit.go`).

Tests: `pkg/jarvis/watcher_test.go`, `pkg/jarvis/onexit_test.go`; each mutation-verified. `go test
./pkg/jarvis/` green, `go vet` clean. #4/#5 remain deferred pending the active Theme 2 work.
