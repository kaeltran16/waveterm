# Jarvis (Gatekeeper tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grant Jarvis one new verb — answering a worker's ask — so a channel you toggle on auto-answers routine `AskUserQuestion` picks and escalates genuine forks to you.

**Architecture:** A per-channel `gatekeeper:enabled` meta flag. A server-side watcher (`pkg/jarvis`) is hooked into the single `publishAgentAsk` choke point; on a pending ask for a worker owned by an enabled channel it resolves the channel, pre-filters un-answerable asks, runs a headless `claude -p` (via `pkg/consult`) that returns a structured decision, then either delivers the answer (via a shared `agentask.DeliverAnswer`) and posts a `jarvis-answered` row, or posts a `jarvis-escalation` row addressing `@you`. Model judges; code owns plumbing and the fail-safe-to-escalate invariant.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/agentask`, `pkg/wshrpc`, reusing `pkg/consult`), React 19 + jotai + Tailwind v4 (@theme tokens), Go `testing`, vitest, Chrome DevTools Protocol for live verification.

**Depends on:** the shipped Concierge tier (`pkg/jarvis` does **not** yet exist; the FE `JarvisRow`, jarvis message kinds, and `activeChannelAtom` do). This plan creates `pkg/jarvis`.

**Deviations from the spec (intentional, discovered while grounding against shipped code):**
- **Watcher is a hook, not a subscription.** `wps.Broker` dispatches only to a single websocket client — there is no in-process Go handler. The watcher is `jarvis.OnAgentAsk(data)` called from `publishAgentAsk` in `wshserver.go`.
- **Shared answer fn lives in `pkg/agentask`** (`DeliverAnswer`), which is imported only by `wshserver` today, so it can take a `blockcontroller` dep with no cycle.
- **Decision carries an option `*int` index**, not an id — `agentask.EncodeAnswer` selects by index, and a pointer lets a missing index fail safe to escalate.
- **Deterministic pre-filter**: multi-question / multi-select asks escalate with no model call (`EncodeAnswer` can't deliver them anyway).
- **New standalone FE rows** `jarvis-answered` / `jarvis-escalation` render via a small `GatekeeperRow`, not the query+reply-grouped `JarvisRow`.

---

## File structure

- **Create** `pkg/agentask/deliver.go` — `DeliverAnswer(oref, answers) (bool, error)`; injectable `sendInput` seam.
- **Create** `pkg/agentask/deliver_test.go` — no-pending and delivers tests.
- **Modify** `pkg/wshrpc/wshserver/wshserver.go` — `AnswerAgentCommand` calls `DeliverAnswer`; `publishAgentAsk` calls `jarvis.OnAgentAsk`; add `SetChannelGatekeeperCommand`.
- **Create** `pkg/jarvis/resolve.go` — `MetaKey_GatekeeperEnabled`, `ResolveGatekeeperChannel`, `workerTaskFor`.
- **Create** `pkg/jarvis/resolve_test.go` — resolver tests.
- **Create** `pkg/jarvis/classify.go` — `Decision`, `BuildClassifyPrompt`, `ParseDecision`, `Classify`.
- **Create** `pkg/jarvis/classify_test.go` — prompt-builder + parser (fail-safe) tests.
- **Create** `pkg/jarvis/watcher.go` — `OnAgentAsk`, `handleAsk`, `postAnswered`, `postEscalation`, `postJarvis`.
- **Modify** `pkg/wshrpc/wshrpctypes.go` — `CommandSetChannelGatekeeperData` + interface method.
- **Regenerate** `frontend/app/store/wshclientapi.ts` + Go client via `task generate` (never hand-edit).
- **Modify** `frontend/app/view/agents/channelssurface.tsx` — header toggle + `GatekeeperRow` + route the two new kinds.

---

### Task 1: `agentask.DeliverAnswer` (shared answer path, Go)

**Files:**
- Create: `pkg/agentask/deliver.go`
- Test: `pkg/agentask/deliver_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (`AnswerAgentCommand`, ~line 1964)

- [ ] **Step 1: Write the failing tests**

