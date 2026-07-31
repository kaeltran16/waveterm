# Phase 2 — Real Status + Real Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 1's two shims with real backends — (A) a live per-session **status + activity detail line** driven by a new `wsh agentstatus` subcommand and an `Event_AgentStatus` broker event, and (B) real **service grouping** via a new `GetSessionGroup(cwd)` marker-walk-up RPC — wired into the existing `SessionSidebar`.

**Architecture:** Two independent subsystems sharing one consumer (the sidebar).
- **Part A (status):** reporter → `wsh agentstatus --state/--detail/--agent` → `wps.Broker.Publish(Event_AgentStatus)` scoped to the agent's terminal block ORef → frontend `waveEventSubscribeSingle` → per-block status atom → sidebar row dot + secondary detail line. Agent status takes precedence over the Phase 0 badge; the badge path stays as a fallback.
- **Part B (grouping):** `GetSessionGroupCommand(cwd) → {root, label}` walks up to the nearest marker file (pom.xml first), with git-root → raw-cwd fallbacks and a version-dir label heuristic, cached per cwd. The frontend resolves labels asynchronously into a cache atom and feeds them to the (still pure, still synchronous) view-model builder via a new `serviceLabel` field on `SessionInput`.

**Tech Stack:** Go backend (`wshrpc`, `wps`, `wsh` cobra subcommands, `tsgen` codegen), React + TypeScript, Jotai atoms, Tailwind v4 + `cn()`, Font Awesome via `makeIconClass`, vitest (`renderToStaticMarkup`) for the frontend, `go test` (table-driven, `t.TempDir()`) for the walk-up.

**Conventions for this plan:**
- **No `git commit` steps.** Per the repo owner's strict no-auto-commit rule, each task ends with a **Checkpoint** (tests + typecheck/VSCode-clean). Commits are batched and made only with explicit approval. (This deliberately overrides the writing-plans skill's per-task commit steps — user instructions win.)
- TDD where it pays: write the failing test, run it red, implement minimally, run it green. Pure functions (view-model, walk-up/label) are unit-tested; cobra subcommands and Jotai wiring are verified live (matching how Wave verifies `VTabBar`/`wsh badge`, which have no unit tests).
- Keep changes **additive** (new files) per spec §10 fork hygiene. Edits to existing files are limited to: `wshrpctypes.go`, `wpstypes.go`, `tsgenevent.go`, `wshserver.go` (registrations/impl), and the three Phase 1 sidebar files.
- **Go rules:** string constants not custom enum types; `lock.Lock(); defer lock.Unlock()` in helper methods; `Make*` (not `New*`) for constructors; consts at top of file; `Printf` not `Println`. Do NOT run `go build` — VSCode problems indicate compile errors. DO run `go test` for the TDD steps (from the project root).
- **Codegen:** never hand-edit `frontend/types/gotypes.d.ts` or `frontend/app/store/wshclientapi.ts`. After editing Go types/interfaces, run `task generate`.

**Prerequisites:**
- **Phase 1 is committed** (a separate agent owns that commit). Execute this plan on top of that committed base; do not touch the `emain/*` or `package-lock.json` working-tree state — those are intentional dev changes owned elsewhere.
- Phase 0 reporter exists in the user's environment (external to the repo — confirmed not committed). Part A Task A6 specifies how to repoint it; it is a documented manual step, not repo code.
- The setting `app:tabbar` is `"left"` so the sidebar mounts (see Phase 1 plan Task 8 for the dev-run recipe).

**Deferred to Phase 3 (explicitly NOT here):** persisted collapse state, keyboard quick-switch/cycle, long-name hover tooltips, typed `MetaType` keys for `session:pinned`/`session:agent`, live-ticking idle duration ("12m" recomputed by a 1/min frontend tick — Phase 2 renders the detail string exactly as the reporter sent it), committing a unit-tested reporter script into the fork.

---

## File Structure

