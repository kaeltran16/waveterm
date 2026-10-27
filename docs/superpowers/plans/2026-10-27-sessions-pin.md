# Sessions: pin a session Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-27-sessions-pin-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `task check:ts && go vet ./pkg/waveobj/`
**Final:** `node scripts/cdp/final-verify.mjs sessions-pin sessions-list sessions-search`
**Prototype:** C:\Users\kael02\AppData\Local\arc-wt\de0bcda5\.superpowers\design\sessions-pin\project\Main.dc.html

**Goal:** Pin solo sessions and runs into a "Pinned" group at the top of the Sessions list, from the card's right-click menu, with the pin set stored as client meta and pruned when a session ages out of the 30-day window.

**Architecture:** A `sessions:pinned` string-list meta key on the client object holds row keys (`${runtime}:${id}` or `run:<runId>`). Pure helpers in a new `sessionspins.ts` decide which rows are pinned, toggle a row and prune the set. `groupByRecency` gains an optional pinned predicate that puts those items in a first `pinned` group. `SessionsSurface` wires the atom, the grouping and an `onContextMenu` on both cards. No `GetSessionsActivity` change.

**Tech Stack:** Go (waveobj meta + `task generate`), React 19 + jotai, vitest, the CDP scenario harness.

## Global Constraints

- Group label is exactly `Pinned`, group key `pinned`, placed before `live` / `today` / `earlier`; sorted `lastactivets` desc like the others.
- Menu item labels are exactly `Pin` and `Unpin`, with lucide `Pin` / `PinOff` at `size={15}`, shown through `ContextMenuModel.getInstance().showContextMenu(items, e)` as in `agenttree.tsx`.
- No pin icon on cards, no hover control, no keybinding, no detail-pane button.
- The Agent-tree tab meta `session:pinned` is untouched and unrelated.
- Never hand-edit generated files; run `task generate` after the Go change.
- Colors from `@theme` tokens only; no new tokens. Never run prettier on `scripts/*.mjs`.

## Review Focus

