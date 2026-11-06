# Live-run states phase 2 fixes, round 1 Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish P12 (one name per run): a worker's header names its lead by the run's plan title, as the card,
the tree's lead row and the lead's own header already do.

**Architecture:** One task. The worker header's "↑ lead" link goes through the existing `leadDisplayName`, the one
helper D12 decides every lead name comes from.

**Tech Stack:** React 19 + jotai, vitest, CDP scenarios.

**Spec:** `docs/superpowers/specs/2026-11-06-live-run-phase2-fixes-design.md` (D12).
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/wshserver ./pkg/orchestrate ./pkg/jarvis ./pkg/agentsessions ./pkg/blockcontroller`
**Check:** `go vet ./pkg/wshrpc/wshserver ./pkg/orchestrate ./pkg/jarvis ./pkg/agentsessions ./pkg/blockcontroller && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-streams lead-card-merge-gate cockpit-roster-counts cockpit-rail-help doc-review agent-tree-rail sessions-list-states final-stage`

## Global Constraints

- **CDP port:** never attach to CDP :9222 and never run `task verify:ui` against the default port. See your
  scenario only in an isolated app: `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.
- **Existing steps:** never lower an existing step's bar. Add a lettered sub-step rather than renumbering.
- **Tokens:** colors come from the `@theme` tokens in `frontend/tailwindsetup.css` only. No new tokens.

## Review Focus

- A worker whose run has no dag yet keeps the lead's tab name on the link (leadDisplayName's no-dag case).
- A worker with no lead in the roster keeps the existing `↑ {run title}` fallback span unchanged.

---

### Task 1: The worker header names its lead by the run title (P12)

**Files:** `frontend/app/view/agents/agentheader.tsx`, `scripts/cdp/scenarios-agent.mjs`

Spec D12. Found at wrap-up: the round-0 work named the lead card header, the tree's lead row and a lead's own
header by `leadDisplayName`, but a worker's (and a stage session's) header subline still shows `↑ {lineage.lead.name}`
(`agentheader.tsx`, the button titled "Go to the lead"), the lead's tab name from the goal. That is the second name
P12 removes.

**Consumes:** `leadDisplayName(agent, run)` from `runlineage.ts` (unchanged). For a worker or stage lineage,
`lineage.run` is the owning run, the same run the fallback span's `lineage.run?.title` already reads.

- [ ] **Implement:** the "Go to the lead" button's text becomes `↑ {leadDisplayName(lineage.lead, lineage.run)}`.
  Nothing else in the header changes; `runlineage.ts` is not edited.
- [ ] **Step, at 1600:** in `agent-tree-rail`, a lettered sub-step after the existing worker steps focuses t-1's
  worker and asserts the header's "Go to the lead" button reads `↑ verify tree-rail` (`TREE_RAIL_TITLE`), not the
  lead's tab name.
- [ ] **Done when:** `npx vitest run frontend/app/view/agents` passes, `task check:ts` is clean, and
  `agent-tree-rail` passes in an isolated app.
