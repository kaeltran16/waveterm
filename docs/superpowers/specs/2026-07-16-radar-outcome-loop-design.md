# Radar → Outcome loop: reflect investigation results back on the finding

Date: 2026-07-16
Scope: single cross-surface feature (close the Radar-finding → Run → outcome loop). Spec only — hands off to writing-plans.
Related: `docs/superpowers/specs/2026-07-10-repo-radar-design.md` (Radar), `docs/superpowers/plans/2026-07-11-radar-start-investigation-composer.md` (the finding → Run handoff this builds on), `docs/deferred.md` ("Repo Radar — Start investigation handoff", verified shipped 2026-07-14), `docs/orchestrator-roadmap.md`.

## Problem

A Run started from a Radar finding carries a `RunRadarOrigin{ReportID, FindingID, Fingerprint}` (`pkg/waveobj/wtype.go`), and the comment says it plainly: *"Carried for a future finding-linked-outcome feature; v1 stores it but does not act on it."* The loop is open on the forward side:

- **Radar → Run** works: `radarfindingdetail.tsx` `startInvestigation()` → `pendingRunDraftAtom` → the Channels composer → `createRun(..., {radarOrigin})` → `CreateRunCommand` sets `run.RadarOrigin` (`wshserver.go:1830`).
- **Run → Radar** does not: when that Run completes and seals its evidence, **nothing updates the originating finding**. The finding sits unchanged; the next scan reconciles it purely by evidence, with no memory that an investigation ever ran. The user cannot tell, from Radar, which findings they have already acted on or what those actions produced.

The reverse direction (`collect_runs.go` — failed/blocked run phases *emit* Radar signals) already exists; this spec adds the missing forward writeback.

## The core constraint: investigated ≠ resolved

Radar doctrine (spec `2026-07-10-repo-radar-design.md`, `lifecycle.go`): *"No longer detected never means fixed."* A completed Run does **not** prove the risk is gone — the Run may have done unrelated work, failed a verify, or missed the point. So this loop **never auto-resolves and never auto-dismisses a finding.** It records *"an investigation ran; here is what it produced,"* and leaves the disposition to the human. Code reports the outcome; the human judges it. This preserves Radar's existing "code discovers, human decides" boundary — the `Group` field stays code-owned and evidence-driven.

## Decisions (locked via brainstorming, 2026-07-16)

- **Record outcome, never auto-resolve.** A finding's `Group` is untouched by the loop. The only state the loop writes is a new `Investigation` record. Dismissal remains a human action.
- **Latest investigation only** — a single `Investigation *RadarInvestigation` pointer on the finding, mirroring the existing `Disposition *RadarDisposition` exactly. Investigation *history* already lives durably in the channel's Runs; latest-only is KISS and matches the established pattern. Re-investigating overwrites.
- **Denormalize the evidence essentials** onto the record (files-touched, add/del, verifs pass/fail, summary) so a finding is self-contained: it survives scan reconciliation and stays meaningful even if the channel/run is later archived. Keep `RunID` + `ChannelID` for an "Open run" deep-link, not as the source of the displayed stats.
- **Writeback keyed by fingerprint, into the latest report.** Reports rotate (each scan mints a new `RadarReport`; findings carry forward by fingerprint via `reconcile`). The origin's `ReportID`/`FindingID` go stale; `Fingerprint` is the durable key (which is why the origin stores it). The helper targets the newest report for the run's project and finds the finding by fingerprint. If no current report holds that fingerprint (finding pruned / went no-longer-detected), it logs and skips — bounded, never fails the Run.
- **Three server-internal hooks, no new wshrpc command.** The writeback fires from existing Run commands (create → executing, done → terminal+evidence, cancel → cancelled). Only `task generate` (new TS types) is needed, not a new RPC.
- **`reconcile` carries `Investigation` forward** across scans, the same way it already carries `Disposition`. This yields the loop's most valuable signal for free (see Item D).
- **Include the "Dismiss (addressed by run)" affordance** — the natural human end of the loop. Reuses the existing disposition path; writes the run id into the dismissal note.

## Non-goals

