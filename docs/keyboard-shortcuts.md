# Keyboard Shortcuts

The cockpit is designed to be operated entirely from the keyboard. This is the human-readable mirror
of the keybinding registry (`frontend/app/store/keybindings/`) — **the registry is the source of
truth**; when they disagree, the registry is right and this file is stale.

Verified against `bindings.ts` on 2026-09-22.

Design spec: [`docs/superpowers/specs/2026-07-03-keyboard-operability-design.md`](superpowers/specs/2026-07-03-keyboard-operability-design.md).

## Concepts

- **Postures.** There is no global "mode" to track. Focus determines behavior:
  - **Navigate** — focus is on a surface region (not a text field). Single keys move a cursor and act on it.
  - **Type** — focus is in a text field, composer, or the terminal. Keys type normally. Press `Esc` to return to Navigate.
- **Leader (`g`, "go").** Press `g` (while not typing), then a letter, to teleport. A hint bar
  appears at the bottom of the screen showing the available next keys.
- **Which-key bar.** The transient bottom bar shown after pressing a leader — it only lists keys
  that will work in your current context.
- **Cheat sheet.** Press `?` (while not typing) to open a searchable modal of every shortcut.
  When you are typing (e.g. in the terminal), open it via Search (`Ctrl`+`P`) → Commands → "Keyboard shortcuts".

## Global (work anywhere, including inside the terminal)

| Keys | Action |
|---|---|
| `Ctrl`+`1`…`8` | Jump to surface by position — in order: Cockpit, Jarvis, Agent, Code, Diff, Sessions, Radar, Usage |
| `Ctrl`+`P` | Search — opens on the Files scope on Code (see below) |
| `Ctrl`+`N` | New agent |
| `Ctrl`+`Tab` / `Ctrl`+`Shift`+`Tab` | Next / previous agent |
| `Ctrl`+`C` `Ctrl`+`C` (double, within 500ms) | Close the focused agent |
| `.` | Focus the selected row (the cockpit narrows to that agent) |
| `Shift`+`.` | Clear focus — back to Global |

Settings has no `Ctrl`+number slot — the nine positions are bound to `SURFACE_ORDER`
(`frontend/app/view/agents/agents.tsx`), which excludes it. Reach Settings with `g` `,`.

## Go-to surface — leader `g` (Navigate posture)

| Keys | Surface |
|---|---|
| `g` `h` | Cockpit (home) |
| `g` `a` | Agent |
| `g` `c` | Jarvis — channels, records, recall |
| `g` `r` | Radar |
| `g` `s` | Sessions |
| `g` `f` | Files |
| `g` `u` | Usage |
| `g` `b` | Code — browse source |
| `g` `,` | Settings |
| `g` `p` | Search |

## Search (`Ctrl`+`P`)

One overlay with scopes: All, Go to, Agents, Runs, Sessions, Records, Projects, Files, Commands.

| Keys | Action |
|---|---|
| `Tab` / `Shift`+`Tab` | Next / previous scope |
| `@` `/` `#` `>` typed first in All | Jump to Agents, Sessions, Projects, Commands |
| `Backspace` on an empty query | Leave a picker, then drop back to All |
| `path:123` in Files | Open the file at that line; a bare `:123` on Code moves the open file |

In All, text that names nothing is a goal: the Start rows run it as a Quick worker, an orchestrator
run, or a one-shot ask. When the text names something, Enter opens that, and one "Start as a goal"
row below expands into the same choices.

## Navigation within a surface (Navigate posture)

| Keys | Action |
|---|---|
| `[` / `]` | Previous / next surface (cycles `SURFACE_ORDER`, wraps) |
| `j` / `k` (or `↓` / `↑`) | Move the cursor within the active region |
| `Enter` | Open / activate the item under the cursor |
| `Esc` | On a deep surface (Jarvis, Radar, Sessions, Files, Usage, Code), return to the Cockpit. In a composer or text field, leave Type posture first. |

## Per-surface actions (Navigate posture)

### Cockpit

| Keys | Action |
|---|---|
| `j` / `k` | Next / previous card or task row |
| `n` | Jump to the next ask |
| `h` / `l` (or `←` / `→`) | Move to the other column; on an ask with several questions, switch question |
| `1`…`9` on a task row | Answer the worker's question, else run the row's action |
| `Enter` on a task row | Send the worker's answer, else open the worker |
| `1`…`9` | Select an answer option |
| `Enter` | Confirm the answer, else open focus |
| `r` | Reply inline to the agent |
| `t` | Open the agent's terminal |
| `b` | Background the agent (keeps it running) |

### Agent

| Keys | Action |
|---|---|
| `j` / `k` (or `←` / `→`) | Previous / next agent |
| `d` | Toggle the agent rail |
| `f` | Toggle terminal fullscreen |
| `Esc` | Back to Cockpit, or exit fullscreen first |
| `Shift`+`Esc` | Return focus to the nav (from inside the terminal) |

### Jarvis

| Keys | Action |
|---|---|
| `i` | Focus the composer |
| `/` | Filter the Brief's rows (`Esc` clears) |
| `Enter` | Open the row under the cursor |
| `Alt`+`↑` / `Alt`+`↓` | Move the chunk under the cursor up / down within its stage |
| `d` | Toggle the context rail |
| `e` | Expand / collapse the record band |
| `c` | New channel |
| `Shift`+`G` | Graph peek (`Esc` closes) |
| `Shift`+`J` / `Shift`+`K` | Next / previous run in this channel |
| `j` / `k` | With a run sheet open: next / previous run in the list it counts (Runs, or Shipped for a finished run) |
| `1`…`9` | Answer an ask option on a run body |
| `Enter` | Submit the answer |
| `Esc` | Leave the composer |

### Files — Review mode

| Keys | Action |
|---|---|
| `a` | Accept the next hunk |
| `r` | Reject the next hunk |
| `u` | Undo the last decision |
| `j` / `k` (or `↓` / `↑`) | Next / previous file |
| `Enter` | Apply the review |

### Route DAG (the orchestrator run's graph)

| Keys | Action |
|---|---|
| `j` / `k` | Next / previous task, in plan order |
| `Enter` (or double-click a task) | Open the task's worker in the Agent surface, or its child run once the session is gone |
| `Esc` | Close the graph |

Resting the pointer on a task shows its peek: the full title and description, what it is waiting on,
its latest activity, and why it failed.

## Help

| Keys | Action |
|---|---|
| `?` (`Shift`+`/`) | Open the shortcut cheat sheet (Navigate posture) |
| Search → Commands → "Keyboard shortcuts" | Open the cheat sheet while typing |

---

*Not yet configurable.* Bindings are fixed in v1. User-remappable shortcuts
(`keybindings.json`) are a deferred enhancement — see the design spec.
