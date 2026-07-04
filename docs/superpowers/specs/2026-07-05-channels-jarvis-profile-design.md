# Channels — Jarvis Profile (Piece 3)

**Date:** 2026-07-05
**Status:** Design — awaiting user review
**Surface:** `pkg/jarvis/` + `pkg/wshrpc` + `frontend/app/view/agents/` (channels/runs files)
**Parent:** `2026-07-04-channels-goal-driven-delegation-design.md` (Piece 3 of 4)
**Depends on:** Piece 1 — backend Run engine (`bddcca2a`); Piece 2 — Run UI (`d5371a92`).

## Problem

A Run today always executes the hardcoded `jarvis.DefaultPlaybook()` (brainstorm → plan[gate] → execute[freshctx]). There is no way to make Jarvis run work **the way you work** — no editable process, and no place to record the judgment (principles) that Piece 4 will feed into the escalation classifier. Piece 3 introduces the **Jarvis profile**: a two-part (playbook + principles), two-layer (global file + per-project override) configuration, resolved at runtime, with an in-app editor for the per-project override.

## Goals

- A **profile** with two parts — **playbook** (the phase pipeline: structure/gates) and **principles** (free text; judgment) — and two layers — a **global** base and a **per-project override**.
- **Section-level resolution**: `resolved.section = override.section ?? global.section`, independently per section.
- The resolved **playbook drives `CreateRun`** (replacing the hardcoded default).
- An in-app **editor** for the per-project override (slide-in panel): edit playbook phases + principles, per-section override badge, Customize / Reset-to-global, Save.
- No DB migration; the override is embedded JSON on the channel's `Meta` (mirrors the existing tier flags).

**Non-goals (this spec):**
- **Principle consumption.** Principles are stored, edited, resolved, and returned to the frontend, but **not yet read by any model**. Wiring principles into `pkg/jarvis/classify.go` and `BuildPhasePrompt` is **Piece 4**. This spec does not touch the classifier or the phase-prompt builder.
- **In-app global editor.** The global layer is edited via its JSON file; the in-app editor edits only the per-project override. A global editor is a future extension.
- **CLAUDE.md seeding.** The global default is a hardcoded builtin, not parsed from the user's CLAUDE.md.
- **Field-level / deep merge.** Resolution is section-level replace, not per-phase or append merge.
- Fine visual/pixel design — reuse the existing `CollapsibleRail` + agents-surface tokens.

## Decisions (from brainstorming)

1. **Global profile = a dedicated JSON file** at `<GetWaveConfigDir()>/jarvis-profile.json`, with a **hardcoded builtin default** when missing/malformed. No CLAUDE.md parsing, no auto-write.
2. **Merge = section-level replace.** The override carries an optional playbook and/or optional principles; each present section wholly replaces the global's; each absent section inherits global. Reset-to-global = drop that section from the override.
3. **Scope line: playbook live, principles inert.** Piece 3 wires the resolved *playbook* into `CreateRun` and makes both sections editable/persisted/resolved. *Principles consumption* is deferred to Piece 4. The classifier is not modified.
4. **Resolution source = backend read command.** A `GetJarvisProfileCommand` returns `{ global, override, resolved }`; resolution lives once, in Go. The frontend renders what it is given and never mirrors the merge rule.
5. **In-app editor edits the per-project override only.** The global layer is the file.

## Architecture

### Data model (Go)

The two **data types live in `pkg/waveobj/wtype.go`** next to `Run`/`RunPhase` (not in `jarvis`), so the wshrpc return type can reference them without importing `jarvis` — `wshrpctypes.go` already imports `waveobj` — and so they are auto-emitted into `frontend/types/gotypes.d.ts` by `task generate` exactly like `Run`/`RunPhase`. The **logic** (`BuiltinProfile`, `LoadGlobalProfile`, `ResolveProfile`, `OverrideFromMeta`, `DefaultPrinciples`, the meta key) lives in a new `pkg/jarvis/profile.go`.

The resolved/global shape **reuses `waveobj.RunPhase`** for the playbook so the resolver output drops straight into `NewRun(playbook []waveobj.RunPhase, ...)` with zero conversion — consistent with today's `DefaultPlaybook() []waveobj.RunPhase`. Only the template-relevant fields (`Kind`, `Skill`, `Gate`, `FreshCtx`) carry meaning in a playbook; runtime fields (`State`, `WorkerOrefs`, `Artifacts`) are set by `NewRun` at run creation.

