# Cockpit Focus (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cockpit's scope contract real — every surface honors the posture it declares in `SURFACE_CONTEXT`, and focus can point at a task, an agent or a run instead of a dossier only.

**Architecture:** Two scope dimensions stay separate: project (`projectFilterAtom`, a name) and focus (a resolved `SpaceScope` bundle). One Go resolver widens from `DossierId` to `(Kind, Id)` and returns the same bundle shape, so every existing filter keeps working. A pure `subjectDecision` function decides seed / aligned / diverged for the surfaces that declare `subject` posture, and one banner renders that decision.

**Tech Stack:** Go (wshrpc + wshserver), TypeScript/React 19, jotai, vitest, Tailwind 4. Build orchestrated by Task.

**Spec:** `docs/superpowers/specs/2026-09-22-cockpit-focus-and-peek-design.md`

**Tracker:** `effort:868d36b8-4871-4134-a920-772df62963b1` — chunks `S1-1` … `S1-6` are this plan's tasks grouped; `S2-*` are Slice 2. Claim a chunk before starting it (`wsh effort chunk attach <effort> "<chunk>" --agent <tabid>`) and tick it `done` only when its tasks are actually complete.

## Global Constraints

- **Never hand-edit generated files.** `task generate` writes `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`. Edit the Go definitions, then regenerate.
- **Typecheck with `task check:ts`**, never bare `npx tsc` (it stack-overflows on this repo). It takes ~2 minutes — allow more than the default timeout. Baseline is clean; any error it reports is yours.
- **`tsconfig` is not strict.** A `{ok:true} | {ok:false; reason}` union does **not** narrow on `.ok` — use `"reason" in result`. Tests pass under vitest while `tsc` fails.
- **Go tests need the vendored header.** From PowerShell at the repo root: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"` before `go test ./pkg/...`. A Git-Bash POSIX path silently fails with the same error.
- **HEAD is not formatter-clean.** `gofmt -l pkg cmd` lists ~50 files and prettier fails in places. Check only the files you touched; never `--write` the tree. Never run prettier on `scripts/*.mjs`.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. Never raw hex/rgba in components — a hardcoded color silently opts out of every runtime theme.
- **`SpaceScope` (the Go wire type) keeps its name.** Only the frontend store's concepts rename to Focus. Renaming the wire type would churn every generated file for no behavior gain; the spec names it as the currency that stays.
- **Commit messages:** `type(scope): description`, subject < 72 chars, explaining WHY. No `Co-Authored-By` trailer.

---

## File Structure

**Go — the resolver**
- `pkg/wshrpc/wshrpctypes_jarvis.go` — modify: `CommandResolveSpaceScopeData` → `CommandResolveFocusScopeData`, interface method rename.
- `pkg/wshrpc/wshserver/wshserver_jarvis.go` — modify: `ResolveFocusScopeCommand` dispatch; add `focusScopeForAgent`, `focusScopeForRun`, `runHasWorkerTab`.
- `pkg/wshrpc/wshserver/wshserver_space_test.go` — modify: add resolver tests beside the existing `buildSpaceScope` test.

**Frontend — the store**
- `frontend/app/view/agents/focusstore.ts` — created by renaming `spacestore.ts`. Owns `activeFocusAtom`, `focusScopeAtom`, `focusRevealAtom`, `focusesAtom`, `enterFocus`, `exitFocus`, `revealSurface`, `concealSurface`, `reresolveFocus`.
- `frontend/app/view/agents/focusscope.ts` — created by renaming `spacescope.ts`. Owns `filterByFocus`, `filterChannelsByFocus`, `filterSessionsByFocus`, `focusBannerText`.
- `frontend/app/view/agents/focussubject.ts` — **new.** Pure `subjectDecision` + its copy. The seed/aligned/diverged decision every `subject`-posture surface shares.
- `frontend/app/view/agents/focusbanner.tsx` — created by renaming `spacebanner.tsx`; gains the diverged variant.
- `frontend/app/view/agents/focusswitcher.tsx` — created by renaming `spaceswitcher.tsx`; gains agent and run groups.

**Frontend — the contract and its consumers**
- `frontend/app/view/agents/surfacecontext.ts` — modify: correct Radar's project posture to `subject`.
- `frontend/app/view/agents/radarsurface.tsx`, `frontend/app/view/code/codestore.ts` + `codepathbar.tsx`, `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/view/agents/vaultsurface.tsx`, `frontend/app/view/jarvis/briefsurface.tsx` — modify: honor declared posture.
- `frontend/app/store/keybindings/bindings.ts` — modify: the `.` focus binding.

---

## Task 1: Mechanical rename — Space becomes Focus

No behavior change. Lands first so every later task uses final names; splitting it out keeps the behavior diffs readable.

**Files:**
- Rename: `frontend/app/view/agents/spacestore.ts` → `focusstore.ts`
- Rename: `frontend/app/view/agents/spacescope.ts` → `focusscope.ts`
- Rename: `frontend/app/view/agents/spacescope.test.ts` → `focusscope.test.ts`
- Rename: `frontend/app/view/agents/spacebanner.tsx` → `focusbanner.tsx`
- Rename: `frontend/app/view/agents/spaceswitcher.tsx` → `focusswitcher.tsx`
- Modify: `cockpitsurface.tsx`, `sessionssurface.tsx`, `app-bar.tsx`, `command-palette.tsx` (import sites)

**Interfaces:**
- Consumes: nothing.
- Produces: `activeFocusAtom`, `focusScopeAtom`, `focusRevealAtom`, `focusesAtom`, `enterFocus`, `exitFocus`, `revealSurface`, `concealSurface`, `filterByFocus`, `filterChannelsByFocus`, `filterSessionsByFocus`, `focusBannerText`, `FocusBanner`, `FocusSwitcher`. Signatures unchanged from their `Space` originals in this task.

- [x] **Step 1: Rename the files with git mv**

```bash
cd frontend/app/view/agents
git mv spacestore.ts focusstore.ts
git mv spacescope.ts focusscope.ts
git mv spacescope.test.ts focusscope.test.ts
git mv spacebanner.tsx focusbanner.tsx
git mv spaceswitcher.tsx focusswitcher.tsx
```

**If the dev app is running, it will blank with no error overlay after this** — `git mv` of frontend modules defeats HMR. Fix with a full `location.reload()` in the app, not by reverting.

- [x] **Step 2: Rename the identifiers**

Apply exactly these, repo-wide across `frontend/`:

