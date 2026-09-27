# Orchestrator: close R15, R16 and F16 — design

Closes the three remaining small orchestrator items in `docs/orchestrator-redesign-flaws.md`.
They are independent.

## What changed since the tracker was written

Two of the three named targets are gone:

- **R15 (F19)** named `waitDecision` in `cmd/wsh/cmd/wshcmd-jarvisdag.go`. It was deleted with
  `wsh jarvis dag wait` in `2ce4161b4`, when the engine began waking the lead by typing a `wake:`
  line into its terminal. One consumer still invents a status for a terminal step:
  `nextStepText` (`frontend/app/view/orchestrate/dagdigest.ts:141`) renders
  `finished (${next.terminalstatus ?? "done"})`.
- **R16 (F20)** named `buildEngineOrchestratePrompt` in `pkg/jarvis`. It was replaced by
  `OrchestrationRules` (`pkg/jarvis/leadprompt.go`) in `117b42724`. The current prompt never
  writes `merge-ready` or `resolve-merge`, because the engine merges by itself. The lead only runs
  `wsh jarvis dag merge <task> --continue` after it fixes a conflict or a failed Verify, and a
  wake names each such event. `leadprompt_test.go:53` already fails if `resolve-merge` reappears
  in the launch prompt.

## Decisions

1. **R15: harden the surviving site.** `nextStepText` renders a terminal step with an empty
   `terminalstatus` as a contract error, `finished with no status (digest contract error)`,
   instead of `done`. `buildNext` (`pkg/orchestrate/digest.go`) only returns `terminal` from its
   step 6, with `TerminalStatus: g.Status` for a `done` or `cancelled` DAG, so this is a guard,
   not a live defect. The Go side gets a test that pins both terminal statuses. The existing
   `TestNextTerminal` covers `done` only, so a `cancelled` case is added.
2. **R16: close as obsolete, no code.** No prompt reads the digest's words, so a shared constant
   would have one reader: the digest itself. `jarvis` also cannot import `orchestrate`
   (`orchestrate` imports `jarvis`). The tracker records the evidence: the deleted builder, the
   current prompt, and the existing absence test.
3. **F16: the digest carries the gate's clock; the CLI and the lead card render it.**
   - `wshrpc.DagTaskDigest` gains `MergeGateTs int64 \`json:"mergegatets,omitempty"\``. It is the
     UnixMilli the open merge gate's clock started: the retained task-done boundary that
     `staleMergeGates` already reads (`firstTaskEventTs(retained, RunEventKindTaskDone, id, true)`).
     It is set only for a merge-ready lane tip (`mergeReadyTip`). It is 0 for every other task,
     and 0 for a gate whose done event was pruned (no clock).
   - Single source: one helper, `mergeGateClock(g, retained) map[string]int64`, computes the
     clock per merge-ready task. `staleMergeGates` derives staleness from that map, and
     `buildTaskDigest` copies `MergeGateTs` from it. The two cannot disagree on the boundary.
   - The digest carries a timestamp, not a rendered age. This follows the `VerifyStartedTs`
     precedent: the cockpit re-renders between digest loads, and an age baked in at load time
     would stop moving.
   - **CLI** (`wsh jarvis dag status`): `taskSignal` gains a case for a merge-ready task
     (`td.MergeState == "ready"`): `merge waiting 34m` with `compactDur(now - MergeGateTs)`, or
     `merge waiting` with no age when `MergeGateTs == 0`. It ranks below ask, Verify and suspect,
     which a done task never carries.
   - **Lead card** (`frontend/app/view/agents/leadcardmodel.ts`): a `done` task whose digest
     `mergestate` is `ready` is not landed. Today its row reads `landed` and folds away under
     Done. It becomes a live row (`kind: "live"`, tone `wait`). Its tag is `merge waiting 34m`
     (`formatElapsed(now - mergegatets)`), or `merge waiting` with no clock. Its sub is
     `<id> · <lane> · merge ready`. The tag is built by a new pure exported helper,
     `mergeWaitTag(mergeGateTs: number | undefined, now: number): string`, tested in
     `leadcardmodel.test.ts`. The row keeps its ended-worker `openId`. It takes no actions and no
     `needsYou`: the engine owns the merge, and health already escalates a stale gate to
     `needs-you` at card level. No new colors: tone `wait` maps to the existing token-backed dot.
   - Scope: only the lane tip (`mergestate: "ready"`) is the gate. A non-tip done task in an
     unmerged lane (`mergestate: "waiting"`) keeps its current rendering. The orchestrate
     surface's own views are unchanged.

## Testing

- `pkg/orchestrate`: `MergeGateTs` is set from the retained done event on a merge-ready tip. It
  is 0 when the done event is absent, 0 on a merged task, and 0 on a non-tip lane member. The
  existing stale-gate tests keep passing unchanged, which shows the single-source refactor held.
  A `cancelled` DAG yields `terminal` with `TerminalStatus: cancelled`.
- `cmd/wsh/cmd`: `dagStatusLines` shows `merge waiting 34m` for a ready task with a clock, and
  `merge waiting` with no age without one.
- Frontend vitest: `mergeWaitTag` with and without a clock. `buildLeadCard` puts a merge-ready
  done task in `rows` with the tag, not in `done`. A merged done task still reads `landed` in
  `done`. `nextStepText` of a terminal step with no status reads as a contract error.
- `task generate` regenerates `frontend/types/gotypes.d.ts` for the new field. The generated file
  is never hand-edited.

## Docs

`docs/orchestrator-redesign-flaws.md`: R15, R16 and the F16 renderer half are marked resolved,
with the obsolescence evidence for R15 and R16. `docs/open-issues.md`: the F16 row's
"Not done" clause becomes resolved, and the F19/F20 row notes say both halves are closed.
