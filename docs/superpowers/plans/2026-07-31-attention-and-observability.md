# Live attention signal + past-work matcher observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cockpit's "something needs you" signal truthful across every surface, and make the dispatch-time past-work matcher record whether it ran.

**Architecture:** The attention list moves from a frontend derivation over a stale channel snapshot to a server-computed list behind one RPC command, polled every 10 seconds by an always-mounted driver, consumed by the nav-rail badges and the Jarvis context rail. Three frontend derivation modules are deleted rather than duplicated, so Go becomes the only definition. Separately, the past-work matcher writes a `pending` marker before evaluating and a reason on every terminal path.

**Tech Stack:** Go (wshrpc command + pure builder in `pkg/jarvis`), SQLite via `pkg/wstore`, React 19 + jotai, vitest, CDP scenario harness.

## Global Constraints

- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts` and the generated TS types come from `task generate`. Edit the Go definitions and regenerate.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. No raw hex or rgba in components.
- **No new SCSS.** Tailwind only.
- **No jsdom render or snapshot tests.** Pure logic is extracted and unit-tested; "does it render" is covered by the CDP scenario harness.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Bare `npx tsc` stack-overflows on this repo. Baseline is clean, so any error reported is yours.
- **Go tests touching `pkg/jarvisproactive` need the vendored sqlite-vec header on a Windows-form path.** From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
  A Git-Bash POSIX path (`/c/Users/...`) fails with an identical-looking error.
- **`tsconfig.json` sets `"strict": false`.** Making an atom nullable produces no tsc errors at its read sites. Find read sites by grep, not by the typechecker.
- **Commit messages:** do not add a co-author trailer.

---

## Deviation from the spec, discovered during planning

**Read this before Task 2.** The current frontend composition (`frontend/app/view/agents/channelneeds.ts:32-55`) emits **two items for one blocked worker** when that worker's question was escalated: one `escalation` item from the `jarvis-escalation` message, and one `worker ask` item from the pending-ask scan. Nothing dedupes them.

That is tolerable in a list where both rows offer different affordances. It is a defect in a **count** — one thing waiting would light the badge as two — and a truthful count is this cycle's entire purpose.

**This plan dedupes: an ask that already has a pending escalation message yields only the escalation item.** Task 2 Step 3 has the test. This is a deliberate behaviour change not present in the spec; a reviewer may reject it, in which case delete the `escalated` filter and its test and update `docs/jarvis-tab.md` to state that a blocked worker with an escalation counts twice.

---

## File Structure

**Created**
- `pkg/jarvis/attention.go` — the pure attention builder and its input types. Lives in `pkg/jarvis` because that package already owns card parsing (`cards.go`) and ask→worker→channel resolution (`resolve.go`, `watcher.go`), which are two of its three inputs. Verified no import cycle: `pkg/wshrpc` does not import `pkg/jarvis`.
- `pkg/jarvis/attention_test.go` — table tests, including the cases ported from the deleted TypeScript tests.
- `frontend/app/view/agents/attentionstore.ts` — the atom, the loader, and the pure badge split.
- `frontend/app/view/agents/attentionstore.test.ts` — unit tests for the badge split.
- `frontend/app/view/agents/attentionpoller.tsx` — the 10-second always-mounted driver. Renders nothing.

**Modified**
- `pkg/agentask/agentask.go` — `PendingAsk` gains a timestamp; `Registry` gains `List()`.
- `pkg/jarvis/watcher.go` — export two resolution helpers.
- `pkg/wshrpc/wshrpctypes_channels.go` — the command, the item type, the return type.
- `pkg/wshrpc/wshserver/wshserver_channels.go` — the handler and its gather step.
- `pkg/jarvisproactive/suggestion.go` + `proactive.go` — the `Reason` field and the reason on every path.
- `pkg/wshrpc/wshserver/wshserver_runs.go` — write the `pending` marker, persist every outcome.
- `frontend/app/cockpit/cockpit-root.tsx` — mount the poller.
- `frontend/app/view/agents/navrail.tsx` — badges read the new atom.
- `frontend/app/view/jarvis/stagerail.tsx` — the list reads the new atom.
- `scripts/cdp/scenarios.mjs` — the cross-channel gate scenario.
- `docs/jarvis-tab.md`, `docs/superpowers/briefs/2026-07-31-jarvis-integration-brief.md`.

**Deleted**
- `frontend/app/view/jarvis/railneeds.ts` + `railneeds.test.ts`
- `frontend/app/view/agents/channelneeds.ts` + `channelneeds.test.ts`
- From `frontend/app/view/agents/channelderive.ts`: `channelAttributedAskORefs`, `channelPendingAskCount`, `standalonePendingAskCount` (and their cases in `channelderive.test.ts`). `channelHasAsk` **stays** — `subjectscolumn.tsx:311` uses it.
- `reviewGate` from `frontend/app/view/agents/runmodel.ts` and `escalationPending` from `frontend/app/view/agents/jarviscards.ts`, plus their tests — both lose their only production caller.

---

### Task 1: Pending-ask registry gains a timestamp and enumeration

**Files:**
- Modify: `pkg/agentask/agentask.go:17-33`
- Modify: the single caller of `GlobalRegistry.Set` (find it with `grep -rn "GlobalRegistry.Set" pkg/ cmd/`)
- Test: `pkg/agentask/agentask_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `PendingAsk.Ts int64`; `func (r *Registry) List() map[string]PendingAsk` keyed by the ask's block ORef.

- [ ] **Step 1: Write the failing test**

Append to `pkg/agentask/agentask_test.go`:

```go
func TestRegistryListReturnsPendingAsksWithTimestamps(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:a", PendingAsk{AskId: "1", BlockId: "a", Ts: 1000})
	r.Set("block:b", PendingAsk{AskId: "2", BlockId: "b", Ts: 2000})

	all := r.List()
	if len(all) != 2 {
		t.Fatalf("want 2 pending, got %d", len(all))
	}
	if all["block:a"].Ts != 1000 {
		t.Fatalf("timestamp not stored: %+v", all["block:a"])
	}

	// a claimed ask is no longer waiting on anyone
	if _, ok := r.Claim("block:a", "1"); !ok {
		t.Fatal("claim should succeed")
	}
	if len(r.List()) != 1 {
		t.Fatalf("claimed ask still listed: %+v", r.List())
	}
}

func TestRegistryListIsACopy(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:a", PendingAsk{AskId: "1", Ts: 1})
	snapshot := r.List()
	r.Drop("block:a")
	if len(snapshot) != 1 {
		t.Fatal("List must return a copy the caller can hold past the lock")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentask/ -run TestRegistryList -v`