| From | To |
|---|---|
| `activeSpaceAtom` | `activeFocusAtom` |
| `spaceScopeAtom` | `focusScopeAtom` |
| `spaceRevealAtom` | `focusRevealAtom` |
| `spacesAtom` | `focusesAtom` |
| `loadSpaces` | `loadFocuses` |
| `enterSpace` | `enterFocus` |
| `exitSpace` | `exitFocus` |
| `filterBySpace` | `filterByFocus` |
| `filterChannelsBySpace` | `filterChannelsByFocus` |
| `filterSessionsBySpace` | `filterSessionsByFocus` |
| `spaceBannerText` | `focusBannerText` |
| `SpaceBanner` | `FocusBanner` |
| `SpaceSwitcher` | `FocusSwitcher` |

Do **not** rename: `SpaceScope` (Go wire type), `SpaceSummary` (Go wire type), `ResolveSpaceScopeCommand` (Task 2 renames it), or any local variable named `space`/`scope` inside a function body.

- [x] **Step 3: Verify nothing behavioral changed**

```bash
npx vitest run frontend/app/view/agents/focusscope.test.ts
```

Expected: PASS, same test count as before the rename.

- [x] **Step 4: Typecheck**

```bash
task check:ts
```

Expected: exit 0. Any error is a missed import site.

- [x] **Step 5: Commit**

```bash
git add -A frontend/
git commit -m "refactor(cockpit): rename Space to Focus so the store matches the UI's own word"
```

---

## Task 2: Widen the focus-scope resolver to agent and run

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go:18` (interface), `:241-245` (data type)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go:518-540` (handler); add helpers near `buildSpaceScope` at `:654`
- Test: `pkg/wshrpc/wshserver/wshserver_space_test.go`
- Modify: `frontend/app/view/agents/focusstore.ts` (caller passes the new shape)

**Interfaces:**
- Consumes: `buildSpaceScope(edges, byORef) wshrpc.SpaceScope` (existing, unchanged); `waveobj.Run.Phases[].WorkerOrefs`, `waveobj.Run.ChannelOID`.
- Produces: `ResolveFocusScopeCommand(ctx, CommandResolveFocusScopeData{Kind, Id}) (*wshrpc.SpaceScope, error)`; TS `RpcApi.ResolveFocusScopeCommand(client, {kind, id})`.

- [x] **Step 1: Write the failing Go tests**

Append to `pkg/wshrpc/wshserver/wshserver_space_test.go`. **Append — do not overwrite the file**; it already holds the `buildSpaceScope` test at line 28.

```go
func runWithWorkers(oid string, channelOID string, tabs ...string) *waveobj.Run {
	orefs := make([]string, 0, len(tabs))
	for _, t := range tabs {
		orefs = append(orefs, "tab:"+t)
	}
	return &waveobj.Run{
		OID:        oid,
		ChannelOID: channelOID,
		Phases:     []waveobj.RunPhase{{Kind: "execute", State: "done", WorkerOrefs: orefs}},
	}
}

func TestFocusScopeForAgentBundlesItsRunsAndChannels(t *testing.T) {
	runs := []*waveobj.Run{
		runWithWorkers("r1", "c1", "t1", "t2"),
		runWithWorkers("r2", "c2", "t9"),
	}
	got := focusScopeForAgent("t1", runs)
	if len(got.TabIds) != 1 || got.TabIds[0] != "t1" {
		t.Fatalf("tabids = %v, want [t1]", got.TabIds)
	}
	if len(got.RunORefs) != 1 || got.RunORefs[0] != "run:r1" {
		t.Fatalf("runorefs = %v, want [run:r1]", got.RunORefs)
	}
	if len(got.ChannelOids) != 1 || got.ChannelOids[0] != "c1" {
		t.Fatalf("channeloids = %v, want [c1]", got.ChannelOids)
	}
}

// A standalone agent no run owns is a legitimate focus. An empty bundle would hide it from every
// filter surface, which reads as the focus being broken rather than the agent being unattached.
func TestFocusScopeForAgentKeepsTheTabWhenNoRunOwnsIt(t *testing.T) {
	got := focusScopeForAgent("t7", []*waveobj.Run{runWithWorkers("r1", "c1", "t1")})
	if len(got.TabIds) != 1 || got.TabIds[0] != "t7" {
		t.Fatalf("tabids = %v, want [t7]", got.TabIds)
	}
	if len(got.RunORefs) != 0 {
		t.Fatalf("runorefs = %v, want empty", got.RunORefs)
	}
}

func TestFocusScopeForRunBundlesItsChannelAndWorkers(t *testing.T) {
	runs := []*waveobj.Run{runWithWorkers("r1", "c1", "t1", "t2"), runWithWorkers("r2", "c2", "t3")}
	got := focusScopeForRun("r1", runs)
	if len(got.RunORefs) != 1 || got.RunORefs[0] != "run:r1" {
		t.Fatalf("runorefs = %v, want [run:r1]", got.RunORefs)
	}
	if len(got.ChannelOids) != 1 || got.ChannelOids[0] != "c1" {
		t.Fatalf("channeloids = %v, want [c1]", got.ChannelOids)
	}
	if len(got.TabIds) != 2 || got.TabIds[0] != "t1" || got.TabIds[1] != "t2" {
		t.Fatalf("tabids = %v, want [t1 t2]", got.TabIds)
	}
}

// A worker oref that is not a tab: address must not be trimmed into a spurious match.
func TestFocusScopeForAgentIgnoresNonTabWorkerOrefs(t *testing.T) {
	run := &waveobj.Run{OID: "r1", Phases: []waveobj.RunPhase{{WorkerOrefs: []string{"t1", "block:t1"}}}}
	got := focusScopeForAgent("t1", []*waveobj.Run{run})
	if len(got.RunORefs) != 0 {
		t.Fatalf("runorefs = %v, want empty", got.RunORefs)
	}
}
```

- [x] **Step 2: Run the tests to verify they fail**

From PowerShell at the repo root:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wshrpc/wshserver/ -run TestFocusScope -v
```

Expected: FAIL — `undefined: focusScopeForAgent`, `undefined: focusScopeForRun`.

- [x] **Step 3: Change the wire type and interface method**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, replace the data type at `:241`:

```go
// CommandResolveFocusScopeData names what the cockpit is focused on. Kind is task | agent | run;
// all three resolve to the same SpaceScope bundle, which is what every surface filter consumes.
type CommandResolveFocusScopeData struct {
	Kind string `json:"kind"`
	Id   string `json:"id"`
}
```

And at `:18`, replace the interface line:

```go
	ResolveFocusScopeCommand(ctx context.Context, data CommandResolveFocusScopeData) (*SpaceScope, error) // resolve a focus target's scope bundle (runs -> channels + worker tabs)
