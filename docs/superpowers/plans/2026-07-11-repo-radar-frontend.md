# Repo Radar Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Repo Radar cockpit surface — scan a registered repo, review grouped evidence-backed findings, and triage them — against the already-shipped backend.

**Architecture:** A new `radar` surface in the cockpit shell. A pure model (`radarmodel.ts`) does all grouping/counting/classification/draft-building and is unit-tested. A store (`radarstore.ts`) owns scope + report state, wraps the five radar RPC commands, and streams a live scan via WOS. `radarsurface.tsx` + three small components render the eight scan states, master/detail results, and dispositions. A dev fixture (`radardevmock.ts`) drives CDP visual verification.

**Tech Stack:** React 19, jotai, Tailwind 4 + `@theme` tokens, vitest, wshrpc (generated `RpcApi`), WOS. Backend RPCs already live: `StartRadarScanCommand`, `CancelRadarScanCommand`, `ListRadarReportsCommand`, `SetRadarFindingDispositionCommand`, `RetryRadarClusteringCommand`.

**Spec:** `docs/superpowers/specs/2026-07-11-repo-radar-frontend-design.md` (this plan implements it). Parent feature spec: `docs/superpowers/specs/2026-07-10-repo-radar-design.md`.

## Global Constraints

- Tailwind + existing `@theme` tokens ONLY; never raw hex/rgba colors. Author token-first so light mode works (mockup is dark-only).
- All new files under `frontend/app/view/agents/`. Copyright header on every file: `// Copyright 2026, Command Line Inc.` / `// SPDX-License-Identifier: Apache-2.0`.
- Signal and source counts derive from canonical IDs, never rendered-section counts.
- Radar interpretation must be rendered visually distinct from source facts.
- Reuse the existing diff renderer; do NOT add a second diff parser.
- "Start investigation" ships **disabled** with a tooltip (handoff deferred — see `docs/deferred.md`); `buildRunDraft` still produces the payload and is unit-tested.
- Never hand-edit generated files (`wshclientapi.ts`, `gotypes.d.ts`). They already contain the radar types/commands.
- Typecheck command (tsc stack-overflows on this repo): `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0).
- Single test file: `npx vitest run frontend/app/view/agents/<file>.test.ts`.
- No jsdom render harness exists — UI tasks are verified by CDP screenshot of the live dev app, not vitest. Pure logic lives in `radarmodel.ts` and IS unit-tested.
- Do NOT commit without explicit user approval (project git policy). The "Commit" steps below stage a suggested message; run them only when the user has approved committing.

## Key types (from `frontend/types/gotypes.d.ts`, do not redefine)

```ts
type RadarReport = WaveObj & {
    projectname: string; projectpath: string; status: string; phase?: string;
    starthead?: string; endhead?: string; startdirty?: string; enddirty?: string;
    prevreportid?: string; prevhead?: string; windowstartts?: number; windowendts?: number;
    startedts: number; completedts?: number; coverage?: {[k: string]: string};
    partialsources?: string[]; fatalerror?: string; clustererror?: string;
    configuredmodel?: string; resolvedmodel?: string; payloadtokens?: number;
    totaltokens?: number; totaltokensestimated?: boolean;
    candidates?: RadarSignal[]; signals?: RadarSignal[]; findings?: RadarFinding[];
};
type RadarFinding = { id: string; fingerprint: string; group: string; riskkind: string;
    subsystem: string; boundarylabel?: string; risk: string; why: string; severity: string;
    strength: string; signalids: string[]; files: string[]; mission: string; disposition?: RadarDisposition; };
type RadarSignal = { id: string; collector: string; sourceref: string; observedts: number;
    paths?: string[]; subsystem?: string; summary: string; facts?: {[k:string]: any}; snippet?: string; contenthash: string; };
type RadarDisposition = { action: string; reason?: string; note?: string; ts: number; user?: string; evidencerev?: string; };
```

RPC (all via `RpcApi.*(TabRpcClient, data)`): `StartRadarScanCommand({projectpath}) -> {report}`, `CancelRadarScanCommand({reportid})`, `ListRadarReportsCommand({projectpath?}) -> {reports}`, `SetRadarFindingDispositionCommand({reportid, findingid, action, reason?, note?})`, `RetryRadarClusteringCommand({reportid})`.

WaveObj id field is `oid`. ORef: `WOS.makeORef("radarreport", report.oid)`.

## File structure

- Modify `frontend/app/view/agents/agents.tsx` — `SurfaceKey` union + `SURFACE_ORDER`.
- Modify `frontend/app/view/agents/navrail.tsx` — `ICON` + `ITEMS`.
- Modify `frontend/app/view/agents/cockpitshell.tsx` — render branch.
- Create `frontend/app/view/agents/radarmodel.ts` (+ `.test.ts`) — pure model.
- Create `frontend/app/view/agents/radarstore.ts` — atoms + RPC actions + WOS.
- Create `frontend/app/view/agents/radarscanstatepanel.tsx` — non-results state panels.
- Create `frontend/app/view/agents/radarfindingslist.tsx` — grouped master list.
- Create `frontend/app/view/agents/radarfindingdetail.tsx` — detail pane.
- Create `frontend/app/view/agents/radarsurface.tsx` — surface shell.
- Create `frontend/app/view/agents/radardevmock.ts` (+ `.test.ts`) — dev fixtures.

---

## Phase A — Navigation (empty tab reachable)

### Task A1: Add the `radar` surface to navigation

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (`SurfaceKey` ~line 25, `SURFACE_ORDER` ~line 36)
- Modify: `frontend/app/view/agents/navrail.tsx` (`ICON` ~line 24, `ITEMS` ~line 35, lucide import ~line 6)
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (imports ~line 11, render branch ~line 69)
- Create: `frontend/app/view/agents/radarnav.test.ts`

**Interfaces:**
- Produces: `SurfaceKey` now includes `"radar"`; `SURFACE_ORDER` includes `"radar"` after `"channels"`.

- [ ] **Step 1: Write the failing test**

`frontend/app/view/agents/radarnav.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { SURFACE_ORDER } from "./agents";
import { ITEMS } from "./navrail";

