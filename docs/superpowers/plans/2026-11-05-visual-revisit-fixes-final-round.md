# Visual revisit fixes: Final round 1 fix plan

**Spec:** `docs/superpowers/specs/2026-11-05-visual-revisit-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/util/keyedmutex`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs diff-states diff-compare code-diff-states code-peek resmon-footer usage-charts agent-header cockpit-card-layout cockpit-roster-counts sessions-list-states sessions-detail-states code-markdown code-toolbar cockpit-launch-stays`

**Goal:** Make Final pass: fix the three failing `resmon-footer` steps (1, 6, 6b), and add the two scenario steps the run's tasks left unmeasured (the leader chip row at 1000x700, the run-member header at 1000x700).

**Architecture:** Two independent tasks with disjoint files. All three failures trace to fcb73f604 (before this run), which put `RemoteReadout` beside `ResMonReadout` inside one wrapper div in both the global footer (`hints-footer.tsx`) and the Cockpit hints bar (`cockpithelp.tsx`). That layout is intended; steps 1 and 6 assert the old DOM shape, and the popover's anchor code reads the wrapper as "the bar".

## Global Constraints

- Existing `@theme` tokens only; no new token.
- A step measures the state (rects, computed style, DOM order) and records pass/fail; a shot alone is not a step. A viewport override set in a step is restored in a `finally`.
- Scope queries to a `data-*` container; never select by window position near the title bar.
- Never attach to or kill the dev app on :9222; live checks run only through Final.

## Review Focus

1. The Resource Manager popover opened with `g m` (no click, so no recorded opener) from the Agent surface's global footer: it must still sit above the footer, not over it (step 3 opens it this way).
2. A Cockpit hints bar with remote mode not configured (`RemoteReadout` renders nothing): steps 6 and 6b must pass with and without the remote chip present.

---

### Task 1: resmon-footer: popover anchor, stale DOM assertions, leader row at 1000
**Depends on:** none
**Files:** `frontend/app/cockpit/resmonpopover.tsx`, `scripts/cdp/scenarios-agent.mjs`

Final evidence (round 1, commit 0fdd8ce): step 1 `{"last":false,"text":"Arc 61% CPU · 7.4 GB"}`, step 6 `{"readout":true,"afterHelp":false,"footer":false}`, step 6b `{"open":true,"bottom":918,"barTop":917}`.

- [ ] **6b (code defect):** `measureAnchor()` in `resmonpopover.tsx` caps the popover's bottom at `readout.parentElement` top, meant as "the bar the readout sits in" (its comment: "never over the bar it sits in"). Since fcb73f604 the parent is the readouts' wrapper, whose top is inside the bar's padding, so the popover overlaps the Cockpit hints bar by a sub-pixel-rounded 1px. Use the bar itself: `readout.closest("[data-hints-footer], [data-cockpit-hints]")`, falling back to `parentElement` when neither matches. Update that comment if it names the parent.
- [ ] **Step 1 (stale assertion):** in the `resmon-footer` scenario, "the readout ends the footer" now means: the footer's last element child contains the readout, and the readout is the last element child of its own parent. Keep the text check. Keep the step's wording.
- [ ] **Step 6 (stale assertion):** "the readout sits in the cockpit hints bar, after ?" now means: the readout is inside `[data-cockpit-hints]`, `[data-cockpit-help]` precedes it in document order (`compareDocumentPosition` & `DOCUMENT_POSITION_FOLLOWING`), and nothing but the remote chip (`RemoteReadout`'s root, which may be absent) sits between the help button and the readout. Keep `!footer`.
- [ ] **Step 6b:** unchanged; it passes once the anchor fix lands. Do not loosen its `bottom <= barTop`.
- [ ] **New step 2a (leader row at 1000x700, t-2 left it unmeasured):** at 1000x700 on the Diff surface (`RESMON_NARROW`, as step 1b uses), press `g` and measure the leader posture's chip row (`[data-footer-chips]`) the way `RESMON_CHIP_FIT` does: every chip lies wholly inside the footer or is dropped whole (on the clipped second line), and the footer's own height stays the 28px bar. Restore the viewport and Escape the leader in a `finally`. Place it so steps 2-5 still start from the Agent surface at 1600x950.

### Task 2: sessions-detail-states: run-member header at 1000x700
**Depends on:** none
**Files:** `scripts/cdp/scenarios-sessions-detail-states.mjs`

t-5 applied the F11 wrap to the run-member header (`sessionsdetail.tsx`, `[data-sessions-member-header]`) without measuring it. Spec F11.

- [ ] **New step:** at 1000x700 (restored in a `finally`), open the existing blocked run member (`open(h, { sel: runSel, member: "t-2", ... })`, as step 3 does) and measure `[data-sessions-member-header]`: the actions (the view toggle and the primary button) sit on a row below the title (their top >= the title's bottom), the title's element is not clipped (`scrollWidth <= clientWidth` or it truncates with an ellipsis rather than wrapping into a column under 200px wide), and no action button's rect leaves the header. Record the header width in the detail. If the member pane at 1000x700 is wider than the 600px threshold, so the actions legitimately stay inline, the step instead asserts they sit inline and do not overlap the title, and the detail says so.
- [ ] Run `sessions-detail-states` only through Final; do not attach to :9222.
