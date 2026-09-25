# Using the orchestrator

How to run work through Jarvis's orchestrator as it behaves after the 2026-09-14 redesign and the Agent
surface follow-ups. Every screenshot is from the dev app on 2026-09-17 or 18, taken while running the flow it
illustrates: a sandbox repo built to break on purpose (`orch-guide-demo`), a Quick run in the same repo, and
the backlog-cleanup initiative run through a goal-led orchestrator.

The design lives in `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md`.
`docs/orchestrator-howto.md` is the record of the pre-redesign engine (plan gate, adaptive runs) and is
history, not instructions.

The 2026-09-25 findings fixes changed how a run starts and ends, and the screenshots predate them. An engine
run now lands on its own branch by default ([Where a run lands](#2-where-a-run-lands)). A reviewer checks the
plan before any worker starts ([The plan review](#the-plan-review)). A final stage judges the combined result
before the run is done ([The final stage](#the-final-stage)). The engine merges the branch back when the run
completes ([Landing back](#landing-back)).

## Pick a flow

| You have | Use | What runs |
|---|---|---|
| One small change you can describe in a sentence | **Quick** | One fresh worker. No lead, no plan. It stops and asks if the goal turns out bigger. |
| A goal that still needs design decisions | **Orchestrator → A goal** | A lead brainstorms it with you in its terminal, then either does it itself or hands the engine a plan. |
| A plan already written in the plan format | **Orchestrator → A plan file** | The engine runs the plan at once. A lead is launched only when something needs judgment. |

Everything else in this guide is how to watch those three and what to do when they need you.

**The division of labor.** Code does the mechanics: scheduling, worktrees, Setup, merges, Verify, the final
stage's commands, retries, and merging the run back. Fresh reviewer sessions judge the plan, each task and the
combined result. The lead only judges what they turn up: questions, failures, conflicts, a failed Verify, a
failed review, a failed final stage. You get what the lead cannot or should not decide.

---

## Before you start

### 1. Register the project

+ Run lists projects from `projects.json`, not from anything you have talked about in Jarvis. Open the
project switcher in the app bar → **+ New project**, give it a name and the repo's local path, and
**Create project**. The command palette's "New project" opens the same modal.

![New project modal](images/orchestrator-guide/01-new-project.png)

### 2. Where a run lands

An orchestrator run lands on its own branch by default. At launch it creates `wave/<runId>` in a tree at
`.waveterm/worktrees/<runId>`, and records the branch the checkout is on as the run's base. Its lead works in
that tree, its lanes squash-merge there, and Verify runs there. The plan's Setup runs there once when the plan is
submitted. For this repo that is `task worktree:prepare`, which junctions `node_modules`, `src-tauri/target` and
`dist/bin` from the main checkout so tests run. The checkout does not move, and a dirty index there does not
hold the run's merges. When the run completes, the engine merges the branch back into the base itself (see
[Landing back](#landing-back)).

To land in the checkout instead, set **Runs land on → Project checkout** in the profile (global, or per project),
or pass `wsh runs start --landing checkout`. The flag wins over the profile, and an empty profile means branch.
The lanes then merge into whatever branch the checkout has checked out, the merge path refuses a dirty index, and
there is nothing to merge back. A run with no base (an unborn repo, or a directory that is not a git repository)
lands in the checkout either way. A run started on a detached HEAD gets its branch, but has no base branch to
merge into, so its land-back is held.

On a landed run the engine removes the tree and deletes `wave/<runId>` itself. A cancelled run, or one whose land
is held, keeps both. In this repo, remove them with `task worktree:cleanup -- .waveterm/worktrees/<runId>`:
Setup junctioned `node_modules`, `src-tauri/target` and `dist/bin` into the tree, and a plain
`git worktree remove` can follow those junctions and delete the main checkout's copies. It deletes the branch
only once merged; `git branch -D wave/<runId>` drops an unmerged one. In a repo whose Setup makes no junctions,
`git worktree remove .waveterm/worktrees/<runId>` and `git branch -D wave/<runId>` do the same.

For this repo there is a second reason to keep the branch default: the dev app serves the frontend from the main
checkout, so a merge landing there triggers HMR reloads mid-run.

To have a run start from, and merge back into, a branch you name, give it its own worktree by hand and register
*that* path as the project:

```bash
git worktree add -b backlog-cleanup .worktrees/backlog-cleanup main
cd .worktrees/backlog-cleanup && task worktree:prepare
```

### 3. Know which app you are driving

The packaged app and the dev app keep separate stores. A run started in the dev app, its efforts and its
`wsh` calls all live in the dev store; `wsh` in a terminal of the packaged app talks to the packaged store.
Terminals the run spawns (the lead and every worker) get a `wsh` bound to the app that spawned them, so the
run's own commands always reach the right store.

### 4. Routes

Leads and workers run on **Claude Code** or **pi** only. A route is a harness plus an exact model; there are
no tiers. The launcher has two pickers, **Lead model** and **Workers model**; the workers inherit the lead's
route unless you pick one.

A pi lead needs the `@juicesharp/rpiv-ask-user-question` package (so its questions reach the cockpit) and the
superpowers package installed into pi itself (the lead plans with `brainstorming` and `writing-plans`).

---

## Flow 1: Quick

Open **+ Run** on the Jarvis Brief (or press `r` there). Pick the project, **Quick**, a route, write the
goal, **Start run** (`⌘⏎`).

![+ Run with the Quick shape](images/orchestrator-guide/02-quick-modal.png)

The Brief opens the run's sheet. A Quick run has no task graph; its worker's transcript is the whole run,
so **Open in Agent ↗** is where you watch it.

![A Quick run executing](images/orchestrator-guide/03-quick-running.png)

The worker is told that if the goal turns out to be more than one change or needs a design decision, it
should stop and ask instead of pushing on. That question arrives in **Waiting on you** like any other.
Settings are fixed for a Quick run: there is no scheduler to reconfigure.

This run appended one line to `README.md` and committed it; the sheet went to **Done** with its evidence
sealed.

---

## Flow 2: Orchestrator from a goal

### Configure the run

![+ Run configured for a goal-led orchestrator](images/orchestrator-guide/04-goal-modal.png)

| Control | What it decides |
|---|---|
| **Project** | Where the lead works and where lanes merge. Type to filter. |
| **Shape → Orchestrator** | A lead plus the engine. |
| **Start from → A goal** | "A lead works the goal with you in its terminal, then hands the engine a plan." |
| **Parallelism** | How many lanes run at once, 1-8, default 3. Lowerable on a live run. |
| **Lead model** | The lead's route. It brainstorms, writes the spec and plan, and later judges wakes, so this is the model whose judgment a retry cannot recover. |
| **Workers model** | Every task worker's route. "Same as lead" unless set. Changeable on a live run for tasks not yet dispatched. |
| **Goal** | What the lead starts from. |

The route picker filters by harness (**All / Pi / Claude Code**) and accepts a custom model id:

![The Lead model picker filtered to Claude Code](images/orchestrator-guide/05-route-picker.png)

For the backlog run: lead **Claude Code · opus**, workers **Claude Code · sonnet**, parallelism 3.

### The lead brainstorms with you

**Start run** creates the run and opens its sheet at **Planning** ("the lead is writing the plan"). Nothing is
dispatched until the lead submits a plan.

![A goal run in Planning](images/orchestrator-guide/06-goal-planning.png)

**Open lead ↗** takes you to the lead on the Agent surface. The lead runs `superpowers:brainstorming` against
the real code in its tree (the run's branch, or the checkout). The details rail's **Run** section reads
"planning · no plan submitted yet" until it submits.

![The lead brainstorming in its terminal](images/orchestrator-guide/07-lead-terminal.png)

### Answering the lead

The lead is told to put every question and approval through its ask tool, so each one lands in **Waiting
on you** on the Brief instead of scrolling past in a terminal. The Jarvis nav icon carries the count.

![A lead's question in Waiting on you, with the initiative it is working on expanded below](images/orchestrator-guide/08-brief-waiting.png)

**Review** expands the waiting list; clicking the row opens the run's sheet with the question as a
**Clarifying question** card:

![A lead's clarifying question on the run sheet](images/orchestrator-guide/09-lead-question-card.png)

- **Pick an option:** click it. A single-question, single-select card sends on the click. Ignore the card's
  "Press 1–9" hint for a lead's question: the sheet's digit and Enter keys only reach a worker asking from
  inside a plan task, and a planning lead is not one.
- **Answer in your own words:** do it in the lead's terminal on the Agent surface (the harness's own picker
  has a free-text choice). The card's "or type your own answer…" field has no send action on the Brief
  sheet today; see [Rough edges](#rough-edges-found-while-writing-this).
- **✕** dismisses the question.

Push back when an option rests on something you know is wrong. On the backlog run the lead's first question
recommended deleting four channel RPCs; the answer "delete them, but grep `scripts/` for callers first" made
it find that `deletechannel` is the teardown of the CDP scenarios, and it came back with a narrower option.

### What the lead does with the goal

The brainstorming skill classifies the goal. The lead states the path it takes and proceeds, asking about the
path only when it is genuinely unclear, and finishes accordingly:

| Class | The lead | You see |
|---|---|---|
| **Spike** (a question to answer) | reports the answer, `wsh jarvis complete` | Done, with its answer as the summary |
| **Bounded** (one change) | asks for your yes, implements in its tree (the run's branch, or the checkout), tests, commits, `wsh jarvis complete --commit` | Done, with the commit, merged back |
| **Architectural** (needs a plan) | asks the decisions it needs as questions with options, writes the design straight into the spec, asks one **Spec review** (the spec's path on the question's first line), writes the plan with `superpowers:writing-plans`, runs `wsh jarvis dag submit --plan <plan> --spec <spec>` and stops | the plan review, then the sheet fills with tasks |

The Spec review is the one approval: the lead does not ask section by section, and after `dag submit` it does not
ask you to review the plan or pick an execution mode, since the engine reviews the plan.

After `dag submit` the engine waits for the lead to go idle and types a `/compact` that keeps what you said and
drops code it read. Every compaction of a lead re-injects its orchestration rules (`wsh jarvis dag rules`), so
it knows it is the lead of a run when it next wakes.

On a run landing on its own branch, `dag submit` commits the spec and plan to `wave/<runId>` before any lane is
cut (subject `docs: spec and plan for <title>`, trailer `Arc-Run: <runId>`). Every lane branches from that
commit, so each worker and reviewer reads that snapshot in its own tree, never the lead's live copy, and the docs
land with the run. A resubmit with revised docs commits them again; identical content commits nothing. On a
checkout-landed run the docs stay uncommitted until the first lane merges, and the engine folds both into that
lane's squash commit.

A lead that exits before submitting fails the run with a **Lead exited** row.

### Writing the goal

The goal is the only thing the lead starts from. The backlog run's goal named the effort to read, the scope
and the one chunk excluded, where the verified facts live, and the constraints the plan must carry (Setup and
Verify commands, which tasks must share a lane, "locate by symbol, not line number", close the chunk before
`wsh jarvis complete`). Pre-answering decisions there saves a round of questions.

Check that the constraints don't force a serial plan. That goal also said "each task updates its tracker row
in the same commit" and "two tasks that edit the same file must not run in parallel". Every task would then
edit `docs/open-issues.md`, whose rows sit on adjacent lines that conflict when merged, so the tasks could
only run one after another. The lead caught it and proposed code tasks that never touch `docs/`, plus one
final task that depends on all of them and updates the rows from each task's chunk note. A shared file
that every task must edit is what sets a plan's width, so keep that edit out of the parallel tasks.

---

## Flow 3: Orchestrator from a plan file

### The plan format

```markdown
**Setup:** `task worktree:prepare`
**Verify:** `npx vitest run`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`
**Prototype:** .superpowers/design/<topic>/<canvas>.dc.html

### Task 1: <title>
**Depends on:** none
...task text...

### Task 2: <title>
...no Depends line: runs after Task 1...

### Task 3: <title>
**Depends on:** Task 1, Task 2
```

- **Setup** runs in every new lane worktree before its first worker (2-minute limit), and once in a run's own
  branch tree when the plan is submitted. **Verify** runs where lanes land (the project checkout, or the run's
  own branch tree) after every lane merge (20-minute limit). Both are optional, both run in a POSIX shell (Git
  Bash on Windows).
- **Check** is a fast whole-project static check. Each worker runs it itself instead of Verify, and the final
  stage runs it once on the merged result. **Final** is one command the final stage runs on the merged result,
  and **Prototype** names the design canvas the result should match (a path, not in backticks). All three are
  optional; see [The final stage](#the-final-stage).
- Headings are `### Task N` or `## Task N`, numbered 1, 2, 3… in order.
- `**Depends on:**` must be the first line after the heading. Left out, the task depends on the task before it,
  so a plan with no Depends lines is **serial**. `none` means independent. References must point backwards.
- There is no task cap.
- **Every worker gets the plan's header.** Its prompt is the engine's worker contract, then the prose above
  Task 1, then its own task's section (`taskPrompt`, `engine.go`). This used to be the task alone: the backlog
  plan's header said "Never edit `docs/`. Task 13 writes all docs." and five lanes edited `docs/open-issues.md`
  anyway. Put rules every task shares in the header; a rule for one task belongs in that task.
- **Worker commit ids don't survive the merge.** A worker cites the commit on its lane branch, but the lane lands
  as a new squash commit. On the backlog run t-8's doc row cited `3f6d5814`, and what landed was `5eac07ed`.
  A later task that records commits should take them from `dag status` (its `landed` lines). A
  `git cat-file` check passes for either id while the lane branch exists.

The engine turns tasks into **lanes**: a chain where each task has one dependency and is its only dependent
shares one worktree and one branch, each task a fresh worker committing on top of the last, and lands as one
squash merge. The squash commit carries its workers' commit messages, oldest first, and names the lane in an
`Arc-Run:` trailer; the plan's task titles stand in only when those messages are empty. Independent tasks and tasks after a fork or join start their own lane. Lanes are what
parallelism counts.

### Start it

Pick **A plan file** and paste the plan's absolute path. The launcher parses it as you type and will not
start until it parses:

![A relative path is rejected](images/orchestrator-guide/10-plan-preview-error.png)

A plan with no Depends lines and no Verify is flagged **serial** and **unverified** before you start:

![A serial, unverified plan](images/orchestrator-guide/11-plan-preview-serial.png)

The sandbox plan: five tasks, five lanes, longest chain 2.

![The sandbox plan parsed](images/orchestrator-guide/12-plan-preview-ready.png)

A real one, the backlog cleanup plan its own lead wrote and then handed back: 13 tasks, 13 lanes, longest
chain 6. The preview line under the path is the fastest check that the Depends lines say what you meant.

The longest chain also sets how a run ends. The backlog chain is Task 2 → 3 → 4 → 6 → 7 → 13. Once the eight
independent tasks had landed, the run went one task at a time, with two of its three slots empty. `dag status`
reports such a stretch as `dependency-wait`, naming the task each waiter needs (the rail's Run section reads
"… waiting on …"). `parallelism-wait` ("waiting for a slot") means every slot is busy. To shorten that tail, cut
Depends lines in the plan. Raising parallelism won't help.

![The backlog plan in the launcher](images/orchestrator-guide/24-plan-dialog-backlog.png)

**Start run** submits the plan immediately. There is no approval step from you and no lead. The engine's plan
reviewer reads the plan first ([The plan review](#the-plan-review)), and the first layer dispatches once it
passes. The launcher submits no spec. On a branch-landed run the engine commits the plan to `wave/<runId>` at
submit; on a checkout-landed one it folds the plan into the first squash commit. A spec sitting beside the plan
stays untracked; commit it yourself.

![A plan run executing](images/orchestrator-guide/13-plan-run-started.png)

The engine launches a lead only at the first judgment event, with the orchestration rules as its prompt and
the event as its first line. A failed plan review is one. A plan that lands and ends its final stage passed or
unverified, with nothing to decide, never gets a lead: the engine closes the run, seals its evidence and merges
it back itself.

The sandbox plan (`orch-guide-demo/docs/plan.md`) was written to need judgment three ways, and the rest of
this guide uses what happened to it: task 1 sets `status.txt` to `broken` so Verify fails after it merges,
tasks 2 and 3 both rewrite the one line of `greeting.txt` so the second merge conflicts, and task 4 asks a
product question the plan's notes tell the lead to forward.

---

## The plan review

Both flows submit a plan file, and the engine reviews it before any worker starts. The dag's status reads
`plan-review`, and the scheduler dispatches nothing until the review passes or the lead accepts it. A dag
submitted as JSON, with no plan file, and a fix round skip it.

The engine starts a fresh plan-reviewer session in the tree where lanes land, on the lead's route. It reads the
spec, the plan and the files they name, and checks that:

- every requirement in the spec has a task;
- no two tasks edit the same file without a Depends between them;
- types, functions and flags have the same names in every task that mentions them;
- each task names its tests;
- the commands the plan names exist.

It also reports gaps in the spec and places where the spec and plan contradict each other. It only reads, and
ends with `wsh jarvis dag planreview pass "<summary>"` or `wsh jarvis dag planreview fail "<findings>"`. A
reviewer that ends without a verdict, or runs past 20 minutes, is replaced once. One lost twice fails the review
with the reason, and the same plan can be submitted again.

- **Pass:** the workers start, and the lead gets a quiet `plan review passed; workers are starting: …` line.
- **Fail:** the lead wakes with the findings. It revises the plan, puts any spec change to you, and runs
  `wsh jarvis dag submit` again. While no task has dispatched, a resubmit replaces the failed proposal and opens
  review round 2. A plan run started without a lead gets one launched by this wake.
- **Round 2 fails:** the lead must put it to you. If you say to proceed anyway, it runs
  `wsh jarvis dag planreview accept "<your reason>"`, and dispatch starts on the plan as it stands.

---

## Watching a run

### The run sheet

Open a run from **Waiting on you**, **Sessions**, or right after **Start run**. Top to bottom:

- **Verb** and subtext: Planning, Starting, Executing, Waiting on you, Landing, Blocked, Done, Cancelled.
- **Meter** (one segment per task) and chips: elapsed, worker minutes, landed, answered, forwarded,
  unverified, attention.
- **Questions for you**, when you hold any.
- **Tasks**: one row per task with its state and an action: **Open in Agent ↗** for a live worker, **View
  child run** for a finished one, **Open DAG ↗** for one blocked on a merge. Then a `next:` line saying what
  the run is waiting for.
- **▸ timeline**: every run event, newest first. **open the full timeline ↗** opens it in the DAG view.
- **Settings line**: `engine · orchestrator · lead … · parallelism … · workers …` with **Adjust**.
- **Dock**: **Open DAG**, **Open lead ↗**, **Ask Jarvis**, **Cancel run**.

A 13-task run a minute after its plan went in — every task listed with the reason it is not running yet
("waiting on …", "not dispatched yet"), the first three dispatched, and the settings line under them:

![A 13-task run executing](images/orchestrator-guide/21-run-executing.png)

The timeline is the most useful thing on the sheet when a run needs you. This is the sandbox run recovering
from its conflict and failed Verify, then taking the answer to its question:

![The run timeline](images/orchestrator-guide/16-answered-timeline.png)

### The DAG view

**Open DAG** shows the task graph with a **Lifecycle** rail (filters All / Task / Attention). Selecting a node
shows its detail panel. Per-node buttons appear only when a node needs a decision: `retry` / `skip` /
`escalate` on a failed or stalled task, `resolve` on a blocked merge or failed Verify, `merge` on a lane end
the engine is not merging itself. **Cancel** in its header cancels the DAG.

![The Route DAG view](images/orchestrator-guide/17-dag.png)

### The Agent surface

The Agent tree groups agents by project and nests a run's workers under its lead ("◆ name"), with a chip
for live workers or "N done". Finished workers fold under **✓ N done**. A worker row reads `t-4 · Pick the
sign-off` with its lane and state. Its header links back to the lead (**↑ lead**) and names its lane.

The details rail (`d`) carries a **Run** section for a lead (progress, lanes, health, the last timeline rows,
held questions) and a **Task** section for a worker (**plan · Task N ↗**, Lead, Lane, Depends on, Result).

![The sandbox lead after its run finished, with the run section in the rail](images/orchestrator-guide/19-lead-rail-done.png)

A goal-led lead reporting what it submitted, with its run row above it in the tree ("◆ backlog-cleanup ·
working · 0/13 done"). The lead stops there; the engine wakes it when it needs a decision:

![The lead after submitting its plan](images/orchestrator-guide/22-agent-tree-executing.png)

A landing doesn't wake the lead. Each task that passes review queues a line (`t-4 passed review: …`) that goes
out ahead of the lead's next wake, and the run-finished wake carries whatever is left, so the lead learns what
landed without a turn per task. `wsh jarvis dag status` shows each task's result and latest review. While the lead
waits at its prompt, its row reads `standing by`.

---

## When the run needs judgment

The engine wakes the lead by typing one self-contained line into its terminal (for example
`wake: Verify failed after merging task t-1 (exit 1). wsh jarvis dag status`). A wake that does not turn the
lead to working within 30 seconds is retried once; after that the lead counts as dead and its events come to
you.

| Event | The lead | What reaches you |
|---|---|---|
| **Plan review failed** | revises the plan and runs `dag submit` again; after round 2, asks you, and on your word runs `dag planreview accept "<your reason>"` | spec changes, and a second failed review |
| **Merge conflict** at a lane merge | fixes it where lanes land (the run's branch tree, or the checkout), commits, `wsh jarvis dag merge <task> --continue` | nothing, unless the lead forwards it or is dead |
| **Verify failed** after a merge | fixes it, commits, `dag merge <task> --continue` (re-runs Verify at HEAD) | same |
| **Review failed** twice, or the reviewer couldn't do its job | reads the findings in `dag status`; `dag sendback <task> "<guidance>"`, `dag approve <task>`, retry, escalate, skip or forward | forwarded review failures |
| **A passed task with a note for later tasks** that the engine could not deliver (no `--for`, or a named task already finished or without a live terminal) | amends the pending tasks the note affects (`dag amend`), or tells a running one (`dag tell`) | nothing |
| **A worker's question** | answers from the spec, plan and code, or forwards a product call with a note | forwarded questions and any it does not answer within **10 minutes** |
| **Task failed** with its retry spent | `dag retry`, `dag escalate --model`, `dag skip`, or forwards | forwarded failures |
| **Worker hung** (15 min silent, process alive, no ask pending) | same as a failure | same |
| **Worker never started** (5 min after spawn, its terminal's shell never came up) | `dag retry` | same |
| **Final stage failed** | writes a fix plan and runs `dag submit --round --plan <fix plan>`; puts it to you when no round is left or the fix is a product call | a failed last round, or a product call |
| **Run finished** | fixes and commits what the landed tasks left behind, writes the report to a file, adds open issues to the initiative, then completes on its own with `wsh jarvis complete --report <file>` | a question only when a decision is needed (a failed verification, a deviation, a proposed fix round), then the Done face |

### A task's review

Tests are not the only check. A worker ends by committing, writing its report to a file the engine names outside
every worktree (`<temp>/arc-reports/<dag>/<task>.md`), and running
`wsh jarvis complete --commit $(git rev-parse HEAD) --report <that file>`. The report covers what it did, what it
did differently from the task and why, what a later task must know, and what it could not verify and why. The
server refuses a task worker's `complete` without `--report`; leads and reviewers are not held to it.

When a worker finishes with a commit, the task goes to **reviewing** and the engine starts a reviewer in the
task's lane worktree, on the **lead's** model. The reviewer reads the task, the spec, the worker's whole report
and `git diff` of the task's commits. It checks the change against what the task asked for (missing requirements,
contradictions of the spec, cut corners, changes outside the task), and ends with one command:

- `wsh jarvis dag review pass "<summary>"`: the task lands as before. Adding `--downstream "<note>" --for t-3,t-5`
  hands what later tasks must know to the tasks named (the reviewer's brief lists the unfinished ones): the engine
  adds it to the prompt of a task that hasn't started and types it into a working one's terminal, and the lead reads
  where it went on its next wake. A note it can't deliver, or one with no `--for`, wakes the lead to route it.
  Adding `--unverified "<what, and why>"` records a check the task asked for (a test, a screenshot, a live run)
  that the diff and the report show was not done. The lead's `passed review` line prints it whole, first; `dag
  status` prints it under the task and in the report; and it becomes one of the run's unverified reasons at the
  final stage.
- `wsh jarvis dag review fail "<findings>"`: the first time, the task goes back to a worker in the same worktree,
  starting from the rejected commit with the findings in its prompt. The second time, it goes to
  **review-failed** and the lead wakes.

A reviewer that ends without a verdict or runs past 20 minutes is replaced once; a reviewer that commits has its
verdict thrown out. Either way the task goes to review-failed after that. A worker that reports no commit is not
reviewed: the task is done, and the lead's next wake says `t-N finished without reporting a commit` with the
worker's closing note.

On a review-failed task the lead (or you, from the DAG) can `approve` it (overrule the reviewer; it lands as it
is), `sendback` it with guidance for one more round, or `retry`, `escalate`, `skip` or `forward` it.

The lead steers later tasks with `dag amend <task> "<note>"` (added to the prompt of a task that hasn't started)
and `dag tell <task> "<text>"` (typed into a running worker's terminal, logged as `lead told t-N`).

### Merge conflict and failed Verify

On the sandbox run, tasks 2 and 3 both landed, and the second merge conflicted. The sheet flagged it as
**blocked-merge** with a `resolve-merge` action, and the engine launched the plan run's first lead with the
conflict as its wake. Other lanes keep merging meanwhile:

![A blocked merge](images/orchestrator-guide/14-merge-conflict.png)

The lead resolved `greeting.txt` as the plan's notes said, committed and ran `dag merge t-3 --continue`. Task 1
had landed in the meantime with `status.txt` set to `broken`, so both merges' Verify runs failed; the engine
woke the lead with both lines in one message, it restored `status.txt`, committed, and continued both. The
timeline above records the whole sequence, conflict to **Verify passed**, in about two minutes.

To do it yourself: fix the tree where lanes land (the project checkout, or the run's own branch tree, which the
card names), commit, then `resolve` on the DAG node (or
`wsh jarvis dag merge <task> --continue`).

### A worker asks a question

A worker's question goes to the lead first and stays off your Brief. While the lead holds it, the details
rail's **Run** section shows it with a countdown ("lead is answering · Nm left") and a **Take over** button
that moves it to you; the lead's `dag answer` is refused from then on.

A question the lead forwards, one it does not answer within 10 minutes, and one you take over all show up
under **Questions for you** on the run sheet, with the lead's note:

![A forwarded question](images/orchestrator-guide/15-question-for-you.png)

Pick an option or type an answer and **Send answer**. The worker continues, and the timeline records
`t-4 answered` (above). The sandbox worker wrote `ciao`, the option picked on this card.

### A task fails or hangs

A failed or stalled task shows on its row and in the DAG with `retry`, `skip` and `escalate`. The lead gets it
first; you see it when it is forwarded or the lead is dead. Retry and escalate stop the worker they
replace, so before you retry a stalled task, check its lane worktree under `.waveterm/worktrees/` for recent
writes: a worker that is still writing files is alive, and the stall signal is wrong.

To move a task to another model, use **escalate…** in the DAG's detail panel under the graph (it opens a
route picker, then **Re-queue on model**). Escalation is one hop per task.

### The lead is dead

Before `dag submit`: the run goes **Blocked** with a **Lead exited** row. Cancel it and start again.

After `dag submit`: the engine keeps merging and verifying, the timeline shows **Lead wake failed**, and every
judgment event and lead-held question comes to you. Select the **Lead wake failed** row and press **Relaunch
lead** to start a replacement: it refuses while the lead is still running, and its prompt is the events the dead
lead missed rather than the original plan. Until then, answer from the sheet and act with the DAG buttons or
`wsh jarvis dag`. A stalled task with no live lead is retried once by the engine itself, so it no longer parks
the run; a second stall waits for you.

---

## Steering a live run

- **Talk to a worker.** Type into its terminal on the Agent surface. What you type is logged on the lead's run
  as a `you told t-2 · …` row and in `dag status`, so the lead sees it at its next wake. It wakes nobody.
- **Change parallelism or the workers' route.** **Adjust** on the settings line → **Worker parallelism**,
  **Worker route** → **Save settings**. It applies to dispatches from then on. **Save as project defaults**
  makes the next run start this way. Shape, machine and the lead's route are fixed at launch, and nothing
  already running changes.

  ![Adjust on a live run](images/orchestrator-guide/23-adjust.png)

- **Cancel.** **Cancel run** is meant to confirm first ("Stop N running workers and cancel this run?
  Completed phases, transcripts, and artifacts are kept.", with **Keep running** to back out). On an engine
  run it does not: it cancels on the first click, kills the running workers and skips every task that had not
  started. See [Rough edges](#rough-edges-found-while-writing-this) — treat the button as immediate. If a
  worker survives the cancel, the sheet says so with **Take control** and **Stop** per worker.

---

## The final stage

A run is not done when its last task lands. Once every task is terminal and merged, the dag's status reads
`finalizing` and the engine runs a final stage on the merged result. The dag is `done` only when that stage ends
passed or unverified.

**Where it runs.** On a branch-landed run, in the landing tree at `wave/<runId>`. On a checkout-landed run, in a
detached worktree at the checkout's HEAD (`.waveterm/worktrees/<runId>-final`), with the plan's Setup run in it,
removed when the stage ends. It never runs in the shared checkout.

**The steps, in order:**

1. **Check**, the plan's Check line, on the merged result (20-minute limit). A non-zero exit fails the stage.
2. **Final**, the plan's `**Final:**` command, in a POSIX shell with `ARC_FINAL_OUT` set to a fresh directory
   for its screenshots and reports (`<temp>/arc-final/<dag>/<round>`, outside every tree). Exit 0 passes. Exit
   3 means it could not verify, and its last output line becomes an unverified reason. Any other exit, or
   running past 30 minutes ("timed out"), fails the stage with the output tail.
3. **The verifier**, a fresh session in the final tree on the lead's route, unless a step above failed. Its
   brief names the spec and plan, `git diff <base>..<head>` of the run, `ARC_FINAL_OUT`, the `**Prototype:**`
   canvas, and every unverified note so far. It checks that the combined change does what the spec asks, and
   looks for breaks where tasks meet: code one task changed that another uses, a name two tasks spell
   differently, behavior two tasks both touch. It compares screenshots to the canvas's boards structurally
   (which elements, their order, copy, controls at that width), never by pixels, and classifies each
   difference as allowed (listed in the spec's Deviations) or a defect. It only reads, and ends with
   `wsh jarvis dag final pass "<summary>" [--unverified "<what, and why>"]` or
   `wsh jarvis dag final fail "<defects: each, where, the fix>"`. A verifier silent past 20 minutes, or ending
   without a verdict, is replaced once. One lost twice adds the unverified reason
   `the verifier did not finish: <why>`.

With no Check and no Final line, the stage goes straight to the verifier.

**The outcome:**

| Outcome | When | Then |
|---|---|---|
| **passed** | nothing failed and nothing is unverified | the dag is done; the lead gets `run finished` with the outcome |
| **unverified** | nothing failed, but there is a reason: a Final exit 3, the verifier's `--unverified`, a reviewer's `--unverified` note, or a plan with no Verify | the dag is done; the `run finished` wake lists every reason in full |
| **failed** | Check, Final or the verifier failed | the lead wakes with the failure in full |

`wsh jarvis dag status` prints the stage as `final <state> round=N commit=… out=<ARC_FINAL_OUT>`, then each
`final unverified:` reason and a `final failed:` detail, whole.

**The fix round.** On a failed stage the lead writes a fix plan in the plan format and runs
`wsh jarvis dag submit --round --plan <fix plan>`. The fix plan's tasks are appended as `t-(n+1)…`, with its
own numbers and Depends mapped on. Each description opens with `Fix round N: this is task K of the fix plan at
<path>`, so its worker reads the fix plan, not the run's. The dag keeps its Verify, Setup, Check, Final and
Prototype. On a branch-landed run the fix plan is committed to `wave/<runId>` first, and the new tasks cut from
the landing tree's head. A fix round skips the plan review, but each of its tasks is reviewed. When its tasks
land, the final stage runs again as round 2. The final stage runs at most twice (`MaxFinalRounds`): the first
round and one fix round. `--round` is refused, with the reason, while the stage is still running, after it
passed, or when no round is left. After round 2 fails, the wake tells the lead to put it to you. It does the same
when the fix is a product call.

**This repo's Final command** is `node scripts/cdp/final-verify.mjs [scenario...]`. It starts a dev app from the
final tree on its own CDP port and WebView2 profile, runs the named `verify:ui` scenarios (all of them with none
named) and writes into `ARC_FINAL_OUT`: `cdp-shots/` (with `index.html` as the contact sheet), `dev-app.log`
and `webview2-profile/`. It stops only the processes it started. It exits 3 with a reason when the app does not
come up within its boot budget (`ARC_FINAL_BOOT_MS`, default 10 minutes). Otherwise it exits with verify.mjs's
own code: 0 pass, 1 a scenario failed, 2 an unknown scenario name. `ARC_FINAL_DEV_CMD` overrides the start
command (default `task dev`).

---

## When the run ends

The sheet goes to **Done**: tasks, commits landed, wall clock, worker time, and **evidence sealed**. **What
landed** lists each task's commit; **Sealed evidence** has the diff stat and the lead's summary. The evidence
also seals the run's outcome from the final stage (`passed` or `unverified`, with the reasons) and the tokens
it spent. On a checkout-landed run it counts only the run's own commits, the ones with its `Arc-Run:` trailer;
the lead ends each commit it makes with `Arc-Run: <runId>` so its own fixes count.

![A finished plan run](images/orchestrator-guide/18-done.png)

Finished workers stay on the Agent tree under **✓ N done**. Opening one shows its read-only transcript
("Session ended · landed `<sha>` · read-only transcript"), starting with the worker contract it was given,
and the rail names the branch it committed on:

![A finished worker's transcript](images/orchestrator-guide/20-done-worker.png)

### Landing back

A branch-landed run's work reaches its base without you. When the run completes (the lead's `complete`, or the
engine closing a lead-free run), the engine seals the evidence, then merges `wave/<runId>` into the base branch in
the project checkout. The merge is `git merge --no-ff` with the plan's title (else the goal's first line) as its
subject and `Arc-Run: <runId>` as its trailer. It then removes the landing tree and deletes the branch; the
evidence keeps the branch's tip. Landing is its own step with its own state, so completion never waits on it.

Before merging, the engine takes these steps:

- If the branch moved past the commit the final stage verified, which the lead's wrap-up commits do, it runs Check
  and Verify again in the landing tree.
- It removes an untracked file in the checkout that is identical to one the run adds, such as the spec or plan the
  lead wrote there before submit.
- If the base took commits while the run worked, the land records the note "merged onto N commits that landed on
  <base> during the run; the combination was not verified".

It **holds** the land, with a reason, and leaves the checkout as it was, when:

- the final stage failed or has not finished;
- the run started on a detached HEAD;
- the checkout is on another branch;
- the checkout is stopped mid-merge, mid-rebase or mid-cherry-pick;
- the checkout has staged changes;
- an untracked file in the checkout differs from one the run adds;
- the re-run Check or Verify fails;
- the merge conflicts (it is aborted, and the reason names the files);
- git refuses to overwrite uncommitted edits to files the merge touches (the edits stay).

Uncommitted edits to other files do not hold it, and survive the merge.

A held land raises a **land held** item under Waiting on you: "The run's branch was not merged back: <reason>".
Clear the reason, then run `wsh runs land <run-id>`, which retries and prints where the land stands.
`wsh runs land <run-id> --force` lands a run whose final stage failed; it is your call only, and the lead is never
told about it.

A done run whose outcome is unverified, or whose land carries a note, raises an **unverified** item ("Finished,
but N things were not verified.") naming each reason. It holds nothing, since the run is done. It stays until you
read it and press **Acknowledge** on its row, or run `wsh runs ack <run-id>`.

`wsh runs show <run-id>` prints all of it:

- `usage`, the tokens per role, with the lead's wrap-up counted once sealed;
- `outcome` with each `unverified:` reason;
- `land <state>` with the held reason or the merge commit, and each `note:`.

`wsh jarvis dag status` prints the same token totals as a `usage` line (`lead … · workers … · reviewers … ·
plan-reviewer … · verifier …`), then one `t-N usage:` line per task for its worker and reviewer. The lead's total
counts every lead session, a relaunched lead's included. A transcript that can't be read is not read as zero: the
line ends `(N unreadable)`. The totals are tokens only; cost stays in the cockpit.

A checkout-landed run has nothing to merge back: its commits are on the project checkout's branch. Review and
merge that branch yourself.

The backlog run finished on 2026-09-18 after 3h12m of wall clock and 5h46m of worker time. All 13 tasks landed
as 13 squash commits on `backlog-cleanup`, and a merge Verify passed after every one of them. One earlier
attempt had timed out and been re-run. Its Done face:

![The backlog run done](images/orchestrator-guide/27-backlog-done.png)

The finished DAG shows the plan's shape. Eight independent tasks ran up to three at a time, and the
t-3 → t-4 → t-6 → t-7 → t-13 chain ran one at a time behind them:

![The backlog run's DAG, done](images/orchestrator-guide/26-backlog-dag-done.png)

### Who wraps up

Done doesn't mean finished. The work after the last merge splits four ways:

| Work | Whose job | On the backlog run |
|---|---|---|
| The run's report | **The lead's.** Its rules (`OrchestrationRules`, `leadprompt.go`) have it fix and commit what the landed tasks left behind, write the report to a file, and add each open issue as a pending chunk on the initiative (creating one if the run has none). Then it completes on its own with `wsh jarvis complete --report <file>`. It asks you first only when a decision is needed: a failed verification, a deviation that needs your call, or a proposed fix round. An unverified outcome never blocks completion. | Not written. The rules then said "write the report …, then `wsh jarvis complete`". The lead ran `complete` first, and the engine closed its tab before it could recover. The sandbox lead did the same. |
| Closing the initiative's tracker chunks | **The engine's.** A task names its chunks with `**Chunk:**` lines after its Depends line, and the engine marks each done with the landed commit once the task's merge passes Verify. | The plan gave it to workers through a header line they never saw. The tracker read 3/16 with all 13 tasks landed. |
| Merging the branch back | **The engine's** on a branch-landed run ([Landing back](#landing-back)); **yours** on a checkout-landed one, or when a land is held. | The run landed on the project checkout's branch, and merging it was left to the human. |
| Checking what the final stage could not, committing anything | **Yours.** The unverified item names what nothing checked. | Four fixes still need a live check once the branch is on `main` and running in the dev app. | Four fixes still need a live check once the branch is on `main` and running in the dev app. |

Both gaps the backlog run hit are closed in code: `wsh jarvis complete --report <file>` seals the report the lead
wrote, and `**Chunk:**` lines let the engine close the tracker. If a sealed summary is still a half-sentence, the
lead ran `complete` without `--report`, or the engine closed the run itself because the lead could not be woken when
the DAG finished. Either way a later `wsh jarvis complete --report <file>` still attaches the report and replaces
that summary.

### What the backlog run left open

The run merged to `main` as `cf2fe485`. This list is the single record of what it left open; the rows it
closed in `docs/open-issues.md` point here.

- **Four fixes needed a live check in the dev app; all four passed on 2026-09-21.** Restart `task dev` on the
  merged `main` before re-running any of them — three are backend changes, and a `wavesrv` started before the
  merge doesn't have them.
  - **F25, hung agents** (`1f116196`): freeze a Claude Code agent mid-work, for example by suspending its
    process. After 3 minutes its row should read `hung · no output Nm`. **Passed**, firing at ~2m45s of true
    silence: the displayed stamp leads real silence by up to the 30s publish throttle, which errs toward
    flagging and matches the intent.
  - **F22/F23, questions and answers** (`2628c6a0`): answer a plain session's question while its agent is
    frozen. Within 30 seconds the card should come back noted "answer was sent but never confirmed". Also, an
    agent kept open after its process ended (`cmd:keeponexit`) should lose its pending question. **Both
    passed**; the note came back at 39s, which is the 30s `AnswerClearTimeout` plus one 5s sweep tick.
  - **F26, a killed worker** (`646f032c`): kill a Quick run's worker process. The run should fail with a
    `worker-exited` event. Quitting the app mid-run should not fail it. **Passed.** Note the app was killed,
    not quit, and nothing reconciles runs at boot, so the run stayed `executing` until cancelled by hand.
  - **Chunk 8, the record peek** (`293f55ca`, frontend only): open a record peek, raise its confirm and press
    Escape. Only the confirm should close, and focus should return to the peek. **Passed.**
- **The hung overlay covers Claude Code only** (F25), and that is now the settled answer rather than an
  unmeasured gap. pi was measured on 2026-09-21: while a tool call is pending its TUI redraws an elapsed
  counter about once a second, but the moment the tool returns it renders nothing at all until the model
  replies — a minimal turn (run one `ping`, report the exit code) sat silent for 142.8s. `HUNG_AFTER_MS`
  is 180s and the frontend reads a `lastoutputts` that `blockcontroller` publishes on a 30s throttle, so
  the overlay can fire at ~150s of real silence: pi cleared a false `hung` by about 7 seconds on the
  simplest turn there is. The silence is bounded by model latency, which grows with reasoning effort and
  context, so no threshold is both safe and tight enough to be useful. Covering pi needs a liveness
  signal other than PTY bytes.
- **The frontend `deleteChannel` wrapper is gone.** It had no caller after `5827e43b` deleted the rest of the
  channel lifecycle stack. The `deletechannel` RPC and `DeleteChannelCommand` stay: `scripts/cdp/scenarios.mjs`,
  `scripts/cdp-e2e-runs-piece4.mjs` and `scripts/cdp-profile-verify.mjs` use it as their teardown.

---

## Tracking an initiative across runs

Big efforts live as initiatives (`wsh effort`, the Brief's **Initiatives** region). A run does not attach
itself to one: the goal names the effort, and a chunk closes when an agent runs
`wsh effort chunk status <effort> "<chunk>" done --note "…"`, or when the engine lands a task that names it
in a `**Chunk:**` line (see [Who wraps up](#who-wraps-up)). When a run finishes, its lead adds each open issue as a pending chunk on the
initiative the goal, spec or plan names, and creates one when there is none. To show a run against a chunk, attach it:
`wsh effort chunk attach <effort> "<chunk>" --run <run-oid>`. Expanding an initiative on the Brief shows each
chunk's status and note trail. On the backlog run the lead closed chunk 1 as already fixed, with its evidence,
before asking its first question. After that only t-4's worker closed any chunks.

---

## CLI: `wsh jarvis dag`

Inside a lead's or worker's terminal, the run is inferred. Elsewhere pass `--channel <id> --runid <id>`.

| Command | Does |
|---|---|
| `dag submit --plan <md> [--spec <md>]` | validate the plan and start the engine on it (one DAG per run); after a failed plan review, submit the revised plan again |
| `dag submit --round --plan <fix plan>` | after a failed final stage, append the fix plan's tasks as a fix round |
| `dag status` | per-task digest, the report numbers, landed commits, Verify and merge errors, what you told workers, unverified notes, the final stage, token usage |
| `dag asks` | questions the lead holds, oldest first, with every option |
| `dag answer <task> <answers-json>` | answer as the lead |
| `dag forward <task> "<note>"` | hand a question, failure, stall or conflict to the human |
| `dag amend <task> "<note>"` | add a note to a task that hasn't started; its worker's prompt carries it |
| `dag tell <task> "<text>"` | type into a running worker's or reviewer's terminal |
| `dag sendback <task> ["<guidance>"]` | one more round for a review-failed task, with your guidance beside the findings |
| `dag approve <task>` | overrule a failed review; the task lands as it is |
| `dag review <pass\|fail> "<note>" [--downstream "<note>" [--for <task ids>]] [--unverified "<what, why>"]` | a reviewer's verdict; ends the reviewer's session |
| `dag planreview <pass\|fail> "<text>"` | the plan reviewer's verdict; ends its session |
| `dag planreview accept "<the human's reason>"` | as the lead, proceed past a failed plan review on the human's word |
| `dag final pass "<summary>" [--unverified "<what, why>"]` / `dag final fail "<defects>"` | the final verifier's verdict; ends its session |
| `dag retry <task>` / `dag skip <task>` | retry or skip a failed or stalled task |
| `dag escalate <task> --model <id> [--runtime <rt>]` | re-queue on another model, once per task |
| `dag merge <task> [--continue]` | squash-merge a lane end, or finish a resolved conflict / re-run a failed Verify |
| `dag retry-cleanup <task>` | retry removing a task's worktree after its automatic attempts gave up (close whatever held it first) |
| `dag cancel <task>` | cancel the whole DAG (the task argument is required and ignored) |
| `wsh jarvis complete [--commit <sha>] [--report <file>]` | finish the run or task; `--commit` scopes its evidence, `--report` seals the file as the summary (required of a task worker) |

Run-level commands, from any terminal in the project:

| Command | Does |
|---|---|
| `wsh runs start [goal] [--plan <md>] [--landing branch\|checkout]` | start a run; `--landing` wins over the profile, and the default is branch |
| `wsh runs show <run-id>` | status, commits, `usage`, the task digest, `outcome` with its reasons, `land`, the report |
| `wsh runs land <run-id> [--force]` | retry a held land-back; `--force` lands a failed final stage (the human's call only) |
| `wsh runs ack <run-id>` | acknowledge an unverified outcome, clearing its attention item |

---

## Rough edges found while writing this

Seen live on 2026-09-17 and 18 or confirmed in code; none block a run.

- **A slow Verify reads as a failed one.** Verify is capped at 20 minutes (`VerifyTimeout`,
  `pkg/orchestrate/plancmd.go`). The engine also writes the plan's Verify into every worker's contract ("Run
  `<Verify>` and get it passing before you complete", `engine.go`). So at parallelism 3 with a full-suite Verify
  (tsc, vitest, `go test ./pkg/...`), up to four copies of the suite run at once. The backlog run's first merge
  Verify ran past the cap. The task went to `verify-failed` with "timed out after 20m" and the tail of the output,
  in which every package shown had passed. The lead woke for it, timed the next package alone
  (`pkg/orchestrate`: 241s under that load), found nothing to fix and re-ran Verify with
  `dag merge t-1 --continue`. If your Verify is the full suite, lower parallelism or expect a timeout like this.
  The same load used to push a worker that was only waiting on its own test run past the stall threshold; a
  busy process tree now counts as activity.
- **A timed-out Verify keeps running on Windows.** The timeout kills only the Git Bash launcher
  (`exec.CommandContext` in `plancmd_windows.go`). The real `bash` under it and the `go test` it started are
  never killed. On the backlog run the first Verify's `go test` was still running 30 minutes after it
  started, competing with the re-run. Kill the orphan tree by hand; it is the `bash.exe -c "<Verify>"` whose
  parent has exited.
- **The sealed summary can be the lead's previous message.** The sandbox lead ran `wsh jarvis complete` in the
  same step as its final check, so the evidence captured its mid-run update, not a report. The backlog lead
  lost more. `wsh jarvis complete` is what makes a run terminal, and the engine used to close a lead's tab the
  moment its run and DAG both were — so the lead ran `complete` mid-turn, having just said it would check why
  the tracker read 3/16, and its tab was deleted before the command returned. It never closed a chunk or wrote
  a report, and the sealed summary is that last line.

  **Fixed in `89dd3705`:** `MaybeCloseOrchestratorLead` now refuses to delete a tab whose lead process is
  still alive, and `CloseOrchestratorLeadOnExit` collects it from the lead's own exit hook instead. A
  terminal run says the work is done, not that the turn is over; only the process says that. The advice
  still stands on its own merits, though: tell a lead to do every tracker update and write its report before
  it runs `complete`, because `complete` seals the evidence from what it can see at that moment.
