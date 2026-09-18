# Backlog cleanup — verified open items (design)

Effort: `effort:cce0be37-6972-4068-89da-2c3738e5f765`. Date: 2026-09-17. Branch: `backlog-cleanup`.

Every chunk was re-checked against the code at `06cf6b68` before this design. Product calls were made one at a
time, on the owner's behalf, by the supervising session the owner delegated them to; this document records the
outcome, not the options.

## Scope

15 chunks (chunk 7, Diff surface Spec B, is deferred by the owner and is not touched by anything here).

### Closed without a task (already done 2026-09-17)

| Chunk | Status | Evidence |
|---|---|---|
| 1 · G6 lead notifications fire-and-forget | done | `27228cb9` replaced the control-file `NotifyLead` with typed wakes confirmed by the lead's `working` status: `pkg/orchestrate/wake.go` `WakeConfirmTimeout`, retry once, then `leadDiedLocked` → `lead-wake-failed` + questions to the human. `TestWakeRetriesOnceThenLeadIsDead`. |
| 5 · Gatekeeper multi-question asks | skipped | The deferral's urgency was DAG child asks; the redesign routed those to the lead (`pkg/jarvis/watcher.go` `handleAsk` returns early for `isDagChildRun`). Held on evidence. |
| 6 · Diff-surface revert orphans | skipped | Kept as Spec B's starting point (`docs/deferred.md` 2026-09-04); Spec B is deferred, not declined. |

Their `docs/open-issues.md` / `docs/deferred.md` rows are updated by the docs task (Task 13).

### Decisions per remaining chunk

| Chunk | Decision |
|---|---|
| 9 · channel lifecycle | Delete rename / archive / notes end to end; delete the FE `deleteChannel` store function but **keep** `DeleteChannelCommand` (CDP scenario teardown calls `deletechannel`). Premise gone: one channel per project since `6b3882ad`/`95065db1`, `channelProjectLabel` never shows `channel.name`, `channel:notes` has no reader. |
| 10 · composer `@`-vocabulary | Delete, including the composer-attachment modules only it mounted; move `RunShape` into `runconfig.ts`; drop the `@quick/@run/@ask` sentence in `runlauncher.tsx`. The lost attachments get a `docs/deferred.md` entry. |
| 11 · subject browsing/grouping | Delete `toggleSubjectGroup` + `collapsedSubjectGroupsAtom`; superseded by the palette's Brief index (`briefpalette.ts` `buildBriefIndex`). |
| 12 · thread lifecycle | Delete FE functions and the Archive/Delete JarvisConversation RPCs; `docs/deferred.md` entry with revive condition "thread clutter in the palette". |
| 13 · per-answer cancel/retry | Delete `cancelJarvisQuery` / `retryJarvisQuery`. |
| 14 · rail fleet dismiss | Delete `dismissWorker`; `buildFleetSnapshot`'s dismiss reader stays for stored messages. |
| 15 · Stage turn renderers | Re-home the two real remainders into the Brief's `TurnView` ([n] markers on restored threads, weak/notfound verdict), then delete `jarvisturn.tsx` and its orphans. |
| 8 · record-peek workaround | Unwind, after confirming `ModalShell` stack-gates both Escape and focus. |
| 16 · lead-authored routing | Phase 3 evidence now (`harness`, `model` on `RunEvidence`); Phase 4 held in `docs/deferred.md`. |
| 3 · F26 | One run-worker exit reconciler for every non-DAG run; shutdown exits are never worker failures. |
| 4 · F22/F23 | Die half: extend the existing ask retirement; hang half closed on evidence; session answers confirmed like DAG answers. |
| 2 · F25 | Pty-silence "hung" overlay for claude, derived in the FE; hook state untouched. |

## Rules every task follows

- **Orphan cascade.** Delete what the task names, then repeat to a fixed point: a module or export is deleted
  only when every remaining consumer is itself deleted or is its own test. Nothing outside that cascade changes.
- **RPC deletion.** Before deleting an RPC, grep `scripts/` (CDP scenarios, inject scripts, verify harness) and
  `cmd/` for its command name; update or drop any caller in the same task. Then `task generate`; never hand-edit
  generated files.
