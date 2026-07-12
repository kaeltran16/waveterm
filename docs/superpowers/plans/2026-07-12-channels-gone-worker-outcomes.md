# Gone-Worker Outcome Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a worker dispatched from a channel exits, post a persisted `outcome` message (status + summary, derived from its transcript) and render it in the channel transcript and the fleet panel's "Done · N" section.

**Architecture:** The shell-proc exit path (`emitAgentIdleOnExit` neighbor) fires `emitAgentOutcome(blockId, exitCode)`. It reads the transcript path stamped on block meta by the agent-hook, runs the existing `pkg/agentsessions` extractor to get status + summary, resolves the dispatching channel with a new non-gated `ResolveDispatchChannel`, and posts a `kind:"outcome"` channel message (reusing the `postJarvisData` post+notify pattern) — idempotent against re-exit. The frontend folds the outcome onto its `WorkerState` and renders an `OutcomeRow` card + a fleet-panel status glyph.

**Tech Stack:** Go (blockcontroller, jarvis, agentsessions, waveobj), React 19 + jotai + Tailwind (frontend/app/view/agents), vitest, `go test`.

## Global Constraints

- Never hand-edit generated files. This feature adds **no** wshrpc command/type, so **no `task generate`** is needed. `task build:backend` compiles Go changes.
- Typecheck FE: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean, exit 0; `npx tsc` stack-overflows here).
- Go tests for sqlite-touching packages need `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`. Pure resolver/derivation tests do not; if a `go test` fails with a sqlite stub error, re-run with the CGO env.
- **CONCURRENCY WARNING:** the A/F/G batch (`docs/superpowers/plans/2026-07-12-channels-fleet-legibility.md`) is being implemented concurrently and edits the **same three FE files** this plan touches — `jarvisderive.ts`, `channelssurface.tsx`, `channelsprimitives.tsx`. Do the **backend tasks (1–5) first** (disjoint from A/F/G). Before starting the FE tasks (6–7), re-check `git log`/`git diff` and rebase onto the A/F/G changes; both batches extend `WorkerState` and `buildFleetSnapshot`, so merge by hand, don't clobber.
- Comments only for "why", lower case, only when necessary.
- **Do not commit.** The user batches commits and approves them. Each task ends with a verification checkpoint; a single commit is proposed after the whole batch is reviewed.
- Status source is the transcript heuristic (via `agentsessions`), never the exit code. Exit code is recorded only as data.

---

### Task 1: Export single-transcript extraction from `agentsessions`

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go` (add `ExtractSession`, reusing `readLines`, the per-runtime `provider`, and its `extract`/`events`)
- Test: `pkg/agentsessions/agentsessions_test.go` (create if absent; otherwise append)

**Interfaces:**
- Produces: `func ExtractSession(path, runtime string) (*SessionInfo, error)` — reads one transcript file and returns the folded `SessionInfo` (with `Status`, `Events`, `DurationMs` populated), or nil `*SessionInfo` + nil error when the file yields no session (e.g. no human prompt). Unknown runtime → error.

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsessions/extractsession_test.go`:

```go
package agentsessions

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTranscript(t *testing.T, lines []string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "session.jsonl")
	var b []byte
	for _, ln := range lines {
		b = append(b, []byte(ln+"\n")...)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExtractSessionClaudeDone(t *testing.T) {
	// a minimal claude transcript: one human prompt + one assistant reply -> a resumable, done session
	path := writeTranscript(t, []string{
		`{"type":"user","cwd":"/repo","message":{"content":"harden the webhooks"}}`,
		`{"type":"assistant","message":{"model":"claude-opus","content":[{"type":"text","text":"done, hardened."}]}}`,
	})
	s, err := ExtractSession(path, "claude")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if s == nil {
		t.Fatal("want a session, got nil")
	}
	if s.Task != "harden the webhooks" {
		t.Errorf("task = %q", s.Task)
	}
	if s.Status != "done" {
		t.Errorf("status = %q, want done", s.Status)
	}
}

func TestExtractSessionUnknownRuntime(t *testing.T) {
	path := writeTranscript(t, []string{`{"type":"user","message":{"content":"x"}}`})
	if _, err := ExtractSession(path, "nope"); err == nil {
		t.Fatal("want error for unknown runtime")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/agentsessions/ -run TestExtractSession`
