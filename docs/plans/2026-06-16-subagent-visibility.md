# Subagent Visibility in the Session Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a coding-agent session row reveal the subagents it spawned this turn as an inline tree of child rows (type + lifecycle outcome), auto-expanded while work is happening, riding the existing Phase 2 `Event_AgentStatus` pipeline with zero new event/subscription.

**Architecture:** Additive on top of Phase 2. The parent session's `SubagentStart`/`SubagentStop` hooks fire in the parent context, so the **existing reporter** catches them and calls `wsh agentstatus` with new `--subagent-start`/`--subagent-stop` flags. `AgentStatusData` gains an optional `subagent` delta; the command publishes it as a non-persisted `Event_AgentStatus`. The frontend's existing subscription reduces those deltas into a per-block `SubagentVM[]` atom, the view-model atom attaches the list (and a rolled-up dot) to the row, and the sidebar renders a chevron + count + an inline `├─`/`└─` child tree. State is ephemeral: a parent `Stop` (idle) clears the block's list and expand override.

**Tech Stack:** Go (`pkg/baseds` event payload, `pkg/wps` Persist, `cmd/wsh` cobra subcommand, `tsgen` codegen), React + TypeScript, Jotai atoms, Tailwind v4 + `cn()`, Font Awesome via `makeIconClass`, vitest (`renderToStaticMarkup` + pure-function unit tests).

**Conventions for this plan:**
- **No `git commit` steps.** Per the repo owner's strict no-auto-commit rule, each task ends with a **Checkpoint** (tests + typecheck/VSCode-clean). Commits are batched and made only with explicit approval. (Deliberately overrides the writing-plans skill's per-task commit steps — user instructions win, matching the Phase 2 and Phase 3 plans.)
- **TDD where it pays:** the four pure functions (`reduceSubagents`, `rollUpStatus`, `subagentExpanded`, and the view-model attach) get a failing test → red → minimal impl → green. The `SubagentRow`/`SessionRow` presentational changes get `renderToStaticMarkup` tests. Jotai-atom wiring, the store reducer, the cobra subcommand, and the reporter are verified **live** (matching how Phase 1/2/3 verified `wsh`/atoms — no unit tests for wiring).
- **Go rules:** string constants, not custom enum types (e.g. `const SubagentAction_Start = "start"`); consts at top of file; `Printf` not `Println`; `Make*` not `New*`. Do NOT run `go build` — VSCode problems indicate compile errors. DO run `go test` from the **project root** for any Go TDD step.
- **Codegen:** never hand-edit `frontend/types/gotypes.d.ts` or `frontend/app/store/wshclientapi.ts`. After editing Go types, run `task generate`.
- **TS rules:** 4-space indent; `@/...` imports across dirs, `./x` within dir; named exports only; `== null`/`!= null` (never `=== undefined`); early returns; `PrimitiveAtom<T>` for writable atoms; cast `atom(undefined)`/`atom(null)` to the proper `PrimitiveAtom<T>` (strict-null-checks-off quirk).

**Prerequisites:**
- **Phase 2 is committed** (commit `bb7a63e6`) and Phase 3 (`077ac807`). Build on that base. The Phase 2 status pipeline — `Event_AgentStatus`, `AgentStatusData`, `wsh agentstatus`, `agentstatusstore.ts`, `sessionSidebarViewModelAtom` — is the substrate this plan extends.
- The setting `app:tabbar` is `"left"` so the sidebar mounts (Phase 1 plan Task 8 dev-run recipe).
- The Phase 0/2 **reporter** exists in the user's environment (external to the repo — confirmed not committed; Phase 3 listed "committing the reporter script" as out of scope). Task 0 specifies the exact reporter change; it is a documented manual step, not repo code.

**Out of scope (YAGNI — stated in spec §2 / §8 Phase 3):**
- Live per-subagent activity ("now editing X") and per-subagent amber/blocked — **not parent-observable** (spec §4). Out, permanently for v1.
- Task **description** on rows — not in the documented payload (§4); rows show `agent_type`. Spike-gated stretch only.
- Persisting subagent state across reconnect — ephemeral, clears each turn.
- Phase 3 polish: persisted manual-expand prefs, success/failure counts on the collapsed badge, task-description label. Explicitly deferred.

