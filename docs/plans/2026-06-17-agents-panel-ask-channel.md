# Agents Panel — Ask-Human Answer Channel (Plan 3b) Implementation Plan

> **Superseded by Plan 3c** (`docs/plans/2026-06-17-agents-panel-organic-ask-hook.md`) — the blocking `ask_human` MCP tool was replaced by a PreToolUse hook on `AskUserQuestion`. Retained as design history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a coding agent ask a structured question (`{question, options?, recommendation?}`) that surfaces in its Agents-panel `AskCard`, the user answers inline, and the answer routes back to **unblock the agent without touching the terminal** — deterministic, zero orchestrator tokens.

**Architecture:** A `wsh` subcommand runs as a long-lived MCP stdio server exposing one tool, `ask_human`. On a call it resolves its block oref (the same `RpcContext.BlockId` the status reporter keys on) and invokes a new blocking `AskHumanCommand` RPC. The backend registers the pending ask in an in-memory registry keyed by `askId`, publishes a per-block `Event_AgentAsk`, then blocks until the UI calls `AnswerAgentCommand`. The frontend mirrors the existing `agentstatusstore` pattern: a per-block ask atom feeds `AgentVM.ask` in the live roster (driving the `asking` state), and the already-built `AskCard` renders the question + pills + reply; its `onAnswer` routes the answer by `askId`.

**Tech Stack:** Go (`wshrpc` RPC + codegen, `wps` events, cobra `wsh` command, a hand-rolled minimal MCP stdio JSON-RPC loop — no MCP SDK in the repo), TypeScript/React, Jotai, vitest, `go test`.

**Source of truth:** spec `docs/specs/2026-06-17-ask-human-channel-design.md` (Approach A, decided with the user 2026-06-17). Builds on Plan 3a (`docs/plans/2026-06-17-agents-panel-live-roster.md`), which already ships `AgentAsk`, `AgentVM.ask`, and the `AskCard`'s conditional pills/reply branch.

**Conventions for this plan:**
- **No `git commit` steps.** Per the repo owner's strict no-auto-commit rule, each task ends with a **Checkpoint** (tests + typecheck/VSCode-clean). Commits are batched and made only with explicit approval. (Deliberately overrides the writing-plans skill's per-task commits — user instructions win, matching the Phase 2/3 plans.)
- **TDD where it pays:** the backend ask-registry (`go test`) and the pure frontend `withAsk` (vitest) get failing-test-first. RPC wiring, the MCP stdio loop, the store subscription, and component wiring are verified by `tsc`/VSCode-problems + the Task 9 live walkthrough (matching how Phase 1–3a verified wiring).
- **Go rules:** string constants (no enum types); consts at top of file; `lock.Lock(); defer lock.Unlock()` via helper funcs; `Printf` not `Println`; **never run `go build`** (VSCode problems indicate compile errors); `go test` for unit tests is fine, **run from the project root** (do not `cd` into the package).
- **Codegen:** never hand-edit `frontend/types/gotypes.d.ts` or `wshclientapi.ts`. After editing `wshrpctypes.go` / event types, run `task generate`.
- **TS rules:** 4-space indent; `@/...` across dirs, `./x` within dir; named exports; `== null` / `!= null`; early returns; `useAtomValue`/`useAtom` are hooks (top of component only).