Expected: FAIL — `undefined: ExtractSession`.

- [ ] **Step 3: Implement `ExtractSession`**

In `pkg/agentsessions/agentsessions.go`, add (after `ScanSessions`). It selects the provider by runtime, reusing the same `extract`/`events` the scanner uses. The provider constructors (`claudeProvider`, `codexProvider`) take a `root` used only for scanning, which `ExtractSession` doesn't need — pass `""`.

```go
// ExtractSession folds a single transcript file into a SessionInfo, selecting the parser by runtime.
// Returns (nil, nil) when the file carries no session (e.g. a tool-only subagent file). Reuses the
// same extract/events the scanner uses, so status/summary derivation cannot drift from the Agent surfaces.
func ExtractSession(path, runtime string) (*SessionInfo, error) {
	var p provider
	switch runtime {
	case "claude":
		p = claudeProvider("")
	case "codex":
		p = codexProvider("")
	default:
		return nil, fmt.Errorf("agentsessions: unknown runtime %q", runtime)
	}
	lines := readLines(path)
	stem := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	s := p.extract(stem, lines)
	if s == nil {
		return nil, nil
	}
	s.Runtime = runtime
	s.TranscriptPath = path
	se := p.events(lines)
	s.Events = se.Events
	s.Status = se.Status
	s.StartedTs = se.StartedTs
	s.DurationMs = se.DurationMs
	return s, nil
}
```

Add `"fmt"` to the import block if not already present.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/agentsessions/ -run TestExtractSession`
Expected: PASS. (If it fails with a sqlite stub error, re-run with the CGO env from Global Constraints.)

- [ ] **Step 5: Checkpoint** — do not commit. Report: `ExtractSession` added, tests passing.

---

### Task 2: `MetaKey_AgentTranscriptPath` + agent outcome data type

**Files:**
- Modify: `pkg/waveobj/metamapdecl.go` (or wherever `agent:*` meta keys live — grep `MetaKey_` for the `session:agent`/agent group)
- Create: `pkg/jarvis/outcome.go` (the `OutcomeData` struct + status mapping; poster added in Task 4)
- Test: `pkg/jarvis/outcome_test.go`

**Interfaces:**
- Produces: `waveobj.MetaKey_AgentTranscriptPath = "agent:transcriptpath"`. `jarvis.OutcomeData{Status string; Summary string; DurationMs int64; ExitCode int}` and `func outcomeStatus(sessionStatus string) string` mapping `agentsessions` status → the persisted pill status.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvis/outcome_test.go`:

```go
package jarvis

import "testing"

func TestOutcomeStatus(t *testing.T) {
	cases := map[string]string{"done": "done", "failed": "failed", "waiting": "waiting", "": "done"}
	for in, want := range cases {
		if got := outcomeStatus(in); got != want {
			t.Errorf("outcomeStatus(%q) = %q, want %q", in, got, want)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestOutcomeStatus`
Expected: FAIL — `undefined: outcomeStatus`.

- [ ] **Step 3: Add the meta key**

Find the agent meta-key group: `grep -n "agent" pkg/waveobj/metamapdecl.go` (or the file that declares `MetaKey_` constants). Add next to the other `agent:*` keys:

```go
	MetaKey_AgentTranscriptPath = "agent:transcriptpath"
```

If meta keys are also enumerated in a `MetaMapDecls`/registry slice in that file, add a matching entry following the existing pattern for a string key.

- [ ] **Step 4: Implement `OutcomeData` + `outcomeStatus`**