**Decisions locked for this plan (resolving spec §7 open items):**
- **Nested subagents → no special handling.** A subagent's own `SubagentStart` fires inside *its* context, which never reaches the parent's hooks (§4). We therefore only ever observe depth-1 children; the reducer keys a flat list by `agent_id`. Flattening is automatic, not code.
- **Clear-on-idle, not clear-on-next-turn.** Spec §3/§5 say collapse + clear on the session's `Stop`/idle transition. Followed exactly: the finished `✓`/`✗` children linger only between `SubagentStop` and the parent `Stop`.
- **Subagent deltas are `Persist:0`; parent state stays `Persist:1`.** Deltas are ephemeral and must not be retained/replayed (a replayed delta would show a phantom child). Verified safe: `wps` `persistEvent` early-returns for `Persist<=0` and never evicts the retained parent-state event (`pkg/wps/wps.go:196,228`).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `pkg/baseds/baseds.go` | 1 | **MODIFY.** Add `AgentSubagentDelta` struct + `SubagentAction_*` / `SubagentStatus_*` string consts; add `Subagent *AgentSubagentDelta` to `AgentStatusData`. |
| `frontend/types/gotypes.d.ts` | 1 | **GENERATED** by `task generate` (read-only; never hand-edit). |
| `cmd/wsh/cmd/wshcmd-agentstatus.go` | 2 | **MODIFY.** Add `--subagent-start`/`--subagent-stop`/`--id`/`--type`/`--status` flags; branch the `RunE`; publish a `Persist:0` subagent-delta event vs the existing `Persist:1` state event. |
| `docs/docs/wsh-reference.mdx` | 2 | **MODIFY.** Extend the `agentstatus` entry with the subagent flags + an example. |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` | 3 | **MODIFY.** Add `SubagentState`/`SubagentVM`/`SubagentDelta`; pure `reduceSubagents`, `rollUpStatus`, `subagentExpanded`; add `subagents`/`subagentsExpanded`/`termBlockOref` to `SessionInput`+`SessionRowVM`; roll up status + attach subagents in `toRow`. |
| `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts` | 3 | **MODIFY.** Unit tests for the three pure fns + the view-model attach/rollup. |
| `frontend/app/tab/sessionsidebar/agentstatusstore.ts` | 4 | **MODIFY.** Add `getSubagentsAtom`/`getSubagentExpandAtom`/`toggleSubagentExpand`; extend the subscription handler to reduce deltas, clear on idle, and stop clobbering parent state with empty-state events. |
| `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` | 5 | **MODIFY.** In the view-model atom, read the two new per-block atoms, compute `subagentsExpanded`, and pass `subagents`/`subagentsExpanded`/`termBlockOref` into `SessionInput`. |
| `frontend/app/tab/sessionsidebar/sessionrow.tsx` | 6 | **MODIFY.** Add the `SubagentRow` presentational component; add chevron + count + `onToggleExpand` to `SessionRow`. |
| `frontend/app/tab/sessionsidebar/sessionrow.test.tsx` | 6 | **MODIFY.** Render tests for `SubagentRow` (connector/marker/truncation) + `SessionRow` chevron/count. |
| `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` | 7 | **MODIFY.** Render each row via a local `SessionRowTree` that emits the `SessionRow` + (when expanded) its `SubagentRow` children; wire `onToggleExpand`. |
| *(external) reporter script* | 0 | **DOCUMENTED.** Map `SubagentStart`/`SubagentStop` → `wsh agentstatus` subagent flags. No repo file. |

**Verified API facts this plan relies on (source-inspected 2026-06-16):**
- `AgentStatusData{ORef,State,Detail,Agent,Ts}` lives in `pkg/baseds/baseds.go:40-46`; `AgentState_Working/Waiting/Idle = "working"/"waiting"/"idle"` at `:32-36`. It is the registered payload for `Event_AgentStatus = "agent:status"` (`pkg/wps/wpstypes.go:37`) via `WaveEventDataTypes` in `pkg/tsgen/tsgenevent.go`. Nested structs referenced by a registered payload are generated transitively (Phase 2 confirmed event payload types generate without an `ExtraTypes` edit).
- `wsh agentstatus` (`cmd/wsh/cmd/wshcmd-agentstatus.go`) resolves its target via `resolveBlockArg()` (reads `--block`/`WAVETERM_BLOCKID`; `cmd/wsh/cmd/wshcmd-root.go:115`), validates `--state`, builds `wps.WaveEvent{Event, Scopes:[oref], Persist:1, Data}`, and publishes via `wshclient.EventPublishCommand(RpcClient, event, &wshrpc.RpcOpts{NoResponse:true})`. `baseds`, `time`, `fmt`, `waveobj`, `wps`, `wshrpc`, `wshclient` are already imported there.
- **Persist semantics:** `BrokerType.persistEvent` returns immediately for `event.Persist <= 0` (`pkg/wps/wps.go:196`); `Publish` only calls it when `event.Persist > 0` (`:228`). So a `Persist:0` event is delivered to live subscribers but never retained nor replayed to late subscribers, and never evicts a retained `Persist:1` event for the same `(event,scope)` key.
- **Frontend store:** `agentstatusstore.ts` keeps a `Map<oref, PrimitiveAtom<AgentStatusData>>` (`getAgentStatusAtom`) and a once-only all-scopes `waveEventSubscribeSingle({eventType:"agent:status", handler})` that dispatches by `event.data.oref` (`agentstatusstore.ts:9-36`). `globalStore` from `@/app/store/jotaiStore`; `atom`/`PrimitiveAtom` from `jotai`.
- **View-model atom:** `sessionSidebarViewModelAtom` (`sessionsidebarmodel.ts:27-74`) already finds each tab's terminal block (`block.meta.view==="term" && block.meta["cmd:cwd"]`), captures `termBlockId`, reads `getAgentStatusAtom(WOS.makeORef("block", termBlockId))`, and prefers a non-empty `agentStatus.state` over the badge. `WOS.makeORef("block", id)` yields the `"block:<uuid>"` oref string used as the atom key.
- **Pure module:** `sessionviewmodel.ts` has **no React/Wave imports**; it defines `SessionStatus="working"|"waiting"|"idle"`, `SessionInput`, `SessionRowVM`, `buildSessionViewModel`, `aggregateStatus`, `toRow` (`:75-85`), and per-row helpers. Group `aggregateStatus` is computed from `rows.map(r=>r.status)` (`:108`), so rolling up status into `row.status` automatically surfaces a working subagent in a collapsed group's aggregate dot.
- **Row rendering:** `SessionRow` (`sessionrow.tsx:26-62`) is presentational (only `cn`/`makeIconClass` imports) and is mapped directly in both the pinned and group sections of `sessionsidebar.tsx:56-93`. `STATUS_COLOR` and the `circle-small` icon define the existing dot. `SessionGroup` renders its `children` inside a `flex flex-col`, so rendering extra sibling rows after a `SessionRow` lays them out vertically.
- **Test conventions:** `sessionviewmodel.test.ts` uses an `input(overrides: Partial<SessionInput>): SessionInput` factory (`:71-84`) that defaults `serviceLabel` from `cwd` and spreads overrides — new optional `SessionInput` fields need no factory change. `sessionrow.test.tsx` uses a `render(props): string` over `renderToStaticMarkup` (`:5-18`).

---

## Task 0: Reporter integration (documented spike + promotion — no repo code)

> The reporter is external (not committed). This task records the exact change the user makes to their reporter so it drives the subagent rows. **Spec §8 Phase 0** (verify payloads) and **Phase 2b** (emit the new flags) are folded together here because the parent-status spike already shipped; only the subagent events are new. No repo files change.

- [ ] **Step 1 (spike): log raw subagent payloads to confirm fields**

In the reporter (the hook command wired into the agent's `.claude/settings.json`), temporarily append the raw stdin JSON for the two new events to a log file when the event is `SubagentStart` or `SubagentStop`. Run a session that spawns ≥2 parallel subagents (e.g. ask Claude Code to launch two `Explore` agents). Confirm in the log:
- `SubagentStart` carries `agent_type` and a unique `agent_id`.
- `SubagentStop` carries the matching `agent_id`, `reason`, and `completion_status` (`success`/`failure`/`other`).
- Parallel subagents have **distinct** `agent_id`s and interleave start/stop cleanly.
- (Codex) whether an equivalent start/stop signal exists. If not, subagent rows simply won't appear for Codex sessions — graceful degradation, no code change.

Gate: is the lifecycle signal clean enough to render? (Per spec §8.) If field names differ from the table in spec §4, adjust the mapping in Step 2 accordingly before proceeding.

- [ ] **Step 2 (promotion): map the events to `wsh agentstatus` subagent flags**

In the reporter, add these two branches (alongside the existing `working`/`waiting`/`idle` branches that emit `--state`). `$WAVETERM_BLOCKID` is inherited from the session env, so `wsh agentstatus` auto-scopes to the block (no `--block`):

| Hook event → | wsh invocation |
|---|---|
| `SubagentStart` | `wsh agentstatus --subagent-start --id "<agent_id>" --type "<agent_type>" --agent <claude\|codex>` |
| `SubagentStop` | `wsh agentstatus --subagent-stop --id "<agent_id>" --type "<agent_type>" --status <success\|failure> --agent <claude\|codex>` |

Map `completion_status`: `success` → `success`; anything else (`failure`/`other`, or `reason ∈ {error,timeout,cancelled}`) → `failure`. Hooks may be `"async": true` so they never block the agent.

- [ ] **Step 3: remove the spike logging**

Delete the raw-payload logging added in Step 1 once the mapping is confirmed.

- [ ] **Step 4: Checkpoint**

Reporter emits subagent start/stop deltas; field names confirmed. No repo change. (Live end-to-end verification happens in Task 8 once the frontend renders the tree.)

---

## Task 1: Backend — extend `AgentStatusData` with a subagent delta + codegen

**Files:**
- Modify: `pkg/baseds/baseds.go` (after the `AgentStatusData` struct, ends `:46`)
- Generated: `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add the delta struct, string constants, and the optional field**