**Verified facts this plan relies on (source-inspected 2026-06-17):**
- **CC 2.1.179 supports the blocking-MCP-tool pattern** (verified against the installed binary; see the spec §2). The agent runs `--dangerously-skip-permissions`, so the `ask_human` tool is auto-approved (spec: permissions out of scope).
- `wsh agentstatus` resolves its block via `resolveBlockArg()` → block oref, and publishes `wps.WaveEvent{Event: Event_AgentStatus, Scopes: [oref], Persist: 1, Data: baseds.AgentStatusData}` (`cmd/wsh/cmd/wshcmd-agentstatus.go:66,92-99`). MCP servers are spawned by Claude Code as child processes of the agent's shell and inherit its `WAVETERM_*` env, so `wsh ask-server` keys on the same block.
- Frontend per-block subscription pattern: `waveEventSubscribeSingle({eventType, handler})` from `@/app/store/wps`, with a `Map<oref, PrimitiveAtom>` (`frontend/app/tab/sessionsidebar/agentstatusstore.ts:13-22,77-117`). Mounted from a `useEffect` in `sessionsidebar.tsx:131-133`.
- `wshrpc` default timeout is **5000ms** and applies to `Timeout <= 0`; the value also bounds the server handler's ctx (`pkg/wshutil/wshrpc.go:28,334-338,770-794`). A blocking ask therefore MUST pass a large explicit `Timeout`.
- `baseds.AgentStatusData` (the WPS payload, tsgen-exposed via `WaveEventDataTypes`) lives in `pkg/baseds/baseds.go:61`; states `AgentState_Working/Waiting/Idle` at `:33-35`.
- `liveAgentBaseAtom` builds each `AgentVM` from a sidebar row + `getAgentStatusAtom(row.termBlockOref)`; rows carry `termBlockOref`, `tabId`, `label`, `status`, `detail`, `model` (`frontend/app/view/agents/liveagents.ts`, `sessionviewmodel.ts:71-84`). 3a maps `waiting`→`asking` but never sets `ask`.
- `AgentAsk { question, options?, recommendation? }` and `AgentVM.ask?` already exist (`frontend/app/view/agents/agentsviewmodel.ts:12-16,28`). `AskCard` renders the inline question + option pills + reply when `agent.ask` is present, else an **Open session to answer** peek button; `onAnswer?` is already optional (`askcard.tsx`, 3a Task 6).
- `fireAndForget` is imported from `@/util/util`; `RpcApi` from `@/app/store/wshclientapi`; `TabRpcClient` from `@/app/store/wshrpcutil`.

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `pkg/agentask/agentask.go` | 1 | **CREATE.** In-memory pending-ask registry (register / resolve / drop), channel-based. |
| `pkg/agentask/agentask_test.go` | 1 | **CREATE.** Unit tests for the registry. |
| `pkg/baseds/baseds.go` | 2 | **MODIFY.** Add `AgentAskData` (the `Event_AgentAsk` payload). |
| `pkg/wps/wpstypes.go` | 2 | **MODIFY.** Add `Event_AgentAsk` constant + `AllEvents` entry. |
| `pkg/tsgen/tsgenevent.go` | 2 | **MODIFY.** Map `Event_AgentAsk` → `baseds.AgentAskData` in `WaveEventDataTypes`. |
| `pkg/wshrpc/wshrpctypes.go` | 3 | **MODIFY.** Add `AskHumanCommand` / `AnswerAgentCommand` + their data types. |
| `pkg/wshrpc/wshserver/wshserver.go` | 3 | **MODIFY.** Implement both commands. |
| `cmd/wsh/cmd/wshcmd-askserver.go` | 4 | **CREATE.** `wsh ask-server` — the MCP stdio server exposing `ask_human`. |
| `frontend/app/view/agents/agentaskstore.ts` | 5 | **CREATE.** Per-block ask atom + `agent:ask` subscription. |
| `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` | 5 | **MODIFY.** Mount `setupAgentAskSubscription()` beside the status one. |
| `frontend/app/view/agents/agentsviewmodel.ts` | 6 | **MODIFY.** Add `askId?` to `AgentAsk`; add pure `withAsk`. |
| `frontend/app/view/agents/agentsviewmodel.test.ts` | 6 | **MODIFY.** Tests for `withAsk`. |
| `frontend/app/view/agents/liveagents.ts` | 6 | **MODIFY.** Apply `withAsk` per row using the ask atom. |
| `frontend/app/view/agents/agents.tsx` | 7 | **MODIFY.** Provide an `answer` handler calling `AnswerAgentCommand`. |
| `frontend/app/view/agents/askcard.tsx` | 7 | **MODIFY.** Route `onAnswer` by `agent.ask.askId`, not `agent.id`. |
| `docs/agents/ask-human-setup.md` | 8 | **CREATE.** Opt-in `.mcp.json` + CLAUDE.md/output-style convention snippet. |
| `docs/docs/wsh-reference.mdx` | 8 | **MODIFY.** Document `wsh ask-server`. |

**Execution order:** 1 → 2 → 3 → 4 (4 calls 3's command); then 5 → 6 → 7 (frontend, needs 2+3's generated types); 8 and 9 last. `task generate` runs at the end of Task 2 and Task 3.

---

## Task 1: Backend ask-registry (TDD)

**Files:**
- Create: `pkg/agentask/agentask.go`
- Create: `pkg/agentask/agentask_test.go`

- [ ] **Step 1: Write the failing test**

Create `pkg/agentask/agentask_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import "testing"

func TestResolveDeliversAnswer(t *testing.T) {
	r := MakeRegistry()
	ch := r.Register("ask-1")
	if ok := r.Resolve("ask-1", "Yes"); !ok {
		t.Fatalf("Resolve returned false for a registered ask")
	}
	if got := <-ch; got != "Yes" {
		t.Fatalf("got %q, want %q", got, "Yes")
	}
}

func TestResolveUnknownIsNoOp(t *testing.T) {
	r := MakeRegistry()
	if ok := r.Resolve("nope", "x"); ok {
		t.Fatalf("Resolve returned true for an unknown ask")
	}
}

func TestDropPreventsResolve(t *testing.T) {
	r := MakeRegistry()
	r.Register("ask-2")
	r.Drop("ask-2")
	if ok := r.Resolve("ask-2", "x"); ok {
		t.Fatalf("Resolve returned true after Drop")
	}
}

func TestResolveTwiceSecondIsNoOp(t *testing.T) {
	r := MakeRegistry()
	r.Register("ask-3")
	r.Resolve("ask-3", "a")
	if ok := r.Resolve("ask-3", "b"); ok {
		t.Fatalf("second Resolve returned true")
	}
}
```