Create `pkg/jarvis/outcome.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

// OutcomeData is the structured payload of a channel "outcome" message (JSON in ChannelMessage.Data).
// The FE styles the status pill off Status.
type OutcomeData struct {
	Status     string `json:"status"`     // "done" | "failed" | "waiting"
	Summary    string `json:"summary"`    // short transcript-derived "what came of it" line
	DurationMs int64  `json:"durationMs"` // wall time from the transcript
	ExitCode   int    `json:"exitCode"`   // process exit code (recorded, not the status source)
}

// outcomeStatus maps an agentsessions status to the persisted pill status. Unknown/empty -> "done"
// (a session with no error/ask marker completed a turn cleanly).
func outcomeStatus(sessionStatus string) string {
	switch sessionStatus {
	case "failed":
		return "failed"
	case "waiting":
		return "waiting"
	default:
		return "done"
	}
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestOutcomeStatus`
Expected: PASS.

- [ ] **Step 6: Checkpoint** — do not commit. Report: meta key + outcome types added, test passing.

---

### Task 3: `ResolveDispatchChannel` (non-gated worker→channel)

**Files:**
- Modify: `pkg/jarvis/resolve.go`
- Test: `pkg/jarvis/resolve_test.go` (create if absent)

**Interfaces:**
- Produces: `func ResolveDispatchChannel(channels []*waveobj.Channel, workerORef string) *waveobj.Channel` — first channel with a `dispatch` message whose `RefORef == workerORef`, regardless of tier. Nil when none.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvis/resolve_test.go`:

```go
package jarvis

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func chanWith(oid string, msgs ...waveobj.ChannelMessage) *waveobj.Channel {
	return &waveobj.Channel{OID: oid, Messages: msgs}
}

func TestResolveDispatchChannelFindsConciergeChannel(t *testing.T) {
	// concierge (gatekeeper OFF) channel still owns its dispatch
	ch := chanWith("c1", waveobj.ChannelMessage{Kind: "dispatch", RefORef: "tab:w1"})
	got := ResolveDispatchChannel([]*waveobj.Channel{ch}, "tab:w1")
	if got == nil || got.OID != "c1" {
		t.Fatalf("got %v, want c1", got)
	}
}

func TestResolveDispatchChannelNoMatch(t *testing.T) {
	ch := chanWith("c1", waveobj.ChannelMessage{Kind: "human", RefORef: ""})
	if got := ResolveDispatchChannel([]*waveobj.Channel{ch}, "tab:w1"); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}
```

(Confirm the `waveobj.ChannelMessage` field names — `Kind`, `RefORef`, `OID` — against `pkg/waveobj`; adjust the literals if the struct differs.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestResolveDispatchChannel`
Expected: FAIL — `undefined: ResolveDispatchChannel`.

- [ ] **Step 3: Implement it**

In `pkg/jarvis/resolve.go`, after `ResolveGatekeeperChannel`:

```go
// ResolveDispatchChannel returns the channel that dispatched the worker at workerORef ("tab:<id>"),
// or nil. Unlike ResolveGatekeeperChannel it is NOT gated by MetaKey_GatekeeperEnabled: a worker's
// outcome belongs in its channel regardless of the channel's autonomy tier. First dispatch owner wins.
func ResolveDispatchChannel(channels []*waveobj.Channel, workerORef string) *waveobj.Channel {
	for _, ch := range channels {
		for _, m := range ch.Messages {
			if m.Kind == "dispatch" && m.RefORef == workerORef {
				return ch
			}
		}
	}
	return nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestResolveDispatchChannel`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — do not commit. Report: resolver added, tests passing.

---

### Task 4: `postOutcome` with idempotency guard

**Files:**
- Modify: `pkg/jarvis/outcome.go` (add poster + guard)
- Modify: `pkg/jarvis/watcher.go` (extract a shared post helper if `postJarvisData` hard-codes author "jarvis")
- Test: `pkg/jarvis/outcome_test.go` (add guard test)

