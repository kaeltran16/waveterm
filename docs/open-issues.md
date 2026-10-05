# Open issues — consolidated backlog

**This file is the single "what's left" list.** `docs/deferred.md` holds the why; this file holds the
what. New deferrals get their full entry appended to `docs/deferred.md`, then a one-line row here.

Pruned 2026-10-05: every row was re-checked against git and the closed ones removed (the shipped
orchestrator rows F11–F26, the closed scans, the Jarvis Brief B5 table, the recall-arm held items).
Recover the pre-prune list with `git show c99f2041:docs/open-issues.md`. The orchestrator flaw history
(F1–F26) stays in `docs/orchestrator-redesign-flaws.md`.

The actionable rows are tracked as chunks of `effort:c732b933-f976-4263-b191-fd95454c3d84`
(`wsh effort show c732b933-f976-4263-b191-fd95454c3d84`). Tick the chunk and delete the row together.

Status legend:

- **Actionable** — can be picked up as-is.
- **Blocked** — cannot start until a prerequisite exists.
- **Held** — deliberately deferred pending a named trigger or evidence; do not build off the spec alone.
- **Declined** — decided against; do not resurface.

---

## 1 · Actionable

| Item | Kind | Effort | Source / notes |
|---|---|---|---|
| Route picker offers routes the account cannot run (F14) — the backend rejects at `runroute.go`, the picker still lists them | bug | M | flaws tracker F14. Deliberately not fixed 2026-09-04: entitlement is not statically knowable, and a probe costs a process spawn per launch and goes stale. The durable fix is catalog-backed resolution at spawn, where ctx is available. A dead route now fails in seconds with the provider's own message |
| A lead's terminal pane can render blank while the backend holds its full output | bug | M | Seen once, 2026-09-21, on a lead launched into a freshly restarted dev app: `wavesrv` held 32 KB of scrollback for the block (`filestore.db`, `db_file_data`, `name='term'`) and resizing did not repaint. Cause unknown (backlog not fed on attach, reattach ordering, or a block created mid-restart). Needs a repro first |
| Diff surface repository actions (Spec B): checkout, cherry-pick, revert — needs its own spec before any code | decision | M | `docs/deferred.md` 2026-09-04 entry. `GitRevertCommand` / `gitinfo.RevertFile` / `gitinfo.RevertHunk` are tested and still have no caller (checked 2026-10-05); Spec B decides whether they are its starting point or get deleted |

Tracked in their own initiatives, not here:

- **Arc Claude mod live verify** (usage strip, card answer, Esc, dag child ask, settings hooks) — effort `99832658`, chunk 9.
- **Orchestrator wall-clock** — effort `b1fe5d7e`: live-verify the unit-tested fixes, the round-2 final tree lock, the Timing section live check.

---

## 2 · Blocked

### Remote/WSL worker host operations

Git surfaces break for SSH/WSL workers because they run on the local host. Not routable today: agent
launch has no connection parameter, `Run`/worktree/`AgentVM` carry no connection field, and the remote
impl doesn't register `GitChangesCommand`/`GitDiffCommand`. Prerequisite chain: (1) remote agent launch
threading connection through launch → run → worktree → `AgentVM`; (2) register host-bound commands on
`wshremote` (or expose `wshserver` handlers over the connection route); (3) then route keyed off the
agent's connection, local default. Effort realistically L counting step 1. Full reference design in git
history (pre-consolidation issue 5). The E8 connserver readiness handshake (patch saved, needs a live
SSH/WSL verify) rides on step 1.

---

## 3 · Held — pick up only on the named trigger

Each names its revive condition in `docs/deferred.md` unless a source is given.

Cockpit and surfaces:

- **OS/taskbar badge when Arc is backgrounded** — the in-app counter ships and nothing reaches you
  cross-app. Measure first that it is missed (`badge.ts`, `navrail.tsx`).
- **Sessions "All activity" rows peeking a run, agent or initiative** (2026-10-01) — revive when a row
  carries a target; wire it through `openOrPeek`.
- **Terminal file drop → pasted path** (2026-09-30) — needs Tauri's `dragDropEnabled`, which disables
  HTML5 drag app-wide.
- **Work on an initiative — "Save place and close"** (2026-09-29) — revive when losing a session's place
  recurs.
- **Run recovery after a restart — New Agent sessions** (2026-09-30) — revive when a session is seen
  re-running its launch prompt.
- **Cockpit focus, slice 2 and beyond** (2026-09-22) — relationship annotation, companion split, time
  correlation, drag courier, Jarvis and Usage focus support.
