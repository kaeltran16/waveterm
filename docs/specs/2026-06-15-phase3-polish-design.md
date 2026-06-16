# Phase 3 — Polish — Design Spec

**Date:** 2026-06-15
**Status:** Design approved (brainstorm complete); implementation plan pending
**Base:** Extends [Wave Agent Sessions](./2026-06-12-wave-agent-sessions-design.md) §9 (Phase 3 — Polish). Phase 1 (sidebar) and Phase 2 (real status + grouping) are committed.
**Scope source:** The main spec's §9 Phase 3 list, minus items already satisfied. Verified against the committed sidebar code on 2026-06-15.

## 1. What this is

Four additive polish changes to the committed session sidebar. Each rides an existing Wave seam; net-new files are minimal and edits stay localized to the sidebar module, `MetaTSType`, and `keymodel.ts`.

The four items:
1. **Typed meta keys** — promote `session:pinned` / `session:agent` from `meta as any` to typed `MetaTSType` keys; add `session:collapsedgroups`. (Enabling primitive — do first.)
2. **Persisted collapse state** — move group collapse from in-memory React state to workspace meta so it survives reload/restart.
3. **Keyboard navigation** — vim-style session cycling in the sidebar's *visual* order, plus a "jump to the next session that needs you" key.
4. **Diff-split keybinding** — split the layout and open a terminal running `git diff` in the active session's cwd.

## 2. Goal & non-goals

**Goal:** make the day-to-day driving of 5–15 sessions calmer and faster — collapse state you set once stays set, you navigate by keyboard in the order you see, you jump straight to whoever is blocked, and you can diff the active session's working tree in one chord.

**Non-goals (this phase):**
- Long-name truncation + hover — **already implemented** in Phase 1/2 (`truncate` + native `title=` on row label, detail line, and group label). Out unless a *styled* tooltip is later wanted (YAGNI: native `title` works).
- Config keys for the diff command or chord remapping — no configurability need yet (YAGNI).
- Live-ticking idle duration ("12m") and committing the reporter script — these were deferred from Phase 2 and are explicitly **not** in this phase.

## 3. Item 1 — Typed meta keys (enabling primitive)

**Why first:** the reactive read for persisted collapse (`getOrefMetaKeyAtom`) is typed to `keyof MetaType`, so the collapse key must be a typed `MetaTSType` field. Promoting the existing two keys at the same time is a one-line-each cleanup that removes the `as any` casts the sidebar currently carries.

**Change:** add to `MetaTSType` (`pkg/waveobj/wtypemeta.go`), then run `task generate`:
```go
SessionPinned          bool     `json:"session:pinned,omitempty"`
SessionAgent           string   `json:"session:agent,omitempty"`
SessionCollapsedGroups []string `json:"session:collapsedgroups,omitempty"`
```
`MetaTSType` is the single shared meta struct across all WaveObj types; the keys are namespaced strings in a flat map, so tab-scoped (`session:pinned`, `session:agent`) and workspace-scoped (`session:collapsedgroups`) keys coexist in the one struct.

**Then:** in `sessionsidebarmodel.ts`, drop the `as any` cast on the `session:pinned` write (`:94`) and the `Record<string, any>` cast on the meta read (`:55,:59`), now that the keys are typed.

**Boundary:** Go type → generated `frontend/types/gotypes.d.ts` (never hand-edited) → consumed by the FE. No behavior change.

## 4. Item 2 — Persisted collapse state

Today collapse is `useState<Set<string>>` in `sessionsidebar.tsx:20` — resets every reload. Move it to **workspace meta**, keyed by group label.

