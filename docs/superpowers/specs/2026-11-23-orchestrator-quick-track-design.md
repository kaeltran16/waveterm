# Orchestrator fast track for small runs

## Intent and why

Small multi-part work (4 tasks or fewer) pays most of a full orchestrator run's fixed cost today. Runs of 1-2 tasks
take 28 min median and runs of 3-4 tasks take 54 min, and 57-59% of that is outside the tasks: lead planning, a
plan review of up to two rounds, per-task reviews, the Final stage and the land. The fast track gets such work done
in less wall-clock time without dropping the checks that catch real defects. It is a different path through the
existing engine, not a new run engine. Google Antigravity's /swarm was the starting example: briefs instead of a
reviewed plan, parallel workers, and a verifier over their diffs. The fast track keeps those ideas and keeps Arc's
code-enforced review, merge and Verify, which the swarm leaves to the model.

## Goals

- Small runs start their workers sooner and finish sooner than they do on the full path.
- Workers still run in parallel worktrees, since doing 3-4 tasks one after another costs more than the plan review
  saves (38.8 min of summed worker time ran in 23.6 min of wall clock).
- The checks that find real defects stay: a plan review in a lighter form, a review of the code, Verify at merges,
  the Final stage.

## Non-goals

- No worker-to-worker channel or shared message board.
- No Arc-built team engine, and no Claude agent teams inside runs.
- No change to Quick runs, to goals the lead does itself without a plan, or to runs of 5 or more tasks.
- No new launcher choice or flag.

## Anti-goals

- A faster run that lets through defects the plan review or task review would have caught (missing UI scenario
  steps, spec contradictions, real bugs, weak tests).
- A small run that reads as broken because a step the user is used to seeing is gone.

## Constraints

- The lead always explores the code and writes the plan before the engine dispatches anything; the fast track
  changes only what comes after that.
- Design sessions and their agents start runs today through Approve, Build this… and `wsh runs start --spec`; that
  flow must not change.

## Decisions

### Which runs take it

Every orchestrator run whose plan has 4 tasks or fewer takes the fast track, automatically, however it was started;
5 or more goes the full way. Nobody sets a flag. Why: the task count is known only once the lead has split the
work, which is after every point where a person or the dispatching agent could choose.

A plan handed straight to the engine as a file follows the same count. A dag submitted as JSON, with no plan file,
keeps today's behavior, per-task reviews included. Why: it never had a plan review, so dropping its task reviews
would leave its code unreviewed until the end.

The track is decided once, when the plan is first submitted, and holds for the whole run. A plan the lead amends
past 4 tasks before dispatch goes the full way (the full two-round plan review and per-task reviews). Fix-round
tasks do not count toward the limit. Autonomous and Ask me approvals behave as today.

### The short plan

For 4 tasks or fewer the lead writes a short plan in the existing plan format. Each task keeps its goal, its Files
line, its Depends line and its acceptance criteria, including the scenario step for any UI it changes and any named
tests the plan skill asks for; the plan keeps its Setup, Verify, Final and Spec lines. What gets shorter is
everything else: no prose beyond what a worker needs to build the task. Why: workers build only from their task's
text, the light review looks for scenario steps in the acceptance criteria, and the end review checks the code
against them.

### The light plan review

One reviewer, on the Light reviewers route, reviews the plan once. Code builds its brief: the task list, the spec
(or the prototype when there is no spec), the dependency edges the engine parsed, and the contents of every file the
tasks' Files lines name. Nothing from the lead's reasoning goes in. Why: today's reviewer spends its time reading
those same files; handing them over saves that time, and building the pack in code keeps the lead's framing out.

It checks four things, the ones small-run plan reviews actually find: every UI the plan changes has a scenario step
(30% of their findings), the dependencies and order hold (14%), nothing contradicts the spec (14%), and the Files
lines cover every file and caller the change touches (11%). The reviewer can still read the repository, so a file
missing from the pack can be found. It passes, or it lists findings.

