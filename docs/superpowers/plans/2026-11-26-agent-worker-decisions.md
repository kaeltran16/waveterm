# Agent workers: orphan answers, worktree Done mark, stopped card, resume timer

**Effort:** effort:79b6e384-8c07-4f81-9b5d-008733bb1102
**Spec:** `docs/superpowers/specs/2026-11-26-agent-worker-decisions-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentworker ./pkg/jarvis ./pkg/wcore ./pkg/gitinfo ./pkg/remotemode ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/agentworker ./pkg/jarvis ./pkg/wcore ./pkg/gitinfo ./pkg/remotemode ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs agent-workers brief-act`

Decisions beyond the spec (its "Left to the builder"), with why:

- **Parent-gone check.** A new `wcore.AgentTabCloseHook func(ctx, tabId string)`, called in `DeleteTab` beside
  `WorkerTabCloseHook` and set by `pkg/agentworker` at init (the `jarvis.AgentExitHook` precedent). The hook runs
  before the tab leaves the store, so it records the tab id in an in-memory gone-parents set under `lifeMu`; the
  settle treats a parent as gone when its tab is missing or in that set. In memory is enough: after a restart the
  tab is gone from the store. Why: a settle can land between the hook and the store delete, and `/exit` leaves the
  parent's process ended, which today would hold the notice for a tab about to vanish.