- [ ] **Step 2: Run the test, verify it fails**

Run (from project root): `go test ./pkg/agentask/`
Expected: FAIL — `MakeRegistry` / `Register` / `Resolve` / `Drop` undefined.

- [ ] **Step 3: Implement the registry**

Create `pkg/agentask/agentask.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentask holds the in-memory registry of pending ask_human requests.
// An AskHumanCommand handler registers an askId and blocks on the returned channel;
// AnswerAgentCommand resolves it. Keyed by askId so a session can be re-asked safely.
package agentask

import "sync"

type Registry struct {
	lock    sync.Mutex
	pending map[string]chan string
}

func MakeRegistry() *Registry {
	return &Registry{pending: make(map[string]chan string)}
}

// GlobalRegistry is the process-wide instance used by the wsh server handlers.
var GlobalRegistry = MakeRegistry()

// Register adds a pending ask and returns the channel its answer will arrive on.
// The channel is buffered(1) so Resolve never blocks even if the waiter already left.
func (r *Registry) Register(askId string) chan string {
	r.lock.Lock()
	defer r.lock.Unlock()
	ch := make(chan string, 1)
	r.pending[askId] = ch
	return ch
}

// Resolve delivers an answer to a pending ask. Returns false if the askId is unknown
// (already resolved, dropped, or never registered) — the caller treats that as a no-op.
func (r *Registry) Resolve(askId string, answer string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	ch := r.pending[askId]
	if ch == nil {
		return false
	}
	delete(r.pending, askId)
	ch <- answer
	return true
}

// Drop removes a pending ask without answering (timeout / agent gone).
func (r *Registry) Drop(askId string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.pending, askId)
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run (from project root): `go test ./pkg/agentask/`
Expected: PASS — all four cases.

- [ ] **Step 5: Checkpoint**

Registry with register/resolve/drop is implemented and green; VSCode shows no Go problems. No commit.

---

## Task 2: WPS `Event_AgentAsk` + `AgentAskData` payload

**Files:**
- Modify: `pkg/baseds/baseds.go`
- Modify: `pkg/wps/wpstypes.go`
- Modify: `pkg/tsgen/tsgenevent.go`
- Generated: `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add the `AgentAskData` payload type**

In `pkg/baseds/baseds.go`, after the `AgentStatusData` struct (ends at `:61`+; place this immediately after its closing brace), add:

```go
// AgentAskData is the payload of Event_AgentAsk. ORef is the block the ask applies to;
// AskId keys the pending request in the agentask registry (for routing the answer back).
// A Cleared event (same ORef+AskId, Cleared=true, no question) removes a resolved/cancelled ask.
type AgentAskData struct {
	ORef           string   `json:"oref"`
	AskId          string   `json:"askid"`
	Question       string   `json:"question,omitempty"`
	Options        []string `json:"options,omitempty"`
	Recommendation string   `json:"recommendation,omitempty"`
	Ts             int64    `json:"ts,omitempty"` // UnixMilli the ask was raised (for the "asking · 4m" age)
	Cleared        bool     `json:"cleared,omitempty"`
}
```

- [ ] **Step 2: Add the event constant + `AllEvents` entry**

In `pkg/wps/wpstypes.go`, add to the event const block (next to `Event_AgentStatus`):

```go
	Event_AgentAsk = "agent:ask" // type: baseds.AgentAskData
```

And add `Event_AgentAsk` to the `AllEvents` slice (next to `Event_AgentStatus`).

- [ ] **Step 3: Register the data type for codegen**

In `pkg/tsgen/tsgenevent.go`, add to `WaveEventDataTypes` (next to the `Event_AgentStatus` entry; mirror its exact form):

```go
	wps.Event_AgentAsk: reflect.TypeOf(baseds.AgentAskData{}),
```

(If `baseds` is not yet imported in that file, add the import — but it is already imported for the `Event_AgentStatus` mapping.)

- [ ] **Step 4: Generate types**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` gains an `AgentAskData` type with `oref`, `askid`, `question?`, `options?`, `recommendation?`, `ts?`, `cleared?`.

- [ ] **Step 5: Checkpoint**

`Event_AgentAsk` + `AgentAskData` exist and are generated to TS; VSCode shows no Go problems; `gotypes.d.ts` has `AgentAskData` (read it; do not edit). No commit.

---

## Task 3: `AskHumanCommand` + `AnswerAgentCommand` RPCs

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Generated: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`