Expected: FAIL — `PendingAsk` has no field `Ts`, and `r.List` is undefined.

- [ ] **Step 3: Add the field and the method**

In `pkg/agentask/agentask.go`, add to `PendingAsk`:

```go
	// Ts is the UnixMilli the ask was raised, copied from AgentAskData.Ts. Drives the "waiting 41m"
	// age in the attention list; without it the list can say what is waiting but not for how long.
	Ts int64
```

And add below `Get`:

```go
// List returns every pending ask, keyed by the block ORef it is registered under. The returned map is a
// copy, so a caller may hold it after the lock is released.
func (r *Registry) List() map[string]PendingAsk {
	r.lock.Lock()
	defer r.lock.Unlock()
	out := make(map[string]PendingAsk, len(r.pending))
	for k, v := range r.pending {
		out[k] = v
	}
	return out
}
```

- [ ] **Step 4: Populate the timestamp at the one registration site**

Run: `grep -rn "GlobalRegistry.Set" pkg/ cmd/`

At that call site the handler already has the `baseds.AgentAskData` whose `Ts` field carries the raise time. Add `Ts: data.Ts,` to the `PendingAsk` literal. If `data.Ts` is zero there (an older caller that never set it), use `time.Now().UnixMilli()` instead so the age is never a 1970 date.

- [ ] **Step 5: Run the package tests**

Run: `go test ./pkg/agentask/ -v`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add pkg/agentask/
git commit -m "feat(agentask): pending asks carry a raise timestamp and can be enumerated"
```

---

### Task 2: The wire types and the pure attention builder

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_channels.go:12-25` (interface) and end of file (types)
- Create: `pkg/jarvis/attention.go`
- Create: `pkg/jarvis/attention_test.go`

**Interfaces:**
- Consumes: `agentask.PendingAsk` (Task 1).
- Produces:
  - `wshrpc.AttentionItem` — the wire item, fields listed in Step 1.
  - `wshrpc.CommandGetAttentionRtnData{ Items []AttentionItem }`
  - `jarvis.AttentionChannel{ OID, Name string; Runs []*waveobj.Run; Messages []*waveobj.ChannelMessage }`
  - `jarvis.AttentionInput{ Channels []AttentionChannel; PendingAsks map[string]agentask.PendingAsk; AskChannel, AskWorker, AskWorkerORef map[string]string }` — all three maps keyed by the ask's **block** oref
  - `func jarvis.BuildAttention(in AttentionInput) []wshrpc.AttentionItem`

- [ ] **Step 1: Add the wire types**

Append to `pkg/wshrpc/wshrpctypes_channels.go`:

```go
// AttentionItem is one thing waiting on the human, anywhere in the cockpit. Kind is "gate" |
// "escalation" | "ask". ChannelId/ChannelName are EMPTY for a standalone agent (one launched from the
// cockpit or Agent surface with no channel) — that is how the two nav-rail badges stay disjoint while
// coming from one source.
type AttentionItem struct {
	Kind         string `json:"kind"`
	Key          string `json:"key"`         // stable across polls for the same waiting thing
	ChannelId    string `json:"channelid,omitempty"`
	ChannelName  string `json:"channelname,omitempty"`
	RunId        string `json:"runid,omitempty"`
	Source       string `json:"source"` // the run's goal, or the worker's name
	Text         string `json:"text"`
	Action       string `json:"action"` // Review | Decide | Answer
	WaitingSince int64  `json:"waitingsince"`
}

type CommandGetAttentionRtnData struct {
	Items []AttentionItem `json:"items"`
}
```

Add to the `ChannelCommands` interface:

```go
	GetAttentionCommand(ctx context.Context) (*CommandGetAttentionRtnData, error) // everything waiting on the human across every channel: review gates, Gatekeeper escalations, blocked workers
```

- [ ] **Step 2: Write the failing test**