**Interfaces:**
- Consumes: `ResolveDispatchChannel` (Task 3), `OutcomeData`/`outcomeStatus` (Task 2).
- Produces: `func alreadyHasFreshOutcome(ch *waveobj.Channel, workerORef string) bool` (pure); `func PostOutcome(channels []*waveobj.Channel, workerORef, runtime string, data OutcomeData)` (resolves + posts, no-op when no channel or a fresh outcome exists).

- [ ] **Step 1: Write the failing test (pure guard)**

Add to `pkg/jarvis/outcome_test.go`:

```go
import "github.com/wavetermdev/waveterm/pkg/waveobj"

func TestAlreadyHasFreshOutcome(t *testing.T) {
	// outcome newer than the latest dispatch -> fresh (skip re-post)
	fresh := &waveobj.Channel{Messages: []waveobj.ChannelMessage{
		{Kind: "dispatch", RefORef: "tab:w1", Ts: 1},
		{Kind: "outcome", RefORef: "tab:w1", Ts: 2},
	}}
	if !alreadyHasFreshOutcome(fresh, "tab:w1") {
		t.Error("want fresh=true when outcome is newer than dispatch")
	}
	// re-dispatched after the outcome -> not fresh (should post again)
	redispatched := &waveobj.Channel{Messages: []waveobj.ChannelMessage{
		{Kind: "outcome", RefORef: "tab:w1", Ts: 2},
		{Kind: "dispatch", RefORef: "tab:w1", Ts: 3},
	}}
	if alreadyHasFreshOutcome(redispatched, "tab:w1") {
		t.Error("want fresh=false when a newer dispatch supersedes the outcome")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestAlreadyHasFreshOutcome`
Expected: FAIL — `undefined: alreadyHasFreshOutcome`.

- [ ] **Step 3: Implement the guard + poster**

Append to `pkg/jarvis/outcome.go`:

```go
import (
	"context"
	"encoding/json"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// alreadyHasFreshOutcome reports whether an outcome message for workerORef is newer than the worker's
// latest dispatch/directive — meaning a re-post would be a duplicate. A later re-dispatch (newer ts)
// makes it stale again, so the worker can earn a fresh outcome. Pure.
func alreadyHasFreshOutcome(ch *waveobj.Channel, workerORef string) bool {
	var latestDispatch, latestOutcome int64
	for _, m := range ch.Messages {
		if m.RefORef != workerORef {
			continue
		}
		switch m.Kind {
		case "dispatch", "directive":
			if m.Ts > latestDispatch {
				latestDispatch = m.Ts
			}
		case "outcome":
			if m.Ts > latestOutcome {
				latestOutcome = m.Ts
			}
		}
	}
	return latestOutcome >= latestDispatch && latestOutcome > 0
}

// PostOutcome resolves the dispatching channel for workerORef and posts a persisted "outcome" message,
// unless there is no owning channel or a fresh outcome already exists. Fire-and-forget by the caller.
func PostOutcome(channels []*waveobj.Channel, workerORef, runtime string, data OutcomeData) {
	ch := ResolveDispatchChannel(channels, workerORef)
	if ch == nil || alreadyHasFreshOutcome(ch, workerORef) {
		return
	}
	payload, _ := json.Marshal(data)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("outcome", runtime, data.Summary, workerORef, time.Now().UnixMilli())
	msg.Data = string(payload)
	if _, err := wstore.PostChannelMessage(ctx, ch.OID, msg); err != nil {
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, ch.OID))
}
```

