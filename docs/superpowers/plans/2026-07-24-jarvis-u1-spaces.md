# Jarvis U1 — Presence C ("Spaces") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a task-focus lens ("Spaces") over the existing cockpit: pick an active task and the Agent roster + Channels filter to that task's attributed work, switched from an app-bar chip and Ctrl+P, strictly additive to Presence D.

**Architecture:** Two new pure-read wshrpc commands expose the vault's task list (`ListDossiersCommand`) and a task's attributed scope bundle (`ResolveSpaceScopeCommand`, from attribution engine D's `EdgesFor`). The frontend holds the active Space in module-scope jotai atoms (survive nav-unmount), renders an app-bar switcher chip mirroring `ProjectSwitcher`, adds a Ctrl+P "Focus on task" group, and applies a pure `filterBySpace` pass to the roster and Channels list with an inline "Show all" escape-hatch banner. No embeddings, no model call, no new WaveObj, no migration.

**Tech Stack:** Go (wshrpc/wshserver, wavevault, jarvisattrib, jarvisdossier); React 19 + jotai + Tailwind 4 (frontend); vitest (FE units); `go test` (backend units); `task generate` (Go→TS/Go bindings codegen).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-24-jarvis-u1-spaces-design.md`. Every task implements part of it.
- **Strictly additive to Presence D.** With no Space active (`activeSpaceAtom == null`), every surface behaves exactly as today. D is the global default.
- **"Needs you" is never suppressed by focus.** Do NOT route the Space filter into the cockpit `needsYou` count (`cockpitsurface.tsx:89`, computed from the global `agents` set), the nav-rail ask badge, or the parked-idle/backgrounded sections. Focus filters only the live roster grid and the Channels list.
- **Scoped surfaces this cycle: Agent roster + Channels only.** Sessions, Radar, Jarvis-recall-default, and a keyboard quick-switch are out of scope (spec §Out of scope).
- **Dark mode only; `@theme` tokens in `tailwindsetup.css` — never raw hex.** Preserve the 46px app bar / 78px nav rail (the chip is a non-destructive addition to the app bar's existing left cluster). Existing cockpit fonts; restrained motion.
- **Go is the source of truth for the wire protocol.** Never hand-edit `wshclient.go`, `wshclientapi.ts`, or `gotypes.d.ts` — edit the Go and run `task generate`.
- **Typecheck command (repo gotcha — bare `npx tsc` stack-overflows):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- **Git policy (repo owner):** do NOT commit or push without explicit approval; do NOT add a co-author trailer; the spec + this plan fold into the feature commit (no standalone docs commit). The per-task "Commit" steps below are checkpoints — stage the listed files and, unless the owner says otherwise, batch into one commit at the end.

---

### Task 1: Backend — space-scope contract + two read commands

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (add 2 interface methods + 4 types)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (add imports + 2 command methods + 3 pure helpers)
- Create: `pkg/wshrpc/wshserver/wshserver_space_test.go`
- Regenerated (do not hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces (Go): `wshrpc.SpaceSummary{Id,Objective,Ticket,Status string; Updated int64}`, `wshrpc.SpaceScope{RunORefs,ChannelOids,TabIds []string}`, `WshServer.ListDossiersCommand`, `WshServer.ResolveSpaceScopeCommand`, and the pure `buildSpaceScope(edges []jarvisattrib.AttributedEdge, byORef map[string]*waveobj.Run) wshrpc.SpaceScope`.
- Produces (generated TS, ambient in `gotypes.d.ts`): `SpaceSummary = {id;objective;ticket;status;updated}`, `SpaceScope = {runorefs;channeloids;tabids}`, `CommandListDossiersRtnData`, `CommandResolveSpaceScopeData`; and `RpcApi.ListDossiersCommand`, `RpcApi.ResolveSpaceScopeCommand`.
- Consumes: `wavevault.OpenVault`, `wavevault.Scope`, `wavevault.CollTasks`, `Retriever.Query`, `jarvisdossier.LoadDossier`, `jarvisattrib.EdgesFor`, `jarvisattrib.AttributedEdge`, `wstore.DBGetAllObjsByType[*waveobj.Run]`, `waveobj.Run{ChannelOID, Phases[].WorkerOrefs}`.

- [ ] **Step 1: Write the failing pure test for `buildSpaceScope`**

Create `pkg/wshrpc/wshserver/wshserver_space_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestBuildSpaceScopeDedupsAndStripsTabPrefix(t *testing.T) {
	edges := []jarvisattrib.AttributedEdge{
		{RunORef: "run:r1"},
		{RunORef: "run:r2"},
		{RunORef: "run:r1"},      // duplicate edge
		{RunORef: "run:missing"}, // edge to a run not in byORef
	}
	byORef := map[string]*waveobj.Run{
		"run:r1": {OID: "r1", ChannelOID: "ch1", Phases: []waveobj.RunPhase{{WorkerOrefs: []string{"tab:t1", "tab:t2"}}}},
		"run:r2": {OID: "r2", ChannelOID: "ch1", Phases: []waveobj.RunPhase{{WorkerOrefs: []string{"tab:t2", "tab:t3"}}}},
	}
	got := buildSpaceScope(edges, byORef)

	if len(got.RunORefs) != 3 {
		t.Fatalf("runorefs: want 3 deduped (r1,r2,missing), got %v", got.RunORefs)
	}
	if len(got.ChannelOids) != 1 || got.ChannelOids[0] != "ch1" {
		t.Fatalf("channeloids: want [ch1], got %v", got.ChannelOids)
	}
	if strings.Join(got.TabIds, ",") != "t1,t2,t3" {
		t.Fatalf("tabids: want t1,t2,t3 (deduped, tab: stripped), got %v", got.TabIds)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestBuildSpaceScope`
Expected: FAIL — `undefined: buildSpaceScope` (and unknown `wshrpc.SpaceScope` once referenced).

- [ ] **Step 3: Add the wire types + interface methods**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add these two methods to the `JarvisCommands interface` (after `ListJarvisConversationsCommand`):

```go
	ListDossiersCommand(ctx context.Context) (*CommandListDossiersRtnData, error)                                          // list focusable task dossiers (active|paused), newest-updated first
	ResolveSpaceScopeCommand(ctx context.Context, data CommandResolveSpaceScopeData) (*SpaceScope, error)                  // resolve a task's attributed scope bundle (runs -> channels + worker tabs) for Presence C
```

And add these types at the end of the file:

```go
// SpaceSummary is one focusable task (Presence C). Objective is the human label; Ticket a secondary tag.
type SpaceSummary struct {
	Id        string `json:"id"`
	Objective string `json:"objective"`
	Ticket    string `json:"ticket"`
	Status    string `json:"status"` // active | paused (the only focusable statuses)
	Updated   int64  `json:"updated"`
}

type CommandListDossiersRtnData struct {
	Spaces []SpaceSummary `json:"spaces"`
}

type CommandResolveSpaceScopeData struct {
	DossierId string `json:"dossierid"`
}

// SpaceScope is a task's derived scope bundle: its attributed run orefs, their channel oids, and the
// worker tab ids (tab: prefix stripped, so they match the roster's tabId key). Rebuildable, never stored.
type SpaceScope struct {
	RunORefs    []string `json:"runorefs"`
	ChannelOids []string `json:"channeloids"`
	TabIds      []string `json:"tabids"`
}
```

- [ ] **Step 4: Implement the commands + pure helpers**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, add to the import block: `"sort"`, and the three packages:

```go
	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
```

Append these functions to the file:

```go
func (ws *WshServer) ListDossiersCommand(ctx context.Context) (*wshrpc.CommandListDossiersRtnData, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	return listDossiers(v)
}

// listDossiers is the vault-backed core (testable with an explicit vault): the active|paused dossiers in
// the tasks collection, projected to summaries, newest-updated first.
func listDossiers(v *wavevault.Vault) (*wshrpc.CommandListDossiersRtnData, error) {
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}})
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return nil, fmt.Errorf("querying tasks: %w", err)
	}
	out := []wshrpc.SpaceSummary{}
	for _, n := range nodes {
		d, err := jarvisdossier.LoadDossier(r, n.ID)
		if err != nil {
			continue // tolerant: skip an unreadable/foreign node
		}
		if d.Status != "active" && d.Status != "paused" {
			continue
		}
		out = append(out, wshrpc.SpaceSummary{Id: d.ID, Objective: d.Objective, Ticket: d.Ticket, Status: d.Status, Updated: d.Updated})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return &wshrpc.CommandListDossiersRtnData{Spaces: out}, nil
}