Create `pkg/jarvis/attention_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func gatedRun(id, goal string, doneTs int64) *waveobj.Run {
	return &waveobj.Run{
		ID:     id,
		Goal:   goal,
		Status: "awaiting-review",
		Phases: []waveobj.RunPhase{
			{Kind: "plan", State: "done", Gate: true, DoneTs: doneTs},
			{Kind: "execute", State: "pending"},
		},
	}
}

func escalationMsg(id, askORef, workerORef, question string, ts int64) *waveobj.ChannelMessage {
	data, _ := json.Marshal(JarvisCardData{AskORef: askORef, WorkerORef: workerORef, Question: question})
	return &waveobj.ChannelMessage{ID: id, Kind: "jarvis-escalation", Ts: ts, Data: string(data)}
}

func TestBuildAttentionFindsAGateInANonActiveChannel(t *testing.T) {
	in := AttentionInput{Channels: []AttentionChannel{
		{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{gatedRun("r1", "refactor auth", 500)}},
	}}
	items := BuildAttention(in)
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d: %+v", len(items), items)
	}
	got := items[0]
	if got.Kind != AttentionGate || got.RunId != "r1" || got.ChannelId != "c1" ||
		got.ChannelName != "alpha" || got.Source != "refactor auth" ||
		got.Action != "Review" || got.WaitingSince != 500 {
		t.Fatalf("wrong gate item: %+v", got)
	}
}

func TestBuildAttentionIgnoresARunThatIsNotAtAGate(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Goal: "g", Status: "executing",
		Phases: []waveobj.RunPhase{{State: "running"}}}
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{{OID: "c1", Runs: []*waveobj.Run{run}}}})
	if len(items) != 0 {
		t.Fatalf("want none, got %+v", items)
	}
}

func TestBuildAttentionCountsAnEscalationOnlyWhileItsAskIsPending(t *testing.T) {
	ch := AttentionChannel{OID: "c1", Name: "alpha",
		Messages: []*waveobj.ChannelMessage{escalationMsg("m1", "block:a", "tab:w", "Which order?", 900)}}

	none := BuildAttention(AttentionInput{Channels: []AttentionChannel{ch}})
	if len(none) != 0 {
		t.Fatalf("an answered escalation must not wait on anyone: %+v", none)
	}

	live := BuildAttention(AttentionInput{
		Channels:    []AttentionChannel{ch},
		PendingAsks: map[string]agentask.PendingAsk{"block:a": {AskId: "1", Ts: 900}},
		AskWorker:   map[string]string{"block:a": "worker-3"},
		AskChannel:  map[string]string{"block:a": "c1"},
	})
	if len(live) != 1 || live[0].Kind != AttentionEscalation || live[0].Text != "Which order?" ||
		live[0].Source != "worker-3" || live[0].WaitingSince != 900 {
		t.Fatalf("wrong escalation item: %+v", live)
	}
}

// An escalated ask is ONE thing waiting, not two. See "Deviation from the spec" in the plan.
func TestBuildAttentionDoesNotCountAnEscalatedAskTwice(t *testing.T) {
	items := BuildAttention(AttentionInput{
		Channels: []AttentionChannel{{OID: "c1", Name: "alpha",
			Messages: []*waveobj.ChannelMessage{escalationMsg("m1", "block:a", "tab:w", "Q?", 900)}}},
		PendingAsks: map[string]agentask.PendingAsk{"block:a": {AskId: "1", Ts: 900}},
		AskChannel:  map[string]string{"block:a": "c1"},
		AskWorker:   map[string]string{"block:a": "worker-3"},
	})
	if len(items) != 1 || items[0].Kind != AttentionEscalation {
		t.Fatalf("want one escalation, got %+v", items)
	}
}

func TestBuildAttentionYieldsAStandaloneAskWithNoChannel(t *testing.T) {
	items := BuildAttention(AttentionInput{
		PendingAsks: map[string]agentask.PendingAsk{"block:z": {AskId: "9", Ts: 42}},
		AskWorker:   map[string]string{"block:z": "solo"},
	})
	if len(items) != 1 {
		t.Fatalf("want 1, got %+v", items)
	}
	if items[0].ChannelId != "" || items[0].Kind != AttentionAsk ||
		items[0].Action != "Answer" || items[0].WaitingSince != 42 {
		t.Fatalf("wrong standalone ask: %+v", items[0])
	}
}

func TestBuildAttentionOrdersByKindThenOldestFirst(t *testing.T) {
	in := AttentionInput{
		Channels: []AttentionChannel{{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{
			gatedRun("newer", "b", 800),
			gatedRun("older", "a", 100),
		}}},
		PendingAsks: map[string]agentask.PendingAsk{"block:z": {AskId: "9", Ts: 50}},
		AskWorker:   map[string]string{"block:z": "solo"},
	}
	items := BuildAttention(in)
	if len(items) != 3 {
		t.Fatalf("want 3, got %+v", items)
	}
	// gates before asks even though the ask is the oldest thing here
	if items[0].RunId != "older" || items[1].RunId != "newer" || items[2].Kind != AttentionAsk {
		t.Fatalf("wrong order: %+v", items)
	}
}

func TestBuildAttentionResolvesAnAskToItsOwningRun(t *testing.T) {
	run := &waveobj.Run{ID: "r1", Goal: "g", Status: "executing",
		Phases: []waveobj.RunPhase{{State: "running", WorkerOrefs: []string{"tab:w"}}}}
	items := BuildAttention(AttentionInput{
		Channels:    []AttentionChannel{{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{run}}},
		PendingAsks: map[string]agentask.PendingAsk{"block:a": {AskId: "1", Ts: 5}},
		AskChannel:  map[string]string{"block:a": "c1"},
		AskWorker:   map[string]string{"block:a": "worker-3"},
		AskWorkerORef: map[string]string{"block:a": "tab:w"},
	})
	if len(items) != 1 || items[0].RunId != "r1" {
		t.Fatalf("ask should carry its owning run: %+v", items)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestBuildAttention -v`
Expected: FAIL — `BuildAttention` undefined.

- [ ] **Step 4: Write the builder**

