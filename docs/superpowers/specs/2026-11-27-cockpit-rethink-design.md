# Cockpit rethink: thumbnails that zoom

## Intent and why

The Cockpit stays its own surface and keeps the job it was designed for: a calm control room for many parallel
agents across projects. At a glance it answers four questions: who waits on you, who is working, what just
happened and what is idle. You triage and reply in place, keyboard-first. What changes is how it does that job.

The current Cockpit was built for 3-10 agents whose asks you answer in place. Work now goes through
**conductors**: one long-lived agent per initiative. It brainstorms, settles the spec, creates the initiative and
dispatches runs. After a compact, it watches those runs and carries the initiative on: it updates it, runs
commands and dispatches the next run. Runs rarely need the human. Their leads or the conductor settle most of what
comes up: over 30 days, conductors landed 62 runs, answered 10 asks and reran 6 Finals on their own.

Today's Cockpit gets this wrong in three ways:

- It shows conductors and their runs as unrelated cards.
- It counts only asks as needing you.
- It folds a conductor that finished its turn into the Idle list after 5 minutes.

## Goals

- One glance shows every session you talk to, what it last said, and the runs it is watching.
- You act in a session the way you do on the Agent surface, without leaving the Cockpit.
- A run's wait reaches you only when its conductor cannot settle it.

## Non-goals and anti-goals

- No folding the Cockpit into Hub or the Agent surface.
- Hub is unchanged, its Waiting on you list included. This rethink is about the Cockpit's own job.
- No home dashboard (headline numbers, run lanes, charts). That direction was set aside.
- Anti-goal: a run's ask or failed Final that skips its conductor and lands on you. It would defeat the point of
  having a conductor.
- Anti-goal: thumbnails that jump as their state changes.

## Constraints

- No backend change. Each run already records the conversation that dispatched it (its origin transcript) and the
  initiative chunk it executes.
- `/compact` keeps the transcript, so the conductor link survives it. `/clear` starts a new transcript and breaks
  the link; that is accepted.
- Use existing theme tokens only: the waiting color for your turn, the muted ink color for waits a conductor has.
- Render cost: several live transcripts on screen multiply render work, and infinite CSS animations are already
  known to cost display rate in the Cockpit. Thumbnails stay static apart from new lines arriving.

## Approach

Every session you talk to is a live **thumbnail**, laid out in a grid. One key zooms the selected thumbnail to
the full session inside the Cockpit, and Esc returns to the grid.

## Decisions

**Which sessions get a thumbnail.** Every live conductor and every plain conversation. A conductor is any live
agent whose transcript is the origin of a run; any other agent is a plain conversation. Run agents (leads,
workers, reviewers) never get a thumbnail: they show as run lines under their conductor. Dismissed and quiet
sessions fold into one Idle line. Why: thumbnails go to the sessions you type into.

A quiet session is one that was never prompted, or that was already idle when the Cockpit first saw it (after an
app start, for example). It starts in the Idle line as if dismissed, and its next finished turn brings it back.
Dismissals stay in memory. Because a session found idle at startup starts in Idle anyway, a restart does not fill
the grid with stale Your turn thumbnails.

**What a thumbnail shows.** From top to bottom:

- The header: name, state and age.
- The last few lines of the transcript, at a readable size.
- The session's runs, one line each with its stage.

A session with no runs today says so. Why: it reads like the Agent surface, just smaller, and runs are visible
without zooming.

**Session state.** Each session is in one of four states:

- **Asks you**: it has an open ask.
- **Your turn**: it is idle with no background task.
- **Watching**: it is idle with a running monitor, background shell or background subagent.
- **Working**: anything else.

Asks you and your turn take the waiting color.

**How long a finished turn stays your turn.** A conductor or conversation that finished its turn stays your turn
until you reply or dismiss it. Dismissing moves it to the Idle line until it next finishes a turn. Nothing ends it
on its own, so the 5-minute idle grace no longer applies to sessions. Why: a finished turn is where a conductor
hands back to you.

**Which runs a thumbnail lists.** A conductor's runs that are still live, plus those that landed, failed or were
cancelled today, newest first. Why: what a conductor finished today is what you check before telling it what to
do next. Older runs belong in the run history.

**A run that waits.** The run line shows the run's stage. While the run waits (an ask, a failed Final, a held
landing, a plan to approve), the line says what it waits on and that the conductor has it, in the muted color.

While the conductor is Working or Watching, the wait stays the conductor's: a running monitor means it will see
the wait. The wait becomes yours at once, and the line takes the waiting color, in three cases (Asks you counts as Your turn here: a conductor waiting on its own question cannot see the wait either):

- the conductor is on Your turn when the wait opens;
- the conductor ends a turn into Your turn with the wait still open;
- the conductor exits.

A 5-minute timer runs only while the conductor is Watching, not while it is Working. When it runs out, the wait
is yours.

Why: the conductor is the first responder. A conductor already on Your turn cannot see the wait. The timer covers a
watching conductor whose monitor misses the wait.

**The attention popup follows the same rule.** The desktop attention popup fires only when a run's wait becomes
yours, never when it opens. So the escalation rule lives in the shell, shared by the Cockpit and the popup: the
Cockpit unmounts when you switch surfaces. Hub's Waiting on you list stays the full queue, unchanged. Why: a ping
for a wait your conductor will settle is the anti-goal.