- **Storage:** `session:collapsedgroups: string[]` on the workspace ORef (per-workspace, persisted by Wave's existing workspace-meta persistence).
- **Read:** `getOrefMetaKeyAtom(workspaceORef, "session:collapsedgroups")` → reactive `string[]`; the component derives the collapsed `Set` from it.
- **Write:** the group toggle handler computes the next array (add/remove the label) and calls `RpcApi.SetMetaCommand` on the workspace ORef.
- **Edge case:** a stale label (group renamed or gone) sits unused in the array — harmless; self-heals the next time that label is toggled. No migration needed.

**Boundary:** the sidebar component owns the read and the toggle (the only writer). The pure derivation `collapsedArrayToSet` is unit-testable.

## 5. Item 3 — Keyboard navigation (vim-style)

Wave already binds `Ctrl:Shift:{h,j,k,l}` to **block** focus nav within a tab (`keymodel.ts:594-625`). This phase mirrors that pattern one altitude up — **session** nav — using the `Cmd:Shift` modifier (because `Ctrl:Shift:j/k` are taken by block nav). Two-tier model: `Ctrl:Shift` moves between blocks inside a session; `Cmd:Shift` moves between sessions.

**Pure logic** lives in `sessionviewmodel.ts` (the existing no-React/no-runtime module) so it is unit-testable without mocking Wave:
- `flattenVisualOrder(vm) → SessionRowVM[]` — Pinned group first, then service groups, top-to-bottom.
- `cycleTarget(vm, offset: 1 | -1) → tabId | undefined` — flatten, find the active row, move by `offset` with wraparound.
- `needsYouTarget(vm) → tabId | undefined` — the next `waiting` row after the active one (wrapping); `undefined` when none are waiting.

**Impure wrappers** live in `sessionsidebarmodel.ts`: `cycleSession(offset)` and `jumpToNeedsYou()` read `sessionSidebarViewModelAtom` via `globalStore`, call the matching pure function, and `setActiveTab` on the result. `registerGlobalKeys()` in `keymodel.ts` binds keys to these wrappers, so sidebar logic stays in the sidebar module.

**Keybindings:**

| Action | Chord | Rationale |
|---|---|---|
| Cycle to next session (down) | `Cmd:Shift:j` | `j` = down |
| Cycle to prev session (up) | `Cmd:Shift:k` | `k` = up |
| Jump to next session that needs you | `Cmd:Shift:n` | `n` = next match |

`Cmd:Shift:j/k/n` do not appear in `registerGlobalKeys()`. **The implementation plan must audit the full keymap** (terminal keymap, block keymap, and any keybindings config) for collisions before finalizing.

**Boundary:** pure selection logic in `sessionviewmodel.ts` (unit-tested); thin atom-reading/dispatch wrappers in `sessionsidebarmodel.ts`; `keymodel.ts` only binds keys.

## 6. Item 4 — Diff-split keybinding

A handler in `keymodel.ts` (alongside `handleSplitHorizontal`) that diffs the active session's working tree in a split.

- **Resolve** the active session's terminal block id + `cmd:cwd`. The view-model atom already finds the per-tab terminal block (`sessionsidebarmodel.ts:35-42`); extract that into a small shared helper (`findTermBlock(get, tab) → { blockId, cwd }`) so it is not duplicated.
- **Build** a term `blockDef` whose meta sets `cmd:cwd` to the active session's cwd and runs `git diff` once (intended shape: `view: "term"` + `cmd: "git diff"` + `cmd:cwd`). The exact controller/cmd meta combination is finalized in the plan against how Wave term blocks run a command (e.g. `getDefaultNewBlockDef` and the `cmd`/`controller`/`cmd:runonce` keys).
- **Split** via `createBlockSplitHorizontally(blockDef, activeBlockId, "after")` (exported from `@/app/store/global`).
- It is a normal terminal block, so the user can scroll, re-run, or run other git commands.

**Keybinding:** `Cmd:Shift:g` (`g` = git; `Cmd:g` is taken by the connection dropdown, the Shift variant is free).

**Boundary:** reuses Wave's block-split entirely. The only new logic is assembling the `blockDef` from the active session's cwd. No-op if the active tab has no terminal block / cwd.

## 7. Testing

- **Pure functions** in `sessionviewmodel.ts`, tested by extending the existing `sessionviewmodel.test.ts` (no running Wave):
  - `flattenVisualOrder(vm) → SessionRowVM[]` — Pinned-first, then groups in order.
  - `cycleTarget(vm, offset)` — next/prev with wraparound; single-session and empty cases.
  - `needsYouTarget(vm)` — next `waiting` after active, wrap, no-waiting → `undefined`.
  - `collapsedArrayToSet` — array ↔ Set derivation.
- **Verified live** (matching how Phase 1/2 verified keybindings and `wsh`): typed-meta round-trip, persisted-collapse write-through across reload, the three nav chords, and diff-split. Jotai/keymap wiring has no unit tests in this codebase.

## 8. File touch list

| File | Item | Change |
|---|---|---|
| `pkg/waveobj/wtypemeta.go` | 1 | Add three `Session*` fields to `MetaTSType` |
| `frontend/types/gotypes.d.ts` | 1 | Generated by `task generate` (not hand-edited) |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` | 3,2 | Add pure `flattenVisualOrder`/`cycleTarget`/`needsYouTarget`/`collapsedArrayToSet` |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts` | 3,2 | Extend with unit tests for the new pure helpers |
| `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` | 1,2,3,4 | Drop `as any` casts; add `cycleSession`/`jumpToNeedsYou` wrappers + `findTermBlock` helper |
| `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` | 2 | Read/write collapse via workspace meta instead of `useState` |
| `frontend/app/store/keymodel.ts` | 3,4 | Bind `Cmd:Shift:j/k/n` to session nav; add diff-split handler + `Cmd:Shift:g` |

## 9. Fork hygiene

Edits to existing files stay limited to: `wtypemeta.go` (three additive fields), the two sidebar files, and `keymodel.ts` (additive key bindings + one handler). Consistent with the spec §10 additive-over-edit principle; the only stock-Wave file touched is `keymodel.ts`, and only by adding bindings (no rebinding of existing keys), minimizing upstream-rebase friction.

## 10. Sequencing

Item 1 (typed meta keys) first — it unblocks Item 2's typed reactive read. Items 2, 3, 4 are mutually independent after that and can be built in any order.