```

- [x] **Step 4: Implement the handler and helpers**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, replace `ResolveSpaceScopeCommand` (`:518-540`) with:

```go
func (ws *WshServer) ResolveFocusScopeCommand(ctx context.Context, data wshrpc.CommandResolveFocusScopeData) (*wshrpc.SpaceScope, error) {
	if data.Id == "" {
		return nil, fmt.Errorf("id is required")
	}
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, fmt.Errorf("loading runs: %w", err)
	}
	switch data.Kind {
	case "task":
		v, err := wavevault.OpenVault(ctx)
		if err != nil {
			return nil, fmt.Errorf("opening vault: %w", err)
		}
		edges, err := jarvisattrib.EdgesFor(ctx, v, data.Id)
		if err != nil {
			return nil, fmt.Errorf("resolving edges: %w", err)
		}
		byORef := make(map[string]*waveobj.Run, len(runs))
		for _, run := range runs {
			byORef["run:"+run.OID] = run
		}
		scope := buildSpaceScope(edges, byORef)
		return &scope, nil
	case "agent":
		scope := focusScopeForAgent(data.Id, runs)
		return &scope, nil
	case "run":
		scope := focusScopeForRun(data.Id, runs)
		return &scope, nil
	default:
		// an unknown kind must not return an empty bundle: empty is indistinguishable from a real
		// focus that currently matches nothing, and every filter surface would render blank with
		// no explanation of why
		return nil, fmt.Errorf("unknown focus kind %q", data.Kind)
	}
}
```

Add beside `buildSpaceScope` (after `:688`):

```go
// focusScopeForAgent bundles one agent tab with every run that has it as a phase worker, plus those
// runs' channels. The tab is in the bundle even when no run owns it — a standalone agent is a
// legitimate focus.
func focusScopeForAgent(tabID string, runs []*waveobj.Run) wshrpc.SpaceScope {
	scope := wshrpc.SpaceScope{RunORefs: []string{}, ChannelOids: []string{}, TabIds: []string{tabID}}
	seenChan := map[string]bool{}
	for _, run := range runs {
		if !runHasWorkerTab(run, tabID) {
			continue
		}
		scope.RunORefs = append(scope.RunORefs, "run:"+run.OID)
		if run.ChannelOID != "" && !seenChan[run.ChannelOID] {
			seenChan[run.ChannelOID] = true
			scope.ChannelOids = append(scope.ChannelOids, run.ChannelOID)
		}
	}
	return scope
}

func runHasWorkerTab(run *waveobj.Run, tabID string) bool {
	for _, ph := range run.Phases {
		for _, wo := range ph.WorkerOrefs {
			if strings.HasPrefix(wo, "tab:") && strings.TrimPrefix(wo, "tab:") == tabID {
				return true
			}
		}
	}
	return false
}