- [ ] **Step 1: Add the interface methods + data types**

In `pkg/wshrpc/wshrpctypes.go`, add to the `WshRpcInterface`:

```go
	AskHumanCommand(ctx context.Context, data CommandAskHumanData) (AskHumanRtnData, error)
	AnswerAgentCommand(ctx context.Context, data CommandAnswerAgentData) error
```

And add the types (near the other `Command*Data` types):

```go
type CommandAskHumanData struct {
	ORef           string   `json:"oref"`
	Question       string   `json:"question"`
	Options        []string `json:"options,omitempty"`
	Recommendation string   `json:"recommendation,omitempty"`
}

type AskHumanRtnData struct {
	Answer string `json:"answer"`
}

type CommandAnswerAgentData struct {
	AskId  string `json:"askid"`
	Answer string `json:"answer"`
}
```

- [ ] **Step 2: Generate bindings**

Run: `task generate`
Expected: `wshclientapi.ts` gains `AskHumanCommand` and `AnswerAgentCommand`; `gotypes.d.ts` gains the three types. No errors.

- [ ] **Step 3: Implement the handlers**

In `pkg/wshrpc/wshserver/wshserver.go`, add (imports needed: `github.com/google/uuid`, `github.com/wavetermdev/waveterm/pkg/agentask`, `github.com/wavetermdev/waveterm/pkg/baseds`, `github.com/wavetermdev/waveterm/pkg/wps` — match the file's existing import style; most are already imported):

```go
// AskHumanCommand registers a pending ask, publishes it to the block's AskCard, and blocks
// until the UI answers (AnswerAgentCommand) or the call times out / is cancelled. The caller
// (wsh ask-server) passes a large RpcOpts.Timeout; on timeout the agent may re-call.
func (ws *WshServer) AskHumanCommand(ctx context.Context, data wshrpc.CommandAskHumanData) (wshrpc.AskHumanRtnData, error) {
	if data.ORef == "" || data.Question == "" {
		return wshrpc.AskHumanRtnData{}, fmt.Errorf("oref and question are required")
	}
	askId := uuid.New().String()
	ch := agentask.GlobalRegistry.Register(askId)
	defer agentask.GlobalRegistry.Drop(askId)

	publishAgentAsk(baseds.AgentAskData{
		ORef:           data.ORef,
		AskId:          askId,
		Question:       data.Question,
		Options:        data.Options,
		Recommendation: data.Recommendation,
		Ts:             time.Now().UnixMilli(),
	})
	// clear the card when we stop waiting (answered, timed out, or cancelled)
	defer publishAgentAsk(baseds.AgentAskData{ORef: data.ORef, AskId: askId, Cleared: true})

	select {
	case answer := <-ch:
		return wshrpc.AskHumanRtnData{Answer: answer}, nil
	case <-ctx.Done():
		return wshrpc.AskHumanRtnData{}, ctx.Err()
	}
}

// AnswerAgentCommand resolves a pending ask. An unknown askId is a no-op (already resolved
// or the agent moved on), not an error.
func (ws *WshServer) AnswerAgentCommand(ctx context.Context, data wshrpc.CommandAnswerAgentData) error {
	if data.AskId == "" {
		return fmt.Errorf("askid is required")
	}
	agentask.GlobalRegistry.Resolve(data.AskId, data.Answer)
	return nil
}

func publishAgentAsk(data baseds.AgentAskData) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:   wps.Event_AgentAsk,
		Scopes:  []string{data.ORef},
		Persist: 1,
		Data:    data,
	})
}
```

- [ ] **Step 4: Verify it compiles**

Confirm VSCode shows no Go problems in `wshserver.go` / `wshrpctypes.go`. (Per repo rules, no `go build`.)

- [ ] **Step 5: Checkpoint**

Both RPCs exist, generate cleanly, and the handlers register/publish/block/resolve. No commit.

---

## Task 4: `wsh ask-server` — the MCP stdio server

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-askserver.go`

> The MCP stdio transport is newline-delimited JSON-RPC 2.0 on stdin/stdout. We implement the minimal surface Claude Code uses: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`. `os.Stdout.Write` is unbuffered in Go, so `fmt.Printf` flushes each response immediately.

- [ ] **Step 1: Write the command**

Create `cmd/wsh/cmd/wshcmd-askserver.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// 1 hour: a human may take a while. On timeout the tool returns an error result and the
// agent can call ask_human again (a noted v1 limitation; a streaming RPC would remove it).
const AskHumanTimeoutMs = 3600000

const mcpProtocolVersion = "2025-06-18"

var askServerCmd = &cobra.Command{
	Use:                   "ask-server",
	Short:                 "run the ask_human MCP server (registered with Claude Code via .mcp.json)",
	Args:                  cobra.NoArgs,
	RunE:                  askServerRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
	Hidden:                true,
}

func init() {
	rootCmd.AddCommand(askServerCmd)
}

type jsonRpcRequest struct {
	JsonRpc string          `json:"jsonrpc"`
	Id      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonRpcResponse struct {
	JsonRpc string          `json:"jsonrpc"`
	Id      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *jsonRpcError   `json:"error,omitempty"`
}

type jsonRpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func askServerRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("ask-server", rtnErr == nil)
	}()

	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %w", err)
	}
	orefStr := oref.String()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var req jsonRpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}
		resp := handleMcpRequest(orefStr, &req)
		if resp == nil {
			continue
		}
		out, err := json.Marshal(resp)
		if err != nil {
			continue
		}
		fmt.Printf("%s\n", out)
	}
	return scanner.Err()
}

func handleMcpRequest(orefStr string, req *jsonRpcRequest) *jsonRpcResponse {
	switch req.Method {
	case "initialize":
		return &jsonRpcResponse{JsonRpc: "2.0", Id: req.Id, Result: map[string]any{
			"protocolVersion": mcpProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "wave-ask", "version": "1.0.0"},
		}}
	case "notifications/initialized":
		return nil
	case "ping":
		return &jsonRpcResponse{JsonRpc: "2.0", Id: req.Id, Result: map[string]any{}}
	case "tools/list":
		return &jsonRpcResponse{JsonRpc: "2.0", Id: req.Id, Result: map[string]any{
			"tools": []any{askHumanToolDef()},
		}}
	case "tools/call":
		return handleToolCall(orefStr, req)
	default:
		if len(req.Id) == 0 {
			return nil // unknown notification
		}
		return &jsonRpcResponse{JsonRpc: "2.0", Id: req.Id, Error: &jsonRpcError{Code: -32601, Message: "method not found"}}
	}
}

func askHumanToolDef() map[string]any {
	return map[string]any{
		"name":        "ask_human",
		"description": "Ask the human operator for a decision and block until they answer in the Wave Agents panel. Use this whenever you need a decision from the user — do NOT just print a question and stop.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"question":       map[string]any{"type": "string", "description": "the decision to ask the human"},
				"options":        map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "optional answer choices shown as buttons"},
				"recommendation": map[string]any{"type": "string", "description": "your suggested answer, shown under the question"},
			},
			"required": []any{"question"},
		},
	}
}

func handleToolCall(orefStr string, req *jsonRpcRequest) *jsonRpcResponse {
	var params struct {
		Name      string `json:"name"`
		Arguments struct {
			Question       string   `json:"question"`
			Options        []string `json:"options"`
			Recommendation string   `json:"recommendation"`
		} `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return &jsonRpcResponse{JsonRpc: "2.0", Id: req.Id, Error: &jsonRpcError{Code: -32602, Message: "invalid params"}}
	}
	if params.Name != "ask_human" {
		return &jsonRpcResponse{JsonRpc: "2.0", Id: req.Id, Error: &jsonRpcError{Code: -32602, Message: "unknown tool: " + params.Name}}
	}
	rtn, err := wshclient.AskHumanCommand(RpcClient, wshrpc.CommandAskHumanData{
		ORef:           orefStr,
		Question:       params.Arguments.Question,
		Options:        params.Arguments.Options,
		Recommendation: params.Arguments.Recommendation,
	}, &wshrpc.RpcOpts{Timeout: AskHumanTimeoutMs})
	if err != nil {
		return &jsonRpcResponse{JsonRpc: "2.0", Id: req.Id, Result: toolTextResult("no answer received ("+err.Error()+"); call ask_human again to keep waiting", true)}
	}
	return &jsonRpcResponse{JsonRpc: "2.0", Id: req.Id, Result: toolTextResult(rtn.Answer, false)}
}