In `pkg/baseds/baseds.go`, add the new string constants and struct, and add the `Subagent` field to `AgentStatusData`. Replace the existing block (`:32-46`):

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

with:

```go
const (
	AgentState_Working = "working"
	AgentState_Waiting = "waiting"
	AgentState_Idle    = "idle"
)

const (
	SubagentAction_Start = "start"
	SubagentAction_Stop  = "stop"

	SubagentStatus_Success = "success"
	SubagentStatus_Failure = "failure"
)

// AgentSubagentDelta is an optional delta carried on AgentStatusData describing a single
// subagent lifecycle transition in the parent session (SubagentStart / SubagentStop hooks).
// It is a delta, not state: the frontend reduces a stream of these into a per-block list.
type AgentSubagentDelta struct {
	Action string `json:"action"`           // SubagentAction_Start | SubagentAction_Stop
	Id     string `json:"id"`               // agent_id, unique per invocation
	Type   string `json:"type,omitempty"`   // agent_type (e.g. Explore, Plan)
	Status string `json:"status,omitempty"` // SubagentStatus_* (stop only)
}

// AgentStatusData is the payload of Event_AgentStatus. ORef is the block (or tab)
// the status applies to; State is one of the AgentState_* constants. When Subagent is
// non-nil the event carries a subagent delta (State may be empty in that case).
type AgentStatusData struct {
	ORef     string              `json:"oref"`
	State    string              `json:"state"`
	Detail   string              `json:"detail,omitempty"`
	Agent    string              `json:"agent,omitempty"`
	Ts       int64               `json:"ts"`
	Subagent *AgentSubagentDelta `json:"subagent,omitempty"`
}
```

- [ ] **Step 2: Generate the TypeScript types**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` gains `type AgentSubagentDelta = { action: string; id: string; type?: string; status?: string }` and `AgentStatusData` gains `subagent?: AgentSubagentDelta`.

- [ ] **Step 3: Verify Go compiles + generated types present**

Confirm VSCode shows no Go problems in `baseds.go`. Confirm `AgentSubagentDelta` and the `subagent?` field appear in `frontend/types/gotypes.d.ts` (read it; do not edit).

- [ ] **Step 4: Checkpoint**

Payload extended with the optional subagent delta; TS regenerated. No commit.

---

## Task 2: Backend — subagent flags on `wsh agentstatus`

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agentstatus.go`
- Modify: `docs/docs/wsh-reference.mdx`

- [ ] **Step 1: Add the new flag vars + registration**

In `cmd/wsh/cmd/wshcmd-agentstatus.go`, replace the var block + `init()` (`:27-38`):

```go
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
```

with:

```go
var (
	agentStatusState  string
	agentStatusDetail string
	agentStatusAgent  string

	agentSubagentStart  bool
	agentSubagentStop   bool
	agentSubagentId     string
	agentSubagentType   string
	agentSubagentStatus string
)

func init() {
	rootCmd.AddCommand(agentStatusCmd)
	agentStatusCmd.Flags().StringVar(&agentStatusState, "state", "", "agent state: working | waiting | idle")
	agentStatusCmd.Flags().StringVar(&agentStatusDetail, "detail", "", "activity detail line (e.g. \"editing foo.go\")")
	agentStatusCmd.Flags().StringVar(&agentStatusAgent, "agent", "", "agent identity (claude | codex)")
	agentStatusCmd.Flags().BoolVar(&agentSubagentStart, "subagent-start", false, "report a subagent that started (requires --id, --type)")
	agentStatusCmd.Flags().BoolVar(&agentSubagentStop, "subagent-stop", false, "report a subagent that stopped (requires --id; --status success|failure)")
	agentStatusCmd.Flags().StringVar(&agentSubagentId, "id", "", "subagent agent_id (with --subagent-start/--subagent-stop)")
	agentStatusCmd.Flags().StringVar(&agentSubagentType, "type", "", "subagent agent_type (e.g. Explore, Plan)")
	agentStatusCmd.Flags().StringVar(&agentSubagentStatus, "status", "", "subagent outcome: success | failure (with --subagent-stop)")
}
```

- [ ] **Step 2: Branch `RunE` — subagent delta vs parent state**

Replace the body of `agentStatusRun` (`:44-82`) with the version below. It resolves the oref first, then branches: a subagent delta publishes a `Persist:0` event carrying `Subagent`; the existing parent-state path is unchanged except it's now reached only when no subagent flag is set.

```go
func agentStatusRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agentstatus", rtnErr == nil)
	}()

	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %v", err)
	}
	if oref.OType != waveobj.OType_Block && oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("agentstatus oref must be a block or tab (got %q)", oref.OType)
	}

	if agentSubagentStart || agentSubagentStop {
		return publishSubagentDelta(oref)
	}

	if !validAgentState(agentStatusState) {
		return fmt.Errorf("--state must be one of working, waiting, idle (got %q)", agentStatusState)
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

func publishSubagentDelta(oref *waveobj.ORef) error {
	if agentSubagentStart && agentSubagentStop {
		return fmt.Errorf("--subagent-start and --subagent-stop are mutually exclusive")
	}
	if agentSubagentId == "" {
		return fmt.Errorf("--id is required with --subagent-start/--subagent-stop")
	}

	action := baseds.SubagentAction_Start
	status := ""
	if agentSubagentStop {
		action = baseds.SubagentAction_Stop
		if agentSubagentStatus != "" && agentSubagentStatus != baseds.SubagentStatus_Success && agentSubagentStatus != baseds.SubagentStatus_Failure {
			return fmt.Errorf("--status must be success or failure (got %q)", agentSubagentStatus)
		}
		status = agentSubagentStatus
	}

	eventData := baseds.AgentStatusData{
		ORef:  oref.String(),
		Agent: agentStatusAgent,
		Ts:    time.Now().UnixMilli(),
		Subagent: &baseds.AgentSubagentDelta{
			Action: action,
			Id:     agentSubagentId,
			Type:   agentSubagentType,
			Status: status,
		},
	}

	// Persist:0 — subagent deltas are ephemeral; they must not be retained or replayed to
	// late subscribers (a replayed delta would resurrect a phantom child). The retained
	// Persist:1 parent-state event for the same scope is untouched (pkg/wps/wps.go:196,228).
	event := wps.WaveEvent{
		Event:   wps.Event_AgentStatus,
		Scopes:  []string{oref.String()},
		Persist: 0,
		Data:    eventData,
	}

	err := wshclient.EventPublishCommand(RpcClient, event, &wshrpc.RpcOpts{NoResponse: true})
	if err != nil {
		return fmt.Errorf("publishing agentstatus subagent event: %v", err)
	}
	fmt.Printf("agentstatus subagent %s %s set\n", action, agentSubagentId)
	return nil
}
```

