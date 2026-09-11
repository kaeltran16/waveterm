# Open issues — consolidated backlog

Consolidated 2026-08-24 from every scattered tracker: the pre-consolidation `docs/open-issues.md`,
`docs/deferred.md`, `docs/jarvis-second-brain-open-issues.md`, `docs/jarvis-consolidation-open-issues.md`
(all JC fixed), the orchestrator roadmaps/plans, and the improvement-scan briefs. **This file is now the
single "what's left" list.** The source files remain as history and rationale logs — they hold the why;
this file holds the what. New deferrals still get their full entry appended to `docs/deferred.md`, then
mirror a one-line row here.

Every item below carries a source pointer; read that before planning any fix. Status legend:

- **Actionable** — can be picked up as-is.
- **Active** — approved workstream already in progress or designed.
- **Blocked** — cannot start until a prerequisite exists.
- **Held** — deliberately deferred pending a named trigger or evidence; do not build off the spec alone.
- **Declined** — decided against; do not resurface.

---

## 1 · Active workstreams

### Channel data-model scaling — Phases 0–2 shipped, Phase 3 parked (evidence gate 2026-08-25)

Phases 0–2 are in — read pool, indexed `db_run`/`db_channelmessage` rows, redirected hot-path lookups,
delta broadcast. **Phase 3 (Contract: drop the embedded arrays) is parked pending evidence**: the prod
reality check measured 4 channels / 680 KB total blob, so the large-channel target does not exist. See
Held §4 and the `docs/deferred.md` 2026-08-25 entry. Take the Phase 2 carry-ins (cross-channel rail
badges, visual-parity CDP check) before any contract work. Spec:
`docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md`. Source: improvement-scan
brief Theme A.

### Diff surface JetBrains parity — Spec A planned, Spec B (repository actions) not written

Five of six gaps are specced and planned (Monaco diff pane, merge-base/tip-to-tip toggle, remote refs
+ fetch, ref swap, file tree) plus a collapsible history column, since the app ships a 1000x700 window
where the diff pane gets ~240px. **Outstanding: gap 6, repository actions** (checkout, cherry-pick,
revert) — needs its own spec before any code; `gitinfo.RevertFile`/`RevertHunk` already exist and are
orphaned. Status: Actionable (Spec A), Blocked on a brainstorm (Spec B). Specs:
`docs/superpowers/specs/2026-09-04-git-compare-viewer-parity-design.md`, plan
`docs/superpowers/plans/2026-09-04-git-compare-viewer-parity.md`, rationale in the `docs/deferred.md`
2026-09-04 entry.

### Lead-authored task routing — Phases 1–3