- **The orphan mark is the raised item.** Raising writes two keys on the worker's **tab** meta:
  `agent:orphaned` (UnixMilli raised) and `agent:orphananswer` (first line of its answer, whitespace collapsed, cut
  to 140 runes, the ask row's bound). Acknowledge deletes both. A mid-turn orphan needs no persisted pre-mark: its
  settle finds the parent gone; one cut off by an Arc restart resumes at boot with its notice owed, as today, and
  its settle finds the tab missing. Tab meta, not block meta, so the attention gather reads one table (tabs). The
  answer is stored at raise time, not read per poll, since `agentsessions.LastAnswer` reads the whole transcript
  and the cockpit polls the attention list.
- **Key constants live in `pkg/jarvis`** (`MetaWorkerOrphaned`, `MetaWorkerOrphanAnswer`, beside the new
  `AttentionWorkerOrphan = "worker-orphan"` kind): jarvis builds the item and agentworker imports jarvis, not the
  reverse. The frontend writes them as literals, as it does `agent:parenttab`.
- **The item.** Kind `worker-orphan`, Key `worker-orphan:<tabId>`, ORef `tab:<tabId>`, Source the worker's tab
  name (its `session:label` when set), Text `Parent ended · <answer first line>` (`Parent ended · no answer` when
  the turn wrote none), Action `Acknowledge`, WaitingSince the raise time. Its group sorts after unverified runs.
  In the Brief queue its kind word is `orphaned` (plural `orphaned`), its row opens the worker's tab through the
  oref router, and its button is Acknowledge, which clears the two keys with `SetMetaCommand` (null values). No new
  wshrpc command: clearing meta is what the ack does, and a command would add generated-file churn for one call.
  Acknowledge all stays unverified runs only.
- **Held notice when the parent goes.** A worker with its notice held raises at once; it is stopped only when it
  runs and is idle. One running a user-typed turn keeps running under the user-turn rule.
- **Worktree commit.** `wsh agent-hook`, on the PostToolUse that stamps `agent:lastcommitts`, also stamps a new
  block meta key `agent:lastcommitbranch`: the branch (`git rev-parse --abbrev-ref HEAD` in the event's cwd) when
  that cwd is a linked worktree (its git dir differs from its common git dir), cleared otherwise. One git call per
  commit, bounded by a short timeout; a failed call stamps no branch and never fails the hook. Why: the hook
  already sees every commit, and the frontend has no git read per agent.
- **Done mark.** The branch icon is lucide `GitBranch` in an existing token other than `text-success` (green read
  as landed), titled `Done, committed on <branch>`. `commitmark.ts` returns the mark with its branch, so the card
  and the tree row draw it from one rule.
- **Stopped card.** A stopped worker's card body is its own state, never "waiting": a `Stopped, a message resumes
  it` line above the transcript's last turn, read by the same transcript stream an idle card uses (a stopped
  worker's file is not growing, so a stream costs one read). The task finds why the 11-26 card fell to "Waiting in
  its terminal" (stream not wanted for it, or no entries) and fixes that cause.
- **Resume timer.** `PublishStatus` stamps `Hook: UserPromptSubmit` on a `working` status: its only working callers
  (start, resume) publish it as their prompt is sent, and the working line (`nowline.ts`) already counts a turn from
  a turn-start hook newer than the transcript's last user entry. Why: no frontend change, and the hook means what
  happened.
- **Built on run acd6a5b1.** That run landed (38e820bae, 294d59aee) and this run's branch is rebased onto it, so
  every task starts from its `PublishStatus(ctx, blockId, state, at)`, its `standingBy` / `backgroundTasksRunning`
  settle, its task-named workers (`session:label`) and its `agent-workers` scenario steps. New scenario steps go
  after its own.
- **Every consumer of the new kind names it.** The pet peek labels it `Orphaned` with the answer as its detail
  and its own dot, and its one act is Open on `tab:<id>` (the pet's ack verb acks runs only, so Acknowledge stays
  in the Brief); the palette reads it `orphaned`; a phone push reads `Parent ended`.
- **Known limit, no spec change.** The branch comes from the hook event's cwd: a `git -C <worktree> commit` run
  from a session in the main checkout stamps no branch and keeps the tick, and pi stamps no commits at all, as
  today. Both are rare and the spec's "no merge check" keeps the mark a one-call stamp.

### Task 1: Orphaned workers finish their owed turn, raise an attention item, stop
**Depends on:** none
**Chunk:** Orphaned workers: finish the owed turn, answer to attention, stop
**Files:** `pkg/agentworker/lifecycle.go`, `pkg/agentworker/lifecycle_test.go`, `pkg/agentworker/orphan.go`, `pkg/agentworker/orphan_test.go`, `pkg/wcore/workspace.go`, `pkg/jarvis/attention.go`, `pkg/jarvis/attention_orphan_test.go`, `pkg/remotemode/pusher.go`, `pkg/remotemode/pusher_test.go`

Acceptance:
- A worker whose parent's tab is deleted mid-turn with its notice owed delivers no notice; when the turn settles it
  writes `agent:orphaned` and `agent:orphananswer` (its answer's first line) on its tab and stops.
- A worker idle with its notice owed or held when its parent's tab is deleted raises at once and stops; a held one
  on a running user turn raises and keeps running.
- A worker on a user-typed turn, or already notified and stopped, gets no mark when its parent goes.
- A worker whose parent is a worker whose process ended (tab kept) still has its notice held, as today.
- An orphan with a worker of its own still running raises only once none runs.
- An orphan standing by on a background task it started (`standingBy`) raises only when the turn that task's
  finish opens settles, not when its parent goes.
- The settle treats a parent as gone in the window between the tab-close hook and the store delete.
- `GatherAttention` lists a tab carrying `agent:orphaned` as a `worker-orphan` item with the Key, ORef, Source,
  Text, Action and WaitingSince the header pins, after the unverified group; a tab without it adds nothing.
- A `worker-orphan` push reads `Parent ended`.

### Task 2: The orphan's item in Waiting on you: open its tab, Acknowledge clears it
**Depends on:** none
**Files:** `frontend/app/view/jarvis/briefingmodel.ts`, `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/jarvis/briefqueueactions.ts`, `frontend/app/view/jarvis/briefqueueactions.test.ts`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/view/jarvis/briefrows.ts`, `frontend/app/view/jarvis/briefrowviews.tsx`, `frontend/app/view/jarvis/briefwaiting.tsx`, `frontend/app/view/jarvis/briefingfixtures.ts`, `scripts/cdp/scenarios-brief-act.mjs`, `frontend/app/view/jarvis/petpeekmodel.ts`, `frontend/app/view/jarvis/petpeekmodel.test.ts`, `frontend/app/view/jarvis/petpeek.tsx`, `frontend/app/view/jarvis/petacts.ts`, `frontend/app/view/jarvis/petacts.test.ts`, `frontend/app/cockpit/palette-items.ts`, `frontend/app/cockpit/palette-items.test.ts`

Acceptance:
- A `worker-orphan` item (wire shape in the header) builds a queue row whose kind word is `orphaned`, whose click
  opens `tab:<id>`, and whose one button is Acknowledge; the summary counts it as `N orphaned`.
- Acknowledge calls `SetMetaCommand` on the item's tab oref with `agent:orphaned` and `agent:orphananswer` null and
  toasts `Acknowledged · <source>`; a refused call shows its error. Acknowledge all does not include it.
- The pet peek row for it reads `Orphaned` with the item's text as its detail, has a dot, and its act is Open on
  `tab:<id>`; the palette's needs row reads `orphaned`.
- Scenario step in `brief-act`: the act fixture carries one `worker-orphan` item; its row shows `orphaned`, the
  `Parent ended · ...` text and an Acknowledge button.

### Task 3: Done mark names the worktree branch
**Depends on:** none
**Files:** `pkg/waveobj/wtypemeta.go`, `pkg/waveobj/metaconsts.go`, `frontend/types/gotypes.d.ts`, `cmd/wsh/cmd/wshcmd-agenthook.go`, `cmd/wsh/cmd/wshcmd-agenthook_test.go`, `pkg/gitinfo/gitinfo.go`, `pkg/gitinfo/gitinfo_test.go`, `frontend/app/view/agents/commitmark.ts`, `frontend/app/view/agents/commitmark.test.ts`, `frontend/app/view/agents/committick.tsx`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/agenttree.tsx`, `scripts/cdp/scenarios-agent-workers.mjs`

Acceptance:
- `agent:lastcommitbranch` is a typed block meta key (`task generate` run).
- A commit hook event in a linked worktree stamps its branch with `agent:lastcommitts`; one in a main checkout
  clears it; a git failure stamps the commit time and no branch.
- The commit mark model returns no mark when not done or not committed this turn, a tick for a commit with no
  branch, and a branch mark for one with a branch.
- The card and the tree row draw the branch icon titled `Done, committed on <branch>` in place of the green tick;
  a shared-checkout commit keeps the tick.
- Scenario step in `agent-workers`: a done fixture worker whose block carries a commit stamp and a branch shows the
  branch icon with that title on its card and its tree row.

### Task 4: A stopped worker's card shows its last turn; a resumed turn's timer starts at the resume
**Depends on:** Task 3
**Chunk:** Worker UX polish: resume timer, unmerged Done, stopped card
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/cockpitsurfacemodel.ts`, `frontend/app/view/agents/cockpitsurfacemodel.test.ts`, `frontend/app/view/agents/cockpitshell.tsx`, `frontend/app/view/agents/agentrow.tsx`, `pkg/agentworker/worker.go`, `pkg/agentworker/worker_test.go`, `scripts/cdp/scenarios-agent-workers.mjs`

Acceptance:
- A stopped worker's card body is the stopped state whether or not it has entries, never `waiting`; a non-worker
  with nothing to show still gets `waiting`.
- A stopped worker with a transcript path is streamed whenever its card can render.
- `PublishStatus(ctx, blockId, state, at)` with `working` publishes `Hook: UserPromptSubmit` at `at`; with `idle`
  (boot's stopped worker, as of its last transcript write) it publishes no hook.
- Scenario step in `agent-workers`: the stopped worker's card shows `Stopped, a message resumes it` above its
  fixture transcript's last assistant text, and no `Waiting in its terminal`.
