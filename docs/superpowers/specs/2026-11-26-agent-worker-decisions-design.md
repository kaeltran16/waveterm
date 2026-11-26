# Agent workers: parent exit, unmerged Done, stopped card, resume timer

Initiative: Agent workers: fix live-test findings (effort 79b6e384), chunks 5 and 6. Chunks 1-4 are built
by a separate run; this work starts once that run has landed, since both edit the worker lifecycle.

## Intent

A live test on 2026-11-26 of agent-started workers (`wsh agents start`) left four open behaviors: what a
parent's exit does to its workers, a Done mark that reads as landed when it is not, a stopped worker's card
that says nothing useful, and a resumed worker's timer that counts from the wrong moment. Settle each so the
worker tree tells the truth and no worker's answer is silently lost.

## Goals

- A worker whose parent's tab is gone finishes the turn it owes, its answer reaches the user, and it stops.
- An agent's done mark says where its work sits.
- A stopped worker's card shows what it last did and how to wake it.
- A resumed turn's timer shows that turn's age.

## Non-goals

- Keeping the parent's tab alive after it exits, or a resume path for a user's own agent.
- A ghost parent row in the tree: an orphan sits at the top level.
- Checking whether a worktree branch has been merged.

## Anti-goals

- An orphan that keeps running or idling after its turn with nobody to read it (the live test's orphan
  idled about 6 minutes).
- An orphan's answer dropped with no trace.

## Decisions

**When a parent is gone.** A parent is gone when its tab no longer exists: a user's own agent's tab closes
on `/exit` or a crash, or the user closes the tab. A parent that is itself a worker keeps its tab when its
process ends (stopped, crashed or `/exit`-ed), so it is not gone: its workers' notices are held for its next
run, as today. Arc quitting deletes no tab, so it orphans nobody. When a parent is gone, each of its workers
that owes it a notice finishes its current turn; its answer then becomes a cockpit attention item linking to
its tab, and it stops. Why: the work in flight is worth finishing and its result worth reading, but nothing
should run after that, and held notices already serve a parent that can come back.

- Only a worker the parent is owed an answer by (a turn the parent gave, mid-turn or with its notice owed or
  held) raises an item. A worker on a turn the user typed raises none and follows the user-turn rule (no
  notice, stopped by the idle sweep). A worker already notified and stopped is left alone.
- An orphan that is idle when its parent goes, with a notice owed or held, raises its item and stops at once.
- A worker whose own parent is an orphan still notifies that parent while it is alive, as today; the
  orphan settles only once none of its own workers runs, as today.
- The orphan mark is set once, when the parent goes, and cleared by Acknowledge. A resumed orphan follows
  the user-turn rule: the user is driving it, so its later turns raise no item.

**The orphan's answer item.** It reads like the other attention items: the worker's title, that its parent
ended, and the first line of its answer. Open goes to the worker's tab; Acknowledge clears it, as on an
unverified run. It is derived from a mark on the worker (like the held-notice mark), so it survives an Arc
restart. Why: the attention list is where the user already looks for things waiting on them.

**Done mark in a worktree.** Any agent that committed in a worktree (workers, leads and the user's own
agents alike) shows a branch icon titled "Done, committed on <branch>" in place of the green tick, on its
card and its tree row. The green tick stays for commits in the shared checkout. No merge check. Why: the
branch is not merged, and the tick read as landed; one rule in the shared commit mark covers every agent,
and a merge check costs a git query per agent for a flip that is rarely seen.

**A stopped worker's card.** It shows the worker's last turn, read from its transcript, under a "Stopped, a
message resumes it" line. The composer resumes it (a message to a stopped worker already resumes it). The
"Waiting in its terminal" notice is for agents with nothing to show yet, never a stopped worker. Why: what
it said is what the user opens the card for, and its terminal has no process.

**Resumed worker's timer.** A resumed worker's turn timer counts from when the resume sent its prompt, so a
4-second-old turn reads 4s, not the time since the previous transcript message.

## Constraints

- The tree row already reads "stopped" for a stopped worker; the card should agree with it.
- New UI follows DESIGN.md and the existing theme tokens; no new tokens.

## Verification

Chunk 7 of the initiative follows this work: a live check in the dev app retests each 11-26 finding and
exercises the paths not yet run: memory-gate refusal, held notice (parent tab open, agent not running),
resume after an Arc restart, pi workers, a refused permission mode, and workers starting their own workers.

## Left to the builder

- Where the parent-gone check runs: a tab lookup at settle, plus hearing a tab's deletion for workers
  already idle with a notice owed or held.
- How the answer item is derived and acknowledged.
- How a stopped worker's card reads its transcript with no live process behind it.
- How the commit mark knows a commit was made in a worktree, and its branch.
- The tests, per the repo's rules.
