# Agent-drawn boards in Arc

Brainstorm: `.superpowers/brainstorm/tldraw-in-arc/brainstorm.json` (11-11). Mockups: canvas
`tldraw-in-arc`, seven boards led by `F8-Tree.dc.html` (see "Mockups" below).

## Intent

Bring a whiteboard that agents draw on into Arc. It started from tldraw, which the owner found very
promising; it is built on Excalidraw instead (see "Library"). A whiteboard is a medium that lets agents
visualize freely; understanding how something works was one example of a use, not the scope.

Agents draw what they understand, on a free board: not a board per run, and not tied to a run's tasks.

Not this design: tying initiatives and runs together (initiatives growing from run fallout). That is
tracked separately in initiative `effort:728d3e5b-9f8d-4795-8eb1-bc122f8e2418` ("Initiatives stop
ballooning").

## Goals

- Boards are things you make, like notes: you create a board on any subject (an idea, an area of a
  codebase, a decision, a bug) and name it; things from any agent can be drawn onto it; boards are kept
  per project, and you reopen and add to them.
- The agents you work with never draw. A separate scribe agent does all drawing, so their context
  stays clean.
- You arrange boards by hand, and the scribe never undoes your arrangement.

## Non-goals and anti-goals

- **No run boards.** A board per orchestrator run, drawn live as it works, was explored and dropped: it
  mostly repeats the run's DAG graph (`frontend/app/view/orchestrate/daggraph.tsx`) and its report.
  Run milestones (plan reviewed, task merged, landed) do not wake the scribe.
- **No drawing in working agents' context.** No skill or prompt tells a working agent to draw. An
  agent only runs the board action when you ask it to (below); the `arc:cockpit` skill names
  `wsh board draw` as the command for that ask, and says never to draw unasked.
- **Not always on.** Nothing draws unless you ask.
- **Not drawing together.** You sketching and an agent drawing back, and agent-composed replacements
  for Arc's views, were considered and not chosen.
- **No sync.** Boards stay on the machine (below).
- Anti-goal: a scribe that rewrites a board you arranged, losing your hand edits.

## The design

### Library

Excalidraw (MIT), not tldraw. tldraw needs a license key in a production build: without one, a
packaged Arc shows the editor for 5 seconds and then nothing (`LicenseManager`/`LicenseProvider` in
tldraw's source; `*.localhost` counts as development only outside production builds). Excalidraw has no
key, no watermark and no terms to check.

How a program draws on Excalidraw (docs.excalidraw.com): `convertToExcalidrawElements` turns short
skeletons (rectangle, ellipse, diamond, text, line, arrow; containers with a `label`; arrows bound to
shapes by id or type at `start`/`end`) into full elements for `initialData` or `updateScene`. The docs
mark this API beta. `@excalidraw/mermaid-to-excalidraw` turns Mermaid into the same skeletons, fully
only for flowcharts; other Mermaid diagrams land as an image.

### The scribe

- **Opt-in, separate.** A separate scribe agent does the drawing, reading what it is pointed at. It
  never shares context with the agent it reads. Off unless you ask.
- **What it reads.** The thing it is handed, plus read-only access to the project's code (read and
  search tools, no edits, no shell), so it can check code the thing mentions before drawing it. Its
  working directory is the project's repo.
- **When it draws.** When you ask (the action below), and at the turn ends of an agent you pointed it
  at. Wakes that arrive while it is drawing merge into its next pass, and each pass reads only what is
  new since its last one.
- **Following an agent.** Draw on a board… on an agent has a "keep following" tick. When it is ticked,
  each later turn end of that agent redraws the same source (thing plus ask) onto the same board. A
  follow stops when the agent closes or you press Stop. It shows in three places, so nothing follows
  unseen: the board's header ("Following claude · waveterm"), the top of the board's tree in the list
  (with Stop), and the agent's row in the Agent tree (a chip naming the board, which opens it, and a
  Stop chip). Without the tick a draw is one-off.
- **What it may change.** Each draw is a group tagged with its source (the thing it was handed).
  Redrawing that source replaces its group in place while you haven't touched it. Once you have edited
  a group, the redraw lands beside it as a pending version you keep or drop. Your own shapes are never
  touched.
- **Pending version.** It is an Excalidraw frame named "Pending redraw · <ask>", its shapes faded,
  placed beside the group you edited. Keep and Drop sit on that source's row in the board's tree, under
  "You edited it at <time>, so the <time> redraw waits beside it." **Agent's call:** Keep makes the
  redraw a normal group beside yours and leaves yours as it is, so nothing you edited is lost; Drop
  deletes the frame.