- Client meta not loaded yet, or no `sessions:pinned` key: the pin set reads as `[]`, nothing throws, the list renders as today (Task 3 test via the atom's fallback, Task 2 tests with empty sets).
- An incomplete or failed archive load must not prune (Task 3 test on the prune gate).
- Pinning a row twice, or a run whose lead session's key is already pinned, leaves no duplicate keys (Task 2 test).
- A run row pinned only by a member session's key reads as pinned, and Unpin clears that key too (Task 2 test).
- Under a search query, a pinned match stays in the Pinned group with its snippet rows, and j/k walks Pinned first (Task 3 scenario steps).

---

### Task 1: The sessions:pinned client meta key
**Depends on:** none
**Files:** `pkg/waveobj/wtypemeta.go`, `pkg/waveobj/metaconsts.go`, `frontend/types/gotypes.d.ts`

Add the field `SessionsPinned []string` with JSON tag `sessions:pinned,omitempty` and the comment `// client (Sessions surface pins: row keys "<runtime>:<id>" or "run:<runId>")` beside the other `session:*` fields in `MetaTSType` (`pkg/waveobj/wtypemeta.go`), then run `task generate` so `metaconsts.go` gains `MetaKey_SessionsPinned` and `gotypes.d.ts`'s `MetaType` gains `"sessions:pinned"?: string[]`.

Acceptance:
- [ ] `task generate` leaves exactly those three files changed for this key.
- [ ] `go build ./pkg/waveobj/` and `go vet ./pkg/waveobj/` pass.
- [ ] Commit: `feat(sessions): sessions:pinned client meta key`.

### Task 2: Pure pin logic and the Pinned group
**Depends on:** none
**Files:** `frontend/app/view/agents/sessionspins.ts`, `frontend/app/view/agents/sessionspins.test.ts`, `frontend/app/view/agents/sessionsarchivestore.ts`, `frontend/app/view/agents/sessionsarchivestore.test.ts`

Interfaces (Task 3 relies on these exact names):
- `sessionspins.ts` (pure: type-only imports plus `sessionKey` / `runSelKey` from `./sessionsruns`; no React, no store):
  - `export function rowPinKeys(row: Row): string[]`: the keys that pin a row: `[row.key]` for a solo row; for a run row `row.key` plus `sessionKey(s)` of each `row.run.group.sessions`.
  - `export function isRowPinned(row: Row, pins: ReadonlySet<string>): boolean`: true when any of `rowPinKeys(row)` is in `pins`.
  - `export function togglePinnedRow(pins: string[], row: Row): string[]`: if the row is pinned, return `pins` without every `rowPinKeys(row)` key; else return `pins` plus `row.key`. Order kept, no duplicates, input not mutated.
  - `export function prunePins(pins: string[], sessions: SessionActivity[]): string[]`: keep a key only if some session has `sessionKey(s) === key` or `s.runid && runSelKey(s.runid) === key`. Returns the input array itself when nothing is dropped, so a caller can test `next !== pins`.
  - `Row` is the type from `./sessionssearch` (import type only, to keep the module free of runtime cycles).
- `sessionsarchivestore.ts`: `groupByRecency<T extends Recent>(list: T[], now: number, isPinned?: (item: T) => boolean): RecencyGroup<T>[]`. `RecencyGroup.key` becomes `"pinned" | "live" | "today" | "earlier"`. Pinned items (those `isPinned` returns true for) go only to `{ key: "pinned", label: "Pinned" }`, first, sorted `lastactivets` desc; empty groups are still dropped. With no `isPinned`, output is unchanged.

Tests:
- [ ] `sessionspins.test.ts`, all failing first, then passing with `npx vitest run frontend/app/view/agents/sessionspins.test.ts`:
  - `isRowPinned` on a solo row: true only when its key is in the set; false on an empty set.
  - `isRowPinned` on a run row: true via `run:<id>`, and true via a member session's key alone.
  - `togglePinnedRow`: pins a solo row (appends its key); unpins it; pinning an already-pinned row returns the set with that row's keys removed (toggle semantics); unpinning a run row pinned by both `run:<id>` and a member key removes both and keeps unrelated keys in order; never yields duplicates.
  - `prunePins`: keeps a solo key present in sessions and a `run:<id>` key whose run id appears on any session; drops a key with no match; returns the same reference when nothing is dropped; `[]` in gives `[]` out.
- [ ] `sessionsarchivestore.test.ts`, new `describe("groupByRecency: pinned")`:
  - a pinned live item and a pinned old item land in `pinned` (newest first) and leave `live` / `earlier`; group order is `["pinned", "live", "today", "earlier"]` minus empties.
  - no `isPinned`, or one that returns false for all: same groups as today (existing tests stay green).
  - `pageGroups` over a result with a pinned group cuts across it first.
- [ ] Commit: `feat(sessions): pin logic and the Pinned group`.

### Task 3: Wire pinning into the Sessions surface, with its CDP scenario
**Depends on:** Task 1 (uses the generated `"sessions:pinned"` MetaType field), Task 2
**Files:** `frontend/app/view/agents/sessionsarchivestore.ts`, `frontend/app/view/agents/sessionsarchivestore.test.ts`, `frontend/app/view/agents/sessionssurface.tsx`, `scripts/cdp/scenarios-sessions.mjs`

Design decisions this task makes:
- `sessionsarchivestore.ts`:
  - `export const sessionsPinnedAtom: Atom<string[]>`, derived from `ClientModel.getInstance().clientAtom`'s `meta?.["sessions:pinned"] ?? []` (a missing client or key reads as `[]`).
  - `export function setSessionsPinned(pins: string[]): void`: `SetMetaCommand` on `WOS.makeORef("client", <client oid>)` with `{ "sessions:pinned": pins.length ? pins : null }`, through `fireAndForget` like `setCollapsedGroups`; no-op with a logged message when the client oid is unknown.
  - `export function shouldPrunePins(loadOk: boolean, incomplete: boolean): boolean`: true only for an ok, complete load. `loadSessionsArchive` calls `prunePins` on the loaded sessions after a successful complete load and calls `setSessionsPinned` only when the result `!==` the current set. Never from search results.
- `sessionssurface.tsx`: read `sessionsPinnedAtom`, build a `Set`, and call `groupByRecency(shown, now, (r) => isRowPinned(r, pinSet))`. `navIds` and paging stay derived from `groups`, so Pinned leads j/k. Give each group container `data-sessions-group={g.key}`. Add `onContextMenu` on the outer `motion.div` of `SoloCard` and `RunCard` (via a prop such as `onContextMenu: (e: React.MouseEvent) => void` built in `SessionsSurface`): `e.preventDefault()`, then a one-item menu, `Pin` / `Unpin` with `Pin` / `PinOff` size 15, whose click calls `setSessionsPinned(togglePinnedRow(pins, row))`. It works on search-result cards too.

Tests:
- [ ] `sessionsarchivestore.test.ts`: `shouldPrunePins(true, false)` is true; `(true, true)`, `(false, false)` and `(false, true)` are false.
- [ ] New CDP scenario `sessions-pin` in `scripts/cdp/scenarios-sessions.mjs`, returned from the default export beside `sessionsList` and `sessionsSearch(kit)`. Arrange seeds `writeSessionsSearchFixtures()` + `seedSessionsSearchRun(h, kit, fx)` and saves the current client `sessions:pinned` value; teardown restores it exactly (deleting the key if it was absent), then `removeSessionsSearchFixtures` and `kit.teardownFixtureRun`. Pin the 1600x950 viewport, scope queries to `[data-sessions-list]`. Steps, each with the named screenshot under `cdp-shots/`:
  0. arrange also makes one more fixture solo session live: write its transcript, create a terminal block and report it as working with that transcript path, the way `scripts/inject-live-agents.mjs` does (`createblock term`, then `agentstatus -b <block oref> --state working --agent claude --transcript <path>`; prefer the matching RPCs through `h.rpc`). Wait until its card shows under Live now with the running mark before step 1. Teardown deletes the block and the transcript.
  1. right-click an ended fixture solo card: take `sessions-pin-1-menu-pin.png` with the context menu still open (`contextMenuAtom` set, the `Pin` item visible), then click `Pin` and take `sessions-pin-1-pinned.png`: that card is under `[data-sessions-group="pinned"]` and gone from its recency group; the group header reads `Pinned`.
  2. right-click the fixture run card and Pin it (`sessions-pin-2-run.png`): it lists under Pinned; Pinned's count is 2.
  3. right-click a pinned card: take `sessions-pin-3-menu-unpin.png` with the menu still open and `Unpin` visible, then close it with Escape.
  4. pin the live fixture card from its menu (`sessions-pin-4-live.png`): it is under Pinned, first (newest), with its running status mark (the `running` text and pulse dot), and it is absent from the Live now group; the toolbar's live count is unchanged from before the pin.
  5. the `Live` status chip (`sessions-pin-5-live-filter.png`): the Pinned group shows only the live pinned card, no ended pinned card shows anywhere; back to `All`.
  6. type the fixtures' search word (`sessions-pin-6-search.png`): a pinned fixture match lists under Pinned with its snippet rows (`[data-session-hits]`); clear the query.
  7. j from All activity selects the first Pinned row (the listNav cursor equals the first Pinned row key).
  8. Unpin the ended solo card from its menu (`sessions-pin-8-unpinned.png`): it returns to its recency group.
  9. pruning: set `sessions:pinned` to the current pins plus `claude:arc-verify-no-such-session`, call `loadSessionsArchive()` and wait until it is complete: the bogus key is gone and the real pins remain.
- [ ] `npx vitest run frontend/app/view/agents/sessionsarchivestore.test.ts frontend/app/view/agents/sessionspins.test.ts` passes; `task check:ts` exits 0.
- [ ] Run `task verify:ui -- sessions-pin sessions-list sessions-search` against a dev app: all PASS.
- [ ] Commit: `feat(sessions): pin a session from its row menu`.
