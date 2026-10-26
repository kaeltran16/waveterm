# Sessions tab improvements, fix round 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the final stage's six failing Sessions steps pass: a find opened on another session survives the switch, and the search scenario stops reading the real index's warm-up as a failure.

**Architecture:** Two independent fixes. The find-clear check in `sessionsdetail.tsx` is driven by the selection `openSessionHit` writes, not by the session a detail happens to render. The `sessions-search` scenario waits for the real index to finish warming before it asserts on the incomplete line.

**Spec:** `docs/superpowers/specs/2026-10-26-sessions-tab-improvements-design.md`

## Global Constraints

- Workers have no dev app. The final stage runs the scenarios; a worker proves its change with unit tests, `task check:ts`, and the scenario-load command.
- Never run prettier on `scripts/*.mjs` (4-space hand formatting).
- No new design tokens.

## Review Focus

- A find opened from a hit while another session (solo or run member) is in view must show its bar at the hit, every time.
- Picking another session by hand (a card without a match, a run member row, All activity) still ends the find.

---

### Task 1: A find survives the switch to the session it opens

**Depends on:** none

The evidence, from Final round 1 (`cdp-shots/sessions-search-8-open-worker.png`, `sessions-find-4-worker.png`): every find opened while no session was in view shows its bar (sessions-search step 7, sessions-find steps 1 to 3). Every find opened while another session's detail was in view has no bar and `sessionsFindAtom` reads null: solo to run member (sessions-search 8, sessions-find 4), run to solo (sessions-find 5, sessions-search 9 through the palette). sessions-find 6 fails only because 5 left no bar. The run detail in the step 8 shot shows the right worker's transcript, so selection worked and only the find was lost. The likely cause is `useEndFindElsewhere` (`frontend/app/view/agents/sessionsdetail.tsx:256`): it compares the find with the session the mounted detail renders. During the switch, the outgoing detail (or `RunDetail` with the previous `sessionsMemberAtom`) still renders the old session with `settled` true and clears the new find. Confirm the cause from the code before fixing it, and say in the report what you found.

**Decision:** whether the find has ended is decided from the selection atoms `openSessionHit` writes (`sessionsSelAtom`, and `sessionsMemberAtom` for a run), never from the session a detail renders. Extract the rule as a pure function and test it.

**Files:**
- Modify: `frontend/app/view/agents/sessionsdetail.tsx` (`useEndFindElsewhere` and its two callers)
- Modify: `frontend/app/view/agents/sessionsfind.ts` (the pure rule)
- Test: `frontend/app/view/agents/sessionsfind.test.ts` (append; do not rewrite the file)

**Interfaces:**
- Consumes: `openSessionHit`, `sessionSelection`, `sessionKey`, `SessionsFind` (all existing).
- Produces: `findEnded(find: SessionsFind | null, sel: <sessionsSelAtom value>, member: <sessionsMemberAtom value>): boolean` in `sessionsfind.ts`, exported. It is true only when a find is set and the selection names a session other than `find.sessionKey`. A selection that is still the find's own target, solo or run member, is never an end.

- [ ] **Step 1: Write the failing tests** in `sessionsfind.test.ts`:
  - `findEnded keeps a find whose run member was just selected`: the selection and member that `sessionSelection` gives for a run worker session, and a find keyed to that worker, return false.
  - `findEnded keeps a find whose solo was just selected`: the same for a solo session.
  - `findEnded ends a find when another session is selected`: a find keyed to solo A, with selection solo B, returns true. So does a find keyed to a run worker when the selected member is the lead.
  - `findEnded is false with no find`.
- [ ] **Step 2: Run** `npx vitest run frontend/app/view/agents/sessionsfind.test.ts` and confirm the new tests fail.
- [ ] **Step 3: Implement** `findEnded`, and make `useEndFindElsewhere` clear `sessionsFindAtom` from it, reading the selection atoms, so a stale rendered session can no longer clear a fresh find. Keep the existing behavior that the merged feed (no selection) leaves the find set.
- [ ] **Step 4: Run** the vitest file (all pass) and `task check:ts` (exit 0; give it more than 2 minutes).
- [ ] **Step 5: Commit** `fix(sessions): a find opened on another session keeps its bar`.

Acceptance in Final: sessions-search steps 8 and 9 and sessions-find steps 4, 5 and 6 pass.

### Task 2: sessions-search waits for the real index before asserting on the incomplete line

**Depends on:** none

The evidence: in Final round 1, sessions-search step 5 failed only on `s5c.incomplete == null`. `cdp-shots/sessions-search-5-retried.png` shows the results back after Retry, under "Results may be incomplete — still indexing". The stub was removed, and that line came from the real backend: the Final dev app indexes the user's whole `~/.claude/projects`, which takes about 50 s to parse cold, and the scenario reached step 5 before the warm-up ended. The product is right. The scenario asserted on a state it does not control.

**Decision:** before step 5's stubs, the scenario polls the real `searchsessions` RPC (the same way `scenarios-sessions-find.mjs` waits with `SEARCH_WAIT_MS`) until it returns `incomplete: false`, bounded at 180 s. If the bound runs out, step 5 fails with a detail that says the index never finished. Step 5's recorded detail adds `retriedIncomplete: s5c.incomplete`, so a later failure names the clause. Nothing in the assertion is loosened.

**Files:**
- Modify: `scripts/cdp/scenarios-sessions.mjs` (the sessions-search scenario, step 5 only, plus a small wait helper if none fits)

**Interfaces:**
- Consumes: the existing `stubSearch`, `RESTORE_SEARCH`, `waitState` and `rec` in that file.
- Produces: nothing other tasks use.

- [ ] **Step 1: Add the index wait** before step 5's first `stubSearch`, and `retriedIncomplete` to step 5's detail.
- [ ] **Step 2: Run** the scenario-load command the plan uses for this module, and confirm it lists `sessions-list` and `sessions-search`.
- [ ] **Step 3: Commit** `test(sessions): search scenario waits for the index to warm before step 5`.

Acceptance in Final: sessions-search step 5 passes.
