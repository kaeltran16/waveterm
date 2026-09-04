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

---

## 2 · Actionable smalls

The reliability findings below are ranked and detailed in
`docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md`; no implementation is approved yet.

| Item | Kind | Effort | Source / notes |
|---|---|---|---|
| Issue 8 deep-link fix was never reproduced live (unit-tested only) — verify with a focused agent + dirty worktree | verification gap | S | pre-consolidation issue 8 detail (in git history); fixed 2026-08-04 |
| OS/dock/titlebar badge when Arc is backgrounded (in-app counter ships; nothing reaches you cross-app) — measure-first | feature | M | scan brief B2; `badge.ts`, `navrail.tsx` |
| Diff-surface orphans: `GitRevertCommand` / `gitinfo.RevertFile` / `gitinfo.RevertHunk` / `filesstore.reloadChanges` have no caller — delete both together or neither | tech-debt | S | `docs/deferred.md` 2026-07-31 entry. **2026-09-04:** `reloadChanges` should be split from the revert three — the surface reads its change list on mount and never again, so a file edited while on screen keeps stale counts, and this is the refresh that gap wants |
| Files-surface CDP visual pass (plan Task 9, deferred while :9222 was occupied) | verification | S | `docs/deferred.md` Files-surface entry |
| `MaxDagTasks` has no path for a plan larger than the cap — a 17-task plan hard-fails at import with no split path, and the natural workaround (two DAG phases) is blocked by F12 | bug | S | flaws tracker F11; the cap was raised 8 → 16, the structural gap stands |
| One run holds exactly one DAG, stated nowhere — `CreateDagForRun` returns the *existing* dag and a differing proposal fails `dag conflict`; nothing in the prompt, CLI help or error text says so, so a lead confidently recommends a dead-end shape and a human discovers it eight tasks later | bug | S | flaws tracker F12; `wstore_dag.go:88`, `wshserver_dag.go:91` |
| No first-token deadline: a lead that dies on its first model call is indistinguishable from one that is thinking | bug | M | flaws tracker F13 + R10 addendum; nothing in `pkg/` implements one (verified 2026-09-04) |
| Route picker offers routes the account cannot run — the backend rejects at `runroute.go:79`, the picker still lists them as selectable | bug | S | flaws tracker F14 |
| `import-tasks` hardcodes `parallelism: 2` with no flag | tech-debt | S | flaws tracker F15; `wshcmd-jarvisdag.go:109` |
| Merge gate has no liveness and no age — the gate now *opens* correctly (F19), but a lead that ignores it leaves it sitting silently with nothing escalating | bug | M | flaws tracker F16 + R10; verified 2026-09-04, no merge-gate age exists in `pkg/orchestrate` |

**F11–F17 were never mirrored here (noted 2026-09-04).** They were filed in
`docs/orchestrator-redesign-flaws.md` Capture 2 and stayed there, so this list — which calls itself
the single "what's left" list — showed orchestration as closed while seven flaws were open. The six
rows above are that omission corrected, each re-verified against the code rather than copied. **F17**
(`runtime` silently forking between two orchestrators) is deliberately *not* among them: the fork is
now an explicit `orchestration` parameter documented at `run.go:377`, so only the runtime-based
*default* remains and the "silent" complaint is answered — it is a close-out review, not a fix.

### Shipped 2026-09-04 — do not re-file

Ten rows left this table in one batch. Recorded here with pointers because several were filed twice
before (a fixed bug with a vivid repro note reads like an open one). Each fix is unit-tested; the
"live" column says whether it was also confirmed in the running app over CDP.

| Was | Fix | Live |
|---|---|---|
| Flat DAG never opened the merge gate — `dag wait` returned `terminal:healthy` with children unmerged | `d966c27e`: `buildNext` reports `merge-ready` whenever `mergeReadyIDs` is non-empty, ranked below dispatch and parallelism-wait so a DAG that can still spawn is never reported as needing the lead | no — needs a live DAG run |
| `buildNext` fell through to a bare `terminal` on a running DAG with cleanup pending (F19) | `d966c27e`: the fall-through is now a typed `cleanup-wait` step, never terminal — the lead's stop signal is the only terminal kind. Named in the FE by `75738bfb` | no |
| Engine prompt said act "when the digest reports `merge`"; the digest says `merge-ready` / `resolve-merge` (F20) | `d966c27e`: prompt uses the digest's own words (`pkg/jarvis/run.go`) | no |
| `dagDigestChildRunLimit = 8` not raised with `MaxDagTasks = 16` (F21) | `d966c27e`: the constant now follows `jarvis.MaxDagTasks` | no |
| Every non-pi DAG child flagged **stalled** at 15 min regardless of progress; `retry` then killed healthy work (F18) | `3ca9cd6d`: liveness reads pi, claude and codex transcript roots via `agentsessions.SessionRoot`. A runtime with **no** readable activity source now reports freshness *unknown* rather than aging into a false stall — a missed stall costs a timeout, a false one kills a working child. `opencode` is deliberately untracked (cwd lives only in a sidecar file; rewrite behaviour unverified) | no |
| A `claude` worker in a never-opened directory blocked forever on the folder-trust dialog | `50cdc2d8`: `ensureClaudeDirTrusted` pre-registers the directory under Claude's own canonical-git-root key and lock protocol before spawn. Writes at most one entry per project, never per worktree | no — needs an untrusted dir |
| Engine `dag merge` not idempotent on a Windows worktree-lock failure | `851511a5`: worktree removal is the caller's step, so a cleanup failure cannot obscure a landed merge; an already-merged branch returns HEAD instead of re-merging | no |
| Pure rename rendered as the whole file added while the list beside it said `+0 −0` | `cd9cb5c8`: `pathDiff` asks the rename-source question **only** when a path-scoped read reports `new file mode`, then re-reads with both paths | **yes** — `R100` fixture renders *Renamed.* with `+0 −0` |
| Compare-mode summary printed the working tree's counts under the compare's ref names, refs reversed vs. the chip | `cd9cb5c8`: `summaryLine` picks the store the panes are showing; picker and chip print `base … head` | **yes** — `main … feat · 3 files · +30 −0` against a dirty tree |
| Hints footer never recomputed on compare/filter changes, advertising keys that did something else | `7807aa93` + `2ed1cc85`: `whenVersionAtom` counter over the 10 atoms the predicates read, plus a `store.test.ts` guard that fails when a predicate reads an unregistered atom | **yes** — 11 chips → 3 on toggle, no focus change |

The three unverified-live engine fixes all need a real orchestrator DAG run; that is the remaining
gap on this batch, not a known defect.

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
