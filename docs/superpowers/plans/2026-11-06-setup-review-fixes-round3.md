# Setup surface review fixes: round 3 (flaky Setup scenario helpers)

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `setup-instructions` and `setup-skills` scenarios wait for the Setup tab button before they click
it, so a slow surface mount no longer fails a step and cascades into the rest.

**Architecture:** One task, scenario code only. Each scenario's fresh-start helper waits for its tab button with the
existing `polishWaitFor`, as `setup-memory` already waits after `h.goto("setup")`.

**Tech Stack:** CDP scenarios (Node).

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `docs/superpowers/specs/2026-11-06-setup-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentsync ./pkg/memhygiene ./pkg/wshrpc/wshserver`
**Check:** `go vet ./pkg/agentsync ./pkg/memhygiene ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs setup-instructions setup-skills setup-memory`

## Global Constraints

- **Never attach to CDP :9222 and never run `task verify:ui` against the default port.** Run scenarios only in an
  isolated app: `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.
- Never lower an existing step's bar and never renumber steps.

---

### Task 1: Setup scenario helpers wait for the tab button
**Depends on:** none
**Files:** `scripts/cdp/scenarios-setup-instructions.mjs`, `scripts/cdp/scenarios-setup-skills.mjs`

Seen in round 2: in a combined `setup-instructions setup-skills` run, step 4's second `freshSetup` failed with
"nothing to click at #setup-tab-instructions". Steps 4b-8b then failed in a cascade (interception missing, teardown
failed). `freshSetup` (`scenarios-setup-instructions.mjs`) and `freshSkills` (`scenarios-setup-skills.mjs`) call
`clickSel` on the tab button right after `h.goto("setup")`, with no wait for the button to render.

- [ ] In both helpers, after `h.goto("setup")`, wait up to 10000 ms with `polishWaitFor` (`scenarios-shared.mjs`)
  until the tab button (`#setup-tab-instructions` / `#setup-tab-skills`) exists. If it never appears, throw an error
  naming that selector. Then click it.
- [ ] Prove it: `ARC_FINAL_OUT=<new temp dir> node scripts/cdp/final-verify.mjs setup-instructions setup-skills`
  passes every step three runs in a row, each with a fresh temp dir. Put the three pass counts in your report.
