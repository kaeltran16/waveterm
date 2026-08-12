# Pi Ask Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route pi's `ask_user_question` tool calls through the cockpit attention list — questions surface in the Wave Agents panel, answers/dismiss/abort return to the tool call — with previews rendered end-to-end and a dismiss button on the answer surface.

**Architecture:** `pkg/agentask` gains a waiter registry (askId → buffered chan). `wsh ask --wait` registers the pending ask (existing flow) plus a waiter, then blocks on the RPC until resolved or the context dies. `DeliverAnswer` claims as today, then resolves the waiter instead of injecting keystrokes when one exists (pi has no native picker); no waiter → the CC keystroke path is untouched. `AgentAskClearCommand` resolves waiters as cancelled (dismiss path). A pi extension registers the canonical `ask_user_question` tool, invokes `pi.exec(wsh, ["ask","--wait","--questions-json",payload], {signal})` (argv because pi's exec stdin is ignored), and maps the JSON result onto the rpiv-shaped tool envelope. Previews flow baseds → generated bindings → VM → answerbar side-by-side layout.

**Tech Stack:** Go (wavesrv + wsh, `task generate` for bindings), React 19 + jotai (answerbar.tsx), pi extension API (`pi.registerTool`/`pi.exec`), vitest for pure logic, `task verify:ui` for visuals.

## Global Constraints

- **Never hand-edit generated files:** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `cmd/wsh/cmd/pi-ask-extension.ts`, `cmd/wsh/cmd/pi-ask-core-extension.ts`. Regenerate with `task generate` (Go types) / `task sync:piartifacts` (pi artifacts).
- **Go tests need the CGO header** on this machine: run from PowerShell with `$env:CGO_CFLAGS="-I<repo>\pkg\jarvisembed\csrc"` before `go test ./pkg/...` (bare `go test ./pkg/...` fails to build 6 sqlite-vec packages). `go test ./pkg/agentask/...` and `go test ./cmd/wsh/...` are CGO-free and work directly.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows).
- **Vitest:** `npx vitest run <file>` for single files.
- **Pi exec stdin is ignored** (`stdio: ["ignore","pipe","pipe"]` in pi's `exec.js`) — the payload travels as the `--questions-json` argv flag, never stdin.
- **Wait timeout:** fixed `30 * time.Minute` RPC timeout for `--wait` (const `askWaitTimeout`).
- **No commits without explicit user approval**; batch everything into one commit at the end (Task 8 presents for approval).
- **Copy rules:** tool envelope text is pinned by tests — answered: `User has answered your questions: "Q"="A". You can now continue with the user's answers in mind.`; declined: `User declined to answer questions`.
- **No new frontend status work** (core spec's waiting-state rule): the existing `agent:ask` event + withAsk overlay already represent pi asking.

---

### Task 1: Waiter registry in `pkg/agentask`

**Files:**
- Create: `pkg/agentask/waiters.go`
- Create: `pkg/agentask/waiters_test.go`
- Modify: `pkg/agentask/deliver.go` (waiter branch in `DeliverAnswer`)
- Modify: `pkg/agentask/agentask.go` (`Registry.waits` field)
- Test: `pkg/agentask/deliver_test.go` (extend — existing tests must keep passing unchanged)

**Interfaces:**
- Consumes: `PendingAsk.AskId` (`pkg/agentask/agentask.go`), `Registry.Claim` (unchanged), `baseds.AgentAnswerItem`.
- Produces (used by Tasks 2, 3):
  - `type WaitResult struct { Answers []baseds.AgentAnswerItem; Cancelled bool }`
  - `func (r *Registry) RegisterWaiter(askId string) chan WaitResult` — creates a buffered(1) channel and stores it keyed by askId.
  - `func (r *Registry) ResolveWaiter(askId string, res WaitResult) bool` — removes the entry and non-blocking-sends; returns true if a waiter was registered. Safe to call when none exists (false), and when already resolved (removal is a no-op).
  - `func (r *Registry) RemoveWaiter(askId string)` — removes the entry without sending (waiter gave up).
- DeliverAnswer's waiter branch is the single delivery decision point: waiter present → resolve, no keystrokes; absent → existing keystroke path.

- [ ] **Step 1: Write the failing tests** — `pkg/agentask/waiters_test.go`:

```go
package agentask

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func TestResolveWaiterDeliversOnce(t *testing.T) {
	r := MakeRegistry()
	ch := r.RegisterWaiter("a1")
	if !r.ResolveWaiter("a1", WaitResult{Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}}}) {
		t.Fatal("resolve must report the waiter was registered")
	}
	select {
	case res := <-ch:
		if res.Cancelled || len(res.Answers) != 1 || res.Answers[0].SelectedIndexes[0] != 1 {
			t.Fatalf("bad result: %#v", res)
		}
	default:
		t.Fatal("waiter must receive the result")
	}
	// second resolve is a no-op (entry removed on first resolve)
	if r.ResolveWaiter("a1", WaitResult{Cancelled: true}) {
		t.Fatal("second resolve must report no waiter")
	}
}

func TestResolveWaiterNoWaiter(t *testing.T) {
	r := MakeRegistry()
	if r.ResolveWaiter("nope", WaitResult{Cancelled: true}) {
		t.Fatal("resolving an unregistered askId must be a no-op")
	}
}

func TestRemoveWaiterGivesUp(t *testing.T) {
	r := MakeRegistry()
	ch := r.RegisterWaiter("a1")
	r.RemoveWaiter("a1")
	if r.ResolveWaiter("a1", WaitResult{Cancelled: true}) {
		t.Fatal("removed waiter must not resolve")
	}
	if len(ch) != 0 {
		t.Fatal("removed waiter must not have a buffered result")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/agentask/ -run TestResolveWaiter -v`
Expected: FAIL to compile — `WaitResult`, `RegisterWaiter`, `ResolveWaiter`, `RemoveWaiter` undefined.

- [ ] **Step 3: Write `pkg/agentask/waiters.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"sync"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// WaitResult is one resolved ask for a --wait caller: the answers, or Cancelled=true when
// the ask was cleared (dismissed in the cockpit) before an answer arrived.
type WaitResult struct {
	Answers   []baseds.AgentAnswerItem
	Cancelled bool
}

// waiters holds blocked wsh ask --wait callers, keyed by the pending ask's AskId. The
// buffered(1) channel + non-blocking resolve make double-resolve safe: only the first
// resolve sends, and a resolve racing a remove is either delivered or dropped, never
// blocked. At most one waiter exists per ask (one AskId, one --wait caller).
type waiters struct {
	lock sync.Mutex
	m    map[string]chan WaitResult
}

func (w *waiters) Register(askId string) chan WaitResult {
	ch := make(chan WaitResult, 1)
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.m == nil {
		w.m = make(map[string]chan WaitResult)
	}
	w.m[askId] = ch
	return ch
}

func (w *waiters) Resolve(askId string, res WaitResult) bool {
	w.lock.Lock()
	ch, ok := w.m[askId]
	if ok {
		delete(w.m, askId)
	}
	w.lock.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- res:
	default: // already resolved or abandoned — first resolve wins
	}
	return true
}

func (w *waiters) Remove(askId string) {
	w.lock.Lock()
	delete(w.m, askId)
	w.lock.Unlock()
}

// Registry-level helpers used by the wsh server and DeliverAnswer.
func (r *Registry) RegisterWaiter(askId string) chan WaitResult { return r.waits.Register(askId) }
func (r *Registry) ResolveWaiter(askId string, res WaitResult) bool { return r.waits.Resolve(askId, res) }
func (r *Registry) RemoveWaiter(askId string) { r.waits.Remove(askId) }
```

- [ ] **Step 4: Add the `waits` field to `Registry`** in `pkg/agentask/agentask.go`

Change `type Registry struct { lock sync.Mutex; pending map[string]PendingAsk }` to add `waits waiters`, and keep `MakeRegistry` initializing only `pending`:

```go
type Registry struct {
	lock    sync.Mutex
	pending map[string]PendingAsk
	waits   waiters
}

func MakeRegistry() *Registry {
	return &Registry{pending: make(map[string]PendingAsk)}
}
```

(`waits` is a zero-value struct — no init needed; `waiters.m` is lazily allocated in `Register`.)

- [ ] **Step 5: Waiter branch in `DeliverAnswer`** — `pkg/agentask/deliver.go`

Insert between the `Claim` and `EncodeAnswer` calls:

```go
	// waiter path (pi ask bridge): a --wait caller registered on this ask — resolve it
	// directly. pi has no native picker to drive, so keystrokes would type into the
	// session; the waiter is the delivery. No waiter -> CC path (keystroke injection).
	if GlobalRegistry.ResolveWaiter(pending.AskId, WaitResult{Answers: answers}) {
		return true, nil
	}
```

- [ ] **Step 6: Run all agentask tests to verify they pass**

Run: `go test ./pkg/agentask/`
Expected: PASS — new waiter tests plus all existing `deliver_test.go` tests (keystroke path unchanged: `TestDeliverAnswer_Delivers` still sees exactly 2 writes; `TestDeliverAnswer_ConcurrentInjectsOnce` still sees 1 winner).

- [ ] **Step 7: Checkpoint — report, no commit**

`git status --short` — expect only `pkg/agentask/waiters.go`, `pkg/agentask/waiters_test.go`, `pkg/agentask/deliver.go`, `pkg/agentask/agentask.go` modified. No commit (per Global Constraints).

---

### Task 2: wshrpc types + wshserver wait-mode handlers

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_ask.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_ask.go`
- Create: `pkg/wshrpc/wshserver/wshserver_ask_test.go`
- Test: `pkg/agentask/deliver_test.go` (add one waiter-interaction test)

**Interfaces:**
- Consumes: Task 1's `RegisterWaiter`/`ResolveWaiter`/`RemoveWaiter`, `WaitResult`.
- Produces (used by Task 3):
  - `CommandAskData.Wait bool json:"wait,omitempty"`
  - `AskRtnData.Answers []baseds.AgentAnswerItem json:"answers,omitempty"` + `AskRtnData.Cancelled bool json:"cancelled,omitempty"`
  - `AskCommand` with `Wait: true` blocks until resolved (returns Answers/Cancelled) or `ctx.Done()` (drops the pending ask, publishes the cleared event, returns `ctx.Err()`).
  - `AgentAskClearCommand` resolves any waiter as cancelled before dropping.

- [ ] **Step 1: Write the failing tests** — `pkg/wshrpc/wshserver/wshserver_ask_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func askData(oref string, wait bool) wshrpc.CommandAskData {
	return wshrpc.CommandAskData{
		ORef: oref,
		Questions: []baseds.AgentAskQuestion{{
			Question: "A or B?",
			Options:  []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}},
		}},
		Wait: wait,
	}
}