Create `pkg/jarvis/attention.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: assemble the cockpit-wide "needs you" list — review gates, Gatekeeper escalations and blocked
// workers, in that order, oldest first within each kind. This is the single definition; the frontend
// derivations it replaces (railneeds.ts / channelneeds.ts) were deleted, because a snapshot of every
// channel's runs is not live and could never see a gate outside the active channel.

package jarvis

import (
	"encoding/json"
	"sort"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	AttentionGate       = "gate"
	AttentionEscalation = "escalation"
	AttentionAsk        = "ask"
)

// AttentionChannel is one channel's contribution: its identity plus the rows the builder reads.
type AttentionChannel struct {
	OID      string
	Name     string
	Runs     []*waveobj.Run
	Messages []*waveobj.ChannelMessage
}

// AttentionInput is everything BuildAttention needs, already fetched. The three ask maps are all keyed
// by the ask's BLOCK oref (the pending-ask registry's key), and are produced by GatherAttention:
//   - AskChannel:   block oref -> owning channel oid ("" or missing = a standalone agent)
//   - AskWorker:    block oref -> worker display name
//   - AskWorkerORef: block oref -> the worker's TAB oref, used to find its owning run phase
type AttentionInput struct {
	Channels      []AttentionChannel
	PendingAsks   map[string]agentask.PendingAsk
	AskChannel    map[string]string
	AskWorker     map[string]string
	AskWorkerORef map[string]string
}

// reviewGateIdx ports frontend runmodel.reviewGate: the gated phase awaiting approval, or -1. The engine
// halts after a gated phase completes (that phase done, its successor still pending); an orchestrator
// lead instead holds a running phase in place.
func reviewGateIdx(run *waveobj.Run) int {
	if run == nil || run.Status != "awaiting-review" {
		return -1
	}
	for i, p := range run.Phases {
		if p.State == "running" && p.Held {
			return i
		}
	}
	for i, p := range run.Phases {
		if p.Gate && p.State == "done" {
			if i+1 >= len(run.Phases) || run.Phases[i+1].State == "pending" {
				return i
			}
		}
	}
	return -1
}

// runIdForWorker finds the run whose phases claim this worker tab oref.
func runIdForWorker(runs []*waveobj.Run, workerORef string) string {
	if workerORef == "" {
		return ""
	}
	for _, r := range runs {
		for _, p := range r.Phases {
			for _, wo := range p.WorkerOrefs {
				if wo == workerORef {
					return r.ID
				}
			}
		}
	}
	return ""
}

func BuildAttention(in AttentionInput) []wshrpc.AttentionItem {
	var gates, escalations, asks []wshrpc.AttentionItem
	// ask orefs already represented by an escalation card — one waiting thing, one item.
	escalated := map[string]bool{}

	for _, ch := range in.Channels {
		for _, run := range ch.Runs {
			idx := reviewGateIdx(run)
			if idx < 0 {
				continue
			}
			gates = append(gates, wshrpc.AttentionItem{
				Kind:         AttentionGate,
				Key:          "gate:" + run.ID,
				ChannelId:    ch.OID,
				ChannelName:  ch.Name,
				RunId:        run.ID,
				Source:       run.Goal,
				Text:         "Approve before Jarvis proceeds.",
				Action:       "Review",
				WaitingSince: run.Phases[idx].DoneTs,
			})
		}

		for _, m := range ch.Messages {
			if m.Kind != "jarvis-escalation" || m.Data == "" {
				continue
			}
			var card JarvisCardData
			if err := json.Unmarshal([]byte(m.Data), &card); err != nil || card.AskORef == "" {
				continue
			}
			// The registry is authoritative: an escalation whose ask was answered (by Jarvis or the
			// human) had its registry entry claimed and dropped, so it is no longer waiting.
			if _, pending := in.PendingAsks[card.AskORef]; !pending {
				continue
			}
			escalated[card.AskORef] = true
			name := in.AskWorker[card.AskORef]
			if name == "" {
				name = "worker"
			}
			escalations = append(escalations, wshrpc.AttentionItem{
				Kind:         AttentionEscalation,
				Key:          "esc:" + m.ID,
				ChannelId:    ch.OID,
				ChannelName:  ch.Name,
				RunId:        runIdForWorker(ch.Runs, card.WorkerORef),
				Source:       name,
				Text:         card.Question,
				Action:       "Decide",
				WaitingSince: m.Ts,
			})
		}
	}

	byOID := map[string]AttentionChannel{}
	for _, ch := range in.Channels {
		byOID[ch.OID] = ch
	}
	for oref, p := range in.PendingAsks {
		if escalated[oref] {
			continue
		}
		chOID := in.AskChannel[oref]
		ch := byOID[chOID]
		name := in.AskWorker[oref]
		if name == "" {
			name = "worker"
		}
		asks = append(asks, wshrpc.AttentionItem{
			Kind:         AttentionAsk,
			Key:          "ask:" + oref,
			ChannelId:    ch.OID,
			ChannelName:  ch.Name,
			RunId:        runIdForWorker(ch.Runs, in.AskWorkerORef[oref]),
			Source:       name,
			Text:         "Waiting on your reply",
			Action:       "Answer",
			WaitingSince: p.Ts,
		})
	}

	// Kind is the priority claim — a gate blocks a whole pipeline, an ask blocks one worker. Age only
	// breaks ties inside a kind. Key is the final tiebreak so map iteration cannot reorder equal items.
	for _, group := range [][]wshrpc.AttentionItem{gates, escalations, asks} {
		g := group
		sort.SliceStable(g, func(i, j int) bool {
			if g[i].WaitingSince != g[j].WaitingSince {
				return g[i].WaitingSince < g[j].WaitingSince
			}
			return g[i].Key < g[j].Key
		})
	}

	out := make([]wshrpc.AttentionItem, 0, len(gates)+len(escalations)+len(asks))
	out = append(out, gates...)
	out = append(out, escalations...)
	out = append(out, asks...)
	return out
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run TestBuildAttention -v`
Expected: PASS, all seven.

- [ ] **Step 6: Run the whole package and build the wshrpc package**

Run: `go test ./pkg/jarvis/ ./pkg/wshrpc/`
Expected: PASS. If `pkg/wshrpc` fails to build, the interface method was added without its return type — recheck Step 1.

- [ ] **Step 7: Commit**

```bash
git add pkg/jarvis/attention.go pkg/jarvis/attention_test.go pkg/wshrpc/wshrpctypes_channels.go
git commit -m "feat(attention): server-side attention builder and its wire types"
```

---

### Task 3: Gather the inputs, serve the command, regenerate the client

**Files:**
- Modify: `pkg/jarvis/watcher.go:63-105` (export two helpers)
- Modify: `pkg/jarvis/attention.go` (add `GatherAttention`)
- Modify: `pkg/wshrpc/wshserver/wshserver_channels.go`
- Test: `pkg/wshrpc/wshserver/wshserver_channels_test.go`

**Interfaces:**
- Consumes: `jarvis.BuildAttention`, `agentask.Registry.List` (Tasks 1–2).
- Produces: `func jarvis.GatherAttention(ctx context.Context) ([]wshrpc.AttentionItem, error)`; `func (ws *WshServer) GetAttentionCommand(ctx context.Context) (*wshrpc.CommandGetAttentionRtnData, error)`; the generated TypeScript client method `RpcApi.GetAttentionCommand`.

- [ ] **Step 1: Export the two resolution helpers**

In `pkg/jarvis/watcher.go`, rename `channelOwnerORef` → `ChannelOwnerORef` and `resolveAskOwner` → `ResolveAskOwner`, updating their call sites in the same file. Add a doc comment to each:

```go
// ChannelOwnerORef maps an ask's block oref to the TAB oref a channel dispatch would reference for that
// worker. Exported so the attention builder can resolve a pending ask the same way the watcher does.
```

```go
// ResolveAskOwner returns the channel that owns this worker tab oref, and the worker's task label.
// Returns (nil, "") for a standalone agent no channel dispatched.
```

- [ ] **Step 2: Run the existing tests to prove the rename changed nothing**

Run: `go test ./pkg/jarvis/`
Expected: PASS. A rename that breaks a test means a call site was missed.

- [ ] **Step 3: Write the failing handler test**

Append to `pkg/wshrpc/wshserver/wshserver_channels_test.go`:

```go
func TestGetAttentionCommandSeesAGateInAnyChannel(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	ch, err := wstore.CreateChannel(ctx, "attn", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	run := waveobj.Run{
		ID: "r-gate", Goal: "refactor auth", Status: "awaiting-review", CreatedTs: 1,
		Phases: []waveobj.RunPhase{
			{Kind: "plan", State: "done", Gate: true, DoneTs: 700},
			{Kind: "execute", State: "pending"},
		},
	}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("append run: %v", err)
	}

	rtn, err := ws.GetAttentionCommand(ctx)
	if err != nil {
		t.Fatalf("GetAttention: %v", err)
	}
	var found *wshrpc.AttentionItem
	for i := range rtn.Items {
		if rtn.Items[i].RunId == "r-gate" {
			found = &rtn.Items[i]
		}
	}
	if found == nil {
		t.Fatalf("gate not reported: %+v", rtn.Items)
	}
	if found.Kind != "gate" || found.ChannelId != ch.OID || found.WaitingSince != 700 {
		t.Fatalf("wrong gate item: %+v", *found)
	}
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestGetAttentionCommand -v`
Expected: FAIL — `ws.GetAttentionCommand` undefined.