(Confirm `wstore.NewChannelMessage(kind, author, text, refORef, ts)` arg order against `watcher.go`'s call in `postJarvisData`; match it exactly.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/jarvis/ -run 'TestAlreadyHasFreshOutcome|TestOutcomeStatus'`
Expected: PASS.

- [ ] **Step 5: Build the package**

Run: `go build ./pkg/jarvis/`
Expected: exit 0.

- [ ] **Step 6: Checkpoint** — do not commit. Report: poster + guard added, tests passing, package builds.

---

### Task 5: Trigger — hook stamp + `emitAgentOutcome`

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agenthook.go` (stamp `agent:transcriptpath` on block meta when the emission carries a path)
- Modify: `pkg/blockcontroller/shellcontroller.go` (add `emitAgentOutcome`; call it at the exit site, line ~620-621)

**Interfaces:**
- Consumes: `jarvis.PostOutcome`, `jarvis.OutcomeData`, `jarvis.outcomeStatus` (make `OutcomeStatus` exported if called cross-package — rename `outcomeStatus`→`OutcomeStatus` in Task 2/4 and update its test), `agentsessions.ExtractSession` (Task 1), `waveobj.MetaKey_AgentTranscriptPath` (Task 2), `wstore.GetChannels`.

> Note: `emitAgentOutcome` (in `pkg/blockcontroller`) calls `jarvis.PostOutcome` and `agentsessions.ExtractSession`. Verify `pkg/blockcontroller` may import `pkg/jarvis` without an import cycle (`grep -r "blockcontroller" pkg/jarvis`); if jarvis already imports blockcontroller, move `emitAgentOutcome`'s body into a small `pkg/jarvis` entry (e.g. `jarvis.OnWorkerExit(blockId, exitCode)`) that blockcontroller calls, keeping the cycle-free direction. Decide this before writing Step 3.

- [ ] **Step 1: Stamp the transcript path from the hook**

In `cmd/wsh/cmd/wshcmd-agenthook.go`, in `agentHookRun`, after the block oref is resolved and when `ev.TranscriptPath != ""`, set the block meta. Use the same RPC client the hook already sets up (`setupRpcClient`); mirror how other `wsh` commands call `SetMetaCommand`:

```go
	if ev.TranscriptPath != "" {
		_ = wshclient.SetMetaCommand(nil, wshrpc.CommandSetMetaData{
			ORef: oref,
			Meta: waveobj.MetaMapType{waveobj.MetaKey_AgentTranscriptPath: ev.TranscriptPath},
		}, nil)
	}
```

(Confirm the exact `wshclient.SetMetaCommand` signature + `CommandSetMetaData` field names against an existing `wsh` call site, e.g. `grep -rn "SetMetaCommand" cmd/wsh`. Match it. Best-effort — a hook must never fail the turn, hence the discarded error.)

- [ ] **Step 2: Add `emitAgentOutcome` and wire it at the exit site**

In `pkg/blockcontroller/shellcontroller.go`, add next to `emitAgentIdleOnExit`:

```go
// emitAgentOutcome posts a channel "outcome" message when a dispatched agent worker's process exits:
// it reads the transcript path stamped on the block by the hook, derives status+summary from the
// transcript (agentsessions), and posts to the dispatching channel (jarvis). No-op for a non-agent
// block, a block with no stamped transcript, or a worker no channel dispatched. Fire-and-forget.
func emitAgentOutcome(blockId string, exitCode int) {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancel()
	blockData, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return
	}
	tpath := blockData.Meta.GetString(waveobj.MetaKey_AgentTranscriptPath, "")
	if tpath == "" {
		return // no transcript stamped (non-agent, or hook never fired) — normal, skip
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return
	}
	runtime := tab.Meta.GetString("session:agent", "")
	if runtime == "" {
		return // not an agent session
	}
	sess, err := agentsessions.ExtractSession(tpath, runtime)
	if err != nil || sess == nil {
		return
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return
	}
	workerORef := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	summary := outcomeSummary(sess) // last event / finished text, trimmed
	jarvis.PostOutcome(channels, workerORef, runtime, jarvis.OutcomeData{
		Status:     jarvis.OutcomeStatus(sess.Status),
		Summary:    summary,
		DurationMs: sess.DurationMs,
		ExitCode:   exitCode,
	})
}

