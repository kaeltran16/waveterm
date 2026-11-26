# Subagents in the transcript — design

Date: 2026-11-26
Status: design
Prototype: canvas `transcript-subagents`, boards PickStep (the live line and Open), SubagentAsWorker (the subagent
view), NowLineSubagents (after the turn: the running background step kept out of the fold, and named in the now line
while the parent is idle).

## Intent

The Rendered view shows a Claude Code subagent only as an Agent tool step and, for a background one, a later
"Subagent finished" notice. What the subagent does in between is not visible from the parent's transcript; the
earlier Rendered round left subagent internals out on purpose, and nothing tracked the gap.

What matters most is supervision while it runs: from the parent's transcript, see what each running subagent is on
right now without leaving the parent. Second, after it finishes, be able to read what it did behind the report it
returned. This follows the Rendered round's goal of staying in Rendered for a whole session.

## Goals

- Each Agent step shows its subagent's live progress while it runs, and its outcome once done.
- Any subagent opens in the center as a full-size, read-only transcript, the way a worker's transcript reads.
- A background subagent that outlives the parent's turn stays findable.

## Non-goals

- Steering or replying to a subagent: it has no input channel.
- Showing the subagent's steps inside the parent's timeline (inline, threaded or in the step body).
- Nested subagents: Claude Code writes a flat layout.
- Codex or pi subagents.

## Anti-goals

- Never show a subagent as running after its transcript finished: no frozen spinner.
- Never hide a running subagent: not in a fold, not off the end of the now line.

## Decisions

**The live line on the Agent step.** While the subagent runs, its Agent step carries a second line: the subagent's
current call (verb and target, named as a step row names them) on the left, its tool count on the right; the step's
own facts show the elapsed time with the running spinner. Once it finishes, the line reads its outcome (done,
failed or stopped) with the tool count, and the step shows its duration. Why: one glance at the parent answers what each
subagent is doing.

**A background step stays running until its subagent finishes, and stays out of the fold.** Its tool_result (the async
launch ack) lands at once, but the step keeps the spinner and the live line until the subagent finishes. When its turn
ends, the turn folds into "Worked for N" as usual, except that a step whose subagent still runs is kept outside the
fold, right under the fold line, the way the last canvas reveal is kept out today; once the subagent finishes, the step
joins the fold. This holds for an older turn too, after later turns have started. Why: the fold and the ack would
otherwise hide exactly the subagent you want to watch.

**When a subagent counts as finished.** A subagent is finished when any of these holds: its transcript ends on a
terminal assistant turn; its meta file records it finished; its meta file records it stopped by the user, or its
transcript ends on the user's interrupt marker; the parent's session has ended (its Claude process exited) while the
subagent never wrote an ending. Outcomes are three: done, failed, and stopped (the user stopped it, or it was lost
with the parent), and stopped reads neutral, like done. There is no quiet-file timeout: a single long tool call can
write nothing for minutes. Why: each signal is a fact on disk or in the agent's state, so the live line never keeps
a frozen spinner, and none of them guesses.

**Ways in.** The Agent step row carries an Open button at its right, running or finished; so does the subagent's
finished notice. The tree's subagent row and the now line's entry open the same view. The step row's own click keeps
expanding its body as today (the report a foreground subagent returned). Why a separate button: a row that sometimes
expands and sometimes navigates would surprise, and the report stays readable without leaving the parent.

**The subagent view.** One view, reached from every way in, replacing today's compact subagent interior. It fills the
center the way an ended worker's transcript does: the same transcript renderer every agent uses, at full size (tool
cards and thinking lines on, not the card-width compact variant), in the transcript column, live while the subagent
runs, with the jump-to-latest pill. Above it, a banner like the ended worker's: state, type, "subagent of <parent>",
elapsed, tool count, read-only, and "↑ parent"; Esc does the same. No message box: a subagent takes no input. Its own
now line shows its running call and elapsed from the transcript (there is no terminal spinner to read), and done once
it finishes. Going back returns to the parent's view where it was: its Rendered view where it was scrolled, or its
terminal when the subagent was opened from the Terminal view. Why: a subagent reads like any
other agent's transcript, and the center is the only place the full-size renderer fits.

**Running subagents in the parent's now line.** Whenever a background subagent of this agent is running, the now line
shows it, whether or not the parent is working:

- Parent idle: the now line, otherwise hidden when the agent is idle, shows only the running subagents: the most
  recent one named (type, current call, elapsed) as a button that opens it, and with more than one, "N subagents
  running" on the right. It adds no done text for the parent's turn: the fold line already carries the turn's time
  and count, and a finished turn with no running subagent keeps no now line, as today.
- Parent working: the working line stays as it is, and a compact "N subagents" button sits at its right end, opening
  the most recent one. It gives way before the spinner, which never truncates.

It leaves when the last running subagent finishes. Why: the now line is always in view, so a running subagent is
findable from any scroll position and any later turn, and every other agent's idle tail stays unchanged.

**Linking a step to its subagent.** A step finds its subagent through the toolUseId in the subagent's meta file, which
is the Agent call's own id, so the join is exact. Matching the first prompt stays as the fallback for files with no
meta. Why: the step is drawn from that call id, and the prompt match missed about 4% of files when measured in July.

## Constraints

- Colors from the existing theme tokens; no new tokens. Layout and type follow DESIGN.md's Transcript section.
- Logic that decides state (the live line's text and outcome, whether a step counts as running, the now line's
  entries) lives in pure model code with unit tests beside it.

## Left to the builder

- How the step gets each running subagent's current call and tool count: the subagent listing already reads every
  file's last record on the parent's activity and can return them, or running files are tailed. And how often it
  refreshes while the parent is quiet, since a background subagent runs while the parent waits.
- Where the Open button gives way at narrow widths.
- A CDP scenario step for: the live line, a background step held running, Open from the step, the notice and the now
  line, and the subagent view with its banner.