- [ ] **Step 5: Write the gather function**

Append to `pkg/jarvis/attention.go`:

```go
// GatherAttention reads the live inputs and builds the list. Channels, runs and messages come from the
// store; pending asks come from the in-process registry, which is why this list is authoritative for the
// current server lifetime rather than absolutely (a wavesrv restart empties it until agents re-raise).
func GatherAttention(ctx context.Context) ([]wshrpc.AttentionItem, error) {
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing channels: %w", err)
	}
	in := AttentionInput{
		PendingAsks:   agentask.GlobalRegistry.List(),
		AskChannel:    map[string]string{},
		AskWorker:     map[string]string{},
		AskWorkerORef: map[string]string{},
	}
	for _, ch := range chans {
		runs, err := wstore.GetChannelRuns(ctx, ch.OID)
		if err != nil {
			return nil, fmt.Errorf("getting runs for channel %s: %w", ch.OID, err)
		}
		msgs, err := wstore.GetChannelMessages(ctx, ch.OID, 0, 0)
		if err != nil {
			return nil, fmt.Errorf("getting messages for channel %s: %w", ch.OID, err)
		}
		in.Channels = append(in.Channels, AttentionChannel{
			OID: ch.OID, Name: ch.Name, Runs: runs, Messages: msgs,
		})
	}
	for blockORef := range in.PendingAsks {
		workerORef := ChannelOwnerORef(ctx, blockORef)
		in.AskWorkerORef[blockORef] = workerORef
		owner, task := ResolveAskOwner(ctx, workerORef)
		if owner != nil {
			in.AskChannel[blockORef] = owner.OID
		}
		if task != "" {
			in.AskWorker[blockORef] = task
		}
	}
	return BuildAttention(in), nil
}
```

Add `"context"`, `"fmt"` and `"github.com/wavetermdev/waveterm/pkg/wstore"` to the file's imports.

- [ ] **Step 6: Write the handler**

Append to `pkg/wshrpc/wshserver/wshserver_channels.go` (import `"github.com/wavetermdev/waveterm/pkg/jarvis"` if not already present):

```go
func (ws *WshServer) GetAttentionCommand(ctx context.Context) (*wshrpc.CommandGetAttentionRtnData, error) {
	items, err := jarvis.GatherAttention(ctx)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGetAttentionRtnData{Items: items}, nil
}
```

- [ ] **Step 7: Run the handler test**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestGetAttentionCommand -v`
Expected: PASS.

- [ ] **Step 8: Regenerate the TypeScript client**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` gains `GetAttentionCommand`, and the generated types gain `AttentionItem`. Do not hand-edit either.

- [ ] **Step 9: Verify the whole backend still builds and typechecks**

Run: `go build ./... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add pkg/ frontend/app/store/wshclientapi.ts frontend/types/
git commit -m "feat(attention): GetAttention command, gather step, regenerated client"
```

---

### Task 4: Frontend attention store and the 10-second poller

**Files:**
- Create: `frontend/app/view/agents/attentionstore.ts`
- Create: `frontend/app/view/agents/attentionstore.test.ts`
- Create: `frontend/app/view/agents/attentionpoller.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx:17,88`

**Interfaces:**
- Consumes: `RpcApi.GetAttentionCommand` (Task 3).
- Produces: `attentionAtom: PrimitiveAtom<AttentionItem[]>`, `loadAttention(): Promise<void>`, `splitAttention(items): { channel: AttentionItem[]; standalone: AttentionItem[] }`, `<AttentionPoller/>`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/attentionstore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitAttention } from "./attentionstore";

const item = (over: Partial<AttentionItem>): AttentionItem =>
    ({ kind: "ask", key: "k", source: "s", text: "t", action: "Answer", waitingsince: 0, ...over }) as AttentionItem;

