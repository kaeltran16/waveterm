# Sessions tab improvements, fix round 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the last failing final-stage step pass (sessions-search step 5), and open builder-check and judge sessions on their own entry instead of on a run row that does not exist.

**Architecture:** Two fixes; Task 2 waits on Task 1 only because both edit the sessions-search scenario. The search scenario waits for the retried answer itself, not the stale results the list keeps after an error. `sessionSelection` places a session by the same solo rule the list groups by.

**Spec:** `docs/superpowers/specs/2026-10-26-sessions-tab-improvements-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/...`
**Check:** `task check:ts && go vet ./pkg/agentsessions/ ./pkg/wshrpc/... ./cmd/server/`
**Final:** `node scripts/cdp/final-verify.mjs sessions-list sessions-search sessions-find sessions-palette`

## Global Constraints

- Workers have no dev app. The final stage runs the scenarios; a worker proves its change with unit tests, `task check:ts`, and the scenario-load command:
  `node --check scripts/cdp/scenarios-sessions.mjs && node --check scripts/cdp/sessions-search-fixtures.mjs && node -e "import('./scripts/cdp/scenarios.mjs').then(m=>console.log(m.SCENARIOS.filter(s=>s.name.startsWith('sessions-')).map(s=>s.name).join('\n')))"`
  It runs without the app and must list `sessions-list` and `sessions-search`.
- Never run prettier on `scripts/*.mjs` (4-space hand formatting).

## Review Focus

- After Retry, step 5 must read the list only once the real reply has landed, not the results kept from the failed attempt.
- A builder-check or brainstorm-judge session opened from a hit, the palette or the feed lands on its own solo entry with its detail showing.

---

### Task 1: sessions-search step 5 reads the retried answer, not the stale one

**Depends on:** none
**Files:** `scripts/cdp/scenarios-sessions.mjs`

The evidence, from Final round 2: step 5 failed only on `retriedIncomplete: "Results may be incomplete — still indexing"`, with `index: "warm"` confirmed just before. After a failed search, `useSessionSearch` (`frontend/app/view/agents/sessionssearchstore.ts`) keeps the previous state's `results` and `incomplete`, which here came from the step's own `incomplete: true` stub. Retry clears `error` at once and keeps those results while the real call waits on the 250 ms debounce. The scenario's `waitState(s.error == null && cards include solo)` is true immediately on the stale state, so it reads the stubbed "still indexing" line.

**Decision:** the scenario fix only; the store is unchanged. Instead of `RESTORE_SEARCH` before Retry, install a pass-through stub with the existing `stubSearch`: it awaits the real call, sets a page flag (e.g. `window.__sessionsSearchRetried = true`) and returns the real reply unchanged. Wait for that flag, then for the state predicate, which also requires `s.incomplete == null` (the flag is set inside the stub, before the store renders the reply, so the next poll can still read the stubbed state; the assertion already demands `incomplete == null`, so nothing is loosened). Restore the real method after the wait, and keep teardown's restore-if-stubbed guard. The assertion is not loosened.

**Changes:**
- Modify: `scripts/cdp/scenarios-sessions.mjs` (sessions-search step 5 only; Task 2 appends a step 10 to the same scenario, so stay inside step 5)

**Interfaces:**
- Consumes: the existing `stubSearch`, `RESTORE_SEARCH`, `SEARCH_STUB`, `waitState` and `rec` in that file.
- Produces: nothing other tasks use.

- [ ] **Step 1: Replace the restore-then-Retry sequence** with the pass-through stub, the flag wait (bounded by `SEARCH_WAIT_MS`), then the state wait. Add `retriedReal: <flag>` to step 5's detail and to its ok condition, and restore the method after it.
- [ ] **Step 2: Run** the scenario-load command for this module and confirm it lists `sessions-list` and `sessions-search`.
- [ ] **Step 3: Commit** `test(sessions): search step 5 waits for the retried reply`.

Acceptance in Final: sessions-search step 5 passes, its detail showing `retriedReal: true` and `retriedIncomplete: null`.

### Task 2: builder-check and judge sessions open on their own entry