func toolTextResult(text string, isError bool) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}},
		"isError": isError,
	}
}
```

- [ ] **Step 2: Verify it compiles**

Confirm VSCode shows no Go problems in `wshcmd-askserver.go`. (No `go build`.)

- [ ] **Step 3: Checkpoint**

`wsh ask-server` implements the MCP stdio handshake + the `ask_human` tool, bridging to `AskHumanCommand`. No commit.

---

## Task 5: Frontend ask store + subscription

**Files:**
- Create: `frontend/app/view/agents/agentaskstore.ts`
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

- [ ] **Step 1: Create the per-block ask store**

Create `frontend/app/view/agents/agentaskstore.ts` (mirrors `agentstatusstore.ts`):

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";

// keyed by block ORef string ("block:<uuid>"); null = no pending ask
const agentAskAtoms = new Map<string, PrimitiveAtom<AgentAskData>>();

export function getAgentAskAtom(oref: string): PrimitiveAtom<AgentAskData> {
    let askAtom = agentAskAtoms.get(oref);
    if (!askAtom) {
        askAtom = atom(null) as PrimitiveAtom<AgentAskData>;
        agentAskAtoms.set(oref, askAtom);
    }
    return askAtom;
}

let subscribed = false;
export function setupAgentAskSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "agent:ask",
        handler: (event) => {
            const data = event.data as AgentAskData;
            if (data?.oref == null) {
                return;
            }
            globalStore.set(getAgentAskAtom(data.oref), data.cleared ? null : data);
        },
    });
}
```