func TestAskCommandWaitResolvesViaAnswer(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef("block", "w1").String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	rtnCh := make(chan wshrpc.AskRtnData, 1)
	errCh := make(chan error, 1)
	go func() {
		rtn, err := ws.AskCommand(context.Background(), askData(oref, true))
		rtnCh <- rtn
		errCh <- err
	}()
	// wait until the pending ask is registered, then answer it
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := agentask.GlobalRegistry.Get(oref); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pending ask never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := ws.AnswerAgentCommand(context.Background(), wshrpc.CommandAnswerAgentData{
		ORef:    oref,
		Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}},
	}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	select {
	case rtn := <-rtnCh:
		if rtn.Cancelled || len(rtn.Answers) != 1 || rtn.Answers[0].SelectedIndexes[0] != 1 {
			t.Fatalf("bad wait result: %#v", rtn)
		}
	case err := <-errCh:
		t.Fatalf("ask wait errored: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("wait RPC never returned")
	}
	if _, ok := agentask.GlobalRegistry.Get(oref); ok {
		t.Fatal("pending ask must be claimed after delivery")
	}
}

func TestAskCommandWaitCancelCleansUp(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef("block", "w2").String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := ws.AskCommand(ctx, askData(oref, true))
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := agentask.GlobalRegistry.Get(oref); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pending ask never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel must return an error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("wait RPC never returned after cancel")
	}
	if _, ok := agentask.GlobalRegistry.Get(oref); ok {
		t.Fatal("cancel must drop the pending ask")
	}
}

