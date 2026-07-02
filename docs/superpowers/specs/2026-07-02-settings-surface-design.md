# Settings surface — design + implementation

Date: 2026-07-02
Status: approved, ready to implement

## Goal

Add a Settings surface to the cockpit exposing five preferences. Two write Wave's
`settings.json` (via the already-existing config RPC); three are frontend-only,
persisted in `localStorage`. No Go changes, no `task generate`.

## Settings in scope (v1)

1. **Default startup surface** — which surface opens on launch (today hardcoded `cockpit`).
2. **Details rail visible by default** — surfaces the existing `railVisibleAtom` pref.
3. **Persisted New Agent launch flags** — makes the New Agent modal's per-runtime flag
   set (and the "Remember" toggle) durable across restarts, editable here.
4. **Terminal font size** — `settings.json` key `term:fontsize` (agent terminals' default).
5. **Memory vault path** — `settings.json` key `memory:vaultpath` (repoints the Memory surface).

Explicitly **out of scope:** theme/appearance. `frontend/tailwindsetup.css` has a single
hardcoded dark `@theme` palette with no light variant and no `data-theme` switcher; a theme
system is a separate, larger effort.

## Architecture

The cockpit has no traditional tabs — it has **surfaces** switched via the left `NavRail`
(`frontend/app/view/agents/navrail.tsx`). Adding one is a known pattern:

- `SurfaceKey` union + `SURFACE_ORDER` live in `frontend/app/view/agents/agents.tsx`.
- `SURFACE_ORDER` drives both `Ctrl+1..8` (in `cockpit-root.tsx`) and the rail's workflow list.
- `cockpitshell.tsx` renders the active surface by branching on `surfaceAtom`.

### Placement decision

`"settings"` is added to the `SurfaceKey` union but **NOT** to `SURFACE_ORDER`. Rationale:
`SURFACE_ORDER` is the numbered workflow set (`Ctrl+1..8` already saturates 1–8). Settings is
a preferences surface, conventionally set apart. The NavRail renders it as a gear button
pinned to the bottom (flex spacer between the workflow items and the gear).

### Persistence — two mechanisms, both pre-existing conventions

- **localStorage** via `atomWithStorage` (jotai/utils). Established by
  `railstore.ts::railVisibleAtom` (`"agent.rail.visible"`). Used for settings 1–3.
- **`settings.json`** via `RpcApi.SetConfigCommand(client, { "<key>": value })`. The server
  handler (`wconfig.SetBaseConfigValue`, `pkg/wconfig/settingsconfig.go:854`) **merges** —
  it reads the existing file and sets only the provided keys (a `nil` value deletes a key),
  and validates each key server-side. So a single-key write never clobbers other settings.
  Reads use `getSettingsKeyAtom("<key>")` (reactive atom over the config that streams to the
  FE over the websocket). Used for settings 4–5. The keys already exist in `SettingsType`, so
  there is no schema change and no codegen.

### Launch-flag persistence (DRY note)

The New Agent modal (`newagentmodal.tsx`) already reads/writes `naFlagsAtom` and
`naRememberFlagsAtom` (`naflagsstore.ts`) as its single source of truth for live flag state.
Upgrading those two atoms from `atom(...)` to `atomWithStorage(...)` makes persistence fall
out for free — the modal's existing "Remember off → clear after launch" logic still works,
and the Settings surface becomes a *second editor of the same atom*. No new state, no sync.

## Data flow

- **Startup surface:** `startupSurfaceAtom` (localStorage) is read once in `CockpitBody`'s
  model-init block and applied via `globalStore.set(model.surfaceAtom, <pref>)`. The Settings
  picker writes the atom; it takes effect on next launch (not retroactively mid-session — no
  need, the user is already navigating).
- **Rail default:** the Settings toggle binds directly to `railVisibleAtom`.
- **Launch flags:** Settings edits `naFlagsAtom` / `naRememberFlagsAtom`; modal reads them.
- **Config keys:** Settings reads via `getSettingsKeyAtom`, writes via `SetConfigCommand`
  **on commit** (blur / Enter / explicit Save), not per-keystroke, to avoid hammering the file.

## Surface layout (`settingssurface.tsx`)

Sections styled like the modal's `Section` component (uppercase mono label + body):

- **General**
  - Startup surface — segmented buttons over `SURFACE_ORDER` filtered to remove `agent`
    (needs a live agent to be meaningful) and `settings`.
  - Details rail visible by default — toggle (same switch styling as the modal's worktree toggle).
- **New Agent defaults**
  - Runtime selector (Claude/Codex/Antigravity/Terminal, reusing the modal's `RUNTIMES` shape)
    → per-runtime flag checklist from `RUNTIME_FLAGS[runtime]`, toggling `naFlagsAtom`.
  - "Remember" toggle → `naRememberFlagsAtom`.
- **Terminal**
  - Font size — number input; commit writes `SetConfigCommand({ "term:fontsize": n })`.
    Coerce/validate to a sane range (see Implementation).
- **Memory**
  - Vault path — text input + Save; commit writes `SetConfigCommand({ "memory:vaultpath": s })`.

Follow project conventions: Tailwind + `@theme` tokens only (no SCSS, no raw hex).

## Testing

- Unit (vitest): `startupSurfaceOptions()` returns `SURFACE_ORDER` minus `agent` (and
  `settings` is absent because it was never in `SURFACE_ORDER`).
- Unit (vitest): font-size input coercion — non-numeric / out-of-range input is clamped or
  rejected, not written.
- Visual: CDP against the live dev app (`node scripts/cdp-shot.mjs`) — no render-test harness
  exists for the cockpit.

## Implementation

Ordered steps. Each references the file(s) touched.

1. **`naflagsstore.ts`** — change `naFlagsAtom` to
   `atomWithStorage("agent.launch.flags", {})` and `naRememberFlagsAtom` to
   `atomWithStorage("agent.launch.remember", true)`. Import `atomWithStorage` from
   `jotai/utils`. No other file changes needed — the modal reads the same atoms.

2. **`cockpitprefsstore.ts`** (new) — export
   `startupSurfaceAtom = atomWithStorage<SurfaceKey>("cockpit.startup.surface", "cockpit")`
   and a pure `startupSurfaceOptions(): SurfaceKey[]` = `SURFACE_ORDER.filter(k => k !== "agent")`.

3. **`agents.tsx`** — add `"settings"` to the `SurfaceKey` union. Do **not** add it to
   `SURFACE_ORDER`.

4. **`settingssurface.tsx`** (new) — the surface component with the four sections above.
   Reuse the modal's `Section` label style and toggle/checkbox styling. Config inputs use
   local `useState` seeded from `useAtomValue(getSettingsKeyAtom(...))`, committing via
   `RpcApi.SetConfigCommand(TabRpcClient, { ... })` on blur/Enter/Save.

5. **`cockpitshell.tsx`** — import `SettingsSurface`; add
   `... : surface === "settings" ? <SettingsSurface model={model} /> : ...` to the branch chain.

6. **`navrail.tsx`** — add a gear glyph; render the workflow `ITEMS` in the existing loop,
   then a `flex-1` spacer, then a single Settings button (active when `surfaceAtom === "settings"`)
   pinned at the bottom. Keep the existing active-state styling (accent bar + tint).

7. **`cockpit-root.tsx`** — in `CockpitBody`'s one-time model-init block (where `agentsModelRef`
   is first populated), after the model is created, read `globalStore.get(startupSurfaceAtom)`
   and `globalStore.set(model.surfaceAtom, pref)`.

8. **Tests** — add `cockpitprefsstore.test.ts` (option list) and a font-size coercion test
   (either colocated or in the surface's test file).

9. **Verify** — `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
   (baseline has ~3 pre-existing `api.test.ts` errors), `npx vitest run`, then CDP visual check.
