# Orchestrator Redesign Slice 3: Question Queue and Lead Wake

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A DAG child's question waits in a queue the lead owns. The engine types a `wake:` line into the lead's terminal when there is judgment work: questions, a failed task, a merge conflict, or the end of the run. The lead no longer polls `dag wait`, and the pi control-file plumbing that never worked is gone.

**Architecture:**
- The queue is the existing `agentask` registry. A DAG child's `PendingAsk` gains in-memory owner, deadline, note and delivery-miss fields. A typed answer counts as delivered only when the agent clears the ask.
- A new `orchestrate` wake adapter holds wake lines per owning run. It types them into the lead's block when the lead is alive and idle, confirms the wake by the lead's agent state turning `working`, retries once, and then treats the lead as dead (G8).
- The engine posts wake lines where it used to call `notifyLeadBestEffort`. The watchdog ticks the adapter, which also sweeps ask deadlines and unconfirmed deliveries.
- `wsh jarvis dag asks` prints every question of every lead-owned entry. `wsh jarvis dag forward` hands a task's open judgment to the human, and the run cockpit's child-ask card shows user-owned entries.
- `control.go`, the pi control RPCs, `dag wait`, `dag ack`, the control digest and the pi extension's control watcher are deleted.

**Tech Stack:** Go (agentask, orchestrate, wshrpc codegen via `task generate`), cobra (`cmd/wsh`), the pi TypeScript extension, React 19 + TypeScript + jotai, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md` §2 (Judgment events, Dead lead), §5 (Question queue), §6 (Waking the lead), §10 (the `dag wait` and pi control plumbing rows), §11 (F22/F23), §12 (Queue, Delivery, Wake adapter tests).

## Global Constraints

- **Harnesses:** Claude Code and pi only. One adapter serves both.
- **Constants** (spec §14, chosen not measured):
  - `LeadAskDeadline = 10 * time.Minute`
  - `WakeConfirmTimeout = 30 * time.Second`
  - `AnswerClearTimeout = 30 * time.Second`
- **Wake lines**, from spec §2 (the task id and failure kind vary):
  - `wake: 2 questions waiting. wsh jarvis dag asks` (`1 question waiting` for one)
  - `wake: task 4 failed (tests), retry spent. wsh jarvis dag status`
  - `wake: merge conflict landing task 5. git status`. The spec's "landing lane ending at task 5" needs lanes, which arrive in slice 4.
  - `wake: run finished. wsh jarvis dag status`
- **Not in this slice:**
  - the hung and Verify wake lines (slice 4)
  - launching a lead on the first judgment event of a plan-input run (slices 4-5)
  - typing the `/compact` handoff (slice 5)
- The queue fields (`Owner`, `Deadline`, `Note`, `Misses`, `ChannelId`, `RunId`, `TaskId`, `DagOID`) are in memory only. `DurableHook` does not persist them, so there is no migration. Nothing re-derives them after a restart, because a DAG child's ask never survives one:
  - only job-backed asks are restored (`InitDurablePendingAsks`, `pkg/agentask/durable.go`)
  - run workers use the in-process `cmd` controller (`makeWorkerBlockMeta`, `pkg/jarvis/runexec.go`), so a restart kills the child along with its question
- `wsh jarvis dag retry` and `dag skip` already exist (`dagAction("retry")` and `dagAction("skip")` in `cmd/wsh/cmd/wshcmd-jarvisdag.go`), so only `dag forward` is new.
- No emojis. Comments are lower case and say why, never what.
- Never hand-edit generated files:
  - Run `task generate` after changing a wshrpc, waveobj or wconfig type.
  - Run `task sync:piartifacts` after editing `pi/extensions/*`. It regenerates `cmd/wsh/cmd/pi-tools-extension.ts` and `pi-tools-core-extension.ts`.
- CGO packages (`wshrpc/wshserver`, and `jarvis`/`orchestrate` through their imports) need, from PowerShell at the repo root: `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (`npx tsc` overflows).
- Never `prettier --write` `scripts/*.mjs`.
- One commit for the slice, with this plan folded in. No co-author trailer, no push. Stage only this slice's files. Never stage the unrelated version bump in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` or `src-tauri/tauri.conf.json`.

## Task order

1. Queue fields and delivery confirmation (`pkg/agentask`).
2. Wake adapter (`pkg/orchestrate/wake.go`).
3. Raise, deadline sweep, forward and engine wake triggers (`pkg/orchestrate`). The old notify calls go; `control.go` stays until Task 5 so the server still compiles.
4. Server and CLI: `DagAskItem`, `dag asks`, `dag forward`, Gatekeeper skip, clear confirmation, status feed, prompt text.
5. Deletions: pi control plumbing, `dag wait`, `dag ack`, the control digest, then `task generate` and `task sync:piartifacts`.
6. Frontend: the user-owned ask card and the run-event kind cleanup.
7. Docs, live check, verify and commit.

---

### Task 1: Queue fields and delivery confirmation

**Files:**
- Modify: `pkg/agentask/agentask.go` (owner consts, `PendingAsk` fields, `Registry.clears`, `Update`, `ConfirmClear`, `ExpireClears`)
- Modify: `pkg/agentask/deliver.go` (`injectAnswer` registers a typed DAG answer)
- Create: `pkg/agentask/queue_test.go` (a new file: `agentask_test.go` already exists and the Write tool would replace it)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `const AskOwner_Lead = "lead"`, `const AskOwner_User = "user"`
  - `const AnswerClearTimeout = 30 * time.Second`
  - `const AnswerUnconfirmedNote = "answer was sent but never confirmed"`
  - `PendingAsk` fields `Owner string`, `Deadline int64`, `Note string`, `Misses int`, `ChannelId string`, `RunId string`, `TaskId string`, `DagOID string`
  - `func (r *Registry) Update(oref, askId string, fn func(*PendingAsk)) bool`
  - `func (r *Registry) ConfirmClear(oref string) bool`
  - `func (r *Registry) ExpireClears(now int64, timeout time.Duration) map[string]PendingAsk`

- [ ] **Step 1: Write the failing tests**

Create `pkg/agentask/queue_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func dagPending(askId string) PendingAsk {
	return PendingAsk{AskId: askId, BlockId: "b1", Questions: oneQuestion(), Owner: AskOwner_Lead, RunId: "run-1", TaskId: "t-0"}
}

func stubKeys(t *testing.T) {
	t.Helper()
	orig := sendInput
	sendInput = func(string, []byte) error { return nil }
	t.Cleanup(func() { sendInput = orig })
}

func answerFirst() []baseds.AgentAnswerItem {
	return []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}}
}

func TestUpdateEditsInMemoryWithoutPersisting(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("block:b1", dagPending("a1"))
	var persisted int
	origHook := DurableHook
	DurableHook = func(string, *PendingAsk) { persisted++ }
	defer func() { DurableHook = origHook }()

	if !GlobalRegistry.Update("block:b1", "a1", func(p *PendingAsk) { p.Owner = AskOwner_User; p.Note = "yours" }) {
		t.Fatal("update of a pending ask must succeed")
	}
	got, _ := GlobalRegistry.Get("block:b1")
	if got.Owner != AskOwner_User || got.Note != "yours" {
		t.Fatalf("update not applied: %+v", got)
	}
	if persisted != 0 {
		t.Fatalf("queue fields are in memory only, DurableHook ran %d times", persisted)
	}
	if GlobalRegistry.Update("block:b1", "stale", func(p *PendingAsk) { p.Owner = AskOwner_Lead }) {
		t.Fatal("a stale ask id must not update")
	}
	if GlobalRegistry.Update("block:none", "", func(p *PendingAsk) {}) {
		t.Fatal("an absent ask must not update")
	}
}

func TestTypedDagAnswerAwaitsClear(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	GlobalRegistry.Set("block:b1", dagPending("a1"))

	if ok, err := DeliverAnswer("block:b1", "", answerFirst()); err != nil || !ok {
		t.Fatalf("want delivered, got (%v, %v)", ok, err)
	}
	if !GlobalRegistry.ConfirmClear("block:b1") {
		t.Fatal("a typed dag answer must wait for the agent's clear")
	}
	if GlobalRegistry.ConfirmClear("block:b1") {
		t.Fatal("a clear confirms once")
	}
}

func TestUnconfirmedAnswerReturnsToOwner(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	GlobalRegistry.Set("block:b1", dagPending("a1"))
	if ok, _ := DeliverAnswer("block:b1", "", answerFirst()); !ok {
		t.Fatal("want delivered")
	}

	if got := GlobalRegistry.ExpireClears(time.Now().UnixMilli(), AnswerClearTimeout); len(got) != 0 {
		t.Fatalf("nothing expires before the timeout, got %+v", got)
	}
	later := time.Now().Add(AnswerClearTimeout + time.Second).UnixMilli()
	got := GlobalRegistry.ExpireClears(later, AnswerClearTimeout)
	p, ok := got["block:b1"]
	if !ok || p.Owner != AskOwner_Lead || p.Misses != 1 || p.Note != AnswerUnconfirmedNote {
		t.Fatalf("want the ask back with its lead owner and one miss, got %+v", got)
	}
	if _, live := GlobalRegistry.Get("block:b1"); !live {
		t.Fatal("the restored ask must be pending again")
	}
}

func TestSecondUnconfirmedAnswerGoesToUser(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	GlobalRegistry.Set("block:b1", dagPending("a1"))
	later := time.Now().Add(AnswerClearTimeout + time.Second).UnixMilli()
	for i := 0; i < 2; i++ {
		if ok, _ := DeliverAnswer("block:b1", "", answerFirst()); !ok {
			t.Fatalf("delivery %d: want delivered", i+1)
		}
		GlobalRegistry.ExpireClears(later, AnswerClearTimeout)
	}
	got, _ := GlobalRegistry.Get("block:b1")
	if got.Owner != AskOwner_User || got.Misses != 2 {
		t.Fatalf("a second failed delivery moves the ask to the user, got %+v", got)
	}
}

func TestExpireClearsDropsWhenChildMovedOn(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	GlobalRegistry.Set("block:b1", dagPending("a1"))
	if ok, _ := DeliverAnswer("block:b1", "", answerFirst()); !ok {
		t.Fatal("want delivered")
	}
	GlobalRegistry.Set("block:b1", dagPending("a2"))

	later := time.Now().Add(AnswerClearTimeout + time.Second).UnixMilli()
	if got := GlobalRegistry.ExpireClears(later, AnswerClearTimeout); len(got) != 0 {
		t.Fatalf("a new ask on the block means the answer landed, got %+v", got)
	}
	if cur, _ := GlobalRegistry.Get("block:b1"); cur.AskId != "a2" {
		t.Fatalf("the child's new ask must be untouched, got %+v", cur)
	}
}

func TestOnlyTypedDagAnswersAwaitClear(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	plain := dagPending("a1")
	plain.Owner = ""
	GlobalRegistry.Set("block:plain", plain)
	if ok, _ := DeliverAnswer("block:plain", "", answerFirst()); !ok {
		t.Fatal("want delivered")
	}
	if GlobalRegistry.ConfirmClear("block:plain") {
		t.Fatal("an ask outside a dag keeps today's fire-and-forget delivery")
	}

	GlobalRegistry.Set("block:pi", dagPending("a2"))
	GlobalRegistry.RegisterWaiter("a2")
	if ok, _ := DeliverAnswer("block:pi", "", answerFirst()); !ok {
		t.Fatal("want delivered")
	}
	if GlobalRegistry.ConfirmClear("block:pi") {
		t.Fatal("a resolved waiter is the delivery; there is no clear to wait for")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/agentask/ -run "TestUpdateEdits|TestTypedDagAnswer|TestUnconfirmedAnswer|TestSecondUnconfirmed|TestExpireClears|TestOnlyTypedDag"`
Expected: FAIL to build with `unknown field Owner in struct literal`, `undefined: AskOwner_Lead` and `GlobalRegistry.Update undefined`.

- [ ] **Step 3: Add the queue fields and registry methods**

In `pkg/agentask/agentask.go`, change the import block to:

```go
import (
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)
```

Insert above `// PendingAsk is the question set currently awaiting an answer for a block.`:

```go
// Owners of a dag child's ask. Only asks raised by dag children have one; the queue is how the lead
// and the human take turns on a question, and every other ask keeps Owner "".
const (
	AskOwner_Lead = "lead"
	AskOwner_User = "user"
)

// AnswerClearTimeout bounds how long a typed answer may go unconfirmed. Hook delivery is sub-second;
// this absorbs a slow turn start.
const AnswerClearTimeout = 30 * time.Second

// AnswerUnconfirmedNote is the note on an ask whose typed answer never cleared it.
const AnswerUnconfirmedNote = "answer was sent but never confirmed"

// a second unconfirmed delivery means typing into this child does not work, so the human takes it.
const maxDeliveryMisses = 2
```

Add these fields at the end of `PendingAsk`, after `Wait bool`:

```go
	// the fields below are set only for an ask raised by a dag child. They live in memory only:
	// DurableHook does not store them, and a dag child's ask never survives a restart to need them.
	Owner string
	// Deadline is the UnixMilli past which a lead-owned ask moves to the user.
	Deadline int64
	// Note says why the ask is with its owner: the lead's forward note, a missed deadline, a failed delivery.
	Note string
	// Misses counts typed answers the agent never cleared.
	Misses    int
	ChannelId string
	// RunId is the dag's owning run, the one the lead works in.
	RunId  string
	TaskId string
	DagOID string
```

Replace the `Registry` struct and `MakeRegistry` with:

```go
type Registry struct {
	lock    sync.Mutex
	pending map[string]PendingAsk
	// clears holds typed dag answers waiting for the agent's clear, keyed by oref.
	clears map[string]sentAnswer
	waits  waiters
}

// sentAnswer is a claimed ask whose answer was typed but not yet confirmed.
type sentAnswer struct {
	pending PendingAsk
	sentAt  int64
}

func MakeRegistry() *Registry {
	return &Registry{pending: make(map[string]PendingAsk), clears: make(map[string]sentAnswer)}
}
```

Append at the end of the file:

```go
// Update edits a pending ask in place. It skips DurableHook because it exists for the queue fields,
// which are not stored; callers must not use it to change a stored field. It returns false when
// nothing is pending, or when askId != "" and no longer matches.
func (r *Registry) Update(oref, askId string, fn func(*PendingAsk)) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	p, ok := r.pending[oref]
	if !ok || (askId != "" && p.AskId != askId) {
		return false
	}
	fn(&p)
	r.pending[oref] = p
	return true
}

func (r *Registry) awaitClear(oref string, p PendingAsk, now int64) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.clears[oref] = sentAnswer{pending: p, sentAt: now}
}

// ConfirmClear ends the wait on a typed answer. The agent clearing its ask is the only proof the
// keystrokes reached the picker.
func (r *Registry) ConfirmClear(oref string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	_, ok := r.clears[oref]
	delete(r.clears, oref)
	return ok
}

// ExpireClears puts back every typed answer the agent did not clear within timeout, keyed by oref.
// The ask returns to its owner with the failure noted, and to the user on the second miss. A block
// that already holds a new ask moved on, so its answer did land and nothing is restored.
func (r *Registry) ExpireClears(now int64, timeout time.Duration) map[string]PendingAsk {
	r.lock.Lock()
	defer r.lock.Unlock()
	restored := make(map[string]PendingAsk)
	for oref, s := range r.clears {
		if now-s.sentAt < timeout.Milliseconds() {
			continue
		}
		delete(r.clears, oref)
		if _, live := r.pending[oref]; live {
			continue
		}
		p := s.pending
		p.Misses++
		p.Note = AnswerUnconfirmedNote
		if p.Misses >= maxDeliveryMisses {
			p.Owner = AskOwner_User
		}
		r.pending[oref] = p
		if DurableHook != nil {
			DurableHook(oref, &p)
		}
		restored[oref] = p
	}
	return restored
}
```

- [ ] **Step 4: Register a typed DAG answer in `injectAnswer`**

In `pkg/agentask/deliver.go`, replace the tail of `injectAnswer`:

```go
	for i, k := range keys {
		if i > 0 {
			time.Sleep(KeystrokeDelay)
		}
		if err := sendInput(pending.BlockId, k); err != nil {
			return false, err // partial prefix already sent — do NOT restore
		}
	}
	return true, nil
}
```

with:

```go
	for i, k := range keys {
		if i > 0 {
			time.Sleep(KeystrokeDelay)
		}
		if err := sendInput(pending.BlockId, k); err != nil {
			return false, err // partial prefix already sent — do NOT restore
		}
	}
	// a dag child's answer is not delivered until the child clears the ask (spec §5): keystrokes into
	// a picker that was not listening vanish, and nothing else would notice the child still waiting.
	if pending.Owner != "" {
		GlobalRegistry.awaitClear(oref, pending, time.Now().UnixMilli())
	}
	return true, nil
}
```

- [ ] **Step 5: Run the package tests**

Run: `go test ./pkg/agentask/`
Expected: PASS, including the existing `deliver_test.go` and `durable_test.go`.

---

### Task 2: Wake adapter

**Files:**
- Modify: `pkg/waveobj/runevent.go` (three new run event kinds)
- Create: `pkg/orchestrate/wake.go`
- Create: `pkg/orchestrate/wake_test.go`

**Interfaces:**
- Consumes (Task 1): `agentask.AskOwner_Lead`, `agentask.AskOwner_User`, `PendingAsk.Owner/Note/Misses/ChannelId/RunId/TaskId/DagOID`, `Registry.Update`.
- Produces:
  - `waveobj.RunEventKindTaskForwarded = "task-forwarded"`, `RunEventKindLeadWoken = "lead-woken"`, `RunEventKindLeadWakeFailed = "lead-wake-failed"`
  - `const LeadAskDeadline = 10 * time.Minute`, `const WakeConfirmTimeout = 30 * time.Second`
  - `func PostWake(ctx context.Context, channelId, runId, line string)`
  - `func PokeWake(ctx context.Context, channelId, runId string)`
  - `func NoteLeadStatus(ctx context.Context, ev *wps.WaveEvent)`
  - `func LeadDead(runId string) bool`
  - `func tickWakes(ctx context.Context)` (package-internal, called by the watchdog in Task 3)
  - `func forwardAskToUser(ctx context.Context, oref string, p agentask.PendingAsk, note string) bool` (package-internal, reused by Task 3)
  - `func publishChildAsk(p agentask.PendingAsk)` (package-internal, reused by Task 3)
  - test seams `leadStateFn`, `sendWakeFn`, `wakeNow`, and `wakes = newWaker()`

**Design notes** (read before coding):
- The state is per owning run (the dag's `RunID`, where the lead works). It holds:
  - the held wake lines
  - the lead's block and tab ids, as last read
  - `sentAt` of the unconfirmed wake, and whether it was retried
  - `dead`
  - the set of asks already announced, keyed `askId/misses`, so an ask restored after a failed delivery is announced again
- **Precondition:** the lead is alive and at its prompt. `idle` counts, and so does `waiting`: a Claude lead left at its prompt reports `waiting` through the idle Notification hook, and Claude run workers launch with `--dangerously-skip-permissions` (`pkg/jarvis/runexec.go:42`), so `waiting` is not a permission dialog. `asking` does not count, because the lead's own question to the human would swallow the text.
- **Send:** bracketed paste of the joined lines, then Enter after `agentask.KeystrokeDelay`, asynchronously.
- **Retry:** presses Enter alone. The text is already in the lead's input, so resending it would duplicate the wake.
- A lead not running, or a second unconfirmed wake, marks the lead dead:
  - One `lead-wake-failed` row carries the reason and any held lines.
  - Every lead-owned ask moves to the user.
  - While dead, each new event goes straight onto its own `lead-wake-failed` row, where the human sees it, and each new question goes to the user (G8).
  - A `working` status from the lead clears `dead`.
- The waker lock is held across the store reads in a flush. That keeps two concurrent flushes from typing the same wake twice. Nothing the flush calls re-enters the waker.

- [ ] **Step 1: Add the run event kinds**

In `pkg/waveobj/runevent.go`, insert after `RunEventKindLeadControlAcknowledged = "lead-control-acknowledged"` (line 58). Task 5 deletes the lead-control kinds; adding next to them keeps this task compiling on its own.

```go

	// the question queue and the lead wake (orchestrator redesign §5, §6):
	//   task-forwarded    a task's open judgment handed to the human, with why ("taskid", "askid", "note")
	//   lead-woken        a wake typed into the lead's terminal ("text")
	//   lead-wake-failed  the lead cannot take wakes; its judgment goes to the human ("reason", "lines")
	RunEventKindTaskForwarded  = "task-forwarded"
	RunEventKindLeadWoken      = "lead-woken"
	RunEventKindLeadWakeFailed = "lead-wake-failed"
```

- [ ] **Step 2: Write the failing tests**

Create `pkg/orchestrate/wake_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

const (
	wakeChannel   = "ch-1"
	wakeRun       = "run-1"
	wakeLeadBlock = "5b1e0a52-2d5c-4c3b-9d8e-0f3b7c1a9e01"
	wakeLeadTab   = "7c2f1b63-3e6d-4d4c-8e9f-1a4c8d2b0f12"
	finishedLine  = "wake: run finished. wsh jarvis dag status"
)

// fakeLead scripts the lead's block and records what the adapter typed and appended.
type fakeLead struct {
	state leadState
	sends []string // "" is Enter alone
	rows  []map[string]any
	now   int64
}

func newFakeLead(t *testing.T) *fakeLead {
	t.Helper()
	f := &fakeLead{
		state: leadState{BlockId: wakeLeadBlock, TabId: wakeLeadTab, Alive: true, State: baseds.AgentState_Idle},
		now:   1_000_000,
	}
	origWakes, origState, origSend, origNow, origAppend, origReg := wakes, leadStateFn, sendWakeFn, wakeNow, appendRunEvent, agentask.GlobalRegistry
	wakes = newWaker()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	leadStateFn = func(context.Context, string, string) leadState { return f.state }
	sendWakeFn = func(_ string, text string) { f.sends = append(f.sends, text) }
	wakeNow = func() int64 { return f.now }
	appendRunEvent = func(_ context.Context, _, _, kind string, _ *int, detail any) {
		row := map[string]any{"eventkind": kind}
		if d, ok := detail.(map[string]any); ok {
			for k, v := range d {
				row[k] = v
			}
		}
		f.rows = append(f.rows, row)
	}
	t.Cleanup(func() {
		wakes, leadStateFn, sendWakeFn, wakeNow, appendRunEvent, agentask.GlobalRegistry = origWakes, origState, origSend, origNow, origAppend, origReg
	})
	return f
}

// status moves the scripted lead to state and returns the event its hook would publish.
func (f *fakeLead) status(state string) *wps.WaveEvent {
	f.state.State = state
	oref := waveobj.MakeORef(waveobj.OType_Block, wakeLeadBlock).String()
	return &wps.WaveEvent{Event: wps.Event_AgentStatus, Data: baseds.AgentStatusData{ORef: oref, State: state}}
}

func (f *fakeLead) countKind(kind string) int {
	n := 0
	for _, r := range f.rows {
		if r["eventkind"] == kind {
			n++
		}
	}
	return n
}

func seedLeadAsk(oref, askId string, questions int) {
	qs := make([]baseds.AgentAskQuestion, questions)
	for i := range qs {
		qs[i] = baseds.AgentAskQuestion{Question: "which way?", Options: []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}}}
	}
	agentask.GlobalRegistry.Set(oref, agentask.PendingAsk{
		AskId: askId, BlockId: "child", Questions: qs,
		Owner: agentask.AskOwner_Lead, ChannelId: wakeChannel, RunId: wakeRun, TaskId: "t-0", DagOID: "dag-1",
	})
}

func TestWakeSendsToIdleLead(t *testing.T) {
	f := newFakeLead(t)
	PostWake(context.Background(), wakeChannel, wakeRun, finishedLine)
	if len(f.sends) != 1 || f.sends[0] != finishedLine {
		t.Fatalf("an idle lead gets the wake at once, got %q", f.sends)
	}
	if f.countKind(waveobj.RunEventKindLeadWoken) != 1 {
		t.Fatalf("a sent wake records one lead-woken row, got %+v", f.rows)
	}
}

func TestWakeTreatsWaitingAsAtPrompt(t *testing.T) {
	f := newFakeLead(t)
	f.state.State = baseds.AgentState_Waiting
	PostWake(context.Background(), wakeChannel, wakeRun, finishedLine)
	if len(f.sends) != 1 {
		t.Fatalf("a Claude lead idle past a minute reports waiting and must still be woken, got %q", f.sends)
	}
}

func TestWakeJoinsEventsHeldForBusyLead(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	for _, state := range []string{baseds.AgentState_Working, baseds.AgentState_Asking} {
		f.state.State = state
		PostWake(ctx, wakeChannel, wakeRun, "wake: task t-1 failed (tests), retry spent. wsh jarvis dag status")
		if len(f.sends) != 0 {
			t.Fatalf("a %s lead gets nothing yet, got %q", state, f.sends)
		}
	}
	PostWake(ctx, wakeChannel, wakeRun, "wake: merge conflict landing task t-2. git status")
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	want := "wake: task t-1 failed (tests), retry spent. wsh jarvis dag status\n" +
		"wake: task t-1 failed (tests), retry spent. wsh jarvis dag status\n" +
		"wake: merge conflict landing task t-2. git status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("held events go out as one message when the lead goes idle, got %q", f.sends)
	}
}

func TestWakeConfirmedByWorkingIsNotRetried(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)
	PostWake(ctx, wakeChannel, wakeRun, "wake: second")
	if len(f.sends) != 1 {
		t.Fatalf("no second wake while one is outstanding, got %q", f.sends)
	}
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	f.now += 3 * WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if len(f.sends) != 1 {
		t.Fatalf("a confirmed wake is never retried, got %q", f.sends)
	}
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 2 || f.sends[1] != "wake: second" {
		t.Fatalf("the held event goes out when the lead is idle again, got %q", f.sends)
	}
}

func TestWakeRetriesOnceThenLeadIsDead(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	PostWake(ctx, wakeChannel, wakeRun, finishedLine)

	f.now += WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if len(f.sends) != 2 || f.sends[1] != "" {
		t.Fatalf("the single retry presses Enter alone, got %q", f.sends)
	}
	if LeadDead(wakeRun) {
		t.Fatal("one unconfirmed wake is not a dead lead")
	}

	f.now += WakeConfirmTimeout.Milliseconds()
	tickWakes(ctx)
	if !LeadDead(wakeRun) || len(f.sends) != 2 {
		t.Fatalf("an unconfirmed retry makes the lead dead with no further sends, dead=%v sends=%q", LeadDead(wakeRun), f.sends)
	}
	if f.countKind(waveobj.RunEventKindLeadWakeFailed) != 1 {
		t.Fatalf("want one lead-wake-failed row, got %+v", f.rows)
	}

	PostWake(ctx, wakeChannel, wakeRun, "wake: merge conflict landing task t-2. git status")
	if len(f.sends) != 2 || f.countKind(waveobj.RunEventKindLeadWakeFailed) != 2 {
		t.Fatalf("a dead lead's events go on the timeline, not into its terminal: sends=%q rows=%+v", f.sends, f.rows)
	}

	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	if LeadDead(wakeRun) {
		t.Fatal("a lead that reports working is taking wakes again")
	}
}

func TestWakeToExitedLeadMovesQuestionsToUser(t *testing.T) {
	f := newFakeLead(t)
	f.state.Alive = false
	seedLeadAsk("block:child-1", "a1", 1)

	PokeWake(context.Background(), wakeChannel, wakeRun)

	if len(f.sends) != 0 || !LeadDead(wakeRun) {
		t.Fatalf("an exited lead is dead and gets nothing typed, dead=%v sends=%q", LeadDead(wakeRun), f.sends)
	}
	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || p.Note != leadNotRunningNote {
		t.Fatalf("a dead lead's questions move to the user with the reason, got %+v", p)
	}
	if f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want one task-forwarded row, got %+v", f.rows)
	}
}

func TestWakeAnnouncesEachQuestionOnce(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	seedLeadAsk("block:child-1", "a1", 1)
	PokeWake(ctx, wakeChannel, wakeRun)
	if len(f.sends) != 1 || f.sends[0] != "wake: 1 question waiting. wsh jarvis dag asks" {
		t.Fatalf("want the one-question line, got %q", f.sends)
	}

	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
	if len(f.sends) != 1 {
		t.Fatalf("an announced question does not wake the lead again, got %q", f.sends)
	}

	seedLeadAsk("block:child-2", "a2", 2)
	PokeWake(ctx, wakeChannel, wakeRun)
	if len(f.sends) != 2 || f.sends[1] != "wake: 3 questions waiting. wsh jarvis dag asks" {
		t.Fatalf("a new ask wakes the lead with the queue's question count, got %q", f.sends)
	}
}

func TestWakeReannouncesRestoredQuestion(t *testing.T) {
	f := newFakeLead(t)
	ctx := context.Background()
	seedLeadAsk("block:child-1", "a1", 1)
	PokeWake(ctx, wakeChannel, wakeRun)
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	agentask.GlobalRegistry.Update("block:child-1", "a1", func(p *agentask.PendingAsk) { p.Misses = 1 })

	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))

	if len(f.sends) != 2 {
		t.Fatalf("a question back after a failed delivery is announced again, got %q", f.sends)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (PowerShell, repo root, CGO flags set): `go test ./pkg/orchestrate/ -run "TestWake"`
Expected: FAIL to build with `undefined: leadState`, `undefined: PostWake` and `undefined: newWaker`.

- [ ] **Step 4: Write the adapter**

Create `pkg/orchestrate/wake.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// LeadAskDeadline is how long the lead owns a child's question before it moves to the human: above
	// the 155s worst compaction plus a Read/Grep answer, below the 15m stall threshold.
	LeadAskDeadline = 10 * time.Minute
	// WakeConfirmTimeout is how long a typed wake may go without the lead turning working.
	WakeConfirmTimeout = 30 * time.Second
)

// why a lead stopped getting wakes; each lands on the lead-wake-failed row and on every ask it hands over.
const (
	leadNotRunningNote  = "lead process is not running"
	wakeUnconfirmedNote = "lead did not respond to a wake"
	leadDeadNote        = "lead is not taking wakes"
)

type leadState struct {
	BlockId string
	TabId   string
	Alive   bool
	State   string
}

// leadStateFn reads the lead's block, whether its process runs and its latest agent state. A var so
// tests can script the lead without a live block.
var leadStateFn = readLeadState

// sendWakeFn types a wake into the lead's block; text "" presses Enter alone. A var for tests.
var sendWakeFn = typeWake

var wakeNow = func() int64 { return time.Now().UnixMilli() }

type runWake struct {
	channelId string
	lines     []string
	blockId   string
	tabId     string
	// sentAt is the UnixMilli of the unconfirmed wake, 0 when none is outstanding.
	sentAt  int64
	retried bool
	dead    bool
	told    map[string]bool
}

type waker struct {
	lock sync.Mutex
	// runs is keyed by the dag's owning run id.
	runs map[string]*runWake
}

func newWaker() *waker {
	return &waker{runs: make(map[string]*runWake)}
}

var wakes = newWaker()

func (w *waker) runLocked(channelId, runId string) *runWake {
	rw := w.runs[runId]
	if rw == nil {
		rw = &runWake{channelId: channelId, told: make(map[string]bool)}
		w.runs[runId] = rw
	}
	return rw
}

// PostWake hands a judgment event to runId's lead: typed now if the lead can take it, held and joined
// with later events if it is busy.
func PostWake(ctx context.Context, channelId, runId, line string) {
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	rw := wakes.runLocked(channelId, runId)
	if rw.dead {
		appendRunEvent(ctx, channelId, runId, waveobj.RunEventKindLeadWakeFailed, nil, map[string]any{"reason": leadDeadNote, "lines": []string{line}})
		return
	}
	rw.lines = append(rw.lines, line)
	wakes.flushLocked(ctx, runId, rw)
}

// PokeWake re-checks runId's question queue after an ask was raised or came back. A lead given up on
// cannot own a new question, so it goes to the human (G8).
func PokeWake(ctx context.Context, channelId, runId string) {
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	rw := wakes.runLocked(channelId, runId)
	if rw.dead {
		for oref, p := range leadAsks(runId) {
			forwardAskToUser(ctx, oref, p, leadDeadNote)
		}
		return
	}
	wakes.flushLocked(ctx, runId, rw)
}

// LeadDead reports that runId's lead stopped taking wakes, so its judgment belongs to the human (G8).
func LeadDead(runId string) bool {
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	rw := wakes.runs[runId]
	return rw != nil && rw.dead
}

// NoteLeadStatus feeds agent status events to the adapter. working confirms the outstanding wake and
// revives a lead given up on; a lead back at its prompt gets what was held while it was busy.
func NoteLeadStatus(ctx context.Context, ev *wps.WaveEvent) {
	var data baseds.AgentStatusData
	if ev == nil || utilfn.ReUnmarshal(&data, ev.Data) != nil || data.ORef == "" {
		return
	}
	oref, err := waveobj.ParseORef(data.ORef)
	if err != nil {
		return
	}
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	for runId, rw := range wakes.runs {
		if oref.OID != rw.blockId && oref.OID != rw.tabId {
			continue
		}
		if data.State == baseds.AgentState_Working {
			rw.sentAt, rw.retried, rw.dead = 0, false, false
			continue
		}
		if atPrompt(data.State) {
			wakes.flushLocked(ctx, runId, rw)
		}
	}
}

// tickWakes retries an unconfirmed wake once and then gives up on the lead. It also flushes anything
// held, which covers an idle status that arrived before the adapter knew the lead's block.
func tickWakes(ctx context.Context) {
	now := wakeNow()
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	for runId, rw := range wakes.runs {
		if rw.sentAt == 0 {
			wakes.flushLocked(ctx, runId, rw)
			continue
		}
		if now-rw.sentAt < WakeConfirmTimeout.Milliseconds() {
			continue
		}
		if rw.retried {
			wakes.leadDiedLocked(ctx, runId, rw, wakeUnconfirmedNote)
			continue
		}
		// the text is already in the lead's input, so only Enter is repeated.
		rw.retried, rw.sentAt = true, now
		sendWakeFn(rw.blockId, "")
	}
}

// atPrompt reports a lead that can take typed input. A Claude lead left at its prompt reports waiting
// through the idle Notification hook, and run workers skip permission prompts, so waiting is not a
// dialog. asking is the lead's own question to the human, which typed text would answer.
func atPrompt(state string) bool {
	return state == baseds.AgentState_Idle || state == baseds.AgentState_Waiting
}

func (w *waker) flushLocked(ctx context.Context, runId string, rw *runWake) {
	if rw.sentAt != 0 || rw.dead {
		return
	}
	asks := leadAsks(runId)
	untold := false
	for _, p := range asks {
		if !rw.told[askTold(p)] {
			untold = true
		}
	}
	if len(rw.lines) == 0 && !untold {
		return
	}
	st := leadStateFn(ctx, rw.channelId, runId)
	rw.blockId, rw.tabId = st.BlockId, st.TabId
	if !st.Alive {
		w.leadDiedLocked(ctx, runId, rw, leadNotRunningNote)
		return
	}
	if !atPrompt(st.State) {
		return
	}
	lines := append([]string{}, rw.lines...)
	if untold {
		lines = append(lines, questionsLine(asks))
	}
	text := strings.Join(lines, "\n")
	sendWakeFn(st.BlockId, text)
	rw.lines, rw.sentAt, rw.retried = nil, wakeNow(), false
	for _, p := range asks {
		rw.told[askTold(p)] = true
	}
	appendRunEvent(ctx, rw.channelId, runId, waveobj.RunEventKindLeadWoken, nil, map[string]any{"text": text})
}

// leadDiedLocked hands the lead's judgment to the human (G8): held events go on the lead-wake-failed
// row, and every question the lead owns moves to the user.
func (w *waker) leadDiedLocked(ctx context.Context, runId string, rw *runWake, reason string) {
	lines := rw.lines
	rw.lines, rw.sentAt, rw.retried, rw.dead = nil, 0, false, true
	appendRunEvent(ctx, rw.channelId, runId, waveobj.RunEventKindLeadWakeFailed, nil, map[string]any{"reason": reason, "lines": lines})
	for oref, p := range leadAsks(runId) {
		forwardAskToUser(ctx, oref, p, reason)
	}
}

// leadAsks is runId's lead-owned questions, keyed by the oref each child waits on.
func leadAsks(runId string) map[string]agentask.PendingAsk {
	out := make(map[string]agentask.PendingAsk)
	for oref, p := range agentask.GlobalRegistry.List() {
		if p.RunId == runId && p.Owner == agentask.AskOwner_Lead {
			out[oref] = p
		}
	}
	return out
}

// askTold keys an announcement by miss count too, so an ask back from a failed delivery is news again.
func askTold(p agentask.PendingAsk) string {
	return fmt.Sprintf("%s/%d", p.AskId, p.Misses)
}

func questionsLine(asks map[string]agentask.PendingAsk) string {
	n := 0
	for _, p := range asks {
		n += len(p.Questions)
	}
	noun := "questions"
	if n == 1 {
		noun = "question"
	}
	return fmt.Sprintf("wake: %d %s waiting. wsh jarvis dag asks", n, noun)
}

// forwardAskToUser moves a dag child's question to the human with why, and reports whether it moved.
// An ask answered or replaced in the meantime moves nothing. The identity is written too, because
// `dag forward` can move an ask that never went through the raise (one restored after a restart), and
// an answer that never lands needs its run to come back to.
func forwardAskToUser(ctx context.Context, oref string, p agentask.PendingAsk, note string) bool {
	moved := agentask.GlobalRegistry.Update(oref, p.AskId, func(cur *agentask.PendingAsk) {
		cur.Owner, cur.Note = agentask.AskOwner_User, note
		cur.ChannelId, cur.RunId, cur.TaskId, cur.DagOID = p.ChannelId, p.RunId, p.TaskId, p.DagOID
	})
	if !moved {
		return false
	}
	publishChildAsk(p)
	appendRunEvent(ctx, p.ChannelId, p.RunId, waveobj.RunEventKindTaskForwarded, nil, map[string]any{
		"taskid": p.TaskId,
		"askid":  p.AskId,
		"note":   truncateText(note, MaxAskSummaryLen),
	})
	return true
}

// publishChildAsk tells the run's cockpit that its question queue changed; the card re-reads `dag asks`.
func publishChildAsk(p agentask.PendingAsk) {
	detail, _ := json.Marshal(map[string]string{"taskid": p.TaskId, "askid": p.AskId})
	publishDagEvent(DagEventChildAsk, &waveobj.TaskGroup{OID: p.DagOID, RunID: p.RunId}, string(detail))
}

func readLeadState(ctx context.Context, channelId, runId string) leadState {
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil || run == nil {
		return leadState{}
	}
	tabId := leadTabID(run)
	if tabId == "" {
		return leadState{}
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil || tab == nil || len(tab.BlockIds) == 0 {
		return leadState{TabId: tabId}
	}
	st := leadState{BlockId: tab.BlockIds[0], TabId: tabId}
	if rs := blockcontroller.GetBlockControllerRuntimeStatus(st.BlockId); rs != nil {
		st.Alive = rs.ShellProcStatus == blockcontroller.Status_Running
	}
	st.State = latestAgentState(st.BlockId, tabId)
	return st
}

// latestAgentState is the newest state reported for the lead. Hooks report on the block, but a reporter
// may use the tab, so both scopes are read and the later report wins.
func latestAgentState(blockId, tabId string) string {
	var best baseds.AgentStatusData
	scopes := []string{waveobj.MakeORef(waveobj.OType_Block, blockId).String(), waveobj.MakeORef(waveobj.OType_Tab, tabId).String()}
	for _, scope := range scopes {
		for _, ev := range wps.Broker.ReadEventHistory(wps.Event_AgentStatus, scope, 1) {
			var d baseds.AgentStatusData
			if utilfn.ReUnmarshal(&d, ev.Data) == nil && d.State != "" && d.Ts >= best.Ts {
				best = d
			}
		}
	}
	return best.State
}

// typeWake pastes the wake and then presses Enter. Bracketed paste keeps a multi-line wake one message
// instead of relying on how each harness's editor treats a typed newline; the pause mirrors agentask's
// keystroke pacing, since one combined write races the editor. It runs async so the waker lock is
// never held across the pause.
func typeWake(blockId, text string) {
	go func() {
		if text != "" {
			if err := sendBlockInput(blockId, "\x1b[200~"+text+"\x1b[201~"); err != nil {
				log.Printf("wake: typing into block %s: %v", blockId, err)
				return
			}
			time.Sleep(agentask.KeystrokeDelay)
		}
		if err := sendBlockInput(blockId, "\r"); err != nil {
			log.Printf("wake: submitting in block %s: %v", blockId, err)
		}
	}()
}

func sendBlockInput(blockId, s string) error {
	return blockcontroller.SendInput(blockId, &blockcontroller.BlockInputUnion{InputData: []byte(s)})
}
```

- [ ] **Step 5: Run the tests**

Run (PowerShell, repo root, CGO flags set): `go test ./pkg/orchestrate/ -run "TestWake"`
Expected: PASS.

Run: `go build ./...`
Expected: exit 0.

---

### Task 3: Raise, sweep, forward and the engine's wake triggers

**Files:**
- Create: `pkg/orchestrate/queue.go`
- Create: `pkg/orchestrate/queue_test.go`
- Modify: `pkg/orchestrate/engine.go` (`cleanupScheduleFailure`, `failDispatch`, the child-done/stalled loop, the failure loop, the status switch)
- Modify: `pkg/orchestrate/outcome.go` (`HandleChildOutcome`)
- Modify: `pkg/orchestrate/mutation.go` (`markBlockedMergeLocked`)
- Modify: `pkg/orchestrate/watchdog.go`, `pkg/orchestrate/watchdog_test.go`
- Modify: `pkg/orchestrate/dag.go` (gains `gatedTaskID`), `pkg/orchestrate/control.go` (loses `PublishChildAsk`, `PublishTaskStalled`, `gatedTaskID`)
- Modify: `pkg/wshrpc/wshserver/wshserver_ask.go` (`forwardChildAsk`), `pkg/wshrpc/wshserver/wshserver_dag.go` (`taskBlockOrefs` moves out)

**Interfaces:**
- Consumes (Task 1): `Registry.Update`, `Registry.ExpireClears`, `agentask.AnswerClearTimeout`, the `PendingAsk` queue fields.
- Consumes (Task 2): `PostWake`, `PokeWake`, `tickWakes`, `forwardAskToUser`, `publishChildAsk`, `wakeNow`, `LeadAskDeadline`, `leadDeadNote`; test helpers `newFakeLead`, `fakeLead.status`, `fakeLead.countKind`, `wakeChannel`, `wakeRun`, `finishedLine`.
- Produces:
  - `func RaiseChildAsk(ctx context.Context, g *waveobj.TaskGroup, target AskTarget, blockOref, question string)`
  - `func ForwardTask(ctx context.Context, dagID, taskID, note string) error`
  - `func RunBlockORefs(ctx context.Context, run *waveobj.Run) []string`
  - package-internal `sweepAsks(ctx)`, `taskFailedWake`, `mergeConflictWake`, `runFinishedWake`, `askDeadlineNote`, and the test seam `expireClearsFn`

**Design notes:**
- Which events wake the lead, and where:
  - A task fails with no automatic retry left. There are three sites: the child-outcome path in `outcome.go` (a worker exit), the tick's failure loop (a child run reported blocked), and the two dispatch-failure paths in `engine.go`. The outcome path persists the failed state before it calls `scheduleLocked`, so the tick's failure loop sees the task as already failed and does not wake a second time.
  - A merge conflict, in `markBlockedMergeLocked`. Both the automatic merge and `dag merge` reach it.
  - The run finishing, in the status switch. `NotifiedCondition` already makes that once per transition.
- Not woken: a done child, an open gate (the human's to approve), a stall (the hung wake is slice 4) and a blocked dag (each failure woke the lead when it happened).
- A raised ask is always given to the lead. `PokeWake` moves it on to the user when the lead is dead, so the raise has no dead-lead branch of its own.
- The sweep runs on its own 5s ticker inside the watchdog goroutine. On the 30s DAG tick, a 30s confirmation window could stretch to a minute.

- [ ] **Step 1: Write the failing tests**

Create `pkg/orchestrate/queue_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const oneQuestionWake = "wake: 1 question waiting. wsh jarvis dag asks"

// settle has the scripted lead take the outstanding wake, so the next event is typed instead of held.
func (f *fakeLead) settle(ctx context.Context) {
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Working))
	NoteLeadStatus(ctx, f.status(baseds.AgentState_Idle))
}

func raiseOn(t *testing.T, oref, askId string) {
	t.Helper()
	agentask.GlobalRegistry.Set(oref, agentask.PendingAsk{
		AskId: askId, BlockId: "child", Questions: []baseds.AgentAskQuestion{{Question: "which way?"}},
	})
	g := &waveobj.TaskGroup{OID: "dag-1", ChannelId: wakeChannel, RunID: wakeRun}
	target := AskTarget{ChannelId: wakeChannel, RunID: wakeRun, TaskId: "t-2", AskId: askId}
	RaiseChildAsk(context.Background(), g, target, oref, "which way?")
}

// stubExpiredClears hands the sweep answers that never landed, putting them back in the registry the
// way ExpireClears does, once.
func stubExpiredClears(t *testing.T, restored map[string]agentask.PendingAsk) {
	t.Helper()
	orig := expireClearsFn
	expireClearsFn = func(int64) map[string]agentask.PendingAsk {
		for oref, p := range restored {
			agentask.GlobalRegistry.Set(oref, p)
		}
		out := restored
		restored = nil
		return out
	}
	t.Cleanup(func() { expireClearsFn = orig })
}

func unconfirmedAsk(owner string, misses int) agentask.PendingAsk {
	return agentask.PendingAsk{
		AskId: "a1", BlockId: "child", Questions: []baseds.AgentAskQuestion{{Question: "which way?"}},
		Owner: owner, Deadline: 1, Note: agentask.AnswerUnconfirmedNote, Misses: misses,
		ChannelId: wakeChannel, RunId: wakeRun, TaskId: "t-2", DagOID: "dag-1",
	}
}

func TestRaisedAskIsLeadOwnedAndWakesLead(t *testing.T) {
	f := newFakeLead(t)
	raiseOn(t, "block:child-1", "a1")

	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_Lead || p.Deadline != f.now+LeadAskDeadline.Milliseconds() ||
		p.RunId != wakeRun || p.TaskId != "t-2" || p.DagOID != "dag-1" {
		t.Fatalf("a raised ask belongs to the lead, with a deadline and its task, got %+v", p)
	}
	if len(f.sends) != 1 || f.sends[0] != oneQuestionWake {
		t.Fatalf("an idle lead is woken for the question, got %q", f.sends)
	}
	if f.countKind(waveobj.RunEventKindChildAsk) != 1 {
		t.Fatalf("want one child-ask row, got %+v", f.rows)
	}
}

func TestRaisedAskGoesToUserWhenLeadIsDead(t *testing.T) {
	f := newFakeLead(t)
	f.state.Alive = false
	PostWake(context.Background(), wakeChannel, wakeRun, finishedLine)

	raiseOn(t, "block:child-1", "a1")

	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || p.Note != leadDeadNote {
		t.Fatalf("a dead lead cannot own a new question, got %+v", p)
	}
	if len(f.sends) != 0 || f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want no typing and one task-forwarded row, sends=%q rows=%+v", f.sends, f.rows)
	}
}

func TestLeadAskPastDeadlineMovesToUser(t *testing.T) {
	f := newFakeLead(t)
	f.state.State = baseds.AgentState_Working
	raiseOn(t, "block:child-1", "a1")
	ctx := context.Background()

	f.now += LeadAskDeadline.Milliseconds() - 1
	sweepAsks(ctx)
	if p, _ := agentask.GlobalRegistry.Get("block:child-1"); p.Owner != agentask.AskOwner_Lead {
		t.Fatalf("the lead keeps its question until the deadline, got %+v", p)
	}

	f.now++
	sweepAsks(ctx)
	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || p.Note != askDeadlineNote {
		t.Fatalf("a question past its deadline moves to the user with why, got %+v", p)
	}
	if f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want one task-forwarded row, got %+v", f.rows)
	}
}

func TestUnconfirmedAnswerComesBackToLead(t *testing.T) {
	f := newFakeLead(t)
	stubExpiredClears(t, map[string]agentask.PendingAsk{"block:child-1": unconfirmedAsk(agentask.AskOwner_Lead, 1)})

	sweepAsks(context.Background())

	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_Lead || p.Deadline != f.now+LeadAskDeadline.Milliseconds() {
		t.Fatalf("an answer that never landed returns to the lead with a fresh deadline, got %+v", p)
	}
	if len(f.sends) != 1 || f.sends[0] != oneQuestionWake {
		t.Fatalf("the lead is told the question is back, got %q", f.sends)
	}
}

func TestSecondUnconfirmedAnswerIsForwardedToUser(t *testing.T) {
	f := newFakeLead(t)
	stubExpiredClears(t, map[string]agentask.PendingAsk{"block:child-1": unconfirmedAsk(agentask.AskOwner_User, 2)})

	sweepAsks(context.Background())

	p, _ := agentask.GlobalRegistry.Get("block:child-1")
	if p.Owner != agentask.AskOwner_User || p.Note != agentask.AnswerUnconfirmedNote {
		t.Fatalf("the second miss stays with the user, noted, got %+v", p)
	}
	if len(f.sends) != 0 || f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want no typing and one task-forwarded row, sends=%q rows=%+v", f.sends, f.rows)
	}
}

func TestDispatchFailureWakesLeadAfterCommit(t *testing.T) {
	f := newFakeLead(t)
	g := &waveobj.TaskGroup{OID: "dag-1", ChannelId: wakeChannel, RunID: wakeRun, Tasks: []waveobj.TaskNode{{ID: "t-3", State: TaskState_Ready}}}
	var afterCommit []func()

	failDispatch(context.Background(), g, "t-3", FailureKindSpawn, errors.New("pty refused"), &afterCommit)
	if len(f.sends) != 0 {
		t.Fatalf("nothing is typed before the failure persists, got %q", f.sends)
	}
	for _, fn := range afterCommit {
		fn()
	}

	want := "wake: task t-3 failed (spawn-failed), retry spent. wsh jarvis dag status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

func TestBlockedChildRunWakesLead(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Blocked)

	h.scheduleTimes(t, 1)

	want := "wake: task t-0 failed (unknown), retry spent. wsh jarvis dag status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

func TestChildFailureWakesLeadOnlyWhenRetryIsSpent(t *testing.T) {
	f := newFakeLead(t)
	h := newChildOutcomeHarness(t, 1)

	if err := HandleChildOutcome(h.ctx, h.workers[0], toolFlakeOutcome()); err != nil {
		t.Fatal(err)
	}
	if len(f.sends) != 0 {
		t.Fatalf("an automatically retried flake is not judgment, got %q", f.sends)
	}
	if err := HandleChildOutcome(h.ctx, h.workers[len(h.workers)-1], toolFlakeOutcome()); err != nil {
		t.Fatal(err)
	}

	want := "wake: task t-0 failed (tool_call_error), retry spent. wsh jarvis dag status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

func TestMergeConflictWakesLead(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})

	if err := MarkBlockedMerge(h.ctx, h.dagID, h.loadDag(t).Tasks[0].RunID); err != nil {
		t.Fatal(err)
	}

	want := "wake: merge conflict landing task t-0. git status"
	if len(f.sends) != 1 || f.sends[0] != want {
		t.Fatalf("want %q, got %q", want, f.sends)
	}
}

func TestRunFinishedWakesLeadOnce(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Done)

	for i := 0; i < 3; i++ {
		h.scheduleTimes(t, 1)
		f.settle(h.ctx)
	}

	if len(f.sends) != 1 || f.sends[0] != runFinishedWake {
		t.Fatalf("the finished run wakes the lead once, got %q", f.sends)
	}
}

func TestDoneChildAndOpenGateDoNotWakeLead(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a", Gate: true}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Done)

	h.scheduleTimes(t, 2)

	if got := h.loadDag(t).Status; got != DagStatus_AwaitingReview {
		t.Fatalf("setup: dag status = %q, want %q", got, DagStatus_AwaitingReview)
	}
	if len(f.sends) != 0 {
		t.Fatalf("a finished child and an open gate are not the lead's judgment, got %q", f.sends)
	}
}

func TestForwardTaskMovesPendingQuestionToUser(t *testing.T) {
	f := newFakeLead(t)
	h := newChildOutcomeHarness(t, 1)
	child, err := wstore.GetRun(h.ctx, h.channel, h.loadDag(t).Tasks[0].RunID)
	if err != nil {
		t.Fatal(err)
	}
	blocks := RunBlockORefs(h.ctx, child)
	if len(blocks) != 1 {
		t.Fatalf("setup: want the child's one worker block, got %q", blocks)
	}
	agentask.GlobalRegistry.Set(blocks[0], agentask.PendingAsk{
		AskId: "a1", Questions: []baseds.AgentAskQuestion{{Question: "which schema?"}}, Owner: agentask.AskOwner_Lead,
	})

	if err := ForwardTask(h.ctx, h.dagID, "t-0", "picking a schema is a product call"); err != nil {
		t.Fatal(err)
	}

	p, _ := agentask.GlobalRegistry.Get(blocks[0])
	if p.Owner != agentask.AskOwner_User || p.Note != "picking a schema is a product call" || p.RunId != h.runID || p.TaskId != "t-0" {
		t.Fatalf("the forwarded question belongs to the user, with the lead's note and its task, got %+v", p)
	}
	if f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("want one task-forwarded row, got %+v", f.rows)
	}
}

func TestForwardTaskRecordsFailedTask(t *testing.T) {
	f := newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	h.finishTask(t, "t-0", jarvis.RunStatus_Blocked)
	h.scheduleTimes(t, 1)

	if err := ForwardTask(h.ctx, h.dagID, "t-0", "the test needs a staging key only the human has"); err != nil {
		t.Fatal(err)
	}

	if f.countKind(waveobj.RunEventKindTaskForwarded) != 1 {
		t.Fatalf("a forwarded failure lands on the timeline, got %+v", f.rows)
	}
}

func TestForwardTaskRejectsNothingToForward(t *testing.T) {
	newFakeLead(t)
	h := newNotifyHarness(t, 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})

	if err := ForwardTask(h.ctx, h.dagID, "t-0", "over to you"); err == nil {
		t.Fatal("a running task with no question has nothing to forward")
	}
	h.finishTask(t, "t-0", jarvis.RunStatus_Blocked)
	h.scheduleTimes(t, 1)
	if err := ForwardTask(h.ctx, h.dagID, "t-0", "  "); err == nil {
		t.Fatal("a forward without a note tells the human nothing")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (PowerShell, repo root, CGO flags set): `go test ./pkg/orchestrate/ -run "Raised|LeadAskPast|Unconfirmed|WakesLead|DoNotWakeLead|ForwardTask"`
Expected: FAIL to build with `undefined: RaiseChildAsk`, `undefined: sweepAsks`, `undefined: expireClearsFn` and `undefined: ForwardTask`.

- [ ] **Step 3: Write the queue operations**

Create `pkg/orchestrate/queue.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// askDeadlineNote is why a question the lead sat on past LeadAskDeadline moved to the human.
const askDeadlineNote = "lead did not answer in time"

const runFinishedWake = "wake: run finished. wsh jarvis dag status"

// taskFailedWake names the failure kind so the lead can pick retry, escalate, skip or forward before
// reading the digest. A child run that reported itself blocked carries no kind.
func taskFailedWake(taskID, kind string) string {
	if kind == "" {
		kind = FailureKindUnknown
	}
	return fmt.Sprintf("wake: task %s failed (%s), retry spent. wsh jarvis dag status", taskID, kind)
}

func mergeConflictWake(taskID string) string {
	return fmt.Sprintf("wake: merge conflict landing task %s. git status", taskID)
}

// RaiseChildAsk puts a dag child's question in its lead's queue and wakes the lead. question is the
// first question's text, for the child-ask row.
func RaiseChildAsk(ctx context.Context, g *waveobj.TaskGroup, target AskTarget, blockOref, question string) {
	var raised agentask.PendingAsk
	ok := agentask.GlobalRegistry.Update(blockOref, target.AskId, func(p *agentask.PendingAsk) {
		p.Owner = agentask.AskOwner_Lead
		p.Deadline = wakeNow() + LeadAskDeadline.Milliseconds()
		p.ChannelId, p.RunId, p.TaskId, p.DagOID = g.ChannelId, g.RunID, target.TaskId, g.OID
		raised = *p
	})
	if !ok {
		return
	}
	publishChildAsk(raised)
	RecordAskLifecycle(ctx, target, waveobj.RunEventKindChildAsk, question)
	PokeWake(ctx, g.ChannelId, g.RunID)
}

// expireClearsFn puts typed answers no agent confirmed back in the queue and returns them. A var so
// tests can hand the sweep a restored ask without typing into a real block.
var expireClearsFn = func(now int64) map[string]agentask.PendingAsk {
	return agentask.GlobalRegistry.ExpireClears(now, agentask.AnswerClearTimeout)
}

// sweepAsks moves lead-owned questions past their deadline to the human, and puts answers that never
// landed back in front of their owner.
func sweepAsks(ctx context.Context) {
	now := wakeNow()
	for oref, p := range agentask.GlobalRegistry.List() {
		if p.Owner == agentask.AskOwner_Lead && p.Deadline > 0 && now >= p.Deadline {
			forwardAskToUser(ctx, oref, p, askDeadlineNote)
		}
	}
	for oref, p := range expireClearsFn(now) {
		if p.Owner != agentask.AskOwner_Lead {
			forwardAskToUser(ctx, oref, p, p.Note)
			continue
		}
		// the deadline restarts: the lead answered in time, and it was the delivery that failed.
		agentask.GlobalRegistry.Update(oref, p.AskId, func(cur *agentask.PendingAsk) {
			cur.Deadline = now + LeadAskDeadline.Milliseconds()
		})
		publishChildAsk(p)
		PokeWake(ctx, p.ChannelId, p.RunId)
	}
}

// ForwardTask hands a task's open judgment to the human with the lead's note (`dag forward`): its
// pending question when it has one, otherwise the failure, stall or merge conflict the lead was woken
// for, which then waits on the timeline for the human.
func ForwardTask(ctx context.Context, dagID, taskID, note string) error {
	note = strings.TrimSpace(note)
	if note == "" {
		return fmt.Errorf("forward needs a note saying what the human should decide")
	}
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return fmt.Errorf("loading dag: %w", err)
	}
	task := taskByID(g, taskID)
	if task == nil {
		return fmt.Errorf("no task %q", taskID)
	}
	if oref, p, ok := taskPendingAsk(ctx, g, task); ok {
		p.ChannelId, p.RunId, p.TaskId, p.DagOID = g.ChannelId, g.RunID, task.ID, g.OID
		if !forwardAskToUser(ctx, oref, p, note) {
			return fmt.Errorf("task %s's question was answered before it could be forwarded", taskID)
		}
		return nil
	}
	switch task.State {
	case TaskState_Failed, TaskState_Stalled, TaskState_BlockedMerge:
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskForwarded, nil, map[string]any{
			"taskid": task.ID,
			"note":   truncateText(note, MaxAskSummaryLen),
		})
		return nil
	}
	return fmt.Errorf("task %s has no question, failure, stall or merge conflict to forward (state %q)", taskID, task.State)
}

func taskPendingAsk(ctx context.Context, g *waveobj.TaskGroup, task *waveobj.TaskNode) (string, agentask.PendingAsk, bool) {
	if task.RunID == "" {
		return "", agentask.PendingAsk{}, false
	}
	child, err := wstore.GetRun(ctx, g.ChannelId, task.RunID)
	if err != nil {
		return "", agentask.PendingAsk{}, false
	}
	for _, oref := range RunBlockORefs(ctx, child) {
		if p, ok := agentask.GlobalRegistry.Get(oref); ok {
			return oref, p, true
		}
	}
	return "", agentask.PendingAsk{}, false
}

// RunBlockORefs lists the worker block orefs of a run's phases, the keys the ask registry holds the
// run's questions under.
func RunBlockORefs(ctx context.Context, run *waveobj.Run) []string {
	var out []string
	seen := map[string]bool{}
	for _, p := range run.Phases {
		for _, oref := range p.WorkerOrefs {
			if !strings.HasPrefix(oref, "tab:") {
				continue
			}
			tab, terr := wstore.DBMustGet[*waveobj.Tab](ctx, strings.TrimPrefix(oref, "tab:"))
			if terr != nil || len(tab.BlockIds) == 0 {
				continue
			}
			bo := waveobj.MakeORef(waveobj.OType_Block, tab.BlockIds[0]).String()
			if !seen[bo] {
				seen[bo] = true
				out = append(out, bo)
			}
		}
	}
	return out
}
```

- [ ] **Step 4: Move `gatedTaskID` and drop the old publishers**

In `pkg/orchestrate/control.go`, delete everything from the `// PublishChildAsk broadcasts a child's pending ask` comment to the end of the file: `PublishChildAsk`, `PublishTaskStalled` and `gatedTaskID`. Then remove `"fmt"` from its imports, since `PublishChildAsk` was its only user. The rest of `control.go` stays until Task 5.

In `pkg/orchestrate/dag.go`, insert directly above the `// dagCondition is the lead-facing identity` comment:

```go
// gatedTaskID returns the id of the done, unreleased gate halting the DAG, or "".
func gatedTaskID(g *waveobj.TaskGroup) string {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.Gate && t.State == TaskState_Done && !t.Released {
			return t.ID
		}
	}
	return ""
}

```

- [ ] **Step 5: Wake on a dispatch failure**

In `pkg/orchestrate/engine.go`, `cleanupScheduleFailure`, replace:

```go
		for _, idx := range failed {
			appendRunEvent(cleanupCtx, fresh.ChannelId, fresh.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{
				"taskid": fresh.Tasks[idx].ID, "lastfailurekind": FailureKindUnrecorded, "attempts": fresh.Tasks[idx].Attempts, "detail": detail,
			})
		}
```

with:

```go
		for _, idx := range failed {
			appendRunEvent(cleanupCtx, fresh.ChannelId, fresh.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{
				"taskid": fresh.Tasks[idx].ID, "lastfailurekind": FailureKindUnrecorded, "attempts": fresh.Tasks[idx].Attempts, "detail": detail,
			})
			PostWake(cleanupCtx, fresh.ChannelId, fresh.RunID, taskFailedWake(fresh.Tasks[idx].ID, FailureKindUnrecorded))
		}
```

No test drives this path, because it needs a persist to fail midway through a spawn. It uses the same line builder that `TestDispatchFailureWakesLeadAfterCommit` pins.

In `failDispatch`, replace:

```go
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{
			"taskid": taskID, "lastfailurekind": kind, "attempts": attempts, "detail": detail,
		})
	})
```

with:

```go
	*afterCommit = append(*afterCommit, func() {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{
			"taskid": taskID, "lastfailurekind": kind, "attempts": attempts, "detail": detail,
		})
		PostWake(ctx, g.ChannelId, g.RunID, taskFailedWake(taskID, kind))
	})
```

- [ ] **Step 6: Drop the lead notifications from the tick**

In `scheduleLocked`, change the liveness comment's `a running task silent past StallThreshold is flagged stalled and reported to the lead (nothing else ever notices a headless child that stopped progressing)` to `a running task silent past StallThreshold is flagged stalled (nothing else ever notices a headless child that stopped progressing)`.

Replace the child-done block, from `// child-done notification: a task whose child just reached done wakes the lead` through the end of its `for` loop:

```go
	// child-done: record the task-done lifecycle boundary (task id + child run id). A done child is not
	// judgment, so the lead is not woken; the merge that follows wakes it only on a conflict.
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.State == TaskState_Done && t.RunID != "" && taskActive(prevStates[t.ID]) {
			taskID := t.ID
			childRunID := t.RunID
			afterCommit = append(afterCommit, func() {
				publishDagEvent(DagEventChildDone, g, taskID)
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskDone, nil, map[string]any{"taskid": taskID, "runid": childRunID})
			})
		}
		if t.State == TaskState_Stalled && prevStates[t.ID] == TaskState_Running {
			taskID := t.ID
			afterCommit = append(afterCommit, func() {
				publishDagEvent(DagEventTaskStalled, g, taskID)
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskStalled, nil, map[string]any{"taskid": taskID})
			})
		}
	}
```

In the failure loop, replace:

```go
			afterCommit = append(afterCommit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{"taskid": taskID, "runid": childRunID, "lastfailurekind": kind, "attempts": attempts})
			})
```

with:

```go
			afterCommit = append(afterCommit, func() {
				appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskFailed, nil, map[string]any{"taskid": taskID, "runid": childRunID, "lastfailurekind": kind, "attempts": attempts})
				PostWake(ctx, g.ChannelId, g.RunID, taskFailedWake(taskID, kind))
			})
```

Replace the status block, from `// status notifications: gate-open / blocked / complete wake the lead` through the closing brace of the `switch`:

```go
	// status notifications: gate-open / blocked / complete, once per condition. The watchdog and every
	// dag mutation re-enter Schedule, so emitting the standing status would refill the lifecycle log with
	// identical rows and re-wake the lead about what it was already told. The gate cannot be compared
	// against the status this tick started from: the mutation paths recompute and PERSIST the new status
	// before calling Schedule, so the row already reads the new condition. What was last announced is its
	// own fact, so the dag records it. Only the finished run wakes the lead here: a gate is the human's,
	// and each failure behind a blocked dag woke the lead when it happened.
	condition := dagCondition(g)
	notify := condition != g.NotifiedCondition
	g.NotifiedCondition = condition
	switch {
	case notify && g.Status == DagStatus_AwaitingReview:
		gateTask := gatedTaskID(g)
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventGateOpen, g, "")
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagGateOpen, nil, map[string]any{"taskid": gateTask})
		})
	case notify && g.Status == DagStatus_Blocked:
		failures := g.Failures
		blockingKind := BlockingKind(g)
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventBlocked, g, "")
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagBlocked, nil, map[string]any{"failures": failures, "kind": blockingKind})
		})
	case notify && g.Status == DagStatus_Done:
		afterCommit = append(afterCommit, func() {
			publishDagEvent(DagEventComplete, g, "")
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindDagDone, nil, map[string]any{})
			PostWake(ctx, g.ChannelId, g.RunID, runFinishedWake)
		})
	}
```

`engine.go` still uses `fmt` (`fmt.Errorf`), so its imports do not change.

- [ ] **Step 7: Wake on a spent retry and on a merge conflict**

In `pkg/orchestrate/outcome.go`, `HandleChildOutcome`, replace:

```go
		if mayRetry {
			detail := map[string]any{"taskid": task.ID, "kind": kind, "attempt": attempt}
			publishDagEvent(DagEventTaskRetried, g, task.ID)
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskRetried, nil, detail)
		}
```

with:

```go
		if mayRetry {
			detail := map[string]any{"taskid": task.ID, "kind": kind, "attempt": attempt}
			publishDagEvent(DagEventTaskRetried, g, task.ID)
			appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskRetried, nil, detail)
		} else {
			PostWake(ctx, g.ChannelId, g.RunID, taskFailedWake(task.ID, kind))
		}
```

In `pkg/orchestrate/mutation.go`, `markBlockedMergeLocked`, replace:

```go
	found := false
	for i := range g.Tasks {
		if g.Tasks[i].RunID == childRunID {
			g.Tasks[i].State = TaskState_BlockedMerge
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("no task owns run %s", childRunID)
	}
```

with:

```go
	found := false
	taskID := ""
	for i := range g.Tasks {
		if g.Tasks[i].RunID == childRunID {
			g.Tasks[i].State = TaskState_BlockedMerge
			taskID = g.Tasks[i].ID
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("no task owns run %s", childRunID)
	}
```

At the end of the same function, replace:

```go
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return nil
}
```

with:

```go
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	PostWake(ctx, g.ChannelId, g.RunID, mergeConflictWake(taskID))
	return nil
}
```

The same three lines also end `applyActionLocked`. Make this edit only in `markBlockedMergeLocked`, the function directly below `MarkBlockedMerge`. Anchor on the `no task owns run` error above it.

- [ ] **Step 8: Tick the adapter and the sweep**

In `pkg/orchestrate/watchdog.go`, insert after `const watchdogInterval = 30 * time.Second`:

```go

// wakeTickInterval paces the wake adapter and the ask sweep. It sits well under WakeConfirmTimeout and
// agentask.AnswerClearTimeout, so neither window runs much past what its constant says.
const wakeTickInterval = 5 * time.Second
```

Replace `StartWatchdog` and `safeTick`, from the `// StartWatchdog launches` comment to the end of the file:

```go
// StartWatchdog launches the periodic DAG-advance loop and the wake loop (idempotent; the first call
// wins). Both run until ctx is done. Wired once at server startup.
func StartWatchdog(ctx context.Context) {
	watchdogOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(watchdogInterval)
			defer ticker.Stop()
			wakeTicker := time.NewTicker(wakeTickInterval)
			defer wakeTicker.Stop()
			safeTick(ctx, watchdogTick) // first pass immediately (a submitted dag's children may already need attention)
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					safeTick(ctx, watchdogTick)
				case <-wakeTicker.C:
					safeTick(ctx, wakeTick)
				}
			}
		}()
	})
}

func wakeTick(ctx context.Context) {
	sweepAsks(ctx)
	tickWakes(ctx)
}

// safeTick recovers per tick: a panic inside one Schedule must not kill the loop for the server's
// lifetime — the watchdog is the only advance path for event-less stalls.
func safeTick(ctx context.Context, tick func(context.Context)) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("watchdog: tick panic (loop continues): %v", r)
		}
	}()
	tick(ctx)
}
```

In `pkg/orchestrate/watchdog_test.go`, `TestSafeTickSurvivesPanic`, change both `safeTick(context.Background())` calls to `safeTick(context.Background(), watchdogTick)`.

- [ ] **Step 9: Raise from the server and use the moved block lookup**

In `pkg/wshrpc/wshserver/wshserver_ask.go`, replace `forwardChildAsk` and its comment:

```go
// forwardChildAsk puts a pending ask raised by a dag child's block in its lead's question queue: the
// child's ask card renders only on the child session, invisible to the human, so the lead answers it
// or forwards it. No-op for blocks that are not dag children.
func forwardChildAsk(ctx context.Context, blockOref, askId string, questions []baseds.AgentAskQuestion) {
	if len(questions) == 0 {
		return
	}
	g, target, ok := askTargetForBlock(ctx, blockOref, askId)
	if !ok {
		return
	}
	orchestrate.RaiseChildAsk(ctx, g, target, blockOref, questions[0].Question)
}
```

In `pkg/wshrpc/wshserver/wshserver_dag.go`:
- Delete `taskBlockOrefs` and its comment.
- In `gatherDagAsks` and `DagAnswerCommand`, replace `taskBlockOrefs(ctx, child)` with `orchestrate.RunBlockORefs(ctx, child)`.
- `strings` is still used (`strings.TrimSpace`), so the imports do not change.

- [ ] **Step 10: Run the tests**

Run (PowerShell, repo root, CGO flags set): `go test ./pkg/orchestrate/`
Expected: PASS, including the existing `notifygate_test.go`, `outcome_test.go`, `watchdog_test.go` and `control_test.go`.

Run: `go build ./...`
Expected: exit 0.

Run: `go test ./pkg/wshrpc/wshserver/ -run "Ask|Dag"`
Expected: PASS. `TestAskCommandForwardsDagChildAsk` still sees `dag:child-ask`. The fixture's owner run has no lead tab, so the adapter treats the lead as dead and forwards the ask, which publishes again.

---

### Task 4: Server and CLI

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`DagAskItem`, delete `DagAskOption`, action comments)
- Modify: `pkg/orchestrate/digest.go`, `pkg/orchestrate/digest_test_helpers_test.go` (the ask summary reads the first question)
- Modify: `pkg/agentask/deliver.go` (`SetSendInputForTest`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`gatherDagAsks`, the `forward` action, two comments)
- Modify: `pkg/wshrpc/wshserver/wshserver_ask.go` (`AgentAskClearCommand` confirms a typed answer)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (`EventPublishCommand` feeds the wake adapter)
- Modify: `pkg/wshrpc/wshserver/wshserver_dagask_test.go`
- Modify: `pkg/jarvis/watcher.go`, `pkg/jarvis/watcher_test.go` (Gatekeeper skip)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go` (`dag asks`, `dag forward`)
- Modify: `pkg/jarvis/run.go`, `pkg/jarvis/run_test.go`, `pkg/jarvis/run_dagprompt_test.go` (lead prompt)

**Interfaces:**
- Consumes:
  - Task 1: `agentask.AskOwner_Lead`, `AskOwner_User`, `AnswerUnconfirmedNote`, `AnswerClearTimeout`, `Registry.ConfirmClear`, `Registry.ExpireClears`
  - Tasks 2-3: `orchestrate.NoteLeadStatus`, `orchestrate.ForwardTask`, `orchestrate.RunBlockORefs`
- Produces:
  - `wshrpc.DagAskItem{TaskId, AskId, Owner, Deadline, Note, Questions []baseds.AgentAskQuestion, BlockORef, Ts}`. `DagAskOption` is deleted.
  - `func agentask.SetSendInputForTest(fn func(blockId string, data []byte) error) func()`
  - `DagActionCommand` action `forward`, with the lead's note in `Notes`
  - `wsh jarvis dag forward <task-id> <note>`
  - CLI helpers `dagAskLines(asks []wshrpc.DagAskItem, now int64) []string` and `dagForwardData(cmd *cobra.Command, args []string) (wshrpc.CommandDagActionData, error)`

**Design notes:**
- There is no restart adoption. A DAG child's ask never survives a restart (Global Constraints), so there is nothing to adopt.
- `gatherDagAsks` returns every entry, whoever holds it, because the run cockpit (Task 6) renders the user-owned ones. `dag asks` prints the lead's entries and only counts the human's.
- An entry with `Owner == ""` is shown to the lead. It is a child's ask whose raise could not resolve the dag at that moment, and the lead is the one who can act on it.
- `NoteLeadStatus` runs after `wps.Broker.Publish`. The adapter re-reads the lead's state through `ReadEventHistory` (`latestAgentState`, Task 2), which must already hold the event.
- `EventPublishCommand` feeding the adapter is one line with no test of its own. `NoteLeadStatus` itself is covered by Task 2's tests.
- The generated frontend `DagAskItem` type changes in Task 5's `task generate`. The frontend consumers are fixed in Task 6, so `tsc` can fail between the two.

- [ ] **Step 1: Write the failing CLI tests**

In `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, change the import block to:

```go
import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)
```

Insert directly above `func TestCompactDur(t *testing.T) {`:

```go
func TestDagAskLinesShowsEveryQuestion(t *testing.T) {
	asks := []wshrpc.DagAskItem{
		{TaskId: "t-3", Owner: agentask.AskOwner_Lead, Ts: 9_000, Deadline: 609_000, Questions: []baseds.AgentAskQuestion{{Question: "later?"}}},
		{TaskId: "t-2", Owner: agentask.AskOwner_Lead, Ts: 1_000, Deadline: 601_000, Note: agentask.AnswerUnconfirmedNote, Questions: []baseds.AgentAskQuestion{
			{Header: "Cache", Question: "which ttl?", Options: []baseds.AgentAskOption{{Label: "24h", Description: "matches prod"}, {Label: "7d"}}},
			{Question: "which regions?", MultiSelect: true, Options: []baseds.AgentAskOption{{Label: "eu"}, {Label: "us"}}},
		}},
		{TaskId: "t-4", Owner: agentask.AskOwner_User, Ts: 500, Questions: []baseds.AgentAskQuestion{{Question: "the human's call?"}}},
	}
	joined := strings.Join(dagAskLines(asks, 61_000), "\n")
	for _, want := range []string{
		"t-2  asked 1m ago  deadline in 9m",
		"note: " + agentask.AnswerUnconfirmedNote,
		"[Cache] which ttl?",
		"0) 24h - matches prod",
		"1) 7d",
		"which regions? (multi-select)",
		"wsh jarvis dag answer",
		"wsh jarvis dag forward",
		"1 held by the human in the run cockpit",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "the human's call?") {
		t.Fatalf("a question the human holds is not the lead's to answer:\n%s", joined)
	}
	if strings.Index(joined, "t-2") > strings.Index(joined, "t-3") {
		t.Fatalf("the oldest question comes first:\n%s", joined)
	}
}

func TestDagAskLinesWithNothingForTheLead(t *testing.T) {
	if got := dagAskLines(nil, 1_000); !reflect.DeepEqual(got, []string{"no questions waiting"}) {
		t.Fatalf("empty queue = %q", got)
	}
	held := []wshrpc.DagAskItem{{TaskId: "t-1", Owner: agentask.AskOwner_User, Ts: 1, Questions: []baseds.AgentAskQuestion{{Question: "q?"}}}}
	want := []string{"no questions waiting", "1 held by the human in the run cockpit"}
	if got := dagAskLines(held, 1_000); !reflect.DeepEqual(got, want) {
		t.Fatalf("human-held queue = %q, want %q", got, want)
	}
}

func TestDagForwardData(t *testing.T) {
	cmd := newDagEscalateTestCmd(t, map[string]string{"channel": "ch", "runid": "run"})
	got, err := dagForwardData(cmd, []string{"t-1", "scope call: B drops the export"})
	if err != nil {
		t.Fatal(err)
	}
	want := wshrpc.CommandDagActionData{ChannelId: "ch", RunId: "run", TaskId: "t-1", Action: "forward", Notes: "scope call: B drops the export"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("forward data = %+v, want %+v", got, want)
	}
}
```

- [ ] **Step 2: Write the failing server tests**

In `pkg/wshrpc/wshserver/wshserver_dagask_test.go`, `TestDagAsksAndAnswerRoundTrip`, replace:

```go
	if len(asks.Asks) != 1 || asks.Asks[0].TaskId != "t-0" || asks.Asks[0].Question != "A or B?" {
		t.Fatalf("asks mismatch: %+v", asks.Asks)
	}
	if len(asks.Asks[0].Options) != 2 || asks.Asks[0].Options[1].Label != "B" {
		t.Fatalf("options not carried: %+v", asks.Asks[0].Options)
	}
```

with:

```go
	if len(asks.Asks) != 1 || asks.Asks[0].TaskId != "t-0" || len(asks.Asks[0].Questions) != 1 || asks.Asks[0].Questions[0].Question != "A or B?" {
		t.Fatalf("asks mismatch: %+v", asks.Asks)
	}
	if opts := asks.Asks[0].Questions[0].Options; len(opts) != 2 || opts[1].Label != "B" {
		t.Fatalf("options not carried: %+v", opts)
	}
```

Append to the end of the file:

```go
func TestDagForwardHandsQuestionToHuman(t *testing.T) {
	g, _, blockORef := dagAskFixture(t)
	ws := &WshServer{}
	ctx := context.Background()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	agentask.GlobalRegistry.Set(blockORef, agentask.PendingAsk{
		AskId:     "ask-forward",
		Questions: []baseds.AgentAskQuestion{{Question: "A or B?", Options: []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}}}},
		Ts:        1,
		Owner:     agentask.AskOwner_Lead,
	})
	note := "scope call: B drops the export; I recommend A"

	if err := ws.DagActionCommand(ctx, wshrpc.CommandDagActionData{
		ChannelId: g.ChannelId, RunId: g.RunID, TaskId: "t-0", Action: "forward", Notes: note,
	}); err != nil {
		t.Fatal(err)
	}

	asks, err := ws.DagAsksCommand(ctx, wshrpc.CommandDagStatusData{ChannelId: g.ChannelId, RunId: g.RunID})
	if err != nil {
		t.Fatal(err)
	}
	if len(asks.Asks) != 1 || asks.Asks[0].Owner != agentask.AskOwner_User || asks.Asks[0].Note != note {
		t.Fatalf("forward must hand the question to the human with the lead's note: %+v", asks.Asks)
	}
	if rows := askLifecycleRows(t, g.ChannelId, g.RunID, waveobj.RunEventKindTaskForwarded); len(rows) != 1 || rows[0]["taskid"] != "t-0" {
		t.Fatalf("want one task-forwarded row for t-0, got %+v", rows)
	}
}

// A typed answer to a dag child counts as delivered only once the child clears its ask, so the clear
// is what must stop the sweep from putting the question back.
func TestAgentAskClearConfirmsTypedDagAnswer(t *testing.T) {
	g, _, blockORef := dagAskFixture(t)
	ws := &WshServer{}
	agentask.GlobalRegistry = agentask.MakeRegistry()
	t.Cleanup(agentask.SetSendInputForTest(func(string, []byte) error { return nil }))
	agentask.GlobalRegistry.Set(blockORef, agentask.PendingAsk{
		AskId:     "ask-typed",
		BlockId:   "child-block",
		Questions: []baseds.AgentAskQuestion{{Question: "A or B?", Options: []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}}}},
		Ts:        1,
		Owner:     agentask.AskOwner_Lead,
		ChannelId: g.ChannelId,
		RunId:     g.RunID,
		TaskId:    "t-0",
		DagOID:    g.OID,
	})
	if ok, err := agentask.DeliverAnswer(blockORef, "ask-typed", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}}); err != nil || !ok {
		t.Fatalf("want delivered, got (%v, %v)", ok, err)
	}

	if err := ws.AgentAskClearCommand(context.Background(), blockORef); err != nil {
		t.Fatal(err)
	}

	later := time.Now().Add(agentask.AnswerClearTimeout + time.Second).UnixMilli()
	if back := agentask.GlobalRegistry.ExpireClears(later, agentask.AnswerClearTimeout); len(back) != 0 {
		t.Fatalf("the child's clear confirmed the answer, so nothing may come back: %+v", back)
	}
}
```

- [ ] **Step 3: Write the failing Gatekeeper, prompt and digest tests**

Append to the end of `pkg/jarvis/watcher_test.go`. It is an existing file, so append with Edit, not Write.

```go
// seedDagRunWorker files a worker tab under a run of a dag and returns the channel and the worker's
// block oref. A child worker belongs to a run the dag's lead spawned; otherwise it is the lead's own.
func seedDagRunWorker(t *testing.T, ctx context.Context, child bool) (*waveobj.Channel, string) {
	t.Helper()
	ch, err := wstore.CreateChannel(ctx, "gk-dag", t.TempDir())
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	tabId, blockId := uuid.NewString(), uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker block: %v", err)
	}
	dagId := uuid.NewString()
	lead := NewRun("lead", "ws-1", ch.ProjectPath, nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(false), 1)
	lead.ID, lead.DagORef = uuid.NewString(), dagId
	if err := wstore.AppendDag(ctx, &waveobj.TaskGroup{OID: dagId, ID: dagId, RunID: lead.ID, ChannelId: ch.OID, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed dag: %v", err)
	}
	runs := []waveobj.Run{lead}
	if child {
		task := NewRun("task", "ws-1", ch.ProjectPath, nil, RunMode_Quick, QuickPlaybook(), 1)
		task.ID, task.DagORef = uuid.NewString(), dagId
		runs = append(runs, task)
	}
	worker := &runs[len(runs)-1]
	worker.Phases[0].WorkerOrefs = []string{waveobj.MakeORef(waveobj.OType_Tab, tabId).String()}
	for _, r := range runs {
		if err := wstore.AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatalf("append run: %v", err)
		}
	}
	return ch, waveobj.MakeORef(waveobj.OType_Block, blockId).String()
}

// A dag child's question waits in its lead's queue, so the Gatekeeper neither answers nor escalates it.
// The lead's own questions are still the Gatekeeper's to judge.
func TestHandleAskSkipsDagChildren(t *testing.T) {
	ctx := context.Background()
	origDeliver := deliverFn
	defer func() { deliverFn = origDeliver }()
	stubClassifier(t)
	cases := []struct {
		name        string
		child       bool
		wantHandled bool
	}{
		{"dag child", true, false},
		{"dag lead", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ch, blockORef := seedDagRunWorker(t, ctx, tc.child)
			delivered := 0
			deliverFn = func(string, string, []baseds.AgentAnswerItem) (bool, error) {
				delivered++
				return true, nil
			}
			handleAsk(ctx, baseds.AgentAskData{ORef: blockORef, AskId: uuid.NewString(), Questions: singleSelect(2)})
			// an answer posts an answered card and an escalation posts its own, so either leaves a message
			handled := delivered > 0 || len(channelMessages(t, ctx, ch.OID)) > 0
			if handled != tc.wantHandled {
				t.Fatalf("gatekeeper handled = %v, want %v", handled, tc.wantHandled)
			}
		})
	}
}
```

In `pkg/jarvis/run_test.go`, `TestBuildOrchestratePromptEngine`, replace everything after the `principles :=` line through the end of the function:

```go
	claude := BuildOrchestratePrompt("do X", principles, "claude", Orchestration_Engine, 0)
	for _, want := range []string{
		"do X", "be clean", "dag submit --file", "wsh jarvis dag wait", "terminal:",
		"wsh jarvis dag merge", "AskUserQuestion", "16 tasks", "one DAG", "wsh jarvis complete",
	} {
		if !strings.Contains(claude, want) {
			t.Fatalf("claude engine prompt missing %q:\n%s", want, claude)
		}
	}
	if strings.Contains(claude, "import-tasks") {
		t.Fatalf("claude engine prompt must not mention pi-tasks:\n%s", claude)
	}

	// pi keeps push delivery: control events, never the wait loop.
	pi := BuildOrchestratePrompt("do X", principles, "pi", Orchestration_Engine, 0)
	for _, want := range []string{"import-tasks", "control events", "16 tasks", "wsh jarvis dag merge"} {
		if !strings.Contains(pi, want) {
			t.Fatalf("pi engine prompt missing %q:\n%s", want, pi)
		}
	}
	if strings.Contains(pi, "dag wait") || strings.Contains(pi, "--file") {
		t.Fatalf("pi engine prompt must not use the pull loop:\n%s", pi)
	}
}
```

with:

```go
	claude := BuildOrchestratePrompt("do X", principles, "claude", Orchestration_Engine, 0)
	for _, want := range []string{
		"do X", "be clean", "dag submit --file", "end your turn", "wake:", "wsh jarvis dag answer", "wsh jarvis dag forward",
		"wsh jarvis dag merge", "AskUserQuestion", "16 tasks", "one DAG", "wsh jarvis complete",
	} {
		if !strings.Contains(claude, want) {
			t.Fatalf("claude engine prompt missing %q:\n%s", want, claude)
		}
	}
	if strings.Contains(claude, "import-tasks") || strings.Contains(claude, "dag wait") {
		t.Fatalf("claude engine prompt must not mention pi-tasks or the wait loop:\n%s", claude)
	}

	// both runtimes are woken by typed `wake:` lines: no wait loop and no control events.
	pi := BuildOrchestratePrompt("do X", principles, "pi", Orchestration_Engine, 0)
	for _, want := range []string{"import-tasks", "wake:", "wsh jarvis dag forward", "16 tasks", "wsh jarvis dag merge"} {
		if !strings.Contains(pi, want) {
			t.Fatalf("pi engine prompt missing %q:\n%s", want, pi)
		}
	}
	if strings.Contains(pi, "dag wait") || strings.Contains(pi, "--file") || strings.Contains(pi, "control events") {
		t.Fatalf("pi engine prompt must not use the pull loop or control events:\n%s", pi)
	}
}
```

In `pkg/jarvis/run_dagprompt_test.go`, `TestBuildOrchestratePromptPiPublishesTypedTasksAutonomously`, replace the want entry `"respond to control events",` with `"wake:",`.

In `pkg/orchestrate/digest_test_helpers_test.go`, add `"github.com/wavetermdev/waveterm/pkg/baseds"` to the imports, directly above the `waveobj` import. Then replace `digestAsk`'s body:

```go
	return wshrpc.DagAskItem{TaskId: taskID, Question: "should we ship?", Ts: ts, AskId: askID}
```

with:

```go
	return wshrpc.DagAskItem{TaskId: taskID, Questions: []baseds.AgentAskQuestion{{Question: "should we ship?"}}, Ts: ts, AskId: askID}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run (PowerShell, repo root, CGO flags set): `go test ./cmd/wsh/cmd/ -run "TestDagAskLines|TestDagForwardData"`
Expected: FAIL to build with `undefined: dagAskLines`, `undefined: dagForwardData` and `unknown field Owner in struct literal of type wshrpc.DagAskItem`.

Run: `go test ./pkg/jarvis/ -run "TestHandleAskSkipsDagChildren|TestBuildOrchestratePrompt"`
Expected: FAIL. `dag child` reports `gatekeeper handled = true, want false`. The engine prompt tests miss `end your turn` and `wake:`.

Run: `go test ./pkg/wshrpc/wshserver/ -run "TestDagAsks|TestDagForward|TestAgentAskClear"`
Expected: FAIL to build with `asks.Asks[0].Questions undefined` and `undefined: agentask.SetSendInputForTest`.

- [ ] **Step 5: Change `DagAskItem`, the digest summary and the keystroke seam**

In `pkg/wshrpc/wshrpctypes_dag.go`:
- In the `DagCommands` interface, change the `DagActionCommand` line's trailing comment from `// approve | sendback | retry | skip | escalate | cancel` to `// approve | sendback | retry | skip | escalate | cancel | forward`.
- In `CommandDagActionData`, change `Action`'s comment to `// approve | sendback | retry | skip | escalate | cancel | forward | approve-plan | sendback-plan`, and `Notes`'s comment to `// sendback-plan: what the human wants changed, delivered to the lead. forward: what the lead checked and recommends, shown to the human`.
- Replace `DagAskItem`, `DagAskOption` and their comments, from `// DagAskItem is one pending child ask` through the closing brace of `DagAskOption`:

```go
// DagAskItem is one entry in a dag's question queue: the task that raised it, the registry's ask id (so
// the digest and lifecycle events can correlate one ask across raise/answer/clear), who holds it and
// why, every question with its options, the child block the answer is delivered to, and when it was
// raised.
type DagAskItem struct {
	TaskId    string                    `json:"taskid"`
	AskId     string                    `json:"askid,omitempty"`
	Owner     string                    `json:"owner,omitempty"`    // lead | user; empty when the raise could not resolve the dag
	Deadline  int64                     `json:"deadline,omitempty"` // UnixMilli past which a lead-held ask moves to the human
	Note      string                    `json:"note,omitempty"`     // why the holder has it: a forward note, a missed deadline, a failed delivery
	Questions []baseds.AgentAskQuestion `json:"questions"`
	BlockORef string                    `json:"blockoref"`
	Ts        int64                     `json:"ts"`
}
```

In `pkg/orchestrate/digest.go`, `buildTaskDigest`, replace:

```go
		td.AskSummary = truncateText(ask.Question, MaxAskSummaryLen)
```

with:

```go
		if len(ask.Questions) > 0 {
			td.AskSummary = truncateText(ask.Questions[0].Question, MaxAskSummaryLen)
		}
```

In `pkg/agentask/deliver.go`, insert directly below the `sendInput` var:

```go

// SetSendInputForTest swaps the keystroke sink for a test outside this package, which has no PTY to
// type into, and returns the restore.
func SetSendInputForTest(fn func(blockId string, data []byte) error) func() {
	orig := sendInput
	sendInput = fn
	return func() { sendInput = orig }
}
```

- [ ] **Step 6: Serve the queue, `forward`, the clear and the status feed**

In `pkg/wshrpc/wshserver/wshserver_dag.go`, `DagActionCommand`, replace:

```go
		// the lead is blocked in `dag wait`; steering it is what makes the redraft immediate rather
		// than waiting out the poll's timeout. Best effort — the wait loop reads the same feedback.
		steerRunLead(ctx, leadORef(run), planSendBackLine(strings.TrimSpace(data.Notes)))
		return nil
	}
```

with:

```go
		// the lead no longer polls, so typing the notes into its terminal is how it learns of the
		// rejection. Best effort: `dag status` carries the same feedback.
		steerRunLead(ctx, leadORef(run), planSendBackLine(strings.TrimSpace(data.Notes)))
		return nil
	case "forward":
		return orchestrate.ForwardTask(ctx, run.DagORef, data.TaskId, data.Notes)
	}
```

Replace `gatherDagAsks` and its comment (as Task 3 left it, calling `orchestrate.RunBlockORefs`):

```go
// gatherDagAsks lists the dag's question queue: every pending ask of its children, whoever holds it.
// Children block on one ask at a time and their own cards are invisible on the child sessions, so this
// is how the lead (`dag asks`) and the run cockpit see them. Shared by the asks RPC and the status
// digest.
func gatherDagAsks(ctx context.Context, run *waveobj.Run) []wshrpc.DagAskItem {
	g, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		return nil
	}
	var items []wshrpc.DagAskItem
	for i := range g.Tasks {
		task := &g.Tasks[i]
		if task.RunID == "" {
			continue
		}
		child, cerr := wstore.GetRun(ctx, run.ChannelOID, task.RunID)
		if cerr != nil {
			continue
		}
		for _, bo := range orchestrate.RunBlockORefs(ctx, child) {
			pending, ok := agentask.GlobalRegistry.Get(bo)
			if !ok || len(pending.Questions) == 0 {
				continue
			}
			items = append(items, wshrpc.DagAskItem{
				TaskId:    task.ID,
				AskId:     pending.AskId,
				Owner:     pending.Owner,
				Deadline:  pending.Deadline,
				Note:      pending.Note,
				Questions: pending.Questions,
				BlockORef: bo,
				Ts:        pending.Ts,
			})
		}
	}
	return items
}
```

Replace `DagAnswerCommand`'s comment:

```go
// DagAnswerCommand delivers an answer to a child's pending ask (the lead's answer path for the
// `child_ask` control event). The child blocks until the answer resolves, so this is what unblocks
// a question-raised child.
```

with:

```go
// DagAnswerCommand delivers an answer to a child's pending ask: the lead's, after a `wake: N questions
// waiting` line, or the human's, for a question the lead forwarded. The child blocks until the answer
// resolves, so this is what unblocks a question-raised child.
```

In `pkg/wshrpc/wshserver/wshserver_ask.go`, replace:

```go
func (ws *WshServer) AgentAskClearCommand(ctx context.Context, oref string) error {
	if oref == "" {
		return fmt.Errorf("oref is required")
	}
	askId := ""
```

with:

```go
func (ws *WshServer) AgentAskClearCommand(ctx context.Context, oref string) error {
	if oref == "" {
		return fmt.Errorf("oref is required")
	}
	// a dag child clearing its ask is the proof a typed answer reached the picker; without it the sweep
	// puts an answered question back in front of its owner
	agentask.GlobalRegistry.ConfirmClear(oref)
	askId := ""
```

In `pkg/wshrpc/wshserver/wshserver.go`, add `"github.com/wavetermdev/waveterm/pkg/orchestrate"` to the imports, directly below `"github.com/wavetermdev/waveterm/pkg/panichandler"`. Then in `EventPublishCommand` replace:

```go
	if data.Event == wps.Event_AgentStatus {
		PiTitleProviderInstance.NoteEvent(&data)
		retireAskOnResume(&data)
	}
	wps.Broker.Publish(data)
	return nil
}
```

with:

```go
	if data.Event == wps.Event_AgentStatus {
		PiTitleProviderInstance.NoteEvent(&data)
		retireAskOnResume(&data)
	}
	wps.Broker.Publish(data)
	if data.Event == wps.Event_AgentStatus {
		// after the publish: the wake adapter re-reads the lead's state from event history, which has
		// to hold this event already
		orchestrate.NoteLeadStatus(ctx, &data)
	}
	return nil
}
```

- [ ] **Step 7: Skip DAG children in the Gatekeeper**

In `pkg/jarvis/watcher.go`, replace:

```go
func handleAsk(ctx context.Context, data baseds.AgentAskData) {
	ownerORef := ChannelOwnerORef(ctx, data.ORef)
	ch, task := ResolveAskOwner(ctx, ownerORef)
```

with:

```go
func handleAsk(ctx context.Context, data baseds.AgentAskData) {
	ownerORef := ChannelOwnerORef(ctx, data.ORef)
	// a dag child's question waits in its lead's queue: an auto-answer would race the lead's, and an
	// escalation would put a second card in front of the human for the same question
	if m := ResolveRunWorkerFromMeta(ctx, ownerORef); m != nil && isDagChildRun(ctx, m.Run) {
		return
	}
	ch, task := ResolveAskOwner(ctx, ownerORef)
```

Insert directly above `func postAnswered(`:

```go
// isDagChildRun reports a run the engine spawned for a dag task. A dag names its lead in RunID, and the
// lead holds the same DagORef without being a child.
func isDagChildRun(ctx context.Context, run *waveobj.Run) bool {
	if run.DagORef == "" {
		return false
	}
	g, err := wstore.GetDag(ctx, run.DagORef)
	return err == nil && g.RunID != run.ID
}

```

- [ ] **Step 8: `dag asks` prints the queue and `dag forward` hands judgment on**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, change the import block to:

```go
import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)
```

`cmd/wsh` already links `pkg/orchestrate`, which imports `pkg/agentask` since Task 2, so the new import adds nothing to the binary.

Replace `dagAsksCmd`:

```go
var dagAsksCmd = &cobra.Command{
	Use:     "asks",
	Short:   "list the questions waiting on the lead, oldest first, with every option",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		rtn, err := wshclient.DagAsksCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 10_000})
		if err != nil {
			return err
		}
		for _, line := range dagAskLines(rtn.Asks, time.Now().UnixMilli()) {
			fmt.Println(line)
		}
		return nil
	},
}

// dagAskLines renders the lead's question queue, oldest first: every question of every entry the lead
// holds, with the option indexes `dag answer` takes. Entries the human holds are only counted, since
// the lead handed them on and an answer from it would race the human's.
func dagAskLines(asks []wshrpc.DagAskItem, now int64) []string {
	sorted := append([]wshrpc.DagAskItem(nil), asks...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Ts < sorted[j].Ts })
	var lines []string
	held := 0
	for _, a := range sorted {
		if a.Owner == agentask.AskOwner_User {
			held++
			continue
		}
		lines = append(lines, dagAskHeading(a, now))
		if a.Note != "" {
			lines = append(lines, "  note: "+a.Note)
		}
		for _, q := range a.Questions {
			lines = append(lines, dagQuestionLines(q)...)
		}
	}
	if len(lines) == 0 {
		lines = append(lines, "no questions waiting")
	} else {
		lines = append(lines,
			`answer:  wsh jarvis dag answer <task-id> '[{"selectedindexes":[0]}]'  (one item per question, in order; {"text":"..."} for free text)`,
			`forward: wsh jarvis dag forward <task-id> "<what you checked, what you recommend>"`)
	}
	if held > 0 {
		lines = append(lines, fmt.Sprintf("%d held by the human in the run cockpit", held))
	}
	return lines
}

func dagAskHeading(a wshrpc.DagAskItem, now int64) string {
	age := compactDur(now - a.Ts)
	if age == "" {
		age = "0s"
	}
	line := fmt.Sprintf("%s  asked %s ago", a.TaskId, age)
	if a.Deadline == 0 {
		return line
	}
	if left := a.Deadline - now; left > 0 {
		return line + "  deadline in " + compactDur(left)
	}
	return line + "  deadline passed"
}

func dagQuestionLines(q baseds.AgentAskQuestion) []string {
	head := "  " + q.Question
	if q.Header != "" {
		head = fmt.Sprintf("  [%s] %s", q.Header, q.Question)
	}
	if q.MultiSelect {
		head += " (multi-select)"
	}
	lines := []string{head}
	for i, o := range q.Options {
		opt := fmt.Sprintf("    %d) %s", i, o.Label)
		if o.Description != "" {
			opt += " - " + o.Description
		}
		lines = append(lines, opt)
	}
	return lines
}
```

Insert directly above the `// dagAckCmd is invoked by the pi control watcher` comment:

```go
// dagForwardData is the forward action's payload. The note is not checked here: the server owns what
// a forward needs.
func dagForwardData(cmd *cobra.Command, args []string) (wshrpc.CommandDagActionData, error) {
	channelId, runId, err := dagIds(cmd)
	if err != nil {
		return wshrpc.CommandDagActionData{}, err
	}
	return wshrpc.CommandDagActionData{ChannelId: channelId, RunId: runId, TaskId: args[0], Action: "forward", Notes: args[1]}, nil
}

var dagForwardCmd = &cobra.Command{
	Use:     "forward <task-id> <note>",
	Short:   "hand a task's question, failure, stall or merge conflict to the human, with what you checked and recommend",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		data, err := dagForwardData(cmd, args)
		if err != nil {
			return err
		}
		return wshclient.DagActionCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 10_000})
	},
}

```

In `init`, change the first line to:

```go
	jarvisDagCmd.AddCommand(dagSubmitCmd, dagImportCmd, dagStatusCmd, dagMergeCmd, dagAsksCmd, dagAnswerCmd, dagForwardCmd)
```

- [ ] **Step 9: Tell the lead how it is woken**

In `pkg/jarvis/run.go`, `buildEngineOrchestratePrompt`, replace:

```go
	// the gate is stated up front because it changes what submitting means: the lead is publishing a
	// proposal, not starting work, and a lead that does not know this reads the pause after submit as
	// the engine failing to dispatch. How a rejection *arrives* is per-runtime, so it stays inside the
	// fork below — pi is push-delivered and never runs the wait loop.
	b.WriteString("Your submitted plan is a proposal: the human reads the task list and approves it before any worker spawns, so write task labels and descriptions to be read by them. A sent-back plan is discarded — revise it and submit again.\n")
	if runtime == "pi" {
		b.WriteString("Create pi-tasks records and run `wsh jarvis dag import-tasks`; the engine validates and schedules ready children automatically and wakes you with control events; respond to control events as they arrive — do not babysit. If the human sends the plan back you are told directly, with their notes.\n")
	} else {
		b.WriteString("Write the DAG as JSON to a file and submit it with `wsh jarvis dag submit --file <path>`. The JSON is an object with `title`, `parallelism` (1-8), and `tasks`, each task `{\"id\": \"t-1\", \"label\": \"...\", \"description\": \"...\", \"deps\": [\"t-0\"]}`.\n")
		b.WriteString("Then loop: run `wsh jarvis dag wait`, do exactly what it reports, and wait again. Stop when it reports a line beginning `woke: terminal:`. Acting on a reported action is what lets the next wait block — an action you leave untaken makes wait return immediately.\n")
		b.WriteString("While the plan sits at the gate, wait reports nothing to do and simply blocks; a sent-back plan returns `woke: plan-sent-back` followed by the human's notes.\n")
	}
```

with:

```go
	// the gate is stated up front because it changes what submitting means: the lead is publishing a
	// proposal, not starting work, and a lead that does not know this reads the pause after submit as
	// the engine failing to dispatch.
	b.WriteString("Your submitted plan is a proposal: the human reads the task list and approves it before any worker spawns, so write task labels and descriptions to be read by them. A sent-back plan is discarded — revise it and submit again.\n")
	if runtime == "pi" {
		b.WriteString("Create pi-tasks records and run `wsh jarvis dag import-tasks`; the engine validates and schedules ready children automatically.\n")
	} else {
		b.WriteString("Write the DAG as JSON to a file and submit it with `wsh jarvis dag submit --file <path>`. The JSON is an object with `title`, `parallelism` (1-8), and `tasks`, each task `{\"id\": \"t-1\", \"label\": \"...\", \"description\": \"...\", \"deps\": [\"t-0\"]}`.\n")
	}
	// both runtimes are woken by text typed into this terminal, which only lands at an idle prompt: a
	// lead that keeps its turn open to poll never receives it.
	b.WriteString("After submitting, end your turn and do not poll. When something needs your judgment the engine types a line beginning `wake:` into this terminal, naming the event and the command that shows it; handle it, then end your turn again. A sent-back plan is typed here too, with the human's notes.\n")
	b.WriteString("Answer a child's question with `wsh jarvis dag answer <task-id> <answers-json>`. A product or scope call, or a question the plan does not settle, goes to the human with `wsh jarvis dag forward <task-id> \"<what you checked, what you recommend>\"`; a failed task you cannot recover is forwarded the same way.\n")
```

- [ ] **Step 10: Run the tests**

Run (PowerShell, repo root, CGO flags set): `gofmt -l pkg/wshrpc/wshrpctypes_dag.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_ask.go pkg/wshrpc/wshserver/wshserver_dagask_test.go pkg/jarvis/watcher.go pkg/jarvis/watcher_test.go pkg/jarvis/run.go pkg/jarvis/run_test.go pkg/orchestrate/digest.go pkg/agentask/deliver.go cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go`
Expected: no output. If a file is listed, run `gofmt -w` on it.

Run: `go test ./pkg/agentask/ ./pkg/orchestrate/ ./pkg/jarvis/ ./cmd/wsh/cmd/`
Expected: PASS.

Run: `go test ./pkg/wshrpc/wshserver/ -run "Ask|Dag"`
Expected: PASS.

Run: `go build ./...`
Expected: exit 0.

---

### Task 5: Deletions

**Files:**
- Delete: `pkg/orchestrate/control.go`, `pkg/orchestrate/control_test.go`
- Rename and modify: `pkg/wshrpc/wshrpctypes_picontrol.go` to `pkg/wshrpc/wshrpctypes_notify.go`
- Rename and modify: `pkg/wshrpc/wshserver/wshserver_picontrol.go` to `wshserver_notify.go`, and `wshserver_picontrol_test.go` to `wshserver_notify_test.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` (the interface name)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`PiControlAckCommand`, `CommandPiControlAckData`, `DagStatusDigest.Control`, `ControlDigest`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go`, `pkg/wshrpc/wshserver/wshserver_dag_test.go`
- Modify: `pkg/orchestrate/digest.go`, `pkg/orchestrate/digest_test.go`, `pkg/orchestrate/digest_test_helpers_test.go`
- Modify: `pkg/waveobj/runevent.go`, `pkg/waveobj/wtype.go` (a comment)
- Modify: `pkg/wps/wpstypes.go` (the `DagEventChildAsk` payload comment, stale since Task 3)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`
- Modify: `pi/extensions/waveterm-tools.ts`, `pi/extensions/waveterm-tools-core.ts`, `pi/extensions/waveterm-tools-core.test.ts`
- Regenerated, never hand-edited:
  - `task generate`: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`
  - `task sync:piartifacts`: `cmd/wsh/cmd/pi-tools-extension.ts`, `cmd/wsh/cmd/pi-tools-core-extension.ts`

**Interfaces:**
- Consumes:
  - Task 3 already removed every `notifyLeadBestEffort` call and moved `gatedTaskID` out of `control.go`. After Task 3, `control.go`'s only outside reader is `ControlFailureUnavailable` in `digest.go`, which Step 1 deletes.
  - Task 4's `init` first line in `wshcmd-jarvisdag.go`, which registers `dagForwardCmd`.
- Produces:
  - `wshrpc.NotifyCommands` (only `NotifyCommand`) in place of `wshrpc.PiControlCommands`
  - `wshrpc.DagStatusDigest` without `Control`
  - Generated TS without `ControlDigest`, `CommandPiControlAckData`, `PiControlCommandData`, `DagStatusDigest.control`, `RpcApi.PiControlAckCommand` or `RpcApi.PiSendControlCommand`. Task 6 removes the frontend readers.

**Design notes:**
- Spec §10 says to delete `wshrpctypes_picontrol.go` and `wshserver_picontrol.go`, but that is inexact. Both files also hold `wsh notify` (`NotifyCommandData`, `validateNotifyData`, `NotifyCommand`) and `OpenFileData`, which are live. Only the pi control parts go. The files are renamed to `*_notify.go` and the interface to `NotifyCommands`, so the names match what is left.
- The pi extension keeps its `wave_*` tools and the `agent_settled` error notification. The wake adapter types into pi's terminal the same way it types into Claude's, so pi needs no receiver of its own.
- Spec §10 also lists "`agent_settled` control handling". The `agent_settled` handler holds no control logic; it only raises a notification when a pi session ends with an error. It stays. The control handling the spec means lives in `session_start` and `session_shutdown`, and those go.
- `wps.DagEvent*` stay. `publishDagEvent` still publishes them, and the run cockpit subscribes to `dag:child-ask`.
- `lead-control-*` rows already in a database stay, and there is no migration. Nothing reads them, and the timeline shows an unmapped kind as its raw string (`eventKindTitle`).
- This task adds no tests: it only deletes. The compiler catches every code reference, and Step 8's grep catches the strings it cannot.
- After Step 8's `task generate`, `tsc` fails until Task 6. Don't run it in this task.

- [ ] **Step 1: Delete the control digest**

In `pkg/orchestrate/digest.go`, `BuildDigest`, delete the line:

```go
	d.Control = buildControl(sn.Retained)
```

Then delete everything from the `// Control digest statuses (spec 7.1).` comment through the closing brace of `buildControl`: the status consts, `controlRow` and `buildControl`. The next remaining line is the `// askIndex maps task id -> its pending ask.` comment. Keep `"encoding/json"`, because the retained-row parsing still uses it.

In `pkg/orchestrate/digest_test.go`, delete everything from `func controlDigestFor(t *testing.T, retained []waveobj.RunEvent) *wshrpc.ControlDigest {` through the closing brace of `TestControlDigestAbsentWithoutControlRows`: `controlDigestFor` plus the six `TestControlDigest*` tests.

In `pkg/orchestrate/digest_test_helpers_test.go`, delete `controlEvent` and its `// controlEvent builds one lead-control-* row as the control writers persist it.` comment. `encoding/json` and `uuid` stay, because `retainedEvent` and `retainedDagEvent` still use them.

- [ ] **Step 2: Delete `control.go`**

Run: `git rm pkg/orchestrate/control.go pkg/orchestrate/control_test.go`

- [ ] **Step 3: Delete the acknowledgement RPC and the control types**

In `pkg/wshrpc/wshrpctypes_dag.go`:
- In `DagCommands`, delete the line `PiControlAckCommand(ctx context.Context, data CommandPiControlAckData) error // the pi watcher confirms it accepted a lead-control event`.
- Delete `CommandPiControlAckData` and its three-line comment.
- In `DagStatusDigest`, delete the field `Control    *ControlDigest    \`json:"control,omitempty"\``.
- Delete `type ControlDigest struct { ... }`, which is the last declaration in the file.

In `pkg/wshrpc/wshserver/wshserver_dag.go`:
- Remove `"encoding/json"` from the imports. `PiControlAckCommand` was its only user.
- In `DagSubmitCommand`, replace:

```go
		// the notes that produced this draft are answered by it; leaving them would re-wake the lead
		// on the next `dag wait` with feedback it has already acted on.
```

with:

```go
		// the notes that produced this draft are answered by it; leaving them would hand the lead
		// feedback it has already acted on the next time it reads `dag status`.
```

- Replace the `dagDigestRetainedKinds` comment and declaration:

```go
// dagDigestRetainedKinds are the lifecycle boundaries the digest derives durations/retries/control
// from. The UI's 200-row window is not consulted.
var dagDigestRetainedKinds = []string{
	waveobj.RunEventKindTaskRetried,
	waveobj.RunEventKindTaskDone,
	waveobj.RunEventKindTaskMergeStarted,
	waveobj.RunEventKindTaskCleanupPending,
	waveobj.RunEventKindTaskCleanupCompleted,
	waveobj.RunEventKindTaskCleanupFailed,
	waveobj.RunEventKindDagDone,
	waveobj.RunEventKindDagCancelled,
	waveobj.RunEventKindLeadControlSent,
	waveobj.RunEventKindLeadControlFailed,
	waveobj.RunEventKindLeadControlAcknowledged,
}
```

with:

```go
// dagDigestRetainedKinds are the lifecycle boundaries the digest derives durations and retries from.
// The UI's 200-row window is not consulted.
var dagDigestRetainedKinds = []string{
	waveobj.RunEventKindTaskRetried,
	waveobj.RunEventKindTaskDone,
	waveobj.RunEventKindTaskMergeStarted,
	waveobj.RunEventKindTaskCleanupPending,
	waveobj.RunEventKindTaskCleanupCompleted,
	waveobj.RunEventKindTaskCleanupFailed,
	waveobj.RunEventKindDagDone,
	waveobj.RunEventKindDagCancelled,
}
```

- Delete everything from the `// controlAckKinds are the rows an acknowledgement is checked against` comment through the closing brace of `PiControlAckCommand`. The next remaining line is `func (ws *WshServer) DagActionCommand(`.

In `pkg/wshrpc/wshserver/wshserver_dag_test.go`:
- Delete everything from the `// controlAckFixture seeds a channel + orchestrator run carrying a dag` comment through the closing brace of `ackRows`: `controlAckFixture`, `seedControlEvent` and `ackRows`.
- Delete everything from `func TestPiControlAckAppendsOnceAndIsIdempotent(t *testing.T) {` through the closing brace of `TestPiControlAckRejectsFailedDelivery`: the four `TestPiControlAck*` tests.
- Keep `TestDagDigestChildRunLimitCoversTaskCap`, which sits between the two blocks. `uuid`, `jarvis`, `waveobj` and `wshrpc` all stay in use elsewhere in the file.

- [ ] **Step 4: Delete the pi control RPC, keeping notify**

Run:

```powershell
git mv pkg/wshrpc/wshrpctypes_picontrol.go pkg/wshrpc/wshrpctypes_notify.go
git mv pkg/wshrpc/wshserver/wshserver_picontrol.go pkg/wshrpc/wshserver/wshserver_notify.go
git mv pkg/wshrpc/wshserver/wshserver_picontrol_test.go pkg/wshrpc/wshserver/wshserver_notify_test.go
```

Read `pkg/wshrpc/wshrpctypes_notify.go`, then replace the whole file with:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// NotifyCommandData is the payload for wsh notify and the wave_notify tool.
type NotifyCommandData struct {
	Title   string `json:"title"`
	Message string `json:"message"`
	Level   string `json:"level"` // info | warn | error (default info)
}

// OpenFileData is the payload for wsh open/view/edit: route a path into the cockpit's code surface.
type OpenFileData struct {
	Path string `json:"path"`
	Edit bool   `json:"edit,omitempty"`
}

// NotifyCommands is the wshrpc domain for cockpit notifications.
type NotifyCommands interface {
	NotifyCommand(ctx context.Context, data NotifyCommandData) error
}
```

In `pkg/wshrpc/wshrpctypes.go`, in the `WshRpcInterface` embed list, change `PiControlCommands` to `NotifyCommands`.

Read `pkg/wshrpc/wshserver/wshserver_notify.go`, then replace the whole file with:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func validateNotifyData(data wshrpc.NotifyCommandData) error {
	if data.Title == "" {
		return fmt.Errorf("notify title is required")
	}
	if data.Level != "" && data.Level != "info" && data.Level != "warn" && data.Level != "error" {
		return fmt.Errorf("invalid notify level %q (want info, warn, or error)", data.Level)
	}
	return nil
}

func (ws *WshServer) NotifyCommand(ctx context.Context, data wshrpc.NotifyCommandData) error {
	if err := validateNotifyData(data); err != nil {
		return err
	}
	if data.Level == "" {
		data.Level = "info"
	}
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_Notify, Data: data})
	return nil
}
```

Read `pkg/wshrpc/wshserver/wshserver_notify_test.go`, then replace the whole file with:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestValidateNotifyData(t *testing.T) {
	if err := validateNotifyData(wshrpc.NotifyCommandData{Title: "hi"}); err != nil {
		t.Fatalf("valid notify rejected: %v", err)
	}
	for _, tc := range []struct {
		name string
		data wshrpc.NotifyCommandData
		want string
	}{
		{"empty title", wshrpc.NotifyCommandData{}, "title is required"},
		{"bad level", wshrpc.NotifyCommandData{Title: "hi", Level: "loud"}, "invalid notify level"},
	} {
		if err := validateNotifyData(tc.data); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want error containing %q", tc.name, err, tc.want)
		}
	}
}
```

- [ ] **Step 5: Delete the lead-control run event kinds**

In `pkg/waveobj/runevent.go`, delete the comment line:

```go
	//   lead-control-*                lead-control delivery + acknowledgement (stable event id)
```

and the three consts:

```go
	RunEventKindLeadControlSent         = "lead-control-sent"
	RunEventKindLeadControlFailed       = "lead-control-failed"
	RunEventKindLeadControlAcknowledged = "lead-control-acknowledged"
```

Task 2's `RunEventKindTaskForwarded`, `RunEventKindLeadWoken` and `RunEventKindLeadWakeFailed` stay where Task 2 put them. Run `gofmt -w pkg/waveobj/runevent.go` to realign the const block.

In `pkg/waveobj/wtype.go`, `Run.PlanFeedback`, replace:

```go
	// PlanFeedback is what the human wrote when they sent this run's gated plan back. The lead reads
	// it through `wsh jarvis dag wait` and redrafts; the next accepted submission clears it, so a
	// redraft is never answered with the notes that produced it.
```

with:

```go
	// PlanFeedback is what the human wrote when they sent this run's gated plan back. The lead is
	// handed it in its terminal and from `wsh jarvis dag status`, and redrafts; the next accepted
	// submission clears it, so a redraft is never answered with the notes that produced it.
```

In `pkg/wps/wpstypes.go`, replace:

```go
	DagEventChildAsk    = "dag:child-ask"    // type: string (JSON {taskid, question})
```

with:

```go
	DagEventChildAsk    = "dag:child-ask"    // type: string (JSON {taskid, askid})
```

In `pkg/tsgen/tsgenevent.go`, replace:

```go
	wps.DagEventChildAsk:       reflect.TypeOf(""), // detail is JSON {taskid, question}
```

with:

```go
	wps.DagEventChildAsk:       reflect.TypeOf(""), // detail is JSON {taskid, askid}
```

Task 3's `publishChildAsk` sends `{taskid, askid}`, and nothing reads the event's payload. The run cockpit re-reads `dag asks` whenever the event arrives, and `wshserver_dagask_test.go` checks only the event's scope. Neither `tsgen` nor `wps` parses these comments, so the generated TS doesn't change.

- [ ] **Step 6: Delete `dag wait` and `dag ack`**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`:
- Delete everything from the `// dagWaitEvents is every engine event that can change what the lead should do next.` comment through the closing `}` of `dagWaitCmd`: `dagWaitEvents`, `waitDecision`, `printDagWait`, `DagWaitDefaultTimeout` and `dagWaitCmd`. The next remaining line is the `// dagStatusLines renders the shared digest` comment.
- Delete `dagAckCmd` and its three-line `// dagAckCmd is invoked by the pi control watcher, not by a human` comment. Task 4 inserted `dagForwardCmd` directly above that comment; `dagForwardCmd` stays.
- Remove `"github.com/wavetermdev/waveterm/pkg/waveobj"` and `"github.com/wavetermdev/waveterm/pkg/wps"` from the imports. `dagWaitCmd` was their only user. `time` stays, because `dagInitCmd` uses it.
- In `init`, change `jarvisDagCmd.AddCommand(dagInitCmd, dagAckCmd, dagWaitCmd)` to `jarvisDagCmd.AddCommand(dagInitCmd)`.
- In `init`, delete these three flag lines:

```go
	dagWaitCmd.Flags().Int("timeout", DagWaitDefaultTimeout, "seconds to block before returning the current digest")
```

```go
	dagAckCmd.Flags().String("event", "", "control event id from the control file envelope")
	dagAckCmd.Flags().String("session", "", "pi session id the control file was written for")
```

In `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, delete `TestWaitDecision`, which is the last function in the file. Every import stays in use.

- [ ] **Step 7: Delete the pi control watcher**

In `pi/extensions/waveterm-tools.ts`, replace the header comment and the imports, from line 1 through `} from "./waveterm-tools-core";`, with:

```ts
// pi extension: wave_* tools (pi drives arc) and the notification bridge (B3). Installed by
// `wsh install-agent-hooks` into ~/.pi/agent/extensions/waveterm-tools.ts with __WSH_PATH__
// substituted for the absolute wsh path. Bare pi outside a Wave block is inert: the tools fail closed
// with a clear error.
import { Type } from "typebox";
import {
    captureTailArgs,
    notifyArgs,
    openFileArgs,
    querySessionsArgs,
    runCommandArgs,
    vaultAskArgs,
} from "./waveterm-tools-core";
```

Then delete everything from the `// --- B2: control channel watcher ---` comment through the closing `});` of the `pi.on("session_shutdown", ...)` handler. That removes `ackControl`, `makeDispatcher`, `startControlWatcher`, `cleanup` and the `session_start` and `session_shutdown` handlers. The end of the file must read:

```ts
    pi.on("agent_settled", async (event: any, ctx: any) => {
        // The settled-payload error signal is confirmed during Task 8's live round-trip; the
        // predicate below covers the documented error carriers (event.error / ctx.lastError).
        if (event?.error || ctx?.lastError) {
            await notify("Pi session ended with an error", { level: "error" });
        }
    });
}

export default function wavetermTools(pi: any): void {
    registerWavetermTools(pi, "__WSH_PATH__");
}
```

In `pi/extensions/waveterm-tools-core.ts`, replace the three-line header comment with:

```ts
// Pure helpers for the waveterm tools extension. No external imports so the repo's vitest can cover
// it. The default export is a no-op: pi auto-loads every file in the extensions directory, and this
// module is a dependency, not an extension.
```

Then delete:
- everything from `export const CONTROL_COMMANDS = [` through the closing brace of `dagEventMessage`, which removes `CONTROL_COMMANDS`, `ControlCommand`, `PiControlCommand`, `controlFileName` and `dagEventMessage`
- everything from `export function parseControlCommand(raw: string): PiControlCommand | null {` through the closing brace of `makeSerialChain`, which removes `parseControlCommand`, `controlAckArgs` and `makeSerialChain`

`runCommandArgs`, `captureTailArgs`, `openFileArgs`, `querySessionsArgs`, `notifyArgs`, `vaultAskArgs` and the `noop` default export stay.

In `pi/extensions/waveterm-tools-core.test.ts`:
- Replace the import block with:

```ts
import {
    captureTailArgs,
    notifyArgs,
    openFileArgs,
    querySessionsArgs,
    runCommandArgs,
    vaultAskArgs,
} from "./waveterm-tools-core";
```

- Delete these six tests:
  - `it("names control files by session id", ...)`
  - `it("parses a valid control command", ...)`
  - `it("preserves the engine's envelope fields", ...)`
  - `it("has nothing to acknowledge for a control file without an envelope", ...)`
  - `it("rejects malformed or unknown control commands", ...)`
  - `it("accepts dag control commands and maps them to notification lines", ...)`
- Delete the whole `describe("makeSerialChain", ...)` block.
- Keep the run, capture-tail, open-file and query-sessions, notify, and `wsh jarvis ask` argv tests.

- [ ] **Step 8: Regenerate and sweep**

Run: `task generate`
Expected: exit 0. Afterwards:
- `pkg/wshrpc/wshclient/wshclient.go` no longer has `PiControlAckCommand` or `PiSendControlCommand`.
- `frontend/app/store/wshclientapi.ts` loses the same two methods.
- `frontend/types/gotypes.d.ts` loses `CommandPiControlAckData`, `PiControlCommandData`, `ControlDigest` and `DagStatusDigest.control`, and `DagAskItem` gains Task 4's fields.

Run: `task sync:piartifacts`
Expected: exit 0. `cmd/wsh/cmd/pi-tools-extension.ts` and `cmd/wsh/cmd/pi-tools-core-extension.ts` now match the edited `pi/extensions` sources.

Run: `git grep --untracked -n -E "PiControl|PiSendControl|ControlDigest|LeadControl|WAVETERM_PI_CONTROL_DIR|NotifyLead|dagWaitCmd|waitDecision|DagWaitDefaultTimeout|controlAckArgs|parseControlCommand|makeSerialChain|dagEventMessage" -- pkg cmd pi`
Expected: no output.

Run: `git grep --untracked -n -E "lead-control|controlWarning|ControlDigest" -- frontend`
Expected: hits only in these files, all of which Task 6 cleans up:
- `frontend/app/view/orchestrate/dagdigest.ts`
- `frontend/app/view/orchestrate/dagdigest.test.ts`
- `frontend/app/view/orchestrate/dagoverview.tsx`
- `frontend/app/view/agents/runtimeline.ts`
- `frontend/app/view/orchestrate/timelinefilter.ts`
- `frontend/app/view/orchestrate/timelinefilter.test.ts`

- [ ] **Step 9: Run the tests**

Run (PowerShell, repo root, CGO flags set): `gofmt -l pkg/orchestrate pkg/wshrpc pkg/waveobj cmd/wsh/cmd`
Expected: no output. If a file is listed, run `gofmt -w` on it.

Run: `go build ./...`
Expected: exit 0.

Run: `go vet ./pkg/orchestrate/ ./pkg/wshrpc/... ./pkg/waveobj/ ./cmd/wsh/cmd/`
Expected: exit 0.

Run: `go test ./pkg/orchestrate/ ./pkg/wshrpc/... ./pkg/waveobj/ ./cmd/wsh/cmd/`
Expected: PASS.

Run: `npx vitest run pi/extensions`
Expected: PASS.

---

### Task 6: Frontend

**Files:**
- Create: `frontend/app/view/agents/childaskmodel.ts`, `frontend/app/view/agents/childaskmodel.test.ts`
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (`toAskQuestions`, extracted from `withAsk`)
- Modify: `frontend/app/view/agents/answerbar.tsx` (the `showHint` prop)
- Modify: `frontend/app/view/agents/childaskstore.ts` (whole file: refresh guard, per-entry answer state, `submitChildAnswer`; `answerChildAsk` is deleted)
- Modify: `frontend/app/view/agents/childaskcard.tsx` (whole file)
- Modify: `frontend/app/view/agents/runtimeline.ts`, `frontend/app/view/agents/runtimeline.test.ts`
- Modify: `frontend/app/view/orchestrate/timelinefilter.ts`, `frontend/app/view/orchestrate/timelinefilter.test.ts`
- Modify: `frontend/app/view/orchestrate/dagdigest.ts`, `frontend/app/view/orchestrate/dagdigest.test.ts`, `frontend/app/view/orchestrate/dagoverview.tsx`

**Interfaces:**
- Consumes:
  - The generated type after Task 5: `DagAskItem = { taskid: string; askid?: string; owner?: string; deadline?: number; note?: string; questions: AgentAskQuestion[]; blockoref: string; ts: number }`
  - Task 2's run event kinds and details:
    - `task-forwarded`: `taskid`, `askid`, `note`
    - `lead-woken`: `text`
    - `lead-wake-failed`: `reason`, `lines`
  - Task 5: `DagStatusDigest` has no `control`.
  - Existing:
    - `AnswerBar` (`answerbar.tsx`)
    - `toggleSelection`, `buildAskAnswers`, `canSubmitAsk` (`agentsviewmodel.ts`)
    - `useRunEvents` (`runeventstore.ts`)
    - `detailOf` (`runtimeline.ts`)
    - `RpcApi.DagAnswerCommand`
- Produces:
  - `export function toAskQuestions(questions: AgentAskData["questions"]): AgentAskQuestion[]` in `agentsviewmodel.ts`
  - In `childaskmodel.ts`:
    - `ASK_OWNER_USER`
    - `childAskKey(ask: DagAskItem): string`
    - `userOwnedAsks(asks: DagAskItem[]): DagAskItem[]`
    - `childAskAgent(ask: DagAskItem): AgentVM`
    - `childAskSent(sentTs: number | undefined, ask: DagAskItem, events: RunEvent[]): boolean`
    - `newAskEventIds(events: RunEvent[], seen: Set<string>): string[]`
  - In `childaskstore.ts`:
    - atoms `childAskSelAtom`, `childAskTextAtom`, `childAskSentAtom`, `childAskErrorAtom`
    - `toggleChildAnswer(ask, qi, oi)`, `setChildAnswerText(ask, qi, value)`, `submitChildAnswer(channelId, runId, ask)`
  - `AnswerBar` prop `showHint?: boolean` (default `true`)

**Design notes:**
- The card reuses the cockpit's `AnswerBar`, which already renders headers, option descriptions, multi-select and several questions. A queue entry is adapted to the `AgentVM` the bar takes, so there is no second picker.
- Picks and typed text live in store atoms keyed by entry, not in component state. The bar calls `onSubmit` in the same click that records a single-select's last pick, before any re-render, so a submit that read React state would miss that pick. The cockpit keeps `answerSelAtom` in its model for the same reason.
- Only user-owned entries render. A lead-owned entry is the lead's to answer, and two answerers on one question would race to type into the child.
- **Sent state.** An answered entry reads "Answered" until the child clears it. An answer the child never consumed comes back through `forwardAskToUser`, which always appends `task-forwarded` with the ask id. A `task-forwarded` row newer than the send therefore makes the entry answerable again. The note cannot be the signal, because the first and second failed deliveries both carry `AnswerUnconfirmedNote`.
- **Refresh.** Clearing an answer publishes only the `child-ask-cleared` run row, not `dag:child-ask`. So the card also refreshes on unseen `child-ask`, `task-forwarded`, `child-answered` and `child-ask-cleared` rows, using the seen-id pattern from `useDagDigest`. The `dag:child-ask` subscription stays for the publishes that have no row, such as a delivery handed back to the lead. Its `if (cur.length === 0) return;` guard goes: a question handed to a card that shows nothing must still appear.
- A failed send drops the sent mark and shows the error under the entry. The old `answerChildAsk` swallowed the error.
- `AnswerBar` gains `showHint`, because its "press Enter to submit" hint is wrong on a card that has a Send button and no Enter binding. The bar's two existing callers don't change.
- The digest's refresh set only loses the lead-control kinds. A forward changes who holds a question, not the digest.
- Existing tokens only. The card keeps its warning palette.
- No render test (repo convention). The model is unit-tested, and Task 7's live check covers the rendering.

- [ ] **Step 1: Write the failing model tests**

Create `frontend/app/view/agents/childaskmodel.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { childAskAgent, childAskKey, childAskSent, newAskEventIds, userOwnedAsks } from "./childaskmodel";

function entry(over: Partial<DagAskItem>): DagAskItem {
    return {
        taskid: "t-1",
        askid: "a-1",
        owner: "user",
        questions: [{ question: "which ttl?" }],
        blockoref: "block:b1",
        ts: 1,
        ...over,
    };
}

function ev(kind: string, ts: number, detail?: Record<string, unknown>): RunEvent {
    return {
        id: `${kind}-${ts}`,
        runid: "run-1",
        channelid: "ch-1",
        ts,
        kind,
        detail: detail == null ? undefined : JSON.stringify(detail),
    };
}

describe("userOwnedAsks", () => {
    it("keeps only the human's entries, oldest first", () => {
        const asks = [
            entry({ taskid: "t-3", askid: "a-3", ts: 30 }),
            entry({ taskid: "t-2", askid: "a-2", owner: "lead", ts: 5 }),
            entry({ taskid: "t-1", askid: "a-1", ts: 10 }),
            entry({ taskid: "t-4", askid: "a-4", owner: undefined, ts: 1 }),
        ];
        expect(userOwnedAsks(asks).map((a) => a.taskid)).toEqual(["t-1", "t-3"]);
    });
});

describe("childAskAgent", () => {
    it("carries every question in the answer bar's shape", () => {
        const agent = childAskAgent(
            entry({
                questions: [
                    {
                        header: "Cache",
                        question: "which ttl?",
                        options: [{ label: "24h", description: "matches prod" }, { label: "7d" }],
                    },
                    { question: "which regions?", multiselect: true, options: [{ label: "eu" }, { label: "us" }] },
                ],
            })
        );
        expect(agent.state).toBe("asking");
        expect(agent.id).toBe("a-1");
        expect(agent.ask?.askId).toBe("a-1");
        expect(agent.ask?.oref).toBe("block:b1");
        expect(agent.ask?.questions).toEqual([
            {
                header: "Cache",
                question: "which ttl?",
                options: [{ label: "24h", description: "matches prod" }, { label: "7d" }],
            },
            { question: "which regions?", multiSelect: true, options: [{ label: "eu" }, { label: "us" }] },
        ]);
    });

    it("keys an entry by its task when the ask id is missing", () => {
        expect(childAskKey(entry({ askid: undefined }))).toBe("t-1");
        expect(childAskAgent(entry({ askid: undefined })).id).toBe("t-1");
    });
});

describe("childAskSent", () => {
    it("is unanswered until the human sends", () => {
        expect(childAskSent(undefined, entry({}), [])).toBe(false);
    });

    it("stays answered while nothing handed the question back", () => {
        expect(childAskSent(100, entry({}), [ev("child-answered", 150, { taskid: "t-1", askid: "a-1" })])).toBe(true);
    });

    it("is answerable again once the question comes back after the send", () => {
        const back = ev("task-forwarded", 200, { taskid: "t-1", askid: "a-1", note: "answer was sent but never confirmed" });
        expect(childAskSent(100, entry({}), [back])).toBe(false);
    });

    it("ignores a hand-off from before the send or for another ask", () => {
        const before = ev("task-forwarded", 50, { taskid: "t-1", askid: "a-1" });
        const other = ev("task-forwarded", 200, { taskid: "t-9", askid: "a-9" });
        expect(childAskSent(100, entry({}), [before, other])).toBe(true);
    });
});

describe("newAskEventIds", () => {
    it("returns the unseen rows that change the queue", () => {
        const events = [
            ev("child-ask", 1),
            ev("task-forwarded", 2),
            ev("child-answered", 3),
            ev("child-ask-cleared", 4),
            ev("task-done", 5),
        ];
        expect(newAskEventIds(events, new Set(["child-ask-1"]))).toEqual([
            "task-forwarded-2",
            "child-answered-3",
            "child-ask-cleared-4",
        ]);
    });
});
```

- [ ] **Step 2: Run the model tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/childaskmodel.test.ts`
Expected: FAIL, with vitest unable to resolve `./childaskmodel`.

- [ ] **Step 3: Extract `toAskQuestions` and write the model**

In `frontend/app/view/agents/agentsviewmodel.ts`, `withAsk`, replace:

```ts
        ask: {
            questions: (ask.questions ?? []).map((q) => ({
                question: q.question,
                header: q.header,
                multiSelect: q.multiselect,
                options: q.options?.map((o) => ({ label: o.label, description: o.description, preview: o.preview })),
            })),
            askId: ask.askid,
```

with:

```ts
        ask: {
            questions: toAskQuestions(ask.questions),
            askId: ask.askid,
```

Insert directly above `export function withAsk(`:

```ts
/** Pure: wire ask questions (lowercase Go json tags) in the view model's shape. Shared by the session ask
 *  and the dag child-ask card, so both render one question shape. */
