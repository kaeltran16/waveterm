# Command palette (Ctrl+P) — design

Status: approved design, pre-implementation
Date: 2026-07-01
Resolves: the "Command palette (⌘K)" entry in `docs/deferred.md` (shipped so far as a render-only stub).

## Goal

Turn the render-only search box in the cockpit top app bar into a working command
palette: a keyboard-driven overlay that fuzzy-searches live agents, resumable past
sessions, and app commands, and dispatches the selected action.

## Scope (v1)

- **Sources:** live agents, resumable sessions, commands (surface navigation + New agent + New project).
- **Matching:** hand-rolled fuzzy subsequence scoring (no new dependency).
- **Open chord:** `Ctrl/Cmd+P`, fully global — it preempts the focused terminal's readline
  `Ctrl+P` (history-back). This is intentional per the user; no terminal guard.

## Architecture

Follows the existing `NewAgentModal` overlay pattern: a jotai visibility atom on the
view model, a fixed overlay rendered from `cockpit-root`, Esc / backdrop-click to close.

### Files

1. **`frontend/app/cockpit/palette-match.ts`** (new, pure, unit-tested)

   The only logic worth isolating and testing.

   ```ts
   // Case-insensitive subsequence match. Returns a score (higher = better) or
   // null when query chars do not all appear in order within text.
   export function fuzzyScore(query: string, text: string): number | null;

   // Ranks searchable items by fuzzyScore(query, item.search), descending.
   // Empty/whitespace query -> passthrough in natural (input) order.
   export function rankPaletteItems<T extends { search: string }>(items: T[], query: string): T[];
   ```

   Scoring rewards **contiguous runs** and **word-boundary starts** (so `nag`
   ranks "**N**ew **ag**ent" highly) and penalizes gaps between matched chars.
   Pure string-in / number-out; never sees action closures.

2. **`frontend/app/cockpit/command-palette.tsx`** (new)

   The overlay component. Takes `model: AgentsViewModel` (like `NewAgentModal`).
   Builds a unified `PaletteItem[]` from the three sources via `useMemo`, ranks with
   `rankPaletteItems`, renders grouped results with flat keyboard navigation.

3. **`frontend/app/view/agents/agents.tsx`** (edit)

   Add `paletteOpenAtom = atom(false)` to `AgentsViewModel`.

4. **`frontend/app/cockpit/app-bar.tsx`** (edit)

   Wire the stub button's `onClick` to open the palette; change the `⌘K` badge to `⌘P`.

5. **`frontend/app/cockpit/cockpit-root.tsx`** (edit)

   Add the global `Ctrl/Cmd+P` binding in the **capture-phase** listener (next to the
   `Ctrl+1..8` handling) so it reliably preempts the terminal; toggles `paletteOpenAtom`.
   Render `<CommandPalette model={model} />` alongside the other modals.

6. **`docs/deferred.md`** (edit) — mark the palette entry resolved; note the v1 exclusions.

### Unified item model

```ts
type PaletteItem = {
    key: string;                              // stable react key
    kind: "command" | "agent" | "session";
    search: string;                           // matched text (title + keywords)
    title: string;                            // primary label
    subtitle?: string;                        // e.g. "myproj · feat/x · opus"
    hint?: string;                            // right-aligned (session age; ⏎ on selected)
    run: () => void;                          // action dispatch (impure; component-owned)
};
```

Built in the component from the atoms:

- **Commands** — 8 surface jumps (labels from navrail `ITEMS`, `run` = `set(surfaceAtom, key)`)
  plus New agent (`set(newAgentOpenAtom, true)`) and New project (`set(newProjectOpenAtom, true)`).
- **Agents** — each `AgentVM` in `model.agentsAtom`. `search` = name + task + project;
  `run` = `model.openTerminal(id)`.
- **Sessions** — `sessionsArchiveAtom`, **resumable only** (`resumecommand` present),
  lazy-loaded via `loadSessionsArchive()` on first open (as `SessionsSurface` does).
  `run` = the same `launchAgent(...)` resume path the Sessions surface uses.

The pure ranker only reads `search`; `run` closures stay in the component, co-located
with the model — matcher stays testable, dispatch stays with state.

## Layout & interaction

Grouped, cmdk-style, fixed group order **Commands → Agents → Sessions**; each group is
headed and hidden when it has no matches. A single flat selection index spans all
visible rows.

```
┌─ Ctrl+P palette (top-aligned, w≈640) ─────────────┐
│ 🔍  new ag|                                  [esc] │
├───────────────────────────────────────────────────┤
│ COMMANDS                                           │
│  › New agent                                    ⏎  │  ← selected
│  › Go to Agent                                     │
│ AGENTS                                             │
│  ◦ loom — fix session race        myproj      2m  │
│ SESSIONS                                           │
│  ◦ Refactor parser         waveterm · main    1h  │
└───────────────────────────────────────────────────┘
```

- **Open:** `Ctrl/Cmd+P` (toggles) or click the app-bar box. Auto-focus the input; lazy-load
  sessions on first open.
- **Navigate:** ↑/↓ move selection, Enter runs the selected item then closes, Esc closes,
  backdrop click closes. Selection resets to the top row whenever the query changes.
- **Empty query:** shows the natural list (commands + live agents + resumable sessions)
  as a launcher menu.
- Styling reuses the `NewAgentModal` overlay tokens (backdrop, `bg-modalbg`, `border-edge-strong`,
  top offset ~11vh, `w-[min(640px,93vw)]`).

## Deliberately out of scope (v1)

- **Read-only sessions** (no `resumecommand`) — excluded so every row is actionable.
- **Cross-group global score sort** — grouped-with-headers is clearer for three
  heterogeneous kinds; flat global ranking is the obvious v2 if grouping feels off.
- **New dependency** — hand-rolled, consistent with the codebase's hand-rolled overlays.

## Testing

- **Unit (vitest)** — `palette-match.test.ts`: subsequence rejection, contiguity /
  word-boundary ordering, empty-query passthrough, case-insensitivity.
- **Visual (manual)** — CDP screenshot of the live dev app: open via `Ctrl+P`, type to
  filter, arrow-navigate, Enter to dispatch. No render-test harness exists (project convention).

## Implementation notes

- The spec doc folds into the feature commit (per repo doc-commit convention); it is not
  committed separately.