- [ ] **Step 2: Mount the subscription**

In `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`, update the status-store import (line 12) to also import the ask setup:

```tsx
import { setupAgentStatusSubscription, toggleSubagentExpand } from "./agentstatusstore";
import { setupAgentAskSubscription } from "@/app/view/agents/agentaskstore";
```

And add the call inside the existing mount effect (currently `:131-133`):

```tsx
    useEffect(() => {
        setupAgentStatusSubscription();
        setupAgentAskSubscription();
    }, []);
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (`AgentAskData` is generated from Task 2; `waveEventSubscribeSingle` is the same util `agentstatusstore` uses.)

- [ ] **Step 4: Checkpoint**

`agent:ask` events land in a per-block atom; the subscription mounts with the status one. No commit.

---

## Task 6: `AgentAsk.askId` + pure `withAsk` + live merge (TDD)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Modify: `frontend/app/view/agents/agentsviewmodel.test.ts`
- Modify: `frontend/app/view/agents/liveagents.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/agentsviewmodel.test.ts`:

```ts
import { withAsk } from "./agentsviewmodel";

describe("withAsk", () => {
    const NOW = 1_000_000;
    const baseWorking = (): AgentVM => ({
        id: "tab-1",
        name: "waveterm",
        task: "",
        state: "working",
        activity: "go test ./…",
        activeMs: 5_000,
    });

    it("flips a working agent to asking and populates ask + blockedMs from ts", () => {
        const ask: AgentAskData = {
            oref: "block:abc",
            askid: "ask-1",
            question: "Guard the nil case?",
            options: ["Yes", "No"],
            recommendation: "Yes",
            ts: NOW - 60_000,
        };
        const vm = withAsk(baseWorking(), ask, NOW);
        expect(vm.state).toBe("asking");
        expect(vm.blockedMs).toBe(60_000);
        expect(vm.activeMs).toBeUndefined();
        expect(vm.ask).toEqual({ question: "Guard the nil case?", options: ["Yes", "No"], recommendation: "Yes", askId: "ask-1" });
    });

    it("returns the vm unchanged when ask is null or cleared", () => {
        expect(withAsk(baseWorking(), null, NOW)).toEqual(baseWorking());
        const cleared: AgentAskData = { oref: "block:abc", askid: "ask-1", cleared: true };
        expect(withAsk(baseWorking(), cleared, NOW)).toEqual(baseWorking());
    });
});
```

Add `AgentVM`/`AgentAskData` to the imports at the top of the test file if not already present (`AgentVM` is exported from `./agentsviewmodel`; `AgentAskData` is a global generated type — no import needed).

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `withAsk` not exported.

- [ ] **Step 3: Add `askId` to `AgentAsk` and implement `withAsk`**

In `frontend/app/view/agents/agentsviewmodel.ts`, extend `AgentAsk` (`:12-16`):

```ts
export interface AgentAsk {
    question: string;
    options?: string[]; // answer pills; absent => default Yes/No
    recommendation?: string; // shown under the question
    askId?: string; // routes the answer back via AnswerAgentCommand (Plan 3b)
}
```

Append the pure function (it imports no React/Wave runtime — keep the file pure):

```ts
/** Pure: overlay a pending ask onto an agent. A live ask makes the agent `asking` regardless of
 *  the reporter's status (a blocking ask_human call may still read as "working"); blockedMs is
 *  derived from now - ask.ts. A null/cleared ask leaves the agent untouched. */
