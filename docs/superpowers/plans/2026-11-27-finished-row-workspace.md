# Finished workers and the Final stage use the workspace pane

**Verify:** `node scripts/verify.mjs ./pkg/waveobj ./pkg/orchestrate`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/waveobj ./pkg/orchestrate`
**Final:** `node scripts/cdp/final-verify.mjs workspace-finished-task workspace-finished-final workspace-finished-changes final-stage final-shots motion-final agent-tree-rail workspace-run`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\finished-row-workspace\project\Main.dc.html

Decisions beyond the design (the goal's seven decisions stand as written):

- **One condition.** `transcriptLook(agentId, rendered)` in `renderedmode.ts` is true for Rendered, an ended id (`isEndedWorkerId`: done worker, ended plan reviewer, ended verifier) or a Final stage id (`isFinalStageId`). It alone picks rail vs pane in `agentsurface.tsx`, the pane shape, and `rendersNow` (which today looks the id up in the roster, where these rows never are). `canRender` is untouched. Why: three call sites drifting is how the rail survived on these rows.
- **Tab kinds.** `{ kind: "task"; runId; taskId }` keyed `task:<runId>:<taskId>`, labelled `Task · <taskId>`; `{ kind: "final"; runId; round: number | null; session?: string }` keyed `final:<runId>`, labelled `Final` (round null = the dag's current round; `session` = the ended verifier's run id, which marks its round "this session"). The picked round is tab sub-state, as a Run tab's view is.
- **Seeding** is a pure `finishedRowTabs(id, lineage)` in `workspacemodel.ts` plus a store call that seeds a row once per session (a module-level set in `workspacestore.ts`) and only into an empty workspace: first tab active, Changes behind it unseen. Closing sticks because the set never forgets.
- **Ended plan reviewer:** no seeded tab (not designed), so it shows its transcript with neither rail nor pane.
- These rows have no rail, so the header's "Show details" menu item is dropped for them, and `d` collapses their pane (it follows `rendersNow`). The rail's branches only these rows reached (the done worker's sealed files, the stage-id-only section) are removed.
- **Verifier prose** is not stored today: a pass's text is only posted as a channel line (`verifier.go`, PostQuiet), a fail's becomes `FinalStage.Detail`, a fast-track end review's is `endreview.text`. Persist it as `FinalStage.VerdictText` (`verdicttext`), set by `applyFinalVerdict` for both verdicts. Rounds recorded before it show a fail's Detail, else say no verdict text was recorded. Why: reading channel messages back would tie the tab to post wording.
- **Event sources, checked:** `task-review-passed` and `task-review-failed` both carry the reviewer's `note`; only failed carries `round`, so a passed card's round is one more than the failed cards before it. `child-ask` carries `question`, `child-answered` carries `answer` (the engine truncates both at MaxAskSummaryLen), paired by `askid`. `task-verify-*` name the batch's oldest tip in `taskid` and the rest in `batch`. `task-told` has no section on any board, so it is not drawn. No section invents earlier rounds: with no events, Review falls back to the TaskNode's one verdict.
- The **Task tab's Changes line** counts the task's own sealed files (its child run's `evidence.files`), as the board's "2 files" beside the Changes tab's "4 files" for the whole merge.
- **Open transcript** in the Final tab only where a target exists: the current round's verifier (live, or its ended id). Earlier rounds' verifiers have no row, so no link.
- **Final-row Changes** read `run.basecommit..dag.final.commit` (the commit Final verified) at the checkout root of the lead run's project, as `runChangesRange` finds it; with no Final commit yet, the lead's own run read. A done worker's read finds the lead run through a new `endedRowRunId(id)` in `runlineage.ts`.
- "round N of M" uses `dag.maxfinalrounds` and drops "of M" when unset.
- **Scenarios:** Task 1 creates three scenario modules on the shared `workspace-run` fixture (the canvas's run), each holding its own steps; Tasks 2, 3 and 4 each extend exactly one of them and layer their own data in it, so only Task 1 edits the fixture and the parallel tasks share no file.

### Task 1: The transcript-look rows get the workspace pane
**Depends on:** none
**Files:** `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/workspacestore.ts`, `frontend/app/view/agents/workspacestore.test.ts`, `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/view/agents/workspacepane.tsx`, `frontend/app/view/agents/workspacetasktab.tsx`, `frontend/app/view/agents/workspacefinaltab.tsx`, `frontend/app/view/agents/endedtranscript.tsx`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/agentdetailsrail.tsx`, `scripts/cdp/workspace-run-fixture.mjs`, `scripts/cdp/scenarios-workspace-finished-task.mjs`, `scripts/cdp/scenarios-workspace-finished-final.mjs`, `scripts/cdp/scenarios-workspace-finished-changes.mjs`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-agent.mjs`, `scripts/cdp/scenarios-final.mjs`, `scripts/cdp/scenarios-motion-final.mjs`

Ended rows and the Final stage row show the workspace pane and never the details rail, whatever the view mode or default. Adds `transcriptLook`, the `task` and `final` tab kinds (with `tabKey`, `tabLabel`), `finishedRowTabs`, the once-per-row seeding, and `workspacetasktab.tsx` (`TaskTab`, `data-workspace-task`) and `workspacefinaltab.tsx` (`FinalTab`, `data-workspace-final`) drawing only their header line, which Tasks 2 and 3 fill; `TabBody` routes both kinds to them as `({ model, agent, tab })`.

Acceptance:
- `transcriptLook` is true for Rendered, any `ended:` id and any `final:` id, false otherwise; `rendersNow` is true for an ended or Final stage id that is not in the roster.
- `finishedRowTabs`: a done worker gives `[task, changes]`; the Final stage id gives `[final (round null), changes]`; an ended verifier gives `[final (its round, session = its run id), changes]`; an ended plan reviewer gives `[]`.
- Seeding opens the first tab active and Changes unseen, only into an empty workspace, and only the first time the row is focused in a session: after closing both tabs, focusing another row and back leaves no pane.
- `EndedTranscript`'s "↑ run" focuses the run's lead and leaves the rail setting unchanged.
- Every CDP step that read the details rail on a Final stage row (`agent-tree-rail`, `final-stage`, `final-shots`, `motion-final`) reads the pane or the Final tab instead, or drops the assertion the center pane already covers; those scenarios pass.
- Scenario `workspace-finished-task`: focusing t-4's ended row shows no details rail and the pane with `Task · t-4` active and Changes unseen; a file link in its transcript opens a File tab beside it; the close-and-return step above; "↑ run" lands on the lead with no rail opened.
- Scenario `workspace-finished-final`: the Final row shows no rail and the pane with Final active and Changes unseen; `d` collapses the pane to its strip; the ended verifier's row opens its Final tab; an ended plan reviewer's row shows neither rail nor pane.
- Scenario `workspace-finished-changes`: on t-4's row, clicking the Changes tab shows the Changes tab body.

### Task 2: Task tab
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/workspacetasktab.tsx`, `frontend/app/view/agents/workspacetaskmodel.ts`, `frontend/app/view/agents/workspacetaskmodel.test.ts`, `scripts/cdp/scenarios-workspace-finished-task.mjs`

