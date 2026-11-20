# Agents launch workers

- Date: 2026-11-20
- Status: Design

## Intent

Agents hand jobs to Claude subagents, and the user cannot see that work. Arc shows a subagent only as a
read-only transcript under its parent: it has no terminal, the user cannot type into it or stop it on its
own, and it is gone once it returns. This design lets an agent start a **worker** instead: a real agent in
its own tab, with a terminal and live state, that the user can watch, type into or stop.

## Goals

- An agent starts a worker with one command and gets back the worker's tab id.
- The worker is an ordinary agent tab, nested under its parent in the Agent tree.
- The parent learns when the worker is done, and reads its answer when it wants it.
- Workers fit the machine's memory: they go through the same memory admission as run workers, and a
  finished worker holds no process.

## Non-goals

- No setting that refuses or redirects Claude's own Agent tool. Agents choose when to start a worker, and
  their subagents keep working as today.
- No branch, review, landing or report: a worker is not a run.
- No merging of a worker's worktree branch by Arc.
- No workers for run agents. `wsh agents start` fails for an agent that a run started (a lead, a task
  worker or a reviewer), and says that runs delegate through their plan. Why: a run's tree is merged and
  deleted by the engine, so a worker there would edit outside review and landing, and outside the run's
  memory accounting.
- Removing the cap of 8 live run workers from orchestrator runs is a separate change. Workers never count
  against that cap.

## Anti-goals

- A worker that looks dead or unreachable in the cockpit. Arc must own the worker's command line, so no
  option can drop the hooks or extensions it reads live state from.
- Idle worker processes holding memory: a live claude session holds about 470 MB on this machine.

## Constraints

- Harnesses: claude and pi, as for run workers.
- Memory is tight. Admission uses the existing memory gate and its learned peaks.
- A resumed session must start with the same launch flags as its first start, so its prompt cache prefix
  still matches.

## Approach

A new `wsh agents start` command, backed by a new wshrpc command. The backend opens the worker's tab,
configures and starts it, and records the calling tab as its parent. The parent collects the answer with the
existing `wsh agents read` and `wsh agents wait`. Arc pushes the parent a one-line notice when the worker is done.

## Decisions

**Starting**

- `wsh agents start` takes a prompt, a harness, a model and session options, and prints the new worker's tab
  id. Why: the backend already opens and starts agent tabs headlessly for runs, and `wsh agents read`/`wait`
  already work on any live tab.
- Harness and model default to the parent's. Why: the common case is "the same agent, on a narrower job".
- Session options are Arc's own flags: model, effort, system prompt, appended system prompt, tools and
  permission mode. Each one is mapped to claude or pi by the same route code `wsh runs start` uses. There is no
  pass-through of raw harness arguments. Why: Arc keeps the worker visible only if it owns the argv.
  Claude's `--bare` and pi's `--no-extensions` would hide it.
- With no permission mode given, a worker starts in the permission mode its parent runs in. The parent can
  pass a stricter one. Why: a worker can then do no more than its parent already can, and it runs unattended
  when the parent does.
- The parent decides per worker where it works. With no choice given, the worker uses the parent's
  directory. With a worktree requested, it works on a new branch off the parent's HEAD, which the parent
  merges or deletes. Why: only the parent knows whether the worker's edits could collide with its own.
- The tab-opening part of a launch lives in the backend once: create the tab, set its meta, start it and tag
  its project. Every UI launch goes through it and keeps its own command line. The New Agent modal keeps its
  free-text command, its flag catalog and every runtime. Curated flags, memory admission, pausing, the
  5-minute TTL and stop-after-answer apply to workers only, never to agents the user launches. Why: one
  launch path that takes no features from the UI. The worker rules exist because no person is driving a
  worker.

**The worker**

- A worker is an ordinary agent, not a run agent. It asks its questions in its own terminal, and while it
  runs the user can type into it or stop it. Why: the point is a real agent, not a transcript.
- Arc records the parent on the worker's tab. The Agent tree nests workers under their parent, as it nests
  subagents. Why: that is where the user already looks for a parent's delegated work.
- A worker can start its own workers, which nest under it. There is no depth limit. Why: memory admission
  bounds the total.
- While a worker still has workers of its own running, its done notice and its stop wait. It stays running
  and receives their notices. It sends its own notice and stops only once it is idle with none left running.
  Why: a worker stopped while its workers run would have no process to receive their notices.
- Workers write the prompt cache with a 5-minute TTL, as run workers do. Why: a cache write costs 1.25x the
  input price at 5 minutes and 2x at 1 hour, and a working agent's turns are rarely more than 5 minutes
  apart. A follow-up after a long pause rewrites the context once.

**The answer**

- When the worker goes idle after a turn its parent gave it, Arc pushes a one-line notice into the parent's
  session. The notice is marked as from that worker and names its tab. Turns the parent gives are the first
  task and each later `wsh agents send` from the parent. The parent reads the answer with
  `wsh agents read`, or blocks on `wsh agents wait`. Why: a push works for claude and pi alike, and a notice
  keeps long answers out of the parent's context until it asks for them.
- A turn the user typed into the worker sends the parent nothing. A worker stopped on a question sends no
  notice: its question shows in the cockpit like any agent's. Why: the parent waits only on work it handed
  off.

**Lifecycle and resources**

- Once the parent has its notice, the worker's process stops and its tab stays, showing the transcript. A
  message from the user or the parent resumes the session. Why: frees about 470 MB per finished worker
  without losing the follow-up.
- A worker that has been idle for 5 minutes with no notice to send also stops, and resumes the same way.
  This covers a worker idle after a turn the user typed, and an orphaned worker. Why: 5 minutes is the
  worker's cache TTL, so past it a resume costs no more than staying alive.
- Every start and resume asks the memory gate without blocking. When free memory does not cover the
  learned peak, the command fails at once, saying memory is short and what holds it. A stopped worker
  releases its claim. Why: the same memory budget as runs, and the parent hears at once instead of hanging.
- A running worker counts as a worker for the gate, so the gate may pause it when it spikes under memory
  pressure, as it pauses run workers. Why: a worker that cannot be paused is the one that runs the machine
  out of memory.
- Closing a parent does not close or stop its workers. Sometimes a parent's tab is open but has no process:
  it exited, or Arc has not reopened it after a restart. A notice for that parent is held and delivered
  when the parent next runs. Nothing resumes the parent just to deliver it. A notice for a parent whose tab
  is closed is dropped, and the worker becomes a top-level agent in the tree. Why: the user may still be
  talking to the worker, and resuming a parent only for a notice spends memory the gate may not have.
- After Arc restarts, a worker that was mid-task resumes its session, as run workers do. A worker that had
  stopped after its answer stays stopped until a message resumes it.

**Discovery**

- Arc's session-start context names `wsh agents start` beside the other `wsh agents` commands. The line is
  neutral and gives no advice on when to use it. Why: Arc's context states capabilities without nudging.

## Left to the builder

- The exact flag names, and how each maps per harness.
- The notice's wording.
- How a stopped worker looks in the tree and in its tab.
- The memory gate's key and estimate for a worker with no learned peak yet.
- How `wsh agents send` reaches and resumes a stopped worker.
- Whether the parent needs a close command for a worker's tab.
