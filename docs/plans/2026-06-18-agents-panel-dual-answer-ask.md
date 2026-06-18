# Agents Panel — Dual-Answer Organic Ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's `AskUserQuestion` renders natively in its own terminal tab (unchanged) AND appears as an interactive copy in the Agents panel; answering in either place resolves the one underlying question.

**Architecture:** The PreToolUse hook stops denying (so the native picker always renders) and becomes a non-blocking projector. The terminal picker is the single source of truth; the panel answers by injecting keystrokes into the agent's PTY via `blockcontroller.SendInput` to drive that native picker. A PostToolUse hook clears the panel copy after the answer (from either surface).

**Tech Stack:** Go (wshrpc server, `pkg/agentask`, `pkg/blockcontroller`), TypeScript/React + Jotai frontend, `wsh` CLI (cobra), Claude Code hooks (Node), `task generate` for Go→TS type codegen.

**Spec:** `docs/specs/2026-06-18-agents-panel-dual-answer-ask-design.md`

**MVP scope (this plan):** panel answering for the **verified** case only — an ask with **exactly one single-select question**, answered by picking an option. multiSelect, freeform, and multi-question asks still render natively in the terminal and are answered there; the panel shows "Open session to answer" for them. (Follow-up plan, after an encoder probe, adds those.)

**Commit policy:** Per the repo owner's `~/.claude/CLAUDE.md`, do NOT commit without explicit approval and batch into one commit. Each task below ends with a `git add` (stage) checkpoint; the single commit is Task 11, gated on the owner's approval.

---

## File Structure

- `pkg/agentask/agentask.go` — registry: change from blocking `map[askId]chan` to `map[oref]PendingAsk` store.
- `pkg/agentask/agentask_test.go` — rewrite for the new store API.
- `pkg/agentask/encode.go` (new) — pure `EncodeAnswer(questions, answers) -> []byte` (the one CC-TUI-coupled unit).
- `pkg/agentask/encode_test.go` (new) — table tests for the encoder.
- `pkg/baseds/baseds.go` — add `AgentAnswerItem`.
- `pkg/wshrpc/wshrpctypes.go` — `CommandAnswerAgentData` → `{oref, answers}`; `AskRtnData` → `{askid}`; add `AgentAskClearCommand` to the interface.
- `pkg/wshrpc/wshserver/wshserver.go` — rewrite `AskCommand` (non-blocking), `AnswerAgentCommand` (encode+inject), add `AgentAskClearCommand`.
- `cmd/wsh/cmd/wshcmd-ask.go` — non-blocking `wsh ask`; add `--clear`.
- `docs/agents/ask-hook.js` — drop the `deny`; publish + exit 0.
- `docs/agents/ask-clear-hook.js` (new) — PostToolUse: `wsh ask --clear`.
- `frontend/app/view/agents/agentsviewmodel.ts` — add `oref` to `AgentAsk`; map it in `withAsk`.
- `frontend/app/view/agents/askcard.tsx` — structured submit; gate to single-select; pass `oref`.
- `frontend/app/view/agents/agents.tsx` — `answer` handler sends `{oref, answers}`.
- `~/.claude/settings.json` — keep the (non-denying) PreToolUse hook; add the PostToolUse clear hook.

Generated (do not hand-edit): `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go` — refreshed by `task generate`.

---

## Task 1: Registry — ORef-keyed pending-ask store

**Files:**
- Modify: `pkg/agentask/agentask.go`
- Test: `pkg/agentask/agentask_test.go`

- [ ] **Step 1: Rewrite the test for the new store API**

