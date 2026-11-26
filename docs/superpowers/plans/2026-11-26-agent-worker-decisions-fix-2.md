# Fix round 2: orphan raise edge cases

The final stage passed. This round takes the two defects task 1 (orphaned workers) reported under Found not fixed,
both in the orphan raise this run built in `pkg/agentworker`.

### Task 1: An orphan's answer is its final turn's, never an earlier turn's
**Depends on:** none
**Files:** `pkg/agentworker/orphan.go`, `pkg/agentworker/orphan_test.go`, `pkg/agentworker/lifecycle.go`, `pkg/agentworker/lifecycle_test.go`

`raiseOrphan` stores `agentsessions.LastAnswer(transcript, harness)`, the transcript's last assistant text. When the
owed turn wrote no text, that is an earlier turn's answer, shown under `Parent ended` as if it were this turn's.
Bound it the way `awaitAnswer` in `lifecycle.go` already does: `LastAnswer` returns the answer's time, and an answer
older than the settling turn's open time is no answer. Where the raise has no open time to hand (an idle raise at
the tab close), the worker passes the one the lifecycle already tracks, or says in its report why none applies.

Acceptance:
- A worker whose transcript has an earlier turn with text and a final turn with none raises
  `Parent ended · no answer` (`agent:orphananswer` empty).
- A final turn with text still stores its first line, as today.

### Task 2: An orphan whose resume is refused at boot still raises
**Depends on:** Task 1 (both edit `pkg/agentworker/orphan.go` and its test; this raise uses its bounded answer)
**Files:** `pkg/agentworker/boot.go`, `pkg/agentworker/boot_test.go`, `pkg/agentworker/orphan.go`, `pkg/agentworker/orphan_test.go`

`resumeAtBoot` resumes a worker left with its notice owed; when the resume is refused (memory gate, snapshot store,
failed start) the worker stays stopped with its notice owed and never settles again, so if its parent's tab is gone
it never raises its orphan item. At boot, a stopped worker with its notice owed whose parent tab is missing raises
the orphan item from its transcript (the raise task 1 bounds) instead of waiting forever; one whose parent still
exists keeps today's behavior.

Acceptance:
- Boot with a worker whose notice is owed, whose resume is refused and whose parent tab is missing writes
  `agent:orphaned` and `agent:orphananswer` on its tab.
- The same worker with its parent tab present gets no mark and stays owed, as today.