Create `pkg/agentask/deliver_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func oneQuestion() []baseds.AgentAskQuestion {
	return []baseds.AgentAskQuestion{{
		Question: "A or B?",
		Options:  []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}},
	}}
}

func TestDeliverAnswer_NoPending(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	delivered, err := DeliverAnswer("tab:none", []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}})
	if err != nil || delivered {
		t.Fatalf("want (false,nil), got (%v,%v)", delivered, err)
	}
}

func TestDeliverAnswer_Delivers(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", PendingAsk{AskId: "a1", BlockId: "b1", Questions: oneQuestion()})
	var got [][]byte
	orig := sendInput
	sendInput = func(blockId string, data []byte) error { got = append(got, data); return nil }
	defer func() { sendInput = orig }()

	delivered, err := DeliverAnswer("tab:t1", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	// index 1 => one downArrow + enter
	if len(got) != 2 {
		t.Fatalf("want 2 keystrokes for index 1, got %d", len(got))
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/agentask/ -run TestDeliverAnswer`
Expected: FAIL — `undefined: DeliverAnswer`, `undefined: sendInput`.

- [ ] **Step 3: Implement `deliver.go`**

Create `pkg/agentask/deliver.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
)

// sendInput is indirected so tests can capture keystrokes without a live block PTY.
var sendInput = func(blockId string, data []byte) error {
	return blockcontroller.SendInput(blockId, &blockcontroller.BlockInputUnion{InputData: data})
}

// DeliverAnswer injects answers into the pending ask's native picker for oref. It returns
// delivered=false with no error when no ask is pending (already answered in the terminal or
// cleared) — the idempotent no-op both AnswerAgentCommand and the Gatekeeper actuator rely on.
// It delivers one keystroke per PTY write with KeystrokeDelay between each (a single combined
// write races the picker's React state and confirms the wrong option).
func DeliverAnswer(oref string, answers []baseds.AgentAnswerItem) (bool, error) {
	pending, ok := GlobalRegistry.Get(oref)
	if !ok {
		return false, nil
	}
	keys, err := EncodeAnswer(pending.Questions, answers)
	if err != nil {
		return false, err
	}
	for i, k := range keys {
		if i > 0 {
			time.Sleep(KeystrokeDelay)
		}
		if err := sendInput(pending.BlockId, k); err != nil {
			return false, err
		}
	}
	return true, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentask/ -run TestDeliverAnswer`
Expected: PASS (2 tests).

- [ ] **Step 5: Rewire `AnswerAgentCommand` to use `DeliverAnswer`**

In `pkg/wshrpc/wshserver/wshserver.go`, replace the body of `AnswerAgentCommand` (~lines 1964-1989) with:

```go
func (ws *WshServer) AnswerAgentCommand(ctx context.Context, data wshrpc.CommandAnswerAgentData) error {
	if data.ORef == "" {
		return fmt.Errorf("oref is required")
	}
	_, err := agentask.DeliverAnswer(data.ORef, data.Answers)
	return err
}
```

- [ ] **Step 6: Build to verify it compiles (no import cycle)**

Run: `go build ./pkg/...`
Expected: no errors. (Confirms `agentask` → `blockcontroller` introduces no cycle.)

- [ ] **Step 7: Commit**

```bash
git add pkg/agentask/deliver.go pkg/agentask/deliver_test.go pkg/wshrpc/wshserver/wshserver.go
git commit -m "refactor(agentask): extract DeliverAnswer shared by AnswerAgentCommand + gatekeeper"
```

---

### Task 2: `pkg/jarvis` package + channel resolver (Go)

**Files:**
- Create: `pkg/jarvis/resolve.go`
- Test: `pkg/jarvis/resolve_test.go`

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvis/resolve_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func ch(name string, enabled bool, msgs ...waveobj.ChannelMessage) *waveobj.Channel {
	meta := waveobj.MetaMapType{}
	if enabled {
		meta[MetaKey_GatekeeperEnabled] = true
	}
	return &waveobj.Channel{OID: name, Name: name, Meta: meta, Messages: msgs}
}
func dispatch(oref, text string) waveobj.ChannelMessage {
	return waveobj.ChannelMessage{Kind: "dispatch", Author: "claude", Text: text, RefORef: oref}
}

func TestResolve_EnabledOwner(t *testing.T) {
	c := ch("c1", true, dispatch("tab:t1", "harden webhooks"))
	got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t1")
	if got == nil || got.OID != "c1" {
		t.Fatalf("want c1, got %v", got)
	}
	if task := workerTaskFor(c, "tab:t1"); task != "harden webhooks" {
		t.Fatalf("want task, got %q", task)
	}
}

