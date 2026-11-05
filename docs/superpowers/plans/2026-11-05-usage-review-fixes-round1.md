# Usage review fixes, round 1: no held figures on scope cards after a failed switch

**Spec:** `docs/superpowers/specs/2026-11-05-usage-review-fixes-design.md` (F5)
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/... ./pkg/orchestrate ./pkg/usagestats ./pkg/waveobj`
**Check:** `task check:ts && go vet ./pkg/wshrpc/... ./pkg/orchestrate ./pkg/usagestats ./pkg/waveobj`
**Final:** `node scripts/cdp/final-verify.mjs usage-charts usage-work usage-states workflow-scan workflow-scan-entry`

F5 says a failed range switch must not show the held range's usage under the new range's toggle. The detail
already swaps to the switch-failed panel (`data-usage-switch-failed`), but the scope bar above it still shows
the held window's figures: after 7 days → All time fails, the All usage card reads `40K tok · ≈ $0.14` under
"All time" (Final screenshot `usage-switch-failed.png`). This round blanks the range-bound figures on the scope
cards while the view is switch-failed.

### Task 1: Scope cards drop held figures after a failed switch
**Depends on:** none
**Files:** `frontend/app/view/agents/usagesurface.tsx`, `scripts/cdp/scenarios-usage.mjs`
- In `usagesurface.tsx`, while `loadView === "switch-failed"`, every `ScopeCard` in `data-usage-scopes`
  (All usage, the provider cards, the project cards and the initiative cards) shows no figure from the held
  buckets. The tokens and estimate line reads `—` in their place, and a project or initiative card's share
  pill (`pctStr(sharePct)`) reads `—`. Give the line a `title` naming why, e.g. "The all time scan failed".
  What is not range-bound stays as it is: names, dots, a provider's state pill (SAVED, NO READING), its quota
  bars and quota fact, and the card facts. Selecting a card still works. Change `ScopeCard`'s props only as
  far as needed: for example `tokens: number | null`, where `null` renders the dash line. No new tokens or
  colors. The `otherFoldersText` note under By work is held data too: hide it while switch-failed.
- In `scripts/cdp/scenarios-usage.mjs`, extend usage-states step 5 (the failed-switch step, in the
  `switchFailed` read before Retry). Record the All usage card's figures line text and the Claude card's
  (`[data-usage-scopes] [data-usage-harness="all"]` and `="claude"`). Assert that neither contains `tok`
  nor `$`, and that the Claude card still shows its quota rows (`[data-usage-limit]`). After Retry, assert
  the All usage card shows `tok` again. Keep the existing assertions. Keep prettier off this file.
Acceptance: `task check:ts`. The usage-states scenario passes in Final, and its `usage-switch-failed.png`
shows dashes on the cards.