- **Resource linking beyond navigation** (2026-09-17) — Related Work, the Work Trail strip, structured
  refs, file/diff/commit/session targets, a shared action builder, usage-to-work links.
- **Cross-surface Back history and its context strip** (2026-09-17) — parked as `09e86573` on
  `feat/surface-integration`; keep the branch while this is open.
- **Composer attachments** (2026-09-18) — revive when attaching a file to a goal or steer is wanted.
- **Diff surface: hiding whitespace-only files from the change list** (2026-09-11).
- **Incremental stateful transcript projection** — only if the capped re-project profiles hot (CDP /
  React-DevTools pass against a populated cockpit first).

Orchestrator:

- **Cross-run Verify hold under `--landing checkout`** (2026-09-15) — one run's failed Verify does not
  hold another run's merges in the same checkout. Branch landing, the default, is unaffected.
- **Lead-authored task routing, Phase 4** (2026-09-17) — the cost/outcome measurement gate. Revive on
  evidence that cheap-first routing waste is common.
- **Channel data-model scaling, Phase 3 (Contract)** (2026-08-25) — revive when a channel blob is
  material (>5 MB, or a measured per-event write/broadcast cost). Prod check: 4 channels, 680 KB.
  Two readers still take the embedded arrays off the `channelsAtom` snapshot and move first:
  `cockpitsurface.tsx` (`answeredAskIdsAcross`) and `briefpeekview.tsx` (`fleetForRecord`).
- **DAG liveness batching (M1)** — 42.7 ms per running task per 30 s tick on 191 session files; build
  the per-schedule snapshot only when the corpus nears ~3,000 files.
- **Automated board rendering** for the final verifier — revive when a verdict misses a layout defect a
  rendered board would have caught (spec `docs/superpowers/specs/2026-09-25-orchestrator-findings-fixes-design.md` §5).
- **A cheap-model route for judging sessions** — revive when the judging roles are a material share of
  a run's tokens (same spec).
- **An idle-lead watchdog after the dag is done** — revive on a run whose lead sat idle at `run
  finished` without completing (same spec).

Jarvis (what survived the 2026-09-22/23 memory and recall-arm removals):

- **U2 Tasks:** in-Wave `## Notes` editing; decision supersede UI (backend `SupersedeDecision` exists);
  manual dossier creation; live push.
- **U3 Graph:** search/filter; read rail; cross-surface nav out of a node; whole-vault attribution; the
  visual constants (opacity/width/dash/`RUN_SQUARE_SCALE`) want a dense-vault legibility check.
- **E Continuity:** a cheap model tier for boundary summaries; completed-task prose re-freshness; a
  per-task resume card beyond the pet's newest-narrative peek.
- **D attribution tuning:** `timeBoxMs` 30d, `weightLayer3` 0.3 (needs a human ground-truth pass),
  `weightLayer2` 0.8 (needs dispatch goals carrying ticket ids).
- **Jarvis Briefing:** generic cross-project progress needs a Wave-owned workstream/milestone contract —
  its own product/data-model session.
- **Pet:** courier gestures (build the store and the gestures together); higher acting tiers.
- **Pi Part B:** `wave_create_widget` pi tool + `wsh widget` vdom CLI — when a concrete consumer appears.

---

## 4 · Declined / permanent limitations (do not resurface)

- Cockpit light/Paper theme — declined; code removed 2026-08-24 (`docs/deferred.md`).
- Gatekeeper v1.1 (make-a-rule + countdown) — revive only on recurring-ask or misfire evidence.
- Arc Environment capability — restore via `git show 4e80bf4f:docs/environment-roadmap.md` if needed.
- Agents-tab fit-one-screen density engine — obsolete, un-executable against the card grid.
- Diff-surface row-density variants and the rest of the narrow-window cascade — the commit column fold
  shipped (`19d324e5`); the rest only on a narrow-window user.
- Rate-limit token *cap* and plan-tier badge — no honest Anthropic-side source.
- Codex/OpenAI 5h-window bars — Codex has no such window.
- Codex subagents + depth>1 subagent nesting — no per-subagent files exist; closed no-go.
- Usage pricing family-substring drift (historical Opus billed at current tier) — accepted estimate error.
- Codex and opencode as run workers — declined 2026-09-17: this install only uses claude and pi.
  Recovery path: `docs/deferred.md` 2026-09-14 entry.
- Final stage: persisting a verifier's verdict held during Checking — declined 2026-09-30.
- The memory subsystem and the Jarvis recall arm (Ask, proactive cards, embeddings) — removed
  2026-09-22/23 on measured usage. Revive only on evidence that note bodies, not index lines, change an
  agent's behaviour (`docs/deferred.md`).