(`validAgentState` is unchanged from `:40-42`.)

- [ ] **Step 3: Verify Go compiles**

Confirm VSCode shows no problems in `wshcmd-agentstatus.go`. (Do not run `go build`.) `resolveBlockArg` returns `*waveobj.ORef`, matching `publishSubagentDelta`'s parameter type.

- [ ] **Step 4: Build wsh + smoke-test the CLI**

Run: `task build:wsh`
Then, inside a Wave terminal block (so `WAVETERM_BLOCKID` is set):
- `wsh agentstatus --help` → shows the original three flags plus `--subagent-start`, `--subagent-stop`, `--id`, `--type`, `--status`.
- `wsh agentstatus --subagent-start --id a1 --type Explore --agent claude` → prints `agentstatus subagent start a1 set`.
- `wsh agentstatus --subagent-stop --id a1 --type Explore --status success` → prints `agentstatus subagent stop a1 set`.
- `wsh agentstatus --subagent-stop --id a1 --status bogus` → errors `--status must be success or failure (got "bogus")`, non-zero exit.
- `wsh agentstatus --subagent-start` (no `--id`) → errors `--id is required …`.
- `wsh agentstatus --state working --detail "running tests"` → still prints `agentstatus working set` (parent path intact).

- [ ] **Step 5: Document the flags**

In `docs/docs/wsh-reference.mdx`, extend the existing `agentstatus` entry: add the five subagent flags and one example line, e.g. `wsh agentstatus --subagent-start --id <agent_id> --type Explore`. Match the entry's existing format.

- [ ] **Step 6: Checkpoint**

`wsh agentstatus` accepts subagent deltas, validates them, and publishes a non-persisted scoped event; the parent-state path is unchanged. No commit.

---

## Task 3: Frontend pure — subagent types, reducer, rollup, expand, view-model attach (TDD)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests (append to `sessionviewmodel.test.ts`)**

Extend the import at the top (`:1-13`) to add the new symbols:

```ts
import { describe, expect, it } from "vitest";
import {
    aggregateStatus,
    badgeToStatus,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    flattenVisualOrder,
    needsYouTarget,
    NO_CWD_LABEL,
    reduceSubagents,
    rollUpStatus,
    subagentExpanded,
    toggleCollapsed,
    type SessionInput,
} from "./sessionviewmodel";
```

Append these describes at the end of the file:

```ts
describe("reduceSubagents", () => {
    it("start appends a working subagent", () => {
        expect(reduceSubagents([], { action: "start", id: "a", type: "Explore" })).toEqual([
            { id: "a", type: "Explore", state: "working" },
        ]);
    });
    it("start is idempotent for a known id", () => {
        const list = [{ id: "a", type: "Explore", state: "working" as const }];
        expect(reduceSubagents(list, { action: "start", id: "a", type: "Explore" })).toEqual(list);
    });
    it("stop flips the matching id to success", () => {
        expect(
            reduceSubagents([{ id: "a", type: "E", state: "working" }], { action: "stop", id: "a", type: "E", status: "success" })
        ).toEqual([{ id: "a", type: "E", state: "success" }]);
    });
    it("stop with failure marks failure", () => {
        expect(
            reduceSubagents([{ id: "a", type: "E", state: "working" }], { action: "stop", id: "a", type: "E", status: "failure" })
        ).toEqual([{ id: "a", type: "E", state: "failure" }]);
    });
    it("stop defaults to success when status is omitted", () => {
        expect(reduceSubagents([{ id: "a", type: "E", state: "working" }], { action: "stop", id: "a", type: "E" })).toEqual([
            { id: "a", type: "E", state: "success" },
        ]);
    });
    it("stop for an unknown id appends a stopped entry", () => {
        expect(reduceSubagents([], { action: "stop", id: "b", type: "Plan", status: "success" })).toEqual([
            { id: "b", type: "Plan", state: "success" },
        ]);
    });
    it("does not mutate the input list", () => {
        const list = [{ id: "a", type: "E", state: "working" as const }];
        reduceSubagents(list, { action: "stop", id: "a", type: "E", status: "success" });
        expect(list).toEqual([{ id: "a", type: "E", state: "working" }]);
    });
    it("tracks parallel subagents independently", () => {
        let l = reduceSubagents([], { action: "start", id: "a", type: "E" });
        l = reduceSubagents(l, { action: "start", id: "b", type: "P" });
        l = reduceSubagents(l, { action: "stop", id: "a", type: "E", status: "success" });
        expect(l).toEqual([
            { id: "a", type: "E", state: "success" },
            { id: "b", type: "P", state: "working" },
        ]);
    });
});

describe("rollUpStatus", () => {
    it("waiting parent dominates a working child", () => {
        expect(rollUpStatus("waiting", [{ id: "a", type: "E", state: "working" }])).toBe("waiting");
    });
    it("idle parent with a working child becomes working", () => {
        expect(rollUpStatus("idle", [{ id: "a", type: "E", state: "working" }])).toBe("working");
    });
    it("idle parent with only finished children stays idle", () => {
        expect(rollUpStatus("idle", [{ id: "a", type: "E", state: "success" }])).toBe("idle");
    });
    it("no children returns the parent status", () => {
        expect(rollUpStatus("working", [])).toBe("working");
    });
});

describe("subagentExpanded", () => {
    it("an empty list is never expanded", () => {
        expect(subagentExpanded([], undefined)).toBe(false);
        expect(subagentExpanded([], true)).toBe(false);
    });
    it("auto-expands while a child is working", () => {
        expect(subagentExpanded([{ id: "a", type: "E", state: "working" }], undefined)).toBe(true);
    });
    it("auto-collapses when all children finished", () => {
        expect(subagentExpanded([{ id: "a", type: "E", state: "success" }], undefined)).toBe(false);
    });
    it("manual override wins over auto", () => {
        expect(subagentExpanded([{ id: "a", type: "E", state: "working" }], false)).toBe(false);
        expect(subagentExpanded([{ id: "a", type: "E", state: "success" }], true)).toBe(true);
    });
});

describe("buildSessionViewModel — subagents", () => {
    it("attaches subagents and rolls an idle parent up to working", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/X", status: "idle", subagents: [{ id: "a", type: "Explore", state: "working" }] }),
        ]);
        const row = vm.groups[0].sessions[0];
        expect(row.subagents).toHaveLength(1);
        expect(row.status).toBe("working");
    });
    it("keeps a waiting parent amber even with a working subagent", () => {
        const vm = buildSessionViewModel([
            input({ tabId: "t1", cwd: "/src/X", status: "waiting", subagents: [{ id: "a", type: "E", state: "working" }] }),
        ]);
        expect(vm.groups[0].sessions[0].status).toBe("waiting");
    });
    it("defaults subagents to [] and expanded to false", () => {
        const vm = buildSessionViewModel([input({ tabId: "t1", cwd: "/src/X" })]);
        const row = vm.groups[0].sessions[0];
        expect(row.subagents).toEqual([]);
        expect(row.subagentsExpanded).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `reduceSubagents`/`rollUpStatus`/`subagentExpanded` not exported; `subagents`/`subagentsExpanded` not on the row.

- [ ] **Step 3: Add the types to `sessionviewmodel.ts`**

After the `SessionStatus` type (`:5`), add:

```ts
export type SubagentState = "working" | "success" | "failure";