// focusScopeForRun bundles one run with its channel and every phase worker tab.
func focusScopeForRun(runID string, runs []*waveobj.Run) wshrpc.SpaceScope {
	scope := wshrpc.SpaceScope{RunORefs: []string{"run:" + runID}, ChannelOids: []string{}, TabIds: []string{}}
	seenTab := map[string]bool{}
	for _, run := range runs {
		if run.OID != runID {
			continue
		}
		if run.ChannelOID != "" {
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

- [x] **Step 5: Run the tests to verify they pass**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wshrpc/wshserver/ -run "TestFocusScope|TestBuildSpaceScope" -v
```

Expected: PASS, including the pre-existing `buildSpaceScope` test.

- [x] **Step 6: Regenerate bindings**

```bash
task generate
```

Expected: `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts` all show `ResolveFocusScopeCommand` and `CommandResolveFocusScopeData`. Do not hand-edit them.

- [x] **Step 7: Update the one frontend caller so the build stays green**

In `frontend/app/view/agents/focusstore.ts`, inside `enterFocus`, change the RPC call only — the signature change lands in Task 3:

```ts
const scope = await RpcApi.ResolveFocusScopeCommand(TabRpcClient, { kind: "task", id: summary.id });
```

- [x] **Step 8: Typecheck and commit**

```bash
task check:ts
git add pkg/ frontend/ && git commit -m "feat(focus): resolve a scope bundle for an agent or run, not dossiers only"
```

---

## Task 3: FocusRef, enterFocus, and focus implies project

**Files:**
- Modify: `frontend/app/view/agents/focusstore.ts`
- Test: `frontend/app/view/agents/focusstore.test.ts` (create)
- Modify: `frontend/app/view/agents/focusswitcher.tsx` (call site)

**Interfaces:**
- Consumes: `RpcApi.ResolveFocusScopeCommand({kind, id})` from Task 2; `projectOf(a: AgentVM): string` from `agentsviewmodel.ts:862`.
- Produces:
  - `type FocusKind = "task" | "agent" | "run"`
  - `interface FocusRef { kind: FocusKind; id: string }`
  - `interface ActiveFocus { ref: FocusRef; label: string; project: string }`
  - `enterFocus(focus: ActiveFocus): void`
  - `exitFocus(): void`
  - `activeFocusAtom: PrimitiveAtom<ActiveFocus | null>`

- [x] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/focusstore.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { ResolveFocusScopeCommand: vi.fn(async () => ({ runorefs: [], channeloids: [], tabids: ["t1"] })) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { RpcApi } from "@/app/store/wshclientapi";
import { activeFocusAtom, enterFocus, exitFocus, focusScopeAtom } from "./focusstore";

const model = { projectFilterAtom: null as any };

beforeEach(() => {
    globalStore.set(activeFocusAtom, null);
    globalStore.set(focusScopeAtom, null);
    vi.clearAllMocks();
});

test("enterFocus sets the active focus immediately, before the resolve lands", () => {
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "jarvis-recall", project: "waveterm" });
    expect(globalStore.get(activeFocusAtom)?.label).toBe("jarvis-recall");
    expect(globalStore.get(focusScopeAtom)).toBeNull();
});

test("enterFocus resolves with the ref's own kind", async () => {
    enterFocus({ ref: { kind: "run", id: "r9" }, label: "fix vault restore", project: "waveterm" });
    await vi.waitFor(() => expect(globalStore.get(focusScopeAtom)).not.toBeNull());
    expect(RpcApi.ResolveFocusScopeCommand).toHaveBeenCalledWith(expect.anything(), { kind: "run", id: "r9" });
});

test("a resolve that lands after the user switched focus is discarded", async () => {
    (RpcApi.ResolveFocusScopeCommand as any).mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r({ runorefs: [], channeloids: [], tabids: ["stale"] }), 20))
    );
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "a", project: "p" });
    enterFocus({ ref: { kind: "agent", id: "t2" }, label: "b", project: "p" });
    await new Promise((r) => setTimeout(r, 40));
    expect(globalStore.get(focusScopeAtom)?.tabids).not.toContain("stale");
});

test("exitFocus clears focus", () => {
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "a", project: "p" });
    exitFocus();
    expect(globalStore.get(activeFocusAtom)).toBeNull();
    expect(globalStore.get(focusScopeAtom)).toBeNull();
});
```

- [x] **Step 2: Run to verify it fails**

```bash
npx vitest run frontend/app/view/agents/focusstore.test.ts
```

Expected: FAIL — `enterFocus` still takes a `SpaceSummary`.

- [x] **Step 3: Implement**

In `frontend/app/view/agents/focusstore.ts`, replace the atom and the two functions:

```ts
export type FocusKind = "task" | "agent" | "run";

export interface FocusRef {
    kind: FocusKind;
    id: string;
}

// label and project travel with the ref because every caller already holds both — a task from
// SpaceSummary.objective, an agent from projectOf(agent), a run from its Goal and ProjectPath.
// Resolving them server-side would be a second copy to keep in sync.
export interface ActiveFocus {
    ref: FocusRef;
    label: string;
    project: string; // "" when unresolvable; the project write is then skipped
}

export const activeFocusAtom = atom<ActiveFocus | null>(null) as PrimitiveAtom<ActiveFocus | null>;

function sameRef(a: FocusRef | undefined, b: FocusRef | undefined): boolean {
    return a != null && b != null && a.kind === b.kind && a.id === b.id;
}

// enterFocus flips the indicator immediately, clears prior reveals, then resolves the bundle. A
// resolve that lands after the user moved on is discarded — the whole ref is compared, not just the
// id, because two kinds can carry the same id string.
export function enterFocus(focus: ActiveFocus): void {
    globalStore.set(activeFocusAtom, focus);
    globalStore.set(focusRevealAtom, new Set<SurfaceKey>());
    globalStore.set(focusScopeAtom, null);
    fireAndForget(async () => {
        const scope = await RpcApi.ResolveFocusScopeCommand(TabRpcClient, focus.ref);
        if (!sameRef(globalStore.get(activeFocusAtom)?.ref, focus.ref)) {
            return;
        }
        globalStore.set(focusScopeAtom, scope ?? null);
    });
}

export function exitFocus(): void {
    globalStore.set(activeFocusAtom, null);
    globalStore.set(focusScopeAtom, null);
    globalStore.set(focusRevealAtom, new Set<SurfaceKey>());
}
```

- [x] **Step 4: Run to verify it passes**

```bash
npx vitest run frontend/app/view/agents/focusstore.test.ts
```

Expected: PASS, 4 tests.

- [x] **Step 5: Add the project implication with its test**

Append to `focusstore.test.ts`:

```ts
test("entering a focus adopts its project; exiting leaves the project alone", () => {
    const projectAtom = { init: "all" } as any;
    const m = { projectFilterAtom: atom("all") } as any;
    enterFocusFor(m, { ref: { kind: "agent", id: "t1" }, label: "a", project: "waveterm" });
    expect(globalStore.get(m.projectFilterAtom)).toBe("waveterm");
    exitFocus();
    expect(globalStore.get(m.projectFilterAtom)).toBe("waveterm");
});

test("a focus with no resolvable project leaves the filter untouched", () => {
    const m = { projectFilterAtom: atom("waveterm") } as any;
    enterFocusFor(m, { ref: { kind: "agent", id: "t1" }, label: "a", project: "" });
    expect(globalStore.get(m.projectFilterAtom)).toBe("waveterm");
});
```

Add `import { atom } from "jotai";` to the test's imports.

Then in `focusstore.ts`:

```ts
// Focus implies project: without this the user can hold a contradictory pair (project A, focus on an
// entity in B) and every filter surface correctly renders empty, which reads as a bug. Exiting focus
// deliberately leaves the project alone — this task, to this project, to everything.
export function enterFocusFor(model: { projectFilterAtom: PrimitiveAtom<string> }, focus: ActiveFocus): void {
    if (focus.project !== "") {
        globalStore.set(model.projectFilterAtom, focus.project);
    }
    enterFocus(focus);
}
```

- [x] **Step 6: Run and commit**

```bash
npx vitest run frontend/app/view/agents/focusstore.test.ts
task check:ts
git add frontend/ && git commit -m "feat(focus): focus any task, agent or run, and adopt its project"
```

---

## Task 4: Persist focus, and degrade when its target dies

**Files:**
- Modify: `frontend/app/view/agents/focusstore.ts`
- Test: `frontend/app/view/agents/focusstore.test.ts`

**Interfaces:**
- Consumes: `pushToast` from `@/app/cockpit/notificationstore`; `ActiveFocus` from Task 3.
- Produces: `persistedFocusAtom` (localStorage key `cockpit.focus.last`); `degradeFocus(reason: string): void`.

- [x] **Step 1: Write the failing tests**

Append to `focusstore.test.ts`:

```ts
test("a vanished focus target degrades to project-only and toasts once", () => {
    enterFocus({ ref: { kind: "agent", id: "gone" }, label: "gone", project: "waveterm" });
    degradeFocus("That agent session has ended");
    expect(globalStore.get(activeFocusAtom)).toBeNull();
    expect(pushToast).toHaveBeenCalledTimes(1);
});

test("degrading when there is no focus is a no-op and does not toast", () => {
    exitFocus();
    degradeFocus("whatever");
    expect(pushToast).not.toHaveBeenCalled();
});
```

Add to the test's mocks block:

```ts
vi.mock("@/app/cockpit/notificationstore", () => ({ pushToast: vi.fn() }));
```

and to its imports: `import { pushToast } from "@/app/cockpit/notificationstore";` plus `degradeFocus` from `./focusstore`.

- [x] **Step 2: Run to verify it fails**

```bash
npx vitest run frontend/app/view/agents/focusstore.test.ts -t "vanished"
```

Expected: FAIL — `degradeFocus` is not exported.

- [x] **Step 3: Implement persistence and degradation**

In `focusstore.ts`:

```ts
// Persisted so a reopened cockpit is where you left it. getOnInit for the same reason
// lastCodeProjectAtom uses it: without it the stored value arrives one render after the first read
// and the app bar flashes "Global" before the restore lands.
export const persistedFocusAtom = atomWithStorage<ActiveFocus | null>("cockpit.focus.last", null, undefined, {
    getOnInit: true,
}) as PrimitiveAtom<ActiveFocus | null>;

// degradeFocus drops to project-only when the focused entity no longer exists. It reports once, the
// same posture openTarget takes: a focus that silently stops applying is worse than one that says
// why it went away. The project set by enterFocusFor deliberately stays.
export function degradeFocus(reason: string): void {
    if (globalStore.get(activeFocusAtom) == null) {
        return;
    }
    exitFocus();
    pushToast({ title: reason, message: "", level: "warn" });
}
```

Add `globalStore.set(persistedFocusAtom, focus)` at the end of `enterFocus`, and `globalStore.set(persistedFocusAtom, null)` at the end of `exitFocus`.

- [x] **Step 4: Restore persisted focus at boot**

In `frontend/app/cockpit/cockpit-root.tsx`, beside the existing startup-surface restore at `:67`:

```ts
const saved = globalStore.get(persistedFocusAtom);
if (saved != null) {
    enterFocus(saved);
}
```

- [x] **Step 5: Run and commit**

```bash
npx vitest run frontend/app/view/agents/focusstore.test.ts
task check:ts
git add frontend/ && git commit -m "feat(focus): survive reload, and say so when a focus target is gone"
```

---

## Task 5: Re-resolve focus on a switch to a focus-honoring surface

**Files:**
- Modify: `frontend/app/view/agents/focusstore.ts`
- Modify: `frontend/app/view/agents/cockpitshell.tsx` (the surface-switch site)
- Test: `frontend/app/view/agents/focusstore.test.ts`

**Interfaces:**
- Consumes: `SURFACE_CONTEXT` from `surfacecontext.ts`; `activeFocusAtom` from Task 3.
- Produces: `reresolveFocus(surface: SurfaceKey): void`.

- [x] **Step 1: Write the failing tests**

```ts
test("switching to a focus-honoring surface re-resolves the bundle", async () => {
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "a", project: "p" });
    await vi.waitFor(() => expect(globalStore.get(focusScopeAtom)).not.toBeNull());
    vi.clearAllMocks();
    reresolveFocus("cockpit");
    expect(RpcApi.ResolveFocusScopeCommand).toHaveBeenCalledTimes(1);
});

test("switching to a surface that ignores focus resolves nothing", () => {
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "a", project: "p" });
    vi.clearAllMocks();
    reresolveFocus("usage");
    expect(RpcApi.ResolveFocusScopeCommand).not.toHaveBeenCalled();
});

test("re-resolving with no active focus does nothing", () => {
    exitFocus();
    reresolveFocus("cockpit");
    expect(RpcApi.ResolveFocusScopeCommand).not.toHaveBeenCalled();
});

test("a re-resolve that rejects degrades to project-only and toasts", async () => {
    enterFocus({ ref: { kind: "run", id: "gone" }, label: "gone", project: "waveterm" });
    await vi.waitFor(() => expect(globalStore.get(focusScopeAtom)).not.toBeNull());
    vi.clearAllMocks();
    (RpcApi.ResolveFocusScopeCommand as any).mockRejectedValueOnce(new Error("no such run"));
    reresolveFocus("cockpit");
    await vi.waitFor(() => expect(globalStore.get(activeFocusAtom)).toBeNull());
    expect(pushToast).toHaveBeenCalledTimes(1);
});

test("a rejected re-resolve for a focus the user already left is ignored", async () => {
    enterFocus({ ref: { kind: "run", id: "r1" }, label: "a", project: "p" });
    (RpcApi.ResolveFocusScopeCommand as any).mockRejectedValueOnce(new Error("boom"));
    reresolveFocus("cockpit");
    enterFocus({ ref: { kind: "run", id: "r2" }, label: "b", project: "p" });
    await new Promise((r) => setTimeout(r, 20));
    expect(globalStore.get(activeFocusAtom)?.ref.id).toBe("r2");
});
```

`degradeFocus` from Task 4 has exactly one caller, and this is it: a re-resolve is the moment the app
re-asks whether the focus target still exists, so it is the moment that can discover it is gone.

- [x] **Step 2: Run to verify it fails**

```bash
npx vitest run frontend/app/view/agents/focusstore.test.ts -t "re-resolve"
```

Expected: FAIL — `reresolveFocus` is not exported.

- [x] **Step 3: Implement**

```ts
// The bundle is a snapshot: a focused agent spawns workers, a new run gets attributed to a focused
// task, a focused entity exits. Re-resolving on arrival at a surface that actually consumes the
// bundle is bounded and lands exactly when it matters. A poller would burn the same RPC while nobody
// is looking at a filtered list.
export function reresolveFocus(surface: SurfaceKey): void {
    const focus = globalStore.get(activeFocusAtom);
    if (focus == null || SURFACE_CONTEXT[surface].space === "unsupported") {
        return;
    }
    fireAndForget(async () => {
        let scope: SpaceScope | null;
        try {
            scope = await RpcApi.ResolveFocusScopeCommand(TabRpcClient, focus.ref);
        } catch {
            // the resolver errors when the target is gone (a deleted run, an unknown kind). Only
            // degrade if this is still the focus the user is on — a rejection for a focus they
            // already left must not clear the one they moved to.
            if (sameRef(globalStore.get(activeFocusAtom)?.ref, focus.ref)) {
                degradeFocus(`That ${focus.ref.kind} is no longer available`);
            }
            return;
        }
        if (!sameRef(globalStore.get(activeFocusAtom)?.ref, focus.ref)) {
            return;
        }
        globalStore.set(focusScopeAtom, scope ?? null);
    });
}
```

- [x] **Step 4: Call it on surface switch**

In `frontend/app/view/agents/cockpitshell.tsx`, add an effect keyed on the current surface value:

```tsx
useEffect(() => {
    reresolveFocus(surface);
}, [surface]);
```

- [x] **Step 5: Run and commit**

```bash
npx vitest run frontend/app/view/agents/focusstore.test.ts
task check:ts
git add frontend/ && git commit -m "refresh(focus): re-resolve the bundle on arrival, so a snapshot never goes stale"
```

---

## Task 6: The pure subject decision

The seed / aligned / diverged call that every `subject`-posture surface shares. Pure, so the logic a keystroke can get wrong is tested without rendering.

**Files:**
- Create: `frontend/app/view/agents/focussubject.ts`
- Test: `frontend/app/view/agents/focussubject.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SubjectDecision = { kind: "seed"; target: string } | { kind: "aligned" } | { kind: "diverged"; focus: string; local: string }`
  - `subjectDecision(local: string | null, focus: string | null): SubjectDecision`
  - `divergenceText(focusLabel: string, localLabel: string): string`

- [x] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/focussubject.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import { divergenceText, subjectDecision } from "./focussubject";

test("no local target and a focus: seed from focus", () => {
    expect(subjectDecision(null, "waveterm")).toEqual({ kind: "seed", target: "waveterm" });
});

test("local target equals focus: aligned, so the surface says nothing", () => {
    expect(subjectDecision("waveterm", "waveterm")).toEqual({ kind: "aligned" });
});

test("local target differs from focus: diverged, carrying both labels", () => {
    expect(subjectDecision("wavesrv", "waveterm")).toEqual({ kind: "diverged", focus: "waveterm", local: "wavesrv" });
});

test("no focus at all: aligned, never diverged — Global is not something to rejoin", () => {
    expect(subjectDecision("wavesrv", null)).toEqual({ kind: "aligned" });
    expect(subjectDecision(null, null)).toEqual({ kind: "aligned" });
});

test("an empty-string local target counts as no target, not as a divergence", () => {
    expect(subjectDecision("", "waveterm")).toEqual({ kind: "seed", target: "waveterm" });
});

test("divergenceText names both sides", () => {
    expect(divergenceText("jarvis-recall", "wavesrv")).toBe("Focus: jarvis-recall · this surface is on wavesrv");
});
```

- [x] **Step 2: Run to verify it fails**

```bash
npx vitest run frontend/app/view/agents/focussubject.test.ts
```

Expected: FAIL — cannot resolve `./focussubject`.

- [x] **Step 3: Implement**

Create `frontend/app/view/agents/focussubject.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one decision every "subject"-posture surface makes: adopt the focus, say nothing, or say it has
// diverged. Surfaces differ in what their target IS (a project name, a repo path, a diff origin), so
// each maps its own target to a comparable string and this decides from the pair. Pure — no jotai.

export type SubjectDecision =
    | { kind: "seed"; target: string }
    | { kind: "aligned" }
    | { kind: "diverged"; focus: string; local: string };

export function subjectDecision(local: string | null, focus: string | null): SubjectDecision {
    // no focus is Global, not a thing to rejoin: a surface with its own target is correct as it stands
    if (focus == null || focus === "") {
        return { kind: "aligned" };
    }
    if (local == null || local === "") {
        return { kind: "seed", target: focus };
    }
    return local === focus ? { kind: "aligned" } : { kind: "diverged", focus, local };
}

export function divergenceText(focusLabel: string, localLabel: string): string {
    return `Focus: ${focusLabel} · this surface is on ${localLabel}`;
}
```

- [x] **Step 4: Run to verify it passes**

```bash
npx vitest run frontend/app/view/agents/focussubject.test.ts
```

Expected: PASS, 6 tests.

- [x] **Step 5: Commit**

```bash
git add frontend/app/view/agents/focussubject.ts frontend/app/view/agents/focussubject.test.ts
git commit -m "feat(focus): one pure seed/aligned/diverged decision for subject surfaces"
```

---

## Task 7: The divergence banner

**Files:**
- Modify: `frontend/app/view/agents/focusbanner.tsx`

**Interfaces:**
- Consumes: `SubjectDecision`, `divergenceText` from Task 6; existing `FocusBanner` from Task 1.
- Produces: `DivergenceBanner({ decision, onRejoin }: { decision: SubjectDecision; onRejoin: () => void })` — renders `null` unless `decision.kind === "diverged"`.

- [x] **Step 1: Implement**

Append to `frontend/app/view/agents/focusbanner.tsx`:

```tsx
import { divergenceText, type SubjectDecision } from "./focussubject";

// The subject-posture counterpart to FocusBanner. A subject surface hides nothing, so it needs a
// rejoin rather than a reveal — and it renders nothing at all when aligned, because the app bar
// already carries the global answer and silence is the reward for being in sync.
export function DivergenceBanner({ decision, onRejoin }: { decision: SubjectDecision; onRejoin: () => void }) {
    if (decision.kind !== "diverged") {
        return null;
    }
    return (
        <div className="mx-1 mb-2 flex items-center gap-2 rounded-[8px] border border-edge-strong bg-surface px-3 py-1.5 text-[12px] text-secondary">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
            <span className="flex-1 truncate">{divergenceText(decision.focus, decision.local)}</span>
            <button
                type="button"
                onClick={onRejoin}
                className="shrink-0 cursor-pointer font-medium text-accent-soft hover:text-accent-100"
            >
                Follow focus
            </button>
        </div>
    );
}
```

Colors are `@theme` tokens only — `bg-surface`, `border-edge-strong`, `text-accent-soft`, matching `FocusBanner` above it. The dot is muted rather than accent so an aligned-but-overridden surface reads quieter than a focused one.

- [x] **Step 2: Typecheck and commit**

```bash
task check:ts
git add frontend/app/view/agents/focusbanner.tsx
git commit -m "feat(focus): a diverged subject surface offers one click back to focus"
```

---

## Task 8: Radar honors the subject posture it actually has

Radar declares `project: "filter"` and implements `subject` — seeding once behind an `initialized` ref and never rejoining. Correct the declaration and finish the behavior.

**Files:**
- Modify: `frontend/app/view/agents/surfacecontext.ts:20`
- Modify: `frontend/app/view/agents/surfacecontext.test.ts:27` (the table assertion)
- Modify: `frontend/app/view/agents/radarsurface.tsx:114-153`

**Interfaces:**
- Consumes: `subjectDecision` (Task 6), `DivergenceBanner` (Task 7), `activeFocusAtom` (Task 3).
- Produces: nothing other tasks consume.

- [x] **Step 1: Correct the declaration**

In `surfacecontext.ts`, change the radar row:

```ts
    radar: { project: "subject", space: "unsupported" },
```

Update the expected object in `surfacecontext.test.ts:27` to match.

- [x] **Step 2: Run the contract test**

```bash
npx vitest run frontend/app/view/agents/surfacecontext.test.ts
```

Expected: PASS.

- [x] **Step 3: Add divergence and rejoin to the surface**

In `radarsurface.tsx`, after the existing `selectScope` definition (`:151`), add:

```tsx
const decision = subjectDecision(scope?.path ?? null, projectPathFor(filter, projects));
const rejoin = () => {
    const target = projectPathFor(filter, projects);
    if (target != null) {
        fireAndForget(() => initRadarScope({ path: target, name: filter }));
    }
};
```

Render `<DivergenceBanner decision={decision} onRejoin={rejoin} />` directly above the findings list.

`projectPathFor(filter, projects)` returns the registry path for the app-bar project name, or `null` for `"all"`. It is the same lookup `pickInitialScope` already performs — extract it from there rather than writing a second one.

**Keep the seed-once `initialized` ref.** It exists so a remount (Radar unmounts on every navigation away) does not re-derive and wipe an in-progress scan. The fix is not removing the guard, it is adding the divergence signal the guard's silence created.

- [x] **Step 4: Verify in the dev app**

```bash
tail -f /dev/null | task dev
```

Set the app bar to a project, open Radar, pick a different project in Radar's own selector, confirm the banner appears and "Follow focus" returns it. Then `TaskStop` the background job explicitly — the `tail -f` half does not exit on its own if `task dev` crashes.

- [x] **Step 5: Commit**

```bash
git add frontend/ && git commit -m "fix(radar): declare the posture it implements, and stop drifting silently"
```

---

## Task 9: Code honors project subject posture

**Files:**
- Modify: `frontend/app/view/code/codestore.ts` (seed selection), `frontend/app/view/code/codepathbar.tsx` (banner)

**Interfaces:**
- Consumes: `subjectDecision`, `DivergenceBanner`, `projectFilterAtom`, `codeProjectAtom`/`lastCodeProjectAtom` (`codestore.ts:83,88`).
- Produces: nothing other tasks consume.

- [x] **Step 1: Seed from focus when there is no persisted project**

Code's project restore currently reads `lastCodeProjectAtom` alone. Change the boot order to: persisted project → app-bar project → nothing. The persisted value keeps winning, which is the whole point of keeping it (Spec §4, Persisting).

- [x] **Step 2: Render the divergence banner in the path bar**

```tsx
const decision = subjectDecision(project?.name ?? null, filter === "all" ? null : filter);
```

Render `<DivergenceBanner decision={decision} onRejoin={() => selectProjectByName(filter)} />` in `codepathbar.tsx` above the path row.

Compare by **project name**, not path: `handoffProjectName` already establishes that a worktree's registry name is the identity Code matches agents by, and a worktree path differs from its repo path while naming the same project.

- [x] **Step 3: Typecheck, verify, commit**

```bash
task check:ts
git add frontend/ && git commit -m "feat(code): follow the cockpit project unless you picked one here"
```

---

## Task 10: Files honors project and focus subject posture

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx`

**Interfaces:**
- Consumes: `subjectDecision`, `DivergenceBanner`, `diffScopeAtom` (`diffscopeatom.ts:13`), `activeFocusAtom`, `projectFilterAtom`.
- Produces: nothing other tasks consume.

- [x] **Step 1: Seed the diff scope from focus**

When `diffScopeAtom` is null and focus names an agent or a run, open that entity's diff rather than an empty surface. Reuse `openDiff(model, scope, file?)` from `agentdiffnav.ts:34` and the existing `agentDiffScope` / `runDiffScope` builders — do not construct a `DiffScope` by hand.

- [x] **Step 2: Render divergence against the focused entity**

The comparable string is the diff origin's entity id (`originKey(o)` from `diffscope.ts:61`), compared against the focused ref's id. Render `<DivergenceBanner …>` above the changed-file list, rejoining by calling `openDiff` for the focused entity.

- [x] **Step 3: Typecheck, verify, commit**

```bash
task check:ts
git add frontend/ && git commit -m "feat(files): open the focused agent's diff instead of a stale one"
```

---

## Task 11: Agent, Vault and Jarvis honor project subject posture

Grouped because all three read a project name and none has a persisted local override — the wiring is the same three lines in each and they are not separately rejectable.

**Files:**
- Modify: `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/view/agents/vaultsurface.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`

**Interfaces:**
- Consumes: `subjectDecision`, `DivergenceBanner`, `projectFilterAtom`, and per surface: `vaultScopeAtom` (`vaultstore.ts:40`), the Brief's own scope, the focused agent's `projectOf(agent)`.
- Produces: nothing other tasks consume.

- [x] **Step 1: Wire each surface**

For each: compute `subjectDecision(localProjectName, filter === "all" ? null : filter)`, render `DivergenceBanner`, and rejoin by writing that surface's own scope to the focus project.

Agent's local target is `projectOf(focusedAgent)` — it has no scope atom of its own, so it can only ever be aligned or diverged, never seeded. That is correct: the Agent surface's target is whichever agent you selected, and focus must not silently switch which terminal you are looking at.

- [x] **Step 2: Typecheck, verify, commit**

```bash
task check:ts
git add frontend/ && git commit -m "feat(cockpit): Agent, Vault and Jarvis follow the cockpit project"
```

---

## Task 12: The switcher gains agents and runs

**Files:**
- Modify: `frontend/app/view/agents/focusswitcher.tsx`

**Interfaces:**
- Consumes: `enterFocusFor` (Task 3), `model.agentsAtom`, `projectOf` (`agentsviewmodel.ts:862`), `focusesAtom`.
- Produces: nothing other tasks consume.

- [x] **Step 1: Add the grouped sections**

Keep the existing "Focus on task" section and "Global (no focus)" row. Add two sections above it — **Agents** (live roster rows) and **Runs** (active runs) — each row calling:

```tsx
enterFocusFor(model, { ref: { kind: "agent", id: a.id }, label: a.name, project: projectOf(a) });
```

The bar trigger's label already reads `active.objective`; change it to `active.label` from `ActiveFocus`.

- [x] **Step 2: Typecheck and commit**

```bash
task check:ts
git add frontend/ && git commit -m "feat(focus): focus an agent or a run from the app bar, not just a task"
```

---

## Task 13: The `.` keybinding and row actions

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts`
- Modify: `docs/keyboard-shortcuts.md`

**Interfaces:**
- Consumes: `enterFocusFor` (Task 3), each surface's row cursor.
- Produces: binding ids `focus:set` and `focus:clear`.

- [x] **Step 1: Add the bindings**

`.` is free — the only punctuation bound in `bindings.ts` is `[`, `]` and `/`. The obvious mnemonic `f` is taken twice (Agent fullscreen at `:774`, the `g f` leader for Diff at `:105`).

```ts
{
    id: "focus:set",
    keys: ".",
    group: "Global",
    label: "Focus the selected row",
    when: navigate,
    run: () => focusSelectedRow(model),
},
```

`focusSelectedRow` reads the current surface's row cursor and calls `enterFocusFor`; it returns `false` when the surface has no focusable row, so the binding falls through rather than swallowing the key.

- [x] **Step 2: Mirror it in the docs**

`docs/keyboard-shortcuts.md` mirrors the bindings. Note while you are there: its surface table is already stale — it says `Ctrl`+`1`…`8` and names "Memory", while `bindings.ts:152` slices `SURFACE_ORDER` to **9**. Fix that row in the same commit.

- [x] **Step 3: Typecheck and commit**

```bash
task check:ts
git add frontend/ docs/ && git commit -m "feat(focus): bind . to focus the selected row"
```

---

## Task 14: CDP scenarios

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: the whole slice.
- Produces: scenarios `focus-reaims-surfaces`, `focus-divergence-rejoin`.

- [x] **Step 1: Add the scenarios**

- `focus-reaims-surfaces` — focus an agent, then assert Files and Code land on that agent's project.
- `focus-divergence-rejoin` — focus project A, set Code to project B by hand, assert the banner renders, click "Follow focus", assert Code returns to A.

Scope every DOM query to a `data-*` container. A document-wide `button` query picks the app bar's global search button, not your row. Pin the viewport to 1600x950 in any ad-hoc probe — `verify.mjs` clears the override on exit, and the real dev window is ~1000x700, where the Subjects column goes icon-only and by-name clicks find nothing.

- [x] **Step 2: Run them**

```bash
task verify:ui -- focus-reaims-surfaces focus-divergence-rejoin
```

Expected: both PASS. If `:9222` refuses the connection mid-run, check the dev log for "going away" — a concurrent session editing frontend files can crash `task dev`, and that reads as a CDP fault.

- [x] **Step 3: Run the whole check set and commit**

```bash
npx vitest run frontend/app/view/agents/
task check:ts
task verify:ui
git add scripts/ && git commit -m "test(focus): cover re-aiming and divergence rejoin under CDP"
```

---

## Task 15: Record the slice

**Files:**
- Modify: `docs/open-issues.md`, `docs/deferred.md`

- [x] **Step 1: Record the deferrals**

Copy the spec's "Deferred until evidence" entries into `docs/deferred.md` with their revive triggers: relationship annotation, companion split, time correlation, drag courier, Jarvis focus support, Usage focus and project support.

- [x] **Step 2: Close the stale rows in `docs/open-issues.md`**

The cross-surface navigation entry at `:302` names `SURFACE_CONTEXT` marking Jarvis's Space support unsupported "until it returns" — update it to say the table is now enforced and Jarvis's cell is a recorded deferral rather than a placeholder.

- [x] **Step 3: Commit with the spec**

Per the repo's rule, spec and plan docs fold into the feature commit they describe rather than landing as a docs-only commit. Amend the spec and this plan into Task 14's commit, or include them here if Task 14 is already pushed.

```bash
git add docs/ && git commit -m "docs(focus): record the slice's deferrals and close the stale contract rows"
```

---

## Self-Review

**Spec coverage.** §1 posture table → Tasks 8–11; §2 widening → Task 2; §3 subject obligations → Tasks 6, 7; §4 setting/showing/persisting/staleness → Tasks 3, 4, 5, 12, 13; Testing → Tasks 2, 3, 4, 5, 6, 14; Rollout slice 1 → all. §5 and §6 are Slice 2 and deliberately absent.

**Type consistency.** `enterFocus`/`enterFocusFor` (Task 3) are consumed by Tasks 12 and 13 under those
exact names. `SubjectDecision` and `divergenceText` (Task 6) are consumed by Tasks 7–11.
`persistedFocusAtom` (Task 4) is read at boot in Task 4 Step 4. `degradeFocus` (Task 4) has exactly one
caller, added in Task 5. `focusBannerText` survives the Task 1 rename and keeps its two filter-surface
callers. No name is defined without a consumer.

**Known gaps, stated rather than hidden:**

- Tasks 9, 10 and 11 give exact files, interfaces and the comparable string for each surface, but not literal code blocks — the surrounding render trees are large and citing line numbers for six surfaces would go stale the moment Task 8 edits one, which is the failure mode your own rule warns about. Each is a three-line wiring against interfaces Tasks 6 and 7 define exactly.
- `projectPathFor` (Task 8) is named as an extraction from `pickInitialScope` rather than written out; its body depends on `pickInitialScope`'s current shape, which the executor will have in front of them.
- The `focusesAtom` rename in Task 1 covers the task list only; Task 12 adds agents and runs to the switcher without renaming that atom again.

---

## Execution record (2026-09-22)

Executed on `worktree-cockpit-focus-s1` off `ef933a78`. Every step is ticked; the commits the plan
names were collapsed into **one commit at the end** at the user's instruction, and the dev-app / CDP
*run* steps (Task 8 Step 4, Task 14 Step 2) were **written but not executed** — also the user's call.
Unit tests and `tsc --noEmit` gated every task.

Deviations from the plan as written, and why:

1. **Task 2 Step 7 — three frontend callers, not one.** `ResolveSpaceScopeCommand` was also called by
   `jarvis/jarvissubjectstore.ts:146` and mocked in `jarvis/recordactions.test.ts:15`. All three moved
   to `ResolveFocusScopeCommand({kind:"task", id})`.
2. **Task 2 Step 6 needed a bootstrap patch.** `cmd/generatets` imports `pkg/wshrpc/wshclient`
   transitively, so `task generate` could not compile while the generated `wshclient.go` still named
   the old type. Fixed by sed-renaming the three symbols in `wshclient.go` first, then running
   `task generate`, which rewrote the file authoritatively.
3. **Task 3 touched three files the plan did not list.** Retyping `activeFocusAtom` from `SpaceSummary`
   to `ActiveFocus` breaks `cockpitsurface.tsx:449` and `sessionssurface.tsx:188` (both read
   `.objective`) and `command-palette.tsx:342` (`enterSpace(summary)`). Without them `check:ts` is red
   at Task 3, not Task 12.
4. **Task 8 compares by project NAME, not path.** The plan said
   `subjectDecision(scope?.path, projectPathFor(filter, projects))`; a path renders as
   `C:\...\waveterm` in the banner text the user reads. `radarstore.resolveScope` already does the
   registry lookup, so `projectPathFor` was not written — reuse over a second helper — and the compare
   is by name, consistent with Task 9's own stated reasoning.
5. **Task 9's banner lives in `codesurface.tsx`, not `codepathbar.tsx`.** `CodePathBar` early-returns
   when no file is open, so a banner there is invisible on exactly the freshly-switched project that
   diverged.
6. **Task 10 gates the two `diffsource.ts` fallbacks.** An explicit cockpit focus outranks the roster
   cursor's follow and the adopt-the-first-agent default; without the gate the async run seed (a WOS
   read) lands after the fallback has already claimed the scope. A `task` focus is deliberately not a
   Files subject: its bundle spans many entities, so there is no single diff to open.
7. **Task 11 wired Agent and Vault; Jarvis was skipped as a plan defect.** The plan named "the Brief's
   own scope", but `briefScopeAtom` holds a `JarvisScope { mode, chips, attached }` — a recall *query*
   scope, not a project name. The Brief has no local project target, so the banner could never render.
   Recorded in `docs/deferred.md` with a revive trigger rather than adding dead wiring.
8. **Task 12 derives runs from the live roster.** There is no global runs atom in the frontend
   (`activeChannelRunsAtom` is per-channel) and no list-runs RPC. An agent carries the run it works
   for, so distinct `runId`s across the roster are exactly the runs with a worker on screen.
9. **Task 13's `focus:clear` is bound to `Shift`+`.`** The plan named the id but not a key.
10. **Task 14 required new `data-*` hooks** before the scenarios could be scoped: `data-focus-switcher`,
    `data-focus-row`, `data-divergence-banner`, `data-divergence-rejoin`, `data-project-switcher`,
    `data-project-option`, and `data-code-picker-row` gained its label as a value.

Verification at the end of the run: `npx vitest run frontend/` — 249 files, 3241 tests, 0 failures.
`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — exit 0.
`go test ./pkg/wshrpc/wshserver/ -run "TestFocusScope|TestBuildSpaceScope"` — 5 pass.
`task verify:ui -- focus-reaims-surfaces focus-divergence-rejoin` was **not run**.
