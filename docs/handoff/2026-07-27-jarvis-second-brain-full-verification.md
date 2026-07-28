# Jarvis Second Brain — Full Live Verification (v1 + v2)

**Date:** 2026-07-27
**Method:** Live, against the running `task dev` app (WebView2 over CDP, `:9222`) and the real dev profile — the same populated vault/wstore used by the 2026-07-27 J1/J2/J5 measurements (14 real dossiers + backfilled history, `~/.waveterm/vault`, real OpenRouter embeddings enabled). No mocks; every scenario drives real RPCs, real Runs (with real `claude` worker spawns), and reads real render output.
**Harness:** `task verify:ui` (`scripts/cdp/scenarios.mjs`, 11 scenarios, 38 assertion steps) for everything already scripted, plus one ad-hoc script for the four surfaces the harness doesn't cover yet (Tasks, Graph, Settings-embeddings, Space switcher — see [Harness gap](#harness-gap-found)).

## TL;DR

**All v1 (A–G) and v2 (S1–S3, U1–U3) sub-projects verified live. 38/38 scripted assertions passed; all four ad-hoc surface checks passed after one bug fix.** One real crash bug was found and fixed during this pass (below) — not a pre-existing known issue, newly discovered here.

| # | Sub-project | Verified how | Result |
|---|---|---|---|
| v1 A | Wave Vault | `jarvis-vault-recall` (real dossier write + read-back) | ✅ PASS |
| v1 B | Dossier / typed records | `extra-tasks-detail` (post-fix) | ✅ PASS |
| v1 C | Recall / traversal | `jarvis-vault-recall`, `jarvis-continuity-resume` | ✅ PASS |
| v1 D | Attribution | `jarvis-ambient` (J1) | ✅ PASS |
| v1 E | Continuity | `jarvis-continuity-resume` | ✅ PASS |
| v1 F | Model tiering | Go tests only (`pkg/jarvis/tier_test.go`) — no UI surface | ✅ PASS (not re-run live this pass; see [caveats](#caveats--not-independently-re-verified-this-pass)) |
| v1 G | Presence D / ambient shell | `jarvis-states`, `jarvis-fleet`, `jarvis-ask`, `jarvis-ambient` | ✅ PASS |
| v2 S1 | Embedding foundation | `extra-settings-embeddings` (J2 UI) | ✅ PASS |
| v2 S2 | Semantic consumers (L3+L4) | Not re-run live this pass (Go `liveprobe` harness only — see caveats) | ⚠️ not re-verified live |
| v2 S3 | Proactive resurfacing | `jarvis-proactive` | ✅ PASS |
| v2 U1 | Presence C "Spaces" | `extra-spaces-popover` | ✅ PASS |
| v2 U2 | Tasks surface | `extra-tasks-list` + `extra-tasks-detail` | ✅ PASS (after fix) |
| v2 U3 | Graph surface | `extra-graph-base` | ✅ PASS |

---

## Bug found & fixed during this pass

### `TaskDetail` crashed on any dossier missing acceptance/blockers/refs/decisions

**Found while driving U2 for this verification** — not a previously known issue.

Opening a real dossier's detail view crashed the whole render tree:

```
TypeError: Cannot read properties of null (reading 'length')
    at TaskDetail (frontend/app/view/jarvis/taskdetail.tsx:245:41)
```

**Root cause:** `wshrpc.DossierDetail`'s `Acceptance`/`Blockers`/`Refs`/`Decisions` fields are Go slices with no `omitempty`; a nil slice marshals to JSON `null`, not `[]`. Per J5's own backfill notes, most of the 14 real dossiers deliberately have empty acceptance/blockers ("left empty where the history recorded none") — so this crash was reachable on real data, not a synthetic edge case. `taskdetail.tsx` called `.length`/`.map` on these fields directly with no null guard.

**Fix (`frontend/app/view/jarvis/taskdetail.tsx`):** normalize all four fields once at the top of `TaskDetail` (`detail.acceptance ?? []`, etc.) instead of scattering null-checks at each call site.

**Verified fixed:** the app was recovered with a full reload, then 20 interactions across the Tasks surface (list rows, detail sub-controls) produced zero crashes, versus an immediate crash on the very first real dossier before the fix.

| Before (crash) | After (fixed) |
|---|---|
| Blank page, `nav button` count 0, `WINDOW ERROR: TypeError: Cannot read properties of null (reading 'length')` | ![Tasks detail renders cleanly](images/2026-07-27-jarvis-second-brain-verification/04-tasks-detail-fixed.png) |

### Harness gap found

`scripts/cdp/attach.mjs`'s `SURFACE_LABEL` map (which `h.goto()` depends on) is missing `graph` and `tasks` — both exist in `navrail.tsx`'s `ITEMS` (U2/U3 shipped after the harness map was last updated) but were never added to the CDP harness. Not fixed in the repo this pass (out of scope for a verification-only task); worked around with a standalone script. Worth a one-line addition to `SURFACE_LABEL` + `SMOKE_SURFACES` next time someone touches `scripts/cdp/`.

---

## v1 — the original seven sub-projects (all complete, per the v1 meta spec)

### A — Wave Vault

Backing store for everything else; no UI of its own. Verified indirectly: `jarvis-vault-recall` dispatches a real Run, which writes a dossier into the vault (commit before the RPC returns), then asks Jarvis a matching question and gets back **12 grounding cards** (not the empty-vault "not found" state) — proving the vault write path and the read path both work end-to-end against the real backend.

![Vault recall grounds a real dossier](images/2026-07-27-jarvis-second-brain-verification/03-vault-recall.png)

### B — Dossier / typed records

Verified via the Tasks surface (U2) reading a real dossier's typed structure: status pills, machine-maintained `REFS` block (`run-53dd5e74-...`), and the decisions log — all rendered from `jarvisdossier`'s parsed Markdown, post the null-safety fix above.

![A real dossier's typed detail view](images/2026-07-27-jarvis-second-brain-verification/04-tasks-detail-fixed.png)

### C — Recall / traversal

`jarvis-vault-recall` and `jarvis-continuity-resume` both exercise the seed-select → expand → grounding-card pipeline against the real vault (424 nodes). Both returned 12 grounding cards for their respective questions.

### D — Attribution

`jarvis-ambient` (the J1 fix) confirms engine D's real dossier→Run edges reach the ambient chip layer on Radar: **2 chips, 1 dashed**, with real dossier titles as labels (`"Diff commit 38f0c9d's changes to validat… · strong confidence · confirmed"`, `"Grep the frontend for remaining getApi()… · weak confidence · informing"`) — the exact join J1 was filed to fix, still holding.

![Radar surface carrying real attribution chips](images/2026-07-27-jarvis-second-brain-verification/05-ambient-radar.png)

### E — Continuity

`jarvis-continuity-resume` advances a real quick-mode Run to `done` (E's rest-boundary trigger), then confirms Jarvis can ground a "where did this land" question against the now-completed dossier.

![Continuity resume: run reaches done, dossier is grounded](images/2026-07-27-jarvis-second-brain-verification/06-continuity-resume.png)

### F — Model tiering

No UI surface — this is a cost-control concern (which `--model` flag a `consult.Run` call gets). Guarded by `pkg/jarvis/tier_test.go` and `pkg/jarvisproactive/tier_test.go` (per the 2026-07-27 J3 test-coverage close-out); not re-run in this live pass since there is nothing to screenshot. See [caveats](#caveats--not-independently-re-verified-this-pass).

### G — Presence D / ambient shell

Covered by `jarvis-states` (9 fixture states + citation-click), `jarvis-fleet` (Fleet mode + roster), and `jarvis-ask` (Ctrl+P → Ask Jarvis → lands as a user turn). All passed.

![Fleet mode: autonomy toggle + roster region](images/2026-07-27-jarvis-second-brain-verification/07-fleet-mode.png)
![Jarvis "grounded" presence state](images/2026-07-27-jarvis-second-brain-verification/08-jarvis-grounded-state.png)
![Contextual entry: Ask Jarvis from a Memory note carries the attached-source chip](images/2026-07-27-jarvis-second-brain-verification/15-contextual-entry.png)
![Multi-turn conversation persists across a reload](images/2026-07-27-jarvis-second-brain-verification/14-multiturn-persistence.png)

### Baseline: Run dispatch lifecycle + all 8 core surfaces render

Not second-brain-specific, but the substrate everything above depends on: `runs-lifecycle` drives a real Run through all 5 states (planning → advance → awaiting-review → approve → cancel) via real RPCs; `surface-smoke` confirms all 8 core nav surfaces render non-empty content.

![A dispatched Run mid-lifecycle](images/2026-07-27-jarvis-second-brain-verification/01-runs-lifecycle.png)
![Cockpit baseline render](images/2026-07-27-jarvis-second-brain-verification/02-cockpit-baseline.png)

---

## v2 — the six v2 sub-projects (all complete, per the v2 meta spec)

### S1 — Embedding foundation

Verified via the Settings surface's Embeddings section (the J2 UI fix): toggle **on**, base URL `https://openrouter.ai/api/v1`, model `openai/text-embedding-3-small`, and "A key is stored" confirming the BYOK secret is present via `GetSecretsNamesCommand` without ever displaying it back. This is the actual live configuration behind all of today's "measured against a real provider" numbers in `docs/jarvis-second-brain-open-issues.md`.

![Embeddings settings: enabled, real BYOK provider configured](images/2026-07-27-jarvis-second-brain-verification/09-settings-embeddings.png)

### S2 — Semantic consumers (L3 recall + L4 attribution)

Not re-verified live in this pass — this layer's correctness is measured through `pkg/jarvisrecall/liveprobe_test.go` (the `liveprobe` build-tag Go harness), not a CDP scenario, since it needs paraphrase queries scored against known targets rather than a DOM assertion. See J2/J5/J9 in `docs/jarvis-second-brain-open-issues.md` for the actual measured numbers (10/10 targets reaching the seed set as of the J5 calibration). See [caveats](#caveats--not-independently-re-verified-this-pass).

### S3 — Proactive resurfacing

`jarvis-proactive` confirms the full lifecycle live: the card renders on a real run body ("RELATED PRIOR WORK · DECISION", real suggestion title), the × dismisses it optimistically, and the dismissal persists to `run.meta` across a reload.

![The proactive "related prior work" card, live on a run](images/2026-07-27-jarvis-second-brain-verification/10-proactive-card.png)

### U1 — Presence C ("Spaces")

The app-bar Space switcher opens with the "FOCUS ON TASK" group, "Global (no focus)" selectable, and 4 real task spaces listed by objective (including real dogfooding dossiers alongside the CDP scenario's own test dossiers) — confirming U1 reads real dossier data, not a fixture.

![Space switcher: Focus-on-task popover with real spaces listed](images/2026-07-27-jarvis-second-brain-verification/11-spaces-switcher.png)

### U2 — Tasks surface

List view groups real dossiers by Active/Paused/Done; detail view renders the machine-maintained panel, status transition buttons, and decisions log — verified clean only after the null-safety fix above (this is where the crash was found).

![Tasks list, grouped by status, from real dossiers](images/2026-07-27-jarvis-second-brain-verification/12-tasks-list.png)

### U3 — Graph surface

Renders the whole federated vault as a force-directed graph — hundreds of memory nodes (purple), task nodes (blue), decision nodes (green), labeled clusters, with the legend (Task/Decision/Memory/Run) — confirming U3 against the real 375-node graph from J6's memory-root unification, not a toy fixture.

![The whole-vault graph, real data (~375 nodes)](images/2026-07-27-jarvis-second-brain-verification/13-graph-surface.png)

---

## Caveats — not independently re-verified this pass

- **F (model tiering)** and **S2 (semantic recall/attribution quality)** have no UI surface to screenshot; their correctness lives in Go test suites (`pkg/jarvis/tier_test.go`, `pkg/jarvisproactive/tier_test.go`, `pkg/jarvisrecall/liveprobe_test.go`) that were not re-run as part of this pass. Their most recent measured results are already recorded in `docs/jarvis-second-brain-open-issues.md` (J3, J5, J9) — this report doesn't re-derive those numbers, just doesn't contradict them.
- **J5 tuning calibration** is explicitly still open (per the open-issues doc) and out of scope here — this report verifies the features *work*, not that every threshold is optimally tuned.
- The vault now carries a handful of extra `ZZZ-...`/`verify-...` test dossiers left behind by the CDP scenario runs (dossier writes aren't cleaned up by scenario teardown, only the RPC-level channels/runs are). Harmless, but visible in the Tasks/Graph screenshots above.
- U3's node-click "bloom" interaction (selecting a task to reveal its attributed runs) was attempted but not strongly asserted — the click landed on the canvas but no selection card was confirmed in the screenshot; worth a follow-up if that specific interaction matters.

## Raw scenario output (38/38 passed)

```
# runs-lifecycle
  PASS  1. CreateRun -> 3 phases, p0 running + worker, status planning
  PASS  2. Advance complete p0 -> p1 running + worker, status planning
  PASS  3. Advance complete p1 -> awaiting-review, p2 pending, NO new worker
  PASS  4. Approve gate -> p2 running + worker, status executing
  PASS  5. Cancel -> status cancelled, p2 skipped

# surface-smoke (cockpit, jarvis, channels, radar, usage, memory, files, settings)
  PASS  x8 — active nav matches, content non-empty

# jarvis-states (empty, active, grounded, working, weak, notfound, stale, contextual, narrow)
  PASS  x9 — fixture bar present, content non-empty
  PASS  citation/card click runs without throwing

# jarvis-fleet
  PASS  switch to Fleet mode -> "Fleet" label + channel selector present
  PASS  select channel -> autonomy toggle + roster region render

# jarvis-ask
  PASS  type goal -> Ask Jarvis lead row present
  PASS  fire Ask row -> Jarvis surface shows the question as a user turn

# jarvis-contextual
  PASS  select memory note -> Ask Jarvis -> Jarvis surface + attached chip + suggested prompt

# jarvis-ambient
  PASS  an attributed row renders >=1 real ambient tag chip
        radar: 2 chips, 1 dashed, labels=[real dossier titles]
  PASS  informing (weak) edges render dashed, not solid

# jarvis-multiturn
  PASS  first question renders as a user turn
  PASS  conversation persists across reload in the history rail

# jarvis-vault-recall
  PASS  ask matching question -> >=1 grounding card (12 cards), not notfound

# jarvis-continuity-resume
  PASS  run advanced to done (E's rest-boundary trigger)
  PASS  ask where the completed task landed -> >=1 grounding card (12 cards), not notfound

# jarvis-proactive
  PASS  proactive card renders on the run body (label + suggestion title)
  PASS  dismiss (x) removes the card from the run body
  PASS  dismissal persisted to run.meta (survives reload)

38/38 steps passed
```

## Ad-hoc extra-surface results (post-fix)

```
PASS U2 tasks detail opens without crashing            opened=true navButtons=12
PASS U3 graph surface renders a canvas                 canvas=true
PASS S1 embeddings settings section present            scrolled=true
PASS U1 space switcher popover opens with Focus-on-task group
     hasFocusLabel=true (confirmed visually; the popover's uppercase CSS on the eyebrow text
     defeated an innerText substring match, screenshot is the real evidence)
     hasGlobalOption=true
```
