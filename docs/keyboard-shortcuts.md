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
| `Ctrl`+`1`…`7` | Jump to surface by position — in order: Cockpit, Jarvis, Agent, Code, Diff, Sessions, Usage |
| `Ctrl`+`P` | Search — opens on the Files scope on Code (see below) |
| `Ctrl`+`N` | New agent |
| `Ctrl`+`Tab` / `Ctrl`+`Shift`+`Tab` | Next / previous agent |
| `Ctrl`+`C` `Ctrl`+`C` (double, within 500ms) | Close the focused agent |

Setup and Settings have no `Ctrl`+number slot — the nine positions are bound to `SURFACE_ORDER`
(`frontend/app/view/agents/agents.tsx`), which excludes them. Reach Setup with `g` `.` and Settings with `g` `,`.

## Go-to surface — leader `g` (Navigate posture)

| Keys | Surface |
|---|---|
| `g` `h` | Cockpit (home) |
| `g` `a` | Agent |
| `g` `c` | Jarvis — channels, records, recall |
| `g` `s` | Sessions |
| `g` `f` | Files |
| `g` `u` | Usage |
| `g` `b` | Code — browse source |
| `g` `.` | Setup — instructions and skills |
| `g` `,` | Settings |
| `g` `p` | Search |
| `g` `m` | Resource Manager (the popover over the footer's `Arc … CPU` readout) |

## Search (`Ctrl`+`P`)

One overlay with scopes: All, Needs you, Go to, Agents, Runs, Sessions, Records, Notes, Projects, Files, Commands.

| Keys | Action |
|---|---|
| `Tab` / `Shift`+`Tab` | Next / previous scope |
| `n:` `g:` `a:` `r:` `s:` `re:` `no:` `p:` `f:` `c:` typed first in All | Narrow to Needs you, Go to, Agents, Runs, Sessions, Records, Notes, Projects, Files, Commands. A `\` or `/` right after the colon keeps it as text, so a pasted `c:\path` stays a query |
| `@` `/` `#` `>` typed first in All | Jump to Agents, Sessions, Projects, Commands (the older sigils) |
| `→` with the caret at the end of the query | Open the selected row's actions (a run, agent, session, record, initiative or project). Mid-query, `→` moves the caret |
| `←` or `Backspace` on an empty action filter | Leave an action's input, then the action list, back to the results with the query and selection as they were |
| `1`…`9` in Needs you | Answer the selected ask with that option, in place |
| `Enter` in Notes | Copy the selected note as markdown and close |
| `Del` twice in Notes, caret at the end of the query | Delete the selected note. Any other key after the first `Del` cancels |
| `Ctrl`+`Enter` on a note in Notes | Edit it: the palette becomes the editor |
| `Enter` on "New note", the last row in Notes | Write a note; the query becomes its title |
| In the note editor: `Ctrl`+`Enter` / `Tab` / `Esc` | Save / move between title and body (`Enter` in the title moves to the body) / back to the Notes list, pressed twice when there are unsaved changes. `Ctrl`+`P` and a click outside go back the same way |
| `Ctrl`+`Enter` | The selected row's alternate action, named in the footer. On the goal block, open an orchestrator run instead of a Quick one |
| `Backspace` on an empty query | Leave a picker, then drop back to All |
| `path:123` in Files | Open the file at that line; a bare `:123` on Code moves the open file |
| `@` typed first in Files on Code | List the open file's symbols instead of files; `Enter` moves the file to the one selected |

In All, text that names nothing is a goal: Quick and Orchestrate open the New run window with it
filled in and the active (else last used) project preselected, so the project is confirmed there
before anything starts; the Ask rows send it as a one-shot ask in that project. When the
text names something, Enter opens that, and one "Start as a goal" row below expands into the same
choices. A verb names something too: "cancel" lists "Cancel run · <run>" for each run that can be
cancelled now, in All and in Commands, so it never starts a run named "cancel".

## Navigation within a surface (Navigate posture)

| Keys | Action |
|---|---|
| `[` / `]` | Previous / next surface (cycles `SURFACE_ORDER`, wraps) |
| `j` / `k` (or `↓` / `↑`) | Move the cursor within the active region |
| `Enter` | Open / activate the item under the cursor |
| `Space` | Peek the item under the cursor in the avatar popup, without leaving the surface (see Peek below) |
| `Esc` | On a deep surface (Jarvis, Sessions, Files, Usage, Code), go back to the surface you jumped from (opening a run, file, diff or agent from elsewhere), else return to the Cockpit. In a composer or text field, leave Type posture first. |

## Resource Manager (the popover opened from the footer's readout or `g` `m`)

| Keys | Action |
|---|---|
| `↑` / `↓` | Move the cursor through the groups and their processes |
| `Enter` | Confirm an open kill, else expand or collapse the cursor's group |
| `x` | Kill the process under the cursor and its children (asks first; never the agent itself) |
| `Shift`+`X` | Kill every process the cursor's group started, keeping the agent and its console (asks first) |
| `Esc` | Cancel an open kill, else close the popover |

While the popover is open its keys take precedence: the surface underneath does not move. A click outside it
closes it.

## Peek (the avatar popup's item view)

A peek shows a run, agent, record, initiative or memory note in the avatar popup. It writes no
selection on the surface underneath. `Space` on a row cursor peeks it;
holding `Ctrl` underlines every link that can be peeked, and `Ctrl`+click on one peeks it instead of opening it.
`Space` never peeks while focus is in a text field.

| Keys | Action |
|---|---|
| `Enter` | Open the item on its own surface (absent for a memory note, which opens nowhere else) |
| `Backspace` | Back to the avatar popup's hub |
| `Esc` | Close the popup, or return to the hub if the item was opened from it |

A link inside an item view does a full open, even with `Ctrl` held.

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
| `r` | Review: open the focused lead's Spec review or Plan review dialog |
| `Esc` | Close an open shell task output peek, or an open subagent (back to the agent's terminal), else back to where you jumped from, else to Cockpit; exits fullscreen first |
| `Shift`+`Esc` | Return focus to the nav (from inside the terminal) |

### Agent: canvas mode

`c` works when the focused agent has a canvas. In canvas mode, `[` / `]`, `d`, `f`, `F11` and `Esc` do not do their usual jobs; the agent keys (`j` / `k`, the arrows, `Ctrl`+`Tab`) still move between agents, since the tree stays beside the canvas.

| Keys | Action |
|---|---|
| `c` | Show the agent's canvas; from the canvas, back to the terminal |
| `Ctrl`+`Shift`+`B` | The same switch, and it also works while typing in the terminal |
| `[` / `]` | Previous / next board |
| `m` | Mark part of the board; in mark mode, stop marking |
| `Enter` / `Esc` | In the note under a drawn box: send the mark to the agent / drop it |

### Agent: brainstorm mode

`b` works when the focused agent has a brainstorm; such an agent never shows canvas mode, so `c` does nothing for it. In brainstorm mode, `d`, `f` and `F11` do not do their usual jobs, and `Esc` steps back inside the brainstorm instead of leaving the surface; the agent keys (`j` / `k`, the arrows, `Ctrl`+`Tab`) still move between agents, since the tree stays beside the brainstorm, except that `j` / `k` move between decisions while the builder check's review fills the main area (the arrows and `Ctrl`+`Tab` still move between agents there).

| Keys | Action |
|---|---|
| `b` | Show the agent's brainstorm; from the brainstorm, back to the terminal (while the question offers a B, `b` picks it instead) |
| `Ctrl`+`Shift`+`B` | The same switch, and it also works while typing in the terminal or while `b` picks an answer |
| `a` / `b` / `c` / `d` | While the brainstorm asks a question with answers to pick from: focus that answer; `Enter` sends it |
| `Esc` | Back one level, as the pane's back control does: from a full-size board to the question or design it was opened from; from the design opened over the question (or over the agent writing) back to it. A focused field keeps its own `Esc`, and on a board with a drawn mark `Esc` stays the mark note's |
| `j` / `k` | In the builder check's review: next / previous decision |
| `Enter` | In the review: show or hide what the cursor decision was (a focused button keeps its own `Enter`) |
| `y` | In the review: keep the cursor decision's change; on a guess, confirm it |
| `u` | In the review: put mine back |

### Jarvis

| Keys | Action |
|---|---|
| `i` | Focus the composer |
| `/` | Filter the Brief's rows (`Esc` clears) |
| `Enter` | Open the row under the cursor |
| `w` | Work on the initiative under the cursor in a new agent, or go to the agent already open on it |
| `Alt`+`↑` / `Alt`+`↓` | Move the chunk under the cursor up / down within its stage |
| `d` | Toggle the context rail |
| `e` | Expand / collapse the record band |
| `c` | New channel |
| `Shift`+`G` | Graph peek (`Esc` closes) |
| `Shift`+`J` / `Shift`+`K` | Next / previous run in this channel |
| `j` / `k` | With a run sheet open: next / previous run in the list it counts (Runs, or Shipped for a finished run) |
| `1`…`9` | With a run sheet open: pick an option on the lead's question card |
| `Enter` | Submit the answer |
| `Esc` | Leave the composer |

### Diff

| Keys | Action |
|---|---|
| `j` / `k` (or `↓` / `↑`) | Next / previous commit or file |
| `Enter` | Open the file under the cursor |
| `/` | Filter history (`Esc` clears) |
| `Shift`+`G` | Toggle the history graph |
| `g` `g` | Top of history |
| `Shift`+`H` | Collapse / expand history |
| `Shift`+`N` / `Shift`+`P` | Next / previous change in the open diff |
| `Shift`+`D` | Split / unified |
| `Shift`+`W` | Ignore whitespace |
| `v` | Mark the open file reviewed (or unmark it) and open the next unreviewed file |
| `m` | Comment on the selected lines of the open diff, or the cursor's line (also from the editor) |
| `Ctrl`+`Enter` / `Esc` | Add / cancel the comment being written |
| `Shift`+`Enter` | Send the pending comments to the agent |
| `r` | Refresh changes and history |
| `c` | In history: compare refs. In compare: change the compared refs |
| `Shift`+`S` | Swap compare refs (in compare) |
| `Tab` | Switch compare side (in compare) |
| `Esc` | Clear filters, else leave compare, else back to the Cockpit |

### Files — Review mode

| Keys | Action |
|---|---|
| `a` | Accept the next hunk |
| `r` | Reject the next hunk |
| `u` | Undo the last decision |
| `j` / `k` (or `↓` / `↑`) | Next / previous file |
| `Enter` | Apply the review |

### Code

The ones marked "from the editor" also work while the caret is in the editor; the rest need focus
outside it. The tree keys work while the file tree holds focus.

| Keys | Action |
|---|---|
| `Alt`+`←` / `Alt`+`→` | Back / forward through opened files and jumps |
| `r` | Refresh the file index |
| `d` | Toggle the diff against HEAD |
| `Ctrl`+`S` | Save the open file (from the editor) |
| `Ctrl`+`Shift`+`F` | Search file contents (from the editor) |
| `Ctrl`+`Shift`+`O` | Go to a symbol in the open file: opens Search seeded with `@` (from the editor) |
| `F12` | Go to the definition of the word at the caret: one match jumps there, several list in Search (from the editor) |
| `Shift`+`F12` | Find references to the word at the caret, in Search (from the editor) |
| `Alt`+`T` / `Alt`+`E` | Focus the file tree / the editor (from the editor) |
| `j` / `k` (or `↓` / `↑`) in the tree | Next / previous file or folder |
| `←` / `→` in the tree | Collapse / expand the folder |
| `Enter` in the tree | Open the file, or toggle the folder |
| `n` / `Shift`+`N` in the tree | New file / new folder in the cursor's directory |
| `F2` / `Del` in the tree | Rename / delete the cursor row |

### Route DAG (the orchestrator run's graph)

| Keys | Action |
|---|---|
| `j` / `k` | Next / previous task, in plan order |
| `←` / `→` | Follow an edge to the nearest dependency / dependent |
| `↑` / `↓` | Previous / next task in the same column |
| `Enter` (or double-click a task) | Open the task's worker in the Agent surface, or its child run once the session is gone |
| `f` | Fit the whole graph |
| `+` / `-` | Zoom in / out |
| `Esc` | Clear the selection; with nothing selected, close the graph |

Clicking a task opens its peek beside it: the title, its worker session, route, review, model, tokens,
description, Verify output and the actions it needs; a second click, a background click or `Esc` closes it.
Hovering only highlights the task. Drag a task to move it (its place is
kept for that run until Reset layout); drag empty canvas to pan. A dashed band marks a lane: tasks that merge as one.

### Final check viewer (a run's Final check screenshots, opened from its run sheet)

| Keys | Action |
|---|---|
| `↑` / `↓` | Previous / next scenario |
| `←` / `→` | Previous / next screenshot of the scenario |
| `z` | Fit / actual size |
| `s` | Show or hide the steps |
| `Esc` | Close the viewer; the run sheet stays open |

While the viewer is open these are the only cockpit keys: the surface underneath does not move.

## Help

| Keys | Action |
|---|---|
| `?` (`Shift`+`/`) | Open the shortcut cheat sheet (Navigate posture) |
| Search → Commands → "Keyboard shortcuts" | Open the cheat sheet while typing |

---

*Not yet configurable.* Bindings are fixed in v1. User-remappable shortcuts
(`keybindings.json`) are a deferred enhancement — see the design spec.
