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

### Channel data-model scaling — Phase 3 (Contract)

The repo's biggest remaining backend item. Split `Messages`/`Runs` out of the channel blob into indexed
rows + read pool, as reversible expand → migrate → contract phases; A1/A2's write/broadcast payoff lands
only at Phase 3. Phase 0 (read pool) shipped; Phase 1 (Expand) was the active work as of 2026-07-22.
Spec: `docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md`. Source: improvement-scan
brief Theme A.

### Lead-authored task routing — Phases 1–3

Draft roadmap (2026-08-19, awaiting review), nothing built yet. Phase 1: `RunSpec.Model` +
harness↔model capability matrix + spawn passthrough. Phase 2: same-tier retry + typed `blocked` +
explicit `wsh jarvis dag escalate` verb. Phase 3: route surfaced in DAG graph + run evidence. Phase 4
(measurement gate) is evidence-gated and may be skipped entirely.
Doc: `docs/lead-authored-task-routing-roadmap.md`.

### Orchestrator redesign plan — 27 unchecked steps

`docs/superpowers/plans/2026-08-16-orchestrator-redesign.md` — headless-child contract +
child-ask forwarding. Not a hard prerequisite for task routing but improves the lead↔worker relationship
it piggybacks on; sequence the two to avoid collisions.

### 2026-08-24 orchestrator improvement scan — untriaged findings

Fresh read-only scans of `pkg/orchestrate`, lead-side `pkg/jarvis`, the `wsh jarvis dag` CLI, and the
Jarvis surface. Sequencing deliberately undecided; each fix batch needs its own spec/plan. Includes at
least one hand-verified blocker (**O1**: `dag merge` targets the wrong branch, so child work cannot land).
File: `docs/superpowers/briefs/2026-08-24-jarvis-orchestrator-improvement-scan.md`.

---

## 2 · Actionable smalls

The reliability findings below are ranked and detailed in
`docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md`; no implementation is approved yet.

| Item | Kind | Effort | Source / notes |
|---|---|---|---|
| **DAG merge blocker:** make merge task-targeted so an isolated child's composite worktree branch can land | correctness / delivery | M | reliability scan R1; 2026-08-24 scan O1 |
| **DAG scheduler safety batch:** stalled tasks consume slots; retry preserves the global failure streak; gate actions target one task; watchdog survives a panicking tick | correctness / reliability | S–M | reliability scan R3; 2026-08-24 scan O2/O3/O5/O6 |
| Serialize config-watcher callbacks and make watcher initialization failure explicit instead of allowing out-of-order updates, a callback race, and a poisoned nil singleton | reliability / concurrency | M | reliability scan R2; `pkg/wconfig/filewatcher.go` |
| Make websocket RPC forwarding cancellation-aware so a full output channel cannot retain the goroutine after disconnect | reliability / cleanup | S | reliability scan R4; `pkg/web/ws.go` |
| Issue 8 deep-link fix was never reproduced live (unit-tested only) — verify with a focused agent + dirty worktree | verification gap | S | pre-consolidation issue 8 detail (in git history); fixed 2026-08-04 |
| OS/dock/titlebar badge when Arc is backgrounded (in-app counter ships; nothing reaches you cross-app) — measure-first | feature | M | scan brief B2; `badge.ts`, `navrail.tsx` |
| Diff-surface orphans: `GitRevertCommand` / `gitinfo.RevertFile` / `gitinfo.RevertHunk` / `filesstore.reloadChanges` have no caller — delete both together or neither | tech-debt | S | `docs/deferred.md` 2026-07-31 entry |
| Files-surface CDP visual pass (plan Task 9, deferred while :9222 was occupied) | verification | S | `docs/deferred.md` Files-surface entry |

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

Reliability investigations (`docs/superpowers/briefs/2026-08-25-reliability-improvement-scan.md`):

- **Consult cancellation cleanup (R5):** reproduce on Windows with a descendant retaining stderr after
  parent cancellation; build process-tree termination or owned-file stderr capture only if the reaper stays
  blocked.
- **DAG liveness batching (M1):** instrument task count, session files visited, bytes opened, and tick time;
  build a per-schedule snapshot only if the current task × transcript-corpus scan is material.

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
