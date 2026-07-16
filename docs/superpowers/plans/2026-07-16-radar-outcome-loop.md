# Radar → Outcome Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Radar-finding → Run → outcome loop: when a Run started from a Radar finding runs, completes, or cancels, record the outcome back onto the finding (by fingerprint) so Radar shows what was investigated and what it produced — without ever asserting the risk is fixed.

**Architecture:** A new `RadarInvestigation` record (latest-only, mirroring the existing `Disposition`) is written onto the finding by a server-internal helper `RecordInvestigation`, keyed by **fingerprint** into the newest findings-bearing report (via the existing `latestSuccessful`). Three existing Run commands call it (create → `executing`, both seal sites → `done`, cancel → `cancelled`); `reconcile` carries the record forward across scans exactly like it carries a disposition. The frontend renders an Investigation block + list badge and adds a "Dismiss (addressed by run)" affordance. No new wshrpc command — only `task generate` for the new waveobj type.

**Tech Stack:** Go + wshrpc + wstore (backend); React 19 + jotai + Tailwind 4 (frontend); `go test` (Go unit, real test DB harness via `wstore.CreateRadarReport`); vitest (FE unit); CDP `:9222` against `cargo tauri dev` (visual).

**Spec:** `docs/superpowers/specs/2026-07-16-radar-outcome-loop-design.md`.

## Global Constraints

