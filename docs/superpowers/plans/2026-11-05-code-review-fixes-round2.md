# Code surface review fixes, round 2: code-editor steps that race Monaco

> **For agentic workers:** one task. The parent plan is `docs/superpowers/plans/2026-11-05-code-review-fixes.md`
> and the spec `docs/superpowers/specs/2026-11-05-code-review-fixes-design.md`. Round 2's Final output
> (shots.json, screenshots, logs) is in
> `C:\Users\kael02\AppData\Local\dev.arc.app\data\final-shots\dc40b934-46a3-4251-a584-192387c36c2c\2`.

**Goal:** Make the run's Final pass: 144 of 146 steps passed in round 2, and the two failures are both in
`code-editor`. The same steps passed in round 1 on the same feature code.

**Architecture:** Scenario timing only. Both failures, and a third flake the round-1 worker saw, measure Monaco
before it has acted on the input the scenario just sent.

**Tech Stack:** the CDP harness in `scripts/cdp/`, Monaco.

**Spec:** `docs/superpowers/specs/2026-11-05-code-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/gitinfo`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs code-session code-jumps code-toolbar code-keys code-handoff code-changed code-blame-draft code-diff-states code-editor code-peek code-diff code-blame code-review code-markdown code-stale-bar code-plain-dir code-git-status code-tree-on-arrival`

## Global Constraints

- A snapshot dev app on :9222 / :5174 belongs to another review: never attach to it or stop it. Check with
  `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario...>`, which starts its own app on a fresh
  store with its own ports.
- Never weaken an assertion: each step still proves what it proves today. The fix is in how the scenario sends
  input and waits, not in what it accepts.

---

### Task 1: code-editor waits for Monaco before it measures
**Depends on:** none
**Files:** `scripts/cdp/scenarios-code-editor.mjs`

Failing in round 2:
- `code-editor: the context menu lists Add review comment and it opens the comment input`:
  `{"listed":true,"item":{"x":609.35,"y":242},"shown":false,"label":null}`. The shot `code-editor-context-comment.png`
  shows the menu still open with "Add review comment" highlighted, so the click reached the item but Monaco never
  ran it. The scenario's `mouse()` sends `mousePressed` and `mouseReleased` at the point with no `mouseMoved`
  first, immediately after the menu appeared. Monaco's menu acts on a mouseup over an item it has registered as
  hovered/focused, so the click sometimes lands before the item is ready.
- `code-editor: with the input open, the commented line's next line sits below the input`: `null`. It follows from
  the first, since no input opened.

Also reported by round 1's Task 3 worker as flaky (1 of 2 runs, `gap 46`), and passing in round 2:
`Escape closes the input and its gap`. It measures as soon as the input is gone, before Monaco has removed the view
zone (`codeviewer.tsx` effect cleanup calls `removeZone`).

Fix:
- Click a context-menu item the way a pointer does: `mouseMoved` onto the item, wait until the item shows as
  focused/hovered (or a short settle), then press and release. If the input still has not appeared, repeat the
  click once and record `retried: true` in the detail. The step still requires the menu item, and nothing else, to
  open the input labelled `Comment on line 5`.
- Before the gap assertion, wait (`polishWaitFor`, bounded at 3 s) for the gap between the commented line and the
  next to close, then assert `Math.abs(gap) < 1` as today.

Acceptance: `code-editor` passes every step in 3 consecutive fresh-store runs of `ARC_FINAL_OUT=<tmp>
node scripts/cdp/final-verify.mjs code-diff-states code-editor` (the Final order around it); state the three
results in the report.