Replace the entire contents of `pkg/agentask/agentask_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func mkPending(askId, blockId string) PendingAsk {
	return PendingAsk{
		AskId:     askId,
		BlockId:   blockId,
		Questions: []baseds.AgentAskQuestion{{Question: "pick"}},
	}
}

func TestSetThenGet(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b1", mkPending("ask-1", "b1"))
	got, ok := r.Get("block:b1")
	if !ok {
		t.Fatalf("Get returned ok=false for a Set oref")
	}
	if got.AskId != "ask-1" || got.BlockId != "b1" {
		t.Fatalf("got %+v, want askId=ask-1 blockId=b1", got)
	}
}

func TestGetUnknownIsNotOk(t *testing.T) {
	r := MakeRegistry()
	if _, ok := r.Get("block:none"); ok {
		t.Fatalf("Get returned ok=true for an unknown oref")
	}
}

func TestDropRemoves(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b2", mkPending("ask-2", "b2"))
	r.Drop("block:b2")
	if _, ok := r.Get("block:b2"); ok {
		t.Fatalf("Get returned ok=true after Drop")
	}
}

func TestSetOverwritesSameOref(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b3", mkPending("ask-old", "b3"))
	r.Set("block:b3", mkPending("ask-new", "b3"))
	got, _ := r.Get("block:b3")
	if got.AskId != "ask-new" {
		t.Fatalf("got askId %q, want ask-new", got.AskId)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run: `go test ./pkg/agentask/...`
Expected: FAIL — `undefined: PendingAsk`, `r.Set undefined`, `r.Get undefined` (the old API was channel-based).

- [ ] **Step 3: Rewrite the registry**

Replace the entire contents of `pkg/agentask/agentask.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentask holds the in-memory registry of pending agent ask requests.
// AskCommand registers a pending ask keyed by the block's ORef; AnswerAgentCommand
// looks it up to encode + inject the answer; the clear path drops it. Keyed by ORef
// because an agent blocks on one AskUserQuestion at a time (at most one pending ask per block).
package agentask

import (
	"sync"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// PendingAsk is the question set currently awaiting an answer for a block.
type PendingAsk struct {
	AskId     string
	BlockId   string
	Questions []baseds.AgentAskQuestion
}

type Registry struct {
	lock    sync.Mutex
	pending map[string]PendingAsk
}

func MakeRegistry() *Registry {
	return &Registry{pending: make(map[string]PendingAsk)}
}

// GlobalRegistry is the process-wide instance used by the wsh server handlers.
var GlobalRegistry = MakeRegistry()

func (r *Registry) Set(oref string, p PendingAsk) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.pending[oref] = p
}

func (r *Registry) Get(oref string) (PendingAsk, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	p, ok := r.pending[oref]
	return p, ok
}

func (r *Registry) Drop(oref string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.pending, oref)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/agentask/...`
Expected: PASS (TestResolve* are gone; TestSetThenGet etc. pass). Note: this temporarily breaks `wshserver.go` compilation (it still calls the old `Register`/`Resolve`) — Task 4 fixes that. `go test ./pkg/agentask/...` compiles only the package, so it passes here.

- [ ] **Step 5: Stage**

```bash
git add pkg/agentask/agentask.go pkg/agentask/agentask_test.go
```

---

## Task 2: Answer encoder (the isolated CC-TUI-coupled unit)

**Files:**
- Create: `pkg/agentask/encode.go`
- Test: `pkg/agentask/encode_test.go`

- [ ] **Step 1: Write the failing test**

Create `pkg/agentask/encode_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"bytes"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func singleSelect(nOpts int) []baseds.AgentAskQuestion {
	opts := make([]baseds.AgentAskOption, nOpts)
	for i := range opts {
		opts[i] = baseds.AgentAskOption{Label: "opt"}
	}
	return []baseds.AgentAskQuestion{{Question: "q", Options: opts}}
}

func ans(idx int) []baseds.AgentAnswerItem {
	return []baseds.AgentAnswerItem{{SelectedIndexes: []int{idx}}}
}

func TestEncodeIndex0IsJustEnter(t *testing.T) {
	got, err := EncodeAnswer(singleSelect(3), ans(0))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got, []byte{'\r'}) {
		t.Fatalf("got %v, want [13]", got)
	}
}

func TestEncodeIndex2IsTwoDownThenEnter(t *testing.T) {
	got, err := EncodeAnswer(singleSelect(3), ans(2))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []byte{0x1b, '[', 'B', 0x1b, '[', 'B', '\r'}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEncodeRejectsMultiSelect(t *testing.T) {
	qs := singleSelect(2)
	qs[0].MultiSelect = true
	if _, err := EncodeAnswer(qs, ans(0)); err == nil {
		t.Fatalf("expected error for multi-select, got nil")
	}
}

func TestEncodeRejectsMultiQuestion(t *testing.T) {
	qs := append(singleSelect(2), baseds.AgentAskQuestion{Question: "q2"})
	answers := []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}, {SelectedIndexes: []int{0}}}
	if _, err := EncodeAnswer(qs, answers); err == nil {
		t.Fatalf("expected error for multi-question, got nil")
	}
}

