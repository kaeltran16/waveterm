# Transcript renderer, fix round 2: final-stage fix 1

**Effort:** effort:2bd27b27-0403-43cd-a540-ff66edce3b3c
**Spec:** `docs/superpowers/specs/2026-11-17-transcript-renderer-fix-round-2-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/remotemode/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs transcript-base transcript-live transcript-media transcript-boards transcript-arc transcript-initiative narration-feed agent-rendered sessions-detail-states`

The final stage found one defect against spec #11 ("Any line count left in the UI is singular for 1"): the Read and
Glob step summary is built as `${n} lines` with no singular, so a Glob that finds one file, or returns "No files
found", reads "1 lines" on its step row. The Pi projection builds its read summary the same way, so it is fixed in
the same task (one rule, both projections).

### Task 1: Singular line count in the Read and Glob step summary
**Depends on:** none
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/pitranscriptprojection.ts`, `frontend/app/view/agents/pitranscriptprojection.test.ts`, `pkg/remotemode/web/static/projectors.js`

**What to build:** the Read/Glob result summary in `transcriptprojection.ts` (today
`` action.summary = `${body.split("\n").length} lines` ``) and the Pi `read` summary in `pitranscriptprojection.ts`
(same expression) read "1 line" for a one-line result and "N lines" otherwise, the way the grep summary beside it
already does for "match"/"matches". Then run `task sync:remoteweb` and commit the regenerated
`pkg/remotemode/web/static/projectors.js` (generated, never hand-edited).

**Acceptance:**
- a Claude transcript whose Glob result is one line (a single path) projects an action with `summary: "1 line"`
- a Claude Glob result of "No files found" projects `summary: "1 line"`
- a multi-line Read result still projects `"N lines"` (the existing "summarizes Grep, Read and Glob" test keeps
  passing)
- a Pi `read` result of one line projects `summary: "1 line"`
- `pkg/remotemode/web/static/projectors.js` matches what `task sync:remoteweb` generates from the edited sources