The Task tab as board Main draws it, from the lead's lineage, the child run, the run's digest, usage and events.

Acceptance:
- Header: the task label, its state word ("Merged" for a merged done task), and a meta line of id, attempts, run time, model, tokens, estimated cost and the short merge commit (`endcommit`), each part left out when unknown.
- Brief: the plan's task description as markdown, then "waits on <deps> · then <dependents>", each half left out when empty.
- Asked the lead: one question + answer pair per `child-ask` of the task, paired by `askid`, with the answer's time; an unanswered ask says so; the section is absent when the task asked nothing.
- Review: one card per round, newest first, "Round N · passed|sent back <time>" and the reviewer's note, rounds numbered as the header decision says; with no review events, one card from the TaskNode's verdict and note; absent when neither.
- Verify: the plan's Verify command and the newest `task-verify-*` result that names the task in `taskid` or `batch` (ok with its time, or the failure reason); "no Verify ran at its merge" when none does; absent when the plan has no Verify.
- Changes line: the task's own sealed file count and +/− totals; Open changes activates the Changes tab, reopening it when it was closed.
- Scenario `workspace-finished-task` (board Main): t-4 seeded with 2 attempts, an answered ask, a sent-back round then a passed round, a passed Verify and its evidence shows every section in that order with Round 2 above Round 1; Open changes makes Changes the active tab.