describe("radar navigation", () => {
    it("adds radar without dropping any existing surface", () => {
        for (const key of ["cockpit", "agent", "channels", "sessions", "files", "memory", "usage"]) {
            expect(SURFACE_ORDER).toContain(key);
        }
        expect(SURFACE_ORDER).toContain("radar");
    });

    it("places radar immediately after channels", () => {
        expect(SURFACE_ORDER.indexOf("radar")).toBe(SURFACE_ORDER.indexOf("channels") + 1);
    });

    it("exposes a radar nav item with a label", () => {
        const item = ITEMS.find((i) => i.key === "radar");
        expect(item?.label).toBe("Radar");
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run frontend/app/view/agents/radarnav.test.ts`
Expected: FAIL — `SURFACE_ORDER` / `ITEMS` do not contain radar.

- [ ] **Step 3: Add `radar` to `SurfaceKey` and `SURFACE_ORDER`**

In `agents.tsx`, extend the union (line ~25-33):

```ts
export type SurfaceKey =
    | "cockpit"
    | "agent"
    | "channels"
    | "radar"
    | "sessions"
    | "files"
    | "memory"
    | "usage"
    | "settings";
```

And `SURFACE_ORDER` (line ~36-44):

```ts
export const SURFACE_ORDER: SurfaceKey[] = [
    "cockpit",
    "agent",
    "channels",
    "radar",
    "sessions",
    "files",
    "memory",
    "usage",
];
```

- [ ] **Step 4: Add the nav rail icon + item**

In `navrail.tsx`, add `Radar` to the lucide import (line ~6-15, keep alphabetical-ish with the others):

```ts
import {
    Bot,
    Gauge,
    GitCompare,
    LayoutDashboard,
    MessagesSquare,
    Network,
    Radar,
    Settings,
    SquareStack,
} from "lucide-react";
```

Add to `ICON` (after the `channels` entry):

```ts
    radar: <Radar {...iconProps} />,
```

Add to `ITEMS` (after the `channels` entry):

```ts
    { key: "radar", label: "Radar" },
```

- [ ] **Step 5: Add the render branch in `cockpitshell.tsx`**

Add the import (after the `ChannelsSurface` import, line ~11):

```ts
import { RadarSurface } from "./radarsurface";
```

Add the branch in the surface switch, after the `channels` branch (line ~69-71):

```tsx
                        ) : surface === "radar" ? (
                            <RadarSurface model={model} />
```

- [ ] **Step 6: Add a temporary stub surface so it compiles**

Create `frontend/app/view/agents/radarsurface.tsx` (replaced fully in Task D4):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "./agents";

export function RadarSurface({ model: _model }: { model: AgentsViewModel }) {
    return <div className="p-6 text-muted-foreground">Repo Radar</div>;
}
```

- [ ] **Step 7: Run the test + typecheck**

Run: `npx vitest run frontend/app/view/agents/radarnav.test.ts`
Expected: PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit (after approval)**

```bash
git add frontend/app/view/agents/agents.tsx frontend/app/view/agents/navrail.tsx frontend/app/view/agents/cockpitshell.tsx frontend/app/view/agents/radarsurface.tsx frontend/app/view/agents/radarnav.test.ts
git commit -m "feat(radar): add radar surface to cockpit navigation"
```

---

## Phase B — Pure model (`radarmodel.ts`)

All functions pure and unit-tested. No jotai, no RPC, no React.

### Task B1: constants, finding grouping, default-collapse

**Files:**
- Create: `frontend/app/view/agents/radarmodel.ts`
- Test: `frontend/app/view/agents/radarmodel.test.ts`

**Interfaces:**
- Produces: `RadarGroup` type; `GROUP_ORDER: RadarGroup[]`; `DEFAULT_OPEN_GROUPS: Set<RadarGroup>`; `groupFindings(findings: RadarFinding[]): Record<RadarGroup, RadarFinding[]>`.

- [ ] **Step 1: Write the failing test**

`frontend/app/view/agents/radarmodel.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DEFAULT_OPEN_GROUPS, GROUP_ORDER, groupFindings } from "./radarmodel";

const finding = (id: string, group: string, extra: Partial<RadarFinding> = {}): RadarFinding => ({
    id,
    fingerprint: `fp-${id}`,
    group,
    riskkind: "test-coverage-gap",
    subsystem: "src/x",
    risk: `risk ${id}`,
    why: "why",
    severity: "medium",
    strength: "moderate",
    signalids: [],
    files: [],
    mission: "mission",
    ...extra,
});

describe("groupFindings", () => {
    it("buckets by lifecycle group in canonical order", () => {
        const grouped = groupFindings([
            finding("a", "recurring"),
            finding("b", "new"),
            finding("c", "dismissed"),
            finding("d", "new"),
        ]);
        expect(GROUP_ORDER).toEqual(["new", "recurring", "nolonger", "dismissed", "suppressed"]);
        expect(grouped.new.map((f) => f.id)).toEqual(["b", "d"]);
        expect(grouped.recurring.map((f) => f.id)).toEqual(["a"]);
        expect(grouped.dismissed.map((f) => f.id)).toEqual(["c"]);
        expect(grouped.nolonger).toEqual([]);
    });

    it("opens only new and recurring by default", () => {
        expect(DEFAULT_OPEN_GROUPS.has("new")).toBe(true);
        expect(DEFAULT_OPEN_GROUPS.has("recurring")).toBe(true);
        expect(DEFAULT_OPEN_GROUPS.has("nolonger")).toBe(false);
        expect(DEFAULT_OPEN_GROUPS.has("dismissed")).toBe(false);
        expect(DEFAULT_OPEN_GROUPS.has("suppressed")).toBe(false);
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: FAIL — `radarmodel` module not found.

- [ ] **Step 3: Implement**

`frontend/app/view/agents/radarmodel.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure model for the Repo Radar surface: finding grouping, canonical counts, scan-state
// classification, selection fallback, and Run-draft construction. No jotai / RPC / React here.

export type RadarGroup = "new" | "recurring" | "nolonger" | "dismissed" | "suppressed";

export const GROUP_ORDER: RadarGroup[] = ["new", "recurring", "nolonger", "dismissed", "suppressed"];

// New + Recurring are actionable-now, so they start open; the rest are history and start collapsed.
export const DEFAULT_OPEN_GROUPS: Set<RadarGroup> = new Set<RadarGroup>(["new", "recurring"]);

const KNOWN_GROUPS = new Set<string>(GROUP_ORDER);

export function groupFindings(findings: RadarFinding[]): Record<RadarGroup, RadarFinding[]> {
    const out: Record<RadarGroup, RadarFinding[]> = {
        new: [],
        recurring: [],
        nolonger: [],
        dismissed: [],
        suppressed: [],
    };
    for (const f of findings ?? []) {
        const g = (KNOWN_GROUPS.has(f.group) ? f.group : "new") as RadarGroup;
        out[g].push(f);
    }
    return out;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (after approval)**

```bash
git add frontend/app/view/agents/radarmodel.ts frontend/app/view/agents/radarmodel.test.ts
git commit -m "feat(radar): finding grouping + default-collapse model"
```

### Task B2: canonical signal/source counts

**Files:**
- Modify: `frontend/app/view/agents/radarmodel.ts`
- Modify: `frontend/app/view/agents/radarmodel.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `findingSignalCount(f: RadarFinding): number`; `reportSignalCount(report: RadarReport): number`; `reportSourceCount(report: RadarReport): number` (distinct collectors among referenced signals).

- [ ] **Step 1: Add failing tests**

Append to `radarmodel.test.ts`:

```ts
import { findingSignalCount, reportSignalCount, reportSourceCount } from "./radarmodel";

const signal = (id: string, collector: string): RadarSignal => ({
    id,
    collector,
    sourceref: `ref-${id}`,
    observedts: 0,
    summary: "s",
    contenthash: `h-${id}`,
});

const report = (extra: Partial<RadarReport> = {}): RadarReport =>
    ({
        oid: "r1",
        version: 1,
        meta: {},
        projectname: "demo",
        projectpath: "/demo",
        status: "completed",
        startedts: 0,
        ...extra,
    }) as RadarReport;

describe("canonical counts", () => {
    it("counts unique signal ids per finding", () => {
        expect(findingSignalCount(finding("a", "new", { signalids: ["s1", "s2", "s1"] }))).toBe(2);
    });

    it("counts unique referenced signal ids across the report", () => {
        const r = report({
            findings: [finding("a", "new", { signalids: ["s1", "s2"] }), finding("b", "new", { signalids: ["s2", "s3"] })],
        });
        expect(reportSignalCount(r)).toBe(3);
    });

    it("counts distinct collectors among referenced signals", () => {
        const r = report({
            signals: [signal("s1", "git"), signal("s2", "git"), signal("s3", "runs")],
            findings: [finding("a", "new", { signalids: ["s1", "s2", "s3"] })],
        });
        expect(reportSourceCount(r)).toBe(2);
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: FAIL — `findingSignalCount` undefined.

- [ ] **Step 3: Implement** (append to `radarmodel.ts`)

```ts
export function findingSignalCount(f: RadarFinding): number {
    return new Set(f.signalids ?? []).size;
}

export function reportSignalCount(report: RadarReport): number {
    const ids = new Set<string>();
    for (const f of report.findings ?? []) {
        for (const id of f.signalids ?? []) {
            ids.add(id);
        }
    }
    return ids.size;
}

export function reportSourceCount(report: RadarReport): number {
    const referenced = new Set<string>();
    for (const f of report.findings ?? []) {
        for (const id of f.signalids ?? []) {
            referenced.add(id);
        }
    }
    const collectors = new Set<string>();
    for (const s of report.signals ?? []) {
        if (referenced.has(s.id)) {
            collectors.add(s.collector);
        }
    }
    return collectors.size;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (after approval)**

```bash
git add frontend/app/view/agents/radarmodel.ts frontend/app/view/agents/radarmodel.test.ts
git commit -m "feat(radar): canonical signal + source counts"
```

### Task B3: scan-state classification + coverage/partial

**Files:**
- Modify: `frontend/app/view/agents/radarmodel.ts`
- Modify: `frontend/app/view/agents/radarmodel.test.ts`

**Interfaces:**
- Produces: `RadarScanState` = `"never-scanned" | "collecting" | "clustering" | "results" | "partial" | "no-findings" | "model-failed" | "cancelled"`; `classifyScanState(report: RadarReport | null): RadarScanState`; `coverageEntries(report: RadarReport): {collector: string; status: string}[]`; `hasCoverageFailure(report: RadarReport): boolean`.

- [ ] **Step 1: Add failing tests**

Append to `radarmodel.test.ts`:

```ts
import { classifyScanState, coverageEntries, hasCoverageFailure } from "./radarmodel";

describe("classifyScanState", () => {
    it("returns never-scanned for null", () => {
        expect(classifyScanState(null)).toBe("never-scanned");
    });
    it("maps in-flight statuses", () => {
        expect(classifyScanState(report({ status: "collecting" }))).toBe("collecting");
        expect(classifyScanState(report({ status: "clustering" }))).toBe("clustering");
        expect(classifyScanState(report({ status: "cancelled" }))).toBe("cancelled");
    });
    it("distinguishes results from no-findings on completed", () => {
        expect(classifyScanState(report({ status: "completed", findings: [] }))).toBe("no-findings");
        expect(classifyScanState(report({ status: "completed", findings: [finding("a", "new")] }))).toBe("results");
    });
    it("maps partial and failed", () => {
        expect(classifyScanState(report({ status: "partial", findings: [finding("a", "new")] }))).toBe("partial");
        expect(classifyScanState(report({ status: "failed" }))).toBe("model-failed");
    });
});

describe("coverage", () => {
    it("lists collector coverage entries", () => {
        const r = report({ coverage: { git: "ok", runs: "failed" } });
        expect(coverageEntries(r)).toEqual(
            expect.arrayContaining([
                { collector: "git", status: "ok" },
                { collector: "runs", status: "failed" },
            ])
        );
    });
    it("detects any non-ok coverage", () => {
        expect(hasCoverageFailure(report({ coverage: { git: "ok" } }))).toBe(false);
        expect(hasCoverageFailure(report({ coverage: { git: "ok", runs: "partial" } }))).toBe(true);
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: FAIL — `classifyScanState` undefined.

- [ ] **Step 3: Implement** (append to `radarmodel.ts`)

```ts
export type RadarScanState =
    | "never-scanned"
    | "collecting"
    | "clustering"
    | "results"
    | "partial"
    | "no-findings"
    | "model-failed"
    | "cancelled";

export function classifyScanState(report: RadarReport | null): RadarScanState {
    if (!report) {
        return "never-scanned";
    }
    switch (report.status) {
        case "collecting":
            return "collecting";
        case "clustering":
            return "clustering";
        case "cancelled":
            return "cancelled";
        case "failed":
            return "model-failed";
        case "partial":
            return "partial";
        case "completed":
            return (report.findings?.length ?? 0) > 0 ? "results" : "no-findings";
        default:
            return "never-scanned";
    }
}

export function coverageEntries(report: RadarReport): { collector: string; status: string }[] {
    return Object.entries(report.coverage ?? {}).map(([collector, status]) => ({ collector, status }));
}

export function hasCoverageFailure(report: RadarReport): boolean {
    return coverageEntries(report).some((e) => e.status !== "ok");
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (after approval)**

```bash
git add frontend/app/view/agents/radarmodel.ts frontend/app/view/agents/radarmodel.test.ts
git commit -m "feat(radar): scan-state classification + coverage derivation"
```

### Task B4: selection fallback + Run-draft construction

**Files:**
- Modify: `frontend/app/view/agents/radarmodel.ts`
- Modify: `frontend/app/view/agents/radarmodel.test.ts`

**Interfaces:**
- Consumes: `groupFindings`, `GROUP_ORDER`.
- Produces: `resolveSelection(findings: RadarFinding[], currentId: string | undefined): string | undefined` (keeps current if still present, else first finding in group order, else undefined); `RadarRunDraft` type; `buildRunDraft(report: RadarReport, finding: RadarFinding): RadarRunDraft`.

- [ ] **Step 1: Add failing tests**

Append to `radarmodel.test.ts`:

```ts
import { buildRunDraft, resolveSelection } from "./radarmodel";

describe("resolveSelection", () => {
    it("keeps the current selection when still present", () => {
        expect(resolveSelection([finding("a", "new"), finding("b", "recurring")], "b")).toBe("b");
    });
    it("falls back to the first finding in group order", () => {
        expect(resolveSelection([finding("b", "recurring"), finding("a", "new")], "gone")).toBe("a");
    });
    it("returns undefined when there are no findings", () => {
        expect(resolveSelection([], "x")).toBeUndefined();
    });
});

describe("buildRunDraft", () => {
    it("keeps report, finding, and fingerprint ids distinct", () => {
        const r = report({ oid: "report-1" });
        const f = finding("finding-1", "new", { fingerprint: "fp-9", mission: "add tests", files: ["a.ts"], signalids: ["s1"] });
        const draft = buildRunDraft(r, f);
        expect(draft.reportId).toBe("report-1");
        expect(draft.findingId).toBe("finding-1");
        expect(draft.fingerprint).toBe("fp-9");
        expect(draft.mission).toBe("add tests");
        expect(draft.files).toEqual(["a.ts"]);
        expect(draft.evidenceRefs).toEqual(["s1"]);
        expect(draft.origin).toBe("radar");
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: FAIL — `resolveSelection` undefined.

- [ ] **Step 3: Implement** (append to `radarmodel.ts`)

```ts
// findings ordered by group, used for selection fallback (first actionable finding wins).
function orderedFindings(findings: RadarFinding[]): RadarFinding[] {
    const grouped = groupFindings(findings);
    return GROUP_ORDER.flatMap((g) => grouped[g]);
}

export function resolveSelection(findings: RadarFinding[], currentId: string | undefined): string | undefined {
    if (currentId && findings.some((f) => f.id === currentId)) {
        return currentId;
    }
    return orderedFindings(findings)[0]?.id;
}

// The finding->Run handoff payload. Consumed by the (deferred) Channels pending-Run composer.
export interface RadarRunDraft {
    reportId: string;
    findingId: string;
    fingerprint: string;
    mission: string;
    files: string[];
    evidenceRefs: string[];
    origin: "radar";
}

export function buildRunDraft(report: RadarReport, finding: RadarFinding): RadarRunDraft {
    return {
        reportId: report.oid,
        findingId: finding.id,
        fingerprint: finding.fingerprint,
        mission: finding.mission,
        files: [...(finding.files ?? [])],
        evidenceRefs: [...(finding.signalids ?? [])],
        origin: "radar",
    };
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit (after approval)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — Expected: exit 0.

```bash
git add frontend/app/view/agents/radarmodel.ts frontend/app/view/agents/radarmodel.test.ts
git commit -m "feat(radar): selection fallback + run-draft construction"
```

---

## Phase C — Store (`radarstore.ts`)

Mirrors `channelsstore.ts`: `globalStore` + `RpcApi` + `TabRpcClient` + WOS. Scope owned locally, initialized from `model.projectFilterAtom` (a project NAME) resolved through `projectsAtom` (name -> `{path}`).

### Task C1: scope resolution

**Files:**
- Create: `frontend/app/view/agents/radarstore.ts`
- Test: `frontend/app/view/agents/radarstore.test.ts`

**Interfaces:**
- Produces: `RadarScope` type `{ name: string; path: string }`; `resolveScope(filter: string, projects: Record<string, ProjectKeywords>): RadarScope | null` (null when filter is "all"/empty/unregistered or the project has no path).

- [ ] **Step 1: Write the failing test**

`frontend/app/view/agents/radarstore.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveScope } from "./radarstore";

const projects = { "payments-api": { path: "/repos/payments-api" } } as Record<string, ProjectKeywords>;

describe("resolveScope", () => {
    it("resolves a registered project name to name+path", () => {
        expect(resolveScope("payments-api", projects)).toEqual({ name: "payments-api", path: "/repos/payments-api" });
    });
    it("returns null for the all filter", () => {
        expect(resolveScope("all", projects)).toBeNull();
    });
    it("returns null for an unregistered name", () => {
        expect(resolveScope("nope", projects)).toBeNull();
    });
    it("returns null for a project with no path", () => {
        expect(resolveScope("x", { x: {} } as Record<string, ProjectKeywords>)).toBeNull();
    });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run frontend/app/view/agents/radarstore.test.ts`
Expected: FAIL — `radarstore` not found.

- [ ] **Step 3: Implement the scope core**

`frontend/app/view/agents/radarstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";

export interface RadarScope {
    name: string;
    path: string;
}

// resolveScope maps the cockpit's global project FILTER (a project name, or "all") to Radar's
// name+path scope. Returns null when there is no single registered project to scan.
export function resolveScope(filter: string, projects: Record<string, ProjectKeywords>): RadarScope | null {
    if (!filter || filter === "all") {
        return null;
    }
    const path = projects?.[filter]?.path;
    if (!path) {
        return null;
    }
    return { name: filter, path };
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run frontend/app/view/agents/radarstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (after approval)**

```bash
git add frontend/app/view/agents/radarstore.ts frontend/app/view/agents/radarstore.test.ts
git commit -m "feat(radar): store scope resolution"
```

### Task C2: report list + current report atoms + WOS pin

**Files:**
- Modify: `frontend/app/view/agents/radarstore.ts`

**Interfaces:**
- Consumes: `RadarScope`.
- Produces atoms: `radarScopeAtom: PrimitiveAtom<RadarScope | null>`, `radarReportsAtom: PrimitiveAtom<RadarReport[] | null>`, `currentReportIdAtom: PrimitiveAtom<string | undefined>`, `radarDevMockAtom: PrimitiveAtom<RadarReport | null>`, `currentReportAtom: Atom<RadarReport | null>`. Functions: `loadReports(path: string): Promise<void>`, `selectReport(reportId: string): Promise<void>`, `initRadarScope(scope: RadarScope | null): Promise<void>`.

- [ ] **Step 1: Implement (no new unit test — WOS/RPC require the live app; covered by CDP in Phase E)**

Append to `radarstore.ts`:

```ts
export const radarScopeAtom = atom<RadarScope | null>(null) as PrimitiveAtom<RadarScope | null>;
export const radarReportsAtom = atom<RadarReport[] | null>(null) as PrimitiveAtom<RadarReport[] | null>;
export const currentReportIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

// DEV-ONLY: when set, fully replaces the live current report (see radardevmock.ts). null in prod.
export const radarDevMockAtom = atom<RadarReport | null>(null) as PrimitiveAtom<RadarReport | null>;

// Current report: the dev-mock override if present, else the WOS-pinned live report (so an in-flight
// scan streams status/phase/coverage updates without polling).
export const currentReportAtom: Atom<RadarReport | null> = atom((get) => {
    const mock = get(radarDevMockAtom);
    if (mock) {
        return mock;
    }
    const id = get(currentReportIdAtom);
    if (!id) {
        return null;
    }
    return get(WOS.getWaveObjectAtom<RadarReport>(WOS.makeORef("radarreport", id))) ?? null;
});

let loading = false;

// loadReports fetches the report list for a path (newest-first) and selects the newest.
export async function loadReports(path: string): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.ListRadarReportsCommand(TabRpcClient, { projectpath: path });
        const list = (rtn.reports ?? []).slice().sort((a, b) => b.startedts - a.startedts);
        globalStore.set(radarReportsAtom, list);
        if (list.length > 0) {
            await selectReport(list[0].oid);
        } else {
            globalStore.set(currentReportIdAtom, undefined);
        }
    } catch (err) {
        console.error("loading radar reports failed", err);
        globalStore.set(radarReportsAtom, []);
    } finally {
        loading = false;
    }
}

// selectReport pins the report in WOS (so subsequent SendWaveObjUpdate deltas apply) and marks it current.
export async function selectReport(reportId: string): Promise<void> {
    await WOS.loadAndPinWaveObject<RadarReport>(WOS.makeORef("radarreport", reportId));
    globalStore.set(currentReportIdAtom, reportId);
}

// initRadarScope sets the owned scope and loads its reports. Clearing scope (null) empties the list.
export async function initRadarScope(scope: RadarScope | null): Promise<void> {
    globalStore.set(radarScopeAtom, scope);
    if (!scope) {
        globalStore.set(radarReportsAtom, null);
        globalStore.set(currentReportIdAtom, undefined);
        return;
    }
    await loadReports(scope.path);
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit (after approval)**

```bash
git add frontend/app/view/agents/radarstore.ts
git commit -m "feat(radar): report list + current-report WOS wiring"
```

### Task C3: scan / cancel / retry / disposition actions

**Files:**
- Modify: `frontend/app/view/agents/radarstore.ts`

**Interfaces:**
- Produces: `startScan(path: string): Promise<void>`, `cancelScan(reportId: string): Promise<void>`, `retryClustering(reportId: string): Promise<void>`, `setDisposition(reportId: string, findingId: string, action: string, reason?: string, note?: string): Promise<void>`.

- [ ] **Step 1: Implement** (append to `radarstore.ts`)

```ts
// startScan kicks a scan for path; the returned report is pinned + selected so its live scan streams in.
export async function startScan(path: string): Promise<void> {
    const rtn = await RpcApi.StartRadarScanCommand(TabRpcClient, { projectpath: path });
    await loadReports(path);
    await selectReport(rtn.report.oid);
}

export async function cancelScan(reportId: string): Promise<void> {
    await RpcApi.CancelRadarScanCommand(TabRpcClient, { reportid: reportId });
}

export async function retryClustering(reportId: string): Promise<void> {
    await RpcApi.RetryRadarClusteringCommand(TabRpcClient, { reportid: reportId });
}

// setDisposition applies dismiss/suppress/reopen/unsuppress; the report update round-trips via WOS.
export async function setDisposition(
    reportId: string,
    findingId: string,
    action: string,
    reason?: string,
    note?: string
): Promise<void> {
    await RpcApi.SetRadarFindingDispositionCommand(TabRpcClient, {
        reportid: reportId,
        findingid: findingId,
        action,
        reason,
        note,
    });
}
```

- [ ] **Step 2: Typecheck + commit (after approval)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — Expected: exit 0.

```bash
git add frontend/app/view/agents/radarstore.ts
git commit -m "feat(radar): scan/cancel/retry/disposition actions"
```

---

## Phase D — Surface UI

No jsdom harness: these tasks are verified by typecheck here and by CDP in Phase E. Each renders real structure using `@theme` tokens (`text-muted-foreground`, `bg-surface`, `border-border`, `bg-accent/10`, `text-accent-soft`, etc. — the same tokens `navrail.tsx` uses).

### Task D1: scan-state panels (`radarscanstatepanel.tsx`)

**Files:**
- Create: `frontend/app/view/agents/radarscanstatepanel.tsx`

**Interfaces:**
- Consumes: `RadarScanState`, `coverageEntries` from `radarmodel`; `cancelScan`, `retryClustering`, `startScan` from `radarstore`.
- Produces: `RadarScanStatePanel({ state, report, scopePath })` rendering the never-scanned/collecting/clustering/no-findings/model-failed/cancelled panels. (`results`/`partial` are handled by the master/detail layout, not this component.)

- [ ] **Step 1: Implement**

`frontend/app/view/agents/radarscanstatepanel.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { coverageEntries, type RadarScanState } from "./radarmodel";
import { cancelScan, retryClustering, startScan } from "./radarstore";

const COLLECTORS = ["structure", "git", "runs", "transcript", "memory", "config"];

function Panel({ heading, message, children }: { heading: string; message?: string; children?: React.ReactNode }) {
    return (
        <div className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
            <h2 className="text-xl font-bold tracking-tight text-primary">{heading}</h2>
            {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
            {children}
        </div>
    );
}

function CollectorChecklist({ report }: { report: RadarReport | null }) {
    const coverage = report ? Object.fromEntries(coverageEntries(report).map((e) => [e.collector, e.status])) : {};
    return (
        <ul className="flex w-full flex-col gap-1.5">
            {COLLECTORS.map((c) => {
                const status = coverage[c];
                const mark = status === "ok" ? "✓" : status === "failed" || status === "partial" ? "✗" : "…";
                return (
                    <li key={c} className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span className="font-mono text-xs text-accent-soft">{mark}</span>
                        <span>{c}</span>
                    </li>
                );
            })}
        </ul>
    );
}

export function RadarScanStatePanel({
    state,
    report,
    scopePath,
}: {
    state: RadarScanState;
    report: RadarReport | null;
    scopePath: string | undefined;
}) {
    const scan = () => scopePath && fireAndForget(() => startScan(scopePath));
    const cancel = () => report && fireAndForget(() => cancelScan(report.oid));
    const retry = () => report && fireAndForget(() => retryClustering(report.oid));

    switch (state) {
        case "never-scanned":
            return (
                <Panel heading="Not yet scanned" message="Radar reads Git history, runs, transcripts, memory, and config to surface correctness risks. It never writes to the repo or runs commands.">
                    <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50">
                        Scan repository
                    </button>
                </Panel>
            );
        case "collecting":
            return (
                <Panel heading="Collecting deterministic signals…">
                    <CollectorChecklist report={report} />
                    <button type="button" onClick={cancel} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">Cancel scan</button>
                </Panel>
            );
        case "clustering":
            return (
                <Panel heading="Clustering candidate risks…" message={`Radar payload: ${report?.payloadtokens ?? 0} tokens`}>
                    <CollectorChecklist report={report} />
                    <button type="button" onClick={cancel} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">Cancel scan</button>
                </Panel>
            );
        case "no-findings":
            return (
                <Panel heading="No correctness risks found" message="This scan surfaced no evidence-backed risks. Signals were collected and clustered cleanly.">
                    <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50">Scan again</button>
                </Panel>
            );
        case "model-failed":
            return (
                <Panel heading="Clustering failed" message="Signals are cached from this scan. Retrying reuses them and only spends budget on clustering, so you won’t re-collect from scratch.">
                    <div className="flex gap-2">
                        <button type="button" onClick={retry} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background">Retry clustering</button>
                        <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground disabled:opacity-50">Discard signals</button>
                    </div>
                </Panel>
            );
        case "cancelled":
            return (
                <Panel heading="Scan cancelled" message="Signals collected before you cancelled were discarded. Findings from your previous scan are unchanged and still available.">
                    <button type="button" onClick={scan} disabled={!scopePath} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background disabled:opacity-50">Scan repository</button>
                </Panel>
            );
        default:
            return null;
    }
}
```

- [ ] **Step 2: Typecheck + commit (after approval)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — Expected: exit 0.

```bash
git add frontend/app/view/agents/radarscanstatepanel.tsx
git commit -m "feat(radar): scan-state panels"
```

### Task D2: grouped findings list (`radarfindingslist.tsx`)

**Files:**
- Create: `frontend/app/view/agents/radarfindingslist.tsx`

**Interfaces:**
- Consumes: `groupFindings`, `GROUP_ORDER`, `DEFAULT_OPEN_GROUPS`, `RadarGroup`, `findingSignalCount` from `radarmodel`.
- Produces: `RadarFindingsList({ findings, selectedId, onSelect })`.

- [ ] **Step 1: Implement**

`frontend/app/view/agents/radarfindingslist.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState } from "react";
import { DEFAULT_OPEN_GROUPS, GROUP_ORDER, groupFindings, type RadarGroup } from "./radarmodel";

const GROUP_LABEL: Record<RadarGroup, string> = {
    new: "New",
    recurring: "Recurring",
    nolonger: "No longer detected",
    dismissed: "Dismissed",
    suppressed: "Suppressed",
};

export function RadarFindingsList({
    findings,
    selectedId,
    onSelect,
}: {
    findings: RadarFinding[];
    selectedId: string | undefined;
    onSelect: (id: string) => void;
}) {
    const grouped = groupFindings(findings);
    const [open, setOpen] = useState<Set<RadarGroup>>(() => new Set(DEFAULT_OPEN_GROUPS));
    const toggle = (g: RadarGroup) =>
        setOpen((prev) => {
            const next = new Set(prev);
            next.has(g) ? next.delete(g) : next.add(g);
            return next;
        });

    return (
        <div className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-border">
            {GROUP_ORDER.map((g) => {
                const items = grouped[g];
                if (items.length === 0) {
                    return null;
                }
                const isOpen = open.has(g);
                return (
                    <div key={g}>
                        <button
                            type="button"
                            onClick={() => toggle(g)}
                            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted"
                        >
                            <span>
                                {GROUP_LABEL[g]} <span className="text-muted-foreground">({items.length})</span>
                            </span>
                            <span className="font-mono">{isOpen ? "−" : "+"}</span>
                        </button>
                        {isOpen
                            ? items.map((f) => (
                                  <button
                                      key={f.id}
                                      type="button"
                                      onClick={() => onSelect(f.id)}
                                      className={cn(
                                          "flex w-full flex-col gap-0.5 border-l-2 px-3 py-2 text-left",
                                          selectedId === f.id
                                              ? "border-accent bg-accent/10"
                                              : "border-transparent hover:bg-surface"
                                      )}
                                  >
                                      <span className="line-clamp-2 text-sm text-primary">{f.risk}</span>
                                      <span className="text-xs text-muted-foreground">
                                          {f.subsystem} · {f.severity} · {f.strength}
                                      </span>
                                  </button>
                              ))
                            : null}
                    </div>
                );
            })}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck + commit (after approval)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — Expected: exit 0.

```bash
git add frontend/app/view/agents/radarfindingslist.tsx
git commit -m "feat(radar): grouped findings master list"
```

### Task D3: finding detail (`radarfindingdetail.tsx`)

Renders risk, why, evidence (signal chips, files, timeline, verbatim diff via the existing renderer), Radar interpretation kept visually distinct, the disabled Start-investigation action, and dismiss/suppress. Reuse the existing diff renderer — find it in Step 1.

**Files:**
- Create: `frontend/app/view/agents/radarfindingdetail.tsx`

**Interfaces:**
- Consumes: `buildRunDraft`, `findingSignalCount` from `radarmodel`; `setDisposition` from `radarstore`.
- Produces: `RadarFindingDetail({ report, finding })`.

- [ ] **Step 1: Locate the existing diff renderer**

Run: `grep -rl "parseDiff\|DiffView\|react-diff\|diffviewer" frontend/app/view --include=*.tsx`
Use the component the Files/Diff surface uses (`frontend/app/view/codeeditor/diffviewer.tsx` or the Files surface's renderer). If the diff specimen in `RadarSignal.snippet` is a plain unified-diff string, render it in a `<pre>` with the shared diff styling rather than adding a parser. Record the exact import you chose in a code comment.

- [ ] **Step 2: Implement**

`frontend/app/view/agents/radarfindingdetail.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { buildRunDraft } from "./radarmodel";
import { setDisposition } from "./radarstore";

// Source facts (diff specimen, files, timeline) render in neutral surface styling; Radar's own
// interpretation renders in a labelled accent-bordered block so the two are never confused.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
            {children}
        </div>
    );
}

export function RadarFindingDetail({ report, finding }: { report: RadarReport; finding: RadarFinding }) {
    const signalsById = new Map((report.signals ?? []).map((s) => [s.id, s]));
    const referenced = finding.signalids.map((id) => signalsById.get(id)).filter(Boolean) as RadarSignal[];
    const dismissed = finding.disposition?.action === "dismiss";
    const suppressed = finding.disposition?.action === "suppress";
    const draft = buildRunDraft(report, finding); // built for the deferred handoff; payload is ready

    const dispose = (action: string) => fireAndForget(() => setDisposition(report.oid, finding.id, action));

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
            <div className="flex flex-col gap-2">
                <div className="flex gap-2 text-xs text-muted-foreground">
                    <span className="rounded bg-surface px-2 py-0.5">{finding.riskkind}</span>
                    <span className="rounded bg-surface px-2 py-0.5">{finding.severity}</span>
                    <span className="rounded bg-surface px-2 py-0.5">{finding.strength}</span>
                    {finding.boundarylabel ? <span className="rounded bg-surface px-2 py-0.5">{finding.boundarylabel}</span> : null}
                </div>
                <h2 className="text-lg font-bold tracking-tight text-primary">{finding.risk}</h2>
            </div>

            <Section title="Why it matters">
                <p className="text-sm text-muted-foreground">{finding.why}</p>
            </Section>

            <Section title="Evidence">
                <div className="flex flex-wrap gap-1.5">
                    {referenced.map((s) => (
                        <span key={s.id} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground" title={s.summary}>
                            {s.collector}
                        </span>
                    ))}
                </div>
                {finding.files.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1">
                        {finding.files.map((f) => (
                            <li key={f} className="font-mono text-xs text-muted-foreground">{f}</li>
                        ))}
                    </ul>
                ) : null}
                {referenced
                    .filter((s) => s.snippet)
                    .map((s) => (
                        <pre key={s.id} className="mt-2 overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs text-muted-foreground">
                            {s.snippet}
                        </pre>
                    ))}
            </Section>

            {/* Radar interpretation — visually distinct from the source facts above */}
            <div className="rounded-md border-l-2 border-accent bg-accent/5 p-3">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-soft">Radar interpretation</h3>
                <p className="text-sm text-muted-foreground">Suggested mission: {finding.mission}</p>
            </div>

            <div className="flex items-center gap-2">
                {/* Start investigation is deferred (docs/deferred.md): draft is built but the Channels composer isn't wired */}
                <button
                    type="button"
                    disabled
                    title="Start investigation opens a prefilled Run in Channels — coming soon"
                    className="cursor-not-allowed rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background opacity-50"
                    data-run-draft-finding={draft.findingId}
                >
                    Start investigation
                </button>
                {dismissed || suppressed ? (
                    <button type="button" onClick={() => dispose(dismissed ? "reopen" : "unsuppress")} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">
                        {dismissed ? "Undo dismiss" : "Unsuppress"}
                    </button>
                ) : (
                    <>
                        <button type="button" onClick={() => dispose("dismiss")} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">Dismiss</button>
                        <button type="button" onClick={() => dispose("suppress")} className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">Suppress</button>
                    </>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Typecheck + commit (after approval)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — Expected: exit 0.

```bash
git add frontend/app/view/agents/radarfindingdetail.tsx
git commit -m "feat(radar): finding detail with separated evidence + interpretation"
```

### Task D4: surface shell (`radarsurface.tsx`)

Replaces the Task A1 stub. Header (scope label + scan control), state switch, master/detail for results/partial.

**Files:**
- Modify: `frontend/app/view/agents/radarsurface.tsx`

**Interfaces:**
- Consumes: everything above; `projectsAtom` from `projectsstore`; `model.projectFilterAtom`.

- [ ] **Step 1: Implement**

`frontend/app/view/agents/radarsurface.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { projectsAtom } from "./projectsstore";
import { classifyScanState, resolveSelection } from "./radarmodel";
import { RadarFindingDetail } from "./radarfindingdetail";
import { RadarFindingsList } from "./radarfindingslist";
import { RadarScanStatePanel } from "./radarscanstatepanel";
import {
    currentReportAtom,
    initRadarScope,
    radarScopeAtom,
    resolveScope,
    startScan,
} from "./radarstore";

export function RadarSurface({ model }: { model: AgentsViewModel }) {
    const filter = useAtomValue(model.projectFilterAtom);
    const projects = useAtomValue(projectsAtom);
    const scope = useAtomValue(radarScopeAtom);
    const report = useAtomValue(currentReportAtom);
    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

    // Initialize (and re-sync) the owned scope from the cockpit's global project selection.
    useEffect(() => {
        const next = resolveScope(filter, projects);
        fireAndForget(() => initRadarScope(next));
    }, [filter, projects]);

    const state = classifyScanState(report);
    const isResults = state === "results" || state === "partial";
    const findings = report?.findings ?? [];
    const effectiveSelected = resolveSelection(findings, selectedId);
    const selectedFinding = findings.find((f) => f.id === effectiveSelected);

    return (
        <div className="flex h-full w-full flex-col bg-background">
            <header className="flex items-center justify-between border-b border-border px-6 py-4">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-primary">Repo Radar</h1>
                    <p className="text-xs text-muted-foreground">
                        {scope ? `Scanning ${scope.name}` : "Select a registered project to scan"}
                    </p>
                </div>
                {isResults && scope ? (
                    <button
                        type="button"
                        onClick={() => fireAndForget(() => startScan(scope.path))}
                        className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background"
                    >
                        {state === "partial" ? "Re-run full scan" : "Re-scan"}
                    </button>
                ) : null}
            </header>

            <div className="min-h-0 flex-1">
                {isResults && report ? (
                    <div className="flex h-full">
                        {state === "partial" ? (
                            <div className="absolute left-0 right-0 top-0 bg-asking/10 px-6 py-1.5 text-xs text-asking">
                                Partial scan — some collectors did not complete.
                            </div>
                        ) : null}
                        <RadarFindingsList findings={findings} selectedId={effectiveSelected} onSelect={setSelectedId} />
                        {selectedFinding ? (
                            <RadarFindingDetail report={report} finding={selectedFinding} />
                        ) : (
                            <div className="flex flex-1 items-center justify-center text-muted-foreground">Select a finding</div>
                        )}
                    </div>
                ) : (
                    <RadarScanStatePanel state={state} report={report} scopePath={scope?.path} />
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit (after approval)**

```bash
git add frontend/app/view/agents/radarsurface.tsx
git commit -m "feat(radar): surface shell wiring scope, states, master/detail"
```

---

## Phase E — Dev fixtures + CDP verification

### Task E1: dev fixtures (`radardevmock.ts`)

**Files:**
- Create: `frontend/app/view/agents/radardevmock.ts`
- Test: `frontend/app/view/agents/radardevmock.test.ts`

**Interfaces:**
- Consumes: `radarDevMockAtom` from `radarstore`.
- Produces: `RADAR_SCENARIOS: readonly string[]`; `buildScenario(name: string): RadarReport`; `setRadarScenario(name: string): void`.

- [ ] **Step 1: Write the failing test**

`frontend/app/view/agents/radardevmock.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { classifyScanState } from "./radarmodel";
import { buildScenario, RADAR_SCENARIOS } from "./radardevmock";

describe("radar dev scenarios", () => {
    it("covers all eight scan states", () => {
        const states = RADAR_SCENARIOS.map((s) => classifyScanState(buildScenario(s)));
        for (const want of ["collecting", "clustering", "results", "partial", "no-findings", "model-failed", "cancelled"]) {
            expect(states).toContain(want);
        }
    });
    it("results scenario has findings across new and recurring", () => {
        const r = buildScenario("results");
        const groups = new Set((r.findings ?? []).map((f) => f.group));
        expect(groups.has("new")).toBe(true);
        expect(groups.has("recurring")).toBe(true);
    });
});
```

Note: `never-scanned` is the null-report state, so it is exercised by clearing the mock (`setRadarScenario("never-scanned")` sets the atom to null), not by `buildScenario`; the test asserts the other seven from `buildScenario`.

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run frontend/app/view/agents/radardevmock.test.ts`
Expected: FAIL — `radardevmock` not found.

- [ ] **Step 3: Implement**

`frontend/app/view/agents/radardevmock.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY radar fixtures for CDP visual verification. setRadarScenario(name) is exposed on window in
// dev (see wiring note below) so CDP can drive each scan state without a real backend scan.

import { globalStore } from "@/app/store/jotaiStore";
import { radarDevMockAtom } from "./radarstore";

export const RADAR_SCENARIOS = [
    "never-scanned",
    "collecting",
    "clustering",
    "results",
    "partial",
    "no-findings",
    "model-failed",
    "cancelled",
] as const;

const signal = (id: string, collector: string, snippet?: string): RadarSignal => ({
    id,
    collector,
    sourceref: `ref-${id}`,
    observedts: 1_720_000_000_000,
    paths: ["src/coupons/validate.ts"],
    subsystem: "src/coupons",
    summary: `${collector} signal ${id}`,
    contenthash: `h-${id}`,
    snippet,
});

const finding = (id: string, group: string): RadarFinding => ({
    id,
    fingerprint: `fp-${id}`,
    group,
    riskkind: "test-coverage-gap",
    subsystem: "src/coupons",
    risk: `Coupon validation ${id} has no test coverage on the expiry path`,
    why: "The expiry branch is exercised only in production; a regression would silently accept expired coupons.",
    severity: "high",
    strength: "moderate",
    signalids: ["s1", "s2"],
    files: ["src/coupons/validate.ts"],
    mission: "Add unit tests for the coupon expiry branch.",
});

const base = (extra: Partial<RadarReport>): RadarReport =>
    ({
        oid: "dev-report",
        version: 1,
        meta: {},
        projectname: "payments-api",
        projectpath: "/repos/payments-api",
        status: "completed",
        startedts: 1_720_000_000_000,
        signals: [signal("s1", "git", "@@ -1,3 +1,4 @@\n-  return true;\n+  return !isExpired(coupon);"), signal("s2", "runs")],
        ...extra,
    }) as RadarReport;

export function buildScenario(name: string): RadarReport {
    switch (name) {
        case "collecting":
            return base({ status: "collecting", phase: "collecting", signals: [], coverage: { git: "ok" } });
        case "clustering":
            return base({ status: "clustering", phase: "clustering", payloadtokens: 12_400, coverage: { git: "ok", runs: "ok" } });
        case "partial":
            return base({ status: "partial", coverage: { git: "ok", runs: "failed" }, partialsources: ["runs"], findings: [finding("a", "new"), finding("b", "recurring")] });
        case "no-findings":
            return base({ status: "completed", coverage: { git: "ok" }, findings: [] });
        case "model-failed":
            return base({ status: "failed", clustererror: "model returned invalid output", candidates: [signal("s1", "git")] });
        case "cancelled":
            return base({ status: "cancelled" });
        case "results":
        default:
            return base({
                status: "completed",
                coverage: { git: "ok", runs: "ok", memory: "ok" },
                findings: [finding("a", "new"), finding("b", "recurring"), finding("c", "nolonger")],
            });
    }
}

// setRadarScenario drives the surface. "never-scanned" clears the mock (null current report).
export function setRadarScenario(name: string): void {
    globalStore.set(radarDevMockAtom, name === "never-scanned" ? null : buildScenario(name));
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run frontend/app/view/agents/radardevmock.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the dev hook (dev-only, tree-shaken from prod)**

In `frontend/app/view/agents/radarsurface.tsx`, add a dev-only effect near the other effects so CDP can call `window.__setRadarScenario("<name>")`:

```tsx
    useEffect(() => {
        if (import.meta.env.DEV) {
            void import("./radardevmock").then((m) => {
                (window as any).__setRadarScenario = m.setRadarScenario;
            });
        }
    }, []);
```

- [ ] **Step 6: Typecheck + commit (after approval)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — Expected: exit 0.

```bash
git add frontend/app/view/agents/radardevmock.ts frontend/app/view/agents/radardevmock.test.ts frontend/app/view/agents/radarsurface.tsx
git commit -m "feat(radar): dev fixtures for CDP verification"
```

### Task E2: CDP visual verification pass

**Files:** none (verification only).

- [ ] **Step 1: Ensure the dev app is running**

Run (if not already up): `tail -f /dev/null | task dev` (per MEMORY.md — a detached `task dev` EOFs wavesrv stdin). Wait for the Vite app on `:5174` inside WebView2.

- [ ] **Step 2: Navigate to Radar + screenshot each state**

For each scenario, drive it over CDP and screenshot:

```bash
# switch to the radar surface, then set a scenario (repeat per state)
node scripts/cdp-shot.mjs radar-results.png   # after evaluating window.__setRadarScenario('results')
```

Use `Runtime.evaluate` to call `window.__setRadarScenario('<name>')` (and to set `model.surfaceAtom` to `"radar"` if not already there), then `node scripts/cdp-shot.mjs <out>.png`. Capture: `never-scanned`, `collecting`, `clustering`, `results`, `partial`, `no-findings`, `model-failed`, `cancelled`.

Expected per state: heading + controls match the mockup; results shows grouped list (New/Recurring open, No-longer collapsed) + detail with evidence chips, files, verbatim diff `<pre>`, and the accent-bordered Radar-interpretation block; Start investigation is visibly disabled.

- [ ] **Step 3: Verify dismiss/undo, suppress/unsuppress interactions**

In the `results` scenario, click Dismiss on the selected finding, confirm the detail switches to "Undo dismiss"; click it, confirm it reverts. Repeat for Suppress/Unsuppress. (Against the dev mock these mutate via the real RPC only when a live report is selected; for pure visual verification, confirm the button states toggle. Note in the verification log that end-to-end disposition round-trip requires a live scan.)

- [ ] **Step 4: Verify theme, nav scrolling, overflow**

- Toggle theme (dev theme switch) and re-screenshot `results` — confirm no raw-color regressions in light mode.
- Shrink the window height until the NavRail scrolls; confirm Radar stays reachable and Settings stays pinned at the bottom.
- Confirm long risk text, long file lists, and wide diffs scroll within their containers without clipping the layout (the diff `<pre>` has `overflow-x-auto`).

- [ ] **Step 5: Record results**

Write a short verification note (states captured, anything off vs. the mockup, and the explicit caveat that live disposition round-trip and a real scan were verified separately or deferred). Save screenshots to the scratchpad or attach to the PR.

---

## Self-Review (completed during authoring)

**Spec coverage:** SurfaceKey/NavRail/CockpitShell (A1); radarstore/radarmodel/radarsurface + small components (B–D); scope-from-global-selection (C1/D4); 8 states (B3, D1, D4, E1/E2); canonical counts (B2); reuse diff renderer (D3 Step 1); source-facts-vs-interpretation separation (D3); dismissed history + undo (D3); disabled Start-investigation + draft built (D3, B4); dev fixtures + CDP (E); pure tests for grouping/collapse/filtering/selection/counts/coverage/partial/draft-id-distinctness/navigation (A1, B1–B4). Deferred handoff recorded in `docs/deferred.md`.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; the only runtime lookup left to the implementer is the exact diff-renderer import (D3 Step 1), which is a deliberate "find the existing component" step, not a logic gap.

**Type consistency:** `RadarScanState`, `RadarGroup`, `RadarScope`, `RadarRunDraft` names are used identically across model/store/UI; RPC field names (`reportid`/`findingid`/`projectpath`/`reportid`) match the generated command types; `report.oid` used consistently for the ORef and RPC ids.
