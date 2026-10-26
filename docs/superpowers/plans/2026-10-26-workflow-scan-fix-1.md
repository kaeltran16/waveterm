# Workflow scan, fix round 1

Final failed every `workflow-scan` step (18/33 passed; `usage-work` and `workflow-scan-entry` passed). Step 0 reports
`{"ok":false,"why":"no __openAddress hook"}`: the hook is installed by `BriefSurface` (`frontend/app/view/jarvis/briefsurface.tsx`,
`linkingdevhooks.ts`), and the scenario's `arrange` calls `openAddressExpr` while the app sits on Usage, so the Brief has not
mounted in that page load. Every later step fails because the lens never opened.

### Task 1: The workflow-scan scenario arranges like workflow-scan-entry

**Depends on:** none

**Files:** `scripts/cdp/scenarios.mjs`, `frontend/app/view/agents/workflowlens.ts`, `frontend/app/view/agents/workflowlensview.tsx`, `frontend/app/view/agents/workflowlens.test.ts`

In `scenarios.mjs`, change the `workflowScan` scenario only. The lens files change only if a step still fails once the lens opens.

Decisions:
- In `workflowScan.arrange`, after `createrun`, call `await polishReload(h)` before the two `openAddressExpr` calls, as
  `workflow-scan-entry` does. It lands on the Brief, which installs `__openAddress`, and it re-primes the channel list,
  which is boot-primed: without it, a channel made by `createchannel` after boot may not be the palette's home project,
  and the header Scan workflow button's enabled checks (steps 1, 7, 9, 10) read `null` or `false`.
- If, with the lens open, a later step still fails, fix the cause in the scenario or the lens code
  (`frontend/app/view/agents/workflowlens.ts`, `workflowlensview.tsx`; a model change keeps `workflowlens.test.ts` passing), never by weakening
  an assertion. Step 6 now runs against Task 3's real `WorkflowScanPicksCommand`: a deferred run has no agent, so the
  expected result is the stored picks, state `applying`, and the inline error `the picks are stored, but the scan's agent is gone`.
- Keep the rule that no step clicks an enabled Scan workflow button.

**Acceptance:** `node scripts/cdp/final-verify.mjs workflow-scan` passes every step (0 to 10, with 3a, 3b, 7a, 7b). Report
the PASS table. If the machine runs out of memory during the build, run it once more; if it still cannot run, say so under
Not verified.