On findings the lead amends the plan and the run dispatches. There is no second review round. Why: the full path's
round 2 and the lead's revisions between rounds are the part a small run can skip; the first-round catches are the
ones nothing later makes before work starts.

A light reviewer that ends without a verdict is lost as today, and the engine starts a fresh light review; a plan
never dispatches without one verdict. Why: with no second round, a lost reviewer would otherwise mean no plan check
at all.

On a Reviewer picks run the light review runs on the reviewer route and picks each task's model, as the full
reviewer does; on every other run it uses the Light reviewers route and picks nothing. Why: Reviewer picks is a
choice the user made, and picking models is a call the design gives the reviewer route.

### Tasks

Tasks run in parallel worktrees, merge and run Verify exactly as they do today, with no per-task review. Why: on
small runs task review failed 4 times in 81, and the review at the end can catch what it catches.

The task reviewer's other duties move, none are dropped:

- A task's For later tasks and downstream notes reach its dependent tasks when it merges, instead of on a review
  pass. Why: that is how a dependent task learns what its predecessor changed.
- The lead still gets each task's lines on merge, the ones a review pass posts today: a quiet line naming the task as
  merged and one caveat line each for the worker's Differs from plan, Not verified and Found not fixed. Like today's,
  they ride on the lead's next wake rather than waking it on their own.
- A worker's Not verified notes still become the final stage's unverified reasons.
- Goalpost findings (a skipped or deleted test, a loosened assertion, a bypassed hook) go into the end review's brief,
  which judges each by name. Why: they are the main code check against weak tests.

### The review at the end

After the last task merges, one reviewer on the reviewer route (the model task reviewers use today) reads the whole
merged diff against the spec and each task's goal and Files line. It looks for what task reviews catch: real bugs,
weak or missing tests, acceptance criteria not met or not proved, edits outside a task's files, and mismatches with
the design, and it judges each goalpost finding. A failure goes to the lead the way a failed Final step does today,
and is fixed through the same fix round. Why: one review over the combined work keeps the catches without a review
hop per task.

The end review runs alongside Check, Verify and Final in the final stage, not before them, and the stage waits for
its verdict as it waits for the verifier's when that runs alongside. Every failure, the review's and the commands',
reaches the lead in one fix round, and a rerun of the final stage reruns the end review too. Why: it adds no wall
clock when Final takes longer than a review, and one fix round covers everything found.

Fix-round tasks get no per-task review either. The end review runs again in every round, over the whole run's merged
diff, so a fix is judged in context and no fix-round code lands unreviewed.

### Final and land

The Final stage and the land are unchanged.

### What the user sees

No new surface or view; the fast track reuses rows the run already draws.

- The plan review shows one reviewer row titled Light review, in the reviewer rows the agent tree and run timeline
  draw today.
- Tasks skip the per-task Reviewing state.
- The review at the end shows as a step of the final stage, running beside Check, Verify and Final as the verifier
  does when it runs alongside.
- The words fast track show where autonomous does: last on the run sheet's settings line, tinted as a mode, and
  in the route line of the run card `wsh runs show` prints (claude opus · fast track). Why: a run without a second
  review round or task reviews then reads as intended, wherever the run is seen.

## Deviations

- The Timeline board (B) of the design canvas adds a run-timeline row at submit ("Fast track: 3 tasks, one light
  plan review…"). It was an alternative to board A, and the approved design shows the label only on the run sheet
  and the run card, so that row is not built. Its run-sheet and run-card lines are board A's.

## Left to the builder

- The lens key and its title, kept consistent between the backend and the frontend.
- How the pack caps very large files.
- How the lead's prompt asks for the short plan inside the existing plan format.
- Where exactly the Fast track label sits on the run.
- How the review at the end is wired into the final stage beside Check and Verify and recorded in the run's events.
- The scenario steps that show the Light review row, the end-review step and the label.
