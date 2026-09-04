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

### 2026-08-26 orchestrator gaps scan — remaining findings (G1–G7)

Read-only scan of the shipped phase-2 engine, child-ask lifecycle, lead CLI, and DAG graph FE
(`docs/superpowers/briefs/2026-08-26-orchestrator-gaps-scan.md`). Sequencing deliberately not decided in
the brief; each fix batch gets its own spec/plan. Severity in parens; G6 deferred as design work.

- **G1** (S): `dag sendback` reopens a done gate to `Running` with no RunID; the scheduler never
  respawns a `Running` task (deadlock, one parallelism slot leaked, status silently `running`).
  Direction: `SendBackGate` should return to `Pending` like `RetryTask`. The unit test codifies the bad
  state (`scheduler_test.go`).
- **G2** (S, policy): auto-retried flakes still increment `g.Failures` toward `MaxConsecutiveFailures=3`
  even after a clean success; decide whether a retry's success should clear the streak.
- **G4** (M): `MergeContinue` has no callers — blocked-merge (`dag merge --continue`) is a dead end; the
  FE's only action maps to `resolve`, rejected by the backend. Wire the verb + FE mapping.
- **G5** (S): a successful merge stamps no merged marker, so the Merge button persists and re-runs a
  failing merge. Stamp a `Merged` marker on the task and key the FE action off it.
- **G6** (low, deferred as design): lead control notifications are fire-and-forget with no delivery ack.
- **G7** (low): `dag status` dumps raw JSON with no per-task health/age/ask summary (the R4 intent).

---

## 2 · Actionable smalls

The reliability findings below are ranked and detailed in
`docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md`; no implementation is approved yet.

| Item | Kind | Effort | Source / notes |
|---|---|---|---|
| Issue 8 deep-link fix was never reproduced live (unit-tested only) — verify with a focused agent + dirty worktree | verification gap | S | pre-consolidation issue 8 detail (in git history); fixed 2026-08-04 |
| OS/dock/titlebar badge when Arc is backgrounded (in-app counter ships; nothing reaches you cross-app) — measure-first | feature | M | scan brief B2; `badge.ts`, `navrail.tsx` |
| Diff-surface orphans: `GitRevertCommand` / `gitinfo.RevertFile` / `gitinfo.RevertHunk` / `filesstore.reloadChanges` have no caller — delete both together or neither | tech-debt | S | `docs/deferred.md` 2026-07-31 entry |
| Files-surface CDP visual pass (plan Task 9, deferred while :9222 was occupied) | verification | S | `docs/deferred.md` Files-surface entry |
| Engine dag-merge not idempotent on Windows worktree-lock failure; a landed merge can leave the task permanently unmarked `merged` | bug | S | observed 2026-08-27 on an orchestrator run; see note below |
| On a **flat** DAG the merge gate never reports `merge-ready`, so `dag wait` tells the lead to stop with children unmerged | bug | S | observed 2026-09-04 on the claude-lead e2e; `docs/jarvis-claude-lead-e2e.md` §6; see note below |
| A `claude` run worker in a never-before-opened directory blocks forever on Claude Code's folder-trust dialog — `--dangerously-skip-permissions` covers tool prompts only, not first-run directory trust | bug | S | observed 2026-09-04, same e2e; `docs/jarvis-claude-lead-e2e.md` §7; worker is alive-but-idle with no signal |

**Dag-merge idempotency gap (2026-08-27):** `DagMergeCommand` → `MergeRunWorktree` runs `git merge --squash` + `commit`, then `RemoveRunWorktree`. On Windows, `git worktree remove` can fail on a dir still locked by the idle child shell (and junctioned `node_modules`/`src-tauri/target`/`dist/bin` from `task worktree:prepare` make removal flaky). When removal fails the command errors out **before** the `UpdateRun(EndCommit)` / `UpdateDag(Merged)` / `SealEvidence` steps — the squash commit is already on `main`, but the DAG task stays `done`/unmerged forever. Re-running `dag merge` then fails with “nothing to commit”, so there is no redo path; the lead has to stamp `merged` + `EndCommit` manually in the wstore. Fix direction: make the command idempotent (if the branch is already fully merged, skip the git work, still write `Merged`/`EndCommit` and seal evidence), treat an unregistered-but-locked worktree dir as already removed, and/or derive the merge action from `git rev-list main..branch` being empty instead of from the removal outcome. Minor trailing issue: the merge commit message embeds the entire child task description rather than just the task label (noise in `git log`).

**Flat-DAG merge gate never opens (2026-09-04):** on a DAG where no task has dependencies, `dag wait` returns `woke: terminal:healthy` at the merge gate instead of `woke: action:merge-ready` — a stop signal, while every child sits unmerged. `buildNext` (`pkg/orchestrate/digest.go:292`) gates its `merge-ready` branch on `mergeReadyBlocking(g)`, which returns *pending tasks whose dep chain reaches a merge-ready task*. A flat DAG has no pending tasks, so the branch never fires even though `mergeReadyIDs(g)` would return every finished task; `buildNext` falls through to the terminal default and, since `g.Status` is still `running`, returns a bare `DagNextStep{Kind: "terminal"}` with an empty `TerminalStatus`. `waitDecision` (`cmd/wsh/cmd/wshcmd-jarvisdag.go`) then treats any `Kind == "terminal"` as terminal and substitutes `d.Health`, producing the nonsense reason `terminal:healthy`. The lead's prompt says "Stop when it reports a line beginning `woke: terminal:`", so a literal lead strands the work — the observed run only completed because the model ignored the signal, ran `dag status`, and merged anyway. Fix direction: report `merge-ready` + `resolve-merge` whenever `mergeReadyIDs(g)` is non-empty, not only when a successor is blocked. **Do not "fix" `waitDecision` alone** — if it stops treating a bare `terminal` as terminal, a flat DAG reports neither an action nor a terminal state and the lead blocks forever, which is worse. `TestWaitDecision` passes and stays correct; it only covers well-formed digests, never `Kind: "terminal"` with an empty status on a running DAG.

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
