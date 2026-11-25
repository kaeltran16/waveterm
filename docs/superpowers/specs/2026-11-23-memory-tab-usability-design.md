# Memory tab: Arc does the routine, you answer the big ones

Status: design, 2026-11-25. Prototype: canvas `memory-tab-redesign` (local only, never committed). `FlowAuto` is the
page; `AutoAll`, `AutoApplying`, `AutoChanged`, `AutoNewer`, `AutoFailed`, `AutoApplied`, `AutoUndoRefused`,
`AutoCleanup`, `AutoDigest` and `AutoEmpty` are its states.

## Intent

The weekly memory check proposes good changes (122 of the 124 decided so far were applied), but reviewing them
stalled: nothing has been decided since Nov 3, and 260 changes wait across 5 projects. The tab asks the user to
judge every trim and every memory of a split one by one, and the user found every review layout drawn for it too
hard to use. The fix is to stop asking about what the user always accepts: Arc applies the routine changes itself
and reports them with Undo, and the tab asks only about the few decisions that change what a project's sessions
load.

## Goals

- Opening the tab shows only what needs the user, and each of those is one decision.
- Routine changes happen without the user and can each be undone afterwards.
- Nothing a split brings over is lost if applying it fails or stops part way.

## Non-goals

- Changing the check's model pass or how one change applies and undoes.
- Index size cards and per-project size meters: sizes and limits are left to the check.
- A project picker: the tab no longer has a project rail or a per-project page.

## Anti-goals

- Applying, without the user, anything that moves memories out of a shared memory or edits a checked-in file.
- Switching a project over while a memory it should have is not yet in its own folder.
- An Undo that leaves a split half undone without saying so.

## Decisions

**Arc applies routine changes on its own.** After each check, Arc applies the trims, deletes, merges and index adds
it proposed. A change whose memory changed on disk since the check is skipped and left to the next check. Why: the
user applied 122 of 124 such decisions; asking about them is what stalled the review.

**What waits for the user.** A project getting its own memory (a split), clearing memories from a shared memory (a
cleanup), a move into a repo doc (it edits a checked-in file such as AGENTS.md), and a project whose last check
failed. Each is one row. Why: these change what sessions load, or touch the repo, or need a person to retry.

**The tab is one page.** A centered column: the title, one line on what Arc does on its own, a "Waiting for you · N"
list, then "Arc did this week". No project rail, no index size cards, no detail column. A row opens in place under
itself, one at a time. With nothing waiting, the page says "Nothing waits for you" and names the next check. Why:
the user wants to act, not to navigate; every layout with a rail and a table was rejected.

**A split is one row.** "Give MP-Frontend its own memory", with how many memories come over (moves and copies) and
how many stay in the shared memory. Opened, it shows four memories to spot-check, Show all, and Keep sharing /
Apply and switch over. Keep sharing is the existing keep of the switch-over. Why: the decision is the switch-over;
its 91 memories are evidence, not 91 decisions.

**A memory sorted wrong can be left out.** In a split's full list each memory has Leave out; a left-out memory
reads "Left out" with Bring back, and the row's counts follow. Move and copy cannot be swapped. Why: the user kept 2
of 83 on the one split decided so far, both by leaving them out.

**One Apply brings everything over, then switches.** Apply brings every move and copy not left out into the
project's folder, then switches the project over, showing "Bringing over N of M" while it runs. Why: switching first
would drop memories from the project's sessions.

**Apply stops before switching when it must, and resumes.**
- A memory changed on disk since the check is skipped: Apply brings the rest, then stops with "N of M already here",
  how many changed, Check now, and Undo the N. The Apply after that check finishes and switches over.
- Memories written to the shared memory since the check stop it before switching the same way, with Check now:
  they have no sort, so switching would leave them out.
- A failed move or copy stops it, names the memory and the error, and offers Undo the N or Try again.
- A stopped Apply stores no error: the row reads "N of M here" and Apply brings over the rest. The same state covers
  a split partly applied one change at a time before this change.
Why: one click still does most of the work, and only a fresh check can sort a changed or new memory.

**One Undo for an applied split.** An applied split moves to "Arc did this week" with See memories and one Undo,
which reverses the switch-over and every move and copy. Undo is refused while a cleanup of the shared memory has
removed any memory the split brought over, and says to undo that cleanup first. Why: undoing it then would leave
the project's sessions without those memories, with no step failing.

**Clearing a shared memory is one row.** Once no project loads some memories of a shared memory, their removal is
one row: how many, the list with Leave out, Keep them / Clear N, and one Undo once applied. A memory any project
left out of its split is never proposed. Why: same shape as a split, and a bulk removal must not delete what the
user chose to keep.

**What Arc did.** "Arc did this week" has one line per project per apply: when, how many by kind, and what it skipped
because the memory changed after the check, with See changes and Undo. See changes opens the line in place: each
change with its own Undo, the project's index size after the changes, and Undo all N. Applied splits and cleanups
sit here too. Why: changes made without the user must be easy to inspect and reverse.

**A failed check waits for the user.** A project whose last check failed is a row with the reason ("Check
interrupted by a restart") and Check now. Why: with no rail, a failure has nowhere else to show.

**The count is what waits.** The Setup toolbar counts what waits for the user: each split, cleanup, move into a repo
doc and failed check is one. Why: the count should match the decisions the user makes.

**The look.** Arc's colors, type and controls from the design system; the layout and flow are new. Why: the first
boards for this design looked foreign next to the app.

## Left to the builder

- How keys move through the rows and act on an opened row.
- The motion each row uses as it opens, applies, and moves to "Arc did this week".
- How long a line stays under "Arc did this week".
- Whether a change under See changes opens its evidence and diff.
- The setup-memory scenario steps that show each prototype board's state.