The roadmap header still reads "draft, awaiting review" (2026-08-19), but the route chain has shipped:
backend run-route capability authority, settings/channel persistence validation, enforcement at worker
launch + DAG children, capability-driven route controls, draft-first DAG creation (stage-local modal), and
structured fast approval (plans 2026-08-20/21), and Phase 2 (same-tier retry wiring + typed `blocked` +
`escalate` verb) shipped with the 2026-08-25 phase-2 engine — `RetryTask`, `TaskState_Blocked`, `dag
escalate` all present in `pkg/` (the 2026-08-24 scan's "Also noted" line is stale). Remaining: Phase 3
(route surfaced in DAG graph + run evidence), Phase 4 measurement gate (evidence-gated, may be skipped
entirely).
Doc: `docs/lead-authored-task-routing-roadmap.md`.

### Orchestrator redesign — shipped (as of 2026-08-25)

`docs/superpowers/plans/2026-08-16-orchestrator-redesign.md` (headless-child contract + child-ask
forwarding) is shipped: `HeadlessContract`, child-ask forwarding (`dag asks`/`dag answer`,
`AskAgentCommand`), and `dag init` are all present in `pkg/`, and the design-flaws tracker F1–F10 are
all marked resolved. The plan doc's own checkboxes were never updated (still 27 unchecked) — a
doc-hygiene gap only, the code is in. No longer a sequencing dependency.

### 2026-08-24 orchestrator improvement scan — remaining Jarvis findings

The engine findings O1–O8 shipped in `b9aad7fd`; Jarvis J1 shipped in `67b628a3`, J2/J6 in `a7de0687`, and
J3 (meta-doc corrected, `Backfill`/`Harden` unexported), J4 (per-line timeline truncation), J5 (onexit
failure logging) landed in the same two commits — the scan is fully closed as of 2026-08-25. Historical
evidence remains in `docs/superpowers/briefs/2026-08-24-jarvis-orchestrator-improvement-scan.md`.

### 2026-08-26 orchestrator gaps scan — closed except G6

Read-only scan of the shipped phase-2 engine, child-ask lifecycle, lead CLI, and DAG graph FE
(`docs/superpowers/briefs/2026-08-26-orchestrator-gaps-scan.md`). **G1, G2, G4, G5 and G7 shipped in
`6c474fa1`**, verified against the code 2026-09-04: `SendBackGate` returns a reopened gate to
`Pending` with the RunID cleared (`scheduler.go:115`); the failure streak clears only on a *fresh*
success (`engine.go` `freshSuccess`, the guard itself from `d692708d` — a blanket clear on any
success would have made the circuit-break untrippable once any task had ever succeeded, so G2's
policy question is answered and closed); `MergeContinue` is reachable as `DagMergeContinueCommand`
end to end; a landed merge stamps `Merged` (marker from `5a863daa`), which cleanup keys off; and
`dag status` prints per-task health/age through `dagStatusLines`.

**G6 remains** (low, deferred as design): lead control notifications are fire-and-forget with no
delivery ack.

### Jarvis Brief B5 — the retired panes' orphaned mounts (deferred 2026-09-10, revised 2026-09-11)

B5 deleted the Subjects column, the Stage and the context rail. Five capabilities were re-homed into the
Brief's detail sheet — the run body, the launcher and its goal row, the record band, the initiative detail,
and B4's profile modal. Thirteen were not, and their implementations are still in the tree, orphaned but
**not deleted**: re-homing one is moving an existing control, not rebuilding it.

**The "mechanical rather than recalled" claim is walked back (2026-09-11).** The list came from sweeping `app/`
for exported functions with no production consumer left, and that sweep is a floor, not a proof. It missed
`agents/channelcomposers.tsx` outright, and it is structurally blind to a capability that dies *inside* a file
that has a successor — the exports keep a consumer (a test file counts as one to a grep), so nothing reads as
orphaned. It is also single-level: an export whose only consumer is itself unmounted reads as live, which is
how steering survived the sweep behind `channelcomposers.tsx`. All three gaps are folded into the table
below. Full rationale: `docs/deferred.md`, the 2026-09-10 entry and its 2026-09-11 update.

**Four are closed** by the Brief review-findings pass (`effort:732863fa-1374-4ab2-9753-1220fc885f34`, F1–F9),
each by re-homing the existing control; the status column says which chunk.

| Capability | Orphaned implementation | Load-bearing? | Status |
|---|---|---|---|
| Channel lifecycle — rename / delete / archive / notes | `renameChannel`, `deleteChannel`, `archiveChannel`, `setChannelNotes` (`agents/channelsstore.ts`) | **yes** — a channel can still be created and never managed | open |
| Initiative lifecycle and the effort card | `EffortCreateForm`, `EffortCard`, `expandEffort`, `toggleEffort`, `unarchiveEffort`, `deleteEffort` | **yes** — no initiative could be started | **creation re-homed (F7)** — `newinitiativecontrol.tsx` + `Shift+N`; archive / unarchive / delete still orphaned |
| Autonomy ladder — tier and mode | `AutonomyLadder` (`jarvis/autonomyladderview.tsx`) | yes — this is the remote approval policy | **re-homed (F7)** — the header tier chip, faced by `briefautonomy.ts` |
| Profile drawer — playbook and global profile (*missed by the sweep: died inside `profilepanel.tsx` → `briefprofileview.tsx`*) | `ProfileOverride.playbook`; `getGlobalProfile` / `setGlobalProfile` / `reduceGlobalPrinciples` | yes — `resolveRunPlan` composes every pipeline run from the resolved playbook | **re-homed (F4)** — `BriefProfileModal`'s project/global scope toggle |
| Steering a running worker (*missed by the sweep: its only consumer was the unmounted `channelcomposers.tsx`*) | `steerWorker` (`agents/channelactions.ts`), via the Talk face | yes — unreachable cockpit-wide, not just from the Brief | **re-homed (F3)** — sheet composer → `briefcomposertarget.ts`; `TalkComposer` itself stays orphaned |
| Composer `@`-command vocabulary — `@quick` / `@run` / `@ask` (*missed by the sweep entirely*) | `LaunchComposer`, `TalkComposer` (`agents/channelcomposers.tsx`); `LAUNCH_COMMANDS`, `parseComposerCommand`, `resolveComposerDispatch` (`agents/composercommand.ts`, now reached only by that file and its test) | no — the launcher's controls set the mode; the one-shot `@ask` consult has no typed form | open |
| Subject browsing, grouping, filtering | `toggleSubjectGroup`; the grouping model went with `subjects.ts` | no — the Brief's regions cover running work | open |
| Thread lifecycle — archive / delete | `archiveJarvisConversation`, `deleteJarvisConversation` | no | open |
| Per-answer cancel and retry | `cancelJarvisQuery`, `retryJarvisQuery` | no | open |
| Ask-mode consult results (§4a item 11) | `ConsultsSection`, deleted with the rail | deliberate drop | open |
| Resume / proactive cards (§4a item 12) | `ResumeCard`, `ProactiveCard` | deliberate drop | open |
| Rail fleet roster and per-worker dismiss | `FleetRoster`, `dismissWorker`, `runRailSection` | no — the header keeps a derived fleet line | open |
| Stage turn renderers | `JarvisAnswer`, `JarvisWorkingSteps` (`jarvis/jarvisturn.tsx`) | largely superseded by `briefdrew.ts` | open |

---

## 2 · Actionable smalls

The reliability findings below are ranked and detailed in
`docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md`; no implementation is approved yet.

| Item | Kind | Effort | Source / notes |
|---|---|---|---|
| Issue 8 deep-link fix was never reproduced live (unit-tested only) — verify with a focused agent + dirty worktree | verification gap | S | pre-consolidation issue 8 detail (in git history); fixed 2026-08-04 |
| OS/dock/titlebar badge when Arc is backgrounded (in-app counter ships; nothing reaches you cross-app) — measure-first | feature | M | scan brief B2; `badge.ts`, `navrail.tsx` |
| Diff-surface orphans: `GitRevertCommand` / `gitinfo.RevertFile` / `gitinfo.RevertHunk` / `filesstore.reloadChanges` have no caller — delete both together or neither | tech-debt | S | `docs/deferred.md` 2026-07-31 entry. **2026-09-04:** `reloadChanges` should be split from the revert three — the surface reads its change list on mount and never again, so a file edited while on screen keeps stale counts, and this is the refresh that gap wants. **2026-09-05:** the `reloadChanges` half is *implemented but not landed* — a live DAG run built it (selection-preserving refresh, `files:refresh` on `r`, a ~10 s visible-surface poller, 8 behavioural tests) and it sits in the throwaway worktree `.claude/worktrees/files-refresh`, verified there at 60 tests passing and `tsc` clean. **Landed on `main` 2026-09-05** (fast-forward to `937c8dfe`; re-reviewed before merge, 212 tests green, `tsc` exit 0, `surface-smoke` 10/10). The `reloadChanges` half of this row is closed; the revert three remain untouched and still belong to Spec B |
| Files-surface CDP visual pass (plan Task 9, deferred while :9222 was occupied) | verification | S | `docs/deferred.md` Files-surface entry |
| `MaxDagTasks` has no path for a plan larger than the cap — a 17-task plan still hard-fails at import, with no way to carry the remainder into a second run | bug | M | flaws tracker F11. **2026-09-04:** the cap raise (8 → 16) and the error text are both done, so R9 is satisfied as written; what remains is the structural half — a split path across runs, which is a feature, not a message fix |
| ~~One run holds exactly one DAG, stated nowhere~~ **fixed 2026-09-04** | bug | S | flaws tracker F12. The rule is now stated in all three places a lead meets it: the prompt (`run.go:416`, since `eda08f24`), both submit paths' CLI help (`dagOneDagPerRunNote`), and both error texts (`dag.go` task ceiling, `wshserver_dag.go` dag conflict) |
| No first-token deadline: a lead that dies on its first model call is indistinguishable from one that is thinking — **exit half fixed 2026-09-04; deadline half falsified live 2026-09-05, revert or narrow it** | bug | M | flaws tracker F13 + R10 addendum. The **exit** path is sound and stays: an agent that exits non-zero without stamping a transcript is reported at `onexit.go` in seconds instead of dropped, and a dead lead fails its running phase so the run derives `blocked` instead of reading `executing` forever. The **first-token deadline** half is harmful. `lastActivityForRun` returns `tracked=true` for any liveness-capable runtime even when no session file matched (`liveness.go:137`), so the `!tracked` guard at `engine.go:232` cannot protect a claude child: with no transcript yet it has `LastActivity == 0` and ages against `FirstTokenDeadline` *while working normally*. In the 2026-09-05 live run all four children wrote **no transcript at all** for their entire successful lifetime, and two of three timed tasks ran past the 5-minute deadline while committing correct work — t-1 304,765 ms, t-2 308,798 ms, t-3 274,921 ms. Only the 30 s `watchdogInterval` failing to land in the 5–9 s exposure window prevented a false `Stalled` and the retry that discards a finished worktree. The deadline sits at the median task duration for this workload, so it is a per-task coin flip, not an edge case. Options: gate it to runtimes whose transcript is per-event (pi today), or replace the signal with pty-output freshness — measured at 15–59 KB per 45 s while working and hard zero the moment work stops, which discriminates in both directions where the transcript never does |
| Route picker offers routes the account cannot run — the backend rejects at `runroute.go:79`, the picker still lists them as selectable | bug | M | flaws tracker F14. **2026-09-04, investigated and deliberately not fixed:** entitlement is not statically knowable — `ListHarnessesCommand` reports capability by construction, and a probe costs a process spawn per launch and goes stale anyway. The pi half (tier routes resolving to a bare `deepseek-v4-pro`) did **not** reproduce: on this install that id is unique to `opencode-go`, so it resolves. It is data-dependent, not deterministic — a static provider prefix would be exactly as fragile as the bare id. The durable fix is catalog-backed resolution at spawn, where ctx is available. Severity dropped by F13: a dead route now fails in seconds with the provider's own message instead of reading healthy for 15 minutes |
| ~~`import-tasks` hardcodes `parallelism: 2` with no flag~~ **fixed 2026-09-04** | tech-debt | S | flaws tracker F15; `--parallelism` added, defaulting to `orchestrate.DefaultParallelism` (the dag's ready width, capped at `MaxParallelism`) |
| ~~Merge gate has no liveness and no age~~ **fixed 2026-09-04** | bug | M | flaws tracker F16 + R10. A merge-ready task open past `MergeGateStaleAfter` (30 min) counts as attention, so health leaves `healthy` for `needs-you`. Aged from the retained task-done boundary; a gate whose event was pruned has no clock and is deliberately left alone. **Confirmed live 2026-09-05:** on a gate the lead never acted on, health flipped `healthy` → `needs-you` at exactly the 30-minute mark; the stranding it caught measured 1,848,673 ms and 1,843,493 ms of finished work sitting invisible while health read clean. **Not done:** the age is not *rendered* anywhere — the CLI and UI show that it needs you, not how long it has sat |
| A pending ask latches forever if the agent hangs or dies mid-tool | bug | M | **F22, found live 2026-09-05.** Ask visibility is set by the `AskUserQuestion` PreToolUse hook (`wsh ask`, non-blocking) and cleared *only* by the PostToolUse hook (`wsh ask --clear`). An agent that never completes the tool never reaches PostToolUse, so the block stays `state=asking` with no timeout, no liveness gate, and nothing to distinguish it from a live question. Observed: hook published `asking` at 23:23:38, agent hung after its picker closed, card still demanding an answer 70 minutes later. `AgentAskClearCommand` is exactly what the PostToolUse hook calls, which is why clearing it by hand worked. Fix shape: age the ask and gate it on worker liveness, the same signal F13 needs |
| `answeragent` reports success for an answer nothing consumed | bug | M | **F23, found live 2026-09-05.** `injectAnswer` (`pkg/agentask/deliver.go:68-76`) returns `true` as soon as the last keystroke is written to the pty; nothing confirms the agent accepted it or resumed. The RPC therefore returns success into a void — no error, no retry, no escalation — and the caller cannot distinguish "answer delivered and accepted" from "answer delivered and agent died". The waiter path (`ResolveWaiter`, pi bridge) does confirm; the Claude Code keystroke path does not |
| Ask banner age is hardcoded to "just now" by accident | bug | S | **F24, found live 2026-09-05.** `agentrow.tsx:439` renders `formatAge(agent.activeMs)`, but `withAsk` deliberately sets `activeMs: undefined` for an asking row and puts the real age in `blockedMs` (`agentsviewmodel.ts:783-784`, derived from the ask's own `ts`). `formatAge(undefined)` returns `"just now"` (`agentsviewmodel.ts:357`), so **every** ask banner reads "just now" regardless of age. Same mistake at `agentdetailsrail.tsx:91` (the ternary special-cases only `idle`) and `runworkercard.tsx:64`. Compounds F22: the one element that would expose a latched ask says it is fresh. Fix: a `displayAgeMs(vm)` helper picking `blockedMs` when asking, with a test, used at all three sites. Survived because the model layer is well covered while components are not — the repo has no jsdom render tests by design. **Fixed 2026-09-05:** `displayAgeMs(agent, now?)` in `agentsviewmodel.ts` returns the field that state actually populates (`blockedMs` asking / `activeMs` working / `now - idleSince` idle), with 5 tests; applied at all four sites (`runworkercard.tsx` had two, not one). The idle branch of `agentdetailsrail.tsx:91` had the same misread and was fixed with it. Note the render sites themselves stay unverified by unit tests — only the helper's contract is covered |
| No agent state represents "hung" | bug | S | **F25, found live 2026-09-05.** With its latched ask cleared, a process that was provably dead (frozen pty, ~1% CPU, no output for 70 min) immediately reclassified as `Working 1`. The roster has asking / working / idle and nothing else, so a hung agent must misreport as one of them |
| A force-killed agent leaves its run `executing` forever | bug | M | **F26, found live 2026-09-05.** Run outcome is hook-driven; `Stop-Process -Force` fires no `SessionEnd`, and nothing reconciles a vanished worker process against run status. Verified: lead killed, run still reported `status=executing phases=running` minutes later. The blockcontroller knows the process is gone; the run state never asks it. **Still open 2026-09-05** — the stranded run was closed by hand (`advancerun action=complete phaseidx=0 commit=937c8dfe`, which sealed evidence matching git exactly: 6 files, +173/-13), confirming only that the transition works when something calls it. Nothing calls it automatically |

**F22–F26 come from one live orchestrator DAG run (2026-09-05)** — see the closing note under
*Shipped 2026-09-04* for what that run verified. They are ask-protocol and liveness defects, not
engine defects: the DAG itself completed 4/4 correctly while the lead was hung the entire time.

**F11–F17 were never mirrored here (noted 2026-09-04).** They were filed in
`docs/orchestrator-redesign-flaws.md` Capture 2 and stayed there, so this list — which calls itself
the single "what's left" list — showed orchestration as closed while seven flaws were open. The six
rows above are that omission corrected, each re-verified against the code rather than copied. Four of
them (F12, F13, F15, F16) were fixed the same day and are struck through above rather than deleted,
so the mirror stays legible against the flaws tracker. **F17**
(`runtime` silently forking between two orchestrators) is deliberately *not* among them: the fork is
now an explicit `orchestration` parameter documented at `run.go:377`, so only the runtime-based
*default* remains and the "silent" complaint is answered — it is a close-out review, not a fix.

### Shipped 2026-09-04 — do not re-file

Ten rows left this table in one batch. Recorded here with pointers because several were filed twice
before (a fixed bug with a vivid repro note reads like an open one). Each fix is unit-tested; the
"live" column says whether it was also confirmed in the running app over CDP.

| Was | Fix | Live |
|---|---|---|
| Flat DAG never opened the merge gate — `dag wait` returned `terminal:healthy` with children unmerged | `d966c27e`: `buildNext` reports `merge-ready` whenever `mergeReadyIDs` is non-empty, ranked below dispatch and parallelism-wait so a DAG that can still spawn is never reported as needing the lead | **yes** — 2026-09-05 run opened `merge-ready(resolve-merge)` with children unmerged, and ranked `parallelism-wait` above it while the DAG could still spawn |
| `buildNext` fell through to a bare `terminal` on a running DAG with cleanup pending (F19) | `d966c27e`: the fall-through is now a typed `cleanup-wait` step, never terminal — the lead's stop signal is the only terminal kind. Named in the FE by `75738bfb` | **yes** — `parallelism-wait`, `merge-ready`, `dispatch` and `terminal:done` all observed as typed kinds across the 2026-09-05 run |
| Engine prompt said act "when the digest reports `merge`"; the digest says `merge-ready` / `resolve-merge` (F20) | `d966c27e`: prompt uses the digest's own words (`pkg/jarvis/run.go`) | no |
| `dagDigestChildRunLimit = 8` not raised with `MaxDagTasks = 16` (F21) | `d966c27e`: the constant now follows `jarvis.MaxDagTasks` | no |
| Every non-pi DAG child flagged **stalled** at 15 min regardless of progress; `retry` then killed healthy work (F18) | `3ca9cd6d`: liveness reads pi, claude and codex transcript roots via `agentsessions.SessionRoot`. A runtime with **no** readable activity source now reports freshness *unknown* rather than aging into a false stall — a missed stall costs a timeout, a false one kills a working child. `opencode` is deliberately untracked (cwd lives only in a sidecar file; rewrite behaviour unverified) | no |
| A `claude` worker in a never-opened directory blocked forever on the folder-trust dialog | `50cdc2d8`: `ensureClaudeDirTrusted` pre-registers the directory under Claude's own canonical-git-root key and lock protocol before spawn. Writes at most one entry per project, never per worktree | no — needs an untrusted dir |
| Engine `dag merge` not idempotent on a Windows worktree-lock failure | `851511a5`: worktree removal is the caller's step, so a cleanup failure cannot obscure a landed merge; an already-merged branch returns HEAD instead of re-merging | no |
| Pure rename rendered as the whole file added while the list beside it said `+0 −0` | `cd9cb5c8`: `pathDiff` asks the rename-source question **only** when a path-scoped read reports `new file mode`, then re-reads with both paths | **yes** — `R100` fixture renders *Renamed.* with `+0 −0` |
| Compare-mode summary printed the working tree's counts under the compare's ref names, refs reversed vs. the chip | `cd9cb5c8`: `summaryLine` picks the store the panes are showing; picker and chip print `base … head` | **yes** — `main … feat · 3 files · +30 −0` against a dirty tree |
| Hints footer never recomputed on compare/filter changes, advertising keys that did something else | `7807aa93` + `2ed1cc85`: `whenVersionAtom` counter over the 10 atoms the predicates read, plus a `store.test.ts` guard that fails when a predicate reads an unregistered atom | **yes** — 11 chips → 3 on toggle, no focus change |

**That gap was closed 2026-09-05 by a real orchestrator DAG run** (claude lead, `orchestration:
engine`, 4 tasks, parallelism 2, merge required, against the `reloadChanges` row in this table). The
run completed 4/4 done-and-merged to `terminal:done`, and the merged result verified independently of
the agents' own reports: 60 tests passing, `tsc --noEmit` exit 0.

What it settled:

- **Verified** — the merge gate opens on a flat DAG; `buildNext` reports typed kinds throughout; the
  30-minute stale-merge-gate escalation (F16) fires exactly on time.
- **Falsified** — F13's first-token deadline, which false-stalls working children; the F13 row above
  now carries the measurements.
- **Not exercised** — F12 (needs a live lead to attempt a second submit) and F13's exit-hook half (no
  child died before its first token).
- **Confirmed architecturally** — execution is genuinely engine-owned. The lead process hung before
  the first task spawned and never participated again; `ScheduleOnce` and the watchdog drove every
  dispatch, merge and advance from persisted state. `spawnBase` was re-read from project HEAD per
  spawn, so t-4 correctly based on the t-3 merge.
- **New defects** — F22–F26 above, all in the ask protocol and liveness reporting rather than the
  engine.

The DAG's own output was reviewed and fast-forwarded onto `main` on 2026-09-05 (`937c8dfe`), closing
the `reloadChanges` half of the Diff-surface orphans row above.

---

## 3 · Blocked

### Remote/WSL worker host operations

Git surfaces and composer attachments break for SSH/WSL workers because they run on the local host.
Not routable today: agent launch has no connection parameter, `Run`/worktree/`AgentVM` carry no
connection field, and the remote impl doesn't register `GitChangesCommand`/`GitDiffCommand`/
`WriteTempFileCommand`. Prerequisite chain: (1) remote agent launch threading connection through
launch → run → worktree → `AgentVM`; (2) register host-bound commands on `wshremote` (or expose
`wshserver` handlers over the connection route); (3) then route keyed off the agent's connection,
local default. Effort realistically L counting step 1. Full reference design in git history
(pre-consolidation issue 5).

---

## 4 · Held — pick up only on the named trigger

Channel data-model scaling — Phase 3 (Contract) (parked 2026-08-25): revive when a real channel blob is
material (>5 MB or a measured per-event write/broadcast cost) — prod reality check: 4 channels, 680 KB
total. Full rationale + measurement in `docs/deferred.md`; Phases 0–2 shipped.

Reliability investigations (`docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md`):

- **Consult cancellation cleanup (R5): resolved 2026-08-25** — reproduced on Windows (a descendant
  retaining stderr kept `cmd.Wait()` blocked 11s past ctx-kill; +2 goroutines leaked per cancelled
  consult until the descendant exited). Fixed by routing stderr to an owned capped temp file so
  `os/exec` spawns no copy goroutine; regression test `pkg/consult/reap_test.go`.
- **DAG liveness batching (M1):** measured 2026-08-25 — 42.7ms per running task per 30s watchdog tick
  on the real corpus (191 session files); scales linearly (201ms @ 3,060 files; 1.6s @ 30,600). Not
  material today (~0.14% tick duty per task). Build the per-schedule snapshot only when the corpus
  nears ~3,000 files (≈10× today; pi sessions accumulate unboundedly).

Jarvis second-brain smalls (canonical list: J7 in `docs/jarvis-second-brain-open-issues.md`;
rationale per entry in `docs/deferred.md`):

- **U2 Tasks:** in-Wave `## Notes` editing (needs human-region write path + `SetDossierNotesCommand`);
  decision supersede UI (backend `SupersedeDecision` exists, no affordance); manual dossier creation;
  live push.
- **U3 Graph:** search/filter over the graph; read rail; cross-surface nav out of a node; whole-vault
  attribution (bloom is per-focused-task).
- **S2 Recall:** recency-aware semantic seed merge; loosening L4 gating to per-run silence.
- **S1 Embeddings:** warm-at-commit wiring (lazy from `Query` today); settings UI for embed config/key.
- **C Recall:** model-in-the-loop (agentic) traversal — lands with cheap-tier consumers; cache-tier
  learning store — only on repeat-question evidence.
- **E Continuity:** app idle/quit flush (A's quit commit covers it); completed-task prose re-freshness;
  per-task resume card beyond the pet's newest-narrative peek (v2 ambient).

J5 tuning constants (`docs/jarvis-second-brain-open-issues.md` §J5 has the authoritative three-way sort):

- `timeBoxMs` 30d — first layer-3 decay observable ~2026-08-19 onward; then re-probe.
- `weightLayer3` 0.3 — needs a human ground-truth labeling pass over 18 existing structural edges.
- `weightLayer2` 0.8 — needs dispatch goals carrying ticket ids (workflow change, not data collection).
- U3 graph visuals (opacity/width/dash/RUN_SQUARE_SCALE) — dense-vault legibility check; medium branch
  reachable since 2026-08-03 but unexercised.
- Traversal/proactive caps and E/S1 caps — only on a measured latency/relevance/truncation complaint.

Other held items (each names its own revive condition in `docs/deferred.md`):

- **S3 proactive extras:** rest-boundary/conversation-turn triggers; global proactive feed; ranked
  lists; "Ask Jarvis about this" card action. (Auto-promotion to `memory/**` is a v3 boundary, not held.)
- **Pet:** courier gestures (carry/drop-target — build store + gestures together); higher acting tiers
  on the creature; `DRIFT_QUEUE_BAND = 5` refit once queue-depth-over-time is recorded.
- **Jarvis Briefing:** generic cross-project progress needs a Wave-owned workstream/milestone contract
  (identity, lifecycle, update authority, staleness) — its own product/data-model session.
- **Pi Part B:** `wave_create_widget` pi tool + `wsh widget` vdom CLI — when a concrete consumer appears.
- **Incremental stateful transcript projection** — only if the capped bounded re-project profiles hot
  (CDP/React-DevTools pass against a populated cockpit first).
- **Attribution engine D (v2)** real ambient edges to replace `fixtureAmbientProvider` behind the
  unchanged `AmbientProvider` interface.

---

## 5 · Declined / permanent limitations (do not resurface)

- Cockpit light/Paper theme — declined; code removed 2026-08-24 (`docs/deferred.md`).
- Gatekeeper v1.1 (make-a-rule + countdown) — revive only on recurring-ask or misfire evidence.
- Arc Environment capability — restore via `git show 4e80bf4f:docs/environment-roadmap.md` if needed.
- Agents-tab fit-one-screen density engine — obsolete, un-executable against the card grid.
- Diff-surface narrow-window folding + row-density variants — revive only on a narrow-window user.
- Rate-limit token *cap* and plan-tier badge — no honest Anthropic-side source.
- Codex/OpenAI 5h-window bars — Codex has no such window.
- Codex subagents + depth>1 subagent nesting — no per-subagent files exist; closed no-go.
- Usage pricing family-substring drift (historical Opus billed at current tier) — accepted estimate error.
- v3 embedding boundary: multimodal/image embeddings, reranking models, bundled local model, auto-
  promotion to `memory/**`, cross-machine sync.

---

## Held redesigns needing live verify or a decision (scan brief 2026-07-21)

E8 connserver readiness handshake (patch saved, needs live SSH/WSL verify — also gated on the remote
launch prerequisite above); E15 favicon blockstore; E16 pty input loop; E2 `ink-*` token swap (not 1:1);
E4 list-reflow motion (was in progress). Source:
`docs/superpowers/briefs/2026-07-21-open-ended-improvement-scan-brief.md` — treat that brief's tables as
a historical snapshot; its Status section records what already shipped.