export function toAskQuestions(questions: AgentAskData["questions"]): AgentAskQuestion[] {
    return (questions ?? []).map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiselect,
        options: q.options?.map((o) => ({ label: o.label, description: o.description, preview: o.preview })),
    }));
}

```

Create `frontend/app/view/agents/childaskmodel.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: which dag child questions the run surface shows, in the shape the cockpit's AnswerBar renders,
// and when the card must re-read the queue. Kept out of the card so it is testable without a DOM.

import { toAskQuestions, type AgentVM } from "./agentsviewmodel";
import { detailOf } from "./runtimeline";

// ASK_OWNER_USER mirrors agentask.AskOwner_User.
export const ASK_OWNER_USER = "user";

// the run rows that change what the queue holds: a raise, a hand-off to the human, an answer, and the
// child clearing its ask
const ASK_QUEUE_EVENT_KINDS = new Set(["child-ask", "task-forwarded", "child-answered", "child-ask-cleared"]);

// childAskKey falls back to the task id because the wire type leaves the ask id optional.
export function childAskKey(ask: DagAskItem): string {
    return ask.askid || ask.taskid;
}

// userOwnedAsks is what the card shows, oldest first. A lead-held entry is the lead's to answer, and two
// answerers on one question would race to type into the child.
export function userOwnedAsks(asks: DagAskItem[]): DagAskItem[] {
    return asks.filter((a) => a.owner === ASK_OWNER_USER).sort((a, b) => a.ts - b.ts);
}