- **Locate by symbol.** Line numbers in docs are archaeology.
- **No docs.** Code tasks never edit `docs/`. Each closes its own chunk with
  `wsh effort chunk status cce0be37-6972-4068-89da-2c3738e5f765 "<label>" done --note "..."` as its last step
  before `wsh jarvis complete --commit`, and the note carries: the commit, deleted paths, the row text Task 13
  should write, and any `git show <commit>^:<path>` recovery command a deferred entry needs.
- **Formatting.** HEAD is not gofmt/prettier clean; format only changed lines. Never `prettier --write` a
  `scripts/*.mjs`.
- **Frontend proof** is vitest over a pure model. No jsdom render tests. No CDP: this worktree cannot drive the
  dev app, so anything that needs a live look goes in the chunk note as "owed after merge".
- **Commit and push.** Commit on the task branch; never push.

## Design

### Deletions

**Chunk 9 — channel lifecycle.** Delete `renameChannel`, `archiveChannel`, `setChannelNotes`, `deleteChannel`
(`frontend/app/view/agents/channelsstore.ts`); `RenameChannelCommand`, `ArchiveChannelCommand`,
`SetChannelNotesCommand` from `pkg/wshrpc/wshrpctypes_channels.go` with their data types, handlers
(`wshserver_channels.go`) and tests; `jarvis.MetaKey_ChannelNotes` (`pkg/jarvis/resolve.go`). Keep
`DeleteChannelCommand` and its handler, `wstore.MetaKey_Archived` (conversations use it) and
`partitionChannels` (reads legacy flags). `task generate`.

**Chunk 10 — composer vocabulary.** Delete `frontend/app/view/agents/channelcomposers.tsx`;
`composercommand.ts` and its test except the `RunShape` type, which moves to `runconfig.ts` (update importers:
`runconfig.ts`, `runconfigstore.ts`, `jarvis/newrun.ts`); `channelderive.activeMentionQuery` and its tests;
`harnesspicker.harnessRuntimeIds`; `attachmenttray.tsx`; `composerattachments.ts` and its test. Remove the
sentence in `runlauncher.tsx` that says typing `@quick`, `@run` or `@ask` in the goal overrides the shape.
Keep `WriteTempFileCommand` (terminal image paste in `term/termutil.ts`) and `ComposerShell` (`runbody.tsx`).
Chunk note carries the recovery command for the attachment modules (`875967bf` introduced them).

**Chunk 11 — subject grouping.** Delete `toggleSubjectGroup` and `collapsedSubjectGroupsAtom`
(`frontend/app/view/jarvis/jarvissubjectstore.ts`).

**Chunks 12 + 13 — thread lifecycle, cancel/retry (one task: both edit `jarvisstore.ts`).** Delete
`archiveJarvisConversation`, `deleteJarvisConversation`, `cancelJarvisQuery`, `retryJarvisQuery`
(`frontend/app/view/jarvis/jarvisstore.ts`); `ArchiveJarvisConversationCommand` and
`DeleteJarvisConversationCommand` with data types, handlers (`wshserver_jarvis.go`) and tests; any `wstore`
helper left test-only (e.g. `wstore.DeleteJarvisConversation`) with its tests. The persisted archived flag stays
readable (`briefpalette.ts`, `summaryToRailConversation`). Do not change `submitJarvisQuery`'s live path, the
`Terminal` type or `terminalBadge`; internal cancel state that becomes dead may be simplified inside
`jarvisstore.ts` / `jarvisturnderive.ts` (this task owns `jarvisturnderive.ts`). `task generate`. Chunk note carries
the recovery command and the revive condition for the deferred entry.

**Chunk 14 — dismiss.** Delete `dismissWorker` (`frontend/app/view/agents/channelactions.ts`). Keep the
`"dismiss"` branch in `jarvisderive.buildFleetSnapshot`.

### Re-homes and small fixes