| File | Part | Responsibility |
|---|---|---|
| `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` | A0 | **NEW.** Moved out of `sessionsidebar.tsx`: the derived `sessionSidebarViewModelAtom` + `togglePin`. Restores React Fast Refresh (handoff finding #3) so the component file hot-reloads during Phase 2 work. |
| `pkg/baseds/*` (the file defining `BadgeEvent`) | A1 | **MODIFY.** Add `AgentStatusData` struct + `AgentState_*` string constants, mirroring `BadgeEvent`. |
| `pkg/wps/wpstypes.go` | A1 | **MODIFY.** Add `Event_AgentStatus` constant (+ `// type:` comment) and append to `AllEvents`. |
| `pkg/tsgen/tsgenevent.go` | A1 | **MODIFY.** Add `Event_AgentStatus → reflect.TypeOf(baseds.AgentStatusData{})` to `WaveEventDataTypes` (this also generates the TS type — no `ExtraTypes` edit needed). |
| `cmd/wsh/cmd/wshcmd-agentstatus.go` | A2 | **NEW.** `wsh agentstatus --state --detail --agent` cobra subcommand, modeled on `wshcmd-badge.go`; publishes `Event_AgentStatus` scoped to the resolved block ORef. |
| `docs/docs/wsh-reference.mdx` | A2 | **MODIFY.** Add `agentstatus` reference entry (alphabetical). |
| `frontend/app/tab/sessionsidebar/agentstatusstore.ts` | A3 | **NEW.** Per-ORef `getAgentStatusAtom` map + `setupAgentStatusSubscription()` (mirrors `badge.ts`). |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` | A4/B4 | **MODIFY.** Add `detail` (A4) and `serviceLabel` (B4) to `SessionInput`/`SessionRowVM`; group by `serviceLabel`; keep `cwdToServiceLabel` as the fallback. |
| `frontend/app/tab/sessionsidebar/sessionrow.tsx` | A5 | **MODIFY.** Render the secondary detail line under the primary label. |
| `pkg/wshrpc/wshrpctypes.go` | B1/B2 | **MODIFY.** Add `CommandGetSessionGroupData`/`CommandGetSessionGroupRtnData` (B1) and the `GetSessionGroupCommand` interface method (B2). |
| `pkg/wshrpc/wshserver/sessiongroup.go` | B1 | **NEW.** Markers, walk-up, git-root + raw-cwd fallback, version-dir label heuristic, per-cwd cache. |
| `pkg/wshrpc/wshserver/sessiongroup_test.go` | B1 | **NEW.** Table-driven `t.TempDir()` tests incl. the `version-1.1` case. |
| `pkg/wshrpc/wshserver/wshserver.go` | B2 | **MODIFY.** Implement `GetSessionGroupCommand`. |
| `frontend/app/tab/sessionsidebar/sessiongroupstore.ts` | B3 | **NEW.** `sessionGroupLabelAtom` (cwd→label cache) + `ensureSessionGroupLabels(cwds)` (fires the RPC for uncached cwds). |
| `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` | A3/A4/B5 | **MODIFY.** Import the atom from the new model module; thread status+detail and resolved `serviceLabel` into `SessionInput`; `useEffect` to start the status subscription and resolve group labels. |

**Verified API facts this plan relies on (source-inspected 2026-06-15):**
- `wshcmd-badge.go` is the subcommand template: `&cobra.Command{Use, Short, Args, RunE, PreRunE: preRunSetupRpcClient}`, flags + `rootCmd.AddCommand` in `init()`, `RunE` opens with `defer func() { sendActivity("<name>", rtnErr == nil) }()`, resolves the target via `resolveBlockArg()` (reads `--block` / `WAVETERM_BLOCKID`), builds a `wps.WaveEvent{Event, Scopes: []string{oref.String()}, Data}`, and publishes via `wshclient.EventPublishCommand(RpcClient, event, &wshrpc.RpcOpts{NoResponse: true})` (`cmd/wsh/cmd/wshcmd-badge.go:20-128`).
- Event registration is a 3-edit checklist enforced by the comment at `pkg/wps/wpstypes.go:10-16`: (1) constant + `// type:` comment in the `const (…)` block (ends `wpstypes.go:36`), (2) append to `AllEvents` (ends `wpstypes.go:59`), (3) `WaveEventDataTypes` entry in `pkg/tsgen/tsgenevent.go:24-44`. `GenerateWaveEventTypes` (`tsgenevent.go:61`) calls `GenerateTSType` for every `WaveEventDataTypes` value, so an event-only payload type is generated without touching `ExtraTypes`.
- `WaveEvent` = `{Event string; Scopes []string; Sender string; Persist int; Data any}` (`wpstypes.go:61-67`). `Persist:1` retains the latest event per scope so a late subscriber gets the current status.
- `EventPublishCommand` exists end-to-end: interface `wshrpctypes.go`, client stub `wshclient.go`, server handler `wshserver.go` → `wps.Broker.Publish(data)`.
- Frontend subscription: `waveEventSubscribeSingle({eventType, scope?, handler})` from `@/app/store/wps` returns an unsubscribe fn; no `scope` = all scopes. `badge.ts` subscribes all-scopes and dispatches by `event.data.oref`; `wos.ts` subscribes per-`oref`. `globalStore` is from `@/app/store/jotaiStore`.
- RPC template: `GetVarCommand(ctx, CommandVarData) (*CommandVarResponseData, error)` (struct-in/struct-out) in `wshrpctypes.go`, implemented in `wshserver.go`; generated command string = lowercased method name minus `Command` (so `GetSessionGroupCommand` → `"getsessiongroup"`). Call from FE via `RpcApi.GetSessionGroupCommand(TabRpcClient, data)`.
- Go walk-up primitives: `os.Stat` for existence; `filepath.Dir(d) == d` is the filesystem-root sentinel (used at `pkg/suggestion/filewalk.go:173`). No reusable marker-walk-up or git-root finder exists — both net-new. Cache pattern modeled on `procCache` (`pkg/wshrpc/wshremote/processviewer.go`): package-level `var sgCache = &sessionGroupCache{m: make(...)}` with mutex + `get`/`set` helpers using `defer`.
- **Async gotcha:** `sessionSidebarViewModelAtom` is a synchronous Jotai derived atom — it cannot `await`. Part B resolves labels into a separate `PrimitiveAtom<Map<string,string>>` cache (filled by a `useEffect`-driven RPC) and the derived atom reads it synchronously, falling back to `cwdToServiceLabel` until the RPC resolves.
- `AgentStatusData`, `Tab`, `Block`, `Workspace`, `CommandGetSessionGroupData/RtnData` are ambient global types (generated into `gotypes.d.ts` under `declare global`) — no import needed in `frontend/**`.

---

# Part A — Real Status

## Task A0: Extract the view-model atom into its own module (fix Fast Refresh)

> Rationale: `sessionsidebar.tsx` currently exports a non-component (`sessionSidebarViewModelAtom`), which breaks React Fast Refresh (handoff finding #3). Part A/B edit this file repeatedly; fixing HMR first makes the rest of Phase 2 iterate cleanly. Pure move — no behavior change.

**Files:**
- Create: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

- [ ] **Step 1: Create the model module**

Create `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` and move the atom + `togglePin` verbatim out of `sessionsidebar.tsx`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getTabBadgeAtom } from "@/app/store/badge";
import { atoms } from "@/app/store/global-atoms";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import {
    badgeToStatus,
    buildSessionViewModel,
    type SessionInput,
    type SidebarViewModel,
} from "./sessionviewmodel";

/** Derived: collect per-tab data reactively and build the grouped view model. */
export const sessionSidebarViewModelAtom = atom<SidebarViewModel>((get) => {
    const ws = get(atoms.workspace);
    const tabIds = ws?.tabids ?? [];
    const activeId = ws?.activetabid;

    const sessions: SessionInput[] = tabIds.map((tabId) => {
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        const badges = get(getTabBadgeAtom(tabId));
        const status = badgeToStatus(badges?.[0]);

        let cwd: string | undefined;
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwd = block.meta["cmd:cwd"];
                break;
            }
        }

        const meta = (tab?.meta ?? {}) as Record<string, any>;
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            pinned: meta["session:pinned"] === true,
            cwd,
            status,
            active: tabId === activeId,
        };
    });

    return buildSessionViewModel(sessions);
});