// childAskAgent adapts an entry to the AgentVM the AnswerBar takes; the bar reads only the ask and the
// asking state.
export function childAskAgent(ask: DagAskItem): AgentVM {
    return {
        id: childAskKey(ask),
        name: ask.taskid,
        task: "",
        state: "asking",
        ask: { questions: toAskQuestions(ask.questions), askId: ask.askid, oref: ask.blockoref },
    };
}

// childAskSent reports whether the entry still stands answered from this card. An answer the child never
// consumed is handed back through a task-forwarded row, and that row is the only signal: the note is the
// same on the first and the second failed delivery.
export function childAskSent(sentTs: number | undefined, ask: DagAskItem, events: RunEvent[]): boolean {
    if (sentTs == null) {
        return false;
    }
    return !events.some((e) => {
        if (e.kind !== "task-forwarded" || e.ts <= sentTs) {
            return false;
        }
        const detail = detailOf<{ taskid?: string; askid?: string }>(e);
        return ask.askid ? detail?.askid === ask.askid : detail?.taskid === ask.taskid;
    });
}

// newAskEventIds returns the queue-changing rows the card has not refreshed for yet.
export function newAskEventIds(events: RunEvent[], seen: Set<string>): string[] {
    return events.filter((e) => ASK_QUEUE_EVENT_KINDS.has(e.kind) && !seen.has(e.id)).map((e) => e.id);
}
```

- [ ] **Step 4: Run the model tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/childaskmodel.test.ts frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS. The existing `withAsk` tests in `agentsviewmodel.test.ts` pin the extraction.

- [ ] **Step 5: Rewrite the store**

Read `frontend/app/view/agents/childaskstore.ts`, then replace the whole file with:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The run's dag child questions and the human's answers to them. Children's own session cards are
// invisible to the human, so the parent-run surface shows the questions that are the human's to answer.
// The engine publishes dag:child-ask (scoped to the dag + owning run) when the queue changes, and this
// store refreshes the list from the asks RPC on that event, on the card's run rows, and on mount.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { buildAskAnswers, canSubmitAsk, toAskQuestions, toggleSelection } from "./agentsviewmodel";
import { childAskKey } from "./childaskmodel";

export const childAsksAtom = atom<DagAskItem[]>([]);

// per-entry picks, typed answers, send times and send errors, keyed by childAskKey. In the store, not
// the card: the AnswerBar submits in the same click that records a single-select's last pick, before
// the card re-renders.
export const childAskSelAtom = atom<Record<string, Record<number, Set<number>>>>({});
export const childAskTextAtom = atom<Record<string, Record<number, string>>>({});
export const childAskSentAtom = atom<Record<string, number>>({});
export const childAskErrorAtom = atom<Record<string, string>>({});

let subscribed = false;
export function setupChildAskSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "dag:child-ask",
        // any queue change may concern the visible run, and a card showing nothing must still pick up a
        // question just handed to the human; the refresh is cheap
        handler: () => refreshChildAsksFromAtom(),
    });
}

// refreshChildAsks reloads the pending asks for the run's dag. Errors (dag gone, server restart) leave
// the current list — the next event or mount refreshes it again.
export function refreshChildAsks(channelId: string, runId: string) {
    if (!channelId || !runId) {
        return;
    }
    fireAndForget(async () => {
        try {
            const rtn = await RpcApi.DagAsksCommand(TabRpcClient, { channelid: channelId, runid: runId });
            globalStore.set(childAsksAtom, rtn?.asks ?? []);
        } catch {
            // dag may be gone; keep the current list
        }
    });
}

// refreshChildAsksFromAtom re-queries using the last run ids seen (stored alongside the list).
let lastCtx: { channelId: string; runId: string } | null = null;
export function refreshChildAsksFromAtom() {
    if (lastCtx) {
        refreshChildAsks(lastCtx.channelId, lastCtx.runId);
    }
}

// bindChildAsks remembers the run whose asks the surface shows and loads them once.
export function bindChildAsks(channelId: string, runId: string) {
    if (lastCtx?.channelId === channelId && lastCtx?.runId === runId && globalStore.get(childAsksAtom).length > 0) {
        return;
    }
    lastCtx = { channelId, runId };
    refreshChildAsks(channelId, runId);
}

export function toggleChildAnswer(ask: DagAskItem, qi: number, oi: number) {
    const key = childAskKey(ask);
    const all = globalStore.get(childAskSelAtom);
    const multiSelect = ask.questions[qi]?.multiselect ?? false;
    globalStore.set(childAskSelAtom, { ...all, [key]: toggleSelection(all[key] ?? {}, qi, oi, multiSelect) });
}

export function setChildAnswerText(ask: DagAskItem, qi: number, value: string) {
    const key = childAskKey(ask);
    const all = globalStore.get(childAskTextAtom);
    globalStore.set(childAskTextAtom, { ...all, [key]: { ...(all[key] ?? {}), [qi]: value } });
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
    const next = { ...rec };
    delete next[key];
    return next;
}

// submitChildAnswer sends the entry's answers once every question has one. A failed send drops the sent
// mark and records the error, so the entry is answerable again and says why.
export function submitChildAnswer(channelId: string, runId: string, ask: DagAskItem) {
    const key = childAskKey(ask);
    const questions = toAskQuestions(ask.questions);
    const selections = globalStore.get(childAskSelAtom)[key] ?? {};
    const texts = globalStore.get(childAskTextAtom)[key] ?? {};
    if (!canSubmitAsk(questions, selections, texts)) {
        return;
    }
    const answers = buildAskAnswers(questions, selections, texts);
    globalStore.set(childAskSentAtom, { ...globalStore.get(childAskSentAtom), [key]: Date.now() });
    globalStore.set(childAskErrorAtom, withoutKey(globalStore.get(childAskErrorAtom), key));
    fireAndForget(async () => {
        try {
            await RpcApi.DagAnswerCommand(TabRpcClient, {
                channelid: channelId,
                runid: runId,
                taskid: ask.taskid,
                answers,
            });
        } catch (err) {
            globalStore.set(childAskSentAtom, withoutKey(globalStore.get(childAskSentAtom), key));
            globalStore.set(childAskErrorAtom, { ...globalStore.get(childAskErrorAtom), [key]: String(err) });
        }
        refreshChildAsks(channelId, runId);
    });
}
```