```go
// JarvisProfile is the resolved (or global) profile. Playbook reuses RunPhase so it feeds NewRun directly.
type JarvisProfile struct {
    Playbook   []waveobj.RunPhase `json:"playbook"`
    Principles string             `json:"principles,omitempty"`
}

// ProfileOverride is the per-project override stored on channel meta. Pointer fields: nil = inherit the
// global section, non-nil = replace it (section-level). An override with both nil is equivalent to none.
type ProfileOverride struct {
    Playbook   *[]waveobj.RunPhase `json:"playbook,omitempty"`
    Principles *string             `json:"principles,omitempty"`
}
```

**Global storage:** `<wavebase.GetWaveConfigDir()>/jarvis-profile.json`. `LoadGlobalProfile() JarvisProfile` reads and unmarshals it; on missing or malformed file it returns `BuiltinProfile()` and logs a non-fatal warning. No side-effecting write from the loader.

**Builtin default:** `BuiltinProfile() JarvisProfile` = `{ Playbook: DefaultPlaybook(), Principles: <DefaultPrinciples const> }`. `DefaultPlaybook()` remains the single source for the default pipeline (used by both the builtin profile and the `CreateRun` fallback).

**Override storage:** `ch.Meta[MetaKey_JarvisProfile]` where `MetaKey_JarvisProfile = "jarvis:profile"` (declared alongside the tier meta keys in `resolve.go`). The stored value is the `ProfileOverride` JSON object; sections the user has not set are absent.

### Resolver (Go — `pkg/jarvis/profile.go`)

```go
// ResolveProfile applies a per-project override onto the global profile, section by section: a non-nil
// override section replaces the global's; a nil section inherits. Pure; single source of the merge rule.
func ResolveProfile(global JarvisProfile, override *ProfileOverride) JarvisProfile {
    out := global
    if override != nil {
        if override.Playbook != nil {
            out.Playbook = *override.Playbook
        }
        if override.Principles != nil {
            out.Principles = *override.Principles
        }
    }
    return out
}
```

A small helper reads the override off channel meta: `OverrideFromMeta(ch *waveobj.Channel) *ProfileOverride` (exported — `wshserver` is a separate package and calls it) — returns nil when the key is absent, and nil + logged warning when the stored value is malformed (so a bad blob degrades to pure-global, never a crash).

### wshrpc commands (`pkg/wshrpc` → `wshserver` → generated api)

Mirror the existing channel commands (`SetChannelTierCommand`):

- **`GetJarvisProfileCommand { channelId } → { global, override, resolved }`** (`CommandGetJarvisProfileData` / `CommandGetJarvisProfileRtnData`). Loads global, reads the override off the channel, resolves, returns all three. `override` is the raw `ProfileOverride` (possibly empty) so the editor can render per-section badges.
- **`SetChannelProfileCommand { channelId, override }`** → `wstore.DBUpdateFn` writes `ch.Meta["jarvis:profile"] = override`, or **deletes the key** when the override is empty (both sections nil) — a full reset-to-global. Then `wcore.SendWaveObjUpdate`. Matches `SetChannelTierCommand` exactly in shape.

### CreateRun wiring (`pkg/wshrpc/wshserver/wshserver.go`)

The one behavioral change to existing runs. Where `CreateRunCommand` currently calls `jarvis.NewRun(..., jarvis.DefaultPlaybook(), ...)`:

```go
resolved := jarvis.ResolveProfile(jarvis.LoadGlobalProfile(), jarvis.OverrideFromMeta(ch))
playbook := resolved.Playbook
if len(playbook) == 0 {
    playbook = jarvis.DefaultPlaybook() // never build a zero-phase run
}
run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, playbook, time.Now().UnixMilli())
```

Principles are resolved here too but unused in Piece 3 (Piece 4 threads `resolved.Principles` into the phase-worker prompt and the classifier).

### Frontend (`frontend/app/view/agents/`)

Regenerate TS types via `task generate` (never hand-edit `gotypes.d.ts` / `wshclientapi.ts`). `JarvisProfile`, `ProfileOverride`, and the command data types become ambient globals + generated `RpcApi` methods.