**Chunk 15 — turn renderers.** Move `turnProse` out of `briefsurface.tsx` into a pure module with a vitest
(e.g. beside the other Brief pure modules). It renders `{ citationRef: n }` segments as `[n]`, so a restored
thread keeps the markers its chip legend refers to. Add a pure `turnVerdict(terminal)` that returns
`terminalBadge`'s label and tone only for `weak` and `notfound` — `error` and `cancelled` return `null`,
because the Brief already renders "Ask failed — try again" — and show it in `TurnView` with token colors. The
vitest covers both rules. Then delete `jarvisturn.tsx` and whatever the cascade leaves (e.g.
`recallderive.groundingByN` and its test cases). `jarvisturnderive.ts` is read, never edited, by this task.

**Chunk 8 — record peek.** First confirm in code that `ModalShell` gates **both** its Escape handling and its
focus take/restore (`takeModalFocus`) on being top of `modalstack`. If focus is not stack-gated, fix that and
cover the rule it depends on in a pure test. Then `briefpeekview.tsx` passes `open={recordId != null}` and the
yield comment goes. A `modalstack.test.ts` case proves the stacked pair: register peek, register confirm → only
confirm is top; unregister confirm → peek is top. Chunk note: the live check (confirm over peek, Escape closes
only the confirm, focus returns to the peek) is owed over CDP after merge.

**Chunk 16 — route evidence.** `waveobj.RunEvidence` gains `Harness string \`json:"harness,omitempty"\`` and
`Model string \`json:"model,omitempty"\``, set where `pkg/jarvis/evidence.go` builds the evidence (before
`evidenceHash`): harness is `run.Runtime`, or the default worker runtime when empty; model is the transcript's
`agentsessions.SessionInfo.Model`, falling back to `run.Model`, empty when neither is known. Tests cover each
fallback. `task generate`. Chunk note carries the Phase 4 held-entry text (revive when enough DAG runs carry route
evidence to compare cost/outcome per stamp, harness and model).

### Liveness

**Chunk 3 — F26, run-worker exit reconciliation.**

1. *Shutdown guard.* `blockcontroller.StopAllBlockControllersForShutdown` sets a package flag; the shell wait
   loop skips `AgentOutcomeHook` while it is set. Quitting the app is never a worker failure, for the new
   reconciler and the existing lead/child paths alike. Tested at that seam.
