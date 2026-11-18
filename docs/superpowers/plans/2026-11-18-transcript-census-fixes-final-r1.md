# Transcript census fixes: Final round 1 fixes

Final on c6ff558 failed 3 of 273 steps. Two causes, one task each, on disjoint files. Inputs are the same as the run's
plan (`docs/superpowers/plans/2026-11-18-transcript-census-fixes.md`): findings at
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\census\findings.md`, specimens at
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\census\out\specimens.json`. Check UI with
`ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario>`.

### Task 1: Change cards keep output another command printed (C3 vs F3)
**Depends on:** none
**Files:** `frontend/app/view/agents/wshcall.ts`, `frontend/app/view/agents/wshcall.test.ts`, `frontend/app/view/agents/wshcards-initiative.tsx`

**What to build:** Final fails `transcript-census-steps` "[rendered|compact] #108 C3: the wsh fallback's output is
boxed, capped at 20 whole lines ..." with `{"failure":true,"box":false}`. Two tasks collided. t-4 (C3) made
`LoadFailure` (recordedoutput.tsx) box and cap a card's recorded output when its record fails to load. t-7 (F3) stopped
the initiative change cards passing `action` to `LoadFailure`, so wsh's own raw output ("addChunk applied to effort
effort:<id>", then an effort show dump) no longer repeats the card. Specimen 108's command is
`cd ... && wsh effort chunk status <id> "<title>" active --note "..." >/dev/null; sed -n 130,246p <file>`: its recorded
output is the `sed` output, not wsh's, and C3 needs it shown.

Lead decision: the output is wsh's own only when every simple command in the call's command line is a wsh call, a `cd`,
or a bare variable assignment (`E=<id> && wsh ...`). Then the change card drops it (F3, specimens 45, 50, 63). When any
other command runs in the line (108's `sed`), the output is that command's, so the change card passes `action` and
`LoadFailure` draws it boxed and capped with Open full view (C3). Decide it in code from the shell tokens wshcall.ts
already produces (`tokenize`), not by matching command names in the card.

**Interfaces:** `export function printsOnlyWsh(command: string | undefined): boolean` in wshcall.ts: true when the
command line runs only wsh calls, `cd` and variable assignments (redirections and the existing command prefixes ignored);
false for an empty or undefined command.

**Acceptance:**
- wshcall.test.ts: `printsOnlyWsh` is true for the commands of specimens 45 (`E=<id> && \` then
  `wsh effort chunk status $E ...`), 50 (`wsh effort chunk note effort:<id> 1 --note "..."`) and 63
  (`E=effort:<id>; wsh effort chunk add $E ... && wsh effort chunk note $E ...`), copied from specimens.json, and false
  for specimen 108's command (`cd ... && wsh ... >/dev/null; sed -n ...`), for `wsh effort list 2>&1 | head -30`, and for
  an empty string.
- In wshcards-initiative.tsx every change card's `LoadError` passes the call to `LoadFailure` exactly when
  `!printsOnlyWsh(actionCommand(action))`; the comment over `LoadError` states the rule.
- `transcript-census-steps` passes at both hosts, the #108 C3 step included, and `transcript-census-wsh` still passes
  its 45/50 step ("change cards whose initiative did not load say what changed and the load error, with no raw wsh
  output or initiative dump") at both hosts. Run both with `ARC_FINAL_OUT=<tmp> node scripts/cdp/final-verify.mjs
  transcript-census-steps transcript-census-wsh`.

### Task 2: transcript-runs attention step fixture draws its time
**Depends on:** none
**Files:** `scripts/cdp/scenarios-transcript-runs.mjs`

**What to build:** Final fails `transcript-runs` "runs attention's collapsed row says nothing waiting before its time,
in secondary" with `"next":""`. This failed on the base too: the fixture's `attentionCall` lasts `durationMs: 200`, and
`StepFacts` (steprows.tsx) draws a step's time only from `STEP_DURATION_MIN_MS` (1000 ms), so no time follows the
summary. The product rule (a sub-second time is noise on the row) stays; the fixture is wrong. Give `attentionCall` a
duration of at least 1000 ms and keep the step's check that the summary's next sibling has text, so it still proves the
summary sits before the time.

**Acceptance:**
- `ARC_FINAL_OUT=<tmp> node scripts/cdp/final-verify.mjs transcript-runs` passes every step, this one included, with
  `next` holding the formatted time.
- No other step in transcript-runs changes its assertions.