export interface SubagentVM {
    id: string;
    type: string;
    state: SubagentState;
}

/** A single subagent lifecycle transition, mapped from the AgentStatusData.subagent delta. */
export interface SubagentDelta {
    action: "start" | "stop";
    id: string;
    type: string;
    status?: "success" | "failure";
}
```

Add to `SessionInput` (after `detail?: string;`, `:45`):

```ts
    subagents?: SubagentVM[];
    subagentsExpanded?: boolean;
    termBlockOref?: string;
```

Add to `SessionRowVM` (after `detail?: string;`, `:55`):

```ts
    subagents: SubagentVM[];
    subagentsExpanded: boolean;
    termBlockOref?: string;
```

- [ ] **Step 4: Roll up status + attach subagents in `toRow`**

Replace `toRow` (`:75-85`):

```ts
function toRow(s: SessionInput, includeService: boolean): SessionRowVM {
    return {
        tabId: s.tabId,
        label: rowLabel(s, includeService),
        status: s.status,
        active: s.active,
        blocked: s.status === "waiting",
        pinned: s.pinned,
        detail: s.detail,
    };
}
```

with:

```ts
function toRow(s: SessionInput, includeService: boolean): SessionRowVM {
    const subagents = s.subagents ?? [];
    const status = rollUpStatus(s.status, subagents);
    return {
        tabId: s.tabId,
        label: rowLabel(s, includeService),
        status,
        active: s.active,
        blocked: status === "waiting",
        pinned: s.pinned,
        detail: s.detail,
        subagents,
        subagentsExpanded: s.subagentsExpanded ?? false,
        termBlockOref: s.termBlockOref,
    };
}
```

- [ ] **Step 5: Implement the three pure functions (append to `sessionviewmodel.ts`)**

```ts
/** Pure: reduce a subagent start/stop delta into the per-block list. Never mutates the input.
 *  start is idempotent by id; stop flips the matching entry (or appends if the start was missed). */
export function reduceSubagents(list: SubagentVM[], delta: SubagentDelta): SubagentVM[] {
    if (delta.action === "start") {
        if (list.some((s) => s.id === delta.id)) {
            return list;
        }
        return [...list, { id: delta.id, type: delta.type, state: "working" }];
    }
    const state: SubagentState = delta.status === "failure" ? "failure" : "success";
    if (!list.some((s) => s.id === delta.id)) {
        return [...list, { id: delta.id, type: delta.type, state }];
    }
    return list.map((s) => (s.id === delta.id ? { ...s, state } : s));
}

/** Pure: the row's dot reflects children — the parent's own waiting (amber) dominates;
 *  otherwise any working child lifts an idle/working parent to working. */
export function rollUpStatus(parent: SessionStatus, subagents: SubagentVM[]): SessionStatus {
    if (parent === "waiting") {
        return "waiting";
    }
    if (subagents.some((s) => s.state === "working")) {
        return "working";
    }
    return parent;
}

/** Pure: auto-expand while a child is working; a manual override (set this turn) wins.
 *  An empty list is never expanded (nothing to show). */
export function subagentExpanded(subagents: SubagentVM[], manualOverride?: boolean): boolean {
    if (subagents.length === 0) {
        return false;
    }
    if (manualOverride != null) {
        return manualOverride;
    }
    return subagents.some((s) => s.state === "working");
}
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS — all new cases plus the unchanged Phase 1/2/3 cases (existing `input()` calls pass no `subagents`, so `subagents=[]` and `rollUpStatus` returns the parent status unchanged).

- [ ] **Step 7: Checkpoint**

Pure subagent reducer, rollup, expand derivation, and view-model attach implemented and green. No commit.

---

## Task 4: Frontend — subagent store + subscription reducer

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/agentstatusstore.ts`

> Extends the existing once-only `agent:status` subscription. No unit test (thin store over the event bus + global types); verified live in Task 8. Two correctness points: (1) a delta-only event has empty `state`, so it must NOT overwrite the parent-status atom; (2) a parent `idle` (Stop) clears the block's ephemeral subagent list + expand override.

- [ ] **Step 1: Add the imports + the two atom maps + the toggle helper**

In `frontend/app/tab/sessionsidebar/agentstatusstore.ts`, add to the imports (after the `jotai` import, `:6`):

```ts
import { reduceSubagents, type SubagentDelta, type SubagentVM } from "./sessionviewmodel";
```

After `getAgentStatusAtom` (`:18`), add:

```ts
// per-block ephemeral subagent list, reduced from start/stop deltas; cleared on the parent's idle transition
const subagentAtoms = new Map<string, PrimitiveAtom<SubagentVM[]>>();

export function getSubagentsAtom(oref: string): PrimitiveAtom<SubagentVM[]> {
    let saAtom = subagentAtoms.get(oref);
    if (!saAtom) {
        saAtom = atom<SubagentVM[]>([]) as PrimitiveAtom<SubagentVM[]>;
        subagentAtoms.set(oref, saAtom);
    }
    return saAtom;
}

// per-block manual expand override (undefined = auto). Reset to undefined on the parent's idle transition.
const subagentExpandAtoms = new Map<string, PrimitiveAtom<boolean>>();

export function getSubagentExpandAtom(oref: string): PrimitiveAtom<boolean> {
    let expandAtom = subagentExpandAtoms.get(oref);
    if (!expandAtom) {
        expandAtom = atom(undefined) as PrimitiveAtom<boolean>;
        subagentExpandAtoms.set(oref, expandAtom);
    }
    return expandAtom;
}

export function toggleSubagentExpand(oref: string, currentlyExpanded: boolean) {
    if (!oref) {
        return;
    }
    globalStore.set(getSubagentExpandAtom(oref), !currentlyExpanded);
}
```

- [ ] **Step 2: Extend the subscription handler**

Replace the handler (`:26-35`):

```ts
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
```

with:

```ts
    waveEventSubscribeSingle({
        eventType: "agent:status",
        handler: (event) => {
            const data = event.data as AgentStatusData;
            if (data?.oref == null) {
                return;
            }
            if (data.subagent != null) {
                const sa = data.subagent;
                const delta: SubagentDelta = {
                    action: sa.action === "stop" ? "stop" : "start",
                    id: sa.id,
                    type: sa.type ?? "",
                    status: sa.status === "failure" ? "failure" : sa.status === "success" ? "success" : undefined,
                };
                const cur = globalStore.get(getSubagentsAtom(data.oref));
                globalStore.set(getSubagentsAtom(data.oref), reduceSubagents(cur, delta));
            }
            // a delta-only event carries an empty state; only a real state update should touch the parent atom
            if (data.state) {
                globalStore.set(getAgentStatusAtom(data.oref), data);
                if (data.state === "idle") {
                    // turn ended: subagent state is ephemeral — clear the list and the manual expand override
                    globalStore.set(getSubagentsAtom(data.oref), []);
                    globalStore.set(getSubagentExpandAtom(data.oref), undefined);
                }
            }
        },
    });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. `AgentStatusData.subagent` resolves as the generated global type (Task 1); `reduceSubagents`/`SubagentDelta`/`SubagentVM` import from the pure module.

