# "Start investigation" Handoff & Pending Run Composer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Radar's finding→Run handoff end-to-end — "Start investigation" opens a prefilled, editable Run composer in Channels→Runs, and the started Run carries structured radar origin.

**Architecture:** Add an optional structured `RadarOrigin` to the `Run` wave object and to `CreateRunCommand` (Go, no migration). On the frontend, a pure `radarmodel` builds a `PendingRunDraft`; an ephemeral `pendingRunDraftAtom` carries it from the Radar surface to the Channels surface, which resolves the finding's project to a channel, switches to the Runs view, and renders the generalized "Start a run" panel prefilled from the draft. Starting the run threads the origin through `createRun`.

**Tech Stack:** Go (wavesrv, wshrpc), TypeScript/React 19 + jotai, vitest, Task (codegen), CDP visual verification.

**Spec:** `docs/superpowers/specs/2026-07-11-radar-start-investigation-composer-design.md`

## Global Constraints

- Never hand-edit generated files. Go is the source of truth; run `task generate` after any wshrpc/waveobj type change (regenerates `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts`).
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (never `npx tsc` — it stack-overflows on this repo). Baseline is clean (exit 0); any error it reports is yours.
- Frontend: Tailwind + existing `@theme` tokens only, never raw colors. Match surrounding conventions in `frontend/app/view/agents/`.
- Pure model logic (grouping, goal composition, channel resolution) lives in `.ts` modules with no jotai/RPC/React and is unit-tested; impure wiring (atoms, RPC wrappers, React) is verified via CDP.
- Comments only for "why," lowercase, only when necessary.
- Do not add features beyond this plan. Finding-linked outcomes (acting on the origin) remain deferred.
- Commit after each task. Conventional commits (`type(scope): description`). Do NOT add a co-author. Do NOT push. Commit only — the human approves the final integration.

---

### Task 1: Backend — structured `RadarOrigin` on `Run` + `CreateRunCommand`