- **No auto-resolve / auto-dismiss / new `Group` state.** (Core constraint above.)
- **No investigation history** — latest only. History is the channel's Runs.
- **No new "resolved/fixed" finding lifecycle** — findings stay new/recurring/nolonger/dismissed/suppressed.
- **No re-scan trigger on run completion.** Recording an outcome does not kick a Radar scan; the "still detected?" answer comes from the next normal scan (Item D). YAGNI + respects Radar's bounded-scan model.
- **Local project scope only** — matches Radar and Runs today. No remote/SSH.
- **No proactive backfill** of outcomes for runs that completed before this ships. The field is additive; a pre-feature run that is later sealed via the lazy `SealRunEvidenceCommand` path will record its outcome naturally (that hook is in scope), but nothing sweeps historical runs to populate findings.

---

## Item A — Data model (`pkg/waveobj/wtype.go`)

New record, next to `RunRadarOrigin` / `RadarDisposition`:

```go
// RadarInvestigation is the latest Run outcome recorded against a finding (by fingerprint). It closes the
// Radar → Run → outcome loop WITHOUT asserting the risk is fixed: it says "an investigation ran, here is what
// it produced." The disposition (dismiss/keep) stays a human decision. Evidence essentials are denormalized
// so the finding is self-contained across scan reconciliation and channel archive; RunID/ChannelID exist only
// for an "Open run" deep-link.
type RadarInvestigation struct {
    RunID        string `json:"runid"`
    ChannelID    string `json:"channelid"`
    Status       string `json:"status"` // executing | done | cancelled | failed
    StartedTs    int64  `json:"startedts"`
    CompletedTs  int64  `json:"completedts,omitempty"`
    Summary      string `json:"summary,omitempty"`
    FilesTouched int    `json:"filestouched,omitempty"`
    AddTotal     int    `json:"addtotal,omitempty"`
    DelTotal     int    `json:"deltotal,omitempty"`
    VerifsPass   int    `json:"verifspass,omitempty"`
    VerifsFail   int    `json:"verifsfail,omitempty"`
}
```

On `RadarFinding`, add (immediately after `Disposition`):

```go
Investigation *RadarInvestigation `json:"investigation,omitempty"`
```

`task generate` regenerates the TS type (`RadarFinding` / `RadarInvestigation`) into the frontend bindings — do not hand-edit generated files.

## Item B — Writeback helper (`pkg/reporadar/lifecycle.go`)

One helper is the whole backend contract; it mirrors `SetDisposition`/`ApplyDisposition`'s shape (locate finding in a report, mutate, publish):

```go
// RecordInvestigation writes/overwrites the latest Run outcome onto the finding identified by origin.Fingerprint
// in the CURRENT (newest) report for projectPath. Reports rotate and findings carry forward by fingerprint, so
// the origin's ReportID/FindingID are not used to locate the finding — only the fingerprint. A missing report or
// absent fingerprint is not an error (the finding may have been pruned or gone no-longer-detected): log and skip.
func RecordInvestigation(ctx context.Context, projectPath string, fingerprint string, inv waveobj.RadarInvestigation) error
```

- Resolve the newest report for `projectPath` via the existing `reporadar.ListReports(ctx, projectPath) ([]*RadarReport, error)` (`command.go:83`) — pick the newest report that actually carries findings (Status `completed`/`partial`), by `StartedTs`; a `collecting`/`clustering` report has no findings yet and is skipped. Do not add a parallel lookup.
- `wstore.UpdateRadarReport(ctx, reportId, func(r){ find finding by fingerprint; set .Investigation = &inv })`, then `publish(reportId)` (same as `ApplyDisposition`).
- No report / no fingerprint match → log at debug and return nil. The caller (a Run command) must never fail because a finding moved.

### `reconcile` carries `Investigation` forward

`reconcile` (same file) already carries `Disposition` forward by fingerprint. Extend every carry-forward branch that copies `p.Disposition` to also copy `p.Investigation`:

- prev Suppressed / prev Dismissed-stays / prev-open → Recurring: copy `Investigation` from the prev finding onto the current one.
- The reopen-on-newer-evidence branch (dismissed → recurring) keeps the `Investigation` too (it is orthogonal to disposition).
- No-longer-detected carry: the prev finding is copied whole, so its `Investigation` rides along already.