func TestEncodeRejectsIndexOutOfRange(t *testing.T) {
	if _, err := EncodeAnswer(singleSelect(2), ans(5)); err == nil {
		t.Fatalf("expected error for out-of-range index, got nil")
	}
}

func TestEncodeRejectsZeroSelections(t *testing.T) {
	answers := []baseds.AgentAnswerItem{{SelectedIndexes: []int{}}}
	if _, err := EncodeAnswer(singleSelect(2), answers); err == nil {
		t.Fatalf("expected error for empty selection, got nil")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentask/... -run TestEncode`
Expected: FAIL — `undefined: EncodeAnswer`.

- [ ] **Step 3: Write the encoder**

Create `pkg/agentask/encode.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// downArrow / enter are the only keystrokes needed to drive Claude Code's native
// AskUserQuestion picker for a single-select question. Verified against Claude Code
// v2.1.181 (2026-06-18): the picker starts highlighted at index 0, ESC[B moves the
// highlight down one option, and CR selects. Number-select is not offered, so we
// navigate with arrows only. CC appends its own "Type something"/"Chat about this"
// entries AFTER the agent's options, so the agent option indices map 1:1.
var downArrow = []byte{0x1b, '[', 'B'}

const enter = byte('\r')

// EncodeAnswer returns the keystroke bytes that drive the native picker to the given
// answer. MVP supports exactly one single-select question answered by one option index.
// Anything else returns an error (callers fall back to answering in the terminal).
func EncodeAnswer(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem) ([]byte, error) {
	if len(questions) != 1 {
		return nil, fmt.Errorf("panel answering supports exactly one question, got %d", len(questions))
	}
	if len(answers) != 1 {
		return nil, fmt.Errorf("expected exactly one answer, got %d", len(answers))
	}
	q := questions[0]
	if q.MultiSelect {
		return nil, fmt.Errorf("panel answering does not support multi-select questions")
	}
	sel := answers[0].SelectedIndexes
	if len(sel) != 1 {
		return nil, fmt.Errorf("single-select expects exactly one selected index, got %d", len(sel))
	}
	idx := sel[0]
	if idx < 0 || idx >= len(q.Options) {
		return nil, fmt.Errorf("selected index %d out of range (%d options)", idx, len(q.Options))
	}
	buf := make([]byte, 0, idx*len(downArrow)+1)
	for i := 0; i < idx; i++ {
		buf = append(buf, downArrow...)
	}
	buf = append(buf, enter)
	return buf, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/agentask/...`
Expected: PASS (all encoder tests + the Task 1 registry tests).

- [ ] **Step 5: Stage**

```bash
git add pkg/agentask/encode.go pkg/agentask/encode_test.go
```

---

## Task 3: Data types + RPC surface

**Files:**
- Modify: `pkg/baseds/baseds.go`
- Modify: `pkg/wshrpc/wshrpctypes.go`

- [ ] **Step 1: Add `AgentAnswerItem` to baseds**

In `pkg/baseds/baseds.go`, after the `AgentAskData` struct (end of file), append:

```go

// AgentAnswerItem is one question's answer in a panel-submitted reply. SelectedIndexes
// indexes into that question's Options (MVP: exactly one for single-select).
type AgentAnswerItem struct {
	SelectedIndexes []int `json:"selectedindexes,omitempty"`
}
```

- [ ] **Step 2: Change the RPC data types**

In `pkg/wshrpc/wshrpctypes.go`, replace the `AskRtnData` and `CommandAnswerAgentData` structs:

```go
type AskRtnData struct {
	AskId string `json:"askid"`
}

type CommandAnswerAgentData struct {
	ORef    string                   `json:"oref"`
	Answers []baseds.AgentAnswerItem `json:"answers"`
}
```

- [ ] **Step 3: Add the clear command to the WshRpcInterface**

In `pkg/wshrpc/wshrpctypes.go`, in the `// agent ask` block of the interface (currently `AskCommand` + `AnswerAgentCommand`), add a third line:

```go
	// agent ask
	AskCommand(ctx context.Context, data CommandAskData) (AskRtnData, error)
	AnswerAgentCommand(ctx context.Context, data CommandAnswerAgentData) error
	AgentAskClearCommand(ctx context.Context, oref string) error
```

- [ ] **Step 4: Regenerate the client + TS types**

Run: `task generate`
Expected: updates `pkg/wshrpc/wshclient/wshclient.go` (adds `AgentAskClearCommand`, updates `AnswerAgentCommand` signature), `frontend/app/store/wshclientapi.ts`, and `frontend/types/gotypes.d.ts` (adds `AgentAnswerItem`, updates `CommandAnswerAgentData`/`AskRtnData`). No manual edits to generated files.

> **Expected transient state:** from Task 1 through Task 5 the full Go tree does **not** compile — the registry API change (Task 1) and type changes (this task) break `wshserver.go` and the old `wshcmd-ask.go` until Tasks 4–5 rewrite them. This is fine: `task generate` reflects only over `pkg/wshrpc` + `pkg/baseds` (which are self-consistent after Steps 1–3), and `go test ./pkg/agentask/...` compiles only that package. Do not try to build the whole tree until Task 5 is done. If `task generate` itself errors on an unrelated package, finish writing the Task 4 + Task 5 source files first, then re-run it.

- [ ] **Step 5: Stage**

```bash
git add pkg/baseds/baseds.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

## Task 4: Server handlers — non-blocking ask, inject answer, clear

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1595-1636` (the `AskCommand`/`AnswerAgentCommand`/`publishAgentAsk` block)

- [ ] **Step 1: Replace the AskCommand and AnswerAgentCommand handlers and add AgentAskClearCommand**

In `pkg/wshrpc/wshserver/wshserver.go`, replace the existing `AskCommand` and `AnswerAgentCommand` functions (keep `publishAgentAsk` as-is below them) with:

```go
func (ws *WshServer) AskCommand(ctx context.Context, data wshrpc.CommandAskData) (wshrpc.AskRtnData, error) {
	if data.ORef == "" || len(data.Questions) == 0 {
		return wshrpc.AskRtnData{}, fmt.Errorf("oref and at least one question are required")
	}
	oref, err := waveobj.ParseORef(data.ORef)
	if err != nil {
		return wshrpc.AskRtnData{}, fmt.Errorf("invalid oref %q: %w", data.ORef, err)
	}
	askId := uuid.New().String()
	agentask.GlobalRegistry.Set(data.ORef, agentask.PendingAsk{
		AskId:     askId,
		BlockId:   oref.OID,
		Questions: data.Questions,
	})
	publishAgentAsk(baseds.AgentAskData{
		ORef:      data.ORef,
		AskId:     askId,
		Questions: data.Questions,
		Ts:        time.Now().UnixMilli(),
	})
	return wshrpc.AskRtnData{AskId: askId}, nil
}

func (ws *WshServer) AnswerAgentCommand(ctx context.Context, data wshrpc.CommandAnswerAgentData) error {
	if data.ORef == "" {
		return fmt.Errorf("oref is required")
	}
	pending, ok := agentask.GlobalRegistry.Get(data.ORef)
	if !ok {
		// already answered in the terminal (or cleared): no-op. This also prevents
		// injecting stray bytes into the shell after the picker is gone.
		return nil
	}
	keys, err := agentask.EncodeAnswer(pending.Questions, data.Answers)
	if err != nil {
		return err
	}
	return blockcontroller.SendInput(pending.BlockId, &blockcontroller.BlockInputUnion{InputData: keys})
}

func (ws *WshServer) AgentAskClearCommand(ctx context.Context, oref string) error {
	if oref == "" {
		return fmt.Errorf("oref is required")
	}
	askId := ""
	if pending, ok := agentask.GlobalRegistry.Get(oref); ok {
		askId = pending.AskId
	}
	agentask.GlobalRegistry.Drop(oref)
	publishAgentAsk(baseds.AgentAskData{ORef: oref, AskId: askId, Cleared: true})
	return nil
}
```

- [ ] **Step 2: Verify imports**

Confirm `pkg/wshrpc/wshserver/wshserver.go` imports `waveobj`, `time`, `uuid`, `agentask`, `baseds`, and `blockcontroller`. `blockcontroller`, `uuid`, `agentask`, `baseds` are already imported (used by `ControllerInputCommand` and the old `AskCommand`). Add `"github.com/wavetermdev/waveterm/pkg/waveobj"` and `"time"` to the import block if VSCode flags them as missing.

- [ ] **Step 3: Verify it compiles**

Check VSCode Problems for `pkg/wshrpc/wshserver/wshserver.go` — expected: no errors. (Per project rules, no `go build` needed.)

- [ ] **Step 4: Run the package tests still pass**

Run: `go test ./pkg/agentask/...`
Expected: PASS (unchanged from Task 2).

- [ ] **Step 5: Stage**

```bash
git add pkg/wshrpc/wshserver/wshserver.go
```

---

## Task 5: `wsh ask` — non-blocking, with `--clear`

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-ask.go`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `cmd/wsh/cmd/wshcmd-ask.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var askClear bool

var askCmd = &cobra.Command{
	Use:                   "ask",
	Short:                 "project an AskUserQuestion into the Wave Agents panel (non-blocking)",
	Args:                  cobra.NoArgs,
	RunE:                  askRun,
	PreRunE:               preRunSetupRpcClient,
	Hidden:                true,
	DisableFlagsInUseLine: true,
}

func init() {
	askCmd.Flags().BoolVar(&askClear, "clear", false, "clear the pending ask for this block (PostToolUse)")
	rootCmd.AddCommand(askCmd)
}

// any error returned here exits non-zero; the hooks treat non-zero / failure as
// "the native terminal prompt handles it" (graceful degradation).
func askRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("ask", rtnErr == nil)
	}()

	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %w", err)
	}

	if askClear {
		return wshclient.AgentAskClearCommand(RpcClient, oref.String(), &wshrpc.RpcOpts{Timeout: 5000})
	}

	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}

	var in struct {
		Questions []struct {
			Question    string `json:"question"`
			Header      string `json:"header"`
			MultiSelect bool   `json:"multiSelect"`
			Options     []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return fmt.Errorf("no questions on stdin: %w", err)
	}
	if len(in.Questions) == 0 {
		return fmt.Errorf("no questions provided")
	}

	questions := make([]baseds.AgentAskQuestion, len(in.Questions))
	for i, q := range in.Questions {
		opts := make([]baseds.AgentAskOption, len(q.Options))
		for j, o := range q.Options {
			opts[j] = baseds.AgentAskOption{Label: o.Label, Description: o.Description}
		}
		questions[i] = baseds.AgentAskQuestion{
			Question:    q.Question,
			Header:      q.Header,
			MultiSelect: q.MultiSelect,
			Options:     opts,
		}
	}

	_, err = wshclient.AskCommand(RpcClient, wshrpc.CommandAskData{ORef: oref.String(), Questions: questions}, &wshrpc.RpcOpts{Timeout: 5000})
	return err
}
```

- [ ] **Step 2: Verify it compiles**

Check VSCode Problems for `cmd/wsh/cmd/wshcmd-ask.go` — expected: no errors. (`AskTimeoutMs` is gone; nothing else references it.)

- [ ] **Step 3: Stage**

```bash
git add cmd/wsh/cmd/wshcmd-ask.go
```

---

## Task 6: PreToolUse hook — drop the deny

**Files:**
- Modify: `docs/agents/ask-hook.js`

- [ ] **Step 1: Replace the file**

Replace the entire contents of `docs/agents/ask-hook.js`:

```js
// Copyright 2026, WaveTerm Inc.
// Licensed under the Apache License, Version 2.0.
//
// PreToolUse hook for AskUserQuestion: projects a COPY of the question into Wave's
// Agents panel via `wsh ask`, then exits 0 so Claude Code renders its native picker
// in the terminal as usual. The panel and the terminal are both live answer surfaces
// (the panel injects keystrokes into this block's PTY to drive the same native picker).
//
// Registered in ~/.claude/settings.json under hooks.PreToolUse with matcher
// "AskUserQuestion". Fail-safe: any problem -> exit 0 -> native terminal prompt.