export function withAsk(vm: AgentVM, ask: AgentAskData | null, now: number): AgentVM {
    if (ask == null || ask.cleared) {
        return vm;
    }
    return {
        ...vm,
        state: "asking",
        activeMs: undefined,
        blockedMs: ask.ts != null ? Math.max(0, now - ask.ts) : vm.blockedMs,
        ask: { question: ask.question, options: ask.options, recommendation: ask.recommendation, askId: ask.askid },
    };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply `withAsk` in the live roster**

In `frontend/app/view/agents/liveagents.ts`, add the imports:

```ts
import { getAgentAskAtom } from "./agentaskstore";
import { agentVMFromInput, askingCount, withAsk, type AgentEntry, type AgentVM } from "./agentsviewmodel";
```

(merge `withAsk` into the existing `./agentsviewmodel` import rather than adding a second line).

In `liveAgentBaseAtom`, after the `agents.push(agentVMFromInput(...))` is built, overlay the ask. Change the push so the built vm passes through `withAsk` using the per-block ask atom:

```ts
        const vm = agentVMFromInput(
            {
                id: row.tabId,
                name: row.label,
                status: row.status,
                detail: row.detail,
                model: row.model,
                ts: status.ts,
                transcriptPath: status.transcriptpath,
            },
            now
        );
        agents.push(withAsk(vm, get(getAgentAskAtom(row.termBlockOref)), now));
```

(`now` is the `const now = Date.now();` already at the top of `liveAgentBaseAtom`; reading `getAgentAskAtom(...)` inside the derived atom subscribes it to ask updates.)

- [ ] **Step 6: Typecheck + full agents suite**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run frontend/app/view/agents` → all green (3a tests + the new `withAsk` cases).

- [ ] **Step 7: Checkpoint**

A pending ask drives the `asking` state and populates `AgentVM.ask` (with `askId`) in the live roster; pure `withAsk` is tested. No commit.

---

## Task 7: Wire the answer back

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`
- Modify: `frontend/app/view/agents/askcard.tsx`

- [ ] **Step 1: Route `AskCard.onAnswer` by `askId`**

In `frontend/app/view/agents/askcard.tsx`, the answer currently keys on `agent.id` (the tabId). Change both call sites to use `agent.ask?.askId`:

- In `submitReply`, change `onAnswer?.(agent.id, reply.trim());` to:

```tsx
        onAnswer?.(agent.ask?.askId, reply.trim());
```

- In the option button `onClick`, change `onClick={() => onAnswer?.(agent.id, opt)}` to:

```tsx
                                onClick={() => onAnswer?.(agent.ask?.askId, opt)}
```

- Update the prop type so the first arg is the askId:

```tsx
    onAnswer?: (askId: string, answer: string) => void;
```

(The `onOpen` header-click and the peek button — shown when `agent.ask` is absent — are unchanged.)

- [ ] **Step 2: Provide the answer handler in the view**

In `frontend/app/view/agents/agents.tsx`, add imports:

```ts
import { fireAndForget } from "@/util/util";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
```

In `AgentsView`, add the handler next to `const open = ...`:

```tsx
    const answer = (askId: string, value: string) => {
        if (askId == null || askId === "") {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { askid: askId, answer: value }));
    };
```

And pass it to the needs-you cards — change the `AskCard` render to:

```tsx
                    {sections.asking.map((a) => (
                        <AskCard key={a.id} agent={a} onAnswer={answer} onOpen={open} />
                    ))}
```

- [ ] **Step 3: Typecheck + lint + tests**

Run: `npx tsc --noEmit` → clean.
Run: `npx eslint frontend/app/view/agents/ frontend/app/tab/sessionsidebar/sessionsidebar.tsx` → clean.
Run: `npx vitest run frontend/app/view/agents` → all green.

- [ ] **Step 4: Checkpoint**

Answering a needs-you card calls `AnswerAgentCommand({askid, answer})`; the inline pills/reply now resolve the agent instead of peeking. No commit.

---

## Task 8: Opt-in registration + convention docs

**Files:**
- Create: `docs/agents/ask-human-setup.md`
- Modify: `docs/docs/wsh-reference.mdx`

- [ ] **Step 1: Write the setup doc**

Create `docs/agents/ask-human-setup.md`:

````markdown
# ask_human channel — agent setup (opt-in)

The Agents panel answers agents' questions inline. For an agent to route a question
to the panel (instead of printing it and stopping), register the `ask_human` MCP server
and steer the agent to use it. Both steps are per-user opt-in; Wave does not install them.

## 1. Register the MCP server

Add to the project's `.mcp.json` (or run `claude mcp add`):

```json
{
  "mcpServers": {
    "wave-ask": { "command": "wsh", "args": ["ask-server"] }
  }
}
```

`wsh ask-server` inherits the Wave block's `WAVETERM_*` env, so it keys the ask to the
correct session automatically. The agent runs with `--dangerously-skip-permissions`, so
the `ask_human` tool is auto-approved.

## 2. Steer the agent to use it

Add to the project's `CLAUDE.md` (or an output-style):

```
When you need a decision from the user, call the `ask_human` tool with a clear
`question`, optional `options` (answer choices), and your `recommendation`.
Do NOT just print a question and stop — call `ask_human` so it reaches the Agents panel.
```
````

- [ ] **Step 2: Document the command**

In `docs/docs/wsh-reference.mdx`, add an entry in alphabetical order:

````markdown
## ask-server

Run the `ask_human` MCP server for the current block. Registered with Claude Code via
`.mcp.json` (see the ask_human channel setup doc), not run by hand. Exposes one tool,
`ask_human(question, options?, recommendation?)`, which surfaces the question in the Wave
Agents panel and blocks until the user answers there.

```sh
wsh ask-server
```

---
````

- [ ] **Step 3: Checkpoint**

Opt-in registration + convention are documented; the command is in the wsh reference. No commit.

---

## Task 9: Live verification (manual, no new code)

**Files:** none. (Mirrors the sidebar/loom/3a live-verification convention; drive the dev app over CDP per the [[cdp-verify-dev-app]] note.)

> Prerequisite: build wsh so `wsh ask-server` exists on the agent's PATH (`task build:wsh` or the project's dev build), and register it per Task 8 in a test project whose agent you can drive.