Investigation carry-forward is independent of the dismissal reopen gate — an investigation never reopens or closes anything; it is pure annotation.

## Item C — Three server hooks (`pkg/wshrpc/wshserver/wshserver.go`)

All three call the one helper. Each is guarded on `run.RadarOrigin != nil` and wrapped so a writeback error is logged, never returned (the Run lifecycle is the source of truth; the annotation is best-effort).

1. **Create → `executing`.** In `CreateRunCommand`, right after `run.RadarOrigin = data.RadarOrigin` (`:1830`): if the origin is set, `RecordInvestigation(ctx, run.ProjectPath, origin.Fingerprint, {RunID: run.ID, ChannelID: data.ChannelId, Status: "executing", StartedTs: ts})`. This gives the finding a live "investigating" state the instant a run is dispatched from it.

2. **Done → `done` + evidence.** After `run.Evidence` is populated and persisted, if `run.RadarOrigin != nil`, record `Status: "done"`, `CompletedTs: run.CompletedTs`, and the denormalized fields from `run.Evidence` (`Summary`, `FilesTouched = len(Evidence.Files)`, `AddTotal`, `DelTotal`, and `VerifsPass`/`VerifsFail` counted from `Evidence.Verifs` by `Result` — via a small pure `investigationFromEvidence(run)` mapper). There are **two seal sites** and the writeback belongs at both: the live path `AdvanceRunCommand` (`:1909-1925`, seals on the non-done→done transition — the path every new run takes) and the lazy-backfill `SealRunEvidenceCommand` (`:2009-2034`, seals older done runs on demand). `RecordInvestigation` overwrites the latest record, so firing from both is safe and idempotent; guarding each on `run.RadarOrigin != nil` keeps normal runs untouched.

3. **Cancel → `cancelled`.** In `CancelRunCommand` (`:1965`), after the cancel is persisted: if `run.RadarOrigin != nil`, record `Status: "cancelled"`, `CompletedTs: ts`. No evidence (cancel does not seal); the stat fields stay zero.

`failed` in the enum covers a future distinct terminal-fail path; today runs go done or cancelled, so v1 emits only those two terminal statuses plus `executing`. The frontend still handles `failed` defensively.

`run.ProjectPath` is the writeback key source (copied from the channel at create; present on every run). `origin.Fingerprint` is the finding key.

## Item D — Frontend (`radarfindingdetail.tsx`, finding list, disposition)

Types arrive via `task generate` (`RadarFinding.investigation?: RadarInvestigation`).

### Finding detail — Investigation block

Rendered when `finding.investigation` is set, above or beside the existing disposition/evidence area:

- **Status pill:** `executing` → "Investigating…" (accent, subtle pulse, reuse existing spinner/`asking` tone); `done` → "Investigated ✓"; `cancelled` → "Investigation cancelled" (muted); `failed` → warn tone.
- **Outcome stats** (when `done`): files touched, `+add / −del`, verifs `N pass / M fail` (fail count in warn tone if > 0), and `summary` if present. Reuse the Runs evidence-chip formatting where it exists.
- **Open run** button — deep-links to the run via `investigation.channelId` + `investigation.runId`. Reuse the existing "jump to a run/agent" navigation (`jumpToAgent`/run-strip selection already used from the fleet panel); if a run-specific deep-link helper does not exist, this is a thin addition (select channel → focus run in the strip).
- **Primary action** becomes **"Investigate again"** (same `startInvestigation()` path) once an investigation exists; the label is "Start investigation" only when `investigation` is unset.

### Finding list — badge

A small per-row indicator in the findings list (`radarsurface.tsx` / the list row component):

- `executing` → `🔬` / "investigating" chip.
- `done` (and the finding is **not** currently recurring) → `✓` "investigated".
- `done` **and** the finding is still `recurring`/`new` in the current report → **"↻ still detected"** in warn tone. This is the loop's highest-value signal: you investigated it, and Radar still finds the evidence — the fix did not take (or the run addressed the wrong thing). It falls out for free from `reconcile` carrying the `Investigation` forward while the evidence-driven `Group` independently stays `recurring`.

### Dismiss (addressed by run)