// outcomeSummary picks a short "what came of it" line from a session's events: the last event's text
// (the events list ends with a "finished" entry for a done session), trimmed to a legible length.
func outcomeSummary(sess *agentsessions.SessionInfo) string {
	text := sess.Task
	if n := len(sess.Events); n > 0 && sess.Events[n-1].Text != "" {
		text = sess.Events[n-1].Text
	}
	const maxLen = 160
	if len(text) > maxLen {
		text = text[:maxLen]
	}
	return text
}
```

Add the imports (`agentsessions`, `jarvis`) to `shellcontroller.go` — **unless** Step-0 cycle check forced the `jarvis.OnWorkerExit` inversion, in which case `emitAgentOutcome` lives in `pkg/jarvis` and shellcontroller just calls `jarvis.OnWorkerExit(bc.BlockId, exitCode)`.

Wire it at the exit site (`shellcontroller.go` ~line 620):

```go
		go checkCloseOnExit(bc.BlockId, exitCode)
		go emitAgentIdleOnExit(bc.BlockId)
		go emitAgentOutcome(bc.BlockId, exitCode)
```

- [ ] **Step 3: Build the backend**

Run: `task build:backend`
Expected: exit 0 (compiles `wavesrv` + `wsh`). Fix any import-cycle or signature mismatch surfaced here.

- [ ] **Step 4: Visual/integration check (CDP, best-effort)**

With `tail -f /dev/null | task dev` running: dispatch a worker in a channel with a harmless short task under prompting perms; let it finish and close its terminal. Confirm (via `node scripts/cdp-shot.mjs` and/or reading the channel messages) that an `outcome` message is posted. If a real dispatch+exit can't be driven over CDP, mark unverified with the reason — do not claim it passed.

- [ ] **Step 5: Checkpoint** — do not commit. Report: backend builds; integration result or unverified-reason.

---

### Task 6: FE — fold outcome onto `WorkerState`

> **Rebase first** onto the A/F/G batch (it also extends `WorkerState`/`buildFleetSnapshot`). Merge additively.

**Files:**
- Modify: `frontend/app/view/agents/jarvisderive.ts` (`WorkerState.outcome` + fold in `buildFleetSnapshot`)
- Test: `frontend/app/view/agents/jarvisderive.test.ts`

**Interfaces:**
- Produces: `WorkerState.outcome?: { status: string; summary: string }`, folded from the channel's `outcome` messages (latest per oref) when its ts > the latest dispatch/directive ts for that oref.

- [ ] **Step 1: Write the failing tests**

Add to `jarvisderive.test.ts` inside `describe("buildFleetSnapshot", …)`:

```ts
    it("folds an outcome message onto its worker", () => {
        const c = chan([
            { kind: "dispatch", author: "claude", text: "go", reforef: "tab:t1", ts: 1 },
            { kind: "outcome", author: "claude", text: "hardened webhooks", reforef: "tab:t1", ts: 2, data: JSON.stringify({ status: "done", summary: "hardened webhooks" }) },
        ]);
        const snap = buildFleetSnapshot(c, []);
        expect(snap[0].outcome).toEqual({ status: "done", summary: "hardened webhooks" });
    });

    it("ignores an outcome older than the latest dispatch (re-dispatched worker)", () => {
        const c = chan([
            { kind: "outcome", author: "claude", text: "old", reforef: "tab:t1", ts: 1, data: JSON.stringify({ status: "failed", summary: "old" }) },
            { kind: "dispatch", author: "claude", text: "go again", reforef: "tab:t1", ts: 2 },
        ]);
        const snap = buildFleetSnapshot(c, []);
        expect(snap[0].outcome).toBeUndefined();
    });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts`
Expected: FAIL — `outcome` undefined / not folded.

- [ ] **Step 3: Add the field + fold logic**

In `jarvisderive.ts`, add to `WorkerState`:

```ts
    outcome?: { status: string; summary: string }; // finished-worker outcome (from an "outcome" message)
```

In `buildFleetSnapshot`, alongside the existing `activeTs`/`dismissTs` maps, collect the latest outcome per oref:

```ts
    const outcomeByOref = new Map<string, { ts: number; outcome: { status: string; summary: string } }>();