export function togglePin(tabId: string, pinned: boolean) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", tabId),
            // session:pinned is not yet in MetaType (spec §6: meta-as-any for v1).
            meta: { "session:pinned": !pinned } as any,
        })
    );
}
```

- [ ] **Step 2: Trim `sessionsidebar.tsx` to a component-only file**

In `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`, delete the moved `sessionSidebarViewModelAtom` and `togglePin` definitions and their now-unused imports (`getTabBadgeAtom`, `atoms`, `WOS`, `RpcApi`, `TabRpcClient`, `fireAndForget`, `atom`, `badgeToStatus`, `buildSessionViewModel`, `SessionInput`, `SidebarViewModel`). Replace the import block so the file keeps only what the component uses:

```tsx
import { createTab, setActiveTab } from "@/app/store/global";
import { makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { SessionGroup, SessionRow } from "./sessionrow";
import { sessionSidebarViewModelAtom, togglePin } from "./sessionsidebarmodel";
import { aggregateStatus } from "./sessionviewmodel";

const PINNED_LABEL = "Pinned";
```

Leave the `SessionSidebar` component body unchanged.

- [ ] **Step 3: Typecheck + run the existing suite**

Run: `npx tsc --noEmit`
Expected: no new errors; no "declared but never used" in either file.

Run: `npx vitest run frontend/app/tab/sessionsidebar`
Expected: PASS — all 30 Phase 1 tests still green (pure move, no behavior change).

- [ ] **Step 4: Checkpoint**

`sessionsidebar.tsx` exports only the component; the atom/helper live in `sessionsidebarmodel.ts`; Fast Refresh restored. No commit.

---

## Task A1: Backend — `Event_AgentStatus` + `AgentStatusData` + codegen

**Files:**
- Modify: the `pkg/baseds` file that defines `BadgeEvent` (find with `grep -rn "type BadgeEvent" pkg/baseds`)
- Modify: `pkg/wps/wpstypes.go`
- Modify: `pkg/tsgen/tsgenevent.go`

- [ ] **Step 1: Add the data struct + state constants in `pkg/baseds`**

Append to the `baseds` file that defines `BadgeEvent`:

```go
const (
    AgentState_Working = "working"
    AgentState_Waiting = "waiting"
    AgentState_Idle    = "idle"
)

// AgentStatusData is the payload of Event_AgentStatus. ORef is the block (or tab)
// the status applies to; State is one of the AgentState_* constants.
type AgentStatusData struct {
    ORef   string `json:"oref"`
    State  string `json:"state"`
    Detail string `json:"detail,omitempty"`
    Agent  string `json:"agent,omitempty"`
    Ts     int64  `json:"ts"`
}
```

- [ ] **Step 2: Register the event constant in `pkg/wps/wpstypes.go`**

Add the constant inside the `const (…)` block (after `Event_Badge`, `wpstypes.go:36`), with the required `// type:` comment:

```go
	Event_AgentStatus         = "agent:status"          // type: baseds.AgentStatusData
```

Append it to `AllEvents` (after `Event_Badge`, `wpstypes.go:58`):

```go
	Event_AgentStatus,
```

- [ ] **Step 3: Register the payload type in `pkg/tsgen/tsgenevent.go`**

Add to the `WaveEventDataTypes` map (after the `Event_Badge` entry, `tsgenevent.go:43`). `baseds` is already imported in this file:

```go
	wps.Event_AgentStatus:         reflect.TypeOf(baseds.AgentStatusData{}),
```

- [ ] **Step 4: Generate the TypeScript types**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` gains `type AgentStatusData = {...}` and `WaveEventName` includes `"agent:status"`; `WaveEvent` union gains the `{ event: "agent:status"; data?: AgentStatusData }` arm.

- [ ] **Step 5: Verify Go compiles + generated types present**

Confirm VSCode shows no Go problems in the three edited files. Confirm `AgentStatusData` and `"agent:status"` appear in `frontend/types/gotypes.d.ts` (read it, do not edit it).

- [ ] **Step 6: Checkpoint**

Event constant + payload type defined and TS-generated. No commit.

---

## Task A2: Backend — the `wsh agentstatus` subcommand

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-agentstatus.go`
- Modify: `docs/docs/wsh-reference.mdx`

- [ ] **Step 1: Create the subcommand (modeled on `wshcmd-badge.go`)**

Create `cmd/wsh/cmd/wshcmd-agentstatus.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var agentStatusCmd = &cobra.Command{
	Use:                   "agentstatus",
	Short:                 "report coding-agent session status for a block",
	Args:                  cobra.NoArgs,
	RunE:                  agentStatusRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var (
	agentStatusState  string
	agentStatusDetail string
	agentStatusAgent  string
)

func init() {
	rootCmd.AddCommand(agentStatusCmd)
	agentStatusCmd.Flags().StringVar(&agentStatusState, "state", "", "agent state: working | waiting | idle")
	agentStatusCmd.Flags().StringVar(&agentStatusDetail, "detail", "", "activity detail line (e.g. \"editing foo.go\")")
	agentStatusCmd.Flags().StringVar(&agentStatusAgent, "agent", "", "agent identity (claude | codex)")
}

func validAgentState(s string) bool {
	return s == baseds.AgentState_Working || s == baseds.AgentState_Waiting || s == baseds.AgentState_Idle
}

func agentStatusRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agentstatus", rtnErr == nil)
	}()

	if !validAgentState(agentStatusState) {
		return fmt.Errorf("--state must be one of working, waiting, idle (got %q)", agentStatusState)
	}

	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %v", err)
	}
	if oref.OType != waveobj.OType_Block && oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("agentstatus oref must be a block or tab (got %q)", oref.OType)
	}

	eventData := baseds.AgentStatusData{
		ORef:   oref.String(),
		State:  agentStatusState,
		Detail: agentStatusDetail,
		Agent:  agentStatusAgent,
		Ts:     time.Now().UnixMilli(),
	}

	event := wps.WaveEvent{
		Event:   wps.Event_AgentStatus,
		Scopes:  []string{oref.String()},
		Persist: 1,
		Data:    eventData,
	}

	err = wshclient.EventPublishCommand(RpcClient, event, &wshrpc.RpcOpts{NoResponse: true})
	if err != nil {
		return fmt.Errorf("publishing agentstatus event: %v", err)
	}
	fmt.Printf("agentstatus %s set\n", agentStatusState)
	return nil
}
```

- [ ] **Step 2: Verify Go compiles**

Confirm VSCode shows no problems in `wshcmd-agentstatus.go`. (Per repo rules, do not run `go build`.) Confirm `sendActivity`, `resolveBlockArg`, `RpcClient`, and `preRunSetupRpcClient` resolve (all are package-level helpers in `cmd/wsh/cmd`, same as `wshcmd-badge.go` uses).

- [ ] **Step 3: Build wsh + smoke-test the CLI**

Run: `task build:wsh`
Then, inside a Wave terminal block (so `WAVETERM_BLOCKID` is set):
- `wsh agentstatus --help` → shows the three flags.
- `wsh agentstatus --state working --detail "running tests" --agent claude` → prints `agentstatus working set`.
- `wsh agentstatus --state bogus` → errors with the validation message and a non-zero exit.

- [ ] **Step 4: Document the command**

Add an `agentstatus` entry to `docs/docs/wsh-reference.mdx` in alphabetical order, matching the `badge` entry's format (synopsis + the `--state`/`--detail`/`--agent` flags + one example).

- [ ] **Step 5: Checkpoint**

`wsh agentstatus` builds, validates `--state`, and publishes a scoped `Event_AgentStatus`. No commit.

---

## Task A3: Frontend — per-ORef agent-status store + subscription

**Files:**
- Create: `frontend/app/tab/sessionsidebar/agentstatusstore.ts`

> Mirrors `frontend/app/store/badge.ts`: a module-level `Map<oref, PrimitiveAtom>` plus a once-only all-scopes subscription that dispatches by `event.data.oref`. No unit test (thin store over the event bus + global types); verified live in A8.

- [ ] **Step 1: Create the store**

Create `frontend/app/tab/sessionsidebar/agentstatusstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";

// keyed by block ORef string ("block:<uuid>")
const agentStatusAtoms = new Map<string, PrimitiveAtom<AgentStatusData>>();

export function getAgentStatusAtom(oref: string): PrimitiveAtom<AgentStatusData> {
    let statusAtom = agentStatusAtoms.get(oref);
    if (!statusAtom) {
        statusAtom = atom(null) as PrimitiveAtom<AgentStatusData>;
        agentStatusAtoms.set(oref, statusAtom);
    }
    return statusAtom;
}

let subscribed = false;
export function setupAgentStatusSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "agent:status",
        handler: (event) => {
            const data = event.data as AgentStatusData;
            if (data?.oref == null) {
                return;
            }
            globalStore.set(getAgentStatusAtom(data.oref), data);
        },
    });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. `AgentStatusData` resolves as an ambient global type (generated in A1). If `waveEventSubscribeSingle`'s `eventType` rejects `"agent:status"`, A1's `task generate` did not run — re-run it.

- [ ] **Step 3: Checkpoint**

Status store compiles; `getAgentStatusAtom` + `setupAgentStatusSubscription` exported. No commit.

---

## Task A4: Frontend — thread status + detail through the view model

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`

- [ ] **Step 1: Write the failing test (append to `sessionviewmodel.test.ts`)**

Add a test asserting the detail string is carried onto the row (the `input()` helper already exists from Phase 1 — add a `detail` to its overrides usage):

```ts
describe("buildSessionViewModel — detail", () => {
    it("carries the detail string onto the row", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/X", detail: "editing X.java" }),
        ]);
        expect(vm.groups[0].sessions[0].detail).toBe("editing X.java");
    });
    it("leaves detail undefined when not provided", () => {
        const vm = buildSessionViewModel([input({ tabId: "t1", cwd: "/src/X" })]);
        expect(vm.groups[0].sessions[0].detail).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `detail` is not a property of `SessionInput`/`SessionRowVM`.

- [ ] **Step 3: Implement — add `detail` to the types and `toRow`**

In `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`:

Add to `SessionInput` (after `status`):
```ts
    detail?: string;
```
Add to `SessionRowVM` (after `blocked`):
```ts
    detail?: string;
```
Add to the object returned by `toRow`:
```ts
        detail: s.detail,
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — including the two new cases.

- [ ] **Step 5: Wire status+detail from the agent-status atom in `sessionsidebarmodel.ts`**

In `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`, import the store and the status type, and prefer the agent status over the Phase 0 badge. Add imports:

```ts
import { getAgentStatusAtom } from "./agentstatusstore";
import { badgeToStatus, buildSessionViewModel, type SessionInput, type SessionStatus, type SidebarViewModel } from "./sessionviewmodel";
```

Inside the `tabIds.map(...)` callback, after the terminal `cwd`/`blockId` loop, resolve status + detail. Capture the terminal block id in the loop, then:

```ts
        let cwd: string | undefined;
        let termBlockId: string | undefined;
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwd = block.meta["cmd:cwd"];
                termBlockId = blockId;
                break;
            }
        }

        const badgeStatus = badgeToStatus(badges?.[0]);
        let status: SessionStatus = badgeStatus;
        let detail: string | undefined;
        if (termBlockId) {
            const agentStatus = get(getAgentStatusAtom(WOS.makeORef("block", termBlockId)));
            if (agentStatus?.state) {
                status = agentStatus.state as SessionStatus;
                detail = agentStatus.detail;
            }
        }
```

Then update the returned object to use the resolved `status` and add `detail` (replace the old `status` line which read the badge directly):

```ts
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            pinned: meta["session:pinned"] === true,
            cwd,
            status,
            detail,
            active: tabId === activeId,
        };
```

Remove the now-redundant `const status = badgeToStatus(badges?.[0]);` line near the top of the callback (it's replaced by `badgeStatus` above).

- [ ] **Step 6: Typecheck + full sidebar suite**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run frontend/app/tab/sessionsidebar` → all green.

- [ ] **Step 7: Checkpoint**

View model carries `detail`; the atom prefers live agent status, falling back to the badge. No commit.

---

## Task A5: Frontend — render the secondary detail line

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx`
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.test.tsx`

- [ ] **Step 1: Write the failing test (append to the `SessionRow` describe in `sessionrow.test.tsx`)**

The `render()` helper already spreads props; add `detail` cases:

```ts
    it("renders the detail line when provided", () => {
        expect(render({ detail: "editing CorrelationEngine.java" })).toContain("editing CorrelationEngine.java");
    });
    it("omits the detail line when not provided", () => {
        expect(render({ detail: undefined })).not.toContain("session-row-detail");
    });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: FAIL — `detail` is not a prop of `SessionRow`; `session-row-detail` not rendered.

- [ ] **Step 3: Implement — add the `detail` prop and the two-line layout**

In `frontend/app/tab/sessionsidebar/sessionrow.tsx`:

Add `detail?: string;` to `SessionRowProps` (after `pinned`). Add `detail` to the destructured params. Change the row container class from the fixed `h-8` to a min-height that grows for two lines, and replace the single label `<span>` with a vertical text stack:

```tsx
export function SessionRow({ label, status, active, blocked, pinned, detail, onSelect, onTogglePin }: SessionRowProps) {
    return (
        <div
            className={cn(
                "session-row group flex min-h-8 w-full cursor-pointer items-center gap-2 border-l-2 border-transparent py-1 pl-2 pr-1.5",
                active && "session-row--active border-l-[#429dff] bg-[rgba(66,157,255,0.08)]",
                blocked && "session-row--blocked border-l-[#d29922] bg-[rgba(210,153,34,0.08)]"
            )}
            onClick={onSelect}
        >
            <i
                className={makeIconClass("circle-small", true) + " text-[10px]"}
                style={{ color: STATUS_COLOR[status] }}
            />
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px]" title={label}>
                    {label}
                </span>
                {detail && (
                    <span className="session-row-detail truncate text-[11px] text-secondary" title={detail}>
                        {detail}
                    </span>
                )}
            </div>
            <i
                className={cn(
                    makeIconClass("thumbtack", true) + " text-[10px]",
                    pinned ? "opacity-90" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
                )}
                onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin();
                }}
            />
        </div>
    );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: PASS — all `SessionRow` + `SessionGroup` cases green.

- [ ] **Step 5: Start the subscription on mount**

In `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`, import and call the subscription once when the sidebar mounts. Add import:
```tsx
import { setupAgentStatusSubscription } from "./agentstatusstore";
import { useEffect, useState } from "react";
```
Add inside the `SessionSidebar` component, with the other hooks (before the `return`):
```tsx
    useEffect(() => {
        setupAgentStatusSubscription();
    }, []);
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run frontend/app/tab/sessionsidebar` → all green.

- [ ] **Step 7: Checkpoint**

Rows render a secondary detail line; subscription starts on mount. No commit.

---

## Task A6: Reporter promotion (documented integration step — no repo code)

> The reporter is external (not committed — confirmed by source search). This task records the exact change the user makes to their Phase 0 hook so it drives the new event instead of `wsh badge`. No repo files change here.

- [ ] **Step 1: Repoint the reporter sink**

In the reporter script (the hook command in the agent's `.claude/settings.json` / Codex `[hooks]`), replace the `wsh badge …` call with, per the spec §7 mapping:

| Event → | wsh invocation |
|---|---|
| `UserPromptSubmit` / `PreToolUse` | `wsh agentstatus --state working --detail "<editing X / running tests / …>" --agent <claude\|codex>` |
| `Notification` (permission/idle prompt) / `PermissionRequest` | `wsh agentstatus --state waiting --detail "<message>" --agent <…>` |
| `Stop` | `wsh agentstatus --state idle --detail "done · your move" --agent <…>` |

The reporter still reads `$WAVETERM_BLOCKID` from the inherited env; `wsh agentstatus` (no `--block`) auto-scopes to that block via `resolveBlockArg()`.

- [ ] **Step 2: Verify end-to-end**

With `app:tabbar=left`, start a hooked agent in a tab and confirm the row dot goes green (working) → amber (waiting) on a permission prompt → grey (idle) on Stop, and the **detail line** under the label updates to match (`editing …`, the prompt message, `done · your move`).

- [ ] **Step 3: Checkpoint**

Live status loop drives the real event + detail line. No commit (no repo change).

---

## Task A8: Part A verification

**Files:** none (verification only)

- [ ] **Step 1:** `npx vitest run frontend/app/tab/sessionsidebar` → all green.
- [ ] **Step 2:** `npx tsc --noEmit` → no new errors.
- [ ] **Step 3:** `npx eslint frontend/app/tab/sessionsidebar/**/*.{ts,tsx}` → clean.
- [ ] **Step 4: Live:** with a hooked agent, observe green→amber→grey on the dot AND the matching detail line; confirm two tabs in the same block-status state update independently (the per-ORef atom keying is correct). A tab with no agent event still shows the badge-derived dot (fallback intact).
- [ ] **Step 5: Checkpoint** — Part A complete. No commit (await batched approval).

---

# Part B — Real Grouping

## Task B1: Backend — walk-up + label heuristic + cache (TDD)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (types only)
- Create: `pkg/wshrpc/wshserver/sessiongroup.go`
- Create: `pkg/wshrpc/wshserver/sessiongroup_test.go`

- [ ] **Step 1: Add the request/response types in `wshrpctypes.go`**

Add near the other `Command*Data` types (exported types may be unused until B2 references them — that does not break the Go build):

```go
type CommandGetSessionGroupData struct {
	Cwd string `json:"cwd"`
}

type CommandGetSessionGroupRtnData struct {
	Root  string `json:"root"`
	Label string `json:"label"`
}
```

- [ ] **Step 2: Write the failing test**

Create `pkg/wshrpc/wshserver/sessiongroup_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"testing"
)

func mkfile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatalf("writefile: %v", err)
	}
}