const path = require("path");
const childProcess = require("child_process");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
    let parsed;
    try {
        parsed = JSON.parse(input);
    } catch (_) {
        process.exit(0);
    }
    if (parsed.tool_name !== "AskUserQuestion") {
        process.exit(0);
    }
    if (!process.env.WAVETERM_BLOCKID || !process.env.WAVETERM_WSHBINDIR) {
        process.exit(0);
    }
    if (!parsed.tool_input?.questions?.length) {
        process.exit(0);
    }

    const wsh = path.join(
        process.env.WAVETERM_WSHBINDIR,
        process.platform === "win32" ? "wsh.exe" : "wsh"
    );

    // non-blocking projection: publish the copy to the panel, then let CC render natively.
    try {
        childProcess.spawnSync(wsh, ["ask"], {
            input: JSON.stringify(parsed.tool_input),
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5000,
        });
    } catch (_) {
        // ignore — terminal picker still renders
    }
    // no permissionDecision: CC proceeds and renders the native picker
    process.exit(0);
});
```

- [ ] **Step 2: Stage**

```bash
git add docs/agents/ask-hook.js
```

---

## Task 7: PostToolUse clear hook (new)

**Files:**
- Create: `docs/agents/ask-clear-hook.js`

- [ ] **Step 1: Create the file**

Create `docs/agents/ask-clear-hook.js`:

```js
// Copyright 2026, WaveTerm Inc.
// Licensed under the Apache License, Version 2.0.
//
// PostToolUse hook for AskUserQuestion: once the question is answered (in the terminal
// OR via a keystroke injected from the Agents panel), remove the panel copy by calling
// `wsh ask --clear`. Registered in ~/.claude/settings.json under hooks.PostToolUse with
// matcher "AskUserQuestion". Fail-safe: any problem -> exit 0 (card lingers until superseded).