func TestAskCommandClearCancelsWaiter(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef("block", "w3").String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	rtnCh := make(chan wshrpc.AskRtnData, 1)
	go func() {
		rtn, _ := ws.AskCommand(context.Background(), askData(oref, true))
		rtnCh <- rtn
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := agentask.GlobalRegistry.Get(oref); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pending ask never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := ws.AgentAskClearCommand(context.Background(), oref); err != nil {
		t.Fatalf("clear: %v", err)
	}
	select {
	case rtn := <-rtnCh:
		if !rtn.Cancelled || len(rtn.Answers) != 0 {
			t.Fatalf("clear must resolve the waiter cancelled: %#v", rtn)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("wait RPC never returned after clear")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestAskCommand -v`
Expected: FAIL to compile — `CommandAskData` has no `Wait` field, `AskRtnData` has no `Answers`/`Cancelled`.

- [ ] **Step 3: Extend the wshrpc types** — `pkg/wshrpc/wshrpctypes_ask.go`

```go
type CommandAskData struct {
	ORef      string                    `json:"oref"`
	Questions []baseds.AgentAskQuestion `json:"questions"`
	// Wait blocks the RPC until the ask is answered (Answers) or cleared/cancelled
	// (Cancelled=true). Fire-and-forget when false (Claude Code hook path).
	Wait bool `json:"wait,omitempty"`
}

type AskRtnData struct {
	AskId     string                   `json:"askid"`
	Answers   []baseds.AgentAnswerItem `json:"answers,omitempty"`
	Cancelled bool                     `json:"cancelled,omitempty"`
}
```

- [ ] **Step 4: Wait-mode handler** — `pkg/wshrpc/wshserver/wshserver_ask.go`

In `AskCommand`, replace the trailing `return wshrpc.AskRtnData{AskId: askId}, nil` (which currently follows `publishAgentAsk(...)`) with:

```go
	if !data.Wait {
		return wshrpc.AskRtnData{AskId: askId}, nil
	}
	// wait mode (pi ask bridge): block until the human answers in the cockpit, or the
	// caller dies. ctx.Done cleanup drops the pending ask and publishes the cleared
	// event so the attention list never shows a stale ask for a dead agent.
	ch := agentask.GlobalRegistry.RegisterWaiter(askId)
	select {
	case res := <-ch:
		return wshrpc.AskRtnData{AskId: askId, Answers: res.Answers, Cancelled: res.Cancelled}, nil
	case <-ctx.Done():
		agentask.GlobalRegistry.RemoveWaiter(askId)
		agentask.GlobalRegistry.Drop(data.ORef)
		publishAgentAsk(baseds.AgentAskData{ORef: data.ORef, AskId: askId, Cleared: true})
		return wshrpc.AskRtnData{}, ctx.Err()
	}
```

In `AgentAskClearCommand`, replace the body with:

```go
func (ws *WshServer) AgentAskClearCommand(ctx context.Context, oref string) error {
	if oref == "" {
		return fmt.Errorf("oref is required")
	}
	askId := ""
	if pending, ok := agentask.GlobalRegistry.Get(oref); ok {
		askId = pending.AskId
		// a blocked --wait caller (pi) treats a cockpit dismiss as cancellation; CC's
		// PostToolUse clear finds no waiter and is unchanged in effect.
		agentask.GlobalRegistry.ResolveWaiter(askId, agentask.WaitResult{Cancelled: true})
	}
	agentask.GlobalRegistry.Drop(oref)
	publishAgentAsk(baseds.AgentAskData{ORef: oref, AskId: askId, Cleared: true})
	return nil
}
```

- [ ] **Step 5: Add the waiter-interaction test to `pkg/agentask/deliver_test.go`**

```go
func TestDeliverAnswerResolvesWaiterWithoutKeystrokes(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	var writes int
	orig := sendInput
	sendInput = func(string, []byte) error { writes++; return nil }
	defer func() { sendInput = orig }()
	ch := GlobalRegistry.RegisterWaiter("a1")

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	if writes != 0 {
		t.Fatalf("waiter path must not inject keystrokes, got %d writes", writes)
	}
	select {
	case res := <-ch:
		if res.Cancelled || len(res.Answers) != 1 {
			t.Fatalf("bad waiter result: %#v", res)
		}
	default:
		t.Fatal("waiter must be resolved")
	}
	// claim semantics preserved: the pending ask is gone after delivery
	if _, ok := GlobalRegistry.Get("tab:t1"); ok {
		t.Fatal("pending ask must be claimed")
	}
}
```

- [ ] **Step 6: Run all Go tests to verify they pass**

Run: `go test ./pkg/agentask/ ./pkg/wshrpc/wshserver/`
Expected: PASS (all new tests + existing). Note: if `./pkg/wshrpc/wshserver/` needs the CGO env on this machine, use the PowerShell `$env:CGO_CFLAGS="-I<repo>\pkg\jarvisembed\csrc"` prefix from Global Constraints; `./pkg/agentask/` never needs it.

- [ ] **Step 7: Regenerate bindings**

Run: `task generate`
Then verify the diff is additive: `git diff --stat pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts` — expect `AskCommand`/`AskRtnData`/`CommandAskData` updated with the new fields; nothing else changed.

- [ ] **Step 8: Checkpoint — report, no commit**

`git status --short` — expect the two Go source files, the new test file, `deliver_test.go`, and the three generated files. No commit.

---

### Task 3: CLI + wire type — `wsh ask --wait` / `--questions-json` / `preview`

**Files:**
- Modify: `pkg/baseds/baseds.go:127-130` (`AgentAskOption.Preview`)
- Modify: `cmd/wsh/cmd/wshcmd-ask.go`
- Modify: `cmd/wsh/cmd/wshcmd-ask_test.go`

**Interfaces:**
- Consumes: Task 2's `CommandAskData.Wait` / `AskRtnData.Answers|Cancelled`.
- Produces (used by Tasks 5–7): the CLI contract `wsh ask --wait [--questions-json <payload>]` → stdout `{"answers":[…],"cancelled":true|false}` JSON, exit 0 for answered or cancelled, non-zero on RPC failure; `--clear` unchanged. `AgentAskOption.Preview` on the wire type (after `task generate`, `preview` appears on the generated `AgentAskOption` in `frontend/types/gotypes.d.ts` and `frontend/app/store/wshclientapi.ts`).

- [ ] **Step 1: Write the failing tests** — append to `cmd/wsh/cmd/wshcmd-ask_test.go`:

```go
func TestFormatAskResult(t *testing.T) {
	rtn := wshrpc.AskRtnData{AskId: "a1", Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}, {Text: "custom"}}}
	got, err := formatAskResult(rtn)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"answers":[{"selectedindexes":[1]},{"text":"custom"}],"cancelled":false}`
	if string(got) != want {
		t.Fatalf("want %s, got %s", want, got)
	}
	cancelled, _ := formatAskResult(wshrpc.AskRtnData{AskId: "a1", Cancelled: true})
	if string(cancelled) != `{"answers":null,"cancelled":true}` {
		t.Fatalf("cancelled shape: %s", cancelled)
	}
}

func TestParseAskQuestionsKeepsPreview(t *testing.T) {
	raw := []byte(`{"questions":[{"question":"Q?","options":[{"label":"A","preview":"mockup A"},{"label":"B"}]}]}`)
	qs, err := parseAskQuestions(raw)
	if err != nil {
		t.Fatal(err)
	}
	if qs[0].Options[0].Preview != "mockup A" || qs[0].Options[1].Preview != "" {
		t.Fatalf("preview not carried: %#v", qs[0].Options)
	}
}
```

Add the imports `"github.com/wavetermdev/waveterm/pkg/baseds"` and `"github.com/wavetermdev/waveterm/pkg/wshrpc"` to the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./cmd/wsh/ -run 'TestFormatAskResult|TestParseAskQuestionsKeepsPreview' -v`
Expected: FAIL to compile — `formatAskResult` undefined; `Preview` field missing on the anonymous option struct.

- [ ] **Step 3: Add the wire field + regenerate**

In `pkg/baseds/baseds.go`:

```go
type AgentAskOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	// Preview is a markdown string rendered beside the option list (pi's rpiv-shaped
	// preview panels). CC never sends it; the cockpit ask UI renders it when present.
	Preview string `json:"preview,omitempty"`
}
```

Run: `task generate`
Run: `grep -n "preview" frontend/types/gotypes.d.ts | head -3`
Expected: `preview?: string` on the generated `AgentAskOption` (and the wshclient Go types). This is the verification that the field flowed through the generator.

- [ ] **Step 4: Implement the CLI changes** — `cmd/wsh/cmd/wshcmd-ask.go`

Add flags + timeout helper + result formatter, and rework `askRun`:

```go
var askWait bool
var askQuestionsJson string

// askWaitTimeout is the RPC ceiling for a blocked ask; the pi tool's own abort path
// (signal -> killed child -> ctx cancel) covers the "user gave up" case before this.
const askWaitTimeout = 30 * time.Minute

func init() {
	askCmd.Flags().BoolVar(&askClear, "clear", false, "clear the pending ask for this block (PostToolUse)")
	askCmd.Flags().BoolVar(&askWait, "wait", false, "block until answered and print the answers as JSON (pi ask bridge)")
	askCmd.Flags().StringVar(&askQuestionsJson, "questions-json", "", "questions container as inline JSON instead of stdin (pi ask bridge; pi.exec stdin is ignored)")
	rootCmd.AddCommand(askCmd)
}
```

In `askRun`, replace the stdin read + RPC call section:

```go
	if askClear && askWait {
		return fmt.Errorf("--clear and --wait are mutually exclusive")
	}

	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}
	if askQuestionsJson != "" {
		raw = []byte(askQuestionsJson)
	}
	questions, err := parseAskQuestions(raw)
	if err != nil {
		return err
	}

	timeout := 5000 * time.Millisecond
	if askWait {
		timeout = askWaitTimeout
	}
	rtn, err := wshclient.AskCommand(RpcClient, wshrpc.CommandAskData{ORef: oref.String(), Questions: questions, Wait: askWait}, &wshrpc.RpcOpts{Timeout: timeout})
	if err != nil {
		return err
	}
	if askWait {
		out, merr := formatAskResult(rtn)
		if merr != nil {
			return merr
		}
		fmt.Println(string(out))
	}
	return nil
}
```

Add the formatter (pure, next to `parseAskQuestions`):

```go
// formatAskResult renders the wait-mode reply as one JSON line. Cancelled is a legitimate
// outcome (dismissed/aborted), not an error: exit stays 0 either way.
func formatAskResult(rtn wshrpc.AskRtnData) ([]byte, error) {
	return json.Marshal(struct {
		Answers   []baseds.AgentAnswerItem `json:"answers"`
		Cancelled bool                     `json:"cancelled"`
	}{Answers: rtn.Answers, Cancelled: rtn.Cancelled})
}
```

Update `parseAskQuestions` to carry previews — add `Preview string \`json:"preview"\`` to the anonymous option struct and `Preview: o.Preview` to the mapping (the test above pins both directions: present and absent).

