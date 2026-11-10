# Motion sweep, Final round 1 fixes Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/wavebase`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs motion-run-sheet motion-dag-peek motion-peeks motion-final motion-brief motion-brief-controls motion-brainstorm motion-lens motion-agent motion-diff motion-code motion-gaps dag-motion jarvis-motion run-sheet-polish dag-peek final-stage final-shots brief-surface brief-peek brief-profile new-run-window brainstorm-mode workflow-scan doc-review agent-composer shell-tasks sessions-list git-history diff-compare settings-storage code-sidebar code-search project-overview`

**Goal:** make the run's Final pass. Round 1's Final passed 484 of 490 steps. The six failures are in three
existing scenarios, each in its own file:

- `jarvis-motion` step 2
- `shell-tasks` steps 2, 2b, 6c and 9
- `final-stage` step B1

Workers on the sweep reproduced the first two on the base (b40931c4e / 58aea87e1). The third does not touch
code the run changed. Each task finds the cause and fixes it in the scenario, or in the app when the app is
wrong. It must not loosen the step until it passes.

**Output dir of the failed Final:**
`C:/Users/kael02/AppData/Local/dev.arc.app/data/final-shots/ee4cd975-1a04-433d-a7f6-7091622e7c4b/1`.
- `shots.json` holds each step's detail.
- `cdp-shots/` holds the screenshots.
- `waveapp.log` holds the isolated app's log.

## Rules for every task

- **Reproduce under the Final command first:** `node scripts/cdp/final-verify.mjs <scenario>`, which uses an
  isolated store. The plain dev app's data hides these failures.
- **A step changes only to match shipped behavior.** Say which commit or spec shows the behavior is intended.
- **When the fix is in app code:** name the file in Differs from plan, and keep the change to the root cause.
- **Done means:**
  - your scenario passes twice in a row under `final-verify.mjs`;
  - the neighbours it shares a store with, in Final order, still pass: run your scenario together with the
    scenario before it in the Final list.

### Task 1: jarvis-motion step 2, the freshness mark on session rows
**Depends on:** none
**Files:** `scripts/cdp/scenarios-brief.mjs`, `frontend/app/view/jarvis/briefrowviews.tsx`

**What fails.** Step 2 ("rows newer than the visit cursor carry the freshness mark") counts `fresh-mark` per
region. Final read:
- initiative: 2 rows, 2 marked
- session: 3 rows, 0 marked
- delta: 2 rows, 0 marked
- shipped: 1 row, 0 marked

The step requires session `marked > 0`. The session rows' `RunRowView` has had no `fresh` prop since the
per-region row split (2b45ab7a4, 168e1db72), so this is stale on the base.

**Decide, from 2b45ab7a4/168e1db72 and any spec or design they cite, whether dropping the mark from session
rows was intended.**
- **If it was intended:** step 2 asserts the regions that still mark, and step 3's cap keeps checking every
  region that can mark.
- **If it was not:** restore the mark on session rows in `briefrowviews.tsx`, through the same `freshKeys`
  path the initiative rows use.

Either way, say which in the report and cite the evidence.

Step 1 ("no channel in this profile") failed in an isolated profile in t-6's lane but passed in this Final.
Leave it unless your reruns show it fail.

### Task 2: shell-tasks, the Agent header pill reads "failed to start"
**Depends on:** none
**Files:** `scripts/cdp/scenarios-cockpit.mjs`

**What fails.** Steps 2, 2b, 6c and 9 read the Agent surface header of the scenario's standing-by fixture
agent. Under Final it reads `pill: "failed to start"` with no accent dot, while the tree row is right.
- `agentStateView` (`frontend/app/view/agents/agentstateview.ts:42`) returns "failed to start" when
  `agent.startError != null`, so in the isolated app the agent the header shows carries a start error.
- t-10 reproduced this on 58aea87e1 (16 of 20 steps pass).

**Find where that `startError` comes from.** Two candidates, among others:
- the header resolving a real block or terminal that fails to start in the isolated store;
- the fixture leaking a start error.

**Fix it where the cause is.**
- If the cause is the scenario's arrange (for example, the isolated store has no start route the fixture
  needs, or a stale block id), fix the arrange.
- If the header or start path is wrong for a mock agent, fix that one file and name it in Differs from plan.
  Keep the change to the root cause.

Rerun `shell-tasks` with `agent-composer`, which runs before it in Final.

### Task 3: final-stage B1, the final node's strip shows one segment
**Depends on:** none
**Files:** `scripts/cdp/scenarios-runs.mjs`

**What fails.** B1 waits through `fstDag` until the final node's meta reads "waits on every task", then
asserts five waiting segments. Final read `strip: ["waiting"]`, one segment.
- `FinalStepStrip` (`frontend/app/view/agents/finalstageviews.tsx`) draws one segment per key.
- The keys come from the run's command group (`frontend/app/view/agents/finalstage.ts`). One segment means
  the group's commands had not loaded when the meta line was already right.
- The run did not change `dagnodes.tsx`, `FinalStepStrip` or `finalstage.ts`. This reads as the scenario
  sampling before the group loads, more likely under Final's load.

**Confirm that from the `b1-waiting-dag` screenshot and a rerun.**
- **If it is a race:** make B1's `fstDag` predicate also wait for the strip to hold five segments, keeping
  the same assertion.
- **If the strip never reaches five:** find why and fix the cause instead.

Rerun `final-stage` with `dag-peek`, which runs before it in Final.