func TestComputeSessionGroupLabel(t *testing.T) {
	root := t.TempDir()

	// nearest pom.xml wins; label = its dir's base name
	svc := filepath.Join(root, "src", "CorrelationEngine")
	mkfile(t, filepath.Join(svc, "pom.xml"))
	deep := filepath.Join(svc, "src", "main", "java")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}

	// version-dir heuristic: marker in a version-named dir -> parent label
	verSvc := filepath.Join(root, "CYbersecurity", "version-1.1")
	mkfile(t, filepath.Join(verSvc, "pom.xml"))

	// git-root fallback: no marker, but a .git dir up the tree
	gitRoot := filepath.Join(root, "plainrepo")
	mkfile(t, filepath.Join(gitRoot, ".git", "HEAD"))
	gitSub := filepath.Join(gitRoot, "nested")
	if err := os.MkdirAll(gitSub, 0o755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		cwd       string
		wantLabel string
		wantRoot  string
	}{
		{"nearest marker from deep dir", deep, "CorrelationEngine", svc},
		{"marker dir itself", svc, "CorrelationEngine", svc},
		{"version dir uses parent name", verSvc, "CYbersecurity", verSvc},
		{"git root fallback", gitSub, "plainrepo", gitRoot},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := computeSessionGroup(tt.cwd)
			if got.Label != tt.wantLabel {
				t.Errorf("label = %q, want %q", got.Label, tt.wantLabel)
			}
			if got.Root != tt.wantRoot {
				t.Errorf("root = %q, want %q", got.Root, tt.wantRoot)
			}
		})
	}

	// raw-cwd fallback: no marker, no .git
	bare := filepath.Join(root, "loose", "dir")
	if err := os.MkdirAll(bare, 0o755); err != nil {
		t.Fatal(err)
	}
	got := computeSessionGroup(bare)
	if got.Label != "dir" || got.Root != bare {
		t.Errorf("bare fallback = %+v, want label=dir root=%s", got, bare)
	}
}
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestComputeSessionGroupLabel -v`
Expected: FAIL to compile — `computeSessionGroup` undefined.

- [ ] **Step 4: Implement `sessiongroup.go`**

Create `pkg/wshrpc/wshserver/sessiongroup.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// marker files in priority order; pom.xml first because the target repo is Java/Maven (spec §5)
var sessionGroupMarkers = []string{
	"pom.xml",
	"go.mod",
	"package.json",
	"Cargo.toml",
	"pyproject.toml",
	"build.gradle",
	"Dockerfile",
}