Imports needed: `"time"` in `cmd/wsh/cmd/wshcmd-ask.go` (json/fmt/io/os already present).

- [ ] **Step 5: Run the tests + build to verify they pass**

Run: `go test ./cmd/wsh/`
Expected: PASS — new tests + existing `TestParseAskQuestions*` tests unchanged.
Run: `go build ./pkg/baseds/ ./cmd/wsh/...`
Expected: exit 0.

- [ ] **Step 6: Checkpoint — report, no commit**

`git status --short` — expect only `pkg/baseds/baseds.go`, the CLI file + its test, and the generated bindings. No commit.

---

### Task 4: Frontend — preview end-to-end

**Files:**
- Create: `frontend/app/view/agents/answerbarpreview.ts`
- Create: `frontend/app/view/agents/answerbarpreview.test.ts`
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:55-58` (AgentAskOption) and `:753-770` (`withAsk` mapping)
- Modify: `frontend/app/view/agents/answerbar.tsx` (`QuestionGroup` preview layout)

**Interfaces:**
- Consumes: Task 3's `AgentAskOption.Preview` on the wire; `MarkdownMessage` from `./markdownmessage` (`export const MarkdownMessage = memo(function MarkdownMessage({ text, className }: { text: string; className?: string })`).
- Produces: `previewMode(question: AgentAskQuestion): boolean` and `activePreview(question: AgentAskQuestion, focusIndex: number): string | undefined` (pure, in `answerbarpreview.ts`); `QuestionGroup` renders the side-by-side layout when `previewMode`.

- [ ] **Step 1: Write the failing tests** — `frontend/app/view/agents/answerbarpreview.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activePreview, previewMode } from "./answerbarpreview";
import type { AgentAskQuestion } from "./agentsviewmodel";

const q = (over: Partial<AgentAskQuestion> = {}): AgentAskQuestion => ({
    question: "Q?",
    options: [
        { label: "A", preview: "mockup A" },
        { label: "B" },
    ],
    ...over,
});

describe("previewMode", () => {
    it("is true when any single-select option has a preview", () => {
        expect(previewMode(q())).toBe(true);
    });
    it("is false for multi-select questions (rpiv rule)", () => {
        expect(previewMode(q({ multiSelect: true }))).toBe(false);
    });
    it("is false when no option has a preview", () => {
        expect(previewMode(q({ options: [{ label: "A" }, { label: "B" }] }))).toBe(false);
    });
    it("is false when there are no options", () => {
        expect(previewMode(q({ options: [] }))).toBe(false);
    });
});

