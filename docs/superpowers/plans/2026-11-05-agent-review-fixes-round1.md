# Agent surface review fixes, Final round 1 Implementation Plan

> **For agentic workers:** one task. It carries its decisions, files and acceptance; you write the implementation.

**Goal:** Make the `agent-header` "quiet 4m" step deterministic; it failed in Final round 1 while 65 of 66 steps
passed.

**Architecture:** The step sets the focused fixture block's last-output stamp 4 minutes back, but focusing a `makeTab`
tab (`view: "term"`, no agent controller) starts a plain shell, and that shell's startup output moves the stamp to
now after the scenario set it. Under Final's load the shell started late, so the pill read "working" (detail:
`"pill":"working","pillWarning":false`). The product rule is right: a working agent whose terminal prints is not
quiet. The fix is in the fixture: wait for the block's output to settle before setting the stamp, and set it again if
the shell still prints. `agent-rail` step 3 and step 7 set the same stamp the same way and passed only by timing, so
they use the same helper.

**Tech Stack:** the CDP harness in `scripts/cdp/`.

**Spec:** `docs/superpowers/specs/2026-11-05-agent-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentsessions`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-streams agent-subagents agent-keys agent-header agent-rail agent-tree agent-start-failed agent-launch-hero cockpit-offgrid cockpit-roster-counts cockpit-card-layout cockpit-rail-help cockpit-launch-stays`

## Global Constraints

- No product code changes: `hungSilenceMs` and the header/rail rendering stay as they are.
- A tab a scenario creates never runs an agent. Keep prettier off `scripts/*.mjs`.
- A snapshot dev app on :9222 / :5174 belongs to another review: never attach to it or stop it. Check with
  `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario>`, which starts its own app on its own ports.

## Review Focus

- A fixture shell that never prints: the settle wait must end at its cap and still set the stamp, not hang.
- A shell that prints after the stamp is set: the step re-sets the stamp and checks again rather than reading the
  first render.

---

### Task 1: Settle the shell's output before setting the quiet stamp

**Files:** `scripts/cdp/agent-page-fixtures.mjs`, `scripts/cdp/scenarios-agent-header.mjs`, `scripts/cdp/scenarios-agent-rail.mjs`

- Add `makeQuiet(h, blockId, minutes)` to `agent-page-fixtures.mjs`, exported beside `focusAgent`. In the page: wait
  until `getLastOutputAtom(blockId)` (from `app/view/agents/agentcontrollerstore.ts`) has not changed for 1.5s,
  capped at 10s total (a shell that never prints ends at the cap); then set it to `now - minutes * 60_000` and
  `agentsModel().structuralNowAtom` to `now`, as the two scenarios do inline today.
- `agent-header` step 3 and `agent-rail`'s quiet setter (`makeQuiet` closure before the Session-line loop, and step
  7) call the helper instead of their inline copies. Each step that waits for the quiet text retries: if the text
  has not appeared within its existing wait, call the helper once more and wait again (at most 3 attempts), so a
  late shell print does not fail the step. The step's detail records the attempt count.
- The step's assertions do not change: "quiet 4m" in the warning color for the header; the rail's expectations as
  they are.

Acceptance: `ARC_FINAL_OUT=<tmp> node scripts/cdp/final-verify.mjs agent-header agent-rail` passes 3 runs in a row;
report each run's attempt counts.