- [ ] **Step 4: Checkpoint**

Store reduces subagent deltas per block, clears on idle, and no longer clobbers parent state with empty-state events; `toggleSubagentExpand` exported. No commit.

---

## Task 5: Frontend — wire subagents into the view-model atom

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`

- [ ] **Step 1: Extend the imports**

In `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`, update the `agentstatusstore` import (`:13`):

```ts
import { getAgentStatusAtom } from "./agentstatusstore";
```

to:

```ts
import { getAgentStatusAtom, getSubagentExpandAtom, getSubagentsAtom } from "./agentstatusstore";
```

and the `sessionviewmodel` import (`:15-24`) to add `subagentExpanded` and `SubagentVM`:

```ts
import {
    badgeToStatus,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    needsYouTarget,
    subagentExpanded,
    type SessionInput,
    type SessionStatus,
    type SidebarViewModel,
    type SubagentVM,
} from "./sessionviewmodel";
```

- [ ] **Step 2: Read the subagent atoms + compute expand in the atom getter**

In `sessionSidebarViewModelAtom`, replace the status-resolution block (`:48-57`):

```ts
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

with:

```ts
        const badgeStatus = badgeToStatus(badges?.[0]);
        let status: SessionStatus = badgeStatus;
        let detail: string | undefined;
        let subagents: SubagentVM[] = [];
        let subagentsExpanded = false;
        let termBlockOref: string | undefined;
        if (termBlockId) {
            termBlockOref = WOS.makeORef("block", termBlockId);
            const agentStatus = get(getAgentStatusAtom(termBlockOref));
            if (agentStatus?.state) {
                status = agentStatus.state as SessionStatus;
                detail = agentStatus.detail;
            }
            subagents = get(getSubagentsAtom(termBlockOref));
            subagentsExpanded = subagentExpanded(subagents, get(getSubagentExpandAtom(termBlockOref)));
        }
```

- [ ] **Step 3: Pass the new fields into `SessionInput`**

In the returned object (`:60-70`), add the three fields after `detail` (the rollup happens inside `buildSessionViewModel`/`toRow`, so pass the raw parent `status`):

```ts
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            pinned: meta["session:pinned"] === true,
            cwd,
            serviceLabel: (cwd && labelMap.get(cwd)) || cwdToServiceLabel(cwd),
            status,
            detail,
            subagents,
            subagentsExpanded,
            termBlockOref,
            active: tabId === activeId,
        };
```

- [ ] **Step 4: Typecheck + full sidebar suite**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run frontend/app/tab/sessionsidebar` → all green (view-model still pure; the atom feeds it real subagents).

- [ ] **Step 5: Checkpoint**

The view-model atom attaches each session's live subagent list + effective expand state. No commit.

---

## Task 6: Frontend — `SubagentRow` component + chevron/count on `SessionRow` (TDD render)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx`
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.test.tsx`

- [ ] **Step 1: Write the failing render tests (append to `sessionrow.test.tsx`)**

Update the import (`:3`) to add `SubagentRow`:

```ts
import { SessionGroup, SessionRow, STATUS_COLOR, SUBAGENT_MARKER_COLOR, SubagentRow } from "./sessionrow";
```

Add these to the existing `SessionRow` describe (after the detail cases, `:43`):

```ts
    it("shows a subagent count and a chevron when there are subagents", () => {
        const html = render({ subagentCount: 2, expanded: false });
        expect(html).toContain("2");
        expect(html).toContain("fa-chevron-right");
    });
    it("shows a chevron-down when expanded", () => {
        expect(render({ subagentCount: 1, expanded: true })).toContain("fa-chevron-down");
    });
    it("omits the subagent chevron when there are none", () => {
        const html = render({ subagentCount: 0 });
        expect(html).not.toContain("fa-chevron-right");
        expect(html).not.toContain("fa-chevron-down");
    });
```

Add a new describe at the end of the file:

```ts
function renderSub(props: Partial<Parameters<typeof SubagentRow>[0]> = {}): string {
    return renderToStaticMarkup(<SubagentRow type="Explore" state="working" last={false} {...props} />);
}

