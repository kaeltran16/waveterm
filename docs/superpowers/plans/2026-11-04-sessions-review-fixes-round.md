# Sessions review fixes: fixture round Implementation Plan

> **For agentic workers:** one task, one worker. It carries its decisions, files and acceptance; you write the
> implementation.

**Goal:** Make the in-page Sessions fixtures safe on a live dev app: a stubbed archive load must not prune the
store's pins, and a real archive load already in flight must not land over the fixtures, for every scenario that
installs them.

**Architecture:** Both fixes live in `scripts/cdp/sessions-page-fixtures.mjs`, the one module every Sessions
scenario installs its archive through. The archive hold `sessions-list-states` wrote for itself moves there, so the
detail and palette scenarios get it too.

**Tech Stack:** the CDP harness in `scripts/cdp/`, jotai, vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-sessions-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentsessions ./pkg/wshrpc/... ./pkg/blockcontroller`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs sessions-list-states sessions-detail-states sessions-palette-resume agent-start-failed`

## Global Constraints

- New and changed scenario steps write nothing into `~/.claude/projects`, and leave the dev store's pins as they
  found them.
- Do not change app code (`frontend/`): these are harness defects, not product ones.

---

### Task 1: Pin-safe, race-safe Sessions fixtures
**Depends on:** none
**Files:** `scripts/cdp/sessions-page-fixtures.mjs`, `scripts/cdp/scenarios-sessions-list-states.mjs`, `scripts/cdp/scenarios-sessions-palette-resume.mjs`

Why: `installSessions` stubs `GetSessionsActivityCommand` with `incomplete: false`, so any `loadSessionsArchive`
while the stub is in place (a Sessions visit, the palette's first-open load, or the reload in `restoreSessions`
racing one) runs `prunePins` against the fixture list and drops every real pin of the dev store
(`frontend/app/view/agents/sessionsarchivestore.ts:73-78`). And on an app still indexing, a real archive load
already in flight when the fixtures go in lands over them; only `sessions-list-states` guards that, with its own
`holdArchive`/`releaseArchive` (`scenarios-sessions-list-states.mjs:75-95`).

- `installSessions(h, sessions)` also:
  - saves the current `sessionsPinnedAtom` value on `window.__sessionsFixturePins` (only on the first install, so
    a second install in one scenario keeps the original);
  - holds the archive: puts the installed list back on every write to `sessionsArchiveAtom` and resets
    `sessionsIncompleteAtom` to false on every write to it, as `holdArchive` does now. A second install replaces
    the hold.
- `restoreSessions(h)` releases the archive hold first, then removes the stubs and objects as now, then, when the
  saved pins differ from the current `sessionsPinnedAtom`, writes them back with `setSessionsPinned` and deletes
  `window.__sessionsFixturePins`, and only then calls `loadSessionsArchive()`.
- `scenarios-sessions-list-states.mjs` drops its local `holdArchive`/`releaseArchive` and `ARCHIVE_STORE`, and
  their calls; its steps must still pass unchanged.
- `restoreSessions` must be safe to call twice (a second call finds no saved pins and no hold, and only reloads).
- New last step in `sessions-palette-resume`, `teardown keeps the store's pins`:
  - setup, before `installSessions`, reads the pins and pins a key no fixture holds (`claude:<fresh UUID>`) with
    `setSessionsPinned([...pins, key])`, so the saved pins include it;
  - the step calls `loadSessionsArchive()` under the stub (which prunes the key), then `restoreSessions(h)`, and
    asserts the key is in `sessionsPinnedAtom` again; it then unpins the key with `setSessionsPinned` and asserts
    the pins equal the ones read before the pin. Without the fix the first assertion fails;
  - the existing teardown keeps its `restoreSessions` call, and also unpins the key if the step did not reach that.

Acceptance: the four Final scenarios pass every step, the new step included; `npx vitest run
scripts/cdp/sessions-page-fixtures.test.mjs` still passes.
