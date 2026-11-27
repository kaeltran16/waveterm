# Finished-row workspace: round 3 fix

Round 2's final stage passed Verify and every scenario step the plan names, and its verifier found two gaps against the
prototype (boards Final, Final-Failed and Verifier in
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\finished-row-workspace\project\Main.dc.html`). Both sit in
the Final tab, so one task takes them.

Decision on the copy (lead, autonomous run): the board's "Did not run: the stage stops at the first failed step." is
what a not-run verifier shows when an earlier step of the round failed, as the board draws it. A stage that ended
without a failed step (a human ended it, or it was cancelled) keeps "Did not run: the stage ended before it.", since
the board's wording would be false there.

### Task 1: The Final tab's Changes line has counts, and a skipped verifier says why as the board does
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacefinaltab.tsx`, `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `scripts/cdp/scenarios-workspace-finished-final.mjs`

**What to build:** On the Final row and on an ended verifier, the Final tab's Changes section reads as boards Final and
Verifier draw it: "Changes", then the file count with its adds and dels ("14 files +912 −58"), then Open changes,
styled as the Task tab's Changes line. The counts come from the same rail read the Changes tab shows for this row
(`railStateAtom`, through `changesLine` in `workspacechangesmodel.ts`, which Task 4 of round 1 made read the verified
range for Final rows); they are left out, with the heading and the button still drawn, until that read has landed for
this row. The Final tab adds no read of its own.

When a round's Verifier step did not run because an earlier step failed, its text is "Did not run: the stage stops at
the first failed step."; when it did not run and no step failed, it keeps "Did not run: the stage ended before it.".

**Acceptance:**
- A `finalTabView` (or the function in `finalstage.ts` that builds the verifier section) case: a round with a failed
  step before a not-run verifier gives the board's text, and a round with no failed step and a not-run verifier gives
  the ended text. The case joins the existing table for that function.
- A new step in `workspace-finished-final` on the Final row reads `[data-final-tab-section="changes"]` and asserts a
  file count with adds and dels once the row's read has landed. The fixture run has no repo of its own, so the step
  gives the row a real range the way `workspace-finished-changes` does (its temp repo and `layerFor`: `projectpath`,
  `basecommit`, `dag.final.commit`), importing or copying that helper rather than seeding `railStateAtom` by hand.
- The `workspace-finished-final` step that shows board Final-Failed reads the Verifier section's board text.
