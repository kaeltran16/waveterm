# CDP report: a multi-line step detail stays under its step (fix round)

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs final-stage`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\final-pane-transcript\project

Round 2's end review found that the Tests card keeps only the first line of a multi-line CDP step detail.
`scripts/cdp/report.mjs` `formatResults` indents a detail eight spaces once, as one pushed string, so the lines after
a newline in `st.detail` (an error message with a stack, a scenario's multi-line note) start at column 0, and
`parseFinalVerify` in `testoutput.ts` ends the failure's message there.

Decision: **fix the format, not the parser.** `formatResults` indents every line of a step's detail by
the same eight spaces, so the printed report reads as one block
under its step for a human too. The parser already joins consecutive eight-space lines into the message, so it does
not change. Nothing else parses these lines: the engine keeps the output as text, and `finalshotsmodel.ts` reads the
screenshots manifest, not this report.

### Task 1: formatResults indents every line of a step detail
**Depends on:** none
**Files:** `scripts/cdp/report.mjs`, `scripts/cdp/report.test.mjs`, `frontend/app/view/agents/testoutput.test.ts`

**What to build:** a FAIL step whose detail has several lines prints each of them indented eight spaces under the
step, and the Tests card's failure message for it holds every line.
(A scenario `ERROR:` stays as is: its message is one line in practice and the card shows it whole.) Single-line details print exactly as now.

**Acceptance:**
- `formatResults` table/tests in `report.test.mjs`: a step with a two-line detail yields both lines prefixed with
  eight spaces; a one-line detail's output is unchanged.
- `testoutput.test.ts` `parseTestOutput final-verify`: output from `formatResults` (imported, not copied text) for a
  FAIL step with a two-line detail gives one failure whose message has both lines, and counts unchanged.
- No scenario step: the change is in text formatting a unit test reaches, and final-stage B5 already shows the card
  from `FST_FINAL_KEPT`, which `formatResults` builds.
