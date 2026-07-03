# Keyboard Shortcuts

The cockpit is designed to be operated entirely from the keyboard. This is the reference for
every binding. It should stay in sync with the keybinding registry
(`frontend/app/store/keybindings/`) — the registry is the source of truth; this file is the
human-readable mirror.

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
  When you are typing (e.g. in the terminal), open it via the command palette → "Keyboard shortcuts".

## Global (work anywhere, including inside the terminal)

| Keys | Action |
|---|---|
| `Ctrl`+`1`…`8` | Jump to surface by position (Cockpit, Agent, Activity, Channels, Sessions, Files, Memory, Usage) |
| `Ctrl`+`P` | Command palette |
| `Ctrl`+`N` | New agent |
| `Ctrl`+`Tab` / `Ctrl`+`Shift`+`Tab` | Cycle agents (Agent surface) |
| `Ctrl`+`C` `Ctrl`+`C` (double) | Close the focused agent |

## Go-to surface — leader `g` (Navigate posture)

| Keys | Surface |
|---|---|
| `g` `h` | Cockpit (home) |
| `g` `a` | Agent |
| `g` `v` | Activity |
| `g` `c` | Channels |
| `g` `s` | Sessions |
| `g` `f` | Files |
| `g` `m` | Memory |
| `g` `u` | Usage |
| `g` `,` | Settings |
| `g` `p` | Command palette |

## Navigation within a surface (Navigate posture)

| Keys | Action |
|---|---|
| `Tab` / `Shift`+`Tab` | Cycle between regions (e.g. list → transcript → composer) |
| `j` / `k` (or `↓` / `↑`) | Move the cursor within the active region |
| `Enter` | Activate the item under the cursor |
| `Esc` | Leave Type posture, return the cursor to the active region |

## Per-surface actions (Navigate posture)

### Agents
| Keys | Action |
|---|---|
| `r` | Reply — focus the composer for the cursor agent |
| `t` | Open the agent's terminal |
| `/` | Filter the agent list |

### Files
| Keys | Action |
|---|---|
| `Enter` | Open the diff for the cursor file |
| `a` | Accept (Review mode) |
| `r` | Reject (Review mode) |
| `/` | Filter the file list |

## Help

| Keys | Action |
|---|---|
| `?` | Open the shortcut cheat sheet (Navigate posture) |
| Command palette → "Keyboard shortcuts" | Open the cheat sheet while typing |

---

*Not yet configurable.* Bindings are fixed in v1. User-remappable shortcuts
(`keybindings.json`) are a deferred enhancement — see the design spec.