const path = require("path");
const childProcess = require("child_process");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
    let parsed;
    try {
        parsed = JSON.parse(input);
    } catch (_) {
        process.exit(0);
    }
    if (parsed.tool_name !== "AskUserQuestion") {
        process.exit(0);
    }
    if (!process.env.WAVETERM_BLOCKID || !process.env.WAVETERM_WSHBINDIR) {
        process.exit(0);
    }

    const wsh = path.join(
        process.env.WAVETERM_WSHBINDIR,
        process.platform === "win32" ? "wsh.exe" : "wsh"
    );

    try {
        childProcess.spawnSync(wsh, ["ask", "--clear"], { encoding: "utf8", timeout: 5000 });
    } catch (_) {
        // ignore
    }
    process.exit(0);
});
```

- [ ] **Step 2: Stage**

```bash
git add docs/agents/ask-clear-hook.js
```

---

## Task 8: Frontend — carry `oref`, structured submit, single-select gate

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:24-27` (the `AgentAsk` interface) and `:142-150` (the `withAsk` mapping)
- Modify: `frontend/app/view/agents/askcard.tsx`
- Modify: `frontend/app/view/agents/agents.tsx:26-31` (the `answer` handler) and `:59` (the `AskCard` props)

- [ ] **Step 1: Add `oref` to the `AgentAsk` interface**