**Runs with no conductor.** Some runs have no live conductor: runs started from the launcher, and runs whose
conductor exited or was cleared. They sit in one strip under the thumbnails, one line each with their stage. Their
waits come straight to you. Space on a strip line opens that run on its own surface, since there is no session to
zoom into. Why: they still need a glance, and no thumbnail owns them.

**Order.** Thumbnails keep the anchored order today's grid uses. Each holds its slot, new ones are added at the end,
and a thumbnail that turns to you is marked by its state, not moved. Why: movement under your eye or cursor breaks
the glance.

**The zoomed view.** Space zooms the selected thumbnail into the session at full size inside the Cockpit:

- **Middle:** its transcript and composer.
- **Right:** the session's own workspace pane, the same pane and tabs it has on the Agent surface.
- **Bottom:** the other sessions as a filmstrip, so you can hop between them without zooming out.

Esc returns to all thumbnails. The view reuses the Rendered transcript and its composer. Why zoom rather than
switch to the Agent surface: triage is a loop (reply, Esc, the next session), and a surface switch breaks it and
loses the grid. The zoomed view is the Agent surface's parts placed in that loop; what only the Cockpit has is the
grid, the escalation rule and triage. Why the session's own pane: its state is already kept per agent, so tabs opened in the Cockpit are still there after Enter, and the run
detail (tasks, activity, graph, waiting rows, the Final) is built once, in the pane.

**The workspace pane in the zoomed view.** Zooming adds, without taking focus, a Run tab for each run the
thumbnail lists and an Initiative tab for each initiative those runs work on. The pane keeps the agent's other
tabs (Docs, Changes, a file). The tab strip is the run list: the active tab defaults to the run that waits, else
the newest live run, else the newest run. `[` and `]` move between tabs and d collapses the pane to its strip, as
on the Agent surface. A session with no tabs shows no pane. A waiting row folds away once handled.

A Run tab's waiting dot follows the escalation rule: the waiting color once the wait is yours, the muted ink
color while the conductor has it. Its waiting row says which, and how long the timer has left while the
conductor is Watching.

**Initiatives.** The zoomed view shows them as the pane's Initiative tab: chunks done out of total as a segmented
bar, and the chunk list with the run's chunk marked. Thumbnails leave the initiative out. Why: it keeps room for
the last turn, and the run-to-initiative link is per run and advisory.

**What stays from today.** Only keyboard triage: arrow keys move between thumbnails, Space zooms, d dismisses.
The following go:

- the status tabs;
- the Backgrounded and Idle sections;
- Live only;
- the project switcher;
- the Events rail;
- the agent and run cards;
- the t and b keys;
- the hints bar;
- the background-subagents strip. A background subagent already makes its conductor read Watching.

Thumbnails are read-only: every ask answer and reply goes through the zoomed view, where an open ask shows its
answer bar above the composer. Why: you reply with the transcript in view, and thumbnails stay simple.

Enter opens the selected session on the Agent surface. The header keeps one count of sessions on your turn, and a
short line saying Space zooms and Esc returns.

The Cockpit always shows every project and ignores the app bar's project scope. Why: a scope set on another
surface must never hide a session that waits on you.

Why: the thumbnails and the Idle line show what the tabs and sections showed, and catching up already happens in
the conductor's turn ("check the initiative" was typed 204 times in 30 days).

## Motion

Every state change maps onto a moment in `docs/reference/motion-system.md`; nothing adds new vocabulary.

Grid:

- Space zooms: the thumbnail's frame morphs into the zoomed view (moment 17) while its content cross-fades. Esc
  plays it back and lands on the same thumbnail, still selected. If mounting the Rendered transcript under the
  morph drops frames, fall back to moment 1 scaled from the thumbnail's position; measure before choosing.
- Arrow keys: the selection ring slides to the next thumbnail (moment 9).
- A new transcript line fades in (moment 5, with its burst guard); older lines move up without animating.
- A session's state changes: the chip cross-fades and the "on your turn" count rolls (moment 12).
- A run's wait becomes yours: the run line's text cross-fades, then one change flash (moment 14). It is the one
  change that must catch the eye.
- A run line arrives (moment 1); a run that lands settles once (moment 4).
- d dismisses: the thumbnail leaves and the grid reflows (moment 2); the Idle count rolls (moment 12). An idle
  session that finishes a turn enters at the end (moment 1) and nothing else moves.

Zoomed view:

- Hopping through the filmstrip swaps the view (ViewSwap) and slides the filmstrip ring (moment 9).
- A handled waiting row's card folds away (moment 6b); the row's stage, the head's state and the tab dot
  cross-fade. A failed action nudges its buttons (moment 13).
- An answered ask collapses the answer bar (moment 6).
- A wait that becomes yours while zoomed recolors the row, card and tab dot, then one change flash on the card
  (moment 14). The timer's minutes left roll (moment 12).
- Tabs, `[` and `]`, and d reuse the workspace pane's own motion.

Never in the grid: the attention glow (moment 3) or any other infinite animation, and no spinner on a live step in
a thumbnail (a static ring). Why: the render cost constraint; the amber chip already marks who waits.

## Left to the builder

- How runs join to a live session (by transcript path, as the project history view already does).
- Where a transcript's last turn is cut for the thumbnail.
- How the zoomed view mounts the Rendered transcript, the composer and the session's workspace pane.
- How many sessions fit before thumbnails shrink or scroll. Usually 2-3 conversations are open, with peaks of
  8-12.
- The arrow-key path through the thumbnails and the strip.
- Which verify:ui scenarios change.