When a `done` investigation exists, add a disposition affordance **"Dismiss (addressed by run)"** alongside the existing dismiss/suppress actions. It calls the existing disposition path (`ApplyDisposition` / the `SetRadarDisposition` command) with `action: "dismiss"` and a `note` referencing `investigation.runId` (e.g. `"addressed by run <id>"`), so the dismissal is self-documenting. No new backend surface — it is the normal dismiss with a prefilled note. This is the human end of the loop: code showed the outcome, the human resolves the finding with the run as the cited justification.

---

## File touch map (for plan sequencing)

**Backend (Go):**
- `pkg/waveobj/wtype.go` — Item A (`RadarInvestigation` struct + `Investigation` field on `RadarFinding`).
- `pkg/reporadar/lifecycle.go` — Item B (`RecordInvestigation` helper + `reconcile` carry-forward).
- `pkg/wshrpc/wshserver/wshserver.go` — Item C (hooks in `CreateRunCommand`, `AdvanceRunCommand`, `SealRunEvidenceCommand`, `CancelRunCommand`).
- Generated (via `task generate`, do not hand-edit): `frontend/app/store/*` type bindings.

**Frontend (TS/TSX):**
- `radarfindingdetail.tsx` — Item D (Investigation block, Investigate-again, Open-run, Dismiss-addressed-by-run).
- `radarsurface.tsx` (or the finding-list row component) — Item D (list badge; the "still detected" derivation compares `finding.investigation?.status === "done"` against `finding.group`).
- `radarstore.ts` / `radarmodel.ts` — only if a derived selector for the badge state is cleaner as a pure helper (preferred — unit-testable).

**Conflict summary:** `wshserver.go` is touched in four functions but they are disjoint (Create/Advance/Seal/Cancel) — one task should own all four (they share the `investigationFromEvidence` mapper and the `origin != nil` guard); they do not conflict with unrelated work. `lifecycle.go` (helper + reconcile) is one task. Frontend detail + list are separable but share the derived badge helper — put the helper first.

## Testing

**Go unit (`pkg/reporadar`):**
- `RecordInvestigation`: writes onto the finding matching the fingerprint in the latest report; overwrites an existing investigation (latest-only); no-ops (no error) when the fingerprint is absent / no report exists.
- `reconcile`: carries `Investigation` forward across a rescan for recurring, dismissed-stays, suppressed, and no-longer-detected; a `done` investigation + still-present evidence yields `Group == recurring` **with** the investigation intact (the "still detected" signal); investigation carry is independent of the dismissal reopen gate.

**Go unit (`pkg/jarvis` or the seal test):**
- Evidence → investigation denormalization: given a sealed `RunEvidence`, the recorded `FilesTouched`/`AddTotal`/`DelTotal`/`VerifsPass`/`VerifsFail`/`Summary` match (a small pure mapper `investigationFromEvidence(run) RadarInvestigation` is the testable unit; the hook calls it).

**FE unit (vitest):**
- Badge-state derivation helper: `executing` → investigating; `done` + not-recurring → investigated; `done` + recurring → still-detected; unset → none.

**Visual (CDP, best-effort):** start an investigation from a finding → finding shows "Investigating…" and a badge; on run completion the finding shows the done outcome stats + Open run; "Investigate again" replaces the primary action. A live run round-trip may be impractical over CDP — if so, rely on the unit tests and mark unverified with that reason (per the repo convention). Never `Page.reload`.

## Verification conventions

- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean, exit 0; `npx tsc` stack-overflows here).
- FE unit: `npx vitest run frontend/app/view/agents/<file>.test.ts`.
- Go unit: `go test ./pkg/reporadar/ ./pkg/jarvis/`.
- Regen + backend build: `task generate` then `task build:backend` (new waveobj type → new TS bindings; see the "new waveobj type needs migration" gotcha only if a new DB table were added — this is a field on an existing object, so no migration).
- Visual: `tail -f /dev/null | task dev` running; capture via `node scripts/cdp-shot.mjs`; never `Page.reload`. If the dev app is not running, mark the visual step unverified rather than claiming it passed.
- Do not commit; the user batches commits and approves them. This spec folds into the feature commit it describes.