- [ ] **Step 6: Let the answer bar drop its hint**

In `frontend/app/view/agents/answerbar.tsx`, `AnswerBar`:
- In the destructured props, insert `showHint = true,` directly after `onDismiss,`.
- In the props type, insert `showHint?: boolean;` directly after `onDismiss?: () => void;`.
- The hint line appears twice, at two indentation levels: once in the single-question return and once in the tabbed return. With replace-all, replace the fragment `{hint ? <div className="mt-2 text-[11px] text-secondary">{hint}</div> : null}` with `{showHint && hint ? <div className="mt-2 text-[11px] text-secondary">{hint}</div> : null}`. Leave each line's indentation as it is.

- [ ] **Step 7: Rewrite the card**

Read `frontend/app/view/agents/childaskcard.tsx`, then replace the whole file with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Child-ask card: the questions of this run's dag children that are the human's to answer. A child's
// question goes to the lead first; what the lead forwards, and what it left past its deadline or could not
// deliver, lands here with the reason. The child's own ask card sits on a session nobody sees, so this is
// where the human answers it, through the dag answer path.

import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { canSubmitAsk } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { childAskAgent, childAskKey, childAskSent, newAskEventIds, userOwnedAsks } from "./childaskmodel";
import {
    bindChildAsks,
    childAskErrorAtom,
    childAskSelAtom,
    childAskSentAtom,
    childAskTextAtom,
    childAsksAtom,
    refreshChildAsks,
    setChildAnswerText,
    submitChildAnswer,
    toggleChildAnswer,
} from "./childaskstore";
import { useRunEvents } from "./runeventstore";