describe("activePreview", () => {
    it("returns the focused option's preview", () => {
        expect(activePreview(q(), 1)).toBe("mockup A");
    });
    it("returns undefined when the focused option has none", () => {
        expect(activePreview(q(), 0)).toBeUndefined();
    });
    it("clamps out-of-range focus to the first option", () => {
        expect(activePreview(q(), 99)).toBe("mockup A");
    });
    it("returns undefined when no option has a preview", () => {
        expect(activePreview(q({ options: [{ label: "A" }] }), 0)).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/answerbarpreview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure module** — `frontend/app/view/agents/answerbarpreview.ts`:

```ts
// Pure preview-layout logic for the answer surface, mirroring rpiv's rule: previews are
// single-select only, and the panel shows the focused option's preview.
import type { AgentAskQuestion } from "./agentsviewmodel";

export function previewMode(question: AgentAskQuestion): boolean {
    if (question.multiSelect) {
        return false;
    }
    return (question.options ?? []).some((o) => !!o.preview);
}

export function activePreview(question: AgentAskQuestion, focusIndex: number): string | undefined {
    const opts = question.options ?? [];
    if (opts.length === 0) {
        return undefined;
    }
    const i = Math.max(0, Math.min(focusIndex, opts.length - 1));
    return opts[i]?.preview || undefined;
}
```

(Note: `answerbarpreview.ts` is a plain frontend module — it does NOT need the pi no-op default export; that convention applies only to `pi/extensions/*` files.)

- [ ] **Step 4: VM type + mapping** — `frontend/app/view/agents/agentsviewmodel.ts`

```ts
export interface AgentAskOption {
    label: string;
    description?: string;
    preview?: string;
}
```

In `withAsk`, change the options mapping to:

```ts
options: q.options?.map((o) => ({ label: o.label, description: o.description, preview: o.preview })),
```

- [ ] **Step 5: Side-by-side layout** — `frontend/app/view/agents/answerbar.tsx`

Add imports (`MarkdownMessage` from `./markdownmessage`, `useState` from react, `previewMode`/`activePreview` from `./answerbarpreview`). In `QuestionGroup`, add focus state and the layout switch. The `stacked` branch becomes:

```tsx
    const stacked = options.some((o) => o.description);
    const withPreview = previewMode(question);
    const [focusIndex, setFocusIndex] = useState(0);
    // preview panel shows the hovered/focused option, defaulting to the first
    const preview = withPreview ? activePreview(question, focusIndex) : undefined;
    const optionList = (
        <div className="mt-2.5 flex flex-col gap-1.5">
            {options.map((opt, oi) => {
                const isSelected = selections.has(oi);
                const isRecommended = isRec(opt.label);
                const showNum = numbered && oi < 9;
                return (
                    <button
                        key={oi}
                        type="button"
                        onClick={() => onClickOption(oi)}
                        onMouseEnter={() => setFocusIndex(oi)}
                        onFocus={() => setFocusIndex(oi)}
                        className={cn(
                            "flex w-full cursor-pointer items-start gap-2.5 rounded border px-3 py-2 text-left",
                            isSelected
                                ? accent.selected
                                : isRecommended
                                  ? accent.rec
                                  : "border-border hover:bg-white/[0.04]"
                        )}
                    >
                        {showNum ? (
                            <span
                                className={cn(
                                    "mt-px inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px]",
                                    isSelected ? accent.numSel : "bg-black/30 text-secondary"
                                )}
                            >
                                {oi + 1}
                            </span>
                        ) : null}
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                                <span className="text-[12.5px] font-semibold text-primary">
                                    {cleanLabel(opt.label)}
                                </span>
                                {isRecommended ? (
                                    <span
                                        className={cn(
                                            "shrink-0 rounded-[5px] px-1.5 py-px font-mono text-[8.5px] font-semibold uppercase tracking-wide",
                                            accent.pill
                                        )}
                                    >
                                        recommended
                                    </span>
                                ) : null}
                            </span>
                            {opt.description ? (
                                <span
                                    className={cn(
                                        "mt-0.5 block text-[11px] leading-[1.45]",
                                        isSelected ? "text-primary/75" : "text-secondary"
                                    )}
                                >
                                    {opt.description}
                                </span>
                            ) : null}
                        </span>
                        {isSelected ? (
                            <span className={cn("mt-0.5 shrink-0 text-[13px]", accent.check)}>
                                {question.multiSelect ? "✓" : "●"}
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </div>
    );
```

Then, inside `QuestionGroup`, render either the plain stacked list or the side-by-side row (previews only render for the stacked layout — the chip layout never has descriptions anyway):

```tsx
            {options.length === 0 ? null : withPreview ? (
                <div className="mt-2.5 flex gap-3">
                    <div className="min-w-0 flex-1">{optionList}</div>
                    <div className="hidden w-[min(46%,340px)] shrink-0 rounded border border-border bg-black/20 p-3 md:block">
                        {preview ? (
                            <MarkdownMessage text={preview} className="text-[11.5px] leading-[1.5]" />
                        ) : (
                            <div className="text-[11px] text-muted">No preview</div>
                        )}
                    </div>
                </div>
            ) : stacked ? (
                optionList
            ) : (
                ...existing chip branch unchanged...
            )}
```

Notes: `MarkdownMessage`'s `className` prop exists (memoized component, `text` + `className`). The preview panel hides below `md` breakpoints so narrow rails don't collapse (keyboard focus still selects previews; the layout is a progressive enhancement).

- [ ] **Step 6: Run the tests + typecheck to verify they pass**

Run: `npx vitest run frontend/app/view/agents/answerbarpreview.test.ts`
Expected: PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Checkpoint — report, no commit**

---

### Task 5: Frontend — dismiss button on the answer surface

**Files:**
- Modify: `frontend/app/view/agents/answerbar.tsx` (`AnswerBar` props + render)
- Modify: `frontend/app/view/agents/agentrow.tsx:530-545` (wire `onDismiss`)
- Modify: `frontend/app/view/agents/channelsprimitives.tsx:100-109` (wire `onDismiss` in `AskRow`)

**Interfaces:**
- Consumes: `RpcApi.AgentAskClearCommand(TabRpcClient, oref)` from `@/app/store/wshclientapi` (exists); `agent.ask?.oref` on `AgentVM` (exists); `fireAndForget` from `@/util/util`.
- Produces: `AnswerBar` prop `onDismiss?: () => void` — when provided, a small ✕ control renders at the top-right of the answer band and clears the pending ask. Task 8 verifies the round trip (dismiss → waiter cancelled).

- [ ] **Step 1: Add the prop + render** — `frontend/app/view/agents/answerbar.tsx`

In the `AnswerBar` props type and destructuring, add `onDismiss?: () => void`. Render a top-right dismiss row when provided. Change the two return sites (single-question and multi-question) to include it; the simplest is a header row above the content:

```tsx
    const dismissControl = onDismiss ? (
        <div className="mb-1 flex justify-end">
            <button
                type="button"
                onClick={onDismiss}
                title="Dismiss this question (pi: cancels the ask; claude: closes the panel copy)"
                className="cursor-pointer rounded-sm px-1.5 py-0.5 text-[11px] text-muted hover:bg-white/[0.04] hover:text-secondary"
            >
                ✕
            </button>
        </div>
    ) : null;
```

Single-question return becomes:

```tsx
    if (questions.length === 1) {
        const hint = answerHint(questions, selections, !!numbered);
        return (
            <div className={className}>
                {dismissControl}
                {renderGroup(0)}
                {hint ? <div className="mt-2 text-[11px] text-secondary">{hint}</div> : null}
            </div>
        );
    }
```

Multi-question return gets `{dismissControl}` inserted as the first child of the root div.

- [ ] **Step 2: Wire agentrow.tsx** — add the RPC imports (agentrow.tsx has none today) and the `onDismiss` prop on the `AnswerBar` call at `frontend/app/view/agents/agentrow.tsx:531`.

Imports to add (same paths as `agents.tsx:7-9`):

```ts
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
```

On the `AnswerBar` call:

```tsx
                        onDismiss={
                            agent.ask?.oref
                                ? () => fireAndForget(() => RpcApi.AgentAskClearCommand(TabRpcClient, agent.ask!.oref!))
                                : undefined
                        }
```

- [ ] **Step 3: Wire channelsprimitives.tsx** — same imports (add if absent) and the same `onDismiss` prop on the `AskRow` `AnswerBar` call at `frontend/app/view/agents/channelsprimitives.tsx:100`.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx prettier --check frontend/app/view/agents/answerbar.tsx frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/channelsprimitives.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/answerbarpreview.ts frontend/app/view/agents/answerbarpreview.test.ts`
Expected: clean (run `npx prettier --write` on those files if not).

- [ ] **Step 5: Checkpoint — report, no commit**

---

### Task 6: Pi extension — ask tool + core module

**Files:**
- Create: `pi/extensions/waveterm-ask-core.ts`
- Create: `pi/extensions/waveterm-ask-core.test.ts`
- Create: `pi/extensions/waveterm-ask.ts`
- Modify: `pi/package.json` (`pi.extensions`)

**Interfaces:**
- Consumes: Task 3's CLI contract (`wsh ask --wait --questions-json <json>` → stdout `{"answers":[…],"cancelled":bool}`); `pi.registerTool`, `pi.exec` (returns `{stdout, stderr, code, killed}`, accepts `{signal}`).
- Produces (used by Task 7): the `ask_user_question` tool (canonical name — arc's global-extension copy shadows rpiv via first-wins load order); core exports `buildAskPayload(questions): string`, `parseAskResult(stdout): AskResult`, `buildAskEnvelope(result, questions)`, `DECLINE_MESSAGE`/`ENVELOPE_PREFIX`/`ENVELOPE_SUFFIX`.

- [ ] **Step 1: Write the failing tests** — `pi/extensions/waveterm-ask-core.test.ts` (mirrors `waveterm-tools-core.test.ts` style — plain vitest, no imports outside the module):

```ts
import { describe, expect, it } from "vitest";
import {
    buildAskEnvelope,
    buildAskPayload,
    parseAskResult,
    DECLINE_MESSAGE,
    ENVELOPE_PREFIX,
    ENVELOPE_SUFFIX,
} from "./waveterm-ask-core";

const QUESTIONS = [
    {
        question: "A or B?",
        header: "Pick",
        multiSelect: false,
        options: [
            { label: "A", description: "option A", preview: "mockup A" },
            { label: "B" },
        ],
    },
];

describe("buildAskPayload", () => {
    it("emits the questions container the wsh ask parser accepts", () => {
        const payload = JSON.parse(buildAskPayload(QUESTIONS));
        expect(payload.questions).toHaveLength(1);
        expect(payload.questions[0].options[0]).toEqual({
            label: "A",
            description: "option A",
            preview: "mockup A",
        });
        expect(payload.questions[0].options[1].preview).toBeUndefined();
    });
});

describe("parseAskResult", () => {
    it("parses the answered shape", () => {
        const r = parseAskResult(`{"answers":[{"selectedindexes":[1]}],"cancelled":false}`);
        expect(r.cancelled).toBe(false);
        expect(r.answers[0].selectedindexes).toEqual([1]);
    });
    it("parses the cancelled shape", () => {
        const r = parseAskResult(`{"answers":null,"cancelled":true}`);
        expect(r.cancelled).toBe(true);
        expect(r.answers).toEqual([]);
    });
    it("throws on malformed output", () => {
        expect(() => parseAskResult("not json")).toThrow();
    });
});

describe("buildAskEnvelope", () => {
    it("formats the canonical answered envelope", () => {
        const env = buildAskEnvelope(
            { answers: [{ selectedindexes: [1] }], cancelled: false },
            QUESTIONS
        );
        expect(env.content[0].text).toBe(
            `${ENVELOPE_PREFIX} "A or B?"="B". ${ENVELOPE_SUFFIX}`
        );
        expect(env.details.answers[0]).toEqual({
            questionIndex: 0,
            question: "A or B?",
            selectedIndexes: [1],
        });
    });
    it("formats free-text answers verbatim", () => {
        const env = buildAskEnvelope({ answers: [{ text: "neither" }], cancelled: false }, QUESTIONS);
        expect(env.content[0].text).toBe(
            `${ENVELOPE_PREFIX} "A or B?"="neither". ${ENVELOPE_SUFFIX}`
        );
    });
    it("uses the decline message for cancelled", () => {
        const env = buildAskEnvelope({ answers: [], cancelled: true }, QUESTIONS);
        expect(env.content[0].text).toBe(DECLINE_MESSAGE);
        expect(env.details.cancelled).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run pi/extensions/waveterm-ask-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the core module** — `pi/extensions/waveterm-ask-core.ts` (no external imports, default export no-op, per the `waveterm-tools-core.ts` convention):

```ts
// Pure helpers for the pi ask bridge extension. No external imports so the repo's vitest
// can cover it. The default export is a no-op: pi auto-loads every file in the extensions
// directory, and this module is a dependency, not an extension.

export interface AskOptionInput {
    label: string;
    description?: string;
    preview?: string;
}

export interface AskQuestionInput {
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: AskOptionInput[];
}

export interface AskAnswerItem {
    selectedindexes?: number[];
    text?: string;
}

export interface AskResult {
    answers: AskAnswerItem[];
    cancelled: boolean;
}

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

// buildAskPayload serializes the questions for wsh ask --questions-json. Omit empty
// fields so the payload stays as small as argv allows; preview rides along for the
// cockpit's side-by-side render.
export function buildAskPayload(questions: AskQuestionInput[]): string {
    return JSON.stringify({
        questions: questions.map((q) => ({
            question: q.question,
            header: q.header || undefined,
            multiSelect: q.multiSelect || undefined,
            options: q.options.map((o) => ({
                label: o.label,
                description: o.description || undefined,
                preview: o.preview || undefined,
            })),
        })),
    });
}

// parseAskResult parses wsh ask --wait's stdout line. A null answers array (cancelled
// without answers) normalizes to [].
export function parseAskResult(stdout: string): AskResult {
    const j = JSON.parse(stdout);
    if (typeof j?.cancelled !== "boolean") {
        throw new Error("malformed ask result: missing cancelled");
    }
    const answers: AskAnswerItem[] = Array.isArray(j.answers) ? j.answers : [];
    return { answers, cancelled: j.cancelled };
}

// buildAskEnvelope maps the wsh result onto the rpiv-shaped tool envelope so the model
// sees the same canonical answered/declined signals whether the questionnaire ran in the
// pi TUI or in the Wave panel.
export function buildAskEnvelope(
    result: AskResult,
    questions: AskQuestionInput[]
): { content: { type: "text"; text: string }[]; details: { answers: unknown[]; cancelled: boolean } } {
    if (result.cancelled) {
        return {
            content: [{ type: "text", text: DECLINE_MESSAGE }],
            details: { answers: [], cancelled: true },
        };
    }
    const segments = questions.map((q, qi) => {
        const a = result.answers[qi] ?? { selectedindexes: [] };
        const answerText = a.text ?? (a.selectedindexes ?? []).map((i) => q.options[i]?.label ?? `option ${i + 1}`).join(", ");
        return `"${q.question}"="${answerText}"`;
    });
    const details = result.answers.map((a, qi) => ({
        questionIndex: qi,
        question: questions[qi]?.question ?? "",
        ...(a.text !== undefined ? { text: a.text } : { selectedIndexes: a.selectedindexes ?? [] }),
    }));
    return {
        content: [{ type: "text", text: `${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}` }],
        details: { answers: details, cancelled: false },
    };
}

export default function wavetermAskCore(): void {
    // no-op dependency module
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run pi/extensions/waveterm-ask-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the extension** — `pi/extensions/waveterm-ask.ts` (mirrors `waveterm-tools.ts`'s structure; `__WSH_PATH__` is substituted at install time):

```ts
// pi extension: the ask bridge (workstream F). Installed by `wsh install-agent-hooks` into
// ~/.pi/agent/extensions/waveterm-ask.ts with __WSH_PATH__ substituted for the absolute wsh
// path. Registers the canonical ask_user_question tool; questions surface in the Wave Agents
// panel (attention list) instead of pi's terminal questionnaire. Bare pi outside a Wave block
// fails closed with a plain-text fallback instruction.
import { Type } from "typebox";
import { buildAskEnvelope, buildAskPayload, parseAskResult } from "./waveterm-ask-core";

export function registerAskTool(pi: any, wshPath: string): void {
    pi.registerTool({
        name: "ask_user_question",
        label: "Ask User Question (Wave)",
        description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

The questions surface in the Wave Agents panel; the user answers there and the tool resumes with the answers.

Usage notes:
- Each question MUST have 2-4 options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or dismiss the ask (which returns a decline). Do NOT author "Other" or "Type something." labels yourself.
- Use multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only; the preview panel shows the focused option.
- Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.`,
        promptSnippet:
            "Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous",
        promptGuidelines: [
            "Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions.",
            "Questions render in the Wave Agents panel, not the terminal questionnaire.",
            "preview is supported for single-select questions only; the panel shows the focused option's preview.",
        ],
        parameters: Type.Object({
            questions: Type.Array(
                Type.Object({
                    question: Type.String({ description: "The complete question to ask" }),
                    header: Type.Optional(
                        Type.String({ description: "Short tag shown next to the question (max 16 chars)" })
                    ),
                    multiSelect: Type.Optional(
                        Type.Boolean({ description: "Allow multiple answers (default false)" })
                    ),
                    options: Type.Array(
                        Type.Object({
                            label: Type.String({ description: "Concise label (1-5 words, max 60 chars)" }),
                            description: Type.Optional(
                                Type.String({ description: "What this choice means or its trade-offs" })
                            ),
                            preview: Type.Optional(
                                Type.String({
                                    description:
                                        "Markdown content shown beside the option list (single-select only)",
                                })
                            ),
                        }),
                        { minItems: 2, maxItems: 4 }
                    ),
                }),
                { minItems: 1, maxItems: 4 }
            ),
        }),
        async execute(_toolCallId: string, params: any, signal: AbortSignal): Promise<unknown> {
            const payload = buildAskPayload(params.questions);
            try {
                const { stdout, killed } = await pi.exec(
                    wshPath,
                    ["ask", "--wait", "--questions-json", payload],
                    { signal }
                );
                if (killed) {
                    // user aborted the tool call (Esc) — same decline signal as dismissing
                    return buildAskEnvelope({ answers: [], cancelled: true }, params.questions);
                }
                return buildAskEnvelope(parseAskResult(stdout), params.questions);
            } catch (e) {
                // not in a Wave block, wsh missing, RPC failure — fail closed: the user never
                // saw the questions, so the model must re-ask them as plain chat text.
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Wave ask unavailable (${String(e)}). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead.`,
                        },
                    ],
                    details: { answers: [], cancelled: true },
                };
            }
        },
    });
}

export default function wavetermAsk(pi: any): void {
    registerAskTool(pi, "__WSH_PATH__");
}
```

- [ ] **Step 6: Register in the package manifest** — `pi/package.json`

```json
        "extensions": [
            "./extensions/waveterm-status.ts",
            "./extensions/waveterm-tools.ts",
            "./extensions/waveterm-tools-core.ts",
            "./extensions/waveterm-ask.ts",
            "./extensions/waveterm-ask-core.ts"
        ],
```

- [ ] **Step 7: Run the full vitest suite for the extensions + typecheck**

Run: `npx vitest run pi/extensions/`
Expected: PASS (new core tests + existing status/tools tests).
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: Checkpoint — report, no commit**

---

### Task 7: Provisioning — sync:piartifacts + installhooks

**Files:**
- Modify: `Taskfile.yml` (`sync:piartifacts` — add the two copies)
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go` (embed + `installPiAskExtension` + call)
- Generate: `cmd/wsh/cmd/pi-ask-extension.ts`, `cmd/wsh/cmd/pi-ask-core-extension.ts` (via `task sync:piartifacts` — never hand-edit)
- Modify: `cmd/wsh/cmd/piartifact_test.go` (embed-sync tests)

**Interfaces:**
- Consumes: Task 6's `pi/extensions/waveterm-ask.ts` + `waveterm-ask-core.ts`.
- Produces: `wsh install-agent-hooks` installs `~/.pi/agent/extensions/waveterm-ask.ts` (+ core) with the wsh path substituted — the arc tool shadows rpiv's `ask_user_question` via pi's global-extensions-first load order.

- [ ] **Step 1: Taskfile sync entries** — in `Taskfile.yml` `sync:piartifacts`, add to `cmds` (after the existing four `cp` lines):

```yaml
            - cmd: cp pi/extensions/waveterm-ask.ts cmd/wsh/cmd/pi-ask-extension.ts
            - cmd: cp pi/extensions/waveterm-ask-core.ts cmd/wsh/cmd/pi-ask-core-extension.ts
```

add to `sources` (after the existing four):

```yaml
            - pi/extensions/waveterm-ask.ts
            - pi/extensions/waveterm-ask-core.ts
```

and add to `generates` (after the existing four):

```yaml
            - cmd/wsh/cmd/pi-ask-extension.ts
            - cmd/wsh/cmd/pi-ask-core-extension.ts
```

- [ ] **Step 2: Generate the embed copies**

Run: `task sync:piartifacts`
Expected: `cmd/wsh/cmd/pi-ask-extension.ts` and `cmd/wsh/cmd/pi-ask-core-extension.ts` now exist, byte-identical to the `pi/extensions/` sources.

- [ ] **Step 3: Embed + installer** — `cmd/wsh/cmd/wshcmd-installhooks.go`

Add next to the other pi embeds:

```go
//go:embed pi-ask-extension.ts
var piAskExtensionTemplate string

//go:embed pi-ask-core-extension.ts
var piAskCoreExtensionTemplate string
```

Add the installer (tools pattern — no idempotence check, matching `installPiToolsExtension`):

```go
// installPiAskExtension writes the Wave ask-bridge extension pair into pi's global extension
// directory, where pi auto-loads every file. Same contract as installPiToolsExtension:
// __WSH_PATH__ is replaced with the absolute wsh exe path on the tool file; the core module
// has no placeholder.
func installPiAskExtension(home string) error {
	if _, err := piLookPath("pi"); err != nil {
		return nil // pi not installed; nothing to hook
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving wsh path: %w", err)
	}
	dir := filepath.Join(home, ".pi", "agent", "extensions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating pi extensions dir: %w", err)
	}
	tool := strings.ReplaceAll(piAskExtensionTemplate, `"__WSH_PATH__"`, jsonString(exe))
	if err := os.WriteFile(filepath.Join(dir, "waveterm-ask.ts"), []byte(tool), 0o644); err != nil {
		return fmt.Errorf("writing waveterm-ask.ts: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "waveterm-ask-core.ts"), []byte(piAskCoreExtensionTemplate), 0o644); err != nil {
		return fmt.Errorf("writing waveterm-ask-core.ts: %w", err)
	}
	return nil
}
```

Call it in `installAgentHooksRun`, after `installPiToolsExtension(home)`:

```go
	if err := installPiAskExtension(home); err != nil {
		return err
	}
```

- [ ] **Step 4: Embed-sync tests** — append to `cmd/wsh/cmd/piartifact_test.go`:

```go
func TestEmbeddedPiAskExtensionMatchesPackage(t *testing.T) {
	want := readRepoFile(t, "pi/extensions/waveterm-ask.ts")
	if piAskExtensionTemplate != want {
		t.Fatalf("piAskExtensionTemplate != pi/extensions/waveterm-ask.ts\nrun: task sync:piartifacts")
	}
}

func TestEmbeddedPiAskCoreExtensionMatchesPackage(t *testing.T) {
	want := readRepoFile(t, "pi/extensions/waveterm-ask-core.ts")
	if piAskCoreExtensionTemplate != want {
		t.Fatalf("piAskCoreExtensionTemplate != pi/extensions/waveterm-ask-core.ts\nrun: task sync:piartifacts")
	}
}
```

- [ ] **Step 5: Build + tests**

Run: `go test ./cmd/wsh/`
Expected: PASS — the new embed tests plus existing installhooks/artifact tests.
Run: `go build ./cmd/wsh/... ./pkg/wshrpc/... ./pkg/wshclient/...`
Expected: exit 0.

- [ ] **Step 6: Checkpoint — report, no commit**

---

### Task 8: Full verification + diff review

- [ ] **Step 1: Run the full verification suite**

- `go test ./pkg/agentask/ ./cmd/wsh/` — PASS expected. If `./pkg/wshrpc/wshserver/` needs it, prefix with the PowerShell CGO env from Global Constraints.
- `npx vitest run pi/extensions/ frontend/app/view/agents/answerbarpreview.test.ts` — PASS expected.
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — exit 0 expected.
- `npx prettier --check` on every changed file — clean expected.
- `task verify:ui -- surface-smoke` — may be SKIPPED if no dev app is running on :9222 (note it, don't fake it). If a dev app IS running, also drive the ask flow: an ask with a preview option renders side-by-side; the ✕ dismiss clears the band.

- [ ] **Step 2: Live round-trip (requires `task dev` + pi installed)**

In a Wave block, run a pi session and prompt it to call `ask_user_question` (or run a scratch session with the extension loaded). Verify: the question appears in the Agents panel attention list; answering resumes the tool with the envelope text; dismissing returns `User declined to answer questions`; Esc during the tool call cancels; with `@juicesharp/rpiv-ask-user-question` also installed, the arc tool wins (first-wins load order — the panel shows the ask, not pi's TUI overlay). Report what was and wasn't verified.

- [ ] **Step 3: Self-review the diff**

`git status` + `git diff --stat`. Check: no commented-out code, no debug statements, no stray changes outside the files listed in Tasks 1–7 plus generated files, the spec, and this plan. Confirm generated files (`wshclientapi.ts`, `gotypes.d.ts`, `wshclient.go`, `pi-ask-extension.ts`, `pi-ask-core-extension.ts`) contain only the additive changes for the new fields/tools.

- [ ] **Step 4: Present for approval — do not commit**

Summarize the changed files and verification results. Per AGENTS.md, commits require explicit user approval; when approved, create ONE commit:

```bash
git add pkg/agentask/ pkg/wshrpc/wshrpctypes_ask.go pkg/wshrpc/wshserver/wshserver_ask.go pkg/wshrpc/wshserver/wshserver_ask_test.go pkg/wshrpc/wshclient/wshclient.go pkg/baseds/baseds.go cmd/wsh/cmd/wshcmd-ask.go cmd/wsh/cmd/wshcmd-ask_test.go cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/pi-ask-extension.ts cmd/wsh/cmd/pi-ask-core-extension.ts cmd/wsh/cmd/piartifact_test.go Taskfile.yml pi/extensions/waveterm-ask.ts pi/extensions/waveterm-ask-core.ts pi/extensions/waveterm-ask-core.test.ts pi/package.json frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts frontend/app/view/agents/answerbar.tsx frontend/app/view/agents/answerbarpreview.ts frontend/app/view/agents/answerbarpreview.test.ts frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentrow.tsx frontend/app/view/agents/channelsprimitives.tsx docs/superpowers/specs/2026-08-12-pi-ask-bridge-design.md docs/superpowers/plans/2026-08-12-pi-ask-bridge.md
git commit -m "feat(pi): ask bridge — pi ask_user_question routes through the Wave panel (workstream F)"
```