- **While it draws, and when it fails.** While the scribe draws a source, that source's row and the
  board's row say "drawing", and the group keeps its old version until the redraw lands. A wake that
  arrives meanwhile shows on the row ("1 more turn end came in; it joins the next pass"). A failed pass
  marks the row "failed" with the reason and a Retry, keeps the old version, and raises an error toast
  ("Scribe couldn't draw on <board>").
- **Agent's call: what a source is.** A source is the thing plus the ask, so drawing one agent twice with
  different asks ("the escalation flow", then "the data model") makes two groups; with no ask, the thing
  alone is the key. A redraw gives the scribe the group's current skeleton and what is new, and it
  returns the whole replacement group, so earlier content survives. "New since the last pass" applies to
  transcripts; a run, an initiative or a record is read whole each pass.
- **Agent's call: arranging is not editing.** Moving or resizing a group keeps it the scribe's: an
  in-place replace keeps the group's position and scale. Only content edits inside a group (text
  changed, shapes added or deleted) make the next redraw a pending version.

### How something gets onto a board

One **Draw on a board…** action, added to the palette's per-thing action lists
(`frontend/app/cockpit/actions/`: agent, run, initiative, session, record). It asks which board
(or a new one) and, optionally, what to draw, then hands that thing to the scribe. Agents can run the
same action when you ask them to ("put that on the brainstorm internals board").

In the palette it is a drill, like the actions that take input today (`ActionInput`):

1. **Pick a board.** The project's boards, each with its group count and last drawn time, then
   **New board…**. Typing filters them; a typed name that matches no board carries into New board….
2. **New board… only:** type its name; Enter makes it.
3. **What to draw**, optional, in the input, with a **Keep following** tick below it (agents only; Tab
   toggles it). The tick says each redraw is a scribe session.
4. Enter hands it to the scribe and closes the palette; the toast follows when the draw lands.

