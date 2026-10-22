# Open issues — consolidated backlog

**This file is the single "what's left" list.** `docs/deferred.md` holds the why; this file holds the
what. New deferrals get their full entry appended to `docs/deferred.md`, then a one-line row here.

Pruned 2026-10-05: every row was re-checked against git and the closed ones removed (the shipped
orchestrator rows F11–F26, the closed scans, the Jarvis Brief B5 table, the recall-arm held items).
Recover the pre-prune list with `git show c99f2041:docs/open-issues.md`. The orchestrator flaw history
(F1–F26) stays in `docs/orchestrator-redesign-flaws.md`.

The rows of that prune were worked as chunks of `effort:c732b933-f976-4263-b191-fd95454c3d84`, archived
2026-10-06 with nothing actionable left (`wsh effort show c732b933-f976-4263-b191-fd95454c3d84`).

Status legend:

- **Actionable** — can be picked up as-is.
- **Blocked** — cannot start until a prerequisite exists.
- **Held** — deliberately deferred pending a named trigger or evidence; do not build off the spec alone.
- **Declined** — decided against; do not resurface.

---

## 1 · Actionable

- **`final-stage` CDP scenario, Part B flakes** (2026-10-12). B2–B6 failed in 2 of 3 runs after the lead's
  Final verification block was removed from the details rail, and passed in 2 runs without that change
  (one of which failed only B6). The failing shape: in B2 the DAG modal's final node still reads the B1
  state ("waits on every task") while the tree's row shows Tree running, and from B3 on the stage row has
  lost focus (no pane). That change touches neither the modal nor focus, so the cause is unproven either
  way. Repro: `ARC_FINAL_OUT=<dir> node scripts/cdp/final-verify.mjs final-stage`, a few runs.

Tracked in their own initiatives, not here:

- **Orchestrator wall-clock** — effort `b1fe5d7e`: live-verify the unit-tested fixes, the round-2 final tree lock, the Timing section live check.

---

## 2 · Blocked

Nothing blocked.

---

## 3 · Held — pick up only on the named trigger

Each names its revive condition in `docs/deferred.md` unless a source is given.

Cockpit and surfaces:

- **Work on an initiative — "Save place and close"** (2026-09-29) — revive when losing a session's place
  recurs.
- **Run recovery after a restart — New Agent sessions** (2026-09-30) — revive when a session is seen
  re-running its launch prompt.
- **A lead's terminal pane rendering blank while the backend holds its output** (2026-10-05) — seen once,
  2026-09-21, on a lead launched into a freshly restarted dev app: `wavesrv` held 32 KB of scrollback
  (`filestore.db`, `db_file_data`, `name='term'`) and resizing did not repaint. Never reproduced. Revive
  when it is seen again: note the block id and keep `waveapp.log` before touching the pane. No repro
  loop exists, because nothing exposes the xterm buffer to CDP.
- **Session target in `openTarget`** (2026-09-17) — revive when opening a session from a Usage session
  page is wanted.
- **Builder check end to end, with a real reviewer** (2026-10-22) — revive when the reviewer's prompt
  or route chain changes, or a check hangs or returns nothing on a real project.
- **Sessions "All activity" feed peek** (2026-10-01) — revive when the feed rows carry a run, agent or
  effort target.
- **Incremental stateful transcript projection** — only if the capped re-project profiles hot (CDP /
  React-DevTools pass against a populated cockpit first).

Orchestrator:

- **Cross-run Verify hold under `--landing checkout`** (2026-09-15) — one run's failed Verify does not
  hold another run's merges in the same checkout. Branch landing, the default, is unaffected.
- **DAG liveness batching (M1)** — 42.7 ms per running task per 30 s tick on 191 session files; build
  the per-schedule snapshot only when the corpus nears ~3,000 files.
- **Automated board rendering** for the final verifier — revive when a verdict misses a layout defect a
  rendered board would have caught (spec `docs/superpowers/specs/2026-09-25-orchestrator-findings-fixes-design.md` §5).
- **A cheap-model route for judging sessions** — revive when the judging roles are a material share of
  a run's tokens (same spec).
- **An idle-lead watchdog after the dag is done** — revive on a run whose lead sat idle at `run
  finished` without completing (same spec). Measured 2026-10-21 on the packaged store: of 82 `dag-done`
  runs, 80 completed within 30 min; the one 13 h gap (`3425249d`) was a lead adding a task after `run
  finished`, not idling.

Memory hygiene:

- **Pi and Codex memory, merges across batches, a retention score / LRU ordering** (2026-10-14) — each
  with its own revive condition in `docs/deferred.md`.

Jarvis:

- **A per-task resume card** beyond the pet's newest-narrative peek — when an ambient surface wants it.

---

## 4 · Declined / permanent limitations (do not resurface)

- Declined 2026-10-16 after weeks held with no trigger (`docs/deferred.md` "Declined 2026-10-16" has the
  recovery lines): the cockpit-focus remnants (relationship annotation, companion split, time correlation,
  drag courier); pet courier gestures and higher acting tiers; resource linking beyond navigation;
  cross-surface Back and its context strip (branch `feat/surface-integration` kept); Diff repository actions;
  Diff hiding whitespace-only files; lead-authored routing Phase 4; Jarvis U2 Tasks editing and U3 graph
  follow-ups.
- Dropped 2026-10-16 as superseded or unpluggable: Jarvis Briefing cross-project progress (efforts carry
  done/total), Jarvis D attribution tuning and E's cheap tier (their consumers, proactive resurfacing and
  recall, are gone), Pi Part B `wave_create_widget` (the vdom commands it wrapped no longer exist).
- File drop (onto a terminal, onto the New run goal) and Steer attachments — declined 2026-10-21: files
  reach an agent by paste, which the terminal and the goal already handle (`docs/deferred.md`).
- Remote/WSL worker host operations (git surfaces for SSH/WSL agents, and the E8 connserver readiness
  handshake that rode on it) — declined 2026-10-21: agents here run on the local host. The design was
  pre-consolidation issue 5: `git show c99f2041:docs/open-issues.md`.
- Cockpit light/Paper theme — declined; code removed 2026-08-24.
- Gatekeeper v1.1 (make-a-rule + countdown) — revive only on recurring-ask or misfire evidence. Measured
  2026-10-12 over 879 structured asks since 08-11: 737 distinct headers, and the ones that recur (spec
  review, scope, plan review, commit) are approval gates, not routine asks a rule could answer.
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
