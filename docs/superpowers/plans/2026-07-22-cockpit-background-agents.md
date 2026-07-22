# Cockpit Background Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface active background Claude Code agents (`claude --bg` / `claude agents`) in the cockpit as a dedicated "Background" section, so the cockpit isn't blind to agents that run with no Wave terminal block.

**Architecture:** A poll pipeline independent of the hook/wps roster. A Go helper shells out to `claude agents --json`, a guarded parser normalizes the two record shapes, a wshrpc command returns them, a frontend store polls every 10s, and a self-contained `BackgroundAgentsStrip` renders them — deduped against live hook-tracked agents by session id and scoped by the existing project switcher. Background agents are **not** merged into `agentsAtom`, so they never touch the block-keyed keyboard/cursor/answer machinery.

**Tech Stack:** Go (wavesrv, `os/exec`), wshrpc codegen (Go→TS), React 19 + jotai + Tailwind 4, vitest, Go `testing`.

## Global Constraints

- Claude Code v2.1.217 confirmed on the dev machine. The resume primitive is `claude --resume <sessionId>`; there is **no** `claude attach` subcommand.
- `claude agents --json` is undocumented and system-wide (all projects). Guard the parser: read only known fields, default missing ones, never assume a field exists, never fail the whole batch on one bad element.
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`). Edit Go, run `task generate`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Baseline is clean; any error it reports is yours.
- No new SCSS and no raw hex/rgba — Tailwind `@theme` tokens only.
- Windows: `cwd` values use backslashes; normalize separators before any path comparison.

## Refinements from the approved spec (confirm before executing)

The spec (`docs/superpowers/specs/2026-07-22-cockpit-background-agents-design.md`) was refined during code reading:

1. **Render model — user-confirmed.** Separate `BackgroundAgentsStrip` section, **not** merged into `agentsAtom` (mirrors the existing `liveTerminalsAtom` separation; keeps blockless agents out of the block-keyed machinery).
2. **Scoping.** Reuse the existing `projectFilterAtom` project switcher instead of a backend `--cwd` param. The backend lists all active sessions; the strip applies `matchesProjectFilter`. Consequence: at the default `"all"` scope the strip shows background agents for every project with active sessions (consistent with how foreground agents behave); selecting a project scopes them. If hard exclusion at `"all"` is wanted, that's a one-line follow-up.
3. **`needs-input` representation.** A `needsInput?: boolean` on `AgentVM` (drives a distinct badge) rather than a new `AgentState` enum member — avoids touching `STATE_RANK`/`sortAgents`/`groupAgents`/sections.
4. **Type placement.** `BackgroundAgentData` lives in `pkg/wshrpc` (it's an RPC return type, like `UsageBucket`), not `pkg/baseds` as the spec's file-list said.
5. **Reuse.** `launch.ts` already has `sessionIdFromTranscript()` (dedup) and the resume machinery — reused rather than re-implemented.

## File Structure

- Create `pkg/bgagents/bgagents.go` — pure parser + `claude agents --json` exec wrapper. One responsibility: turn the CLI into `[]Agent`.
- Create `pkg/bgagents/bgagents_test.go` — parser table tests.
- Modify `pkg/wshrpc/wshrpctypes_agents.go` — add command to the `AgentCommands` interface + payload/return + `BackgroundAgentData`.
- Modify `pkg/wshrpc/wshserver/wshserver_agents.go` — implement the command.
- Regenerate `frontend/app/store/wshclientapi.ts` + `frontend/types/gotypes.d.ts` via `task generate`.
- Create `frontend/app/view/agents/backgroundagentsstore.ts` — poll store atoms + loader + derived VM atom.
- Create `frontend/app/view/agents/backgroundagentspoller.tsx` — always-mounted 10s poller (null component).
- Modify `frontend/app/cockpit/cockpit-root.tsx` — mount the poller next to `NowTicker`.
- Modify `frontend/app/view/agents/agentsviewmodel.ts` — `AgentVM.kind` += `"background"`, add `needsInput?`/`cwd?`, add `backgroundAgentToVM` + `dedupBackgroundAgents` (pure).
- Create `frontend/app/view/agents/agentsviewmodel.test.ts` additions (or a new `backgroundagents.test.ts`) — pure-logic tests.
- Modify `frontend/app/cockpit/cockpit-actions.ts` — add `attachBackgroundAgent`.
- Create `frontend/app/view/agents/backgroundagentsstrip.tsx` — the section component.
- Modify `frontend/app/view/agents/cockpitsurface.tsx` — mount the strip above the grid.

---

### Task 1: Backend `bgagents` package (parser + exec)

**Files:**
- Create: `pkg/bgagents/bgagents.go`
- Test: `pkg/bgagents/bgagents_test.go`

**Interfaces:**
- Produces: `type Agent struct { SessionId, Cwd, Kind, Name, State string; StartedTs int64 }`; `func Parse(data []byte) ([]Agent, error)`; `func List(ctx context.Context) ([]Agent, error)`.

- [ ] **Step 1: Write the failing parser tests**

Create `pkg/bgagents/bgagents_test.go`:

```go
package bgagents