describe("SubagentRow", () => {
    it("renders the subagent type", () => {
        expect(renderSub({ type: "general-purpose" })).toContain("general-purpose");
    });
    it("colors the marker by state", () => {
        expect(renderSub({ state: "working" })).toContain(SUBAGENT_MARKER_COLOR.working);
        expect(renderSub({ state: "success" })).toContain(SUBAGENT_MARKER_COLOR.success);
        expect(renderSub({ state: "failure" })).toContain(SUBAGENT_MARKER_COLOR.failure);
    });
    it("uses a tee connector for a non-last child and an elbow for the last", () => {
        expect(renderSub({ last: false })).toContain("├─");
        expect(renderSub({ last: true })).toContain("└─");
    });
    it("sets a title for hover/truncation", () => {
        expect(renderSub({ type: "a-very-long-subagent-type-name" })).toContain('title="a-very-long-subagent-type-name"');
    });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: FAIL — `SubagentRow`/`SUBAGENT_MARKER_COLOR` not exported; `subagentCount`/`expanded` not props of `SessionRow`.

- [ ] **Step 3: Add the chevron + count to `SessionRow`**

In `frontend/app/tab/sessionsidebar/sessionrow.tsx`, add `SubagentState` to the type import (`:6`):

```ts
import type { SessionStatus, SubagentState } from "./sessionviewmodel";
```

Add `subagentCount`/`expanded`/`onToggleExpand` to `SessionRowProps` (after `detail?: string;`, `:21`):

```ts
    subagentCount?: number;
    expanded?: boolean;
    onToggleExpand?: () => void;
```

Replace the `SessionRow` function (`:26-62`) with the version that prepends a fixed-width chevron slot (so dots stay aligned across rows) and adds a count pill before the thumbtack:

```tsx
export function SessionRow({
    label,
    status,
    active,
    blocked,
    pinned,
    detail,
    subagentCount = 0,
    expanded = false,
    onToggleExpand,
    onSelect,
    onTogglePin,
}: SessionRowProps) {
    return (
        <div
            className={cn(
                "session-row group flex min-h-8 w-full cursor-pointer items-center gap-2 border-l-2 border-transparent py-1 pl-2 pr-1.5",
                active && "session-row--active border-l-[#429dff] bg-[rgba(66,157,255,0.08)]",
                blocked && "session-row--blocked border-l-[#d29922] bg-[rgba(210,153,34,0.08)]"
            )}
            onClick={onSelect}
        >
            {subagentCount > 0 ? (
                <i
                    className={makeIconClass(expanded ? "chevron-down" : "chevron-right", true) + " w-[9px] text-[9px] text-secondary"}
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpand?.();
                    }}
                />
            ) : (
                <span className="w-[9px]" />
            )}
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
            {subagentCount > 0 && (
                <span className="rounded bg-[rgba(255,255,255,0.08)] px-1 text-[10px] tabular-nums text-secondary">
                    {subagentCount}
                </span>
            )}
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

- [ ] **Step 4: Add the `SubagentRow` component + marker maps**

In `sessionrow.tsx`, after the `STATUS_COLOR` const (`:13`), add the subagent marker maps:

```ts
// Hollow/check/cross markers — a different glyph shape than the session's filled dot, so a
// subagent never reads as a peer process (spec §6).
export const SUBAGENT_MARKER: Record<SubagentState, string> = {
    working: "◦",
    success: "✓",
    failure: "✗",
};
export const SUBAGENT_MARKER_COLOR: Record<SubagentState, string> = {
    working: "#7d8590",
    success: "#3fb950",
    failure: "#f85149",
};
```

Add the component (after `SessionRow`, before `SessionGroup`):

```tsx
interface SubagentRowProps {
    type: string;
    state: SubagentState;
    last: boolean;
}

export function SubagentRow({ type, state, last }: SubagentRowProps) {
    return (
        <div className="flex min-h-6 w-full items-center gap-1.5 py-0.5 pl-6 pr-1.5 text-[13px] text-secondary">
            <span className="select-none font-mono text-[11px] opacity-50">{last ? "└─" : "├─"}</span>
            <span className="font-mono text-[11px] leading-none" style={{ color: SUBAGENT_MARKER_COLOR[state] }}>
                {SUBAGENT_MARKER[state]}
            </span>
            <span className="truncate" title={type}>
                {type}
            </span>
        </div>
    );
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: PASS — all `SessionRow` (incl. chevron/count), `SubagentRow`, and `SessionGroup` cases green.

- [ ] **Step 6: Checkpoint**

`SessionRow` shows a chevron + count when it has subagents; `SubagentRow` renders the connector + marker-by-state + truncated type. No commit.

---

## Task 7: Frontend — render the subagent children in the sidebar

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

> The pinned and group sections both map rows. Extract a single local `SessionRowTree` component that renders a `SessionRow` followed by its `SubagentRow` children when expanded, and use it in both places (DRY). It is a non-exported local component, so React Fast Refresh is unaffected (the Phase 2 A0 concern was about exporting a non-component, not local helpers).

- [ ] **Step 1: Update imports**

In `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`, replace the row + model imports (`:10-12`):

```tsx
import { SessionGroup, SessionRow } from "./sessionrow";
import { collapsedGroupsAtom, sessionCwdsAtom, sessionSidebarViewModelAtom, setCollapsedGroups, togglePin } from "./sessionsidebarmodel";
import { aggregateStatus, toggleCollapsed } from "./sessionviewmodel";
```

with:

```tsx
import { SessionGroup, SessionRow, SubagentRow } from "./sessionrow";
import { toggleSubagentExpand } from "./agentstatusstore";
import { collapsedGroupsAtom, sessionCwdsAtom, sessionSidebarViewModelAtom, setCollapsedGroups, togglePin } from "./sessionsidebarmodel";
import { aggregateStatus, toggleCollapsed, type SessionRowVM } from "./sessionviewmodel";
```

- [ ] **Step 2: Add the `SessionRowTree` local component**

In `sessionsidebar.tsx`, after the `PINNED_LABEL` const (`:14`), add:

```tsx
function SessionRowTree({ row }: { row: SessionRowVM }) {
    return (
        <>
            <SessionRow
                label={row.label}
                status={row.status}
                active={row.active}
                blocked={row.blocked}
                pinned={row.pinned}
                detail={row.detail}
                subagentCount={row.subagents.length}
                expanded={row.subagentsExpanded}
                onToggleExpand={() => toggleSubagentExpand(row.termBlockOref, row.subagentsExpanded)}
                onSelect={() => setActiveTab(row.tabId)}
                onTogglePin={() => togglePin(row.tabId, row.pinned)}
            />
            {row.subagentsExpanded &&
                row.subagents.map((sa, i) => (
                    <SubagentRow key={sa.id} type={sa.type} state={sa.state} last={i === row.subagents.length - 1} />
                ))}
        </>
    );
}
```

- [ ] **Step 3: Use `SessionRowTree` in both sections**

Replace the pinned-rows map (`:56-68`):

```tsx
                    {vm.pinned.map((r) => (
                        <SessionRow
                            key={r.tabId}
                            label={r.label}
                            status={r.status}
                            active={r.active}
                            blocked={r.blocked}
                            pinned={r.pinned}
                            detail={r.detail}
                            onSelect={() => setActiveTab(r.tabId)}
                            onTogglePin={() => togglePin(r.tabId, r.pinned)}
                        />
                    ))}
```

with:

```tsx
                    {vm.pinned.map((r) => (
                        <SessionRowTree key={r.tabId} row={r} />
                    ))}
```

Replace the group-rows map (`:81-93`):

```tsx
                    {g.sessions.map((r) => (
                        <SessionRow
                            key={r.tabId}
                            label={r.label}
                            status={r.status}
                            active={r.active}
                            blocked={r.blocked}
                            pinned={r.pinned}
                            detail={r.detail}
                            onSelect={() => setActiveTab(r.tabId)}
                            onTogglePin={() => togglePin(r.tabId, r.pinned)}
                        />
                    ))}
```

with:

```tsx
                    {g.sessions.map((r) => (
                        <SessionRowTree key={r.tabId} row={r} />
                    ))}
```

- [ ] **Step 4: Typecheck + full sidebar suite**

Run: `npx tsc --noEmit` → clean (`SessionRow` is now referenced only inside `SessionRowTree`; confirm no "declared but never used" — it is still imported and used).
Run: `npx vitest run frontend/app/tab/sessionsidebar` → all green.

- [ ] **Step 5: Checkpoint**

Pinned and group rows render via `SessionRowTree`; expanded rows show their subagent children; the chevron toggles the per-block override. No commit.

---

## Task 8: Verification

**Files:** none (verification only)

- [ ] **Step 1:** `npx vitest run frontend/app/tab/sessionsidebar` → all green (Phase 1/2/3 cases + the new `reduceSubagents`/`rollUpStatus`/`subagentExpanded`/view-model-attach + `SubagentRow`/chevron cases).
- [ ] **Step 2:** `npx tsc --noEmit` → no new errors.
- [ ] **Step 3:** `npx eslint frontend/app/tab/sessionsidebar/**/*.{ts,tsx}` → clean.
- [ ] **Step 4: Live — lifecycle (Task 0 reporter active, `app:tabbar=left`):** in a session, ask the agent to spawn 2+ parallel subagents. Confirm: the session row auto-expands and shows a `◦` working child per subagent with `├─`/`└─` connectors and a count badge; the row's dot rolls up to green (working) while children run; each child flips to `✓`/`✗` on its `SubagentStop` and lingers; on the agent's `Stop` the tree collapses and clears.
- [ ] **Step 5: Live — amber dominance:** trigger a permission prompt in a session that also has a working subagent; confirm the parent row stays **amber** (parent-blocked dominates the rollup), not green.
- [ ] **Step 6: Live — manual override:** while children are working (auto-expanded), click the chevron to collapse; confirm it stays collapsed until the next turn (`Stop` resets it). Confirm clicking the chevron does not switch the active tab (`stopPropagation`).
- [ ] **Step 7: Live — collapsed group aggregate:** put a session with a working subagent into a collapsed service group; confirm the group's aggregate dot reflects working (green) via the rolled-up row status.
- [ ] **Step 8: Live — Codex (if applicable):** confirm a Codex session without subagent hooks simply shows no chevron/children (graceful degradation), and a Codex session that does emit start/stop renders the tree.
- [ ] **Step 9: Checkpoint** — Subagent visibility complete. No commit (await batched approval).

---

## Self-Review

**1. Spec coverage:**
- §1/§2 one concept (inline subagent tree, lifecycle only) → Tasks 3–7. ✅
- §3 decisions: source = parent `SubagentStart`/`SubagentStop` (Task 0); correlation by `agent_id` (reducer keys by id, Task 3); row label = `agent_type` (SubagentRow, Task 6); states `working`→`success`/`failure` (Task 3 reducer); inline tree (Task 7); connectors `├─`/`└─` + hollow `◦`/`✓`/`✗` vs filled `●` (Task 6); auto-expand on spawn, collapse+clear on Stop (Task 3 `subagentExpanded` + Task 4 idle-clear); transport overloads `Event_AgentStatus` with optional `subagent` (Task 1); frontend reducer keyed by block id (Task 4). ✅
- §4 boundary (only lifecycle observable; nested subagents not parent-observable) → "Decisions locked" note + no nested-handling code. ✅
- §5 architecture (reporter → `wsh agentstatus` subagent flags → `Event_AgentStatus{subagent}` → reducer → `subagentsByBlock` → view-model attach → row) → Tasks 0,1,2,4,5,7. `SubagentVM = {id,type,state}` and the delta shape match §5. Parent rollup (any working child ⇒ ≥working; parent amber dominates) → `rollUpStatus` (Task 3). Auto-expand `manualOverride ?? hasWorking` with reset on idle → `subagentExpanded` (Task 3) + idle reset (Task 4). ✅
- §6 UI (parent chevron + count, dot rolls up; child connector/marker/label/indent; lifecycle visuals) → Tasks 6,7. ✅
- §7 risks/decisions: version dependence + Codex parity verified in Task 0 spike + Task 8 Step 8; parent-green-while-foreground-subagent-blocked = accepted v1 gap (not coded); nested → flatten (locked decision, no code); task-description → out (deferred). ✅
- §8 phasing: Phase 0 spike + Phase 2b core covered; Phase 3 polish explicitly deferred in the header. ✅
- §9 testing: reducer pure + table-driven (start/stop/interleaved-parallel) → Task 3; auto-expand derivation pure → Task 3; view-model attach + rolled-up dot → Task 3; `SubagentRow` render (connector/marker/truncation) → Task 6. **Gap flagged:** §9 also lists "Reporter mapping = pure function." The reporter is external/uncommitted (established Phase 2/3 fork decision), so it is covered as a documented mapping (Task 0) rather than a committed unit-tested module — consistent with prior phases; committing a tested reporter remains deferred.

**2. Placeholder scan:** No "TBD"/"handle later"/"similar to". Every code step shows complete code. The only non-code judgement steps are Task 0 (explicitly an external, documented reporter change) and the live-verification steps in Task 8.

**3. Type consistency:**
- Go `AgentSubagentDelta{Action,Id,Type,Status}` (Task 1) → generated global `AgentSubagentDelta{action,id?,type?,status?}` consumed in Task 4 (`data.subagent`), mapped to the pure `SubagentDelta{action:"start"|"stop", id, type, status?:"success"|"failure"}` (Task 3) before `reduceSubagents`. Distinct names (generated `AgentSubagentDelta` vs pure `SubagentDelta`) avoid an ambient/module collision.
- `SubagentVM{id,type,state:SubagentState}` defined in Task 3, produced by `reduceSubagents`/`getSubagentsAtom` (Tasks 3,4), consumed by the atom (Task 5) and `SubagentRow`/`SessionRowTree` (Tasks 6,7). `SubagentState = "working"|"success"|"failure"` used identically in the reducer, the marker maps (`SUBAGENT_MARKER`/`SUBAGENT_MARKER_COLOR`), and `SubagentRow`.
- `reduceSubagents(list, delta) → SubagentVM[]`, `rollUpStatus(parent, subagents) → SessionStatus`, `subagentExpanded(subagents, override?) → boolean` — signatures defined in Task 3, consumed unchanged by Task 4 (`reduceSubagents`) and Task 5 (`subagentExpanded`); `rollUpStatus` is internal to `toRow`. Names identical across tasks.
- `getSubagentsAtom`/`getSubagentExpandAtom`/`toggleSubagentExpand` live in `agentstatusstore.ts` (Task 4); imported by `sessionsidebarmodel.ts` (Task 5, the two getters) and `sessionsidebar.tsx` (Task 7, the toggle). `SessionRowVM` gains required `subagents`/`subagentsExpanded` + optional `termBlockOref` (Task 3), always supplied by the atom (Task 5) and consumed by `SessionRowTree` (Task 7). No drift.
- `SessionRow` new props `subagentCount?`/`expanded?`/`onToggleExpand?` (Task 6) supplied by `SessionRowTree` (Task 7). `toggleSubagentExpand(oref, currentlyExpanded)` — Task 4 signature matches the Task 7 call `toggleSubagentExpand(row.termBlockOref, row.subagentsExpanded)`.
- Persist: Go `Persist:0` (delta) vs `Persist:1` (state) in Task 2 aligns with the verified `wps` semantics; the frontend never relies on delta replay (idle-clear in Task 4 resets ephemeral state).

---

## Execution Handoff

Strict dependency order: **Task 1 → Task 2** (command needs the payload type). **Task 3** is pure and can run any time but gates **Task 4 → Task 5** (store + atom) and **Task 6 → Task 7** (row + sidebar). Task 5 and Task 7 are the two "live" endpoints; both must land before Task 8's live checks. **Task 0** (reporter) is external and only required for the Task 8 live verification — do it last, or in parallel with the code tasks. A natural sequence: 1, 2, 3, 4, 5, 6, 7, 0, 8.