In `frontend/app/view/agents/agentsviewmodel.ts`, change the `AgentAsk` interface:

```ts
export interface AgentAsk {
    questions: AgentAskQuestion[];
    askId?: string;
    oref?: string;
}
```

- [ ] **Step 2: Map `oref` in `withAsk`**

In `frontend/app/view/agents/agentsviewmodel.ts`, in the `withAsk` return's `ask:` object, add `oref` next to `askId`:

```ts
        ask: {
            questions: (ask.questions ?? []).map((q) => ({
                question: q.question,
                header: q.header,
                multiSelect: q.multiselect,
                options: q.options?.map((o) => ({ label: o.label, description: o.description })),
            })),
            askId: ask.askid,
            oref: ask.oref,
        },
```

- [ ] **Step 3: Update `askcard.tsx` — structured submit + single-select gate**

In `frontend/app/view/agents/askcard.tsx`:

(a) Delete the now-unused `buildAnswerString` function (lines 30-43).

(b) Change the `AskCard` props type:

```ts
export function AskCard({
    agent,
    onAnswer,
    onOpen,
}: {
    agent: AgentVM;
    onAnswer?: (oref: string, answers: AgentAnswerItem[]) => void;
    onOpen: (id: string) => void;
}) {
```

(c) Replace `allAnswered` + `handleSubmit` (lines 126, 148-152) with a single-select gate:

