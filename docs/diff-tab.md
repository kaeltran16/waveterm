# The Diff tab — end to end

How to use the Diff surface: what every control does, in the order you would reach for it. It is
both the reference and the tour, because the surface is small enough not to need two.

Source of truth for behaviour is the code: `frontend/app/view/agents/filessurface.tsx` and the
stores beside it (`filesstore.ts`, `githistorystore.ts`, `comparestore.ts`). Keybindings come from
`frontend/app/store/keybindings/bindings.ts` (`buildFilesBindings`).

**One sentence:** the Diff surface is a read-only Git review pane — pick a repository, pick a range,
walk its commits, and read one file's changes at a time. It never writes to the repository.

Every screenshot below was driven against the **live dev app** over CDP on 2026-09-04, scoped to this
repository with three files dirty in the working tree. Nothing is mocked.

- [1. Getting there](#1-getting-there)
- [2. The subject bar — what you are looking at](#2-the-subject-bar--what-you-are-looking-at)
- [3. Ranges](#3-ranges)
- [4. The three panes](#4-the-three-panes)
- [5. Filtering and paging history](#5-filtering-and-paging-history)
- [6. Compare two refs](#6-compare-two-refs)
- [7. Reading the diff pane](#7-reading-the-diff-pane)
- [8. When something is wrong](#8-when-something-is-wrong)
- [9. Keyboard](#9-keyboard)
- [10. Arriving from elsewhere](#10-arriving-from-elsewhere)
- [11. The other diff — the Code surface](#11-the-other-diff--the-code-surface)
- [12. What it deliberately cannot do](#12-what-it-deliberately-cannot-do)
- [13. Comments to the agent](#13-comments-to-the-agent)

---

## 1. Getting there

| Gesture | Effect |
|---|---|
| Nav rail → **Diff** | The sixth item in the rail |
| `Ctrl`+`6` | Jump by position (`SURFACE_ORDER` index 5) |
| `g` `f` | Chord: go → Diff |
| `]` / `[` | Cycle to the next / previous surface |

The surface unmounts when you leave it. That is deliberate and mostly invisible: scroll position,
filters, the selected commit and the selected file are all kept in module-level atoms, so returning
puts you back where you were rather than at row zero.

---

## 2. The subject bar — what you are looking at

Three controls on one line, then a quiet summary under them.

**The source picker** (the dropdown next to the "Diff" title) chooses *whose repository* you are
reading. It lists two groups:

- **Agents** — every running agent, each with its state dot. Picking one also moves the cockpit's
  focus to that agent, so you can inspect a diff without bouncing back to the Agent surface first.
- **Projects** — every entry in the project registry, resolved straight from its configured path.
  No agent needs to be running.

A third kind of subject exists but is not in the list: a **run**. You get there by opening a diff
from a finished run's evidence, and the picker then shows that run's own label rather than falling
back to "Select a source".

Once a source is picked, the surface follows the focused agent *only while the scope is an agent*.
Pin a project, or arrive from a run, and changing focus elsewhere no longer drags this surface with
it.

**The range strip** is the chip row beside the picker — see the next section.

**The summary line** under the bar is text, not a control. It restates the range in git's own terms
plus the totals, e.g. `uncommitted work against HEAD on main · 12 files · +340 −86`. In compare
mode it reports **the comparison's** totals — `main … feat · 3 files · +30 −0` — and names the two
refs in the same `base … head` order as the chip beside it. It reads whichever change list the panes
are showing (`summaryLine` in `diffscope.ts` picks the compare store in compare mode, the history
store otherwise), so the line and the aggregate row below it can no longer disagree.

---

## 3. Ranges

A range is *which slice of history* the surface is showing. Which chips appear depends on the source:

| Chip | Shown when | Means |
|---|---|---|
| **Working tree** | Always | Uncommitted work against `HEAD` |
| **Since session start** | Source is an agent | The worktree against the commit that was `HEAD` when the agent's session began |
| **This run** | Source is a run | The run's base commit … `HEAD` |
| **Compare** | Always | Two refs against each other — see [section 6](#6-compare-two-refs) |

A chip that could apply but currently cannot is drawn **disabled with a tooltip explaining why**
rather than hidden — "Since session start" greys out with *no session-start commit recorded yet*
until the agent's transcript has yielded one. A chip that can never apply to this source is absent
entirely.

Switching range relabels the history divider and the synthetic top row without re-reading the commit
list, so it is instant.

---

Picking a source loads the change list, the first page of history, **and** a first file — you land on
a populated diff rather than an empty pane. The working-tree row is selected, and within it the first
changed file.

---

## 4. The three panes

Left to right, all on one time axis.

![The Diff surface at the default 1000x700 window](images/diff-tab/three-panes-1000x700.png)

*The three panes at the app's default window size: the diff pane on the right is roughly 240px. This is
[section 12](#12-what-it-deliberately-cannot-do)'s point, in a picture. Both shots predate the Monaco
pane, so the pane itself looks different now; [section 7](#7-reading-the-diff-pane) describes it.*

![The same surface at 1600x950](images/diff-tab/three-panes-wide.png)

*The same state at 1600×950 — the width the surface was designed against, where the diff pane has room
for its full header and readable lines.*

### Pane 1 — history (460px)

Commits newest-first. Each row is: short hash, ref chips (branch/tag; extras collapse into `+2`),
subject, author, relative time. The pane header states what you are looking at — how many lanes the
graph is drawing and how many it folded (`8 lanes · 1 folded`), and how much history is loaded
(`51 commits loaded`, which is the working-tree row plus one page).

- **Row zero is the working tree** — hash renders as `·······`, subject in the warning colour, time
  reads *not committed*. Uncommitted work is a row in the history, not a separate mode.
- **A divider band** marks the range anchor — "session start" or "run base". Commits *before* the
  anchor are dimmed, so what is in-range is visible without counting.
- **The lane gutter** (the commit graph) draws behind the rows, up to 7 lanes; anything past that
  folds into one grey column. Toggle with `Shift`+`G`. It hides itself automatically while a filter
  is active, because a filtered set mostly lacks its own parents and the lanes would draw edges to
  commits that are not on screen.

### Pane 2 — the selected commit (300px)

Who, when, and which files. Hash chip (or "working tree"), ref chips, subject, author with initials,
then a file count with `+adds −dels`, then the changed-file list. Each file row shows its status
letter (colour-coded), the path, and its own `+/−` counts. Click a file to load it into pane 3.

Read-only by design: there is no stage control, no message box, nothing that authors a commit.

### Pane 3 — the diff

The selected file's changes. Covered in [section 7](#7-reading-the-diff-pane).

---

## 5. Filtering and paging history

The filter row sits above the three panes (hidden in compare mode and in the two failure states).

- **Free text** — matched against commit subjects (`git log --grep`).
- **Author** chip — click it to turn it into an input (`git log --author`).
- **Path** chip — a pathspec (`git log -- <path>`).
- **Clear all** appears with a summary chip: `2 filters · 31 matching commits`.
- **Graph** toggle lives at the end of this row.

Typing is debounced 250ms — each settled keystroke is one git invocation, not each keypress.
Clearing is immediate, because clearing is a decision rather than typing.

History loads **50 commits per page** and appends when you scroll within 200px of the bottom.

**The "Restored" banner.** If you were away from the surface for more than two minutes and it puts
you back on a remembered selection, a green banner names what it restored, then dismisses itself
after six seconds. Below that threshold it restores silently.

---

## 6. Compare two refs

Press `c`, or click the **Compare** chip. The subject bar swaps in a ref expression you can edit in
place; the same control serves both gestures.

**The ref picker.** Two free-text fields in the order **base … head** — the order `git diff
base...head` reads in, and the order the summary line below it prints — each with branch suggestions
(local branches, most recently committed first, with their age). Free text is accepted alongside the
suggestions, so a tag or a raw SHA works.

- It opens pre-filled with the **current branch on both sides**, and focus lands on **base**, the
  first field — head is where you already are, base is the ref you came to change. So the first thing
  you see is *"These refs do not diverge"*; type over the highlighted base field.
- `Enter` applies. `Escape` cancels **the edit only** — leaving compare is `Escape`'s job once the
  picker is closed. Closed, the control collapses to a chip reading `base … head`; click it to reopen.

![Compare mode with the ref picker open](images/diff-tab/compare.png)

*Compare, freshly entered: the picker open on `main … main`, the aggregate as row zero reporting
`0 files`, the merge base named at the foot of the column, and the diff pane waiting for a file.*

**The compare column** replaces the history pane:

| Row | What it is |
|---|---|
| **Aggregate** (row zero) | Everything head introduces relative to base, anchored at their merge base |
| **`head` group** | Commits on head but not base — "N ahead", coloured green |
| **`base` group** | Commits on base but not head — "N behind", coloured blue |
| **Merge base** | Printed at the foot of the column |

Selecting the aggregate row shows the aggregate file list in pane 2; selecting a commit row shows
that commit exactly as the normal history pane would. "Back to the aggregate" is therefore just a
selection — no gesture, no hidden state.

`Tab` jumps between the two sides. `Escape` leaves compare and restores **the range comparison
interrupted**, rather than guessing a default. Comparing while comparing never nests: it keeps the
original range as the thing to return to.

---

## 7. Reading the diff pane

The pane is a read-only Monaco diff editor fed two full file texts: the left side read at the
range's base ref, the right side at the commit (or from disk, for the working tree). Which two refs
is `pairRefsFor` (`diffcontent.ts`); the loader is `diffcontentstore.ts`. Unified by default;
unchanged stretches fold away, keeping 3 lines of context around each change.

The header carries the path (the directory truncates from the left, so the file name always
shows), the file's `+adds −dels` from the change list, and these controls:

- **Change navigator** — `change 2/5` with ↑/↓ (`Shift`+`P` / `Shift`+`N`), walking the hunks
  Monaco computed. Hidden while the open file has no change to walk.
- **Unified / Split** (`Shift`+`D`) — only offered when the pane itself measures ≥ 900px; below
  that the pane stays unified whatever the toggle says.
- **Hide whitespace** (`Shift`+`W`) — off by default, so the pane agrees with the counts beside it;
  on reads through a reformat.
- **Mark reviewed** (`v`) — ticks the open file and opens the next unreviewed one. Shown when the
  open file belongs to a listed subject.
- **Open in Code** — opens the file in the Code surface at the first line where the two texts
  differ. Always available when a repository is scoped. The Code surface always shows the
  working-tree file and says so itself if the path is gone.
- **Open in editor ↗** — hands the path to the OS. Only offered on the working-tree row, since it is
  the only row whose file is guaranteed to exist on disk.

Below 1100px of pane width the buttons drop their labels and keep their icons and tooltips.

**States that are not a diff**, each with its own sentence instead of an empty editor
(`diffempty.ts`):

| State | What you see |
|---|---|
| Either side over 2 MB | *Too large to show here*, with the size in the header — open it in Code |
| Either side binary | *Binary file — Git records a change here, but there is no text to compare.* |
| Both texts identical | *Contents unchanged — Only the name or the file mode changed.* |
| No file selected | *Pick a file to see its changes* |
| No commit open | *Pick a commit to see its changes* |
| Compare's aggregate lists no files | *Nothing to compare* |

**Added and deleted files** need no special case: the side where the path does not exist reads as
empty, so an untracked or added file is all additions and a deleted one all removals.

**Renames** show as **R** in the file list, which keeps the source path git reported
(`nameStatusToStatusZ` emits it after the entry, as porcelain does). The pane reads the left side at
that old path, so an edited rename shows only its edits and a pure rename reads *Contents
unchanged*. A comment on a renamed file's removed lines names the old path in the prompt.

---

## 8. When something is wrong

Two failure screens, deliberately different:

- **"This source is not a Git repository"** — a calm fact about the source you picked. Pick another
  with the source picker.
- **"Couldn't read this repository"** — a fault. It prints the failing git command, its exit code
  (or *no exit code* for a timeout or a missing binary), stderr verbatim in a selectable block, and a
  **Retry** button. Nothing was changed, so retrying is safe.

A repository whose read failed is checked *first*, because a failed read also reports "not a repo" —
showing it as absent would hide the reason behind a screen that reads like normality.

---

## 9. Keyboard

Diff-surface keys (live when the surface is active and you are not in a text field or modal):

| Key | Action | Available |
|---|---|---|
| `j` / `k`, `↓` / `↑` | Move the commit cursor — moving *is* selecting, so the panes follow | Always |
| `Enter` | Open the selected file in the OS editor | When a file is selected |
| `/` | Focus the history filter | History mode |
| `Shift`+`G` | Toggle the commit graph | History mode |
| `g` `g` | Jump to the top of history | History mode |
| `c` | Compare refs | Always |
| `Tab` | Switch compare side | Compare mode |
| `Shift`+`S` | Swap the compare refs | Compare mode |
| `Shift`+`N` / `Shift`+`P` | Next / previous change in the open diff | A text diff is open |
| `Shift`+`D` | Split / unified | Pane ≥ 900px |
| `Shift`+`W` | Hide whitespace | Always |
| `v` | Mark the open file reviewed (or unmark it) and open the next unreviewed file | The open file is in a listed subject |
| `m` | Comment on the selected lines, or the cursor's line (also from inside the editor) | A text diff is open |
| `Ctrl`+`Enter` / `Esc` | Add / cancel the comment being written | In a comment card |
| `Shift`+`Enter` | Send the pending comments | The send bar has a recipient |
| `Escape` | Clear filters → else leave compare → else back to Cockpit | In that order |

`Shift`+`?` opens the full shortcut sheet. Note that `Shift`+`G` is deliberately not bare `g`, which
is the leader key for the go-to chords.

**The hints footer** along the bottom of the window is the live version of this table: it lists only
the keys whose bindings currently apply, so it changes as you move between history and compare. It
dims while focus is in a text field, since most of these keys are suppressed there.

Entering or leaving compare, and changing the filters, recomputes it in place — no focus change
needed. That runs through `whenVersionAtom` (`store/keybindings/whenstate.ts`): a counter bumped
whenever any atom a `when` predicate reads changes, which the footer subscribes to instead of
subscribing to each atom itself. **A predicate that starts reading a new atom must add it to
`PREDICATE_ATOMS` there**, or the footer goes stale again for that state; `store.test.ts` fails if a
predicate touches an atom the list is missing.

Not bound today: moving through the **changed-file list** with the keyboard. Commit navigation is
keyboard-driven; picking a file within a commit is mouse-only.

---

## 10. Arriving from elsewhere

Three places in the cockpit open this surface pre-scoped, and one of them can preselect a file:

| From | Gesture | Lands on |
|---|---|---|
| Cockpit agent card | Row menu → **Review changes** | That agent, "Since session start" |
| Agent details rail | Click a changed file | That agent, **with that file already selected** |
| Agent details rail | Click **+N more** under the file list | That agent, no file preselected |
| Run completion / evidence | The diff link on a finished run | That run, "This run" range, base commit … HEAD |

The file preselection is one-shot on purpose: it beats the remembered selection exactly once, then
stops — otherwise every later return to the surface would drag you back to the linked file.

---

## 11. The other diff — the Code surface

The Code surface (`Ctrl`+`9`, or `g` `b`) has its own diff, and it answers a different question.

| | Diff surface | Code surface's Diff mode |
|---|---|---|
| Question | "What changed in this commit / range?" | "What am I about to commit in this file?" |
| Renderer | Monaco diff editor | Monaco diff editor |
| Right-hand side | The committed content | **Your unsaved draft**, so in-progress edits appear |
| Compares against | Any commit, or two refs | `HEAD` only |
| Split view | Yes, `Shift`+`D` | Yes, when the pane measures ≥ 900px |
| Scope | Whole repository | The one open file |

Press `d` in the Code surface to toggle it (the mode toggle in the path bar reads
`preview` / `source` / `diff`; **preview** is markdown-only).

Practical rule: use the Code surface's diff while writing, the Diff surface while reviewing.

---

## 12. What it deliberately cannot do

Current, honest limits — not bugs:

- **Read-only.** No staging, no checkout, no cherry-pick, no revert. Repository-mutating actions are
  a separate, unwritten spec. A comment ([section 13](#13-comments-to-the-agent)) only ever becomes a
  prompt to an agent.
- **No comments on removed lines in unified view.** Monaco draws them without a gutter or selection;
  switch to split (`Shift`+`D`).
- **No comments to a run that has not landed.** Its landing tree belongs to the engine; the batch waits.
- **"Sent" means handed over.** A live agent takes the prompt through its mod, else it is typed into
  its terminal; a typing failure after the hand-off is only logged by wavesrv.
- **Pending comments are per machine.** They live in this app's localStorage, not in the repository.
- **No keyboard navigation of the changed-file list** (section 9).
- **It is cramped at the default window size.** The app opens at 1000×700
  (`src-tauri/tauri.conf.json:14`) and the two left columns are fixed at 460px + 300px, leaving the
  diff roughly 240px — about 30 characters. Maximize the window before a real review.
- **Local host only.** SSH/WSL workers run their git elsewhere; those commands are not registered on
  the remote route.

---

## 13. Comments to the agent

Mark lines of the open diff with a note while reviewing, then send the batch to the agent that made
the changes as one prompt. Spec: `docs/superpowers/specs/2026-10-26-diff-comments-design.md`.

**Adding.** Hover a line and click the **+** in its gutter, or select lines and press `m` (with no
selection, the cursor's line). A draft card opens under the range's last line — *Comment on lines
7–9* — and `Ctrl`+`Enter` adds it, `Esc` cancels. Changed and context lines on the right take comments
in both views. Removed lines take them only in split view, on the left side; in unified view a hunk of
only removed lines carries a hint to switch.

**Pending.** Each comment stays as a card under its lines, marked *pending*, with edit and delete. A
card shows only on the pair of refs it was made on (the working tree, a commit, a comparison); the
changed-file list counts a file's comments across every pair in a badge on its row. When the agent
keeps working and the lines move, the comment follows its quoted text; if the text is gone the card
is not drawn, but the comment stays counted and is sent with its original lines and quote.

Comments are held per source — one batch per agent, run or project — in localStorage
(`diff.comments.pending`), so they survive a restart; the 50 most recently touched batches are kept.

**The send bar** under the diff pane counts the batch and names who gets it. With no comments it is a
one-line hint.

| Source | Send goes to |
|---|---|
| A live agent in an Arc terminal | That agent, as its next prompt — "working, joins its turn" mid-turn, "at its prompt" when idle |
| A project | A new Claude Code agent in the project's folder, the batch as its first prompt |
| A run that has landed | A new agent in the run's project folder |
| A run that has not landed, or is held | Nobody yet: Send is disabled with the reason, and the batch is kept |
| An agent a run started | Its run's rule |
| An agent that has ended (or runs outside Arc) | A new agent in its last folder, else its project's folder; with neither, Send is disabled |

`Shift`+`Enter` (or **Send**) sends. To a live agent the cards leave and *Sent 3 comments to loom*
stays until the next comment. A new agent opens on the Agent surface. A failure keeps the batch and
shows the error with **Send again**. **Discard** drops the whole batch.

What the agent receives:

```
Review comments on your changes (worktree against 3f9a21c), 2 comments:

  src/retry/policy.go:4
  >     return 8
  Why 8? Put the reason in a comment above the return.

  src/retry/legacy.go: removed lines 1-3 of 3f9a21c
  > package retry
  Legacy() may still have callers outside this package.

  Line numbers are the file as shown in the diff. Address each comment, then say which you changed.
```

---

## Coverage of this document

What was exercised in the live dev app on 2026-09-04, before the pane became Monaco (its **New file** and *Renamed.* states are gone, see [section 7](#7-reading-the-diff-pane)), and what was not:

| Exercised live | Not exercised |
|---|---|
| Source picker (project), range chips, summary line | Agent source, and the **Since session start** range (no agent was running) |
| Working tree as row zero; selecting a historical commit | Run scope, and the **This run** range |
| Untracked file → **New file** all-additions | Mode-change-only file |
| Binary file → the binary sentence | The `Restored` banner (needs a two-minute absence) |
| Pure rename → the *Renamed.* state | **Open in editor ↗** (spawns an OS application; deliberately skipped) |
| Text filter, author filter, `Escape` to clear | Deep link from the agent details rail |
| Paging (51 → 101 rows), `g g`, `Shift`+`G` | |
| `j`/`k` moving cursor and panes together | |
| **Open in Code** → lands on the Code surface | |
| Compare against a diverging branch, `Tab` between sides, `Escape` restoring the prior range | |
| Not-a-repo and read-failure panels (via `task verify:ui -- git-history`, 10/10) | |

---

## Verifying

The surface has no jsdom render tests by design. Check it in the live dev app:

```bash
task dev                       # Vite on :5174 inside WebView2, CDP on :9222
node scripts/cdp-shot.mjs out.png
task verify:ui -- git-history  # paging, filtering, Escape, persistence, the range chips
task verify:ui -- surface-smoke
```

`git-history` (`scripts/cdp/scenarios.mjs`) builds three throwaway repos — a healthy one with 61
commits, one with its object store emptied to force the failure panel, and a plain directory for the
not-a-repo panel — registers them as projects, and drives the surface through them.

**What that scenario cannot catch.** Its fixtures are single-branch with **clean working trees**, so
the history store and the compare store both read zero and agree by accident — every compare-vs-
working-tree defect is invisible to it, and so is anything needing a second ref. Checking that class
of behaviour by hand needs a fixture with two diverging branches *and* a dirty tree, so the two
stores hold visibly different numbers. Renames have their own fixture, `diff-rename` (a pure rename and
an edited one, each its own commit), and `diff-source-row` checks which row a source opens on.

Pure logic is unit-tested beside its module: `diffscope.test.ts`, `gitdiff.test.ts`,
`githistorystore.test.ts`, `comparestore.test.ts`, `filesstore.test.ts`, `agentdiffnav.test.ts`.