func (ws *WshServer) ResolveSpaceScopeCommand(ctx context.Context, data wshrpc.CommandResolveSpaceScopeData) (*wshrpc.SpaceScope, error) {
	if data.DossierId == "" {
		return nil, fmt.Errorf("dossierid is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	edges, err := jarvisattrib.EdgesFor(ctx, v, data.DossierId)
	if err != nil {
		return nil, fmt.Errorf("resolving edges: %w", err)
	}
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, fmt.Errorf("loading runs: %w", err)
	}
	byORef := make(map[string]*waveobj.Run, len(runs))
	for _, run := range runs {
		byORef["run:"+run.OID] = run
	}
	scope := buildSpaceScope(edges, byORef)
	return &scope, nil
}

// buildSpaceScope is the pure edge->bundle core: dedup the attributed run orefs, their channel oids, and
// the worker tab ids (tab: prefix stripped) from each run's phases. Order-stable by first appearance; an
// edge to a run missing from byORef still contributes its run oref (surfaced, not dropped).
func buildSpaceScope(edges []jarvisattrib.AttributedEdge, byORef map[string]*waveobj.Run) wshrpc.SpaceScope {
	scope := wshrpc.SpaceScope{RunORefs: []string{}, ChannelOids: []string{}, TabIds: []string{}}
	seenRun := map[string]bool{}
	seenChan := map[string]bool{}
	seenTab := map[string]bool{}
	for _, e := range edges {
		if seenRun[e.RunORef] {
			continue
		}
		seenRun[e.RunORef] = true
		scope.RunORefs = append(scope.RunORefs, e.RunORef)
		run := byORef[e.RunORef]
		if run == nil {
			continue
		}
		if run.ChannelOID != "" && !seenChan[run.ChannelOID] {
			seenChan[run.ChannelOID] = true
			scope.ChannelOids = append(scope.ChannelOids, run.ChannelOID)
		}
		for _, ph := range run.Phases {
			for _, wo := range ph.WorkerOrefs {
				if !strings.HasPrefix(wo, "tab:") {
					continue
				}
				tabID := strings.TrimPrefix(wo, "tab:")
				if tabID == "" || seenTab[tabID] {
					continue
				}
				seenTab[tabID] = true
				scope.TabIds = append(scope.TabIds, tabID)
			}
		}
	}
	return scope
}
```

- [ ] **Step 5: Run the `buildSpaceScope` test to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestBuildSpaceScope`
Expected: PASS.

- [ ] **Step 6: Write + run the `listDossiers` test**

Append to `pkg/wshrpc/wshserver/wshserver_space_test.go` (add imports `"context"`, `"github.com/wavetermdev/waveterm/pkg/jarvisdossier"`, `"github.com/wavetermdev/waveterm/pkg/wavevault"`):

```go
func TestListDossiersFiltersStatusAndSorts(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	id1, h1, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "T-1", Objective: "alpha"})
	if err != nil {
		t.Fatalf("create alpha: %v", err)
	}
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "T-2", Objective: "beta"}); err != nil {
		t.Fatalf("create beta: %v", err)
	}
	id3, h3, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "T-3", Objective: "gamma"})
	if err != nil {
		t.Fatalf("create gamma: %v", err)
	}
	if _, err := jarvisdossier.SetStatus(v, id1, "paused", h1); err != nil {
		t.Fatalf("pause alpha: %v", err)
	}
	if _, err := jarvisdossier.SetStatus(v, id3, "completed", h3); err != nil {
		t.Fatalf("complete gamma: %v", err)
	}
	rtn, err := listDossiers(v)
	if err != nil {
		t.Fatalf("listDossiers: %v", err)
	}
	// gamma (completed) excluded; alpha (paused) + beta (active) included.
	if len(rtn.Spaces) != 2 {
		t.Fatalf("want 2 focusable (alpha paused + beta active), got %d: %+v", len(rtn.Spaces), rtn.Spaces)
	}
	for _, s := range rtn.Spaces {
		if s.Status != "active" && s.Status != "paused" {
			t.Fatalf("unexpected status in results: %+v", s)
		}
	}
}
```

Run: `go test ./pkg/wshrpc/wshserver/ -run 'TestBuildSpaceScope|TestListDossiers'`
Expected: PASS (both).

- [ ] **Step 7: Regenerate bindings + build**

Run: `task generate`
Then verify the generated client + TS gained the commands:
Run: `grep -c "ListDossiersCommand\|ResolveSpaceScopeCommand" pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts`
Expected: nonzero counts in both files.
Run: `go build ./... && go test ./pkg/wshrpc/...`
Expected: build OK; tests PASS.

- [ ] **Step 8: Commit (checkpoint — see git policy)**

```bash
git add pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_space_test.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(jarvis): U1 space-scope backend — list dossiers + resolve scope bundle"
```

---

### Task 2: Frontend — Space state (pure filters + module store)

**Files:**
- Create: `frontend/app/view/agents/spacescope.ts` (pure)
- Create: `frontend/app/view/agents/spacescope.test.ts`
- Create: `frontend/app/view/agents/spacestore.ts` (jotai glue)

**Interfaces:**
- Consumes: generated `SpaceSummary`, `SpaceScope` (ambient); `RpcApi.ListDossiersCommand`, `RpcApi.ResolveSpaceScopeCommand`; `AgentVM` (`./agentsviewmodel`); `SurfaceKey` (`./agents`).
- Produces (pure, `spacescope.ts`): `filterBySpace(agents: AgentVM[], scope: SpaceScope|null, revealed: boolean): AgentVM[]`; `filterChannelsBySpace<T extends {oid:string}>(channels: T[]|null, scope: SpaceScope|null, revealed: boolean): T[]|null`; `spaceBannerText(objective: string, hidden: number, revealed: boolean): string`.
- Produces (store, `spacestore.ts`): atoms `activeSpaceAtom`, `spaceScopeAtom`, `spaceRevealAtom`, `spacesAtom`; functions `loadSpaces()`, `enterSpace(summary)`, `exitSpace()`, `revealSurface(key)`, `concealSurface(key)`.

- [ ] **Step 1: Write the failing pure test**

Create `frontend/app/view/agents/spacescope.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { filterBySpace, filterChannelsBySpace, spaceBannerText } from "./spacescope";

const agent = (id: string): AgentVM => ({ id, name: id, task: "", state: "idle" });
const scope = (over: Partial<SpaceScope>): SpaceScope => ({ runorefs: [], channeloids: [], tabids: [], ...over });

test("filterBySpace: null scope passes all through (Global)", () => {
    const a = [agent("t1"), agent("t2")];
    expect(filterBySpace(a, null, false)).toBe(a);
});

test("filterBySpace: keeps only rows whose id is in tabids", () => {
    const a = [agent("t1"), agent("t2"), agent("t3")];
    expect(filterBySpace(a, scope({ tabids: ["t1", "t3"] }), false).map((x) => x.id)).toEqual(["t1", "t3"]);
});

test("filterBySpace: revealed passes all through despite scope", () => {
    const a = [agent("t1"), agent("t2")];
    expect(filterBySpace(a, scope({ tabids: ["t1"] }), true)).toBe(a);
});

test("filterChannelsBySpace: keeps only channels whose oid is in channeloids", () => {
    const ch = [{ oid: "c1" }, { oid: "c2" }];
    expect(filterChannelsBySpace(ch, scope({ channeloids: ["c2"] }), false)?.map((c) => c.oid)).toEqual(["c2"]);
});

test("filterChannelsBySpace: null channels stays null", () => {
    expect(filterChannelsBySpace(null, scope({ channeloids: ["c2"] }), false)).toBeNull();
});

test("spaceBannerText: focused with hidden, focused zero, revealed", () => {
    expect(spaceBannerText("alpha", 3, false)).toBe("Focused: alpha · 3 hidden");
    expect(spaceBannerText("alpha", 0, false)).toBe("Focused: alpha");
    expect(spaceBannerText("alpha", 3, true)).toBe("Showing all · Focused: alpha");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/spacescope.test.ts`
Expected: FAIL — cannot resolve `./spacescope`.

- [ ] **Step 3: Implement the pure filters**

Create `frontend/app/view/agents/spacescope.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure Presence-C scope filters. A Space's SpaceScope (from ResolveSpaceScopeCommand) lists the task's
// attributed run orefs, channel oids, and worker tab ids. These apply that scope to surface lists; kept
// jotai-free so they unit-test without a render/store harness.

import type { AgentVM } from "./agentsviewmodel";

// Keep only roster rows whose tabId (AgentVM.id) is in the Space. Null scope (Global) or a revealed
// surface (the "Show all" escape hatch) passes everything through unchanged.
export function filterBySpace(agents: AgentVM[], scope: SpaceScope | null, revealed: boolean): AgentVM[] {
    if (scope == null || revealed) {
        return agents;
    }
    const ids = new Set(scope.tabids);
    return agents.filter((a) => ids.has(a.id));
}

// Keep only channels whose oid is in the Space. Typed on { oid } so it works on the Channel wire type
// without importing it. Null channels / null scope / revealed pass through.
export function filterChannelsBySpace<T extends { oid: string }>(
    channels: T[] | null,
    scope: SpaceScope | null,
    revealed: boolean
): T[] | null {
    if (channels == null || scope == null || revealed) {
        return channels;
    }
    const ids = new Set(scope.channeloids);
    return channels.filter((c) => ids.has(c.oid));
}

// Escape-hatch banner copy for a scoped surface. Revealed => an un-focus hint; otherwise the focus line
// with the hidden count (or the empty-Space / nothing-hidden case).
export function spaceBannerText(objective: string, hidden: number, revealed: boolean): string {
    if (revealed) {
        return `Showing all · Focused: ${objective}`;
    }
    if (hidden <= 0) {
        return `Focused: ${objective}`;
    }
    return `Focused: ${objective} · ${hidden} hidden`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/spacescope.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Implement the module store**

Create `frontend/app/view/agents/spacestore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Active-Space (Presence C) state. Module-scope atoms so focus survives the surface unmount on nav-switch
// (only the agent surface stays mounted). Lives under view/agents/ so the scoped surfaces (roster,
// channels) read it without importing the jarvis view (the one-directional import rule).

import { globalStore } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import type { SurfaceKey } from "./agents";

// null = Global (Presence D). A summary = the focused task.
export const activeSpaceAtom = atom<SpaceSummary | null>(null);
// the resolved scope bundle for the active Space; null when Global or while a resolve is in flight.
export const spaceScopeAtom = atom<SpaceScope | null>(null);
// which scoped surfaces the user clicked "Show all" on; reset on every switch.
export const spaceRevealAtom = atom<Set<SurfaceKey>>(new Set<SurfaceKey>());
// the switcher/palette task list (active+paused), newest-updated first.
export const spacesAtom = atom<SpaceSummary[]>([]);

export function loadSpaces(): void {
    fireAndForget(async () => {
        const rtn = await RpcApi.ListDossiersCommand(TabRpcClient);
        globalStore.set(spacesAtom, rtn?.spaces ?? []);
    });
}

// enterSpace focuses a task: flip the indicator immediately, clear prior reveals, then resolve its scope
// bundle (async). A stale resolve (user switched/exited mid-flight) is discarded.
export function enterSpace(summary: SpaceSummary): void {
    globalStore.set(activeSpaceAtom, summary);
    globalStore.set(spaceRevealAtom, new Set<SurfaceKey>());
    globalStore.set(spaceScopeAtom, null);
    fireAndForget(async () => {
        const scope = await RpcApi.ResolveSpaceScopeCommand(TabRpcClient, { dossierid: summary.id });
        if (globalStore.get(activeSpaceAtom)?.id !== summary.id) {
            return;
        }
        globalStore.set(spaceScopeAtom, scope ?? null);
    });
}

export function exitSpace(): void {
    globalStore.set(activeSpaceAtom, null);
    globalStore.set(spaceScopeAtom, null);
    globalStore.set(spaceRevealAtom, new Set<SurfaceKey>());
}

export function revealSurface(key: SurfaceKey): void {
    const next = new Set(globalStore.get(spaceRevealAtom));
    next.add(key);
    globalStore.set(spaceRevealAtom, next);
}

export function concealSurface(key: SurfaceKey): void {
    const next = new Set(globalStore.get(spaceRevealAtom));
    next.delete(key);
    globalStore.set(spaceRevealAtom, next);
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline).

```bash
git add frontend/app/view/agents/spacescope.ts frontend/app/view/agents/spacescope.test.ts frontend/app/view/agents/spacestore.ts
git commit -m "feat(jarvis): U1 space state — pure scope filters + module store"
```

---

### Task 3: Frontend — app-bar Space switcher chip

**Files:**
- Create: `frontend/app/view/agents/spaceswitcher.tsx`
- Modify: `frontend/app/cockpit/app-bar.tsx` (mount the chip after `ProjectSwitcher`)

**Interfaces:**
- Consumes: `activeSpaceAtom`, `spacesAtom`, `enterSpace`, `exitSpace`, `loadSpaces` (`./spacestore`); `PopoverReveal` (`@/app/element/popoverreveal`).
- Produces: `SpaceSwitcher` React component (no props).

- [ ] **Step 1: Create the switcher component**

Create `frontend/app/view/agents/spaceswitcher.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { activeSpaceAtom, enterSpace, exitSpace, loadSpaces, spacesAtom } from "./spacestore";

// App-bar Space (Presence C) switcher: "◇ <objective> ▾" (or "Global"). Mirrors ProjectSwitcher's
// bar trigger + PopoverReveal dropdown. Selecting a task focuses it; "Global" returns to no-focus. The
// list refreshes on each open (dossiers change as work is dispatched).
export function SpaceSwitcher() {
    const active = useAtomValue(activeSpaceAtom);
    const spaces = useAtomValue(spacesAtom);
    const [open, setOpen] = useState(false);
    const label = active ? active.objective : "Global";
    const toggle = () =>
        setOpen((v) => {
            if (!v) loadSpaces();
            return !v;
        });
    const close = () => setOpen(false);
    return (
        <div className="relative">
            <button
                type="button"
                onClick={toggle}
                className="flex cursor-pointer items-center gap-1.5 rounded-sm px-[7px] py-1 text-[13px] font-medium text-secondary hover:bg-surface-hover hover:text-primary"
            >
                {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                <span className="max-w-[180px] truncate">{label}</span>
                <span className="text-[9px] text-muted">▾</span>
            </button>
            {open ? <div className="fixed inset-0 z-50" onClick={close} /> : null}
            <PopoverReveal
                open={open}
                origin="top left"
                className="absolute left-0 top-[calc(100%+7px)] z-[60] w-[268px] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-popover"
            >
                <div className="px-3 pb-1.5 pt-[9px]">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                        Focus on task
                    </span>
                </div>
                <div className="max-h-[46vh] overflow-y-auto px-1.5 pb-1.5">
                    <button
                        type="button"
                        onClick={() => {
                            exitSpace();
                            close();
                        }}
                        className={cn(
                            "flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-surface-hover",
                            active == null && "bg-accent/10"
                        )}
                    >
                        <span className="h-2 w-2 shrink-0 rounded-[3px] bg-muted" />
                        <span className="flex-1 truncate text-[13px] font-medium text-secondary">Global (no focus)</span>
                    </button>
                    {spaces.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                                enterSpace(s);
                                close();
                            }}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-surface-hover",
                                active?.id === s.id && "bg-accent/10"
                            )}
                        >
                            <span
                                className={cn(
                                    "h-2 w-2 shrink-0 rounded-[3px]",
                                    s.status === "paused" ? "bg-muted" : "bg-success"
                                )}
                            />
                            <span className="flex-1 truncate text-[13px] font-medium text-secondary">{s.objective}</span>
                            {s.ticket ? <span className="font-mono text-[10px] text-muted">{s.ticket}</span> : null}
                        </button>
                    ))}
                    {spaces.length === 0 ? (
                        <div className="px-2 py-3 text-[12px] text-muted">No active tasks yet.</div>
                    ) : null}
                </div>
            </PopoverReveal>
        </div>
    );
}
```

- [ ] **Step 2: Mount the chip in the app bar**

In `frontend/app/cockpit/app-bar.tsx`, add the import near the `ProjectSwitcher` import:

```tsx
import { SpaceSwitcher } from "@/app/view/agents/spaceswitcher";
```

Then, inside the left cluster `<div className="flex items-center gap-[9px]">`, immediately after the existing `<ProjectSwitcher model={model} variant="bar" />`, add:

```tsx
                <span className="text-[13px] text-ink-faint">/</span>
                <SpaceSwitcher />
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visually verify the chip renders**

Ensure the dev app is running (`tail -f /dev/null | task dev` in a background shell, per the repo run flow), then:
Run: `node scripts/cdp-shot.mjs cdp-shots/u1-chip.png`
Expected: the app bar shows `Arc / <project> / Global ▾`. Open the PNG and confirm the "Global" chip is present next to the project switcher.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/spaceswitcher.tsx frontend/app/cockpit/app-bar.tsx
git commit -m "feat(jarvis): U1 app-bar Space switcher chip"
```

---

### Task 4: Frontend — Ctrl+P "Focus on task" group

**Files:**
- Create: `frontend/app/cockpit/palette-focus.ts` (pure)
- Create: `frontend/app/cockpit/palette-focus.test.ts`
- Modify: `frontend/app/cockpit/command-palette.tsx`

**Interfaces:**
- Consumes: `SpaceSummary` (ambient); `spacesAtom`, `activeSpaceAtom`, `enterSpace`, `exitSpace`, `loadSpaces` (`@/app/view/agents/spacestore`).
- Produces (pure): `buildFocusItems(spaces: SpaceSummary[], activeSpaceId: string|null, deps: {focus:(s:SpaceSummary)=>void; exit:()=>void}): FocusItem[]` where `FocusItem = {key:string; title:string; subtitle?:string; run:()=>void}`.

- [ ] **Step 1: Write the failing pure test**

Create `frontend/app/cockpit/palette-focus.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import { buildFocusItems } from "./palette-focus";

const spaces: SpaceSummary[] = [
    { id: "t1", objective: "alpha", ticket: "A-1", status: "active", updated: 2 },
    { id: "t2", objective: "beta", ticket: "", status: "paused", updated: 1 },
];
const noop = { focus: () => {}, exit: () => {} };

test("one row per task; ticket becomes the subtitle (blank => undefined)", () => {
    const items = buildFocusItems(spaces, null, noop);
    expect(items.map((i) => i.key)).toEqual(["focus-t1", "focus-t2"]);
    expect(items[0].subtitle).toBe("A-1");
    expect(items[1].subtitle).toBeUndefined();
});

test("prepends an Exit focus row when a Space is active", () => {
    const items = buildFocusItems(spaces, "t1", noop);
    expect(items[0].key).toBe("focus-exit");
    expect(items).toHaveLength(3);
});

test("empty list + no active Space => no rows", () => {
    expect(buildFocusItems([], null, noop)).toEqual([]);
});

test("a task row's run() focuses that summary", () => {
    let got: SpaceSummary | null = null;
    const items = buildFocusItems(spaces, null, { focus: (s) => (got = s), exit: () => {} });
    items[0].run();
    expect(got?.id).toBe("t1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/cockpit/palette-focus.test.ts`
Expected: FAIL — cannot resolve `./palette-focus`.

- [ ] **Step 3: Implement the builder**

Create `frontend/app/cockpit/palette-focus.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure builder for the command palette's "Focus on task" group (mirrors palette-launch/palette-ask). One
// row per active|paused task (from ListDossiersCommand); run() focuses that task. When a Space is already
// active it prepends an "Exit focus" row. Empty list + no active Space => no rows.

export interface FocusItem {
    key: string;
    title: string;
    subtitle?: string;
    run: () => void;
}

export interface FocusDeps {
    focus: (space: SpaceSummary) => void;
    exit: () => void;
}

export function buildFocusItems(spaces: SpaceSummary[], activeSpaceId: string | null, deps: FocusDeps): FocusItem[] {
    const items: FocusItem[] = [];
    if (activeSpaceId != null) {
        items.push({ key: "focus-exit", title: "Exit focus", subtitle: "Return to Global", run: deps.exit });
    }
    for (const s of spaces) {
        items.push({
            key: `focus-${s.id}`,
            title: s.objective,
            subtitle: s.ticket || undefined,
            run: () => deps.focus(s),
        });
    }
    return items;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/cockpit/palette-focus.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the group into the palette**

In `frontend/app/cockpit/command-palette.tsx`:

(a) Add imports:

```tsx
import { buildFocusItems } from "./palette-focus";
import { activeSpaceAtom, enterSpace, exitSpace, loadSpaces, spacesAtom } from "@/app/view/agents/spacestore";
```

(b) Add `"focus-task"` to the `PaletteKind` union (line ~34):

```tsx
type PaletteKind = "launch" | "ask-jarvis" | "focus-task" | "command" | "agent" | "session" | "channel";
```

(c) Put `"focus-task"` first in `GROUP_ORDER` and add its label to `GROUP_LABELS`:

```tsx
const GROUP_ORDER: PaletteKind[] = ["focus-task", "command", "agent", "session"];
const GROUP_LABELS: Record<Exclude<PaletteKind, "launch" | "ask-jarvis">, string> = {
    "focus-task": "Focus on task",
    command: "Commands",
    agent: "Agents",
    session: "Sessions",
    channel: "Channels",
};
```

(d) Read the atoms near the other `useAtomValue` calls (after `const channels = useAtomValue(channelsAtom);`):

```tsx
    const spaces = useAtomValue(spacesAtom);
    const activeSpace = useAtomValue(activeSpaceAtom);
```

(e) Refresh the task list on each open — in the existing open `useEffect` (the one that calls `loadSessionsArchive`), add after the `loadedRef` block:

```tsx
        if (open) {
            loadSpaces();
        }
```

(f) Build the focus palette items (add after the `channelItems` memo, near the other item memos):

```tsx
    // "Focus on task" group: rows for each active|paused task (+ Exit focus when focused). Selecting a
    // row enters that Space (re-lensing the scoped surfaces) and closes the palette.
    const focusItems = useMemo<PaletteItem[]>(
        () =>
            buildFocusItems(spaces, activeSpace?.id ?? null, {
                focus: (s) => {
                    enterSpace(s);
                    close();
                },
                exit: () => {
                    exitSpace();
                    close();
                },
            }).map((fi) => ({
                key: fi.key,
                kind: "focus-task" as const,
                search: fi.subtitle ? `${fi.title} ${fi.subtitle}` : fi.title,
                title: fi.title,
                subtitle: fi.subtitle,
                run: fi.run,
            })),
        [spaces, activeSpace, model]
    );
```

(g) Include the focus items in the default-scope ranked pool. Change the default-branch ranking line (`const ranked = rankPaletteItems(items, query);` at ~line 301) to:

```tsx
        const ranked = rankPaletteItems([...focusItems, ...items], query);
```

(No render change needed: `"focus-task"` is a normal ranked group rendered by the standard group renderer via `GROUP_LABELS`; only `"launch"`/`"ask-jarvis"` use the accent-railed lead block.)

- [ ] **Step 6: Typecheck + unit tests + commit**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx vitest run frontend/app/cockpit/palette-focus.test.ts frontend/app/cockpit/palette-ask.test.ts`
Expected: PASS (focus builder + the untouched ask builder still green).

```bash
git add frontend/app/cockpit/palette-focus.ts frontend/app/cockpit/palette-focus.test.ts frontend/app/cockpit/command-palette.tsx
git commit -m "feat(jarvis): U1 Ctrl+P 'Focus on task' group"
```

---

### Task 5: Frontend — scope the Agent roster (filter + banner)

**Files:**
- Create: `frontend/app/view/agents/spacebanner.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

**Interfaces:**
- Consumes: `filterBySpace`, `spaceBannerText` (`./spacescope`); `activeSpaceAtom`, `spaceScopeAtom`, `spaceRevealAtom`, `revealSurface`, `concealSurface` (`./spacestore`); `SurfaceKey` (`./agents`).
- Produces: `SpaceBanner` component `{ surface: SurfaceKey; text: string; revealed: boolean }`.

- [ ] **Step 1: Create the escape-hatch banner component**

Create `frontend/app/view/agents/spacebanner.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Presence-C escape-hatch banner on a scoped surface (roster, channels). "Show all" reveals the
// hidden rows for this surface without leaving the Space; once revealed it flips to "Re-focus". Copy is
// computed by spaceBannerText (pure).

import type { SurfaceKey } from "./agents";
import { concealSurface, revealSurface } from "./spacestore";

export function SpaceBanner({ surface, text, revealed }: { surface: SurfaceKey; text: string; revealed: boolean }) {
    const toggle = () => (revealed ? concealSurface(surface) : revealSurface(surface));
    return (
        <div className="mx-1 mb-2 flex items-center gap-2 rounded-[8px] border border-accent/30 bg-accent/5 px-3 py-1.5 text-[12px] text-secondary">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="flex-1 truncate">{text}</span>
            <button
                type="button"
                onClick={toggle}
                className="shrink-0 cursor-pointer font-medium text-accent-soft hover:text-accent-100"
            >
                {revealed ? "Re-focus" : "Show all"}
            </button>
        </div>
    );
}
```

- [ ] **Step 2: Apply the Space filter to the roster pipeline**

In `frontend/app/view/agents/cockpitsurface.tsx`, add imports:

```tsx
import { filterBySpace, spaceBannerText } from "./spacescope";
import { activeSpaceAtom, spaceRevealAtom, spaceScopeAtom } from "./spacestore";
import { SpaceBanner } from "./spacebanner";
```

Replace the roster-scoping lines (currently `const visibleOrdered = filterAgents(orderedAgents, projectFilter, liveOnly);` at ~line 207) with:

```tsx
    const spaceScope = useAtomValue(spaceScopeAtom);
    const activeSpace = useAtomValue(activeSpaceAtom);
    const agentRevealed = useAtomValue(spaceRevealAtom).has("agent");
    // project + live-only first (global/needs-you counts read the unfiltered set — see needsYou above),
    // then the Space lens. hidden = rows the Space filter removed (drives the banner's count).
    const projectScoped = filterAgents(orderedAgents, projectFilter, liveOnly);
    const visibleOrdered = filterBySpace(projectScoped, spaceScope, agentRevealed);
    const spaceHidden = projectScoped.length - visibleOrdered.length;
```

(Leave `needsYou` at line 89, and the parked-idle/backgrounded sections at ~223-224, untouched — they must stay global so focus never hides a needs-you signal. `shownAgents = shownForChip(visibleOrdered, chip)` stays as-is directly below.)

- [ ] **Step 3: Render the banner in the sticky header**

In the return JSX, inside the sticky header block (`<div className="sticky top-0 z-[5] ...">`, starts ~line 365), after the `SurfaceHeader` wrapper and the status-chip row and before that sticky `<div>` closes, add:

```tsx
                    {activeSpace != null ? (
                        <SpaceBanner
                            surface="agent"
                            text={spaceBannerText(activeSpace.objective, spaceHidden, agentRevealed)}
                            revealed={agentRevealed}
                        />
                    ) : null}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Verify behavior in the dev app**

With the dev app running, focus a task from the app-bar chip (or Ctrl+P) — one that has attributed runs (e.g. after dispatching a run in a channel). Confirm: the roster grid shows only that task's worker rows, the banner reads `Focused: <objective> · N hidden`, "Show all" reveals the rest, and the nav-rail "needs you" badge is unchanged.
Run: `node scripts/cdp-shot.mjs cdp-shots/u1-roster.png` to capture the scoped roster + banner.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/spacebanner.tsx frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(jarvis): U1 scope the Agent roster to the active Space"
```

---

### Task 6: Frontend — scope the Channels rail (filter + banner)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx`
- Modify: `frontend/app/view/agents/channelrail.tsx`

**Interfaces:**
- Consumes: `filterChannelsBySpace`, `spaceBannerText` (`./spacescope`); `activeSpaceAtom`, `spaceScopeAtom`, `spaceRevealAtom` (`./spacestore`); `SpaceBanner` (`./spacebanner`).
- Produces: `ChannelRail` gains an optional `spaceBanner?: ReactNode` prop, rendered above the channel list.

- [ ] **Step 1: Accept + render a banner slot in the rail**

In `frontend/app/view/agents/channelrail.tsx`:

(a) Ensure `ReactNode` is imported — add `type ReactNode` to the existing `from "react"` import (e.g. `import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";`).

(b) Add `spaceBanner` to the destructured props and the props type:

```tsx
export function ChannelRail({
    channels,
    activeId,
    agents,
    projects,
    picking,
    spaceBanner,
    onSelect,
    onToggleNew,
    onPickProject,
    onDeleteChannel,
    onSetTier,
    onRenameChannel,
    onArchiveChannel,
}: {
    channels: Channel[] | null;
    activeId: string | undefined;
    agents: AgentVM[];
    projects: Record<string, { path?: string }>;
    picking: boolean;
    spaceBanner?: ReactNode;
    onSelect: (id: string) => void;
    onToggleNew: () => void;
    onPickProject: (name: string, path: string) => void;
    onDeleteChannel: (id: string) => void;
    onSetTier: (id: string, tier: JarvisTier) => void;
    onRenameChannel: (id: string, name: string) => void;
    onArchiveChannel: (id: string, archived: boolean) => void;
}) {
```

(c) Render the banner immediately after the search-box block (the `<div className="border-b border-edge-faint px-3.5 py-3">…</div>` that wraps the "Search channels" input), before the channel list:

```tsx
            {spaceBanner != null ? <div className="px-2 pt-2">{spaceBanner}</div> : null}
```

- [ ] **Step 2: Filter the channels prop + pass the banner at the call site**

In `frontend/app/view/agents/channelssurface.tsx`, add imports:

```tsx
import { filterChannelsBySpace, spaceBannerText } from "./spacescope";
import { activeSpaceAtom, spaceRevealAtom, spaceScopeAtom } from "./spacestore";
import { SpaceBanner } from "./spacebanner";
```

Near the top of the component (after `const channels = useAtomValue(channelsAtom);`), derive the scoped list:

```tsx
    const spaceScope = useAtomValue(spaceScopeAtom);
    const activeSpace = useAtomValue(activeSpaceAtom);
    const channelsRevealed = useAtomValue(spaceRevealAtom).has("channels");
    const scopedChannels = filterChannelsBySpace(channels, spaceScope, channelsRevealed);
    const channelsHidden = (channels?.length ?? 0) - (scopedChannels?.length ?? 0);
```

Then in the `<ChannelRail .../>` element (call site ~line 318), change `channels={channels}` to `channels={scopedChannels}` and add the banner prop:

```tsx
                <ChannelRail
                    channels={scopedChannels}
                    activeId={activeId}
                    agents={agents}
                    projects={projects}
                    picking={picking}
                    spaceBanner={
                        activeSpace != null ? (
                            <SpaceBanner
                                surface="channels"
                                text={spaceBannerText(activeSpace.objective, channelsHidden, channelsRevealed)}
                                revealed={channelsRevealed}
                            />
                        ) : null
                    }
                    onSelect={(id) => fireAndForget(() => selectChannel(id))}
```

(Leave the rest of the `ChannelRail` props unchanged.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify behavior in the dev app**

With a task focused, open the Channels surface: confirm the rail shows only the task's channel(s), the banner appears above the list, and "Show all" reveals the rest.
Run: `node scripts/cdp-shot.mjs cdp-shots/u1-channels.png`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelrail.tsx frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(jarvis): U1 scope the Channels rail to the active Space"
```

---

### Task 7: Verification pass + tracking table

**Files:**
- Modify: `docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md` (tracking table)

**Interfaces:** none (verification + docs).

- [ ] **Step 1: Full unit + build sweep**

Run: `go test ./pkg/wshrpc/... && npx vitest run frontend/app/view/agents/spacescope.test.ts frontend/app/cockpit/palette-focus.test.ts`
Expected: all PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 2: End-to-end dev walkthrough (manual — scoping is data-driven, not fixture/atom-drivable)**

Note: the CDP scenario harness asserts via RPC/DOM only (`globalStore` is not exposed on `window`), so Space filtering cannot be atom-driven from a scenario. Verify manually against the live dev app:
1. Fresh app → app-bar chip reads **"Global"**; roster + Channels behave exactly as before (Presence D intact).
2. Dispatch a run in a channel (creates a dossier + attributed run). Open the chip → the task appears; select it.
3. Roster grid + Channels rail filter to that task; both show the `Focused: …` banner; "Show all" reveals the rest; the nav-rail "needs you" badge is unchanged.
4. Ctrl+P → "Focus on task" group lists the task + (when focused) "Exit focus"; both work.
5. Switch surfaces away and back — focus persists (chip still shows the task).
Capture a contact set: `node scripts/cdp-shot.mjs cdp-shots/u1-global.png` (before focus) and reuse `u1-roster.png` / `u1-channels.png` from Tasks 5–6.

- [ ] **Step 3: Update the v2 meta spec tracking table**

In `docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md`, update the U1 row's **Plan** and **Built** cells:

```markdown
| U1 | Presence C ("Spaces") | [spec](2026-07-24-jarvis-u1-spaces-design.md) | [plan](../plans/2026-07-24-jarvis-u1-spaces.md) | Built — app-bar Space chip + Ctrl+P "Focus on task" group scope the Agent roster + Channels to a task's attributed runs (via D's EdgesFor); filter + "Show all" escape hatch; needs-you never suppressed; `ListDossiers`/`ResolveSpaceScope` pure-read RPCs (`pkg/wshrpc`). No embeddings/model/WaveObj/migration. Sessions/Radar/Jarvis-recall-default deferred |
```

- [ ] **Step 4: Self-review the diff, then commit (checkpoint — batch per git policy)**

Run: `git status` and review the staged diff for stray debug/commented code.

```bash
git add docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md
git commit -m "docs(jarvis): mark U1 (Spaces) built in v2 tracking table"
```

---

## Self-Review

**1. Spec coverage:**
- Spec §"What a Space is" (active|paused vault dossiers, objective label) → Task 1 `listDossiers`.
- Spec §"The seam — space-scope contract" (`SpaceSummary`, `SpaceScope`) → Task 1 types.
- Spec §"Backend — two new wshrpc commands" → Task 1 (`ListDossiersCommand`, `ResolveSpaceScopeCommand`, `buildSpaceScope`; graceful degradation = OpenVault scaffolds an empty vault → empty list → chip shows only Global).
- Spec §"Frontend — state" (module atoms, one-directional import) → Task 2 `spacestore.ts` under `view/agents/`.
- Spec §"app-bar chip + switcher" (mirror `ProjectSwitcher`, breadcrumb, Exit focus, Space-wins) → Task 3.
- Spec §"Ctrl+P 'Focus on task…' group" → Task 4.
- Spec §"scoping the surfaces" (roster + Channels, filter + escape-hatch banner, needs-you never suppressed) → Tasks 5–6 + Global Constraints.
- Spec §"Edge cases" (empty scope banner via `spaceBannerText(…,0,…)` → `Focused: <objective>`; reset reveal on switch via `enterSpace`) → Tasks 2/5.
- Spec §Testing (vitest pure, Go pure/vault, manual/DOM for chrome) → Tasks 1,2,4,7.
- Spec §Out of scope (Sessions, Radar, Jarvis-recall-default, keyboard quick-switch, live push) → not implemented; recorded in tracking-table Built note.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✅

**3. Type consistency:** `SpaceScope` fields are `runorefs/channeloids/tabids` (Go json tags) everywhere on the FE; `filterBySpace`/`filterChannelsBySpace`/`spaceBannerText` signatures match between `spacescope.ts`, its test, and the Task 5/6 call sites; `FocusDeps.focus` takes a `SpaceSummary` in `palette-focus.ts`, its test, and the palette wiring; `SpaceSummary` fields `id/objective/ticket/status/updated` consistent across Go, switcher, palette, and tests; `enterSpace/exitSpace/revealSurface/concealSurface/loadSpaces` names match between `spacestore.ts` and all consumers. ✅
