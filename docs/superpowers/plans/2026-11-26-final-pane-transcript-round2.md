# Final stage pane: End review findings above the box (fix round)

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs final-stage`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\final-pane-transcript\project

Round 1's end review found the pane drops the End review findings when a command and the end review both fail.
`pkg/orchestrate/endreview.go` `applyEndReview` appends a failed end review's findings to an existing Detail:
`Final \`x\` failed (exit 1):\n...\n\n[End review] <findings>`. The failed Final kept output, so `finalDetailAbove`
is false; when that output parses as a Tests card the findings show nowhere, and when it does not (Check, tsc) they
land in that step's red panel error, under the wrong step. The original plan's decision 8 puts an End review failure
above the box.

Decisions:

1. **The detail splits at the `[End review] ` block**, the split `withoutEndReview` already makes (at the start, or
   after `\n\n`). One helper does it for both `withoutEndReview` and the pane, so the boundary lives in one place.
2. **The command part** rides in the failed command step's panel as its error (unchanged rule otherwise: hidden under
   a card, absent while the output loads). It never includes the end-review block.
3. **The above-box block** is the end-review part, prefix included, whenever it exists; plus the whole detail, as
   today, when no failed command step kept output (verifier failed, a human ended the stage, end review alone).
4. **`isTestCommand` moves to `testoutput.ts`** (with `TEST_CMD`), so `finalstage.ts`, a pure model that runlineage
   and workspacestore import, stops pulling `renderregistry.ts` (react, mermaid, ChartCard) in at runtime.
   `renderregistry.ts` imports it from there; its tests move with it.

### Task 1: End review findings draw above the box; the test-command matcher moves to testoutput.ts
**Depends on:** none
**Files:** `frontend/app/view/agents/finalstage.ts`, `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/finalstagepane.tsx`, `frontend/app/view/agents/testoutput.ts`, `frontend/app/view/agents/testoutput.test.ts`, `frontend/app/view/agents/renderregistry.ts`, `frontend/app/view/agents/renderregistry.test.ts`, `scripts/cdp/scenarios-final.mjs`

**What to build:** in a stage where a command failed and kept output and the end review also failed, the pane shows
the End review findings as the red block above the step box, and the failed step's panel error (when it has one)
holds only the command's part of the detail. Every other stage draws as it does now. `finalstage.ts` imports
`isTestCommand` from `testoutput.ts`, and no runtime import of `renderregistry.ts` remains in it.

**Interfaces:**
- `finalDetailAbove(view: FinalStageView): string` replaces the boolean form: the text the pane draws above the box,
  `""` for none. `finalstagepane.tsx` draws `data-final-detail` when it is non-empty.
- `isTestCommand(cmd: string): boolean` is exported from `testoutput.ts`; `renderregistry.ts` no longer exports it.

**Acceptance:**
- The `finalDetailAbove` `it.each` table gains a row: Final failed with kept output and a detail ending in
  `\n\n[End review] <findings>` gives `[End review] <findings>`; the existing rows keep their meaning (verifier and
  human-ended give the whole detail, a command that kept output with no end review gives `""`).
- `finalStepBody` for a failed Check (unparsed output) in that combined stage sets `error` to the command part only,
  with no `[End review]` text in it.
- `isTestCommand` cases pass from `testoutput.test.ts`, and none remain in `renderregistry.test.ts`.
- **final-stage B5c** (new step after B5): B5's stage with `endreview: { state: "failed", text: FST_ER_FINDING }`
  and `\n\n[End review] ${FST_ER_FINDING}` appended to its detail. The Final row still opens as a final-verify card
  with no error, End review reads failed, and `data-final-detail` sits above the box holding `FST_ER_FINDING` and
  none of the Final command's detail.