- **Never auto-resolve/auto-dismiss a finding.** The loop writes only the `Investigation` record; `Group` stays code-owned and evidence-driven. Dismissal is a human action. (Spec §"core constraint".)
- **Latest investigation only** — a single `*RadarInvestigation` pointer; re-investigating overwrites. History lives in the channel's Runs.
- **Writeback keyed by fingerprint**, into the newest completed/partial report; a missing report or absent fingerprint is a logged no-op, never an error that fails the Run.
- **No new wshrpc command.** Writeback is server-internal, fired from existing Run commands.
- **No emoji in UI or code** (per repo owner's global style). Use text labels + existing `@theme` tone tokens (`TONE_TEXT`, `text-accent-soft`, `text-muted`), never raw hex/rgba.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline clean (exit 0). `npx tsc` stack-overflows on this repo; never use it. Any error it reports is yours.
- **FE unit tests:** `npx vitest run frontend/app/view/agents/<file>.test.ts`.
- **Go unit tests:** `go test ./pkg/reporadar/ ./pkg/jarvis/`.
- **Never hand-edit generated files.** `task generate` produces the TS type bindings from Go. Regenerate; do not edit by hand.
- **No DB migration needed:** `Investigation` is a field on the embedded `RadarFinding` (JSON inside the `RadarReport` object), not a new table. (Contrast the "new waveobj type needs migration" gotcha — that is for new top-level object types.)
- **Do NOT commit.** The user batches all changes into one commit and approves it (repo git policy is STRICT — never auto-commit). End each task at verification, not a commit. The spec + this plan fold into the feature commit.
- **Comments:** lower-case, explain "why" not "what", only when necessary (matches the existing files).
- **Visual verification:** the dev app must run via `tail -f /dev/null | task dev` (headless `task dev` dies on stdin EOF). Capture with `node scripts/cdp-shot.mjs <out.png>`; drive DOM/keys over raw CDP on `:9222`. **Never** `Page.reload` — it breaks Tauri boot. If the dev app is not running, state the visual step is unverified rather than claiming it passed.

---

## Execution ordering

Backend types must land (and regenerate) before any frontend task reads `finding.investigation`. Recommended order: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**.

Shared-file sequencing (one subagent per task, review between):
- `pkg/reporadar/investigation.go` (new): **Task 3 → Task 4** (Task 3 adds `InvestigationFromRun`, Task 4 adds `RecordInvestigation` in the same file).
- `frontend/app/view/agents/radarfindingdetail.tsx`: only Task 8 touches it.
- `frontend/app/view/agents/channelssurface.tsx`: only Task 7 touches it.

File-disjoint tasks (2 is `lifecycle.go`, 6 is `radarmodel.ts`, 9 is `radarfindingslist.tsx`) may run in parallel with unrelated tasks, but the sequential order above is conflict-free.

---

## Task 1: Data model + regenerate bindings

**Files:**
- Modify: `pkg/waveobj/wtype.go` (after `RadarFinding`, ~line 367)
- Generated (via `task generate`, do NOT hand-edit): frontend TS type bindings.

**Interfaces:**
- Produces: Go `waveobj.RadarInvestigation` struct + `RadarFinding.Investigation *RadarInvestigation`; TS ambient `RadarInvestigation` + `RadarFinding.investigation?`. Consumed by every later task.

- [ ] **Step 1: Add the struct + field**

In `pkg/waveobj/wtype.go`, immediately after the `RadarFinding` struct (the block ending with `Disposition *RadarDisposition ...` at ~line 367), add:

```go
// RadarInvestigation is the latest Run outcome recorded against a finding (by fingerprint). It closes the
// Radar -> Run -> outcome loop WITHOUT asserting the risk is fixed: it says "an investigation ran, here is
// what it produced." Disposition (dismiss/keep) stays a human decision. Evidence essentials are denormalized
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

Then add the field to `RadarFinding`, immediately after its `Disposition` line:

```go
	Investigation *RadarInvestigation `json:"investigation,omitempty"`
```

- [ ] **Step 2: Regenerate bindings**

Run: `task generate`
Expected: exit 0. The TS `RadarInvestigation` type and `RadarFinding.investigation?` field appear in the generated bindings.

Verify: `grep -rn "RadarInvestigation" frontend/` → at least one hit in a generated `.d.ts`/types file. Do not hand-edit it.

- [ ] **Step 3: Backend build + frontend typecheck**

Run: `task build:backend`
Expected: exit 0.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (new optional field, no FE consumers yet).

---

## Task 2: `reconcile` carries `Investigation` forward — TDD

**Files:**
- Modify: `pkg/reporadar/lifecycle.go` (`reconcile`, lines ~34-57)
- Test: `pkg/reporadar/lifecycle_test.go`

**Interfaces:**
- Consumes: `waveobj.RadarFinding.Investigation` (Task 1).
- Produces: `reconcile` now copies a prev finding's `Investigation` onto the carried-forward current finding (all existing-fingerprint branches), enabling the "investigated but still detected" signal. No signature change.

- [ ] **Step 1: Write the failing tests**

In `pkg/reporadar/lifecycle_test.go`, append:

```go
func TestReconcileCarriesInvestigationForward(t *testing.T) {
	inv := &waveobj.RadarInvestigation{RunID: "r1", Status: "done", CompletedTs: 40, FilesTouched: 3}
	prev := &waveobj.RadarReport{Findings: []waveobj.RadarFinding{
		{Fingerprint: fp("src/coupons"), Group: GroupNew, RiskKind: RiskTestCoverageGap, Subsystem: "src/coupons", Investigation: inv},
	}}
	// still detected -> Recurring, but the investigation record rides along (the "still detected" signal)
	out := reconcile("/repos/pay", []waveobj.RadarFinding{find("src/coupons")}, prev, map[string]int64{})
	if len(out) != 1 || out[0].Group != GroupRecurring {
		t.Fatalf("expected recurring, got %+v", out)
	}
	if out[0].Investigation == nil || out[0].Investigation.RunID != "r1" {
		t.Fatalf("investigation must carry forward, got %+v", out[0].Investigation)
	}
}

func TestReconcileDoesNotInventInvestigationForNewFinding(t *testing.T) {
	out := reconcile("/repos/pay", []waveobj.RadarFinding{find("src/auth")}, nil, map[string]int64{})
	if out[0].Investigation != nil {
		t.Fatalf("a brand-new finding must have no investigation, got %+v", out[0].Investigation)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/reporadar/ -run TestReconcileCarriesInvestigationForward`
Expected: FAIL — `out[0].Investigation` is nil (not carried).

- [ ] **Step 3: Carry the investigation forward**

In `pkg/reporadar/lifecycle.go`, inside `reconcile`, in the `for _, f := range current` loop, immediately after the `if !existed { ... continue }` block (i.e. once we know `p, existed` and `existed == true`), add one line before the `switch p.Group`:

```go
		f.Investigation = p.Investigation // carry the loop's outcome forward, like Disposition (independent of it)
```

(The no-longer-detected carry at the bottom appends `p` whole, so its `Investigation` already rides along — no change there. New findings hit the `!existed` branch and correctly stay investigation-free.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/reporadar/ -run TestReconcile`
Expected: PASS (the two new tests + all existing `TestReconcile*` — confirm none regressed).

---

## Task 3: `InvestigationFromRun` mapper — TDD

**Files:**
- Create: `pkg/reporadar/investigation.go`
- Test: `pkg/reporadar/investigation_test.go`

**Interfaces:**
- Consumes: `waveobj.Run`, `waveobj.RunEvidence` (existing), `waveobj.RadarInvestigation` (Task 1).
- Produces: `InvestigationFromRun(run *waveobj.Run, channelId, status string, ts int64) waveobj.RadarInvestigation` — used by Task 5's server hooks.

- [ ] **Step 1: Write the failing test**

Create `pkg/reporadar/investigation_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestInvestigationFromRunExecutingHasNoEvidence(t *testing.T) {
	run := &waveobj.Run{ID: "r1", CreatedTs: 100}
	inv := InvestigationFromRun(run, "chan1", "executing", 100)
	if inv.RunID != "r1" || inv.ChannelID != "chan1" || inv.Status != "executing" {
		t.Fatalf("identity fields wrong: %+v", inv)
	}
	if inv.StartedTs != 100 || inv.CompletedTs != 0 {
		t.Fatalf("executing must set StartedTs, not CompletedTs: %+v", inv)
	}
	if inv.FilesTouched != 0 || inv.VerifsPass != 0 {
		t.Fatalf("executing must have no evidence stats: %+v", inv)
	}
}

func TestInvestigationFromRunDoneDenormalizesEvidence(t *testing.T) {
	run := &waveobj.Run{
		ID: "r1", CreatedTs: 100,
		Evidence: &waveobj.RunEvidence{
			Summary:  "fixed the gap",
			Files:    []waveobj.EvidenceFile{{Path: "a.go"}, {Path: "b.go"}},
			AddTotal: 12, DelTotal: 3,
			Verifs: []waveobj.EvidenceVerif{{Result: "pass"}, {Result: "fail"}, {Result: "pass"}, {Result: "unknown"}},
		},
	}
	inv := InvestigationFromRun(run, "chan1", "done", 500)
	if inv.Status != "done" || inv.CompletedTs != 500 {
		t.Fatalf("done must set CompletedTs: %+v", inv)
	}
	if inv.Summary != "fixed the gap" || inv.FilesTouched != 2 || inv.AddTotal != 12 || inv.DelTotal != 3 {
		t.Fatalf("evidence denorm wrong: %+v", inv)
	}
	if inv.VerifsPass != 2 || inv.VerifsFail != 1 {
		t.Fatalf("verif counts wrong (pass=2 fail=1): %+v", inv)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/reporadar/ -run TestInvestigationFromRun`
Expected: FAIL to compile — `InvestigationFromRun` undefined.

- [ ] **Step 3: Implement the mapper**

Create `pkg/reporadar/investigation.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"log"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// InvestigationFromRun builds a finding investigation record from a run's state. For a terminal status
// (done/cancelled/failed) it sets CompletedTs and, when the run has sealed evidence, denormalizes the
// essentials so the finding is self-contained. For "executing" it records only identity + StartedTs.
func InvestigationFromRun(run *waveobj.Run, channelId, status string, ts int64) waveobj.RadarInvestigation {
	inv := waveobj.RadarInvestigation{
		RunID:     run.ID,
		ChannelID: channelId,
		Status:    status,
		StartedTs: run.CreatedTs,
	}
	if status != "executing" {
		inv.CompletedTs = ts
	}
	if ev := run.Evidence; ev != nil {
		inv.Summary = ev.Summary
		inv.FilesTouched = len(ev.Files)
		inv.AddTotal = ev.AddTotal
		inv.DelTotal = ev.DelTotal
		for _, v := range ev.Verifs {
			switch v.Result {
			case "pass":
				inv.VerifsPass++
			case "fail":
				inv.VerifsFail++
			}
		}
	}
	return inv
}
```

(The `context`/`fmt`/`log`/`wstore` imports are used by `RecordInvestigation` added in Task 4 — add them now so the file compiles once Task 4 lands; if Task 3 is verified in isolation, temporarily omit the unused imports and re-add in Task 4. Simplest: implement Task 4 in the same review cycle.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/reporadar/ -run TestInvestigationFromRun`
Expected: PASS.

---

## Task 4: `RecordInvestigation` writeback — TDD — depends on Task 3

**Files:**
- Modify: `pkg/reporadar/investigation.go` (add `RecordInvestigation`)
- Test: `pkg/reporadar/investigation_test.go`

**Interfaces:**
- Consumes: `latestSuccessful` (`command.go`), `canonPath`, `publish` (`scan.go`), `wstore.UpdateRadarReport`.
- Produces: `RecordInvestigation(ctx context.Context, projectPath, fingerprint string, inv waveobj.RadarInvestigation) error` — used by Task 5's server hooks. Logged no-op on missing report / absent fingerprint; error only on a real DB failure.

- [ ] **Step 1: Write the failing tests**

In `pkg/reporadar/investigation_test.go`, add the `context`/`wstore` imports to the import block and append:

```go
func TestRecordInvestigationWritesByFingerprint(t *testing.T) {
	ctx := context.Background()
	pp := canonPath("/repos/pay")
	rpt, _ := wstore.CreateRadarReport(ctx, "pay", pp)
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = StatusCompleted
		r.Findings = []waveobj.RadarFinding{{ID: "f1", Fingerprint: "RAD-abc", Group: GroupNew}}
	})
	inv := waveobj.RadarInvestigation{RunID: "r1", ChannelID: "chan1", Status: "done", FilesTouched: 2}
	if err := RecordInvestigation(ctx, pp, "RAD-abc", inv); err != nil {
		t.Fatalf("record: %v", err)
	}
	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Findings[0].Investigation == nil || got.Findings[0].Investigation.RunID != "r1" {
		t.Fatalf("investigation must be written, got %+v", got.Findings[0].Investigation)
	}
}

func TestRecordInvestigationNoopOnAbsentFingerprint(t *testing.T) {
	ctx := context.Background()
	pp := canonPath("/repos/nofp")
	rpt, _ := wstore.CreateRadarReport(ctx, "nofp", pp)
	wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		r.Status = StatusCompleted
		r.Findings = []waveobj.RadarFinding{{ID: "f1", Fingerprint: "RAD-here", Group: GroupNew}}
	})
	if err := RecordInvestigation(ctx, pp, "RAD-missing", waveobj.RadarInvestigation{RunID: "r9"}); err != nil {
		t.Fatalf("absent fingerprint must be a no-op, not an error: %v", err)
	}
	got, _ := wstore.GetRadarReport(ctx, rpt.OID)
	if got.Findings[0].Investigation != nil {
		t.Fatalf("no finding should have been mutated, got %+v", got.Findings[0].Investigation)
	}
}