**Depends on:** Task 1
**Files:** `frontend/app/view/agents/sessionsruns.ts`, `frontend/app/view/agents/sessionsruns.test.ts`, `scripts/cdp/sessions-search-fixtures.mjs`, `scripts/cdp/scenarios-sessions.mjs`

Found by t-9 reading the code: `sessionSelection` (`frontend/app/view/agents/sessionsruns.ts`) sends any session with a `runid` to `run:<runid>`. But `isSoloSession` keeps builder-check and brainstorm-judge sessions, which carry a `runid`, as solos, so no run row exists for them. Opening one through `openSessionHit` or the feed selects a run key that resolves to nothing, and the detail falls back to the merged feed. `isSoloSession` is the rule the list groups by, so the selection must follow it.

**Decision:** `sessionSelection` returns `{ sel: sessionKey(s) }` for every session `isSoloSession` holds as solo, and the run placement otherwise. One rule, so the list's grouping and the selection cannot disagree again.

**Changes:**
- Modify: `frontend/app/view/agents/sessionsruns.ts` (`sessionSelection`; widen its `Pick` as needed)
- Test: `frontend/app/view/agents/sessionsruns.test.ts` (append; do not rewrite the file)
- Modify: `scripts/cdp/sessions-search-fixtures.mjs` (a builder-check session and its run)
- Modify: `scripts/cdp/scenarios-sessions.mjs` (sessions-search: append step 10 after step 9; Task 1 already changed step 5)

**Interfaces:**
- Consumes: `isSoloSession`, `sessionKey`, `runSelKey`, `memberOfSession` (existing).
- Produces: `sessionSelection` with an unchanged return shape.

- [ ] **Step 1: Write the failing tests:**
  - `sessionSelection opens a builder-check session on its own entry`: `{ runtime: "claude", id: "b1", runid: "r1", role: "builder-check" }` gives `{ sel: "claude:b1" }` with no member.
  - The same for `role: "brainstorm-judge"`.
  - `sessionSelection keeps a run worker on its run`: `role: "worker", taskid: "t-2"` gives `{ sel: runSelKey("r1"), member: "t-2" }`.
- [ ] **Step 2: Run** `npx vitest run frontend/app/view/agents/sessionsruns.test.ts` and confirm the first two fail.
- [ ] **Step 3: Implement** the change in `sessionSelection`.
- [ ] **Step 4: Run** that vitest file and `npx vitest run frontend/app/view/agents/sessionsfind.test.ts` (both pass), then `task check:ts` (exit 0; give it more than 2 minutes).
- [ ] **Step 5: Seed a builder-check session.** In `sessions-search-fixtures.mjs`, `writeSessionsSearchFixtures` writes a fifth transcript, `check`, whose reply holds a word of its own (a third nonce, `checkWord`, returned with the fixture; not `word`, so steps 1-4's counts are unchanged) exactly once; return `check: { id }` and `checkWord`. `seedSessionsSearchRun` adds a third run in the same channel the way it adds the worker's (`createrun` quick, `deferstart: true`, then `cancelrun`), and after the cancels writes it with `kit.fstWriteRun` as `{ ...r, stagerole: "builder-check", sessionid: fx.check.id }` and no `dagoref`, so `linkSessionsToRuns` (`pkg/wshrpc/wshserver/sessionruns.go`, its `IsBrainstormSession` branch) gives the session that run's `runid` and the role `builder-check`. Store its id on ctx (`checkRunId`); the channel delete in teardown already removes it.
- [ ] **Step 6: Add sessions-search step 10.** After step 9: clear the field, type `fx.checkWord`, wait for the `claude:<check id>` card with a snippet row, click that row, then `waitFind` on `claude:<check id>` at `1 of 1`. Shoot `cdp-shots/sessions-search-10-open-check.png`. `rec` passes only when there is no arrange error, the `[data-session-key="claude:<check id>"]` body renders with the find bar at `1 of 1`, and `inRun` is false (no run row or merged feed in its place); put the card keys and the find state in the detail. Before the fix the selection is `run:<check run id>`, which no row has, so the body is absent and the step fails.
- [ ] **Step 7: Run** the scenario-load command (Global Constraints).
- [ ] **Step 8: Commit** `fix(sessions): one-shot brainstorm sessions open on their own entry`.

Acceptance in Final: sessions-search step 10 passes.