describe("splitAttention", () => {
    it("routes items with a channel to the Jarvis badge and the rest to Cockpit", () => {
        const out = splitAttention([
            item({ key: "a", channelid: "c1" }),
            item({ key: "b" }),
            item({ key: "c", kind: "gate", channelid: "c2" }),
        ]);
        expect(out.channel.map((i) => i.key)).toEqual(["a", "c"]);
        expect(out.standalone.map((i) => i.key)).toEqual(["b"]);
    });

    it("keeps the two groups disjoint and complete", () => {
        const items = [item({ key: "a", channelid: "c1" }), item({ key: "b" })];
        const out = splitAttention(items);
        expect(out.channel.length + out.standalone.length).toBe(items.length);
    });

    it("treats an empty channel id as standalone, not as a channel named empty", () => {
        const out = splitAttention([item({ key: "a", channelid: "" })]);
        expect(out.standalone).toHaveLength(1);
        expect(out.channel).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/attentionstore.test.ts`
Expected: FAIL — cannot resolve `./attentionstore`.

- [ ] **Step 3: Write the store**

Create `frontend/app/view/agents/attentionstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit-wide "needs you" list, computed server-side (pkg/jarvis/attention.go) and polled. This
// replaced a frontend derivation over channelsAtom, which is a snapshot refetched only on channel
// create/delete/rename/archive — so a run parked at a review gate in any non-active channel was
// invisible to every badge.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export const attentionAtom = atom<AttentionItem[]>([]) as PrimitiveAtom<AttentionItem[]>;

// splitAttention keeps the two nav-rail badges disjoint by construction rather than by two derivations
// agreeing: an item either names a channel or it does not.
export function splitAttention(items: AttentionItem[]): {
    channel: AttentionItem[];
    standalone: AttentionItem[];
} {
    const channel: AttentionItem[] = [];
    const standalone: AttentionItem[] = [];
    for (const i of items ?? []) {
        (i.channelid ? channel : standalone).push(i);
    }
    return { channel, standalone };
}

// A failed poll leaves the last good list in place. Blanking the badge on one dropped request would
// read as "nothing needs you", which is the exact lie this whole change exists to remove.
export async function loadAttention(): Promise<void> {
    try {
        const rtn = await RpcApi.GetAttentionCommand(TabRpcClient);
        globalStore.set(attentionAtom, rtn.items ?? []);
    } catch {
        // keep the previous value
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/attentionstore.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the poller**

Create `frontend/app/view/agents/attentionpoller.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Always-mounted (cockpit root) 10s poll driver for the cockpit-wide attention list. Renders nothing.
// 10s mirrors BackgroundAgentsPoller, which picked it so a blocked agent surfaces quickly; a review
// gate has the same urgency. Polling rather than server push is deliberate — a missed poll self-heals
// on the next tick, whereas a missed push event goes stale while still looking live.

import { useEffect } from "react";
import { loadAttention } from "./attentionstore";

export function AttentionPoller() {
    useEffect(() => {
        void loadAttention();
        const t = setInterval(() => void loadAttention(), 10_000);
        return () => clearInterval(t);
    }, []);
    return null;
}
```

- [ ] **Step 6: Mount it**

In `frontend/app/cockpit/cockpit-root.tsx`, add the import beside the existing background-agents one:

```tsx
import { AttentionPoller } from "@/app/view/agents/attentionpoller";
```

and render it next to `<BackgroundAgentsPoller />` (around line 88):

```tsx
            <BackgroundAgentsPoller />
            <AttentionPoller />
```

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/attentionstore.ts frontend/app/view/agents/attentionstore.test.ts frontend/app/view/agents/attentionpoller.tsx frontend/app/cockpit/cockpit-root.tsx
git commit -m "feat(attention): frontend store and 10s poll driver"
```

---

### Task 5: Nav-rail badges read the new source

**Files:**
- Modify: `frontend/app/view/agents/navrail.tsx:9,41-50`

**Interfaces:**
- Consumes: `attentionAtom`, `splitAttention` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Swap the badge source**

In `frontend/app/view/agents/navrail.tsx`, delete the import of `channelPendingAskCount, standalonePendingAskCount` from `./channelderive` and the now-unused `channelsAtom` import if nothing else in the file uses it. Add:

```tsx
import { attentionAtom, splitAttention } from "./attentionstore";
```

Replace lines 41-50 (the `channels` / `agents` reads and the `badges` object) with:

```tsx
    // Two disjoint "needs you" badges from one server-computed list: Jarvis counts everything a channel
    // owns (review gates, Gatekeeper escalations, dispatched workers), Cockpit counts standalone agents
    // no channel dispatched. Disjoint by construction — an item either names a channel or it does not.
    const attention = useAtomValue(attentionAtom);
    const split = splitAttention(attention);
    const badges: Partial<Record<SurfaceKey, number>> = {
        cockpit: split.standalone.length,
        jarvis: split.channel.length,
    };
```

Leave `agents` in place only if something else in the file reads it; otherwise remove that line and its import too.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: clean. An "unused import" is not a tsc error here — check the file by eye for leftovers.

- [ ] **Step 3: Lint the touched file**

Run: `npx eslint frontend/app/view/agents/navrail.tsx`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/navrail.tsx
git commit -m "fix(navrail): badges count review gates and escalations, from live data"
```

---

### Task 6: The Jarvis rail reads the new source, and the superseded derivations are deleted

**Files:**
- Modify: `frontend/app/view/jarvis/stagerail.tsx:35,74`
- Modify: `frontend/app/view/agents/channelderive.ts:88-121`, `channelderive.test.ts`
- Modify: `frontend/app/view/agents/runmodel.ts:52-74`, `frontend/app/view/agents/jarviscards.ts:57-62`
- Delete: `frontend/app/view/jarvis/railneeds.ts`, `railneeds.test.ts`, `frontend/app/view/agents/channelneeds.ts`, `channelneeds.test.ts`

**Interfaces:**
- Consumes: `attentionAtom` (Task 4).
- Produces: nothing new. `RailNeedsItem` is replaced by the generated `AttentionItem`; `outsideFocus` becomes a local computation in `stagerail.tsx`.

- [ ] **Step 1: Point the rail at the atom**

In `frontend/app/view/jarvis/stagerail.tsx`, replace the `buildRailNeeds` import with:

```tsx
import { attentionAtom } from "@/app/view/agents/attentionstore";
```

Replace line 74 with:

```tsx
    // Attention beats focus: a Space scopes the Subjects column and the Stage, never this list — an item
    // in a channel outside focus still surfaces, labelled as such. The label describes membership, not
    // filtering, so it stands whether or not "Show all" is on.
    const attention = useAtomValue(attentionAtom);
    const focused = spaceScope != null ? new Set(spaceScope.channeloids ?? []) : null;
    const needs = attention.map((n) => ({
        ...n,
        outsideFocus: focused != null && n.channelid !== "" && !focused.has(n.channelid),
    }));
```

**Read the whole `Needs you` render block before editing it** — this plan specifies the data swap, not the markup, and the block was not read while planning. Every row field changes case: the generated type uses `n.channelid`, `n.runid`, `n.channelname`, against the deleted TypeScript's `channelId` / `runId` / `channelName`. Unchanged: `n.key`, `n.kind`, `n.source`, `n.text`, `n.action`. The click handler becomes `goToNeed(n.channelid, n.runid)`.

Two things must survive the swap or `jarvis-drawer` will go red: the rail stays mounted with no subject selected, and the "outside focus" label describes membership rather than filtering — no item is dropped because a Space is active.

- [ ] **Step 2: Verify the rail still compiles and its tests are the only ones referencing the deleted modules**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: errors ONLY in the files about to be deleted. Any other file erroring is a consumer this plan missed — fix it before continuing.

- [ ] **Step 3: Delete the superseded modules**

```bash
git rm frontend/app/view/jarvis/railneeds.ts frontend/app/view/jarvis/railneeds.test.ts
git rm frontend/app/view/agents/channelneeds.ts frontend/app/view/agents/channelneeds.test.ts
```

- [ ] **Step 4: Delete the three stranded counting functions**

From `frontend/app/view/agents/channelderive.ts`, delete `channelAttributedAskORefs`, `channelPendingAskCount` and `standalonePendingAskCount` (lines 88-121) and any import they alone used. **Keep `channelHasAsk`** — `frontend/app/view/jarvis/subjectscolumn.tsx:311` still calls it for the Subjects column's per-channel asking dot. Delete the cases covering the three removed functions from `channelderive.test.ts`, keeping the `channelHasAsk` cases.

- [ ] **Step 5: Delete the two stranded leaf predicates**

Delete `reviewGate` from `frontend/app/view/agents/runmodel.ts` and `escalationPending` from `frontend/app/view/agents/jarviscards.ts`, plus their test cases.

**Check `currentPhaseIndex` first** (`runmodel.ts:88-100`) — it calls `reviewGate`. If it is still used anywhere, inline the gate lookup into it as a file-local, unexported `gateIdx` helper rather than deleting the logic:

```ts
// local: the gated phase awaiting approval, or -1. The exported predicate moved server-side
// (pkg/jarvis/attention.go); this is the only remaining consumer.
function gateIdx(run: Run): number {
    if (run.status !== "awaiting-review") {
        return -1;
    }
    const phases = run.phases ?? [];
    for (let i = 0; i < phases.length; i++) {
        if (phases[i].state === "running" && phases[i].held) {
            return i;
        }
    }
    for (let i = 0; i < phases.length; i++) {
        if (phases[i].gate && phases[i].state === "done") {
            const next = phases[i + 1];
            if (!next || next.state === "pending") {
                return i;
            }
        }
    }
    return -1;
}
```

Run `grep -rn "reviewGate\|escalationPending" frontend/app` and resolve every hit before deleting.

- [ ] **Step 6: Full frontend verification**

Run:
```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run frontend/app/view/
```
Expected: typecheck clean; vitest green with the deleted suites gone and no other suite failing.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/
git commit -m "refactor(attention): rail reads the server list; delete the superseded frontend derivations"
```

---

### Task 7: CDP scenario — a gate in a non-active channel lights the badge

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: the `attention-cross-channel` scenario.

- [ ] **Step 1: Read two neighbouring scenarios first**

Run: `grep -n "name:" scripts/cdp/scenarios.mjs | head -30`, then read `jarvis-subject-state` in full. Match its `arrange` / `goto` / `assert` / `teardown` shape exactly — it already creates and deletes its own channel, which is the pattern this scenario needs.

- [ ] **Step 2: Add the scenario**

Arrange, via `Runtime.evaluate` calling the same RPC client the app uses:

1. Create a channel named `attn-probe`.
2. Create a run in it.
3. Park that run at its gate by calling the phase-report command with `action: "hold"` — the same path `wsh jarvis hold` uses (`cmd/wsh/cmd/wshcmd-jarvis.go:21-33`). Driving a real agent to a gate would take up to two minutes; this takes a round trip.
4. Select a **different** channel.
5. Navigate to the **Usage** surface (`model.surfaceAtom` = `"usage"`), so the assertion runs nowhere near Jarvis.
6. Wait for one poll tick — poll at 500ms for up to 15 seconds rather than sleeping 10, so the step is not flaky at the interval boundary.

Assert: the Jarvis nav item's badge element exists and its text parses to a number ≥ 1.

Teardown: delete the `attn-probe` channel.

- [ ] **Step 3: Run it**

Run: `task verify:ui -- attention-cross-channel`
Expected: PASS. Requires the dev app running (`task dev`) and a backend rebuilt with the new command — `task build:backend` — since a new RPC handler does not hot-reload.

- [ ] **Step 4: Break it on purpose, twice**

A green scenario that cannot fail is not a net, and the two halves of this change fail differently.

*Break the detection.* Make `reviewGateIdx` in `pkg/jarvis/attention.go` always return `-1`, rebuild the backend, re-run. Expected: FAIL at the badge assertion. Restore and rebuild.

*Break the delivery.* Change the interval in `frontend/app/view/agents/attentionpoller.tsx` to `10_000_000` and drop the immediate `void loadAttention()` call, then re-run. Expected: FAIL, and specifically at the poll-wait step rather than the badge assertion — the two failures must be distinguishable, or the scenario cannot tell you which half broke. Restore both.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp/scenarios.mjs
git commit -m "test(cdp): a review gate in a non-active channel lights the nav badge"
```

---

### Task 8: The past-work matcher records that it ran

**Files:**
- Modify: `pkg/jarvisproactive/suggestion.go:19-30`
- Modify: `pkg/jarvisproactive/proactive.go:44-101`
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go:265-285`
- Test: `pkg/jarvisproactive/proactive_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks — independent, and may be done first if preferred.
- Produces: `ProactiveSuggestion.Reason string`; `Status` gains the value `"pending"`.

- [ ] **Step 1: Set the CGO include path for this package's tests**

From PowerShell at the repo root:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
```

Verify: `go test ./pkg/jarvisproactive/` builds. A Git-Bash POSIX path fails with an identical error message, so use PowerShell here.

- [ ] **Step 2: Write the failing tests**

Append to `pkg/jarvisproactive/proactive_test.go`:

```go
func TestEvaluateReportsWhyItFoundNothing(t *testing.T) {
	// an index that reports unavailable must still produce a persistable record
	sug, err := evaluate(context.Background(), unavailableIndex(t), fixtureVault(t), &waveobj.Run{Goal: "g"})
	if err != nil {
		t.Fatalf("must not error: %v", err)
	}
	if sug == nil {
		t.Fatal("embeddings-off must produce a record, not a nil no-op")
	}
	if sug.Status != "none" || sug.Reason != ReasonEmbeddingsOff {
		t.Fatalf("want none/%s, got %+v", ReasonEmbeddingsOff, *sug)
	}
}

func TestEvaluateBelowThresholdReportsNoCandidates(t *testing.T) {
	sug, _ := evaluate(context.Background(), emptyIndex(t), fixtureVault(t), &waveobj.Run{Goal: "g"})
	if sug == nil || sug.Reason != ReasonNoCandidates {
		t.Fatalf("want %s, got %+v", ReasonNoCandidates, sug)
	}
}

func TestHitCarriesNoReason(t *testing.T) {
	// a hit is the product answer; Reason exists only to explain a none
	sug := &ProactiveSuggestion{Status: "hit", Title: "t"}
	if sug.Reason != "" {
		t.Fatal("a hit must not carry a reason")
	}
}
```

Reuse the index and vault helpers the existing tests in this file already define — read `TestEvaluateDisabledIndexIsNoop` and `TestEvaluateBelowThresholdSkipsModel` and name your helpers to match whatever those use rather than inventing `unavailableIndex` / `emptyIndex` if equivalents exist.

- [ ] **Step 3: Run to verify failure**

Run: `go test ./pkg/jarvisproactive/ -run "TestEvaluateReports|TestEvaluateBelowThresholdReports|TestHitCarries" -v`
Expected: FAIL — `Reason` and the `Reason*` constants are undefined.

- [ ] **Step 4: Add the field and the reason vocabulary**

In `pkg/jarvisproactive/suggestion.go`, add above the struct:

```go
// Status values. "pending" is written before evaluation begins so that a run which never reaches a
// verdict — a timeout, a crash — is distinguishable from one that ran and found nothing. Before this,
// six different failure paths all left run.Meta untouched, and absence meant all six.
const (
	StatusPending = "pending"
	StatusHit     = "hit"
	StatusNone    = "none"
)

// Reason explains a "none". Empty on a hit and on the pending marker.
const (
	ReasonNoCandidates  = "no-candidates"
	ReasonJudgeDeclined = "judge-declined"
	ReasonJudgeError    = "judge-error"
	ReasonEmbeddingsOff = "embeddings-off"
	ReasonIndexError    = "index-error"
	ReasonVaultError    = "vault-error"
	ReasonQueryError    = "query-error"
)
```

Add to `ProactiveSuggestion`:

```go
	Reason string `json:"reason,omitempty"` // why a "none" is a none; empty on a hit
```

Update the struct's doc comment: `Status` is `pending` | `hit` | `none`.

- [ ] **Step 5: Make every path return a record**

In `pkg/jarvisproactive/proactive.go`, change `EvaluateDispatch` so the two open failures become records instead of bare errors:

```go
func EvaluateDispatch(ctx context.Context, run *waveobj.Run) (*ProactiveSuggestion, error) {
	ix, err := jarvisembed.OpenIndex(ctx)
	if err != nil {
		return &ProactiveSuggestion{Status: StatusNone, Reason: ReasonIndexError}, err
	}
	defer ix.Close()
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return &ProactiveSuggestion{Status: StatusNone, Reason: ReasonVaultError}, err
	}
	return evaluate(ctx, ix, v, run)
}
```

In `evaluate`, replace each silent return with a reasoned record — `!ix.Available()` → `ReasonEmbeddingsOff`; the query error branch → `ReasonEmbeddingsOff` when it is `jarvisembed.ErrEmbeddingsDisabled`, else `ReasonQueryError`; `len(cands) == 0` → `ReasonNoCandidates`; judge error → `ReasonJudgeError`; `pick < 0` → `ReasonJudgeDeclined`. The hit case gains nothing.

Update the function doc comments: they currently promise "nil for a total no-op", which is no longer true.

- [ ] **Step 6: Write the pending marker and persist every outcome**

In `pkg/wshrpc/wshserver/wshserver_runs.go`, restructure the detached block (currently lines 265-285). Extract the metadata write into a local helper so the marker and the outcome share one path, then:

```go
	proactiveAsync(func() {
		pctx, cancel := context.WithTimeout(context.Background(), proactiveDispatchTimeout)
		defer cancel()
		// Marker first: a run left holding "pending" is a timeout or a crash, and is visible. Without
		// it, "never ran" and "ran and found nothing" are the same absence. Deliberately breaks the
		// package's invariant 10 ("embeddings off is a total no-op"); one metadata field on a non-fatal
		// path keeps the run protected while removing the blindness.
		writeProactive(pctx, data.ChannelId, run.ID, jarvisproactive.ProactiveSuggestion{
			Status: jarvisproactive.StatusPending,
		})
		sug, perr := jarvisproactive.EvaluateDispatch(pctx, &run)
		if perr != nil {
			log.Printf("CreateRun: proactive dispatch eval failed (non-fatal): %v", perr)
		}
		if sug == nil {
			sug = &jarvisproactive.ProactiveSuggestion{
				Status: jarvisproactive.StatusNone,
				Reason: jarvisproactive.ReasonQueryError,
			}
		}
		writeProactive(pctx, data.ChannelId, run.ID, *sug)
	})
```

`writeProactive` wraps the existing `wstore.UpdateRun` closure that sets `r.Meta[jarvisproactive.MetaKeyProactive]`, logging on failure exactly as the current code does.

- [ ] **Step 7: Run the Go tests**

Run (PowerShell, with `CGO_CFLAGS` set from Step 1):
```
go test ./pkg/jarvisproactive/ ./pkg/wshrpc/wshserver/ -v
```
Expected: PASS, including the pre-existing hit / decline / below-threshold / self-exclusion cases now asserting reasons.

- [ ] **Step 8: Confirm the frontend needs no change**

Run: `grep -n "status" frontend/app/view/agents/proactive.ts`
Expected: it renders only on `raw.status !== "hit"` → return null. The new `pending` value is already not-a-hit, so nothing changes. Do not edit this file.

- [ ] **Step 9: Commit**

```bash
git add pkg/jarvisproactive/ pkg/wshrpc/wshserver/wshserver_runs.go
git commit -m "feat(jarvisproactive): record that the dispatch evaluator ran, and why it found nothing"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/jarvis-tab.md`
- Modify: `docs/superpowers/briefs/2026-07-31-jarvis-integration-brief.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the Jarvis surface reference**

In `docs/jarvis-tab.md`, § 12 currently describes the attention list as rail-local. Add a paragraph stating that the list is computed server-side (`pkg/jarvis/attention.go`), polled every 10 seconds by an always-mounted driver, and consumed by both the nav-rail badges and the rail — so a review gate in a non-active channel is now visible from every surface. Note the two limits explicitly: up to 10 seconds of staleness, and that the pending-ask registry is in-memory, so the list is authoritative for the current server lifetime rather than absolutely.

If the deviation in this plan's header was kept, also state that a blocked worker whose question was escalated counts once, as an escalation.

- [ ] **Step 2: Close the items in the decision record**

In `docs/superpowers/briefs/2026-07-31-jarvis-integration-brief.md`, under "What to do now", mark item 1 (make the dispatch evaluator observable) and item 2 (fix the review-gate blind spot) as shipped with this plan's date, and note that item 3 — dispatch real work, then re-run the measurement — is now possible because the evaluator records every attempt.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: the attention list is server-computed; close the first two brief items"
```

---

## Final verification

- [ ] `go build ./...`
- [ ] `go test ./pkg/agentask/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/` (PowerShell, `CGO_CFLAGS` set)
- [ ] `go test ./pkg/jarvisproactive/`
- [ ] `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
- [ ] `npx vitest run`
- [ ] `npx eslint .` on the touched files
- [ ] `task build:backend` then `task dev`, and `task verify:ui -- attention-cross-channel jarvis-drawer jarvis-subject-state` — `jarvis-drawer` is the existing net for the rail's Needs-you list and must still pass after Task 6 rewired it.
