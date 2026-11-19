# Brainstorm tab polish: Final round 1 fix

Final round 1 on 78637e4 failed 5 of 291 steps; its saved output keeps only the tail, so the failing names are not
all on record. The lead reran the same Final list on 78637e4 (`ARC_FINAL_OUT=<tmp> node scripts/cdp/final-verify.mjs
<the Final list>`): 287/291, the 4 failures all in `brainstorm-mode`:

- 2j "Shift+Enter puts a newline in the answer and sends nothing": `{"value":null,"typed":[],"keys":"set"}`
- 2k "Enter sends the two lines as one line and clears the box": `sent: []`
- 2k2 "a sent answer reads as the agent writing it up": still `asking question 4` with the answer box
- 2k3 "The design behind it: When it pages Being written": the part reads `asked`

2k2 and 2k3 follow from 2k sending nothing. `brainstorm-mode` alone on 78637e4 passes 56/56. Final round 1's
`brainstorm-mode-2-sent` shot shows the same state (question 4, empty answer box), so the same cluster failed there,
plus one step the lead could not identify. t-1 had reported this class (combined runs only, terminal-echo waits,
`brainstorm-mode` globals undefined, `workspace-brainstorm-check` blank after a reload) as passing alone.

What the lead found: `value: null` means `[data-brainstorm-pane] [data-brainstorm-answer]` was absent when 2j ran.
The box was back a few seconds later. 2j runs right after 2i, which sends "brainstorm: skip questions", and
`bsAgentTook` (scenarios-brainstorm.mjs:460), which publishes idle and waits up to `BS_POLL_WAIT_MS` (7 s) for
`BS_NOT_WRITING` but ignores the result. So the pane most likely still read as writing (the sent line not yet
settled by `settleSent`/`lineTaken` in brainstormmodel.ts) when 2j filled the box. Whether that is a slow page under
a long run or a real settle bug (for example the idle event's `ts` against the line's `at`) is not established.

Product call (lead): none needed; the design is unchanged.

### Task 1: Every Final step passes in one combined run
**Depends on:** none
**Files:** `scripts/cdp/scenarios-brainstorm.mjs`, `scripts/cdp/scenarios-shared.mjs`, `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`, `frontend/app/view/agents/brainstormstore.ts`

**What to build:** find why `brainstorm-mode` 2j-2k3 fail when the whole Final list runs in one app and pass alone,
and fix the cause. Start from what the lead found above: confirm whether the pane still shows the writing state after
2i's `bsAgentTook`, and if so whether the sent line fails to settle (an app bug: fix it in brainstormmodel.ts or
brainstormstore.ts with a unit test that fails before the fix) or settles late on a loaded page (a scenario bug:
make the helper wait on the real condition and fail loudly, never pass by sleeping longer). Then run the full Final
list once more and fix any other step that fails, whatever scenario it is in, by the same rule: the cause, not a
retry. A file this needs that is not on the Files line is fine; name it and why in Differs from plan.

**Acceptance:**
- `brainstorm-mode` 2j, 2k, 2k2 and 2k3 pass inside the full Final list run, not only alone
- the full Final list (`ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <the plan's Final list>`) passes
  every step in one run; the report quotes its "N/N steps passed" line
- a settle bug, if that is the cause, has a `settleSent` unit test that fails before the fix
- no step is retried or skipped to pass, and no wait is lengthened without the condition it waits on being checked