func TestResolve_NotEnabledIgnored(t *testing.T) {
	c := ch("c1", false, dispatch("tab:t1", "x"))
	if got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t1"); got != nil {
		t.Fatalf("want nil for disabled channel, got %v", got)
	}
}

func TestResolve_NoOwner(t *testing.T) {
	c := ch("c1", true, dispatch("tab:t1", "x"))
	if got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t2"); got != nil {
		t.Fatalf("want nil for unowned oref, got %v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/`
Expected: FAIL — package `pkg/jarvis` does not exist / undefined symbols.

- [ ] **Step 3: Implement `resolve.go`**

Create `pkg/jarvis/resolve.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvis is the home for the Jarvis manager's acting tiers. This tier (Gatekeeper) watches
// for worker asks on gatekeeper-enabled channels, classifies them with a headless claude, and either
// auto-answers routine ones or escalates genuine forks. Concierge (read+post) is separate for now.
package jarvis

import "github.com/wavetermdev/waveterm/pkg/waveobj"

// MetaKey_GatekeeperEnabled is the per-channel bool flag toggling Gatekeeper for that channel.
const MetaKey_GatekeeperEnabled = "gatekeeper:enabled"

// ResolveGatekeeperChannel returns the gatekeeper-enabled channel that dispatched the worker at
// askingORef ("tab:<id>"), or nil. A channel owns a worker if it has a dispatch/directive message
// whose RefORef equals askingORef. First enabled owner wins (a worker in one channel is the norm).
func ResolveGatekeeperChannel(channels []*waveobj.Channel, askingORef string) *waveobj.Channel {
	for _, ch := range channels {
		if !ch.Meta.GetBool(MetaKey_GatekeeperEnabled, false) {
			continue
		}
		for _, m := range ch.Messages {
			if (m.Kind == "dispatch" || m.Kind == "directive") && m.RefORef == askingORef {
				return ch
			}
		}
	}
	return nil
}

// workerTaskFor returns the dispatch text for a worker oref (its task), or "" if not found.
func workerTaskFor(ch *waveobj.Channel, askingORef string) string {
	for _, m := range ch.Messages {
		if m.Kind == "dispatch" && m.RefORef == askingORef {
			return m.Text
		}
	}
	return ""
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/resolve.go pkg/jarvis/resolve_test.go
git commit -m "feat(jarvis): channel-ownership resolver + gatekeeper meta key"
```

---

### Task 3: `SetChannelGatekeeperCommand` (the toggle, Go)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerate: `frontend/app/store/wshclientapi.ts` (+ Go client) via `task generate`

Note: no Go unit test — this is a thin persist-and-notify command (like `PostChannelMessageCommand`); verified by compile + a clean `task generate` diff + the Task 7 CDP toggle.

- [ ] **Step 1: Add the RPC type + interface method**

In `pkg/wshrpc/wshrpctypes.go`, near `CommandPostChannelMessageData`:

```go
type CommandSetChannelGatekeeperData struct {
	ChannelId string `json:"channelid"`
	Enabled   bool   `json:"enabled"`
}
```

In `WshRpcInterface`, near `PostChannelMessageCommand`:

```go
	SetChannelGatekeeperCommand(ctx context.Context, data CommandSetChannelGatekeeperData) error // toggles Jarvis Gatekeeper (auto-answer routine asks) for a channel
```

- [ ] **Step 2: Implement the command**

In `pkg/wshrpc/wshserver/wshserver.go`, after `PostChannelMessageCommand` (~line 1620). Add `"github.com/wavetermdev/waveterm/pkg/jarvis"` to the imports:

```go
func (ws *WshServer) SetChannelGatekeeperCommand(ctx context.Context, data wshrpc.CommandSetChannelGatekeeperData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[jarvis.MetaKey_GatekeeperEnabled] = data.Enabled
	})
	if err != nil {
		return fmt.Errorf("updating channel gatekeeper flag: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 3: Regenerate bindings**

Run: `task generate`
Expected: `wshclientapi.ts` gains `SetChannelGatekeeperCommand` and `wshclient.go` gains its stub. `frontend/types/gotypes.d.ts` gains `CommandSetChannelGatekeeperData`. No other unexpected diffs.

- [ ] **Step 4: Build to verify it compiles**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go frontend/types/gotypes.d.ts
git commit -m "feat(jarvis): SetChannelGatekeeperCommand — per-channel gatekeeper toggle"
```

---

### Task 4: classifier — prompt builder + fail-safe parser (Go)

**Files:**
- Create: `pkg/jarvis/classify.go`
- Test: `pkg/jarvis/classify_test.go`

Note: `Classify` (the `consult.Run` wrapper) is pure delegation to a real CLI, like Concierge's `JarvisCommand`; it has no unit test. `BuildClassifyPrompt` and `ParseDecision` (the safety-critical part) are unit-tested here.

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvis/classify_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func aQuestion() baseds.AgentAskQuestion {
	return baseds.AgentAskQuestion{
		Question: "Which migration?",
		Options:  []baseds.AgentAskOption{{Label: "Use existing"}, {Label: "Create new"}},
	}
}

func TestBuildClassifyPrompt_Contents(t *testing.T) {
	c := &waveobj.Channel{Name: "payments-api"}
	p := BuildClassifyPrompt(aQuestion(), "harden webhooks", c)
	for _, want := range []string{"Which migration?", "0", "Use existing", "1", "Create new", "harden webhooks", "JSON"} {
		if !contains(p, want) {
			t.Fatalf("prompt missing %q\n---\n%s", want, p)
		}
	}
}

func TestParseDecision_ValidAnswer(t *testing.T) {
	d := ParseDecision(`{"action":"answer","optionindex":0,"reason":"routine"}`)
	if d.Action != "answer" || d.OptionIndex == nil || *d.OptionIndex != 0 {
		t.Fatalf("want answer/0, got %+v", d)
	}
}

func TestParseDecision_FailsSafe(t *testing.T) {
	cases := []string{
		``,                                        // empty
		`not json at all`,                         // prose
		`{"action":"answer"}`,                     // missing optionindex
		`{"optionindex":0,"reason":"x"}`,          // missing action
		`{"action":"answer","optionindex":"a"}`,   // non-numeric index
		`{"action":"maybe","optionindex":0}`,      // unknown action
	}
	for _, in := range cases {
		if d := ParseDecision(in); d.Action != "escalate" {
			t.Fatalf("want escalate for %q, got %+v", in, d)
		}
	}
}

func TestParseDecision_ProseWrappedJSON(t *testing.T) {
	// the model sometimes wraps JSON in prose; we extract the object
	d := ParseDecision("Sure!\n```json\n{\"action\":\"escalate\",\"reason\":\"ambiguous\"}\n```")
	if d.Action != "escalate" {
		t.Fatalf("want escalate, got %+v", d)
	}
}

func contains(s, sub string) bool { return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0) }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run "Classify|ParseDecision"`
Expected: FAIL — `undefined: BuildClassifyPrompt`, `undefined: ParseDecision`.

- [ ] **Step 3: Implement `classify.go`**

Create `pkg/jarvis/classify.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const classifyTimeout = 120 * time.Second
const maxTimeline = 12

// Decision is the classifier's structured verdict. OptionIndex is a pointer so a missing index in
// the model's reply is distinguishable from index 0 and fails safe to escalate.
type Decision struct {
	Action      string `json:"action"` // "answer" | "escalate"
	OptionIndex *int   `json:"optionindex"`
	Reason      string `json:"reason"`
}

// BuildClassifyPrompt composes a JSON-only prompt: the single question + its indexed options, the
// worker's task, and a capped recent timeline. The model must return {action, optionindex, reason}.
func BuildClassifyPrompt(q baseds.AgentAskQuestion, task string, channel *waveobj.Channel) string {
	var opts strings.Builder
	for i, o := range q.Options {
		opts.WriteString(fmt.Sprintf("  %d: %s", i, o.Label))
		if o.Description != "" {
			opts.WriteString(" — " + o.Description)
		}
		opts.WriteString("\n")
	}
	timeline := recentTimeline(channel)
	if task == "" {
		task = "(unknown task)"
	}
	return strings.Join([]string{
		fmt.Sprintf(`You are Jarvis, gatekeeping a coding agent in the "%s" channel. A worker paused to ask a multiple-choice question. Decide whether it is ROUTINE (safe to auto-answer on the human's behalf) or a genuine FORK that needs the human.`, channel.Name),
		`Escalate (do NOT answer) if the choice is irreversible, changes product scope or user-facing behavior, is a real judgment call, or you are not confident. When in doubt, escalate.`,
		"",
		"Worker task: " + task,
		"Question: " + q.Question,
		"Options (index: label):",
		strings.TrimRight(opts.String(), "\n"),
		"",
		"Recent channel messages:",
		timeline,
		"",
		`Reply with ONLY a JSON object, no prose: {"action":"answer"|"escalate","optionindex":<int, required when action is answer>,"reason":"<one short sentence>"}`,
	}, "\n")
}

func recentTimeline(channel *waveobj.Channel) string {
	if channel == nil || len(channel.Messages) == 0 {
		return "(none)"
	}
	msgs := channel.Messages
	if len(msgs) > maxTimeline {
		msgs = msgs[len(msgs)-maxTimeline:]
	}
	var b strings.Builder
	for _, m := range msgs {
		b.WriteString(m.Author + ": " + m.Text + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// ParseDecision extracts the JSON object from the reply and validates it. ANY problem — no JSON,
// bad JSON, unknown action, or action=="answer" without a numeric optionindex — yields escalate.
// The model can never fail open into an auto-answer.
func ParseDecision(reply string) Decision {
	start := strings.Index(reply, "{")
	end := strings.LastIndex(reply, "}")
	if start < 0 || end <= start {
		return Decision{Action: "escalate", Reason: "unparseable classifier reply"}
	}
	var d Decision
	if err := json.Unmarshal([]byte(reply[start:end+1]), &d); err != nil {
		return Decision{Action: "escalate", Reason: "unparseable classifier reply"}
	}
	if d.Action != "answer" {
		return Decision{Action: "escalate", Reason: d.Reason}
	}
	if d.OptionIndex == nil {
		return Decision{Action: "escalate", Reason: "classifier gave no option index"}
	}
	return d
}

// Classify runs the headless claude classifier. It fails safe to escalate on any CLI/timeout error.
func Classify(ctx context.Context, channel *waveobj.Channel, q baseds.AgentAskQuestion, task string) Decision {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return Decision{Action: "escalate", Reason: "claude CLI unavailable"}
	}
	runCtx, cancel := context.WithTimeout(ctx, classifyTimeout)
	defer cancel()
	reply, err := consult.Run(runCtx, spec, channel.ProjectPath, BuildClassifyPrompt(q, task, channel), func(string) {})
	if err != nil {
		return Decision{Action: "escalate", Reason: "classifier error: " + err.Error()}
	}
	return ParseDecision(reply)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run "Classify|ParseDecision"`
Expected: PASS (4 tests). Then `go test ./pkg/jarvis/` — all Task 2 + Task 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/classify.go pkg/jarvis/classify_test.go
git commit -m "feat(jarvis): classifier prompt + fail-safe decision parser"
```

---

### Task 5: watcher — hook, pre-filter, actuator (Go)

**Files:**
- Create: `pkg/jarvis/watcher.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (`publishAgentAsk`, ~line 2004)

Note: `OnAgentAsk`/`handleAsk` orchestrate the real CLI + registry + PTY + DB, so like `JarvisCommand`/`ConsultCommand` they are verified by the Task 7 CDP run, not a Go unit test. The unit-testable pieces (resolver, pre-filter logic, parser) are covered in Tasks 2 and 4. The pre-filter branch is exercised end-to-end in Task 7 Step 4.

- [ ] **Step 1: Implement `watcher.go`**

Create `pkg/jarvis/watcher.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var (
	inflightLock sync.Mutex
	inflight     = map[string]context.CancelFunc{} // askId -> cancel
)

// OnAgentAsk is the server-side Gatekeeper entry point, called from publishAgentAsk for every ask
// and clear. It never blocks the publish path: real work runs in a goroutine. A Cleared event
// cancels any in-flight classification for that AskId.
func OnAgentAsk(data baseds.AgentAskData) {
	if data.Cleared {
		cancelInflight(data.AskId)
		return
	}
	if data.AskId == "" || data.ORef == "" {
		return
	}
	inflightLock.Lock()
	if _, dup := inflight[data.AskId]; dup {
		inflightLock.Unlock()
		return // the persisted event re-delivered; already handling
	}
	ctx, cancel := context.WithCancel(context.Background())
	inflight[data.AskId] = cancel
	inflightLock.Unlock()
	go func() {
		defer func() { panichandler.PanicHandler("jarvis.OnAgentAsk", recover()) }()
		defer cancelInflight(data.AskId)
		handleAsk(ctx, data)
	}()
}

func cancelInflight(askId string) {
	inflightLock.Lock()
	defer inflightLock.Unlock()
	if cancel, ok := inflight[askId]; ok {
		cancel()
		delete(inflight, askId)
	}
}

func handleAsk(ctx context.Context, data baseds.AgentAskData) {
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return
	}
	ch := ResolveGatekeeperChannel(channels, data.ORef)
	if ch == nil {
		return // not owned by any gatekeeper-enabled channel
	}
	// deterministic pre-filter: only a single single-select question is auto-answerable.
	if len(data.Questions) != 1 || data.Questions[0].MultiSelect {
		postEscalation(ch.OID, data, "needs a human (multiple or multi-select questions)")
		return
	}
	q := data.Questions[0]
	decision := Classify(ctx, ch, q, workerTaskFor(ch, data.ORef))
	if ctx.Err() != nil {
		return // cleared / cancelled mid-classification
	}
	if decision.Action == "answer" && decision.OptionIndex != nil {
		idx := *decision.OptionIndex
		if idx >= 0 && idx < len(q.Options) {
			delivered, derr := agentask.DeliverAnswer(data.ORef, []baseds.AgentAnswerItem{{SelectedIndexes: []int{idx}}})
			if derr == nil && delivered {
				postAnswered(ch.OID, q.Options[idx].Label, decision.Reason)
			}
			return
		}
	}
	postEscalation(ch.OID, data, decision.Reason)
}

func postAnswered(channelId, optionLabel, reason string) {
	text := fmt.Sprintf("Answered → %q", optionLabel)
	if reason != "" {
		text += " — " + reason
	}
	postJarvis(channelId, "jarvis-answered", text)
}

func postEscalation(channelId string, data baseds.AgentAskData, reason string) {
	var b strings.Builder
	b.WriteString("@you — your call")
	if reason != "" {
		b.WriteString(" (" + reason + ")")
	}
	b.WriteString("\n")
	if len(data.Questions) > 0 {
		q := data.Questions[0]
		b.WriteString(q.Question + "\n")
		for i, o := range q.Options {
			b.WriteString(fmt.Sprintf("  %d) %s\n", i, o.Label))
		}
	}
	postJarvis(channelId, "jarvis-escalation", strings.TrimRight(b.String(), "\n"))
}

func postJarvis(channelId, kind, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage(kind, "jarvis", text, "", time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, channelId, msg); err != nil {
		log.Printf("jarvis: post %s failed: %v", kind, err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
}
```

- [ ] **Step 2: Build to verify the package compiles**

Run: `go build ./pkg/jarvis/`
Expected: no errors. (If `panichandler` import path differs, match the one used in `wshserver.go`.)

- [ ] **Step 3: Hook the watcher into `publishAgentAsk`**

In `pkg/wshrpc/wshserver/wshserver.go`, in `publishAgentAsk` (~line 2004), call the watcher before publishing (the `jarvis` import was added in Task 3):

```go
func publishAgentAsk(data baseds.AgentAskData) {
	jarvis.OnAgentAsk(data) // Gatekeeper (server-side, non-blocking): auto-answer/escalate on enabled channels
	wps.Broker.Publish(wps.WaveEvent{
		Event:   wps.Event_AgentAsk,
		Scopes:  []string{data.ORef},
		Persist: 1,
		Data:    data,
	})
}
```

- [ ] **Step 4: Build the whole backend to verify no cycle**

Run: `go build ./pkg/...`
Expected: no errors. (Confirms `wshserver` → `jarvis` → {`agentask`,`consult`,`wstore`,`wcore`} has no import cycle.)

- [ ] **Step 5: Run all Go tests**

Run: `go test ./pkg/jarvis/ ./pkg/agentask/`
Expected: PASS (all Task 1/2/4 tests).

- [ ] **Step 6: Commit**

```bash
git add pkg/jarvis/watcher.go pkg/wshrpc/wshserver/wshserver.go
git commit -m "feat(jarvis): gatekeeper ask watcher — pre-filter, classify, auto-answer/escalate"
```

---

### Task 6: FE — channel toggle + gatekeeper row rendering

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx`

No new unit test: this is view wiring (a toggle calling a generated RPC + two message-kind render branches), consistent with how the Concierge `JarvisRow` branch was added without a vitest; verified by tsc + Task 7 CDP.

- [ ] **Step 1: Add the `GatekeeperRow` component**

In `channelssurface.tsx`, after the existing `JarvisRow` component (~line 220), add a standalone row for the two Gatekeeper kinds. `jarvis-answered` is a muted/confirmed card; `jarvis-escalation` is an amber attention card:

```tsx
function GatekeeperRow({ msg, now }: { msg: ChannelMessage; now: number }) {
    const escalated = msg.kind === "jarvis-escalation";
    return (
        <div className="flex items-start gap-3">
            <Avatar name="jarvis" />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">jarvis</span>
                    <Tag label={escalated ? "escalation" : "answered"} tone={escalated ? "warning" : "muted"} />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <div
                    className={
                        escalated
                            ? "rounded-[9px] border border-warning/40 bg-warning/10 px-3 py-2.5"
                            : "rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5"
                    }
                >
                    <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{msg.text}</div>
                </div>
            </div>
        </div>
    );
}
```

Note: if `Tag` has no `warning`/`muted` tone or `border-warning`/`bg-warning` tokens don't exist, use the nearest existing @theme tokens (mirror the amber treatment `JarvisRow` uses for its live "thinking" card, e.g. `border-accent/40 bg-accentbg/30`). Do not introduce raw hex — @theme tokens only.

- [ ] **Step 2: Route the two new kinds and keep them out of the default map**

In the message map (~line 377), extend the filter and add branches. Change the filter to also drop nothing new (these render as their own rows), and add the branches beside the `jarvis` one:

```tsx
                                    ) : m.kind === "jarvis" ? (
                                        <JarvisRow
                                            key={m.id}
                                            msg={m}
                                            allMessages={messages}
                                            streams={consultStreams}
                                            now={now}
                                        />
                                    ) : m.kind === "jarvis-answered" || m.kind === "jarvis-escalation" ? (
                                        <GatekeeperRow key={m.id} msg={m} now={now} />
                                    ) : (
                                        <MessageRow key={m.id} model={model} agents={agents} msg={m} now={now} />
                                    )
```

(The existing filter `m.kind !== "consult-reply" && m.kind !== "jarvis-reply"` stays as-is — `jarvis-answered`/`jarvis-escalation` are top-level rows, not grouped replies, so they must NOT be filtered out.)

- [ ] **Step 3: Add the per-channel Gatekeeper toggle to the channel header**

Locate the channel header area (where `active?.name` is rendered as the channel title). Add a toggle bound to the channel's meta flag. Near the top of the component body (beside `const agents = useAtomValue(model.agentsAtom);`), read the current state:

```tsx
    const gatekeeperOn = Boolean((active?.meta as Record<string, unknown> | undefined)?.["gatekeeper:enabled"]);
```

In the header JSX, add a labeled switch (use the existing switch/button primitive in the codebase; a minimal button toggle if none is imported):

```tsx
                    <button
                        type="button"
                        onClick={() =>
                            active &&
                            fireAndForget(() =>
                                RpcApi.SetChannelGatekeeperCommand(TabRpcClient, {
                                    channelid: active.oid,
                                    enabled: !gatekeeperOn,
                                })
                            )
                        }
                        title="Jarvis auto-answers routine asks in this channel; escalates genuine forks"
                        className={
                            gatekeeperOn
                                ? "rounded-[7px] border border-accent/50 bg-accentbg/40 px-2 py-1 font-mono text-[11px] text-accent-soft"
                                : "rounded-[7px] border border-edge-mid px-2 py-1 font-mono text-[11px] text-muted"
                        }
                    >
                        gatekeeper {gatekeeperOn ? "on" : "off"}
                    </button>
```

Ensure `RpcApi`, `TabRpcClient`, and `fireAndForget` are imported (they are already used in this file for the send path; if `RpcApi`/`TabRpcClient` are not yet imported here, add them from the same modules `channelactions.ts` uses).

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` errors — no new errors.

- [ ] **Step 5: Full test run**

Run: `npx vitest run`
Expected: full suite green (unchanged count — no new FE tests this tier).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(jarvis): channel gatekeeper toggle + answered/escalation rows"
```

---

### Task 7: end-to-end verification (live dev app, CDP)

**Files:** none (verification only).

- [ ] **Step 1: Rebuild the backend and launch the dev app**

The Go changes mean `wavesrv` must be rebuilt. Keep stdin open (project dev gotcha):

Run: `task build:backend` then `tail -f /dev/null | task dev`
(If `wavesrv` boot-errors on EOF, that stdin redirect is the fix. CDP `Page.reload` breaks Tauri boot — touch `src-tauri/` to relaunch instead.)

- [ ] **Step 2: Prepare a channel with a live worker**

Open the Channels tab. In a channel, dispatch a real Claude worker (`@claude <task>`) whose task will make it ask a routine `AskUserQuestion` (a multiple-choice with an obvious safe pick). Toggle the channel's **gatekeeper on**. Screenshot: `node scripts/cdp-shot.mjs gk-before.png`.

- [ ] **Step 3: Verify the auto-answer happy path**

Drive the worker to raise a routine single-select ask. Confirm via `node scripts/cdp-shot.mjs gk-answered.png`:
- the worker's picker is dismissed and it resumes (Gatekeeper answered), and
- a `jarvis` row tagged `answered` appears reading `Answered → "<option>" — <reason>` with the real chosen option.

- [ ] **Step 4: Verify the escalation path**

Drive the worker to raise a genuine fork (an ambiguous or irreversible choice) — or a multi-question/multi-select ask to exercise the deterministic pre-filter. Confirm via `node scripts/cdp-shot.mjs gk-escalated.png`:
- an amber `jarvis` row tagged `escalation` addressing `@you` with the question + options, and
- the worker's ask is **not** auto-answered (it stays pending until you answer via the existing ask surface).

- [ ] **Step 5: Verify the toggle-off path**

Toggle gatekeeper **off**. Drive another routine ask. Confirm it is **not** touched by Jarvis (no `jarvis-answered`/`jarvis-escalation` row appears) and you answer it normally.

- [ ] **Step 6: Record the verification result**

Note the CDP outcome in the PR/commit description. Do not commit large PNGs to the repo.

---

## Self-review

**1. Spec coverage:**
- Opt-in per-channel toggle → Task 3 (command) + Task 6 (UI). ✅
- Auto-answer routine + visible record; escalate the rest → Task 5 (`handleAsk`, `postAnswered`/`postEscalation`). ✅
- Stateless single-call classifier, fail-safe to escalate → Task 4 (`Classify`, `ParseDecision`). ✅
- Server-side watcher via hook (not subscribe) → Task 5 (`OnAgentAsk` + `publishAgentAsk` hook). ✅
- Per-channel scope (resolve dispatch/directive reforefs) → Task 2 (`ResolveGatekeeperChannel`). ✅
- Deterministic pre-filter (multi-question/multi-select escalate, no model call) → Task 5. ✅
- Shared `agentask.DeliverAnswer`, idempotent, returns delivered → Task 1. ✅
- Model-for-judgment/code-for-determinism → Task 4 model call vs Task 2/5 deterministic resolution + range check. ✅
- Claude-only → Task 4 (`consult.SpecFor("claude")`). ✅
- Error/uncertainty → escalate; never hang → Task 4 (CLI/timeout → escalate) + Task 5 (ctx cancel on cleared). ✅
- Distinct rows → Task 6 (`GatekeeperRow`, two kinds). ✅
- Testing: Go units (Tasks 1/2/4), tsc + vitest (Task 6), CDP (Task 7). ✅
- Deferred (make-a-rule, countdown, inline-answer buttons, bare-prose, multi-answer, Delegator) → not in any task, correctly out of scope. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step gives an exact command + expected result. The two @theme-token fallbacks in Task 6 are explicit instructions (use nearest existing token, no raw hex), not placeholders. ✅

**3. Type consistency:** `Decision{Action string; OptionIndex *int; Reason string}` is consistent across Task 4 (definition + parser) and Task 5 (consumer, nil-check + range-check). `DeliverAnswer(oref string, answers []baseds.AgentAnswerItem) (bool, error)` is consistent across Task 1 (definition), Task 1 Step 5 (`AnswerAgentCommand` caller), and Task 5 (actuator caller). `MetaKey_GatekeeperEnabled = "gatekeeper:enabled"` is consistent across Task 2 (definition), Task 3 (command writer), and Task 6 (FE reader, literal string matches). Message kinds `jarvis-answered` / `jarvis-escalation` (author `jarvis`, empty reforef) are consistent across Task 5 (post) and Task 6 (filter + route + render). `CommandSetChannelGatekeeperData{channelid, enabled}` matches the FE call in Task 6 (`{channelid: active.oid, enabled}`). ✅