2. *Reconciler.* `orchestrate.HandleLeadExit` becomes the exit reconciler for every run that is neither a DAG
   child nor holding a DAG: when the exited worker oref is in the run's **running phase's** `WorkerOrefs` (so a
   pipeline's earlier phase exiting late cannot fail the next one) and the run, re-read under `UpdateRun`, is
   still executing or planning, `jarvis.FailPhase` that phase. An orchestrator lead keeps `lead-exited`; every
   other mode appends a new `worker-exited` run event (`pkg/waveobj/runevent.go`, plus title and tone in
   `frontend/app/view/agents/runtimeline.ts` and its test).
3. *Ordering.* `pkg/jarvis/onexit.go` resolves the tab and agent runtime and calls the reconciler **before** the
   `reportableExit` transcript gate, so a clean exit with no transcript still reconciles.
4. *Tests.* Quick run fails on worker exit; pipeline's stale earlier-phase exit is ignored; a run completed just
   before the exit is untouched; DAG children and DAG-holding runs unchanged; shutdown exit does not fire the hook.
5. *Relaunch check.* Read the `ResyncController` path and say in the chunk note whether a quick-run worker
   actually restarts after quit + relaunch. If a quick run can still sit `executing` after that, the note says
   so as the remaining F26 gap for Task 13 to record — it is not closed silently.

**Chunk 4 — F22/F23, session asks.**

1. *Die half.* Extend `pkg/jarvis/attention.go` `livePendingAsks` with a third way to be gone: a local (not
   job-backed) block whose controller reports its process not running. A missing controller is unknown and
   keeps the ask. Table-tested beside the existing cases. This stays the single retirement path.
2. *Hang half.* Closed on evidence, no code: a live agent in its picker writes nothing to transcript or pty,
   so no signal separates hung from waiting; the cockpit dismiss (`agentrow.tsx` → `AgentAskClearCommand`) is
   the human's escape and F24's `displayAgeMs` shows the real age.
3. *F23.* `agentask.injectAnswer` awaits the clear for every keystroke-delivered ask, not only `Owner != ""`
   (the waiter path already confirms). `orchestrate.sweepAsks` handles a restored ask with no `DagOID` as a
   session ask: it stays pending with `AnswerUnconfirmedNote` and is republished on `wps.Event_AgentAsk`
   **directly**, not through `jarvis.PublishAgentAsk`, which would run the Gatekeeper on it again. DAG handling
   is unchanged. `baseds.AgentAskData` gains `Note string \`json:"note,omitempty"\`` (`task generate`); the FE
   passes it through the view model (`AgentAsk.note`, tested in `agentsviewmodel.test.ts`) and the ask card
   shows it.
4. *Tests.* Session answer not cleared in time comes back with the note; a cleared one does not; the republish
   does not invoke `OnAgentAsk`; the `livePendingAsks` cases.

**Chunk 2 — F25, hung overlay.**

1. *Stamp.* `blockcontroller.HandleAppendBlockFile` records the last output time per block for
   `BlockFile_Term` (the funnel for local and remote output).
2. *Publish.* `BlockControllerRuntimeStatus` gains `LastOutputTs int64 \`json:"lastoutputts,omitempty"\``
   (`task generate`), republished on `controllerstatus` at most once per 30 s per block, without the per-update
   log line. A working agent's published time is therefore never more than 30 s old, well under the threshold.
3. *Overlay.* The FE roster subscribes to `controllerstatus` (the `agentaskstore.ts` global-subscription pattern)
   into a block → last-output map. A pure function marks an agent hung when `agent === "claude"`, `state ===
   "working"`, and `now - lastOutputTs >= 3 min`; the row reads `hung · no output Nm`. `AgentState` and every
   state switch are unchanged. pi is excluded until its TUI output is measured.
   A silent agent produces no further `controllerstatus` event, so an overlay evaluated only on events would
   never flip to hung: it is evaluated against the agents view model's clock (`model.nowAtom`, as
   `agentdetailsrail.tsx` reads it), so it flips as time advances past a fixed stamp.
4. *Untouched.* `Event_AgentStatus`, hook state, the engine and the wake adapter.
5. *Tests.* Pure overlay: claude working past threshold is hung; under threshold, asking/idle, non-claude, or no
   stamp are not; a stamp that stays fixed while `now` advances past the threshold flips to hung; throttle helper
   publishes on first output after the interval and not before.

## Plan shape

- **Generate lane** (each runs `task generate`, so one chain): chunk 16 → chunk 9 → chunks 12+13 → chunk 4 →
  chunk 2. Chunk 2 also waits on chunk 3 (both edit `blockcontroller`), and on chunk 4 (both edit
  `agentsviewmodel.ts` / the agent row).
- **Verify flake:** a first task with no dependency hoists the in-test dynamic import in
  `frontend/preview/mock/mockwaveenv.test.ts`, which timed out once in three HEAD runs under load (owner call
  2026-09-17). No effort chunk.
- **Exit lane:** chunk 3, no dependency.
- **Frontend lane:** chunks 10, 11, 14, 15, 8, no dependencies, no shared files.
- **Docs:** one final task depends on every code task and writes every `docs/open-issues.md`,
  `docs/deferred.md` and `docs/lead-authored-task-routing-roadmap.md` update from the chunk notes, citing
  commits — including the three chunks closed without a task and the new deferred entries (attachments,
  threads, Phase 4).
- **Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run &&
  CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...` — green on HEAD and timed before submit.
- **Setup:** `task worktree:prepare`.

## Noticed, out of scope

`jarvisderive.ts` exports `fleetCostUsd`, `buildJarvisPrompt` and `pendingAskCount` with no consumer, and
`effortstore.ts`'s `unarchiveEffort` / `deleteEffort` are still orphaned (initiative lifecycle row). Neither is a
chunk of this effort.
