# Global Jarvis profile editing — design

Date: 2026-07-16

## Problem

The Jarvis profile panel (`frontend/app/view/agents/profilepanel.tsx`) presents a
**merged** view — "JARVIS PROFILE · MERGED (GLOBAL + THIS PROJECT)" — but its only
persistence path writes a **per-project override** into the current channel's meta
(`SetChannelProfileCommand` → `wstore.DBUpdateFn`). There is no write path for the
**global** profile:

- `LoadGlobalProfile` (`pkg/jarvis/profile.go`) reads `jarvis-profile.json` from
  `GetWaveConfigDir()` and falls back to the builtin defaults when the file is absent.
- No production code ever writes that file (only tests do). No such file exists on disk,
  so the global profile is permanently the 4 builtin principles + builtin playbook.

Consequence: when a user edits a section shown as `GLOBAL` (Playbook, Principles) expecting
a default that persists across all projects, the panel silently reinterprets the edit as a
*per-project* override. The `GLOBAL` rows snap back to the builtins on reopen, because
nothing can persist a global change. This is a by-design gap, not a runtime bug — the
backend per-project round-trip is correct and covered by passing tests
(`TestSetChannelProfileStoresPatch`).

## Goal

Let users edit the **whole** global profile (Playbook + Principles + Run defaults) and have
it persist to `jarvis-profile.json`, so those edits become the default across all projects.

Non-goals: light/paper theming; live cross-surface push of global changes (see Propagation);
a separate global-settings screen.

## Approach — scope toggle, one panel, two modes

A segmented toggle at the top of `ProfilePanel`: **Global defaults · This project**,
defaulting to *This project*. The toggle drives section rendering and the Save button.

### This project scope (unchanged)
Today's merged/override UI, byte-for-byte: per-section GLOBAL/PROJECT badges,
`customize` / `reset to global`, per-principle `override` / `disable`, Save →
`SetChannelProfileCommand` (channel meta). No behavior change.

### Global defaults scope (new)
Sections are edited **directly** on the base `JarvisProfile`. No badges, no
inherit/override/disable, no customize/reset — every section is always-editable. Save →
new `SetGlobalProfileCommand` (writes `jarvis-profile.json`). Global scope ignores
`channelId`, so it works even when there is no active channel.

## Per-section behavior in Global scope

- **Playbook** — reuses the existing `PhaseEditor` list (add / remove / reorder / edit),
  minus the customize/reset chrome.
- **Run defaults** — reuses the existing mode `<select>` + plan-gate checkbox, writing
  straight to the global profile.
- **Principles** — the one section needing a new editor. In global scope, principles are a
  plain flat list over `JarvisProfile.Principles`: **add / edit text / delete / reorder**
  (up-down, matching `PhaseEditor`). No override/disable/inherited concept — those only
  make sense against a global baseline. Implemented as a pure reducer mirroring
  `reducePrinciplePatch`, plus a small list component.

New principle IDs (from "add") are generated client-side; validation is enforced
server-side (`ValidateGlobalPrinciples`): non-blank id + text, no duplicate ids.

## Backend

- `pkg/jarvis/profile.go`:
  - `SaveGlobalProfile(profile waveobj.JarvisProfile) error` — validate, then write
    `jarvis-profile.json` to `GetWaveConfigDir()` atomically (temp file + rename). Reuses
    `ValidateGlobalPrinciples`; adds light playbook validation (each phase has a non-empty
    `kind`).
- `pkg/wshrpc/wshrpctypes.go` + `pkg/wshrpc/wshserver/wshserver.go` — two new commands:
  - `GetGlobalProfileCommand()` → the global `JarvisProfile` (no channel needed; returns
    builtins when no file exists yet). Symmetric with Set; lets Global scope load without an
    active channel.
  - `SetGlobalProfileCommand(data { profile JarvisProfile }) error` → validate +
    `SaveGlobalProfile`.
- Run `task generate` to regenerate `wshclientapi.ts`, `gotypes.d.ts`, `wshclient.go`.

## Frontend

- `frontend/app/view/agents/runactions.ts` — `getGlobalProfile()` / `setGlobalProfile(profile)`
  wrappers over the generated RPC.
- `frontend/app/view/agents/profilepanel.tsx` — scope toggle state; scope-aware section
  rendering; Save routing (`setChannelProfile` vs `setGlobalProfile`); dirty-tracking per
  scope; Global-scope load via `getGlobalProfile` (independent of `channelId`).
- `frontend/app/view/agents/profilemodel.ts` (or a sibling) — flat-list principles reducer
  (`add` / `update` / `delete` / `move`) as pure functions.
- A small global-principles list component (or a mode in `principleseditor.tsx`).

## Propagation

Saving global changes the resolved profile for every channel. The panel updates its own
loaded state immediately (as the project save does today). Other open surfaces (composer
run-footer, command-palette) already refetch `getJarvisProfile` on channel-switch/open.

v1 relies on **refetch-on-next-open** — a global edit is rare. A `jarvis:profile-updated`
wps broadcast is a documented follow-up if staleness proves annoying.

## Edge cases (mostly handled already)

- Deleting a global principle referenced by a project override → becomes a *stale*
  diagnostic, already surfaced and removable in project scope. No new work.
- Empty global playbook still falls back to `DefaultPlaybook()` at run time (existing
  behavior, preserved).
- Two sessions editing the global file concurrently → last-write-wins (acceptable).

## Testing

- **Go** (`pkg/jarvis/profile_test.go`, `pkg/wshrpc/wshserver/wshserver_profile_test.go`):
  `SetGlobalProfileCommand` writes and round-trips via `LoadGlobalProfile`; validation
  rejects blank/duplicate ids and blank text; `GetGlobalProfileCommand` returns builtins
  with no file and the saved profile with one. Uses the existing `withConfigHome(t, dir)`
  temp-config-dir helper.
- **Frontend**: unit-test the flat-list principles reducer (add/edit/delete/reorder) as pure
  functions; scope-toggle wiring (Save target switches with scope).
- **Visual**: CDP verify in the dev app (no jsdom harness) per repo convention — flip to
  Global scope, edit + save, reopen, confirm persistence.

## Files touched

- `pkg/jarvis/profile.go`
- `pkg/wshrpc/wshrpctypes.go`
- `pkg/wshrpc/wshserver/wshserver.go`
- generated bindings (`wshclientapi.ts`, `gotypes.d.ts`, `wshclient.go`)
- `frontend/app/view/agents/profilepanel.tsx`
- `frontend/app/view/agents/profilemodel.ts` (+ a global-principles list component)
- `frontend/app/view/agents/runactions.ts`
- `pkg/jarvis/profile_test.go`, `pkg/wshrpc/wshserver/wshserver_profile_test.go`, a frontend `.test.ts`