import "testing"

func TestParse_BothShapes(t *testing.T) {
	data := []byte(`[
		{"id":"7802f291","sessionId":"7802f291-33c2-4c24-94d7-b7a029a3a526","cwd":"C:\\a","kind":"background","startedAt":1782441963164,"name":"bg one","state":"blocked"},
		{"pid":28732,"sessionId":"c32f3bda-8ea6-47e1-a2fc-3f38ce03f18a","cwd":"C:\\a","kind":"interactive","startedAt":1784691487376,"name":"int one","status":"busy"}
	]`)
	got, err := Parse(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 agents, got %d", len(got))
	}
	if got[0].State != "blocked" || got[0].Kind != "background" || got[0].SessionId != "7802f291-33c2-4c24-94d7-b7a029a3a526" {
		t.Errorf("background mapping wrong: %+v", got[0])
	}
	// interactive uses `status`, which must populate State
	if got[1].State != "busy" || got[1].Kind != "interactive" {
		t.Errorf("interactive status->state wrong: %+v", got[1])
	}
	if got[0].StartedTs != 1782441963164 {
		t.Errorf("startedAt->StartedTs wrong: %d", got[0].StartedTs)
	}
}

func TestParse_SkipsEntryMissingSessionId(t *testing.T) {
	data := []byte(`[{"name":"no id","state":"blocked"},{"sessionId":"abc","kind":"background","state":"working"}]`)
	got, err := Parse(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].SessionId != "abc" {
		t.Fatalf("want only the valid entry, got %+v", got)
	}
}