```ts
    // MVP: the panel can drive the native picker only for a single single-select question.
    // Everything else (multi-select, multi-question) is answered in the terminal.
    const panelAnswerable = questions.length === 1 && !questions[0]?.multiSelect;
    const canSubmit = panelAnswerable && (selections[0]?.size ?? 0) === 1;

    const handleSubmit = () => {
        if (!canSubmit) return;
        const answers: AgentAnswerItem[] = [{ selectedindexes: Array.from(selections[0] ?? []) }];
        onAnswer?.(agent.ask?.oref, answers);
    };
```

(d) In the JSX, change the answerable condition from `{agent.ask ? (` to `{agent.ask && panelAnswerable ? (`, and change the Submit button's `disabled={!allAnswered}` to `disabled={!canSubmit}` and its `allAnswered` class condition to `canSubmit`:

```tsx
            {agent.ask && panelAnswerable ? (
                <>
                    {questions.map((q, qi) => (
                        <QuestionGroup
                            key={qi}
                            question={q}
                            qi={qi}
                            selections={selections[qi] ?? new Set()}
                            freeform={freeforms[qi] ?? ""}
                            onToggle={handleToggle}
                            onFreeform={handleFreeform}
                        />
                    ))}
                    <div className="mt-3.5 flex justify-end">
                        <button
                            type="button"
                            disabled={!canSubmit}
                            onClick={handleSubmit}
                            className={cn(
                                "rounded-[7px] px-[18px] py-1.5 text-[12.5px] font-semibold",
                                canSubmit
                                    ? "cursor-pointer bg-[#238636] text-white"
                                    : "bg-[#238636]/40 text-white/50"
                            )}
                        >
                            Submit
                        </button>
                    </div>
                </>
            ) : (
                <div className="mt-3.5 border-t border-[#2a2f3a] pt-3.5">
                    <button
                        type="button"
                        onClick={() => onOpen(agent.id)}
                        className="cursor-pointer rounded-[7px] bg-[#238636] px-[18px] py-1.5 text-[12.5px] font-semibold text-white"
                    >
                        Open session to answer
                    </button>
                </div>
            )}
```

Note: `isAnswered` becomes unused after removing `allAnswered`; delete the `isAnswered` helper (lines 121-125) too.

- [ ] **Step 4: Update `agents.tsx` — answer handler sends `{oref, answers}`**

In `frontend/app/view/agents/agents.tsx`, replace the `answer` handler:

```ts
    const answer = (oref: string, answers: AgentAnswerItem[]) => {
        if (!oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    };
```

The `<AskCard ... onAnswer={answer} ... />` usage on line 59 is unchanged (the prop name is the same; only its signature changed).

- [ ] **Step 5: Verify it compiles**

Check VSCode Problems for the three files — expected: no TS errors. (`AgentAnswerItem` is an ambient global from `gotypes.d.ts`, like `AgentAskData`; no import needed.)

- [ ] **Step 6: Stage**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/askcard.tsx frontend/app/view/agents/agents.tsx
```

---

## Task 9: Hook config — keep non-denying PreToolUse, add PostToolUse clear

**Files:**
- Modify: `~/.claude/settings.json` (global Claude Code config; back up first)

- [ ] **Step 1: Back up**

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.dualanswer-bak
```

- [ ] **Step 2: Add the PostToolUse clear hook (PreToolUse AskUserQuestion entry already present, now non-denying via Task 6)**

Run this Node script (avoids hand-editing JSON / backslash corruption):

```js
// save as a temp .mjs and run with node
import fs from "node:fs";
const p = process.env.USERPROFILE + "/.claude/settings.json";
const node = '"C:\\Program Files\\nodejs\\node.exe"';
const clearHook = process.env.USERPROFILE + "/IdeaProjects/waveterm/docs/agents/ask-clear-hook.js";
const cmd = `${node} "${clearHook.replaceAll("/", "\\")}"`;
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.hooks.PostToolUse = s.hooks.PostToolUse || [];
if (!s.hooks.PostToolUse.some((e) => e.matcher === "AskUserQuestion")) {
    s.hooks.PostToolUse.push({ matcher: "AskUserQuestion", hooks: [{ type: "command", command: cmd, timeout: 10 }] });
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
    console.log("added PostToolUse AskUserQuestion clear hook");
} else {
    console.log("PostToolUse AskUserQuestion hook already present");
}
```

