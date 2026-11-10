# Brainstorm board: show what the agent is doing

## Intent

When the brainstorm agent spends a turn on something long (drawing mockup boards, researching, writing the spec),
the board shows what it is doing as it happens instead of one fixed line: the step it is on, taken from its live
activity, and each board as it lands. The user can tell the agent is not stuck, and can look at a mockup before
the question that uses it arrives.

Today, during a mockup turn the board says "Working" and nothing on it changes until the turn ends, because the
agent writes `brainstorm.json` once per turn.

## What exists today (context)

- `WorkingMain` (`frontend/app/view/agents/brainstormui.tsx`) renders a pulsing "Working" label, the file's
  `working` string, the fixed line "The next question comes after." and the Design button.
- While a sent line is pending, `shownFile` (`brainstormmodel.ts`) substitutes one of Arc's fixed strings for
  `working`: "Writing up your answer.", "Taking in your change.", "Taking in the judge's result.", "A builder is
  reading the design.".
- `DesignMain` (`brainstormpane.tsx`) shows, while `working` is set, a note: "The agent is writing. Confirm, edit
  and keep open again when it asks its next question."
- `AgentVM.activity` (`agentsviewmodel.ts`) is a live activity line while the agent works, filled by the hook's
  `detailForTool` (`cmd/wsh/cmd/wshcmd-agenthook.go`). It names files only for Edit, Write, Read and Bash; other
  tools show their bare name.
- `entriesAtomFor(agent.id)` (`livetranscriptatoms.ts`) gives the agent's live transcript entries, including
  action entries with verb and file target.
- The hook already recognizes canvas board paths (`canvasBoardPathRe` in `wshcmd-agenthook.go`).
- `Thumbnails` (`brainstormui.tsx`) draws boards from a canvas, base and list of names.
- The turn start Arc already tracks reaches `terminalAnswer` (`brainstormmodel.ts`, via `brainstormpoller.ts`).

## Scope

In scope: every moment the brainstorm agent itself is busy and the board shows a fixed line: the Working view in
the main area, the "The agent is writing" note on the design view, and Arc's pending lines while a sent answer,
change, judge result or builder result is being taken in.

The step line, elapsed time and boards show only while the agent is in a turn (`agent.state === "working"`).
When the agent has ended its turn with `working` still set because something runs in the background (a research
subagent, a long command), the Working view and the design view's note show their plain line as today: a step
from a finished turn never reads as current. Following a background subagent's transcript is out of scope.

Out of scope: the judge wait (it already shows the approach list being weighed) and the builder check wait (it
already shows usual and longest times).

## Decisions

### The Working view

Keep the "Working" label and the big `working` line. Replace the fixed "The next question comes after." with:

1. **A live step line**: the agent's current step (verb and target, e.g. `WRITE  Page-trend.dc.html`, in the
   timeline's tool-row verb style) and the turn's elapsed time at the right.
2. **Boards made this turn**: under the step line, a thumbnail of each board the agent has written since the
   user's last answer, with its file name as caption. Found from the turn's Write/Edit steps on `.dc.html` files
   under the canvas's `project/` folder, read from the transcript entries, not from a folder watcher. Clicking a
   thumbnail opens the board, as thumbnails do elsewhere in the pane. The section is absent when the turn has
   written no board.
   - *Agent's call:* boards show on the first mockup turn too, before `brainstorm.json` names a `canvas`. A
     board's canvas comes from its own path (`.superpowers/design/<canvas>/project/<name>.dc.html` under the
     brainstorm's project folder), so any canvas under that project counts, not only `f.canvas`. The poller
     serves the design folder once the first such board appears in the turn's entries, and re-reads that
     canvas's `canvas.json` when a new board lands; a board `canvas.json` does not list yet uses the default
     board size. Today `readBoards` (`brainstormpoller.ts`) does neither until the file sets `canvas`.

Prototype: `.superpowers/design/brainstorm-working-visibility/project/Main.dc.html`.

### The design view while the agent works

The working note on the design view shows the same live step and elapsed time in place of its fixed first
sentence ("The agent is writing."); the rest of the note stays. The boards stay in the Working view only.

## Left to the builder

- How each tool reads in the step line: widen `detailForTool`, or derive the line from the transcript entries.
- When the elapsed time starts: the turn's start, as Arc already tracks it.
- A board the turn edits rather than creates shows among this turn's boards too, once.
- With no step known yet (turn just started, no hook detail), the step line is left out rather than drawn empty.
- Logic (this turn's boards from entries, the step line text, elapsed time) goes in a pure `.ts` with tests beside
  it, per the repo's convention; the `.tsx` stays thin.
- Verification: a CDP scenario that shows the Working view mid-turn with a step and two boards, and the design
  view's note with the step line.

## Non-goals

- No change to the agent's one-write-per-turn rule in the arc:brainstorm skill (mid-turn writes were weighed and
  dropped: each extra write costs output tokens and seconds per answer).
- No full transcript in the pane: the Rendered view already shows it.
- No stalled/quiet warning: elapsed time is shown, with no threshold.
