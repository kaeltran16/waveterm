# Keyboard Shortcuts

The cockpit is designed to be operated entirely from the keyboard. This is the human-readable mirror
of the keybinding registry (`frontend/app/store/keybindings/`) — **the registry is the source of
truth**; when they disagree, the registry is right and this file is stale.

Verified against `bindings.ts` on 2026-07-31.

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
| `Ctrl`+`1`…`8` | Jump to surface by position — in order: Cockpit, Jarvis, Agent, Radar, Sessions, Files, Memory, Usage |
| `Ctrl`+`P` | Command palette |
| `Ctrl`+`N` | New agent |
| `Ctrl`+`Tab` / `Ctrl`+`Shift`+`Tab` | Next / previous agent |
| `Ctrl`+`C` `Ctrl`+`C` (double, within 500ms) | Close the focused agent |

Settings has no `Ctrl`+number slot — the eight positions are bound to `SURFACE_ORDER`
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
| `g` `m` | Memory |
| `g` `u` | Usage |
| `g` `,` | Settings |
| `g` `p` | Command palette |

## Navigation within a surface (Navigate posture)

| Keys | Action |
|---|---|
| `[` / `]` | Previous / next surface (cycles `SURFACE_ORDER`, wraps) |
| `j` / `k` (or `↓` / `↑`) | Move the cursor within the active region |
| `Enter` | Open / activate the item under the cursor |
| `Esc` | On a deep surface (Jarvis, Radar, Sessions, Files, Memory, Usage), return to the Cockpit. In a composer or text field, leave Type posture first. |

## Per-surface actions (Navigate posture)

### Cockpit

| Keys | Action |
|---|---|
| `j` / `k` | Next / previous agent |
| `n` | Jump to the next ask |
| `h` / `l` (or `←` / `→`) | Switch question on a multi-question ask |
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
| `d` | Toggle the context rail |
| `e` | Expand / collapse the record band |
| `n` | New thread |
| `c` | New channel |
| `Shift`+`G` | Graph peek (`Esc` closes) |
| `Shift`+`J` / `Shift`+`K` | Next / previous run in this channel |
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

## Help

| Keys | Action |
|---|---|
| `?` (`Shift`+`/`) | Open the shortcut cheat sheet (Navigate posture) |
| Command palette → "Keyboard shortcuts" | Open the cheat sheet while typing |

---

*Not yet configurable.* Bindings are fixed in v1. User-remappable shortcuts
(`keybindings.json`) are a deferred enhancement — see the design spec.
