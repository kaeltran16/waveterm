# Ctrl+P fast-dispatch — implementation spec

**Status:** spec (approved-pending review). **Date:** 2026-07-13.
**Depends on / sibling of:** `2026-07-13-channels-runs-merged-surface-design.md` (the merged surface). This spec is a **self-contained, buildable-now** slice that does **not** wait on the surface redesign.

---

## 1. Goal

Extend the existing command palette so you can **launch work into the active channel by typing a goal and picking a mode** — the keyboard-shortcut equivalent of the merged composer's *launch face*. The composer stays the primary launcher; `Ctrl+P` is a fast path to the same actions, reachable from any surface.

Non-goal: replace the composer, or change any backend. This reuses existing actions and RPCs.

---

## 2. Current state (what we build on)

- `frontend/app/cockpit/command-palette.tsx` — a `Ctrl+P` fuzzy-search overlay (bound in `keybindings/bindings.ts` as `palette` / `g p`). Groups today: **Commands** (Go to <surface>, New agent, New project, Keyboard shortcuts), **Agents** (jump to a live agent), **Sessions** (resume). Each item fires `run()` immediately.
- `frontend/app/cockpit/palette-match.ts` — `rankPaletteItems(items, query)` fuzzy-filters by `item.search`.
- Existing actions: `channelactions.ts#sendChannelMessage`, `runactions.ts#createRun`, `runactions.ts#getJarvisProfile`.
- Active channel: `channelsstore.ts#activeChannelAtom` (a `Channel | null`; fields `oid`, `name`, `projectpath`).

**Key constraint:** launch rows must **not** go through `rankPaletteItems`. The typed text is the *goal*, not a filter — fuzzy-matching "fix auth" against a row named "Quick" would drop the row. Launch rows are a separate, always-shown lead group.

---

## 3. Behavior

### 3.1 When launch rows appear
Only when **(a)** the query is non-empty (trimmed) **and (b)** there is an active channel (`activeChannelAtom != null`). Otherwise the palette behaves exactly as today.

- Empty query → no launch group (palette default view unchanged; non-disruptive).
- No active channel → no launch group. (Limitation: a channel is "active" once the user has selected one; `CockpitShell` primes the channel list at boot but does not auto-select. A future improvement may default to the most-recent channel. Documented, not built.)

### 3.2 The launch group
A lead group titled **`Launch in #<channel name>`**, placed above the ranked Commands/Agents/Sessions groups. It is not fuzzy-filtered. Rows (in order; the first is preselected so `Enter` on a typed goal launches it):

| Row | Action | Wiring |
|---|---|---|
| **Quick · claude** | spawn one worker on the goal, no phases | `sendChannelMessage({ text: "@claude " + goal, … })` |
| **Run · `<strategy>`** | a managed run using the channel's strategy | `createRun(oid, goal, { mode, planGate })` where `mode`/`planGate` come from the channel's Jarvis profile |
| **Ask · claude** | one-shot consult, no worker | `sendChannelMessage({ text: "ask @claude " + goal, … })` |
| **Ask · codex** | one-shot consult, no worker | `sendChannelMessage({ text: "ask @codex " + goal, … })` |

- **Default selection = Quick** (the palette is the *fast-dispatch* shortcut; Quick is the fast one-off). Easily changed.
- **`Run` strategy resolution:** the pipeline-vs-orchestrator choice (+ plan gate) is a per-channel setting. Fetch it via `getJarvisProfile(oid)` → `resolved.defaultmode` / `resolved.defaultplangate`. Pre-fetch on active-channel change so the row can label itself `Run · pipeline` / `Run · orchestrator`; if not yet loaded, label plain `Run` and resolve at click time. Fall back to `{ mode: "pipeline", planGate: true }` (the Superpowers default) when unset.
- **After firing any row:** switch surface to `channels` (`globalStore.set(model.surfaceAtom, "channels")`) so the result is visible, then close the palette.

### 3.3 `@`/`ask` text synthesis (internal transport)
Quick and Ask reuse `sendChannelMessage`, which parses a leading `@runtime` / `ask @runtime`. The palette synthesizes that string internally — **the user never types `@`.** The goal is trimmed first. Inner `@` inside the goal is preserved (`parseMentions` only strips *leading* mentions), so `"add @mentions to X"` dispatched Quick yields body `"add @mentions to X"`. This is deliberate: the parser stays as the transport layer; only the user-facing `@magic` is removed.

---

## 4. Implementation shape

### New file: `frontend/app/cockpit/palette-launch.ts` (pure)
```
export interface LaunchItem { key: string; title: string; subtitle: string; run: () => void; }
export interface LaunchDeps {
  dispatch: (runtime: string, goal: string) => void;      // Quick: one worker
  run: (goal: string) => void;                            // managed run, channel strategy
  consult: (runtime: string, goal: string) => void;       // Ask: one-shot, no worker
}
// Empty goal or no channel -> []. Otherwise the 4 rows above, keyed launch:quick|run|consult:claude|consult:codex.
export function buildLaunchItems(query: string, channelName: string | undefined,
                                 runLabel: string, deps: LaunchDeps): LaunchItem[]
```
`runLabel` lets the caller pass `"Run · pipeline"` etc. (or `"Run"` before the profile loads). Pure — the component injects the impure deps.

### Edit: `frontend/app/cockpit/command-palette.tsx`
- Add `PaletteKind` `"launch"`; add `channel = useAtomValue(activeChannelAtom)` and a small effect that fetches `getJarvisProfile(channel.oid)` into local state on channel change.
- Build launch `PaletteItem[]` from `buildLaunchItems(...)` with deps that call `sendChannelMessage` / `createRun` (+ surface switch + close).
- Compose `groups = [launchGroup?, ...rankedGroups]`; render each group's label from a `label` field (launch group's label is dynamic `Launch in #<name>`; the others keep `GROUP_LABELS`). Keyboard nav (`flat`, `sel`, Enter) already operates on the flattened group list — no change beyond including the launch group.

No other files change. No backend, no generated files, no keybinding change.

---

## 5. Testing

Test-**after** (not TDD, per direction):
- Unit (`vitest`) on `buildLaunchItems`: returns `[]` without goal/channel; produces the 4 keyed rows; each row's `run()` calls the right dep with the trimmed goal.
- Visual-verify on the live dev app over CDP (`scripts/cdp-shot.mjs`): open `Ctrl+P`, type a goal → launch group leads; select **Run** → a run appears in the active channel; select **Quick** → a worker is dispatched.

---

## 6. Out of scope / deferred

- Composer changes (the merged surface — owned by the design brief).
- A true one-phase "Quick" **backend** Run mode (Quick currently = the existing dispatch path, a bare worker-tab, not a `Run`).
- `>`-prefix to switch the palette into command-only search (disambiguates "goal" vs "command filter" when a query also matches a command). For now both show; launch group leads.
- Auto-selecting a default channel when none is active.

---

## 7. Decisions carried in (see the design brief's log for full context)

- **Launch modes = Quick · Run · Ask.** Pipeline & orchestrator collapse into one **Run**; the strategy (pipeline|orchestrator + plan gate) is the channel's ⚙ profile setting, not a per-launch choice.
- Palette **complements** the composer (fast shortcut), never replaces it.
- `@mention` incantations are removed from the user's hands; they remain only as internal transport for `sendChannelMessage`.