export function ChildAskCard({ channelId, runId }: { channelId: string; runId: string }) {
    const asks = userOwnedAsks(useAtomValue(childAsksAtom));
    const selections = useAtomValue(childAskSelAtom);
    const texts = useAtomValue(childAskTextAtom);
    const sent = useAtomValue(childAskSentAtom);
    const errors = useAtomValue(childAskErrorAtom);
    const events = useRunEvents(runId, channelId);
    const seenEventsRef = useRef(new Set<string>());
    const [activeQuestion, setActiveQuestion] = useState<Record<string, number>>({});

    useEffect(() => {
        bindChildAsks(channelId, runId);
    }, [channelId, runId]);

    // an answer clearing publishes no dag:child-ask, only its run row, so the rows drive a refresh too
    useEffect(() => {
        const fresh = newAskEventIds(events, seenEventsRef.current);
        if (fresh.length === 0) {
            return;
        }
        for (const id of fresh) {
            seenEventsRef.current.add(id);
        }
        refreshChildAsks(channelId, runId);
    }, [events, channelId, runId]);

    if (asks.length === 0) {
        return null;
    }
    return (
        <div className="mb-4 overflow-hidden rounded-xl border border-warning/30 bg-warning/5">
            <div className="flex items-center gap-2 border-b border-warning/15 px-3.5 py-2">
                <span className="text-[12px] text-warning">?</span>
                <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-warning">
                    Questions for you
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10px] text-muted">{asks.length} waiting</span>
            </div>
            <div className="flex flex-col gap-2 px-3.5 py-3">
                {asks.map((a) => {
                    const key = childAskKey(a);
                    const agent = childAskAgent(a);
                    const answered = childAskSent(sent[key], a, events);
                    const ready = canSubmitAsk(agent.ask?.questions ?? [], selections[key] ?? {}, texts[key] ?? {});
                    return (
                        <div key={key} className="rounded-[9px] border border-warning/20 bg-background px-3 py-2.5">
                            <div className="font-mono text-[10px] text-ink-mid">{a.taskid}</div>
                            {a.note ? <div className="mt-1 text-[12px] text-secondary">{a.note}</div> : null}
                            <AnswerBar
                                agent={agent}
                                selections={selections[key] ?? {}}
                                texts={texts[key] ?? {}}
                                sent={answered}
                                showHint={false}
                                activeQuestion={activeQuestion[key] ?? 0}
                                onSelectQuestion={(qi) => setActiveQuestion((cur) => ({ ...cur, [key]: qi }))}
                                onToggle={(qi, oi) => toggleChildAnswer(a, qi, oi)}
                                onText={(qi, value) => setChildAnswerText(a, qi, value)}
                                onSubmit={() => submitChildAnswer(channelId, runId, a)}
                            />
                            {errors[key] ? <div className="mt-2 text-[11px] text-warning">{errors[key]}</div> : null}
                            {answered ? null : (
                                <button
                                    type="button"
                                    disabled={!ready}
                                    onClick={() => submitChildAnswer(channelId, runId, a)}
                                    className="mt-2 cursor-pointer rounded-md border border-edge-mid bg-surface-hover px-2.5 py-1 text-[11.5px] font-semibold text-secondary hover:border-accent/60 hover:text-primary disabled:cursor-default disabled:opacity-40"
                                >
                                    Send answer
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
```

- [ ] **Step 8: Write the failing timeline tests**

In `frontend/app/view/agents/runtimeline.test.ts`, change the import to:

```ts
import { artifactsOf, buildRunTimeline, clickTargetFor, eventKindTitle, joinWorkspacePath, toneFor } from "./runtimeline";
```

Insert inside `describe("toneFor", () => {`, after the existing `it(...)`:

```ts
    it("tones the queue and wake rows", () => {
        expect(toneFor("task-forwarded")).toBe("text-asking");
        expect(toneFor("lead-wake-failed")).toBe("text-warning");
        expect(toneFor("lead-woken")).toBe("text-muted");
    });
```

Insert directly above `describe("joinWorkspacePath", () => {`:

```ts
describe("eventKindTitle", () => {
    it("names the queue and wake rows", () => {
        expect(eventKindTitle("task-forwarded")).toBe("Handed to you");
        expect(eventKindTitle("lead-woken")).toBe("Lead woken");
        expect(eventKindTitle("lead-wake-failed")).toBe("Lead wake failed");
    });
});

```

In `frontend/app/view/orchestrate/timelinefilter.test.ts`, replace the whole `it("attention covers asks, gates, failures, blocked merges, failed cleanup and failed control", ...)` test with:

```ts
    it("attention covers asks, gates, failures, blocked merges, failed cleanup, hand-offs and failed wakes", () => {
        for (const kind of [
            "child-ask",
            "dag-gate-open",
            "phase-held",
            "task-failed",
            "task-stalled",
            "dag-blocked",
            "task-merge-blocked",
            "task-cleanup-failed",
            "task-forwarded",
            "lead-wake-failed",
        ]) {
            expect(ATTENTION_KINDS.has(kind), kind).toBe(true);
        }
    });

    it("a wake that landed is not attention", () => {
        expect(ATTENTION_KINDS.has("lead-woken")).toBe(false);
    });
```

Insert inside `describe("eventClickTarget", () => {`, directly after the `it("routes cleanup kinds to the dag task", ...)` test:

```ts
    it("routes a hand-off to the dag task", () => {
        expect(eventClickTarget(ev("task-forwarded", { taskid: "t-6", askid: "a-1", note: "yours" }))).toEqual({
            kind: "dag-task",
            taskId: "t-6",
        });
    });
```

- [ ] **Step 9: Run the timeline tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/runtimeline.test.ts frontend/app/view/orchestrate/timelinefilter.test.ts`
Expected: FAIL. `toneFor("task-forwarded")` is `text-muted`, `eventKindTitle("task-forwarded")` is the raw kind, `ATTENTION_KINDS` lacks `task-forwarded`, and the hand-off routes to `none`.

- [ ] **Step 10: Map the new kinds and drop the lead-control ones**

In `frontend/app/view/agents/runtimeline.ts`:

In `RUN_GROUP_KINDS`, replace:

```ts
    "lead-control-sent",
    "lead-control-failed",
    "lead-control-acknowledged",
```

with:

```ts
    "task-forwarded",
    "lead-woken",
    "lead-wake-failed",
```

In `KIND_TITLE`, replace:

```ts
    "lead-control-sent": "Lead notified",
    "lead-control-failed": "Lead notify failed",
    "lead-control-acknowledged": "Lead acknowledged",
```

with:

```ts
    "task-forwarded": "Handed to you",
    "lead-woken": "Lead woken",
    "lead-wake-failed": "Lead wake failed",
```

In `KIND_TONE`:
- Insert `"task-forwarded": "text-asking",` directly after `"dag-plan-gated": "text-asking",`.
- Replace `"lead-control-failed": "text-warning",` with `"lead-wake-failed": "text-warning",`.
- Replace these two lines with the single line `"lead-woken": "text-muted",`:

```ts
    "lead-control-sent": "text-muted",
    "lead-control-acknowledged": "text-muted",
```

In `frontend/app/view/orchestrate/timelinefilter.ts`:
- In `ATTENTION_KINDS`, replace `"lead-control-failed",` with the two lines `"task-forwarded",` and `"lead-wake-failed",`.
- In `TASK_TARGET_KINDS`, replace these three lines with the single line `"task-forwarded": "dag-task",`:

```ts
    "lead-control-sent": "dag-task",
    "lead-control-failed": "dag-task",
    "lead-control-acknowledged": "dag-task",
```

- [ ] **Step 11: Drop the control warning**

In `frontend/app/view/orchestrate/dagdigest.ts`, replace:

```ts
// events whose arrival means the current digest may be out of date (ask/answer/clear and control
// delivery). Not activity ticks — those never re-request the digest.
const REFRESH_EVENT_KINDS = new Set([
    "child-ask",
    "child-answered",
    "child-ask-cleared",
    "lead-control-sent",
    "lead-control-failed",
    "lead-control-acknowledged",
]);
```

with:

```ts
// events whose arrival means the current digest may be out of date (ask/answer/clear). Not activity
// ticks — those never re-request the digest.
const REFRESH_EVENT_KINDS = new Set(["child-ask", "child-answered", "child-ask-cleared"]);
```

Then delete `CONTROL_WARNING` with its two-line comment, and `controlWarning`: everything from `// CONTROL_WARNING is the human-facing half of the control digest.` through the closing brace of `controlWarning`.

In `frontend/app/view/orchestrate/dagdigest.test.ts`:
- Remove `controlWarning,` from the import.
- Delete the whole `it("refreshes on lead-control delivery events", ...)` test.
- In `describe("degradation views (spec 8)", ...)`, replace the helper:

```ts
    const digest = (health: string, control?: ControlDigest): DagStatusDigest =>
        ({
            dagversion: 1,
            health,
            counts: { total: 2, done: 1 } as DagStatusCounts,
            next: { kind: "dispatch" },
            tasks: [],
            durations: { elapsedms: 1000 },
            control,
        }) as DagStatusDigest;
```

with:

```ts
    const digest = (health: string): DagStatusDigest =>
        ({
            dagversion: 1,
            health,
            counts: { total: 2, done: 1 } as DagStatusCounts,
            next: { kind: "dispatch" },
            tasks: [],
            durations: { elapsedms: 1000 },
        }) as DagStatusDigest;
```

- Delete the whole `it("warns only for control states the human should know about", ...)` test.

In `frontend/app/view/orchestrate/dagoverview.tsx`:
- Remove `controlWarning,` from the `./dagdigest` import.
- Delete the line `const control = controlWarning(digest);`.
- Delete the line `{control ? <span className="text-warning">⚠ {control}</span> : null}`.

- [ ] **Step 12: Run the frontend checks**

Run: `npx vitest run frontend/app/view/agents frontend/app/view/orchestrate pi/extensions`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, with no output.

Run: `npx prettier --check frontend/app/view/agents/childaskmodel.ts frontend/app/view/agents/childaskmodel.test.ts frontend/app/view/agents/childaskstore.ts frontend/app/view/agents/childaskcard.tsx frontend/app/view/agents/answerbar.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/runtimeline.ts frontend/app/view/agents/runtimeline.test.ts frontend/app/view/orchestrate/timelinefilter.ts frontend/app/view/orchestrate/timelinefilter.test.ts frontend/app/view/orchestrate/dagdigest.ts frontend/app/view/orchestrate/dagdigest.test.ts frontend/app/view/orchestrate/dagoverview.tsx pi/extensions/waveterm-tools.ts pi/extensions/waveterm-tools-core.ts pi/extensions/waveterm-tools-core.test.ts`
Expected: every file passes.
- If one of the two new `childaskmodel` files fails, run `npx prettier --write` on it.
- If an existing file fails, check whether it already failed before this slice: `git show HEAD:<path> | npx prettier --check --stdin-filepath <path>`.
  - If it already failed, hand-format only this slice's lines in it, so the diff stays within the slice.
  - If it didn't, run `npx prettier --write <path>`.

Run: `npx eslint frontend/app/view/agents/childaskmodel.ts frontend/app/view/agents/childaskmodel.test.ts frontend/app/view/agents/childaskstore.ts frontend/app/view/agents/childaskcard.tsx frontend/app/view/agents/answerbar.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/runtimeline.ts frontend/app/view/orchestrate/timelinefilter.ts frontend/app/view/orchestrate/dagdigest.ts frontend/app/view/orchestrate/dagoverview.tsx pi/extensions/waveterm-tools.ts pi/extensions/waveterm-tools-core.ts`
Expected: no errors.

Run: `git grep --untracked -n -E "lead-control|controlWarning|ControlDigest|answerChildAsk|Children are asking" -- frontend`
Expected: no output.

---

### Task 7: Docs, live check, verify and commit

**Files:**
- Modify: `docs/orchestrator-howto.md` (two dated update notes)
- Modify: `docs/open-issues.md` (the F22 and F23 rows)

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: the slice commit.

**Design notes:**
- The howto's "Nobody ever woke the lead" section and its `dag wait` latency analysis are dated records of a real run. They keep their text and gain an update note. The following are records of the same kind and stay untouched:
  - `docs/jarvis-claude-lead-e2e.md`
  - `docs/jarvis-orchestrator-plan-e2e.md`
  - `docs/orchestrator-redesign-flaws.md`
  - `docs/orca-vs-waveterm-comparison.md`
- F22 and F23 are only partly fixed. The confirmation covers typed answers to DAG children. A session ask outside a DAG still latches, and `answeragent` still returns on the last keystroke. The rows say so and stay open.
- The live check is the only end-to-end coverage for `childaskcard.tsx` and the typed wake. Spec §12 notes that child asks have never happened in a real run, so the path has to be driven on purpose.

- [ ] **Step 1: Update the howto**

In `docs/orchestrator-howto.md`, replace:

```markdown
### Nobody ever woke the lead

Open the DAG modal during execution
```

with:

```markdown
### Nobody ever woke the lead

> **Update 2026-09-14 (orchestrator redesign, slice 3):** the machinery this section describes is gone.
> `NotifyLead`, the pi control files, `PiSendControlCommand`, `dag wait` and the `lead-control-*` rows
> were deleted. The engine now types a `wake:` line into the lead's terminal when there is judgment work
> (`pkg/orchestrate/wake.go`), and the timeline shows `Lead woken` or `Lead wake failed`. The section
> stays as the record of why.

Open the DAG modal during execution
```

Replace:

```markdown
and I have no way to rule out that the first gap was a `wait` timing out rather than a lead thinking.
```

with:

```markdown
and I have no way to rule out that the first gap was a `wait` timing out rather than a lead thinking.

> **Update 2026-09-14:** `dag wait` no longer exists. The lead ends its turn after submitting and is woken
> by a typed `wake:` line. A wake it does not pick up within 30 seconds is retried once; after that the
> lead is treated as dead, the timeline records `Lead wake failed`, and its events go to the human. A lead
> that stops taking wakes now shows on the timeline.
```

- [ ] **Step 2: Update F22 and F23**

In `docs/open-issues.md`, in the F22 row, replace:

```markdown
Fix shape: age the ask and gate it on worker liveness, the same signal F13 needs |
```

with:

```markdown
Fix shape: age the ask and gate it on worker liveness, the same signal F13 needs. **Delivery half fixed 2026-09-14 for DAG children (orchestrator redesign slice 3):** an answer the child never clears, because it hung or died mid-tool, goes back to its owner noted `answer was sent but never confirmed`, and a second miss moves it to the human, so a hung child surfaces instead of reading answered. The ask itself still latches: nothing ages it against worker liveness, and a session ask outside a DAG is unchanged |
```

In the F23 row, replace:

```markdown
The waiter path (`ResolveWaiter`, pi bridge) does confirm; the Claude Code keystroke path does not |
```

with:

```markdown
The waiter path (`ResolveWaiter`, pi bridge) does confirm; the Claude Code keystroke path does not. **Partly fixed 2026-09-14 for DAG children (orchestrator redesign slice 3):** a typed answer counts as delivered only when the agent clears the ask; one not cleared within `AnswerClearTimeout` (30s) goes back to its owner with the failure noted, and a second miss moves it to the human. The RPC still returns on the last keystroke, and a session answer outside a DAG is still unconfirmed |
```

- [ ] **Step 3: Full verification**

**Go**, from PowerShell with `CGO_CFLAGS` set:
- `gofmt -l pkg cmd` prints nothing for touched files.
- `go vet ./pkg/agentask/ ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/waveobj/ ./pkg/wshrpc/... ./cmd/wsh/cmd/`
- `go test ./pkg/... ./cmd/... -count=1`

Report any failing package with its output. A failure that also fails at `e9e480b3` is pre-existing; say so, with evidence.

**Frontend:**
- `npx vitest run` (full)
- the tsc typecheck
- `npx eslint` on the files listed in Task 6 Step 12

**Generated files:** running `task generate` and then `task sync:piartifacts` again produces no diff.

- [ ] **Step 4: Live check**

1. Run `task dev`, which rebuilds `wavesrv` and `wsh`. If another session's dev app is already running, ask the user before stopping it, and never kill a `wavesrv` process without approval.
2. Run `task verify:ui -- surface-smoke`. Expected: PASS.
3. Force a child ask (spec §12, live acceptance 4). Create a scratch git repo with one commit. Launch an orchestrator run there with a Claude lead, as `docs/orchestrator-howto.md` describes, and this goal:

```text
Submit a DAG of three independent tasks, t-1, t-2 and t-3, with parallelism 3. Each task's description must say: before doing anything else, use AskUserQuestion. t-1 and t-2 ask one question, "Which greeting should the file contain?", with options "hello" and "hi", then write the chosen word to <task-id>.txt and stop. t-3 asks two questions in one AskUserQuestion call: the same greeting question, and "Which punctuation?" as a multi-select with options "!" and "?"; it writes the greeting plus every chosen mark to t-3.txt and stops.
When you are woken for t-1's question, answer it with `wsh jarvis dag answer`. When you are woken for t-2's question, forward it with `wsh jarvis dag forward t-2 "your call: pick the greeting"`. Never answer or forward t-3's question.
```

Expected:
- **The wake.** The lead's terminal receives a line beginning `wake:` that names the waiting questions and `wsh jarvis dag asks`, and the timeline shows `Lead woken`.
- **t-1.** The timeline shows `Child answered` and then `Question cleared`, and `t-1.txt` exists.
- **t-2.**
  - The timeline shows `Handed to you`.
  - The run surface shows "Questions for you" with t-2, its question, both options and the lead's note.
  - Picking an option shows "Answered". The entry leaves the card after `Question cleared`, and `t-2.txt` exists.
- **t-3.**
  - About 10 minutes after the raise, the timeline shows `Handed to you`, and the card shows t-3 with the note `lead did not answer in time`.
  - Both questions render, and the second one is multi-select.
  - Answer both questions, then press Send answer. `t-3.txt` holds the chosen greeting and marks.
- No `lead-control-*` row appears anywhere.

If the dev app can't be driven from this session, say so in the report. Don't claim the card or the wake was verified.

- [ ] **Step 5: Self-review the diff**

Run `git diff --stat` and `git diff`. Check that:
- nothing outside this slice is staged
- there's no commented-out code or debug output
- generated files changed only through `task generate` and `task sync:piartifacts`

- [ ] **Step 6: Commit**

Re-check `git status`. Stage only this slice's files by explicit path: the Files lists of Tasks 1-7, the renames and deletions Task 5 staged, and this plan.

Never stage these unrelated working-tree changes from other work:
- `package.json`, `package-lock.json`
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`
- `frontend/app/view/jarvis/peterrand.tsx`, `frontend/app/view/jarvis/petpeek.tsx`, `frontend/app/view/jarvis/petpeekmodel.ts`, `frontend/app/view/jarvis/petpeekmodel.test.ts`
- `scripts/cdp/scenarios.mjs`

Commit with a message describing the user-visible outcome, for example `feat(orchestrate): a child's question waits in a queue the lead owns, and the engine wakes the lead by typing into its terminal`. The body names the deletions (`dag wait`, `dag ack`, the pi control plumbing, the control digest) and the partial F22/F23 fix. Add no co-author or session trailer, and don't push.

- [ ] **Step 7: Mark effort chunk 4 done**

Run: `wsh effort chunk status aeabb4ad-a19c-4f5d-bba2-44586b73af16 4 done --note "<short sha>: question queue and lead wake"`
