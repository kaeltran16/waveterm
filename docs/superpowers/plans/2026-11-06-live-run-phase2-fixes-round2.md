# Live-run states phase 2 fixes, round 2 Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish P12 (one name per run): the worker rail's Lead row and the lead card's message box name the lead
by the run's plan title, as the card header, the tree's lead row and both agent headers already do.

**Architecture:** One task. Both renders go through the existing `leadDisplayName(agent, run)` in `runlineage.ts`,
the single helper D12 decides every lead name comes from.

**Tech Stack:** React 19 + jotai, CDP scenarios.

**Spec:** `docs/superpowers/specs/2026-11-06-live-run-phase2-fixes-design.md` (D12).
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/wshserver ./pkg/orchestrate ./pkg/jarvis ./pkg/agentsessions ./pkg/blockcontroller`
**Check:** `go vet ./pkg/wshrpc/wshserver ./pkg/orchestrate ./pkg/jarvis ./pkg/agentsessions ./pkg/blockcontroller && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-streams lead-card-merge-gate cockpit-roster-counts cockpit-rail-help doc-review agent-tree-rail sessions-list-states final-stage`

## Global Constraints

- **CDP port:** never attach to CDP :9222 and never run `task verify:ui` against the default port. See your
  scenarios only in an isolated app: `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.
- **Existing steps:** never lower an existing step's bar. Extend a step or add a lettered sub-step; never renumber.
- **Fixtures:** page-only injections, as step 9b already does for t-1's worker tab; the fixture files stay as they
  are. Teardown removes only what the step added.
- **Tokens:** colors come from the `@theme` tokens in `frontend/tailwindsetup.css` only. No new tokens.

## Review Focus

- A lead whose run has no dag keeps its tab name in both places (leadDisplayName's no-dag case).
- The rail's no-lead fallback span (`run.title`) is unchanged.

---

### Task 1: The rail's Lead row and the card's message box use the run title (P12)

**Files:** `frontend/app/view/agents/runrailsections.tsx`, `frontend/app/view/agents/leadcard.tsx`, `scripts/cdp/scenarios-agent.mjs`, `scripts/cdp/scenarios-runs.mjs`

Spec D12. Final round 2 found the worker rail's Task section printing `{lead.name}` in its Lead row
(`runrailsections.tsx`, `TaskSection`, the button that focuses the lead): its shot showed "↑ verify tree-rail" in
the worker header and "Lead ↑ tree-rail lead" in the rail on one screen. The lead card's composer placeholder
(`leadcard.tsx`, the `AgentComposer` placeholder "message <lead.name>…") has the same defect on the card whose header already
reads the plan title.

**Consumes:** `leadDisplayName(agent: Pick<AgentVM, "name">, run: Pick<RunInfo, "title" | "dag"> | undefined): string`
from `./runlineage` (unchanged; `runlineage.ts` is not edited). `TaskSection` always has `run.dag`; the card already
imports the helper and has `run` in scope.

- [ ] **Implement:** the rail's Lead button text becomes `leadDisplayName(lead, run)` (import it from `./runlineage`).
  The card's placeholder becomes `message <leadDisplayName(lead, run)>…`. Nothing else in either file changes.
- [ ] **Step, at 1600, rail:** extend `agent-tree-rail` step 9b (it already focuses t-1's worker at 1600): it also
  asserts the rail's Task section Lead row reads `TREE_RAIL_TITLE` and does not include `TREE_RAIL_LEAD`.
- [ ] **Step, at 1600, card:** in `lead-card-merge-gate`, a sub-step `L25b` after `L25` opens held run D's card
  composer and asserts its placeholder is `message <run D's plan title>…` and does not include the lead's tab
  name. If run D's page-injected lead has no `blockId` (the composer only renders for one), add one in the page
  only, the way 9b adds a tab, and restore it after.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents` passes, `task check:ts` is clean, and
  `agent-tree-rail` and `lead-card-merge-gate` pass in an isolated app.