The drill chip reads `Agent › <name> › Draw on a board… › <board>`, ← steps back, and the footer always
says what Enter does ("Draw claude · waveterm: the escalation flow on Brainstorm internals, and keep
following").

**Agent's call: how an agent hands work over.** `wsh ui do` passes only an action id today
(`cmd/wsh/cmd/wshcmd-ui.go`, `uiclient.ts` `handle_uiinvoke`), and the per-thing actions are not
reachable through it. So agents get their own command, `wsh board draw --board <name> [--ask "<what to
draw>"]`, backed by a new wshrpc command. The thing is the calling agent's own session, read from its
latest turn; the ask focuses the drawing. No cockpit UI opens, and it does not wait for you to be idle.

### Where a board opens: the Boards surface

- A full-width **Boards** surface, outside the numbered `SURFACE_ORDER` (like Setup and Settings,
  `agents.tsx:57-62`), reached by `g w` and opened from the palette through the openref router
  (`frontend/app/view/jarvis/openref.ts`). Its nav rail entry sits in the bottom group, above Setup,
  with Lucide's `Shapes` icon.
- The surface header reads "Boards / <board>" with the board's facts ("4 groups · 1 new since you
  looked · last drawn 16:04") and, while a follow runs, "Following <agent>".
- **The list** (264px, `bg-surface`, like Setup's lists) holds New board, the project's board count,
  and the boards, most recently drawn first. The open board unfolds into a tree, the way the Agent tree
  nests rows; the others stay folded, each with its time and "N new" when the scribe drew there since
  you looked. Clicking the open board's row folds it.
- **The open board's tree:** the follow with Stop on top, then one row per source: the palette's kind
  icon (`KIND_ICONS` in `palette-rows.tsx`: agent, run, initiative, record, session), the ask as its
  title ("the run, read whole" with none), then source · shape count · time, and a New pill if it is
  new since you looked. A last "Your shapes" row counts yours and says the scribe never changes them.
- **The board is plain Excalidraw**: no overlays, tags or outlines drawn over it. Clicking a source
  row selects that group's elements with Excalidraw's own selection. On open, the newest group since
  you last looked is selected.
- **New board** puts a name field at the top of the list, focused ("Name this board", like renaming a
  session in the Agent tree). Enter or Create makes an empty board in the current project and opens it;
  Esc or Cancel drops it; an empty name stays open with "Type a name first". Names need not be unique.
  An empty board says "Nothing on this board yet" and how to fill it: draw with the tools, or Draw on a
  board… on any agent, run or initiative.
- **No boards yet:** a project with none shows `SurfaceEmptyState` ("No boards in <project> yet") with
  New board as its action.
- **A board file that will not open** shows `SurfaceError` with Retry, the file's path, and that Arc
  left the file as it was; its list row says "won't open". Nothing draws on it until it opens.
- It unmounts on switch like every surface but Agent. Coming back loads the saved board, and the
  board's zoom and position are kept in a per-board jotai atom, so you land where you left.
- When the scribe finishes a draw, a notice says so (for example "Scribe drew 4 shapes on Brainstorm
  internals", "From run 690cc20a") with an Open. **Agent's call:** the notice is a shell-level toast on
  the existing cockpit toast stack (`frontend/app/cockpit/toaststack`), not a line in one agent's view,
  because a draw can come from a run, an initiative or a record with no agent involved.
- Escape: while Excalidraw has a selection or an active tool, the board owns Escape (deselect, drop
  the tool), the way the Diff compare state does in `bindings.ts`; with nothing to clear, Escape goes
  home as on every other surface.

### Where boards are saved

Each board is a `.excalidraw` file (Excalidraw's JSON) under Arc's data folder, per project:
`%LOCALAPPDATA%/dev.arc.app/data/boards/<project>/`. Private to the machine: not synced, not in git.
The dev app (`dev.arc.app-dev`) keeps its own data folder, so its boards are separate.

## Constraints

- No new design tokens; the Boards surface follows `DESIGN.md` and the `@theme` tokens.
- Free keys are scarce (from `bindings.ts`): b, r, / and Space are taken on several surfaces, and the
  g-leader letters h a c s f u b . , are in use.
- The owner starts work and wants control: nothing auto-chains.
- Subagents and model sessions cost usage. The scribe's cost is kept down by reading only what is new
  in a transcript and opening code only to check what the thing mentions; a follow (one draw per turn
  end) is where most of its cost will come from.

## Left to the builder

Each of these is the agent's call, changeable:

- **Agent's call:** the scribe runs on Sonnet as a one-shot session per batch, like the brainstorm
  judge (`pkg/brainstormcheck`, `wsh brainstorm judge`).
- **Agent's call:** the scribe writes Excalidraw skeleton JSON, or a Mermaid flowchart for flows.
  `convertToExcalidrawElements` is a JavaScript function in the Excalidraw package, so the conversion
  runs in the frontend (or a node step), not in wavesrv; the builder picks where the scribe's output
  waits until it is converted.
- **Agent's call:** each board file carries its name and the scribe's source tags (Excalidraw
  elements have a `customData` field), at `<data>/boards/<project>/<id>.excalidraw`.
- **Agent's call:** Excalidraw's controls take Arc's tokens (dark theme, the canvas on `background`),
  and its main menu (export, open, save) is hidden.
- Check that Tab is free inside the palette's drill before giving it to Keep following; at the top level
  it switches scope.
- Pin the Excalidraw version: the skeleton API is beta.

## Mockups

Canvas `tldraw-in-arc`, one board per screen or state the built UI reaches:

| Board | Shows |
|---|---|
| `F8-Tree.dc.html` | A board open: its follow and sources unfolded in the list, a pending redraw waiting for Keep or Drop, the draw toast |
| `N1-NewBoard.dc.html` | New board: the name field in the list, then the new empty board |
| `N2-NoBoards.dc.html` | A project with no boards |
| `D1-DrawPicker.dc.html` | Draw on a board… on an agent in the palette, through to the toast |
| `D2-Drawing.dc.html` | The scribe drawing (a wake queued) and a failed redraw with Retry and the error toast |
| `A1-AgentRow.dc.html` | A followed agent's row in the Agent tree |
| `E1-LoadError.dc.html` | A board whose file will not open |

Shantell Sans stands in for Excalidraw's own hand-drawn font. The options not chosen (a pane beside the
terminal, a gallery, a sources panel, tabs with a draw history, tags on the board, an in-place compare,
and the earlier B-, K-, L-, U- explorations) are in the canvas's `unchosen/` folder, outside the spec.

## Background

- Agents rarely draw unprompted: 26 diagrams in 23,653 replies in the transcript scan.
- 22 how-does-X-work asks in 3 months, 4 of them asked again for a flow already explained.
- Screen markup sent to agents was tried (canvas send-marks) and got 0 uses.
- Notes are vault files (`<vault>/notes/<id>.md`, `pkg/notestore`); boards deliberately are not.