**Files:**
- Modify: `pkg/waveobj/wtype.go` (add `RunRadarOrigin`, add `Run.RadarOrigin`)
- Modify: `pkg/wshrpc/wshrpctypes.go:803-810` (`CommandCreateRunData`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1943-1966` (`CreateRunCommand`)
- Create: `pkg/waveobj/wtype_test.go` (JSON round-trip test)
- Regenerate (do not hand-edit): `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces (Go): `waveobj.RunRadarOrigin{ ReportID, FindingID, Fingerprint string }`; `waveobj.Run.RadarOrigin *RunRadarOrigin`; `wshrpc.CommandCreateRunData.RadarOrigin *waveobj.RunRadarOrigin`.
- Produces (generated TS): `RunRadarOrigin = { reportid: string; findingid: string; fingerprint: string }`; `Run.radarorigin?: RunRadarOrigin`; `CommandCreateRunData.radarorigin?: RunRadarOrigin`.

- [ ] **Step 1: Write the failing test** — JSON round-trip proving `RadarOrigin` survives and is omitted when nil (this is the no-migration guarantee: an existing run with no origin must still deserialize).

Create `pkg/waveobj/wtype_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRunRadarOriginRoundTrips(t *testing.T) {
	in := Run{
		ID:   "r1",
		Goal: "investigate",
		RadarOrigin: &RunRadarOrigin{
			ReportID:    "report-1",
			FindingID:   "finding-1",
			Fingerprint: "fp-9",
		},
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out Run
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.RadarOrigin == nil {
		t.Fatalf("radar origin lost on round-trip")
	}
	if out.RadarOrigin.ReportID != "report-1" || out.RadarOrigin.FindingID != "finding-1" || out.RadarOrigin.Fingerprint != "fp-9" {
		t.Errorf("origin ids not preserved: %+v", out.RadarOrigin)
	}
}

func TestRunOmitsRadarOriginWhenNil(t *testing.T) {
	b, err := json.Marshal(Run{ID: "r1", Goal: "g"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "radarorigin") {
		t.Errorf("nil origin must be omitted, got %s", b)
	}
	// an old run (no origin key) must deserialize with a nil origin
	var out Run
	if err := json.Unmarshal([]byte(`{"id":"r1","goal":"g","workspaceid":"w","projectpath":"/p","status":"done","phases":[],"createdts":1}`), &out); err != nil {
		t.Fatalf("legacy unmarshal: %v", err)
	}
	if out.RadarOrigin != nil {
		t.Errorf("legacy run must have nil origin, got %+v", out.RadarOrigin)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/waveobj/ -run TestRunRadarOrigin -v`
Expected: FAIL — `RunRadarOrigin` undefined and `Run` has no `RadarOrigin` field (compile error).

- [ ] **Step 3: Add the type and field**

In `pkg/waveobj/wtype.go`, immediately after the `Run` struct (ends at line 246), add:

```go
// RunRadarOrigin links a Run back to the Radar finding it was started from. Carried for a future
// finding-linked-outcome feature; v1 stores it but does not act on it.
type RunRadarOrigin struct {
	ReportID    string `json:"reportid"`
	FindingID   string `json:"findingid"`
	Fingerprint string `json:"fingerprint"`
}
```

In the `Run` struct (line 235-246), add one field after `Phases`:

```go
	Phases      []RunPhase      `json:"phases"`
	RadarOrigin *RunRadarOrigin `json:"radarorigin,omitempty"` // set when started from a Radar finding
	CreatedTs   int64           `json:"createdts"`
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/waveobj/ -run TestRunRadarOrigin -v`
Expected: PASS (both tests).

- [ ] **Step 5: Add `RadarOrigin` to the RPC command and wire it in `CreateRunCommand`**

In `pkg/wshrpc/wshrpctypes.go`, `CommandCreateRunData` (line 803-810), add one field:

```go
type CommandCreateRunData struct {
	ChannelId   string                   `json:"channelid"`
	WorkspaceId string                   `json:"workspaceid"` // where phase-worker tabs are created
	Goal        string                   `json:"goal"`
	PlaybookId  string                   `json:"playbookid,omitempty"`
	Mode        string                   `json:"mode,omitempty"`        // pipeline | orchestrator (empty = resolved profile default)
	PlanGate    *bool                    `json:"plangate,omitempty"`    // orchestrator plan gate; nil = resolved profile default
	RadarOrigin *waveobj.RunRadarOrigin  `json:"radarorigin,omitempty"` // set when started from a Radar finding
}
```

In `pkg/wshrpc/wshserver/wshserver.go`, `CreateRunCommand`, set the origin on the run right after it is created (line 1954). `jarvis.NewRun`'s signature is intentionally left unchanged:

```go
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, resolved.Principles, mode, playbook, time.Now().UnixMilli())
	run.RadarOrigin = data.RadarOrigin // nil for normal runs; set only from a Radar handoff
	if err := wstore.AppendRun(ctx, data.ChannelId, run); err != nil {
```

- [ ] **Step 6: Verify the backend still builds and all package tests pass**

Run: `go build ./... && go test ./pkg/waveobj/ ./pkg/jarvis/ ./pkg/wstore/`
Expected: build succeeds; all tests PASS (no regression in the existing run/channel tests).

- [ ] **Step 7: Regenerate bindings**

Run: `task generate`
Then confirm the generated output (do not hand-edit): `frontend/types/gotypes.d.ts` now contains a `RunRadarOrigin` type, `Run.radarorigin?: RunRadarOrigin`, and `CommandCreateRunData.radarorigin?: RunRadarOrigin`.

Run: `grep -n "RunRadarOrigin\|radarorigin" frontend/types/gotypes.d.ts`
Expected: matches for the new type and both optional fields.

- [ ] **Step 8: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/waveobj/wtype_test.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(runs): carry structured radar origin on Run + CreateRun"
```

---

### Task 2: Frontend pure model — `composeRunGoal`, `PendingRunDraft`, `toPendingRunDraft`

**Files:**
- Modify: `frontend/app/view/agents/radarmodel.ts` (add the `PendingRunDraft` type + two pure functions)
- Modify: `frontend/app/view/agents/radarmodel.test.ts` (add tests)

**Interfaces:**
- Consumes: `buildRunDraft(report, finding): RadarRunDraft` (existing, `radarmodel.ts:125`); `RadarFinding`, `RadarReport` (generated types).
- Produces:
  - `interface PendingRunDraft { goal: string; files: string[]; evidenceRefs: string[]; radarOrigin?: { reportid: string; findingid: string; fingerprint: string }; projectPath?: string }`
  - `composeRunGoal(finding: RadarFinding): string`
  - `toPendingRunDraft(report: RadarReport, finding: RadarFinding): PendingRunDraft`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/radarmodel.test.ts` (extend the existing import from `./radarmodel` to also import `composeRunGoal` and `toPendingRunDraft`):

```ts
describe("composeRunGoal", () => {
    it("includes the mission, affected files, and evidence refs", () => {
        const f = finding("finding-1", "new", {
            mission: "add tests for the coupon boundary",
            files: ["src/coupon.ts", "src/coupon.test.ts"],
            signalids: ["s1", "s2"],
        });
        const goal = composeRunGoal(f);
        expect(goal).toContain("add tests for the coupon boundary");
        expect(goal).toContain("src/coupon.ts");
        expect(goal).toContain("src/coupon.test.ts");
        expect(goal).toContain("s1");
        expect(goal).toContain("s2");
    });

    it("omits the files and evidence sections when empty", () => {
        const f = finding("finding-2", "new", { mission: "look into X", files: [], signalids: [] });
        expect(composeRunGoal(f)).toBe("look into X");
    });
});

describe("toPendingRunDraft", () => {
    it("maps origin ids distinctly and carries the project path", () => {
        const r = report({ oid: "report-1", projectpath: "/repo/demo" });
        const f = finding("finding-1", "new", {
            fingerprint: "fp-9",
            mission: "add tests",
            files: ["a.ts"],
            signalids: ["s1"],
        });
        const draft = toPendingRunDraft(r, f);
        expect(draft.radarOrigin).toEqual({ reportid: "report-1", findingid: "finding-1", fingerprint: "fp-9" });
        expect(draft.files).toEqual(["a.ts"]);
        expect(draft.evidenceRefs).toEqual(["s1"]);
        expect(draft.projectPath).toBe("/repo/demo");
        expect(draft.goal).toContain("add tests");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts -t "composeRunGoal"`
Expected: FAIL — `composeRunGoal` / `toPendingRunDraft` are not exported.

- [ ] **Step 3: Implement the pure helpers**

In `frontend/app/view/agents/radarmodel.ts`, after `buildRunDraft` (ends at line 135), add:

```ts
// The composer draft handed from a Radar finding to the Channels Run composer. Origin-agnostic on
// purpose: the composer never imports Radar concepts, it just renders goal + optional context + origin.
export interface PendingRunDraft {
    goal: string; // prefilled, editable
    files: string[]; // context, read-only in the composer
    evidenceRefs: string[]; // context, read-only in the composer
    radarOrigin?: { reportid: string; findingid: string; fingerprint: string };
    projectPath?: string; // resolves the target channel on landing
}

// composeRunGoal turns a finding into an editable goal: the suggested mission, then (when present) the
// affected files and the evidence signal ids, so the user reviews the full context in one text field.
export function composeRunGoal(finding: RadarFinding): string {
    const parts = [finding.mission];
    const files = finding.files ?? [];
    if (files.length > 0) {
        parts.push(`\nAffected files:\n${files.map((f) => `- ${f}`).join("\n")}`);
    }
    const refs = finding.signalids ?? [];
    if (refs.length > 0) {
        parts.push(`\nEvidence: ${refs.join(", ")}`);
    }
    return parts.join("\n");
}

export function toPendingRunDraft(report: RadarReport, finding: RadarFinding): PendingRunDraft {
    const d = buildRunDraft(report, finding);
    return {
        goal: composeRunGoal(finding),
        files: d.files,
        evidenceRefs: d.evidenceRefs,
        radarOrigin: { reportid: d.reportId, findingid: d.findingId, fingerprint: d.fingerprint },
        projectPath: report.projectpath,
    };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: PASS (all radarmodel tests, existing + new).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/radarmodel.ts frontend/app/view/agents/radarmodel.test.ts
git commit -m "feat(radar): pure PendingRunDraft + goal composition for the handoff"
```

---

### Task 3: Frontend shared contract — `pendingRunDraftAtom` + `createRun` origin option

**Files:**
- Modify: `frontend/app/view/agents/runactions.ts`

**Interfaces:**
- Consumes: `PendingRunDraft` (Task 2, `radarmodel.ts`); `RpcApi.CreateRunCommand` (generated).
- Produces:
  - `pendingRunDraftAtom` — `PrimitiveAtom<PendingRunDraft | null>` (default `null`). The cross-surface signal: Radar sets it, Channels consumes it.
  - `createRun(channelId, goal, opts?)` — `opts` gains `radarOrigin?: { reportid: string; findingid: string; fingerprint: string }`, threaded into `CommandCreateRunData.radarorigin`.

- [ ] **Step 1: Add the atom and extend `createRun`**

This task is thin impure glue (a jotai atom + an RPC field); it has no dedicated unit test and is verified end-to-end in Task 7 (CDP). In `frontend/app/view/agents/runactions.ts`:

Add the import for the type and `atom`, near the top:

```ts
import { atom, type PrimitiveAtom } from "jotai";
import type { PendingRunDraft } from "./radarmodel";
```

After the imports / before `createRun`, add the shared atom:

```ts
// The pending Run draft handed from Radar's "Start investigation" to the Channels Run composer. Ephemeral
// (lost on reload, which is fine for a review step); cleared on explicit Start or Discard.
export const pendingRunDraftAtom = atom<PendingRunDraft | null>(null) as PrimitiveAtom<PendingRunDraft | null>;
```

Extend `createRun` (line 13-27) to accept and forward the origin:

```ts
export async function createRun(
    channelId: string,
    goal: string,
    opts?: { mode?: string; planGate?: boolean; radarOrigin?: { reportid: string; findingid: string; fingerprint: string } }
): Promise<Run> {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const rtn = await RpcApi.CreateRunCommand(TabRpcClient, {
        channelid: channelId,
        workspaceid: workspaceId,
        goal,
        mode: opts?.mode,
        plangate: opts?.planGate,
        radarorigin: opts?.radarOrigin,
    });
    return rtn.run;
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (`radarorigin` is a known field on `CommandCreateRunData` after Task 1's regen; if tsc reports it as unknown, Task 1's `task generate` did not run — fix that first.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/runactions.ts
git commit -m "feat(runs): pending-run-draft atom + radar origin on createRun"
```

---

### Task 4: Radar — activate "Start investigation"

**Files:**
- Modify: `frontend/app/view/agents/radarsurface.tsx:73-74` (pass `model` down)
- Modify: `frontend/app/view/agents/radarfindingdetail.tsx` (enable the button, wire onClick)

**Interfaces:**
- Consumes: `toPendingRunDraft` (Task 2), `pendingRunDraftAtom` (Task 3), `AgentsViewModel.surfaceAtom` (`agents.tsx:68`), `globalStore` (`@/app/store/jotaiStore`).
- Produces: clicking "Start investigation" sets `pendingRunDraftAtom` and switches `surfaceAtom` to `"channels"`.

This task is UI wiring; it is verified in Task 7 (CDP), not by a unit test.

- [ ] **Step 1: Pass `model` into the detail pane**

In `frontend/app/view/agents/radarsurface.tsx`, change the `RadarFindingDetail` render (line 73-74) to pass the model:

```tsx
                        {selectedFinding ? (
                            <RadarFindingDetail model={model} report={report} finding={selectedFinding} />
                        ) : (
```

- [ ] **Step 2: Wire the button in `radarfindingdetail.tsx`**

Update the imports at the top of `frontend/app/view/agents/radarfindingdetail.tsx`:

```tsx
import { fireAndForget } from "@/util/util";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "./agents";
import { toPendingRunDraft } from "./radarmodel";
import { pendingRunDraftAtom } from "./runactions";
import { setDisposition } from "./radarstore";
```

Change the component signature (line 25) to accept `model`:

```tsx
export function RadarFindingDetail({ model, report, finding }: { model: AgentsViewModel; report: RadarReport; finding: RadarFinding }) {
```

Replace the `draft` line (line 30) and the disabled button block (line 80-90) with an active handoff. Remove the old `const draft = buildRunDraft(...)` line and the `buildRunDraft` import if now unused (keep it only if still referenced elsewhere in the file — it is not). New handler + button:

```tsx
    const startInvestigation = () => {
        globalStore.set(pendingRunDraftAtom, toPendingRunDraft(report, finding));
        globalStore.set(model.surfaceAtom, "channels");
    };
```

```tsx
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={startInvestigation}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background hover:bg-accent/90"
                >
                    Start investigation
                </button>
```

(The dismiss/suppress buttons below it are unchanged.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/radarsurface.tsx frontend/app/view/agents/radarfindingdetail.tsx
git commit -m "feat(radar): activate Start investigation handoff"
```

---

### Task 5: Channels — resolve the target channel + consume the draft

**Files:**
- Modify: `frontend/app/view/agents/channelderive.ts` (add pure `resolveTargetChannel`)
- Modify: `frontend/app/view/agents/channelderive.test.ts` (test it)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (consume `pendingRunDraftAtom`, land on Runs)

**Interfaces:**
- Consumes: `pendingRunDraftAtom` (Task 3); `Channel` (generated); the existing `channelssurface` state (`channelsAtom`, `selectChannel`, `setView`, `setPicking`, `RunsView`).
- Produces: `resolveTargetChannel(channels: Channel[], projectPath: string | undefined): Channel | undefined` — the first channel whose `projectpath` matches (trailing-slash-insensitive); `undefined` if none.

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/channelderive.test.ts` (add `resolveTargetChannel` to the import from `./channelderive`):

```ts
const ch = (oid: string, projectpath: string): Channel => ({ oid, projectpath } as Channel);

describe("resolveTargetChannel", () => {
    it("returns the first channel matching the project path", () => {
        const channels = [ch("c1", "/repo/a"), ch("c2", "/repo/b"), ch("c3", "/repo/b")];
        expect(resolveTargetChannel(channels, "/repo/b")?.oid).toBe("c2");
    });
    it("ignores a trailing slash on either side", () => {
        expect(resolveTargetChannel([ch("c1", "/repo/a/")], "/repo/a")?.oid).toBe("c1");
        expect(resolveTargetChannel([ch("c1", "/repo/a")], "/repo/a/")?.oid).toBe("c1");
    });
    it("returns undefined when nothing matches or the path is missing", () => {
        expect(resolveTargetChannel([ch("c1", "/repo/a")], "/repo/z")).toBeUndefined();
        expect(resolveTargetChannel([ch("c1", "/repo/a")], undefined)).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts -t "resolveTargetChannel"`
Expected: FAIL — `resolveTargetChannel` is not exported.

- [ ] **Step 3: Implement the pure resolver**

In `frontend/app/view/agents/channelderive.ts`, add near the other channel helpers (e.g. after `filterChannels`):

```ts
// resolveTargetChannel finds the channel a Radar finding should hand off to: the first whose bound
// project path matches. Paths come from the same project registry, so an exact (trailing-slash-
// insensitive) compare is sufficient — no fuzzy matching.
export function resolveTargetChannel(channels: Channel[], projectPath: string | undefined): Channel | undefined {
    if (!projectPath) {
        return undefined;
    }
    const norm = (p: string) => p.replace(/[/\\]+$/, "");
    const want = norm(projectPath);
    return channels.find((c) => c.projectpath != null && norm(c.projectpath) === want);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Consume the draft in `channelssurface.tsx`**

Add imports:

```tsx
import { pendingRunDraftAtom } from "./runactions";
import { resolveTargetChannel } from "./channelderive";
```

Inside `ChannelsSurface` (after the existing `useAtomValue` reads, ~line 884), read the draft:

```tsx
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
```

Add a one-shot landing effect keyed to the draft identity, so a new draft switches to the Runs view once (and never re-hijacks normal browsing). Place it after the existing effects (~line 934):

```tsx
    // land a Radar handoff: on a NEW pending draft, resolve its project to a channel, select it, and
    // switch to the Runs view once. Keyed to the finding id so it fires per handoff, not per render.
    const landedDraftRef = useRef<string | null>(null);
    useEffect(() => {
        const key = pendingDraft?.radarOrigin?.findingid ?? null;
        if (!key || landedDraftRef.current === key) {
            return;
        }
        landedDraftRef.current = key;
        const target = resolveTargetChannel(channels ?? [], pendingDraft?.projectPath);
        if (target) {
            fireAndForget(() => selectChannel(target.oid));
            setView("runs");
        } else {
            setPicking(true); // no channel for this project yet — offer the create flow; draft persists
        }
    }, [pendingDraft, channels]);
```

Pass the draft into the Runs view. Change the `RunsView` render (line 1184-1185):

```tsx
                        {view === "runs" && active ? (
                            <RunsView model={model} channel={active} agents={agents} runMode={runMode} planGate={planGate} pendingDraft={pendingDraft} />
                        ) : (
```

(`useRef` is already imported in this file. `channels` may be `null` while loading — the effect guards with `channels ?? []`.)

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (`RunsView` gains a required `pendingDraft` prop in Task 6; until then tsc flags the new prop as unknown — that is expected and resolved by Task 6. If executing strictly task-by-task, accept this one tsc error here and re-run the typecheck at the end of Task 6.)

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/channelderive.ts frontend/app/view/agents/channelderive.test.ts frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(channels): resolve target channel + consume radar run draft"
```

---

### Task 6: RunsView — generalized composer (prefilled, editable, origin banner, Discard)

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (`RunsView` accepts `pendingDraft`; enrich the "Start a run" panel)

**Interfaces:**
- Consumes: `PendingRunDraft` (Task 2, `radarmodel.ts`); `pendingRunDraftAtom` (Task 3); `createRun` with `radarOrigin` (Task 3).
- Produces: `RunsView` gains a `pendingDraft: PendingRunDraft | null` prop. When set, the new-run panel is forced open, the goal is prefilled and editable, an origin banner + files + evidence render, Start threads the origin and clears the atom, Discard clears the atom.

This task is UI; behavior is verified in Task 7 (CDP).

- [ ] **Step 1: Extend the `RunsView` signature and prop type**

In `frontend/app/view/agents/runssurface.tsx`, add imports:

```tsx
import { useSetAtom } from "jotai";
import type { PendingRunDraft } from "./radarmodel";
import { approveGate, cancelRun, createRun, pendingRunDraftAtom, sendBackGate } from "./runactions";
```

(The existing `import { approveGate, cancelRun, createRun, sendBackGate } from "./runactions";` at line 26 is replaced by the line above. `useAtomValue` is already imported from jotai; add `useSetAtom` to that import if not present.)

Change the `RunsView` props (line 658-670):

```tsx
export function RunsView({
    model,
    channel,
    agents,
    runMode,
    planGate,
    pendingDraft,
}: {
    model: AgentsViewModel;
    channel: Channel;
    agents: AgentVM[];
    runMode: string;
    planGate: boolean;
    pendingDraft: PendingRunDraft | null;
}) {
```

- [ ] **Step 2: Seed the composer from the draft and force the new-run panel when a draft is present**

Add the setter near the other hooks (after line 684):

```tsx
    const setPendingDraft = useSetAtom(pendingRunDraftAtom);
```

When a draft arrives, seed the goal textarea and clear the active-run selection so the "Start a run" panel shows. Add an effect keyed to the draft identity (after the steer-reset effect, ~line 701):

```tsx
    // a Radar handoff seeds the composer: prefill the goal and drop to the new-run panel. Keyed to the
    // finding id so editing the goal afterwards does not get overwritten on every render.
    useEffect(() => {
        if (pendingDraft) {
            setDraft(pendingDraft.goal);
            setActiveRunId(undefined);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingDraft?.radarOrigin?.findingid]);
```

- [ ] **Step 3: Thread the origin through Start and clear the atom**

Update `startRun` (line 779-789):

```tsx
    const startRun = () => {
        const goal = draft.trim();
        if (!goal) {
            return;
        }
        setDraft("");
        const radarOrigin = pendingDraft?.radarOrigin;
        setPendingDraft(null); // consumed
        fireAndForget(async () => {
            const created = await createRun(channel.oid, goal, { mode: runMode, planGate, radarOrigin });
            setActiveRunId(created.id);
        });
    };
```

- [ ] **Step 4: Render the origin context in the "Start a run" panel**

In the empty-state branch (the `else` at line 896-912, `<div className="mx-auto mt-10 ...">`), render a Radar context block above the `ComposerShell` and a Discard control, shown only when `pendingDraft` is set. Replace that block with:

```tsx
                        ) : (
                            <div className="mx-auto mt-10 w-full max-w-[620px]">
                                <div className="mb-1 text-center text-[17px] font-bold text-primary">
                                    {pendingDraft ? "Start investigation" : "Start a run"}
                                </div>
                                <div className="mb-5 text-center text-[13px] text-muted">
                                    {pendingDraft ? "Review the draft, then start it" : `Give Jarvis a goal for #${channel.name}`}
                                </div>
                                {pendingDraft ? (
                                    <div className="mb-3 rounded-[10px] border border-accent/30 bg-accentbg/15 px-3.5 py-3">
                                        <div className="mb-2 flex items-center gap-2">
                                            <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-accent-soft">
                                                From Radar finding
                                            </span>
                                            <span className="flex-1" />
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setPendingDraft(null);
                                                    setDraft("");
                                                }}
                                                className="rounded-[6px] border border-edge-mid px-2 py-0.5 font-mono text-[10px] text-muted hover:border-edge-strong hover:text-secondary"
                                            >
                                                Discard
                                            </button>
                                        </div>
                                        {pendingDraft.files.length > 0 ? (
                                            <div className="mb-1.5 flex flex-wrap gap-1.5">
                                                {pendingDraft.files.map((f) => (
                                                    <span key={f} className="rounded-full border border-edge-mid px-2 py-0.5 font-mono text-[10.5px] text-muted">
                                                        {f}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : null}
                                        {pendingDraft.evidenceRefs.length > 0 ? (
                                            <div className="font-mono text-[10.5px] text-muted">
                                                {pendingDraft.evidenceRefs.length} evidence signal
                                                {pendingDraft.evidenceRefs.length === 1 ? "" : "s"}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                                <ComposerShell
                                    value={draft}
                                    onChange={setDraft}
                                    onSubmit={startRun}
                                    autoFocus
                                    placeholder="Give Jarvis a goal to start a run…"
                                    sendLabel="Start run ⏎"
                                    footerLeft={
                                        <span className="font-mono text-[11.5px] text-ink-mid">{composerSummary(runMode, planGate)}</span>
                                    }
                                />
                            </div>
                        )}
```

- [ ] **Step 5: Typecheck the full frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (this also clears the expected Task 5 Step 6 error, since `RunsView` now declares `pendingDraft`).

- [ ] **Step 6: Run the full frontend test suite**

Run: `npx vitest run`
Expected: PASS (no regressions; the new radarmodel + channelderive tests pass).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/runssurface.tsx
git commit -m "feat(runs): generalized run composer with radar handoff prefill"
```

---

### Task 7: End-to-end visual verification (CDP) + close the deferred item

**Files:**
- Modify: `docs/deferred.md` (mark the item resolved)

**Interfaces:**
- Consumes: the full feature (Tasks 1-6) running in the dev app.

- [ ] **Step 1: Launch the dev app**

Per the memory notes, the dev server must keep wavesrv's stdin open: `tail -f /dev/null | task dev` (and free port 5174 first if a prior dev tree left Vite's node bound). Wait for the Vite app inside WebView2 on `http://localhost:5174/` and CDP on `:9222`.

- [ ] **Step 2: Inject a Radar report with findings**

Use the dev scenario driver exposed by `radarsurface.tsx` (`window.__setRadarScenario`) or `scripts/inject-live-agents.mjs` to land the Radar surface in the `results` state with at least one finding and at least one channel bound to that finding's project. (If no channel exists for the project, that is the no-channel path — verify it separately in Step 5.)

- [ ] **Step 3: Verify the handoff**

Drive via CDP (`node scripts/cdp-shot.mjs out.png` to capture; `Runtime.evaluate` / `Input.dispatchKeyEvent` to interact):
- On the Radar finding detail, click **Start investigation**.
- Confirm the app switches to the Channels surface, the matching channel is selected, the view is **Runs**, and the "Start investigation" panel shows the prefilled editable goal, the "From Radar finding" banner, affected-files chips, and the evidence-count line.
- Screenshot it.

Expected: the composer is prefilled and editable; the goal contains the finding's mission.

- [ ] **Step 4: Verify Start + Discard**

- Edit the goal slightly, click **Start run**; confirm a new run tab appears and the composer clears.
- Trigger another handoff, then click **Discard**; confirm the composer returns to the blank "Start a run" state and the draft is gone.

Expected: Start creates a run; Discard clears the pending draft.

- [ ] **Step 5: Verify the no-matching-channel path**

- Trigger **Start investigation** for a finding whose project has no channel; confirm the new-channel picker opens and the draft persists (creating + selecting a channel then shows the prefilled composer).

Expected: picker opens; draft is not lost.

- [ ] **Step 6: Mark the deferred item resolved**

In `docs/deferred.md`, under `## Repo Radar — "Start investigation" handoff composer (2026-07-11)`, add a resolution note at the top of that section (mirroring the existing `> **Resolved …**` blockquote style used by other entries):

```markdown
> **Resolved 2026-07-11 (radar-start-investigation-composer):** the handoff is wired end-to-end.
> "Start investigation" builds a `PendingRunDraft` (`radarmodel.toPendingRunDraft`), sets the ephemeral
> `pendingRunDraftAtom`, and switches to Channels, which resolves the finding's project to a channel
> (`resolveTargetChannel`), lands on the Runs view, and renders the generalized "Start a run" panel
> prefilled + editable with a Radar-origin banner. Starting threads structured origin
> (`Run.RadarOrigin` = report/finding/fingerprint) through `createRun` → `CreateRunCommand`; no DB
> migration (optional field on the JSON-embedded Run). Acting on the origin (finding-linked outcomes)
> remains deferred per the parent spec.
```

- [ ] **Step 7: Commit**

```bash
git add docs/deferred.md
git commit -m "docs(deferred): close radar Start-investigation composer"
```

---

## Self-review notes

- **Spec coverage:** structured origin (Task 1); pure draft + goal composition (Task 2); shared atom + createRun option (Task 3); Radar activation + navigation (Task 4); channel resolution + landing (Task 5); generalized prefilled composer + Discard + origin-on-start (Task 6); testing + no-channel edge + deferred close (Tasks 2/5/7). All spec sections map to a task.
- **No-migration claim** is verified by the Task 1 round-trip + legacy-unmarshal test, not merely asserted.
- **Type consistency:** `PendingRunDraft` (Task 2) is consumed unchanged in Tasks 3/5/6; `radarOrigin` shape `{ reportid, findingid, fingerprint }` matches the generated `RunRadarOrigin` (lowercased json tags) and is identical across `createRun`, `toPendingRunDraft`, and `CommandCreateRunData`.
- **Honest coverage:** Tasks 3/4/6 are impure UI/wiring with no unit tests; they are explicitly verified in the Task 7 CDP pass. Task 5 Step 6 has a deliberate, documented transient tsc error resolved in Task 6 Step 5.