```

Inside the message loop, after the `dismiss` branch:

```ts
        if (m.kind === "outcome") {
            const prev = outcomeByOref.get(m.reforef);
            if (!prev || (m.ts ?? 0) > prev.ts) {
                let parsed: { status?: string; summary?: string } = {};
                try {
                    parsed = m.data ? JSON.parse(m.data) : {};
                } catch {
                    parsed = {};
                }
                outcomeByOref.set(m.reforef, {
                    ts: m.ts ?? 0,
                    outcome: { status: parsed.status ?? "done", summary: parsed.summary ?? m.text ?? "" },
                });
            }
        }
```

When building each `WorkerState` (both the live and gone return objects), attach the outcome only when newer than the latest dispatch/directive:

```ts
            const oc = outcomeByOref.get(oref);
            const outcome = oc && oc.ts > (activeTs.get(oref) ?? 0) ? oc.outcome : undefined;
```

Add `outcome` to both returned objects (live branch and gone branch). Confirm `ChannelMessage` has a `data?: string` field (it does — used by jarvis cards); if the FE type lacks it, read it as `(m as { data?: string }).data`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts`
Expected: PASS (including pre-existing tests — vitest `toEqual` ignores the new `undefined` field).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Checkpoint** — do not commit. Report: fold added, tests passing, typecheck clean.

---

### Task 7: FE — `OutcomeRow` card + fleet-panel status glyph

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`OutcomeRow` + message-map wiring)
- Modify: `frontend/app/view/agents/channelsprimitives.tsx` (`WorkerRow` glyph + summary)

**No unit test** (render-only; the repo has no jsdom harness per `CLAUDE.md`). Verified by typecheck + CDP.

- [ ] **Step 1: Add `OutcomeRow` and wire the message kind**

In `channelssurface.tsx`, add a status-pill helper and the row (structured like `GatekeeperRow`). Parse the message `data` for the status/summary (fall back to `msg.text`):

```tsx
const OUTCOME_PILL: Record<string, { label: string; cls: string }> = {
    done: { label: "done", cls: "bg-success text-background" },
    failed: { label: "failed", cls: "bg-asking text-background" },
    waiting: { label: "needs you", cls: "bg-warning text-background" },
};

function OutcomeRow({ msg, now }: { msg: ChannelMessage; now: number }) {
    let status = "done";
    let summary = msg.text;
    try {
        const d = msg.data ? JSON.parse(msg.data) : {};
        status = d.status ?? status;
        summary = d.summary ?? summary;
    } catch {
        // legacy/malformed data — fall back to the flat text
    }
    const pill = OUTCOME_PILL[status] ?? OUTCOME_PILL.done;
    return (
        <div className="flex items-start gap-3">
            <Avatar name={msg.author} />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">{msg.author}</span>
                    <Tag label="outcome" tone="muted" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <div className="rounded-[9px] border border-edge-mid bg-surface-raised px-3.5 py-3">
                    <div className="mb-1.5">
                        <span className={`rounded-[4px] px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] ${pill.cls}`}>
                            {pill.label}
                        </span>
                    </div>
                    <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{summary}</div>
                </div>
            </div>
        </div>
    );
}
```

In the transcript message map, add the branch (before the final `MessageRow` fallback):

```tsx
                                ) : m.kind === "outcome" ? (
                                    <OutcomeRow msg={m} now={now} />
                                ) : (
```

Confirm `ChannelMessage` exposes `data?: string` in the FE type; if not, read `(msg as { data?: string }).data`.

- [ ] **Step 2: Add the fleet-panel glyph + summary to gone `WorkerRow`**

In `channelsprimitives.tsx` `WorkerRow`, add a status glyph next to the name when `w.outcome` is present, and prefer the outcome summary as the subline:

```tsx
                <span className="font-mono text-[12.5px] text-primary">{w.name}</span>
                {w.outcome ? (
                    <span
                        title={`outcome: ${w.outcome.status}`}
                        className={
                            w.outcome.status === "failed"
                                ? "text-[11px] text-asking"
                                : w.outcome.status === "waiting"
                                  ? "text-[11px] text-warning"
                                  : "text-[11px] text-success"
                        }
                    >
                        {w.outcome.status === "failed" ? "✗" : w.outcome.status === "waiting" ? "⏸" : "✓"}
                    </span>
                ) : null}
```