Expected: `added PostToolUse AskUserQuestion clear hook`.

- [ ] **Step 3: Confirm the PreToolUse AskUserQuestion command still points at `docs/agents/ask-hook.js`** (unchanged path; Task 6 changed the file's behavior, not its location). Read `~/.claude/settings.json` and verify both hooks are present and command strings are intact (no collapsed `\\`).

- [ ] **Step 4: Stage** (settings.json is outside the repo — nothing to stage; note it in the final summary instead.)

---

## Task 10: Build, deploy, and runtime-verify end-to-end

This task changes Go (wavesrv + wsh) and TS. The dev app must be rebuilt and relaunched (closes the owner's open tabs — **confirm before relaunching**).

- [ ] **Step 1: Rebuild wsh (CGO off, ~10s) and install it**

```bash
cd /c/Users/kael02/IdeaProjects/waveterm
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w -X main.WaveVersion=0.14.5" -o dist/bin/wsh-0.14.5-windows.x64.exe cmd/wsh/main-wsh.go
cp dist/bin/wsh-0.14.5-windows.x64.exe "$LOCALAPPDATA/waveterm-dev/Data/bin/wsh.exe"
```

(Terminals re-exec wsh from that path live; no relaunch needed for the wsh half.)

- [ ] **Step 2: Rebuild wavesrv + relaunch the dev app** (after confirming with the owner)

Run: `task electron:winquickdev` (background). Wait for `wave-ready` / poll `127.0.0.1:9222`.

- [ ] **Step 3: Drive a real agent (reuse the spike harness)**

Using `C:\Users\kael02\AppData\Local\Temp\wavecdp\cdp.mjs` + `spike-input.mjs`: open a throwaway tab, start `claude`, prompt it to call `AskUserQuestion` with one single-select question (Red/Green/Blue).

- [ ] **Step 4: Assert dual render**

Screenshot: the **native picker** renders in the terminal block AND an **interactive AskCard** (with the three option buttons + enabled-after-pick Submit) appears in the Agents panel.

- [ ] **Step 5: Answer from the PANEL → agent continues, card clears**

Open the Agents tab; click "Green"; click Submit. Then screenshot the terminal block.
Expected: the native picker resolves to **Green**, the agent prints it picked Green, and the AskCard disappears from the panel (PostToolUse `--clear`).

- [ ] **Step 6: Answer in the TERMINAL → card clears**

Trigger a second ask; this time answer in the terminal picker directly (inject `\r`). Screenshot the panel.
Expected: the AskCard disappears (PostToolUse `--clear` fires regardless of answer surface).

- [ ] **Step 7: Record evidence**

Save screenshots to `C:\Users\kael02\AppData\Local\Temp\wavecdp\` and note PASS/FAIL per step. Restore the original active tab; leave any throwaway tab for the owner to close (CDP can't close tabs in this dev build).

---

## Task 11: Commit (requires owner approval)

- [ ] **Step 1: Show the staged diff summary**

```bash
git status
git diff --cached --stat
```

- [ ] **Step 2: Ask the owner for explicit approval** (per CLAUDE.md). Present files (M/A/D) + the message:

```
feat(agents): dual-answer organic ask — native terminal + answerable panel mirror

Drop the deny-based suppression so AskUserQuestion always renders natively in its
tab; project a non-blocking copy to the Agents panel that answers by injecting
keystrokes into the agent PTY. PostToolUse clears the card from either surface.
```

- [ ] **Step 3: On approval only**, commit the staged changes with that message. Do NOT push unless separately approved. (settings.json is outside the repo and is not part of the commit.)

---

## Notes / out of scope (follow-up)

- **multiSelect / freeform / multi-question panel answering** — needs an encoder probe (space-toggle, "Type something" navigation + typed text, inter-question advance) against the live CC picker, then extends `EncodeAnswer` + the `askcard.tsx` gate. Until then those asks are answered in the terminal (panel shows "Open session to answer").
- **Esc-cancel staleness** and **simultaneous dual-answer interleaving** — documented accepted limitations (spec §7); no work in this plan.