func TestParse_EmptyArray(t *testing.T) {
	got, err := Parse([]byte(`[]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty, got %d", len(got))
	}
}

func TestParse_NonJSON(t *testing.T) {
	if _, err := Parse([]byte(`not json`)); err == nil {
		t.Fatal("want error on non-JSON, got nil")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/bgagents/`
Expected: FAIL — `undefined: Parse` / package has no Go files.

- [ ] **Step 3: Implement the package**

Create `pkg/bgagents/bgagents.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package bgagents lists Claude Code background/interactive agents by shelling out to
// `claude agents --json`. The listing schema is undocumented and system-wide, so Parse is
// deliberately tolerant: it reads known fields, defaults the rest, and skips (never fails on)
// a malformed element.
package bgagents

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"
)

const listTimeout = 5 * time.Second

// Agent is one normalized entry. State is `state` (background) or `status` (interactive).
type Agent struct {
	SessionId string
	Cwd       string
	Kind      string // "background" | "interactive"
	Name      string
	State     string
	StartedTs int64 // epoch ms
}

// rawAgent carries every field either record shape can emit; missing fields unmarshal to zero.
type rawAgent struct {
	SessionId string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	State     string `json:"state"`  // background
	Status    string `json:"status"` // interactive
	StartedAt int64  `json:"startedAt"`
}

// Parse normalizes the `claude agents --json` array. Elements with no sessionId are skipped.
func Parse(data []byte) ([]Agent, error) {
	var raws []rawAgent
	if err := json.Unmarshal(data, &raws); err != nil {
		return nil, fmt.Errorf("parsing claude agents json: %w", err)
	}
	out := make([]Agent, 0, len(raws))
	for _, r := range raws {
		if r.SessionId == "" {
			continue
		}
		state := r.State
		if state == "" {
			state = r.Status
		}
		out = append(out, Agent{
			SessionId: r.SessionId,
			Cwd:       r.Cwd,
			Kind:      r.Kind,
			Name:      r.Name,
			State:     state,
			StartedTs: r.StartedAt,
		})
	}
	return out, nil
}

// List runs `claude agents --json`. A missing `claude` binary yields (nil, nil): the machine
// simply has no background-agent support, which must not spam errors on every 10s poll.
func List(ctx context.Context) ([]Agent, error) {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return nil, nil
	}
	cctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, "agents", "--json").Output()
	if err != nil {
		return nil, fmt.Errorf("running claude agents --json: %w", err)
	}
	return Parse(out)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/bgagents/`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/bgagents/
git commit -m "feat(bgagents): parse + list claude background agents"
```

---

### Task 2: wshrpc command `GetBackgroundAgentsCommand`

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_agents.go:8-21` (interface) and end of file (types)
- Modify: `pkg/wshrpc/wshserver/wshserver_agents.go`
- Regenerate: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `bgagents.List` (Task 1).
- Produces: `RpcApi.GetBackgroundAgentsCommand(client, {})` → `{ agents: BackgroundAgentData[] }`; TS type `BackgroundAgentData { sessionid, cwd, kind, name, state, startedts }`.

- [ ] **Step 1: Add the command to the interface + payload/return types**

In `pkg/wshrpc/wshrpctypes_agents.go`, add to the `AgentCommands` interface (after line 19, `GetCacheStatusCommand`):

```go
	GetBackgroundAgentsCommand(ctx context.Context, data CommandGetBackgroundAgentsData) (*CommandGetBackgroundAgentsRtnData, error)
```

At the end of the file, add:

```go
type CommandGetBackgroundAgentsData struct{}

type CommandGetBackgroundAgentsRtnData struct {
	Agents []BackgroundAgentData `json:"agents"`
}

// BackgroundAgentData is one entry from `claude agents --json`, normalized. No PR/model/token
// fields — the listing carries none.
type BackgroundAgentData struct {
	SessionId string `json:"sessionid"`
	Cwd       string `json:"cwd"`
	Kind      string `json:"kind"` // "background" | "interactive"
	Name      string `json:"name"`
	State     string `json:"state"`
	StartedTs int64  `json:"startedts"` // epoch ms
}
```

- [ ] **Step 2: Implement the command**

In `pkg/wshrpc/wshserver/wshserver_agents.go`, add the `bgagents` import to the import block:

```go
	"github.com/wavetermdev/waveterm/pkg/bgagents"
```

Add the method (after `GetCacheStatusCommand`, near line 152):

```go
func (ws *WshServer) GetBackgroundAgentsCommand(ctx context.Context, data wshrpc.CommandGetBackgroundAgentsData) (*wshrpc.CommandGetBackgroundAgentsRtnData, error) {
	agents, err := bgagents.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing background agents: %w", err)
	}
	out := make([]wshrpc.BackgroundAgentData, len(agents))
	for i, a := range agents {
		out[i] = wshrpc.BackgroundAgentData{
			SessionId: a.SessionId, Cwd: a.Cwd, Kind: a.Kind,
			Name: a.Name, State: a.State, StartedTs: a.StartedTs,
		}
	}
	return &wshrpc.CommandGetBackgroundAgentsRtnData{Agents: out}, nil
}
```

- [ ] **Step 3: Verify the backend compiles**

Run: `go build ./pkg/...`
Expected: exit 0.

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: exit 0; `frontend/app/store/wshclientapi.ts` gains `GetBackgroundAgentsCommand` and `frontend/types/gotypes.d.ts` gains `BackgroundAgentData` + the command data/rtn types.

- [ ] **Step 5: Typecheck the frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline).

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_agents.go pkg/wshrpc/wshserver/wshserver_agents.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(wshrpc): GetBackgroundAgentsCommand"
```

---

### Task 3: Frontend poll store + always-mounted poller

**Files:**
- Create: `frontend/app/view/agents/backgroundagentsstore.ts`
- Create: `frontend/app/view/agents/backgroundagentspoller.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx:16,86`

**Interfaces:**
- Consumes: `RpcApi.GetBackgroundAgentsCommand`, `BackgroundAgentData` (Task 2).
- Produces: `backgroundAgentsAtom: PrimitiveAtom<BackgroundAgentData[]>`, `backgroundAgentsErrorAtom`, `loadBackgroundAgents()`, `<BackgroundAgentsPoller/>`.

- [ ] **Step 1: Create the store**

Create `frontend/app/view/agents/backgroundagentsstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Background-agents poll store. `claude agents --json` has no event stream, so this polls. On RPC
// failure the last-good list is kept (a transient websocket drop must not blank the section) and
// backgroundAgentsErrorAtom is set. loadSeq drops out-of-order responses (usagestore pattern).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export const backgroundAgentsAtom = atom<BackgroundAgentData[]>([]) as PrimitiveAtom<BackgroundAgentData[]>;
export const backgroundAgentsErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

let loadSeq = 0;

export async function loadBackgroundAgents(): Promise<void> {
    const seq = ++loadSeq;
    try {
        const rtn = await RpcApi.GetBackgroundAgentsCommand(TabRpcClient, {});
        if (seq !== loadSeq) {
            return;
        }
        globalStore.set(backgroundAgentsAtom, rtn.agents ?? []);
        globalStore.set(backgroundAgentsErrorAtom, false);
    } catch {
        if (seq !== loadSeq) {
            return;
        }
        globalStore.set(backgroundAgentsErrorAtom, true);
    }
}
```

- [ ] **Step 2: Create the poller**

Create `frontend/app/view/agents/backgroundagentspoller.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Always-mounted (cockpit root) 10s poll driver for the background-agents section, mirroring
// NowTicker. Renders nothing. 10s (vs usage's 60s) so a `blocked`/needs-input background agent
// surfaces quickly; each tick is one `claude agents --json` shell-out.

import { useEffect } from "react";
import { loadBackgroundAgents } from "./backgroundagentsstore";

export function BackgroundAgentsPoller() {
    useEffect(() => {
        void loadBackgroundAgents();
        const t = setInterval(() => void loadBackgroundAgents(), 10_000);
        return () => clearInterval(t);
    }, []);
    return null;
}
```

- [ ] **Step 3: Mount the poller in cockpit root**

In `frontend/app/cockpit/cockpit-root.tsx`, add the import after line 16 (`NowTicker` import):

```tsx
import { BackgroundAgentsPoller } from "@/app/view/agents/backgroundagentspoller";
```

And render it next to `<NowTicker>` (line 86):

```tsx
            <NowTicker model={model} />
            <BackgroundAgentsPoller />
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/backgroundagentsstore.ts frontend/app/view/agents/backgroundagentspoller.tsx frontend/app/cockpit/cockpit-root.tsx
git commit -m "feat(cockpit): poll claude background agents"
```

---

### Task 4: Pure VM mapping + dedup

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:6,73-91` and add functions near line 916
- Test: `frontend/app/view/agents/backgroundagents.test.ts`

**Interfaces:**
- Consumes: `BackgroundAgentData` (Task 2), `sessionIdFromTranscript` from `./launch` (existing).
- Produces: `AgentVM.kind` includes `"background"`; `AgentVM.needsInput?: boolean`; `AgentVM.cwd?: string`; `backgroundAgentToVM(bg, projectName, now): AgentVM`; `dedupBackgroundAgents(background, liveAgents): AgentVM[]`.

- [ ] **Step 1: Extend the AgentVM type**

In `frontend/app/view/agents/agentsviewmodel.ts`, change line 90 and add two fields:

```ts
    kind?: "agent" | "terminal" | "background"; // undefined = agent (roster); "terminal" = plain shell; "background" = detached claude agent
    needsInput?: boolean; // background agent parked on input (claude state "blocked") — drives the needs-input badge
    cwd?: string; // background agent working dir — the resume target for Attach
```

- [ ] **Step 2: Write the failing pure-logic tests**

Create `frontend/app/view/agents/backgroundagents.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backgroundAgentToVM, dedupBackgroundAgents, type AgentVM } from "./agentsviewmodel";

const NOW = 1_000_000;

function bg(sessionid: string, state: string, startedts = NOW - 60_000): BackgroundAgentData {
    return { sessionid, cwd: "C:\\proj", kind: "background", name: "task", state, startedts };
}

describe("backgroundAgentToVM", () => {
    it("maps blocked -> working + needsInput", () => {
        const vm = backgroundAgentToVM(bg("s1", "blocked"), "proj", NOW);
        expect(vm.kind).toBe("background");
        expect(vm.state).toBe("working");
        expect(vm.needsInput).toBe(true);
        expect(vm.id).toBe("s1");
        expect(vm.cwd).toBe("C:\\proj");
        expect(vm.project).toBe("proj");
        expect(vm.activeMs).toBe(60_000);
    });
    it("maps idle -> idle, not needsInput", () => {
        const vm = backgroundAgentToVM(bg("s2", "idle"), "proj", NOW);
        expect(vm.state).toBe("idle");
        expect(vm.needsInput).toBeFalsy();
    });
    it("maps busy/working -> working", () => {
        expect(backgroundAgentToVM(bg("s3", "busy"), "p", NOW).state).toBe("working");
        expect(backgroundAgentToVM(bg("s4", "working"), "p", NOW).state).toBe("working");
    });
});

describe("dedupBackgroundAgents", () => {
    it("drops a background agent already tracked live (by transcript session id)", () => {
        const live: AgentVM[] = [
            { id: "tab1", name: "live", task: "", state: "working", transcriptPath: "/x/projects/p/s1.jsonl" },
        ];
        const background = [
            backgroundAgentToVM(bg("s1", "blocked"), "p", NOW), // dup of live
            backgroundAgentToVM(bg("s2", "working"), "p", NOW), // keep
        ];
        const out = dedupBackgroundAgents(background, live);
        expect(out.map((a) => a.id)).toEqual(["s2"]);
    });
    it("keeps all when nothing matches", () => {
        const live: AgentVM[] = [{ id: "t", name: "l", task: "", state: "idle", transcriptPath: "/x/p/other.jsonl" }];
        const background = [backgroundAgentToVM(bg("s9", "idle"), "p", NOW)];
        expect(dedupBackgroundAgents(background, live)).toHaveLength(1);
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/backgroundagents.test.ts`
Expected: FAIL — `backgroundAgentToVM`/`dedupBackgroundAgents` are not exported.

- [ ] **Step 4: Implement the pure functions**

In `frontend/app/view/agents/agentsviewmodel.ts`, add the import at the top (after the existing `./projectname` import):

```ts
import { sessionIdFromTranscript } from "./launch";
```

Add near the pending-launch helpers (around line 916):

```ts
/** Pure: one `claude agents --json` entry -> an AgentVM in the background lane. `blocked` (parked on
 *  input) maps to working + needsInput so it reads as live and flags for attention; `idle` stays idle;
 *  everything else is working. id IS the sessionId (the resume target); no transcriptPath/blockId
 *  exists for a detached agent, so it never enters the transcript-stream or block-input paths. */
export function backgroundAgentToVM(bg: BackgroundAgentData, projectName: string, now: number): AgentVM {
    const state: AgentState = bg.state === "idle" ? "idle" : "working";
    return {
        id: bg.sessionid,
        name: bg.name || "background agent",
        task: "",
        state,
        kind: "background",
        agent: "claude",
        project: projectName,
        cwd: bg.cwd,
        needsInput: bg.state === "blocked",
        activeMs: bg.startedts ? Math.max(0, now - bg.startedts) : undefined,
    };
}

/** Pure: drop background agents that are already tracked as live hook-fed agents. A live agent's
 *  session id is the stem of its transcript filename (sessionIdFromTranscript); a background agent's
 *  id IS its session id. Same id => same session => show it once (the live, richer one wins). */
export function dedupBackgroundAgents(background: AgentVM[], liveAgents: AgentVM[]): AgentVM[] {
    const liveSessionIds = new Set(
        liveAgents.map((a) => sessionIdFromTranscript(a.transcriptPath)).filter(Boolean)
    );
    return background.filter((b) => !liveSessionIds.has(b.id));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/backgroundagents.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/backgroundagents.test.ts
git commit -m "feat(agents): pure background-agent VM mapping + dedup"
```

---

### Task 5: Derived VM atom + Attach action

**Files:**
- Modify: `frontend/app/view/agents/backgroundagentsstore.ts` (add derived atom)
- Modify: `frontend/app/cockpit/cockpit-actions.ts` (add `attachBackgroundAgent`)

**Interfaces:**
- Consumes: `backgroundAgentsAtom` (Task 3), `backgroundAgentToVM` (Task 4), `projectLabel` from `./projectlabel`, `atoms.fullConfigAtom`, `launchAgent` (existing).
- Produces: `backgroundAgentVMsAtom: Atom<AgentVM[]>`; `attachBackgroundAgent(model, vm): Promise<void>`.

- [ ] **Step 1: Add the derived VM atom**

In `frontend/app/view/agents/backgroundagentsstore.ts`, add imports:

```ts
import { atoms } from "@/app/store/global-atoms";
import { backgroundAgentToVM, type AgentVM } from "./agentsviewmodel";
import { projectLabel } from "./projectlabel";
import { type Atom } from "jotai";
```

Add the derived atom at the end:

```ts
// Background entries -> AgentVMs. Only kind:"background" enters the lane (interactive sessions are
// Wave terminals or foreign shells, owned by the hook roster). Project name is resolved with the same
// projectLabel the rest of the cockpit uses, so the existing project switcher scopes these too.
export const backgroundAgentVMsAtom: Atom<AgentVM[]> = atom((get) => {
    const raw = get(backgroundAgentsAtom).filter((a) => a.kind === "background");
    const config = get(atoms.fullConfigAtom);
    const now = Date.now();
    return raw.map((a) => backgroundAgentToVM(a, projectLabel(a.cwd, config?.projects ?? {}), now));
});
```

- [ ] **Step 2: Add the Attach action**

In `frontend/app/cockpit/cockpit-actions.ts`, add after `launchAgent` (line 111):

```ts
// Attach = resume a detached background agent inside a fresh Wave terminal block. `claude --resume
// <sessionId>` is the primitive (there is no `claude attach`); task is empty so resume reattaches
// without replaying a prompt. Once it boots, the hook reporter registers it and the session-id dedup
// collapses the background-lane entry into the now-live agent.
export async function attachBackgroundAgent(
    model: AgentsViewModel,
    bg: { sessionId: string; cwd: string; project: string }
): Promise<void> {
    await launchAgent(model, {
        runtime: "claude",
        startupCommand: `claude --resume ${bg.sessionId}`,
        task: "",
        projectPath: bg.cwd,
        projectName: bg.project || "background",
    });
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/backgroundagentsstore.ts frontend/app/cockpit/cockpit-actions.ts
git commit -m "feat(cockpit): background-agent VM atom + attach action"
```

---

### Task 6: `BackgroundAgentsStrip` section + mount

**Files:**
- Create: `frontend/app/view/agents/backgroundagentsstrip.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (mount above the grid)

**Interfaces:**
- Consumes: `backgroundAgentVMsAtom` (Task 5), `dedupBackgroundAgents` + `matchesProjectFilter` + `formatAge` (Task 4 / existing), `attachBackgroundAgent` (Task 5), `model.agentsAtom` / `model.projectFilterAtom` / `model.nowAtom`.

- [ ] **Step 1: Create the strip component**

Create `frontend/app/view/agents/backgroundagentsstrip.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Background section: detached `claude --bg` / `claude agents` sessions the hook roster can't see
// (they have no Wave block). Deduped against live agents by session id and scoped by the same project
// switcher as the roster. Background agents are view + attach only — no transcript/answer/open (there's
// no block to drive); Attach resumes one into a fresh Wave terminal, after which it becomes a normal
// hook-tracked agent.

import { globalStore } from "@/app/store/jotaiStore";
import { attachBackgroundAgent } from "@/app/cockpit/cockpit-actions";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { dedupBackgroundAgents, formatAge, matchesProjectFilter, type AgentVM } from "./agentsviewmodel";
import { backgroundAgentVMsAtom } from "./backgroundagentsstore";

export function BackgroundAgentsStrip({ model }: { model: AgentsViewModel }) {
    const backgroundVMs = useAtomValue(backgroundAgentVMsAtom);
    const live = useAtomValue(model.agentsAtom);
    const projectFilter = useAtomValue(model.projectFilterAtom);
    const now = useAtomValue(model.nowAtom);

    const shown = dedupBackgroundAgents(backgroundVMs, live).filter((a) => matchesProjectFilter(a, projectFilter));
    if (shown.length === 0) {
        return null;
    }

    const attach = (a: AgentVM) =>
        fireAndForget(() => attachBackgroundAgent(model, { sessionId: a.id, cwd: a.cwd ?? "", project: a.project ?? "" }));

    return (
        <div className="shrink-0 border-b border-edge-mid px-4 py-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-mid">
                Background · {shown.length}
            </div>
            <div className="flex flex-col gap-1">
                {shown.map((a) => (
                    <div
                        key={a.id}
                        className="flex items-center gap-2 rounded-[9px] border border-edge-mid bg-lane px-3 py-1.5"
                    >
                        <span className={a.needsInput ? "text-warning" : "text-ink-mid"}>●</span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{a.name}</span>
                        {a.project ? <span className="shrink-0 text-[11px] text-ink-mid">{a.project}</span> : null}
                        {a.needsInput ? (
                            <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
                                needs input
                            </span>
                        ) : null}
                        <span className="shrink-0 text-[11px] text-ink-mid">{formatAge(a.activeMs)}</span>
                        <button
                            onClick={() => attach(a)}
                            className="shrink-0 rounded-[7px] border border-border px-[11px] py-[3px] text-[11px] font-semibold text-ink-mid hover:text-foreground"
                        >
                            Attach
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Mount the strip above the grid in cockpitsurface**

In `frontend/app/view/agents/cockpitsurface.tsx`, add the import with the other `./` imports near the top:

```tsx
import { BackgroundAgentsStrip } from "./backgroundagentsstrip";
```

In the component's returned JSX, render `<BackgroundAgentsStrip model={model} />` as the first child of the cockpit content column, immediately **before** the scrollable grid container (the element that hosts the absolute-positioned cards via `renderCard`). It is a self-contained `shrink-0` block, so it sits above the grid without touching the spring-grid layout math.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Verify in the live dev app (CDP surface-smoke)**

There is no jsdom render harness for the cockpit (per repo convention). Verify against the running dev app:

1. Ensure `task dev` is running (use `tail -f /dev/null | task dev` headless; TaskStop it when done).
2. Confirm background sessions exist: `claude agents --json` should list `kind:"background"` entries under the current project (start one with `claude --bg` in the project dir if none).
3. Capture the cockpit: `node scripts/cdp-shot.mjs cdp-shots/bg-agents.png`.
4. Confirm the "Background · N" section renders above the grid, a `needs input` badge shows for any `blocked` agent, and clicking Attach opens a new terminal running `claude --resume <sessionId>` (the agent then also appears in the normal roster and drops from the Background strip on the next poll).

Expected: section renders; counts match `claude agents --json`; Attach resumes the session.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/backgroundagentsstrip.tsx frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(cockpit): background agents section + attach"
```

---

## Self-Review

**Spec coverage:**
- Backend poll of `claude agents --json` → Task 1 (`bgagents.List`) + Task 2 (command).
- Guarded parser (both shapes, missing fields, non-JSON, empty) → Task 1 (`Parse` + tests).
- Frontend poll store (loadSeq, keep-last-good) → Task 3.
- Dedup by sessionId via transcript path → Task 4 (`dedupBackgroundAgents`, reuses `sessionIdFromTranscript`).
- `needs-input` distinct badge → Task 4 (`needsInput`) + Task 6 (badge). *(Refinement: boolean, not a new AgentState member.)*
- Attach via `claude --resume <sessionId>` → Task 5 + Task 6.
- Current-project scope → reused `projectFilterAtom` + `matchesProjectFilter` in Task 6. *(Refinement: switcher, not backend `--cwd`.)*
- `claude` missing / non-JSON / timeout degradation → Task 1 (`List` returns `(nil,nil)` on missing binary) + Task 3 (keep-last-good on RPC error).
- Windows path handling → `Parse` treats `cwd` as opaque; `sessionIdFromTranscript` already splits on `[/\\]`.
- Tests: Go parser (Task 1), FE pure mapping/dedup (Task 4), CDP smoke (Task 6). Matches the no-jsdom-render convention.
- Scope-out honored: no PR link, no token/model, no `--all`, no system-wide toggle.

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. The one prose instruction (Task 6 Step 2 mount point) references a concrete anchor (before the `renderCard` grid container) rather than a line number, because the strip is layout-independent — acceptable, and CDP smoke verifies placement.

**Type consistency:** `Agent`/`Parse`/`List` (Task 1) ↔ `BackgroundAgentData`/`GetBackgroundAgentsCommand` (Task 2) ↔ `backgroundAgentsAtom`/`loadBackgroundAgents` (Task 3) ↔ `backgroundAgentToVM`/`dedupBackgroundAgents`/`AgentVM.{kind,needsInput,cwd}` (Task 4) ↔ `backgroundAgentVMsAtom`/`attachBackgroundAgent` (Task 5) ↔ `BackgroundAgentsStrip` (Task 6). Names checked consistent across tasks.