### Task 3: Final tab, and the verifier's verdict kept
**Depends on:** Task 1
**Files:** `pkg/waveobj/wtype.go`, `pkg/orchestrate/final.go`, `pkg/orchestrate/verifier_test.go`, `frontend/types/gotypes.d.ts`, `frontend/app/view/agents/workspacefinaltab.tsx`, `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/finalstagepane.tsx`, `frontend/app/view/agents/finalstagerail.tsx`, `frontend/app/view/jarvis/finalshotsviewer.tsx`, `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/workspacepane.tsx`, `scripts/cdp/scenarios-workspace-finished-final.mjs`, `scripts/cdp/scenarios-final.mjs`, `scripts/cdp/scenarios-motion-final.mjs`

`FinalStage.VerdictText` (`verdicttext`, then `task generate`), and the Final tab of boards Final, Final-Failed and Verifier over `dag.final` and `dag.pastfinals`. The center `FinalStagePane` keeps its steps and loses its Screenshots link; `FinalStageRail` stays for a live verifier in Terminal.

Acceptance:
- A pass verdict's text and a fail verdict's text are both on the stage's `verdicttext`, and a round's text is still there once it moves to `pastfinals`.
- Header: "Final verification", the shown round's state with its dot, a Round switch over every round (absent with one round), defaulting to the tab's round (the current one when null), the pick kept on the tab; a meta line "round N of M · time · start", "of M" only with `maxfinalrounds`.
- Sections: Verified (Commit, Tree, Reviewers as `FinalStageRail` draws them); Why it failed for a failed round only (its detail, and on the current round the lead line from `finalFailedNote`); Verifier (verdict text per the header decision, "did not run" when its step did not run, a meta of model, time and unverified count, Open transcript per the header decision); Screenshots grouped by scenario, failed scenarios first, one thumbnail per step file with its step name, the failed step outlined, `emptyRoundText` for a round without shots, a click opening `FinalShotsViewer` on that round, scenario and step; a Changes line whose Open changes activates the Changes tab.
- Order: a failed round leads with Why it failed; the tab an ended verifier opened leads with its round's Verifier, marked "this session"; otherwise Verified, Verifier, Screenshots, Changes.
- The Final tab shows the waiting dot while its run's current round failed and the run holds an ask owned by the user, and none otherwise.
- The center pane has no Screenshots link; `final-shots` and `motion-final` open the viewer from the Final tab and pass.
- Scenario `workspace-finished-final`: board Final (two rounds, round 2 passed: switching to Round 1 shows Why it failed and "did not run"); board Final-Failed (a round failed at Final with a lead asking: Why it failed first, the failed step outlined, the waiting dot, a thumbnail click opens the viewer on that step); board Verifier (the ended verifier's row: Verifier first, marked this session).

### Task 4: Changes from the merge commit, and the run's verified changes
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/railstore.ts`, `frontend/app/view/agents/railstore.test.ts`, `frontend/app/view/agents/railgit.ts`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/workspacechangestab.tsx`, `frontend/app/view/agents/workspacechangesmodel.ts`, `frontend/app/view/agents/workspacechangesmodel.test.ts`, `frontend/app/view/agents/agentdiffnav.ts`, `frontend/app/view/agents/agentdiffnav.test.ts`, `scripts/cdp/scenarios-workspace-finished-changes.mjs`

A read path beside `readOwnChanges`/`readRunChanges` in `railstore.ts` for these rows, drawn by the existing Changes tab (boards Main, Worker-Fallback and Final's Changes). `RailGitState` gains `merge?: { commit: string; own: string[]; also: { id: string; label: string }[]; gone: boolean }` and `verified?: { commit: string; round: number }`.

Acceptance:
- `endedRowRunId("ended:<run>:<rest>")` returns the lead run id; anything else, undefined.
- A done worker's row lists `endcommit^..endcommit` read at the lead run's checkout root, with diffs; its own files (its child run's `evidence.files`) first, then "Also in this merge · <id> <label>" for each other task whose child run has the same `endcommit`, and a line naming the merge commit and the lane's task ids.
- When that commit does not resolve or the child run has no `endcommit`, the tab lists the sealed files with their counts and no diffs or patch read, and says why (board Worker-Fallback).
- The Final stage row and an ended verifier list `basecommit..dag.final.commit` at the checkout root with the line "The run's changes at <short>, the commit round N verified."; with no Final commit, the lead's run read.
- Open on Diff opens the Diff surface on the same range; a new Final round's commit reloads the list.
- Scenario `workspace-finished-changes` (a temp git repo with one squash commit holding t-1's and t-4's files): t-4's Changes shows its two files first, then t-1's under Also in this merge, a diff opening on click; with t-4's `endcommit` pointed at a missing sha, the fallback list and its reason; the Final row's Changes shows the run's files and the verified-commit line.