// a dir name like "v1", "v2", "version-1.1" is not a useful service label; use its parent instead
var versionDirRe = regexp.MustCompile(`^(v\d+|version[-.].*)$`)

type sessionGroupCache struct {
	lock sync.Mutex
	m    map[string]*wshrpc.CommandGetSessionGroupRtnData
}

var sgCache = &sessionGroupCache{m: make(map[string]*wshrpc.CommandGetSessionGroupRtnData)}

func (c *sessionGroupCache) get(cwd string) (*wshrpc.CommandGetSessionGroupRtnData, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	v, ok := c.m[cwd]
	return v, ok
}

func (c *sessionGroupCache) set(cwd string, v *wshrpc.CommandGetSessionGroupRtnData) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.m[cwd] = v
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func findMarkerDir(dir string) (string, bool) {
	for {
		for _, marker := range sessionGroupMarkers {
			if fileExists(filepath.Join(dir, marker)) {
				return dir, true
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

func findGitRoot(dir string) (string, bool) {
	for {
		if fileExists(filepath.Join(dir, ".git")) {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

func labelForDir(dir string) string {
	base := filepath.Base(dir)
	if versionDirRe.MatchString(base) {
		return filepath.Base(filepath.Dir(dir))
	}
	return base
}

func computeSessionGroup(cwd string) *wshrpc.CommandGetSessionGroupRtnData {
	if markerDir, ok := findMarkerDir(cwd); ok {
		return &wshrpc.CommandGetSessionGroupRtnData{Root: markerDir, Label: labelForDir(markerDir)}
	}
	if gitRoot, ok := findGitRoot(cwd); ok {
		return &wshrpc.CommandGetSessionGroupRtnData{Root: gitRoot, Label: filepath.Base(gitRoot)}
	}
	return &wshrpc.CommandGetSessionGroupRtnData{Root: cwd, Label: filepath.Base(cwd)}
}

// resolveSessionGroup is the cached entry point used by the RPC. Cache is process-lifetime
// per spec §5 (cwd→service is stable; "auto, zero upkeep").
func resolveSessionGroup(cwd string) *wshrpc.CommandGetSessionGroupRtnData {
	if v, ok := sgCache.get(cwd); ok {
		return v
	}
	v := computeSessionGroup(cwd)
	sgCache.set(cwd, v)
	return v
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestComputeSessionGroupLabel -v`
Expected: PASS — all five cases (incl. `version-1.1` → `CYbersecurity`).

- [ ] **Step 6: Checkpoint**

Walk-up + heuristic + cache implemented and green. No commit.

---

## Task B2: Backend — the `GetSessionGroupCommand` RPC

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface method)
- Modify: `pkg/wshrpc/wshserver/wshserver.go`

- [ ] **Step 1: Declare the interface method**

In `pkg/wshrpc/wshrpctypes.go`, add to the `WshRpcInterface` interface (near the other `Get*Command` methods):

```go
	GetSessionGroupCommand(ctx context.Context, data CommandGetSessionGroupData) (*CommandGetSessionGroupRtnData, error)
```

- [ ] **Step 2: Implement it in `wshserver.go`**

Add to `pkg/wshrpc/wshserver/wshserver.go`:

```go
func (ws *WshServer) GetSessionGroupCommand(ctx context.Context, data wshrpc.CommandGetSessionGroupData) (*wshrpc.CommandGetSessionGroupRtnData, error) {
	if data.Cwd == "" {
		return nil, fmt.Errorf("cwd is required")
	}
	return resolveSessionGroup(data.Cwd), nil
}
```

(`fmt` is already imported in `wshserver.go`.)

- [ ] **Step 3: Generate the client**

Run: `task generate`
Expected: `wshclientapi.ts` gains `GetSessionGroupCommand(client, data, opts)` → `wshRpcCall("getsessiongroup", data, opts)`; `gotypes.d.ts` gains `CommandGetSessionGroupData` + `CommandGetSessionGroupRtnData`.

- [ ] **Step 4: Verify Go compiles + client generated**

Confirm no VSCode Go problems (the `WshServer` now satisfies the extended interface). Confirm the new method + types appear in the generated files (read-only).

- [ ] **Step 5: Checkpoint**

RPC declared, implemented, generated. No commit.

---

## Task B3: Frontend — group-label cache atom + resolver

**Files:**
- Create: `frontend/app/tab/sessionsidebar/sessiongroupstore.ts`

> The synchronous view-model atom can't `await`. This store holds resolved labels in a `PrimitiveAtom<Map<cwd,label>>`; `ensureSessionGroupLabels` fires the RPC for uncached cwds and writes results back, triggering a re-derive. No unit test (thin RPC cache); verified live in B6.

- [ ] **Step 1: Create the store**

Create `frontend/app/tab/sessionsidebar/sessiongroupstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";

// cwd -> resolved service label, filled asynchronously from GetSessionGroupCommand
export const sessionGroupLabelAtom = atom(new Map<string, string>()) as PrimitiveAtom<Map<string, string>>;

const inflight = new Set<string>();

export function ensureSessionGroupLabels(cwds: string[]) {
    const cur = globalStore.get(sessionGroupLabelAtom);
    const todo = cwds.filter((cwd) => cwd && !cur.has(cwd) && !inflight.has(cwd));
    if (todo.length === 0) {
        return;
    }
    for (const cwd of todo) {
        inflight.add(cwd);
        fireAndForget(async () => {
            try {
                const res = await RpcApi.GetSessionGroupCommand(TabRpcClient, { cwd });
                const next = new Map(globalStore.get(sessionGroupLabelAtom));
                next.set(cwd, res.label);
                globalStore.set(sessionGroupLabelAtom, next);
            } finally {
                inflight.delete(cwd);
            }
        });
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` → clean. (`RpcApi.GetSessionGroupCommand` exists from B2's `task generate`.)

- [ ] **Step 3: Checkpoint** — store compiles. No commit.

---

## Task B4: Frontend — group by resolved `serviceLabel` (pure)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

> Move the impurity (label derivation) out of the pure builder: the atom resolves each session's label and passes it in via a new required `serviceLabel` field. `cwdToServiceLabel` stays exported as the atom's fallback and keeps its Phase 1 tests.

- [ ] **Step 1: Update the test fixture + add a grouping-by-serviceLabel case**

In `sessionviewmodel.test.ts`, update the `input()` helper to supply `serviceLabel` (default derived from cwd so existing assertions still hold):

```ts
import { buildSessionViewModel, cwdToServiceLabel, type SessionInput } from "./sessionviewmodel";

function input(overrides: Partial<SessionInput>): SessionInput {
    const cwd = overrides.cwd ?? "/src/CorrelationEngine";
    return {
        tabId: "t1",
        name: "tab",
        agent: "claude",
        pinned: false,
        cwd,
        serviceLabel: cwdToServiceLabel(cwd),
        status: "idle",
        active: false,
        ...overrides,
    };
}
```

Add a case proving the builder groups by `serviceLabel`, not by recomputing from cwd:

```ts
it("groups by the provided serviceLabel, not the cwd basename", () => {
    const vm = buildSessionViewModel([
        input({ tabId: "t1", cwd: "/src/CorrelationEngine", serviceLabel: "ServiceA" }),
        input({ tabId: "t2", cwd: "/other/path", serviceLabel: "ServiceA" }),
    ]);
    expect(vm.groups).toHaveLength(1);
    expect(vm.groups[0].label).toBe("ServiceA");
    expect(vm.groups[0].sessions).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `serviceLabel` not on `SessionInput`; grouping still uses `cwdToServiceLabel`.

- [ ] **Step 3: Implement — add `serviceLabel`, group by it**

In `sessionviewmodel.ts`:

Add to `SessionInput` (after `cwd`):
```ts
    serviceLabel: string;
```

Change `rowLabel` to use the provided label instead of recomputing:
```ts
function rowLabel(s: SessionInput, includeService: boolean): string {
    const agent = s.agent && s.agent.length > 0 ? s.agent : s.name;
    const base = agent && agent.length > 0 ? agent : "session";
    return includeService ? `${base} · ${s.serviceLabel}` : base;
}
```

In `buildSessionViewModel`, group by `s.serviceLabel`:
```ts
        const label = s.serviceLabel;
```
(replace the `const label = cwdToServiceLabel(s.cwd);` line). Keep `cwdToServiceLabel` exported and unchanged — it remains the atom's fallback and keeps its Phase 1 tests.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — all pure-function cases, incl. the new one and the unchanged `cwdToServiceLabel` tests.

- [ ] **Step 5: Checkpoint** — builder groups by `serviceLabel`. No commit.

---

## Task B5: Frontend — resolve labels via the RPC and feed the atom

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

- [ ] **Step 1: Read resolved labels in the view-model atom**

In `sessionsidebarmodel.ts`, import the cache atom + fallback, and set `serviceLabel` per session. Add imports:
```ts
import { sessionGroupLabelAtom } from "./sessiongroupstore";
import { cwdToServiceLabel } from "./sessionviewmodel";
```
Inside the atom getter, read the label map once:
```ts
    const labelMap = get(sessionGroupLabelAtom);
```
In the per-tab return object, add (after `cwd`):
```ts
            serviceLabel: (cwd && labelMap.get(cwd)) || cwdToServiceLabel(cwd),
```

- [ ] **Step 2: Drive resolution from the component**

In `sessionsidebar.tsx`, import the resolver and trigger it for the cwds currently in view. Add import:
```tsx
import { ensureSessionGroupLabels } from "./sessiongroupstore";
```
The component already reads `vm = useAtomValue(sessionSidebarViewModelAtom)`. Collect distinct cwds from the workspace tabs is indirect through the vm; simplest is to resolve from the same source the atom uses. Add a derived read of the raw cwds via a small effect keyed on the workspace. Since the atom doesn't expose cwds, add a lightweight exported helper to the model that lists them, OR resolve opportunistically: add to `sessionsidebar.tsx` an effect that pulls cwds from the live tabs.

Add an exported selector atom to `sessionsidebarmodel.ts`:
```ts
export const sessionCwdsAtom = atom<string[]>((get) => {
    const ws = get(atoms.workspace);
    const tabIds = ws?.tabids ?? [];
    const cwds: string[] = [];
    for (const tabId of tabIds) {
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwds.push(block.meta["cmd:cwd"]);
                break;
            }
        }
    }
    return cwds;
});
```
In `sessionsidebar.tsx`, consume it and resolve on change:
```tsx
import { sessionCwdsAtom, sessionSidebarViewModelAtom, togglePin } from "./sessionsidebarmodel";
```
```tsx
    const cwds = useAtomValue(sessionCwdsAtom);
    useEffect(() => {
        ensureSessionGroupLabels(cwds);
    }, [cwds.join("|")]);
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run frontend/app/tab/sessionsidebar` → all green.

- [ ] **Step 4: Checkpoint** — labels resolve via the RPC into the cache atom; the sidebar re-groups when they arrive. No commit.

---

## Task B6: Part B verification

**Files:** none (verification only)

- [ ] **Step 1:** `go test ./pkg/wshrpc/wshserver/ -run TestComputeSessionGroupLabel -v` → PASS.
- [ ] **Step 2:** `npx vitest run frontend/app/tab/sessionsidebar` → all green.
- [ ] **Step 3:** `npx tsc --noEmit` → no new errors; `npx eslint frontend/app/tab/sessionsidebar/**/*.{ts,tsx}` → clean.
- [ ] **Step 4: Live:** open terminals in `…/src/<ServiceA>` (with a `pom.xml`/`go.mod` up-tree) and a sibling service. Confirm groups label by the marker dir (not the raw last segment) and a monorepo no longer collapses into one group. Confirm a `…/version-1.1/` cwd labels by its parent service name. Confirm the initial render shows the `cwdToServiceLabel` fallback then settles to the RPC label without fl/re-mount glitches.
- [ ] **Step 5: Checkpoint** — Part B complete. No commit (await batched approval).

---

## Self-Review

**1. Spec coverage (against §5 grouping, §6 UI, §7 status, §9 Phase 2 scope, §11 testing):**
- `wsh agentstatus --state --detail --agent` → Task A2. ✅
- `Event_AgentStatus` broker event scoped to block ORef → Tasks A1, A2. ✅
- Reporter promotion (detail line) → Task A6 (documented; external per spec §7). ✅ (flagged: committing a tested reporter is deferred.)
- Frontend subscription + per-session status dot + secondary detail line → Tasks A3, A4, A5. ✅
- `GetSessionGroup(cwd) → {root,label}` marker walk-up, fallback chain, version-dir heuristic, cached → Tasks B1, B2. ✅
- Swap client-side basename grouping for the RPC → Tasks B3, B4, B5. ✅
- Testing: walk-up + version-dir label table-driven (§11) → B1 Go test (incl. `version-1.1`); view-model purity preserved + extended (§11) → A4, B4. ✅
- Live-ticking idle duration ("12m") → correctly **deferred** (Phase 3), stated in header.

**2. Placeholder scan:** No "TBD"/"handle later"/"similar to". Every code step shows complete code. The two judgement points are concrete: A1 Step 1 says find the `baseds` file via grep (the file name isn't asserted, the symbol is); A6 is explicitly a documented manual step, not repo code.

**3. Type consistency:**
- `AgentStatusData{ORef,State,Detail,Agent,Ts}` defined in A1 (Go) → generated global type consumed in A3 (`event.data as AgentStatusData`, `getAgentStatusAtom`) and A4 (`agentStatus.state`/`.detail`). `State` values are the `AgentState_*` constants (A1) and align with the frontend `SessionStatus = "working"|"waiting"|"idle"` union — the A4 cast `agentStatus.state as SessionStatus` is sound because A2 validates `--state` against exactly those three.
- `Event_AgentStatus = "agent:status"` constant (A1) matches the FE `eventType: "agent:status"` (A3) and the generated `WaveEventName` arm.
- `CommandGetSessionGroupData{Cwd}` / `CommandGetSessionGroupRtnData{Root,Label}` defined B1, referenced by the interface method + impl B2, consumed FE as `RpcApi.GetSessionGroupCommand(TabRpcClient, { cwd })` returning `{label}` (B3). Field casing: Go `Cwd`→json `cwd`, `Label`→`label` — FE uses `cwd`/`res.label`. Consistent.
- `serviceLabel` added to `SessionInput` (B4) is required and always supplied by the atom (B5) via `labelMap.get(cwd) || cwdToServiceLabel(cwd)`; `detail` (A4) is optional. `buildSessionViewModel` consumes both. `cwdToServiceLabel` retained as fallback in both B4 (export) and B5 (atom). Consistent.
- `sessionSidebarViewModelAtom`, `togglePin`, `sessionCwdsAtom` all live in `sessionsidebarmodel.ts` (A0, B5) and are imported by `sessionsidebar.tsx`. `getAgentStatusAtom`/`setupAgentStatusSubscription` in `agentstatusstore.ts` (A3); `sessionGroupLabelAtom`/`ensureSessionGroupLabels` in `sessiongroupstore.ts` (B3). No name drift.

---

## Execution Handoff

Part A and Part B are independent — Part B can run first if grouping is the priority. Within each part, tasks are ordered by dependency.