- [ ] **Step 1:** Launch the dev app (`task dev`), open the **Agents** view, start a real agent session in a Wave block with the `.mcp.json` registration.
- [ ] **Step 2: Ask appears.** Have the agent call `ask_human` (e.g., ask it to confirm a decision). Confirm the agent moves to **needs you** with the question, option pills (or Yes/No + reply), the recommendation, real previous-info (3a), and an "asking · age" label. Confirm the agent's terminal is **blocked** (not prompting).
- [ ] **Step 3: Answer unblocks.** Click an option (or type a reply + Enter). Confirm the card clears, the sidebar badge decrements, and the **agent continues** in its terminal with the chosen answer — without anything typed into the terminal.
- [ ] **Step 4: Edge cases.** (a) Close the session while it's asking → the card disappears. (b) Answer, then confirm a second click is a quiet no-op. (c) An agent that prints a question without `ask_human` still appears as needs-you with the **Open session to answer** peek button (3a path, unchanged).
- [ ] **Step 5: Record the result.** No commit. Note any deviations; file follow-ups for anything that didn't match (do not silently pass).

---

## Self-Review

**1. Spec coverage (against `2026-06-17-ask-human-channel-design.md`):**
- §3 `wsh` MCP server exposing `ask_human` → Task 4. ✅
- §3 `AskHumanCommand` (blocking) + `AnswerAgentCommand` → Task 3. ✅
- §3 ask-registry + `Event_AgentAsk` scoped to the block oref → Tasks 1, 2, 3. ✅
- §3 frontend ask store + merge onto `AgentVM.ask` + `onAnswer` wiring → Tasks 5, 6, 7. ✅
- §3 enforcement as opt-in docs (`.mcp.json` + convention) → Task 8. ✅
- §4.1.4 answer routes on askId, not tabId → Task 6 (`AgentAsk.askId`) + Task 7 (AskCard uses `agent.ask?.askId`). ✅
- §5 edge cases: agent dies (frontend drops the row → card gone; backend clears on ctx cancel/timeout); answered-after-resolved no-op (`Resolve` returns false → Task 3); bare-`waiting` agent shows peek button (3a path retained, Task 9 Step 4c). ✅
- §7 testing: registry unit-tested (Task 1, `go test`), pure `withAsk` unit-tested (Task 6, vitest), end-to-end live (Task 9). ✅

**2. Placeholder scan:** No "TBD"/"handle later"/"similar to". Every code step shows full code; every run step has an exact command + expected result. The 1-hour timeout and the lingering-goroutine-until-timeout behaviour are stated as explicit, documented v1 limitations (not silent gaps); the streaming-RPC alternative is named.

**3. Type consistency:**
- Go: `baseds.AgentAskData{ORef, AskId, Question, Options, Recommendation, Ts, Cleared}` (Task 2) is the `Event_AgentAsk` payload published in Task 3 and consumed as the generated TS `AgentAskData` in Tasks 5–6. `wshrpc.CommandAskHumanData` / `AskHumanRtnData` / `CommandAnswerAgentData` (Task 3) are produced by `wsh ask-server` (Task 4) and called by the view (Task 7) — field names (`oref`, `question`, `options`, `recommendation`, `askid`, `answer`) match the JSON tags.
- TS: `AgentAsk` gains `askId?` (Task 6), populated by `withAsk` from `AgentAskData.askid` (Task 6), read by `AskCard` as `agent.ask?.askId` (Task 7). `withAsk(vm, ask, now) → AgentVM` (Task 6) is called in `liveAgentBaseAtom` (Task 6 Step 5). `getAgentAskAtom(oref) → PrimitiveAtom<AgentAskData>` (Task 5) is read in `liveagents.ts` (Task 6). `onAnswer?: (askId, answer)` (Task 7) matches the `answer` handler's signature.

---

## Execution Handoff

Tasks are dependency-ordered: 1 → 2 → 3 → 4, then 5 → 6 → 7, then 8, then 9. `task generate` runs at the end of Tasks 2 and 3 (the frontend tasks need those generated types). Task 9 is live-only and needs a built `wsh` + a registered test agent.