And update the subline block to prefer the outcome summary:

```tsx
            {(w.outcome?.summary || w.dispatchTask || w.task) ? (
                <div title={w.outcome?.summary ?? w.dispatchTask ?? w.task} className="mt-0.5 truncate pl-4 text-[11px] text-muted">
                    {w.outcome?.summary ?? w.dispatchTask ?? w.task}
                </div>
            ) : null}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual check (CDP, best-effort)**

With the dev app running and a channel that has a posted `outcome` (from Task 5, or hand-inject one via `scripts/inject-live-agents.mjs`-style tooling): confirm the transcript shows an `OutcomeRow` with the right pill, and the "Done · N" fleet row shows the glyph + summary. `node scripts/cdp-shot.mjs outcome-card.png`. Mark unverified with the reason if the state can't be produced.

- [ ] **Step 5: Checkpoint** — do not commit. Report typecheck + visual result.

---

### Task 8: Batch verification + commit proposal

- [ ] **Step 1: Go tests**

Run: `go test ./pkg/jarvis/ ./pkg/agentsessions/` (add the CGO env if a sqlite stub error appears).
Expected: PASS.

- [ ] **Step 2: FE unit + typecheck**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts` and `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
Expected: PASS / exit 0.

- [ ] **Step 3: Backend build**

Run: `task build:backend`
Expected: exit 0.

- [ ] **Step 4: Self-review the diff**

Run: `git --no-pager diff --stat`. Confirm only the intended files changed, no debug/commented-out code, no generated files hand-edited.

- [ ] **Step 5: Propose the commit (do not commit unprompted)**

Present the M/A file list and a proposed message, await explicit approval:

```
feat(channels): post gone-worker outcome cards from transcript status
```

---

## Self-Review

**1. Spec coverage:**
- Trigger `emitAgentOutcome` at the exit site → Task 5. ✓
- Transcript-path stamp on block meta from the hook → Task 5 (key defined Task 2). ✓
- Derive status+summary via `agentsessions` → Task 1 (`ExtractSession`) + Task 5 (`outcomeSummary`) + Task 2 (`OutcomeStatus`). ✓
- Non-gated channel resolution → Task 3. ✓
- Persisted `outcome` message via `postJarvisData` pattern → Task 4. ✓
- Idempotency via dispatch-ts rule → Task 4 (`alreadyHasFreshOutcome`). ✓
- FE fold → Task 6; `OutcomeRow` + fleet glyph → Task 7. ✓
- Non-goals (files-changed, classifier, plain terminals, backfill) → none implemented. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. Two steps carry explicit *confirm-the-signature* instructions (`wstore.NewChannelMessage` arg order, `wshclient.SetMetaCommand` shape, `ChannelMessage.data`, `waveobj.ChannelMessage` field names) with the grep to run — these are real cross-file verifications, not deferred work. The import-cycle contingency in Task 5 is a decision with both branches specified. Render tasks state "no unit test" with the documented reason.

**3. Type consistency:** `OutcomeData`/`OutcomeStatus`/`ExtractSession`/`ResolveDispatchChannel`/`PostOutcome`/`alreadyHasFreshOutcome` names match across definition and call sites. **Note:** Task 2 defines `outcomeStatus` lowercase but Task 5 calls it cross-package as `jarvis.OutcomeStatus` — export it (rename to `OutcomeStatus`, update the Task 2 test) when Task 5 is reached. `WorkerState.outcome: {status, summary}` matches between Task 6 (fold) and Task 7 (render). FE `outcome` message shape `{status, summary}` matches the Go `OutcomeData` JSON tags.

**Sequencing:** 1 → 2 → 3 → 4 → 5 (backend, disjoint from the concurrent A/F/G batch), then **rebase**, then 6 → 7 (FE, shared files with A/F/G) → 8.