func TestRecordInvestigationNoopWhenNoReport(t *testing.T) {
	ctx := context.Background()
	if err := RecordInvestigation(ctx, canonPath("/repos/never-scanned"), "RAD-x", waveobj.RadarInvestigation{RunID: "r1"}); err != nil {
		t.Fatalf("no report must be a no-op, not an error: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/reporadar/ -run TestRecordInvestigation`
Expected: FAIL to compile — `RecordInvestigation` undefined.

- [ ] **Step 3: Implement `RecordInvestigation`**

In `pkg/reporadar/investigation.go`, append:

```go
// RecordInvestigation writes/overwrites the latest Run outcome onto the finding identified by fingerprint in
// the NEWEST completed/partial report for projectPath. Reports rotate and findings carry forward by
// fingerprint (see reconcile), so the origin's ReportID/FindingID are not used — only the fingerprint. A
// missing report or absent fingerprint is a logged no-op: a Run command must never fail because a finding
// moved or was pruned. Only a real DB error propagates.
func RecordInvestigation(ctx context.Context, projectPath, fingerprint string, inv waveobj.RadarInvestigation) error {
	rpt := latestSuccessful(ctx, canonPath(projectPath))
	if rpt == nil {
		log.Printf("radar: no report for %q; skipping investigation writeback for %s", projectPath, fingerprint)
		return nil
	}
	found := false
	err := wstore.UpdateRadarReport(ctx, rpt.OID, func(r *waveobj.RadarReport) {
		for i := range r.Findings {
			if r.Findings[i].Fingerprint == fingerprint {
				r.Findings[i].Investigation = &inv
				found = true
				return
			}
		}
	})
	if err != nil {
		return fmt.Errorf("recording investigation: %w", err)
	}
	if !found {
		log.Printf("radar: fingerprint %s not in report %s; investigation not recorded", fingerprint, rpt.OID)
		return nil
	}
	publish(rpt.OID)
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/reporadar/`
Expected: PASS (Task 3 mapper tests + these three + all existing reporadar tests).

---

## Task 5: Three server hooks — depends on Task 4

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (`CreateRunCommand` ~1830, `AdvanceRunCommand` seal block ~1909-1925, `SealRunEvidenceCommand` ~2026-2034, `CancelRunCommand` ~1977-1982)

**Interfaces:**
- Consumes: `reporadar.InvestigationFromRun`, `reporadar.RecordInvestigation` (Tasks 3-4). `reporadar` is already imported in this file (used by `ListRadarReportsCommand`); confirm and reuse the existing import.

Each hook is guarded on `RadarOrigin != nil` and logs (never returns) a writeback error — the Run lifecycle is the source of truth; the annotation is best-effort.

- [ ] **Step 1: Create → `executing`**

In `CreateRunCommand`, immediately after `AppendRun` succeeds (after the `if err := wstore.AppendRun(...)` block at ~line 1833, before `spawnRunWorkers`), add:

```go
	if run.RadarOrigin != nil {
		inv := reporadar.InvestigationFromRun(&run, data.ChannelId, "executing", run.CreatedTs)
		if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
			log.Printf("CreateRun: recording radar investigation (executing) failed: %v", rerr)
		}
	}
```

(`run` here is the `waveobj.Run` value returned by `jarvis.NewRun`; take its address.)

- [ ] **Step 2: Done → `done` (live seal path)**

In `AdvanceRunCommand`, inside the seal block (`if run.Status == jarvis.RunStatus_Done && run.Evidence == nil { ... }`), after the inner `UpdateRun` that persists evidence (after the `if uerr := wstore.UpdateRun(...)` block ending ~line 1924), add — still inside the seal `if`:

```go
		if run.RadarOrigin != nil {
			inv := reporadar.InvestigationFromRun(run, data.ChannelId, "done", run.CompletedTs)
			if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
				log.Printf("AdvanceRun: recording radar investigation (done) failed: %v", rerr)
			}
		}
```

(`run` is the `*waveobj.Run` from the `GetRun` at ~1910; `SealEvidence` has populated `run.Evidence` and `run.CompletedTs`.)

- [ ] **Step 3: Done → `done` (lazy backfill seal path)**

In `SealRunEvidenceCommand`, after the `UpdateRun` that persists evidence (after the `if uerr := wstore.UpdateRun(...)` block ~line 2034), add:

```go
	if run.RadarOrigin != nil {
		inv := reporadar.InvestigationFromRun(run, data.ChannelId, "done", run.CompletedTs)
		if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
			log.Printf("SealRunEvidence: recording radar investigation (done) failed: %v", rerr)
		}
	}
```

(Idempotent with Step 2 — `RecordInvestigation` overwrites the latest record. This path fires when an older run is sealed on demand.)

- [ ] **Step 4: Cancel → `cancelled`**

In `CancelRunCommand`, inside the `if run, gerr := wstore.GetRun(...); gerr == nil { ... }` block (~line 1977, where the reloaded `run` carries `RadarOrigin`), after `stopRunWorkers(ctx, run)`, add:

```go
		if run.RadarOrigin != nil {
			inv := reporadar.InvestigationFromRun(run, data.ChannelId, "cancelled", time.Now().UnixMilli())
			if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
				log.Printf("CancelRun: recording radar investigation (cancelled) failed: %v", rerr)
			}
		}
```

- [ ] **Step 5: Build the backend**

Run: `task build:backend`
Expected: exit 0. (`log` and `time` are already imported in `wshserver.go`; `reporadar` is already imported. If `go build` reports an unused/ missing import, fix per the compiler.)

- [ ] **Step 6: Full backend tests**

Run: `go test ./pkg/reporadar/ ./pkg/jarvis/`
Expected: PASS. (No new server-level unit test — the logic under test lives in the Task 3/4 helpers; the hooks are thin wiring verified by build + the behavioral note. State this in the task's verification.)

---

## Task 6: `investigationBadge` FE helper — TDD

**Files:**
- Modify: `frontend/app/view/agents/radarmodel.ts`
- Test: `frontend/app/view/agents/radarmodel.test.ts` (exists)

**Interfaces:**
- Consumes: `RadarFinding.investigation` (Task 1, generated).
- Produces: `investigationBadge(f: RadarFinding): "investigating" | "investigated" | "still-detected" | null` — used by Tasks 8 (detail) and 9 (list).

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/agents/radarmodel.test.ts`, add `investigationBadge` to the existing `./radarmodel` import and append:

```ts
describe("investigationBadge", () => {
    const f = (group: string, status?: string): RadarFinding =>
        ({ id: "f", group, investigation: status ? { runid: "r", channelid: "c", status, startedts: 0 } : undefined }) as unknown as RadarFinding;

    it("is null with no investigation", () => {
        expect(investigationBadge(f("new"))).toBeNull();
    });
    it("is investigating while executing", () => {
        expect(investigationBadge(f("new", "executing"))).toBe("investigating");
    });
    it("is still-detected when done but the finding still recurs", () => {
        expect(investigationBadge(f("recurring", "done"))).toBe("still-detected");
        expect(investigationBadge(f("new", "done"))).toBe("still-detected");
    });
    it("is investigated when done and the finding is no longer open", () => {
        expect(investigationBadge(f("nolonger", "done"))).toBe("investigated");
        expect(investigationBadge(f("dismissed", "done"))).toBe("investigated");
    });
    it("shows no list badge for a cancelled/failed investigation", () => {
        expect(investigationBadge(f("new", "cancelled"))).toBeNull();
        expect(investigationBadge(f("new", "failed"))).toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts -t investigationBadge`
Expected: FAIL — `investigationBadge is not a function`.

- [ ] **Step 3: Implement `investigationBadge`**

In `frontend/app/view/agents/radarmodel.ts`, append:

```ts
export type InvestigationBadge = "investigating" | "investigated" | "still-detected" | null;

// The loop badge for a finding: an active investigation, a completed one, or a completed one contradicted by
// the finding still being detected (group still new/recurring — "the fix did not take"). cancelled/failed
// carry no list badge (surfaced only in the detail pane). Pure — no jotai/RPC.
export function investigationBadge(f: RadarFinding): InvestigationBadge {
    const inv = f.investigation;
    if (!inv) {
        return null;
    }
    if (inv.status === "executing") {
        return "investigating";
    }
    if (inv.status === "done") {
        return f.group === "new" || f.group === "recurring" ? "still-detected" : "investigated";
    }
    return null;
}
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: PASS (existing + 5 new).

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

## Task 7: "Open run" focus mechanism

**Files:**
- Modify: `frontend/app/view/agents/runactions.ts` (add `pendingRunFocusAtom`)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (landing effect)

**Interfaces:**
- Produces: `pendingRunFocusAtom` (jotai `{channelId, runId} | null`) — set by Task 8's Open-run button, consumed here to select the channel + run.

- [ ] **Step 1: Add the focus atom**

In `frontend/app/view/agents/runactions.ts`, next to `pendingRunDraftAtom` (line ~19), add:

```ts
// A one-shot request to focus a specific run (e.g. from Radar's "Open run"). The Channels surface consumes it
// on landing: select the channel, then select the run once its strip is populated, then clear. Mirrors
// pendingRunDraftAtom (the guard is clearing the atom, so it survives ChannelsSurface remount on navigation).
export const pendingRunFocusAtom = atom<{ channelId: string; runId: string } | null>(
    null
) as PrimitiveAtom<{ channelId: string; runId: string } | null>;
```

(Confirm `atom` and `PrimitiveAtom` are already imported in `runactions.ts` — `pendingRunDraftAtom` uses both. They are.)

- [ ] **Step 2: Consume the focus atom in the Channels surface**

In `frontend/app/view/agents/channelssurface.tsx`:

1. Add `pendingRunFocusAtom` to the existing `./runactions` import (the block importing `pendingRunDraftAtom`).
2. Inside `ChannelsSurface`, near the other atom reads (after `setPendingDraft`, ~line 57), add:

```tsx
    const pendingFocus = useAtomValue(pendingRunFocusAtom);
    const setPendingFocus = useSetAtom(pendingRunFocusAtom);
```

3. After the Radar-handoff landing effect (the `useEffect` ending ~line 125), add:

```tsx
    // land an "Open run" focus request: select the channel, then (once its runs are loaded) select the run.
    useEffect(() => {
        if (!pendingFocus) {
            return;
        }
        if (activeId !== pendingFocus.channelId) {
            fireAndForget(() => selectChannel(pendingFocus.channelId));
            return; // re-runs when activeId flips to the target channel
        }
        if (runs.some((r) => r.id === pendingFocus.runId)) {
            setActiveRunId(pendingFocus.runId);
            setPendingFocus(null);
        }
    }, [pendingFocus, activeId, runs]);
```

(`useAtomValue`, `useSetAtom`, `fireAndForget`, `selectChannel`, `runs`, `activeId`, `setActiveRunId` are all already in scope/imported in this file. This effect is declared after the `resolveActiveRunId` effect at ~line 75, so it wins the run selection on the same render.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (atom defined; no button wires it yet — that is Task 8).

---

## Task 8: Investigation block + "Investigate again" + "Dismiss (addressed by run)" — depends on Tasks 6, 7

**Files:**
- Modify: `frontend/app/view/agents/radarfindingdetail.tsx`

**Interfaces:**
- Consumes: `finding.investigation` (Task 1), `investigationBadge` is NOT needed here (the detail shows full status), `pendingRunFocusAtom` (Task 7), `setDisposition` (already imported, supports a `note` arg).

- [ ] **Step 1: Add imports + Open-run handler + note-capable dispose**

In `frontend/app/view/agents/radarfindingdetail.tsx`:

1. Add `pendingRunFocusAtom` to the existing `./runactions` import (currently `import { pendingRunDraftAtom } from "./runactions";`):

```tsx
import { pendingRunDraftAtom, pendingRunFocusAtom } from "./runactions";
```

2. Extend the local `dispose` helper (line 56) to accept a note:

```tsx
    const dispose = (action: string, reason?: string, note?: string) =>
        fireAndForget(() => setDisposition(report.oid, finding.id, action, reason, note));
```

3. After `startInvestigation` (line 61), add:

```tsx
    const inv = finding.investigation;
    const openRun = () => {
        if (!inv) {
            return;
        }
        globalStore.set(pendingRunFocusAtom, { channelId: inv.channelid, runId: inv.runid });
        globalStore.set(model.surfaceAtom, "channels");
    };
    const stillDetected = finding.group === "new" || finding.group === "recurring";
```

- [ ] **Step 2: Render the Investigation block**

In `radarfindingdetail.tsx`, immediately before the `{/* actions */}` block (before line ~176), add:

```tsx
            {inv ? (
                <div className="rounded-md border border-border p-4">
                    <div className="mb-2 flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted">Investigation</span>
                        {inv.status === "executing" ? (
                            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-accent-soft">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-soft" />
                                Investigating…
                            </span>
                        ) : inv.status === "done" ? (
                            <span className={cn("text-[11px] font-semibold", stillDetected ? TONE_TEXT.recurring : TONE_TEXT.nolonger)}>
                                {stillDetected ? "Investigated — still detected" : "Investigated"}
                            </span>
                        ) : (
                            <span className="text-[11px] font-semibold text-muted">
                                {inv.status === "cancelled" ? "Investigation cancelled" : "Investigation failed"}
                            </span>
                        )}
                        <span className="flex-1" />
                        <button
                            type="button"
                            onClick={openRun}
                            className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-edge-strong hover:text-primary"
                        >
                            Open run
                        </button>
                    </div>
                    {inv.status === "done" ? (
                        <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-muted-foreground">
                            <span>{inv.filestouched ?? 0} {(inv.filestouched ?? 0) === 1 ? "file" : "files"}</span>
                            <span className="text-accent-soft">+{inv.addtotal ?? 0}</span>
                            <span className="text-muted">−{inv.deltotal ?? 0}</span>
                            <span>{inv.verifspass ?? 0} pass</span>
                            {(inv.verifsfail ?? 0) > 0 ? <span className={TONE_TEXT.recurring}>{inv.verifsfail} fail</span> : null}
                        </div>
                    ) : null}
                    {inv.summary ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{inv.summary}</p> : null}
                </div>
            ) : null}
```

- [ ] **Step 3: "Investigate again" label + "Dismiss (addressed by run)" button**

In `radarfindingdetail.tsx`:

1. Change the primary action label (line ~184) from the static `Start investigation` to reflect a prior investigation:

```tsx
                        {inv ? "Investigate again" : "Start investigation"}
```

2. In the Dismiss card (the `<div className="flex-1 rounded-md border border-border p-3">` for Dismiss, after the `DISMISS_REASONS.map(...)` button group closes, ~line 219), add a run-linked dismiss shown only when a done investigation exists:

```tsx
                            {inv?.status === "done" ? (
                                <button
                                    type="button"
                                    onClick={() => dispose("dismiss", "Resolved by investigation", `addressed by run ${inv.runid}`)}
                                    className="mt-2 rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground hover:border-edge-strong hover:text-primary"
                                >
                                    Addressed by run
                                </button>
                            ) : null}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verify (dev app, best-effort)**

With the dev app running and a finding that has an investigation (see the note below): the detail shows the Investigation block with the correct status pill; a `done` one shows files/±/verifs and an "Open run" button that navigates to Channels and focuses the run; the primary action reads "Investigate again"; a `done` investigation shows the "Addressed by run" dismiss. Reproducing a live run round-trip over CDP may be impractical — if so, rely on unit tests and mark unverified with that reason. Never `Page.reload`.

---

## Task 9: Finding-list badge — depends on Task 6

**Files:**
- Modify: `frontend/app/view/agents/radarfindingslist.tsx`

**Interfaces:**
- Consumes: `investigationBadge` (Task 6).

- [ ] **Step 1: Import the helper**

In `frontend/app/view/agents/radarfindingslist.tsx`, add `investigationBadge` to the existing `./radarmodel` import block (lines 7-16):

```tsx
    investigationBadge,
```

- [ ] **Step 2: Render the badge in the finding row meta line**

In `radarfindingslist.tsx`, inside the `items.map((f) => { ... })` body, compute the badge next to `const fmeta = groupMeta(f.group);` (~line 86):

```tsx
                                  const badge = investigationBadge(f);
```

Then in the meta row (the `<div className="flex items-center gap-2 font-mono text-[10px] text-muted">` at ~line 114), insert the badge just before the trailing `<span className="flex-1" />`:

```tsx
                                              {badge ? (
                                                  <span
                                                      className={cn(
                                                          badge === "still-detected"
                                                              ? TONE_TEXT.recurring
                                                              : badge === "investigating"
                                                                ? "text-accent-soft"
                                                                : TONE_TEXT.nolonger
                                                      )}
                                                  >
                                                      {badge === "still-detected"
                                                          ? "still detected"
                                                          : badge === "investigating"
                                                            ? "investigating"
                                                            : "investigated"}
                                                  </span>
                                              ) : null}
```

(`TONE_TEXT` and `cn` are already imported in this file.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verify (dev app, best-effort)**

A finding with an active investigation shows "investigating"; a completed one shows "investigated" (muted/nolonger tone) or "still detected" (recurring/warn tone) if the finding is still open. Same live-reproduction caveat as Task 8 Step 5.

---

## Final verification (after all tasks)

- [ ] `go test ./pkg/reporadar/ ./pkg/jarvis/` → PASS (new: reconcile carry-forward, `InvestigationFromRun`, `RecordInvestigation`).
- [ ] `task build:backend` → exit 0.
- [ ] `npx vitest run frontend/app/view/agents/radarmodel.test.ts` → PASS (new: `investigationBadge`).
- [ ] `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
- [ ] `task generate` produced the `RadarInvestigation` TS binding (Task 1); generated files not hand-edited.
- [ ] Update `docs/deferred.md`: the `RunRadarOrigin` "v1 stores it but does not act on it" note is now resolved — the forward loop is wired (create/done/cancel → finding investigation record; reconcile carries it; detail + list surface it; "Dismiss (addressed by run)" closes it). Note the wtype.go comment on `RunRadarOrigin` should be updated to reflect that it is now acted upon.
- [ ] Do NOT commit; the user batches commits and approves them. Spec + plan fold into the feature commit.

## Self-Review

- **Spec coverage:** Item A (data model) → Task 1; Item B (`RecordInvestigation` + reconcile carry) → Tasks 2+4; the `investigationFromEvidence` mapper the spec references → Task 3 (`InvestigationFromRun`); Item C (three/four server hooks) → Task 5 (create/advance-seal/lazy-seal/cancel); Item D (detail block, Investigate-again, list badge, Open-run, Dismiss-addressed-by-run) → Tasks 6+7+8+9. Core constraint (never auto-resolve) honored — no task mutates `Group`. Non-goals (no history, no new group, no rescan trigger, local scope, no proactive backfill) carry no task.
- **Placeholder scan:** every code step shows actual code; every test step shows real assertions; no TBD/"handle errors"/"similar to Task N".
- **Type consistency:** `RadarInvestigation` json tags (`runid`/`channelid`/`status`/`startedts`/`completedts`/`summary`/`filestouched`/`addtotal`/`deltotal`/`verifspass`/`verifsfail`) are used verbatim in the Go struct (Task 1), the mapper (Task 3), and the FE (`inv.channelid`/`inv.runid`/`inv.filestouched`/… Tasks 8-9). `InvestigationFromRun(run, channelId, status, ts)` signature identical in Tasks 3 and 5. `RecordInvestigation(ctx, projectPath, fingerprint, inv)` identical in Tasks 4 and 5. `investigationBadge(f) → "investigating"|"investigated"|"still-detected"|null` identical in Tasks 6, 8 (uses `inv.status`/`stillDetected` directly, not the helper), and 9. `pendingRunFocusAtom: {channelId, runId} | null` identical in Tasks 7 and 8. `setDisposition(reportId, findingId, action, reason?, note?)` matches the existing store signature (note arg already supported).
- **Conflict check:** `investigation.go` (new) Tasks 3→4 sequenced; `wshserver.go` all in Task 5; frontend files disjoint per task (`radarmodel.ts` T6, `runactions.ts`+`channelssurface.tsx` T7, `radarfindingdetail.tsx` T8, `radarfindingslist.tsx` T9). Backend types (T1) + regenerate precede all FE tasks that read `finding.investigation`.
