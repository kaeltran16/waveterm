# Transcript renderer, fix round 2: final-stage fix 2

**Effort:** effort:2bd27b27-0403-43cd-a540-ff66edce3b3c
**Spec:** `docs/superpowers/specs/2026-11-17-transcript-renderer-fix-round-2-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/remotemode/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs transcript-base transcript-live transcript-media transcript-boards transcript-arc transcript-initiative narration-feed agent-rendered sessions-detail-states`

The final stage found one more defect against spec #11 ("Any line count left in the UI is singular for 1"): the git
diff card's overflow note in `toolrenderers.tsx` (`DiffCard`) renders `${hidden} more lines in raw`, so a 401-line
diff (cap `DIFF_LINES_SHOWN_MAX = 400`) reads "1 more lines in raw". A sweep of the renderer's other counted labels
found none left: "N edits" is drawn only for two or more merged edits, "Read N images" only for two or more image
reads, and "Show all N lines" only past the clamp.

### Task 1: Singular hidden-line count in the git diff card's overflow note
**Depends on:** none
**Files:** `frontend/app/view/agents/unifieddiff.ts`, `frontend/app/view/agents/unifieddiff.test.ts`, `frontend/app/view/agents/toolrenderers.tsx`

**What to build:** the overflow note under a capped git diff card reads "1 more line in raw" when one line is hidden
and "N more lines in raw" otherwise. The cockpit has no render tests, so the label moves into a pure exported
helper beside `capDiffLines` in `unifieddiff.ts` (`hiddenLinesLabel(hidden: number): string`), which `DiffCard`
renders. No projection change, so `projectors.js` is untouched.

**Acceptance:**
- `hiddenLinesLabel(1)` is "1 more line in raw"; `hiddenLinesLabel(5)` is "5 more lines in raw"
- `capDiffLines` on a 401-line diff with the cap 400 gives `hidden` 1, and its label is "1 more line in raw"
- `DiffCard` draws the note through the helper, still only when `hidden > 0`
