# Boards, better: one drawing at a time, opened for viewing

## Intent and why

Boards are where the drawer answers a question as a diagram. Two problems make them hard to use today:

- **Answers pile up on one canvas.** Every answer lands on the same canvas, each one dense with text
  (most boards in use carry 2k to 6.8k characters across 45 to 110 text elements, and one ask pushed
  back with "too many texts"). The canvas fits the view only when it first opens, so in the narrow board
  tab beside an agent's transcript a new answer shows as a sliver, and an earlier answer is hard to find
  again.
- **The board leans toward editing.** Show selects shapes, which opens the style panel as a click would,
  and the drawing toolbar is always shown. But the drawer does the drawing, and people rarely edit by
  hand: no saved board holds a shape a person drew, and 1 of 31 typed asks used a shape selection.

This change makes each answer its own short, titled drawing that is easy to find again, and opens every
board as a viewer, with editing one switch away.

## Goals

- Each drawer answer is its own titled drawing, kept short.
- The view shows the whole newest drawing when it arrives, in the narrow board tab too.
- Any drawing on a board is one click away.
- A board opens for viewing: no drawing toolbar, no style panel, and clicks and drags pan rather than
  move shapes.
- Hand editing, including asking about selected shapes, stays one switch away.

## Non-goals

- Automatic layout of a drawing's shapes, step-by-step playback, and saving a drawing as an image. They
  were weighed and set aside for later.
- Splitting boards drawn before this change into one drawing per past turn.

## Anti-goals

- Denser drawings. A drawing that needs more words becomes a second drawing, never longer labels.
- A board that ends up stuck in edit mode, or a mode the user has to remember to leave.
- Moving the view away from a drawing the user went back to look at.

## Decisions

### Drawings

- **Each answer is a drawing:** a titled frame on the board's canvas, numbered in the order it was
  drawn. Why: a frame gives every answer a name and a boundary the view can fit and the row can list.
- **The drawer keeps each drawing short:** a few words per box, one idea per drawing, no paragraphs on
  the canvas. When there is more to say it makes another drawing rather than a denser one. Detail that
  does not fit stays out of the drawing: a question still goes to the agent as today, and a request for
  more detail becomes a further drawing. Why: boards today are text-heavy and were pushed back on for it.
- **Follow-ups:** a follow-up that changes the drawing in view (simpler, more detail, about selected
  shapes) edits that drawing; a new question gets a new drawing. The drawer decides which a turn is. A
  misjudged turn costs one undo, as today. Why: the user left the call to the drawer.
- **The drawing in view** is the one the drawings row marks as current. A line the person types names it to
  the drawer; shapes selected in Edit name the drawing that holds them instead (a selection across drawings
  leaves the current one named). Why: the drawer needs one drawing to edit, and the row already shows which.
- **A request from an agent** (a briefing or a draw request) always makes a new drawing. Why: it arrives with
  no view, often while the board is closed, so there is no drawing in view to edit.
- **An edit stays inside its drawing:** a follow-up changes, moves or removes only shapes of the drawing it
  edits, and a new drawing only adds shapes. An answer that touches another drawing is unusable. Why: each
  answer is its own drawing; an edit that reaches into an earlier one would rewrite an answer the person
  may go back to.
- **Boards drawn before this change** keep all their shapes as one drawing titled "Earlier drawings";
  new answers on them become new drawings beside it. Why: splitting old boards per past turn would mean
  guessing at overlapping shapes, for 11 boards.

### Finding a drawing

- **A drawings row above the canvas** lists the board's drawings by number and title. Clicking one moves
  the view to that drawing, fitted. Why: one click to any answer, without panning a large canvas.
- The row shows in both the workspace board tab and the Boards surface, since both use the one board
  view.
- A turn's Show still outlines that turn's shapes.

### When a new drawing arrives

- **The view fits the new drawing,** so the narrow tab shows the whole of it. Why: today the canvas fits
  only on first open, so a tall board shows a sliver of the newest answer.
- **Unless the user moved to an earlier drawing:** then the view stays where it is, and the new drawing
  is marked new in the row.
- **The view follows new drawings while the newest drawing is the one mostly in view.** Moving to an earlier
  drawing, by a row click, a pan or a zoom, stops it; coming back to the newest, by the row or by hand,
  resumes it. Zooming into the newest to read it keeps following. Why: the view never leaves a drawing the
  person went back to, however they got there, and the newest still arrives whole.
- **Reopening a board** you left following the newest drawing fits the newest, so answers that landed while
  it was closed show; otherwise it returns to where you left it, as today.

### View mode and the Edit switch

- **Every board opens in view mode:** pan and zoom, no drawing toolbar, no style panel. Clicks and drags
  pan instead of moving shapes, which also ends accidental drags that autosave a moved shape.
- **Show is unchanged:** it keeps outlining the turn's shapes. In view mode a selection set by the app
  still draws its outline, without resize handles or the style panel.
- **One Edit button in the board header** turns editing on, bringing back today's editing in full,
  asking about selected shapes included; pressing it again turns editing off. Nothing else changes the
  mode: no Done step, and leaving the board does not turn it off. Why: the user asked for the simplest
  switch.
- **Edit is one switch per board,** shared by the workspace board tab and the Boards surface, and held only
  in memory: switching surfaces, tabs or boards leaves it as it was, and every board is in view mode when
  Arc starts. Why: the user ruled out leaving the board as a way to end Edit, so only a restart resets it.
- **The ask box hint** reads "Press Edit to ask about shapes" in view mode, in place of "Select shapes
  to ask about them"; with Edit on it reads as today.
- A drawer answer that lands while Edit is on goes in as today, and answers land live in view mode too.

## Constraints

- The board view is shared by the workspace board tab and the Boards surface; both get the drawings
  row, fit-the-newest, view mode and the Edit button.
- The canvas stays Excalidraw (0.18.1); view mode is its own view mode, not a custom one.
- Colors and spacing come from the existing theme tokens.

## Left to the builder

- The exact size and word limits per drawing, and the drawer prompt's wording for drawing a new drawing
  versus editing the one in view.
- Where a new drawing is placed on the canvas.
- How the drawings row handles many drawings in the narrow tab.
- Where the Edit button sits in each header.
- The tests for the drawer's answer format.
- Boards scenario steps that show: the drawings row; the view fitting a new drawing; a follow-up editing
  the drawing in view; a board opening in view mode; Show outlining shapes there; and Edit bringing the
  tools back.