- **`runactions.ts`** (extend): `getJarvisProfile(channelId): Promise<{global, override, resolved}>`, `setChannelProfile(channelId, override): Promise<void>` — thin wrappers over the generated `RpcApi`, matching the existing run-action pattern.
- **`profilemodel.ts`** (new, unit-tested): tiny pure helpers only — `sectionSource(override): { playbook: "global"|"project"; principles: "global"|"project" }` and a `isDirty(edited, saved)` check for the Save button. No merge logic (that is Go's).
- **`profilepanel.tsx`** (new): the editor, a `CollapsibleRail` slide-in toggled by a **Profile** button in the Runs header. Loads via `getJarvisProfile` on open. Renders:
  - a "merged: global + this project" header;
  - **Playbook** section — editable phase list: `kind` select (brainstorm/plan/execute/custom), `skill` text input, **GATE** and **FRESH-CTX** toggles, add / remove / reorder phase; a `[global]`/`[project]` badge with **Customize** (copy the inherited global playbook into the editable override) and **Reset-to-global** (drop the override playbook);
  - **Principles** section — a multiline textarea with the same badge + Customize / Reset-to-global;
  - **Save** → `setChannelProfile` with the assembled `ProfileOverride` (only customized sections non-nil).
- **`runssurface.tsx`** (modify): add the **Profile** toggle button to the Runs header and mount `<ProfilePanel channelId=… />`. New component kept in its own file so `runssurface.tsx` does not grow further.

## Data flow

1. User clicks **Profile** in the Runs header → `getJarvisProfile(channelId)` → `{ global, override, resolved }`.
2. Editor renders each section from `override` (badge = project if that section is non-nil, else global) showing global values where inherited.
3. User edits, clicks **Save** → `setChannelProfile(channelId, override)` → channel meta updated → WOS re-mirrors the channel.
4. Next **New Run** in that channel → `CreateRunCommand` resolves the profile server-side → the run's phases come from the resolved playbook.

## Error handling / edge cases

- **Missing global file:** `LoadGlobalProfile` returns `BuiltinProfile()`.
- **Malformed global file:** `LoadGlobalProfile` returns `BuiltinProfile()` + logs; never crashes the server.
- **Malformed override on meta:** `overrideFromMeta` returns nil + logs; the channel behaves as pure-global.
- **Empty resolved playbook** (e.g. a user saved a zero-phase override): `CreateRun` falls back to `DefaultPlaybook()` — a run always has phases.
- **Legacy channels** (no `jarvis:profile` key): resolve to pure global; behavior identical to today.
- **Empty override save:** deletes the meta key (clean reset-to-global), so the channel is indistinguishable from never-customized.
- **In-flight runs are unaffected:** a run's phases are copied at creation (`NewRun`); editing the profile changes only *future* runs.

## Testing

**Go (`pkg/jarvis/profile_test.go`):**
- `ResolveProfile` — nil override → global; nil section inherits; non-nil section replaces (playbook-only, principles-only, both).
- `LoadGlobalProfile` — missing file → builtin; malformed file → builtin.
- `BuiltinProfile` — playbook equals `DefaultPlaybook()`; principles non-empty.
- `CreateRun` resolution — an override playbook is honored; empty resolved playbook falls back to `DefaultPlaybook()`. (Engine-level test on the resolution + fallback, matching the Piece 1 run-engine test style.)

**TS (`profilemodel.test.ts`, vitest):**
- `sectionSource` — global when section nil, project when non-nil, mixed.
- `isDirty` — false when equal, true on any section change.

**Component:** `profilepanel.tsx` verified by typecheck (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`, baseline clean) + a CDP screenshot against the live dev app (open the panel, customize a section, Save, reopen to confirm persistence). No render-test harness exists for the cockpit.

## Files touched

- `pkg/waveobj/wtype.go` (**modify**) — add `JarvisProfile`, `ProfileOverride` data types (beside `Run`/`RunPhase`).
- `pkg/jarvis/profile.go` (**new**) — `BuiltinProfile`, `DefaultPrinciples`, `LoadGlobalProfile`, `ResolveProfile`, `OverrideFromMeta`.
- `pkg/jarvis/profile_test.go` (**new**).
- `pkg/jarvis/resolve.go` (**modify**) — add `MetaKey_JarvisProfile`.
- `pkg/wshrpc/wshrpctypes.go` (**modify**) — `GetJarvisProfileCommand`, `SetChannelProfileCommand` + data types.
- `pkg/wshrpc/wshserver/wshserver.go` (**modify**) — implement both commands; resolve the playbook in `CreateRunCommand`.
- generated: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts` (via `task generate`).
- `frontend/app/view/agents/runactions.ts` (**modify**) — `getJarvisProfile`, `setChannelProfile`.
- `frontend/app/view/agents/profilemodel.ts` (**new**) + `profilemodel.test.ts` (**new**).
- `frontend/app/view/agents/profilepanel.tsx` (**new**) — the editor.
- `frontend/app/view/agents/runssurface.tsx` (**modify**) — Profile toggle + mount the panel.
