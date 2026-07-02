# Channels — Wave-jarvis Handoff Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Channels surface to full functional parity with `Wave-jarvis.dc.html` — rich Gatekeeper "answered" cards, clickable escalation options, a Jarvis fleet-manager right panel, and per-channel tier chips + unread badges.

**Architecture:** One optional JSON `data` field on `ChannelMessage` carries the structured ask (populated by `pkg/jarvis/watcher.go`); the FE parses it to render two rich cards. Escalation options deliver via the existing `AnswerAgentCommand`; Override steers the worker via `ControllerInputCommand`. A new `SetChannelReadCommand` stamps a per-channel `read:ts` for unread counts. Pure logic lives in a new `jarviscards.ts` (vitest); components are verified via CDP.

**Tech Stack:** Go (waveobj/wstore/wshrpc/jarvis), TypeScript + React 19 + jotai + Tailwind v4, vitest, CDP visual verification.

**Spec:** `docs/superpowers/specs/2026-07-02-channels-jarvis-handoff-parity-design.md`

---

## Conventions used in this plan

- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows; baseline has ~3 pre-existing `frontend/tauri/api.test.ts` errors — ignore those).
- FE unit tests: `npx vitest run <file>`.
- Go tests: `go test ./pkg/<pkg>/`.
- Codegen: `task generate` regenerates `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go` from Go. **Never hand-edit generated files.**
- Backend rebuild (for live/CDP): `task build:backend` (add `--force` if only `.sql`/non-fingerprinted files changed — not needed here).
- Styling: Tailwind `@theme` tokens only, no raw hex/rgba, no new SCSS.

---

## File Structure

**Backend**
- `pkg/waveobj/wtype.go` — add `ChannelMessage.Data`.
- `pkg/jarvis/cards.go` (new) — `JarvisCardData` type + pure `BuildCardData(...)` (unit-tested).
- `pkg/jarvis/cards_test.go` (new) — table tests for `BuildCardData`.
- `pkg/jarvis/watcher.go` — `postAnswered`/`postEscalation` populate `Data`; `postJarvisData` helper.
- `pkg/wstore/wstore_channel.go` — `SetChannelRead`.
- `pkg/wshrpc/wshrpctypes.go` — `SetChannelReadCommand` + `CommandSetChannelReadData`.
- `pkg/wshrpc/wshserver/wshserver.go` — `SetChannelReadCommand` impl.

**Frontend**
- `frontend/app/view/agents/jarviscards.ts` (new) — `JarvisCardData` type, `parseCardData`, `unreadCount`, `autonomyExplainer`, `fleetCounts`, `tierChip`, `READ_TS_META`.
- `frontend/app/view/agents/jarviscards.test.ts` (new) — vitest for the above.
- `frontend/app/view/agents/channelactions.ts` — `steerWorker`.
- `frontend/app/view/agents/channelsstore.ts` — `selectChannel` stamps read.
- `frontend/app/view/agents/channelssurface.tsx` — `OptionList`, `EscalationRow`, rebuilt `GatekeeperRow`, `ContextPanel`, `Composer`, `Avatar`.
- `frontend/app/view/agents/channelrail.tsx` — tier chip + unread badge.

---

## Phase 1 — Backend: structured card data

### Task 1: Add `Data` field to `ChannelMessage`

**Files:**
- Modify: `pkg/waveobj/wtype.go` (the `ChannelMessage struct`, ~line 204)

- [ ] **Step 1: Add the field**

In `pkg/waveobj/wtype.go`, change the struct to:

```go
type ChannelMessage struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Author  string `json:"author"`
	Text    string `json:"text"`
	RefORef string `json:"reforef,omitempty"`
	Ts      int64  `json:"ts"`
	Data    string `json:"data,omitempty"` // optional JSON payload for rich rendering (e.g. JarvisCardData)
}
```

- [ ] **Step 2: Regenerate TS types**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` `ChannelMessage` now has `data?: string;`.

- [ ] **Step 3: Verify Go builds**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add pkg/waveobj/wtype.go frontend/types/gotypes.d.ts
git commit -m "feat(channels): add optional data field to ChannelMessage"
```

---

### Task 2: `JarvisCardData` payload + `BuildCardData` (TDD)

**Files:**
- Create: `pkg/jarvis/cards.go`
- Create: `pkg/jarvis/cards_test.go`

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvis/cards_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func sampleQuestion() baseds.AgentAskQuestion {
	return baseds.AgentAskQuestion{
		Question: "Session cache TTL — 24h or 7d?",
		Options: []baseds.AgentAskOption{
			{Label: "24 hours", Description: "matches access-token lifetime"},
			{Label: "7 days", Description: "fewer re-auths"},
		},
	}
}

func TestBuildCardData_Answered(t *testing.T) {
	choice := 0
	cd := BuildCardData(sampleQuestion(), &choice, "low-risk, reversible", "block:abc", "tab:xyz")
	if cd.AskORef != "block:abc" || cd.WorkerORef != "tab:xyz" {
		t.Fatalf("orefs: %+v", cd)
	}
	if cd.Question != "Session cache TTL — 24h or 7d?" {
		t.Fatalf("question: %q", cd.Question)
	}
	if len(cd.Options) != 2 || cd.Options[0].Label != "24 hours" || cd.Options[0].Sub != "matches access-token lifetime" {
		t.Fatalf("options: %+v", cd.Options)
	}
	if cd.Choice == nil || *cd.Choice != 0 {
		t.Fatalf("choice: %+v", cd.Choice)
	}
	if cd.Reason != "low-risk, reversible" {
		t.Fatalf("reason: %q", cd.Reason)
	}
	// round-trips as JSON
	if _, err := json.Marshal(cd); err != nil {
		t.Fatalf("marshal: %v", err)
	}
}

func TestBuildCardData_Escalation_NoChoice(t *testing.T) {
	cd := BuildCardData(sampleQuestion(), nil, "real fork", "block:abc", "tab:xyz")
	if cd.Choice != nil {
		t.Fatalf("expected nil choice, got %+v", cd.Choice)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestBuildCardData`
Expected: FAIL — `undefined: BuildCardData`.

- [ ] **Step 3: Implement `cards.go`**

Create `pkg/jarvis/cards.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import "github.com/wavetermdev/waveterm/pkg/baseds"

// JarvisCardOption is one selectable option in a Gatekeeper card.
type JarvisCardOption struct {
	Label string `json:"label"`
	Sub   string `json:"sub,omitempty"`
}

// JarvisCardData is the structured payload the FE uses to render the rich Gatekeeper answered /
// escalation cards. Serialized into ChannelMessage.Data. AskORef is the block-level ask oref (used to
// deliver an answer); WorkerORef is the worker's tab oref (used to resolve the roster row + steer).
type JarvisCardData struct {
	AskORef    string             `json:"askORef"`
	WorkerORef string             `json:"workerORef"`
	Question   string             `json:"question"`
	Options    []JarvisCardOption `json:"options"`
	Choice     *int               `json:"choice,omitempty"` // present ⇒ answered; absent ⇒ escalation
	Reason     string             `json:"reason,omitempty"`
}

// BuildCardData assembles the card payload from a single-select ask question.
func BuildCardData(q baseds.AgentAskQuestion, choice *int, reason, askORef, workerORef string) JarvisCardData {
	opts := make([]JarvisCardOption, 0, len(q.Options))
	for _, o := range q.Options {
		opts = append(opts, JarvisCardOption{Label: o.Label, Sub: o.Description})
	}
	return JarvisCardData{
		AskORef:    askORef,
		WorkerORef: workerORef,
		Question:   q.Question,
		Options:    opts,
		Choice:     choice,
		Reason:     reason,
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestBuildCardData`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/cards.go pkg/jarvis/cards_test.go
git commit -m "feat(jarvis): JarvisCardData payload + BuildCardData"
```

---

### Task 3: Populate `Data` in `postAnswered` / `postEscalation`

**Files:**
- Modify: `pkg/jarvis/watcher.go` (`handleAsk` call sites ~line 104/109, `postAnswered` 112, `postEscalation` 120, `postJarvis` 137)

- [ ] **Step 1: Add a `postJarvisData` helper and route `postJarvis` through it**

Replace `postJarvis` (lines 137-146) with:

```go
func postJarvis(channelId, kind, text string) {
	postJarvisData(channelId, kind, text, "")
}

func postJarvisData(channelId, kind, text, data string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage(kind, "jarvis", text, "", time.Now().UnixMilli())
	msg.Data = data
	if _, err := wstore.PostChannelMessage(ctx, channelId, msg); err != nil {
		log.Printf("jarvis: post %s failed: %v", kind, err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
}
```

- [ ] **Step 2: Change `postAnswered` to carry the full card data**

Replace `postAnswered` (lines 112-118) with:

```go
func postAnswered(channelId string, q baseds.AgentAskQuestion, choiceIdx int, reason, askORef, workerORef string) {
	text := fmt.Sprintf("Answered → %q", q.Options[choiceIdx].Label)
	if reason != "" {
		text += " — " + reason
	}
	data, _ := json.Marshal(BuildCardData(q, &choiceIdx, reason, askORef, workerORef))
	postJarvisData(channelId, "jarvis-answered", text, string(data))
}
```

- [ ] **Step 3: Change `postEscalation` to carry the card data**

Replace `postEscalation` (lines 120-135) with:

```go
func postEscalation(channelId string, data baseds.AgentAskData, reason, workerORef string) {
	var b strings.Builder
	b.WriteString("@you — your call")
	if reason != "" {
		b.WriteString(" (" + reason + ")")
	}
	b.WriteString("\n")
	var payload string
	if len(data.Questions) > 0 {
		q := data.Questions[0]
		b.WriteString(q.Question + "\n")
		for i, o := range q.Options {
			b.WriteString(fmt.Sprintf("  %d) %s\n", i, o.Label))
		}
		j, _ := json.Marshal(BuildCardData(q, nil, reason, data.ORef, workerORef))
		payload = string(j)
	}
	postJarvisData(channelId, "jarvis-escalation", strings.TrimRight(b.String(), "\n"), payload)
}
```

- [ ] **Step 4: Update the call sites in `handleAsk`**

In `handleAsk` (lines 90-109), update the three calls to pass `ownerORef` (and the answered args). The relevant region becomes:

```go
	// deterministic pre-filter: only a single single-select question is auto-answerable.
	if len(data.Questions) != 1 || data.Questions[0].MultiSelect {
		postEscalation(ch.OID, data, "needs a human (multiple or multi-select questions)", ownerORef)
		return
	}
	q := data.Questions[0]
	decision := Classify(ctx, ch, q, workerTaskFor(ch, ownerORef))
	if ctx.Err() != nil {
		return // cleared / cancelled mid-classification
	}
	if decision.Action == "answer" && decision.OptionIndex != nil {
		idx := *decision.OptionIndex
		if idx >= 0 && idx < len(q.Options) {
			delivered, derr := agentask.DeliverAnswer(data.ORef, []baseds.AgentAnswerItem{{SelectedIndexes: []int{idx}}})
			if derr == nil && delivered {
				postAnswered(ch.OID, q, idx, decision.Reason, data.ORef, ownerORef)
			}
			return
		}
	}
	postEscalation(ch.OID, data, decision.Reason, ownerORef)
```

- [ ] **Step 5: Add the `encoding/json` import**

In the import block (lines 6-20), add `"encoding/json"` (keep alphabetical order — it goes first among the stdlib group):

```go
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
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)
```

- [ ] **Step 6: Build + run the jarvis tests**

Run: `go build ./pkg/... && go test ./pkg/jarvis/`
Expected: builds clean, all jarvis tests PASS.

- [ ] **Step 7: Commit**

```bash
git add pkg/jarvis/watcher.go
git commit -m "feat(jarvis): populate ChannelMessage.Data on answered/escalation posts"
```

---

## Phase 2 — Backend: `SetChannelReadCommand`

### Task 4: `SetChannelRead` wstore + wshrpc command + regen

**Files:**
- Modify: `pkg/wstore/wstore_channel.go` (add `SetChannelRead`)
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface ~line 115, data struct ~line 713)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (impl, near `SetChannelTierCommand` ~line 1664)

- [ ] **Step 1: Add `SetChannelRead` to wstore**

Append to `pkg/wstore/wstore_channel.go`:

```go
// MetaKey_ReadTs stores the per-channel last-read timestamp (ms) used to derive unread counts.
const MetaKey_ReadTs = "read:ts"

// SetChannelRead stamps the channel's last-read timestamp.
func SetChannelRead(ctx context.Context, channelId string, ts int64) error {
	return DBUpdateFn(ctx, channelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[MetaKey_ReadTs] = float64(ts)
	})
}
```

Note: `MetaMapType` stores numbers as `float64` (JSON), so store `float64(ts)`.

- [ ] **Step 2: Add the command to the wshrpc interface**

In `pkg/wshrpc/wshrpctypes.go`, directly after the `SetChannelTierCommand` interface line (~115), add:

```go
	SetChannelReadCommand(ctx context.Context, data CommandSetChannelReadData) error // stamps a channel's last-read timestamp for unread counts
```

- [ ] **Step 3: Add the command data struct**

In `pkg/wshrpc/wshrpctypes.go`, after `CommandSetChannelTierData` (~line 717), add:

```go
type CommandSetChannelReadData struct {
	ChannelId string `json:"channelid"`
	Ts        int64  `json:"ts"`
}
```

- [ ] **Step 4: Implement the server command**

In `pkg/wshrpc/wshserver/wshserver.go`, after `SetChannelTierCommand` (~line 1685), add:

```go
func (ws *WshServer) SetChannelReadCommand(ctx context.Context, data wshrpc.CommandSetChannelReadData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	if err := wstore.SetChannelRead(ctx, data.ChannelId, data.Ts); err != nil {
		return fmt.Errorf("updating channel read ts: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 5: Regenerate the RPC client**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` gains `SetChannelReadCommand`; `pkg/wshrpc/wshclient/wshclient.go` gains a matching wrapper; `CommandSetChannelReadData` appears in `gotypes.d.ts`.

- [ ] **Step 6: Build**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add pkg/wstore/wstore_channel.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go frontend/types/gotypes.d.ts
git commit -m "feat(channels): SetChannelReadCommand + per-channel read:ts meta"
```

---

## Phase 3 — Frontend pure helpers (`jarviscards.ts`, TDD)

### Task 5: `JarvisCardData` type + `parseCardData` (TDD)

**Files:**
- Create: `frontend/app/view/agents/jarviscards.ts`
- Create: `frontend/app/view/agents/jarviscards.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/jarviscards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCardData } from "./jarviscards";

const answered = JSON.stringify({
    askORef: "block:abc",
    workerORef: "tab:xyz",
    question: "TTL 24h or 7d?",
    options: [{ label: "24 hours", sub: "matches token" }, { label: "7 days" }],
    choice: 0,
    reason: "reversible",
});

describe("parseCardData", () => {
    it("parses an answered payload", () => {
        const cd = parseCardData({ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answered });
        expect(cd?.question).toBe("TTL 24h or 7d?");
        expect(cd?.options).toHaveLength(2);
        expect(cd?.choice).toBe(0);
        expect(cd?.askORef).toBe("block:abc");
        expect(cd?.workerORef).toBe("tab:xyz");
    });
    it("parses an escalation payload (no choice)", () => {
        const esc = JSON.stringify({ askORef: "block:a", workerORef: "tab:b", question: "q", options: [{ label: "x" }] });
        expect(parseCardData({ id: "2", kind: "jarvis-escalation", author: "jarvis", text: "", ts: 0, data: esc })?.choice).toBeUndefined();
    });
    it("returns null for a legacy message (no data)", () => {
        expect(parseCardData({ id: "3", kind: "jarvis-answered", author: "jarvis", text: "flat", ts: 0 })).toBeNull();
    });
    it("returns null for malformed json", () => {
        expect(parseCardData({ id: "4", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: "{oops" })).toBeNull();
    });
    it("returns null when required fields are missing", () => {
        expect(parseCardData({ id: "5", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: "{}" })).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: FAIL — cannot resolve `./jarviscards`.

- [ ] **Step 3: Implement `jarviscards.ts` (type + parseCardData)**

Create `frontend/app/view/agents/jarviscards.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers for the Channels Jarvis surface: parse the ChannelMessage.data payload into the rich
// Gatekeeper card model, derive unread counts, the per-tier autonomy explainer, fleet counts, and the
// rail tier chip. No React, no jotai — unit-tested in jarviscards.test.ts.

import type { JarvisTier } from "./channelmessages";

export const READ_TS_META = "read:ts";

export interface JarvisCardOption {
    label: string;
    sub?: string;
}

export interface JarvisCardData {
    askORef: string;
    workerORef: string;
    question: string;
    options: JarvisCardOption[];
    choice?: number;
    reason?: string;
}

// parseCardData reads the structured payload off a jarvis-answered/-escalation message. Returns null
// for legacy messages (no data), malformed JSON, or a payload missing required fields — callers then
// fall back to the flat msg.text.
export function parseCardData(msg: ChannelMessage): JarvisCardData | null {
    if (!msg.data) {
        return null;
    }
    try {
        const p = JSON.parse(msg.data) as Partial<JarvisCardData>;
        if (typeof p.question !== "string" || !Array.isArray(p.options) || typeof p.askORef !== "string") {
            return null;
        }
        return {
            askORef: p.askORef,
            workerORef: typeof p.workerORef === "string" ? p.workerORef : "",
            question: p.question,
            options: p.options,
            choice: typeof p.choice === "number" ? p.choice : undefined,
            reason: typeof p.reason === "string" ? p.reason : undefined,
        };
    } catch {
        return null;
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/jarviscards.ts frontend/app/view/agents/jarviscards.test.ts
git commit -m "feat(channels): jarviscards parseCardData + types"
```

---

### Task 6: `unreadCount` (TDD)

**Files:**
- Modify: `frontend/app/view/agents/jarviscards.ts`
- Modify: `frontend/app/view/agents/jarviscards.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `jarviscards.test.ts`:

```ts
import { unreadCount } from "./jarviscards";

describe("unreadCount", () => {
    const msgs = [
        { id: "a", kind: "human", author: "you", text: "", ts: 100 },
        { id: "b", kind: "dispatch", author: "claude", text: "", ts: 200 },
        { id: "c", kind: "jarvis-answered", author: "jarvis", text: "", ts: 300 },
    ] as ChannelMessage[];
    it("counts messages after lastRead, excluding your own", () => {
        expect(unreadCount(msgs, 150)).toBe(2); // b, c
    });
    it("excludes your own messages", () => {
        expect(unreadCount(msgs, 0)).toBe(2); // a is author 'you'
    });
    it("boundary ts === lastRead is read", () => {
        expect(unreadCount(msgs, 300)).toBe(0);
    });
    it("no lastRead counts all non-you", () => {
        expect(unreadCount(msgs, undefined)).toBe(2);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: FAIL — `unreadCount` not exported.

- [ ] **Step 3: Implement**

Append to `jarviscards.ts`:

```ts
// unreadCount = channel messages strictly after lastReadTs, excluding the human's own posts.
export function unreadCount(messages: ChannelMessage[] | undefined, lastReadTs: number | undefined): number {
    const since = lastReadTs ?? 0;
    return (messages ?? []).filter((m) => m.ts > since && m.author !== "you").length;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/jarviscards.ts frontend/app/view/agents/jarviscards.test.ts
git commit -m "feat(channels): unreadCount helper"
```

---

### Task 7: `autonomyExplainer` + `tierChip` (TDD)

**Files:**
- Modify: `frontend/app/view/agents/jarviscards.ts`
- Modify: `frontend/app/view/agents/jarviscards.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `jarviscards.test.ts`:

```ts
import { autonomyExplainer, tierChip } from "./jarviscards";

describe("autonomyExplainer", () => {
    it("marks capabilities cumulatively per tier", () => {
        const c = autonomyExplainer("concierge");
        expect(c.checklist.map((x) => x.active)).toEqual([true, false, false]);
        const g = autonomyExplainer("gatekeeper");
        expect(g.checklist.map((x) => x.active)).toEqual([true, true, false]);
        const d = autonomyExplainer("delegator");
        expect(d.checklist.map((x) => x.active)).toEqual([true, true, true]);
    });
    it("labels the three capabilities", () => {
        expect(autonomyExplainer("concierge").checklist.map((x) => x.label)).toEqual([
            "Observe the fleet",
            "Answer routine questions",
            "Dispatch & steer workers",
        ]);
    });
});

describe("tierChip", () => {
    it("maps tier to its letter", () => {
        expect(tierChip("concierge")).toBe("C");
        expect(tierChip("gatekeeper")).toBe("G");
        expect(tierChip("delegator")).toBe("D");
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Append to `jarviscards.ts`:

```ts
export interface AutonomyExplainer {
    blurb: string;
    checklist: { label: string; active: boolean }[];
}

const TIER_RANK: Record<JarvisTier, number> = { concierge: 0, gatekeeper: 1, delegator: 2 };
const CAP_LABELS = ["Observe the fleet", "Answer routine questions", "Dispatch & steer workers"] as const;
const TIER_BLURB: Record<JarvisTier, string> = {
    concierge: "Observes the fleet and summarizes on request. It never answers or acts on its own.",
    gatekeeper: "Answers routine worker questions itself; escalates real forks to you.",
    delegator: "Spawns and steers workers toward a goal; still escalates real forks to you.",
};

// autonomyExplainer returns the per-tier blurb + a 3-item capability checklist, cumulative by rank.
export function autonomyExplainer(tier: JarvisTier): AutonomyExplainer {
    const rank = TIER_RANK[tier];
    return {
        blurb: TIER_BLURB[tier],
        checklist: CAP_LABELS.map((label, i) => ({ label, active: i <= rank })),
    };
}

export function tierChip(tier: JarvisTier): "C" | "G" | "D" {
    return tier === "delegator" ? "D" : tier === "gatekeeper" ? "G" : "C";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/jarviscards.ts frontend/app/view/agents/jarviscards.test.ts
git commit -m "feat(channels): autonomyExplainer + tierChip helpers"
```

---

### Task 8: `fleetCounts` (TDD)

**Files:**
- Modify: `frontend/app/view/agents/jarviscards.ts`
- Modify: `frontend/app/view/agents/jarviscards.test.ts`

Note: `buildFleetSnapshot` (in `jarvisderive.ts`) returns `WorkerState[]` with a `state` field of `"working" | "asking" | "idle" | "gone"`. "waiting" in the panel = `asking`.

- [ ] **Step 1: Add the failing test**

Append to `jarviscards.test.ts`:

```ts
import { fleetCounts } from "./jarviscards";

describe("fleetCounts", () => {
    it("tallies working and waiting(=asking), ignoring idle/gone", () => {
        const snap = [
            { state: "working" }, { state: "working" }, { state: "asking" },
            { state: "idle" }, { state: "gone" },
        ] as { state: string }[];
        expect(fleetCounts(snap)).toEqual({ working: 2, waiting: 1 });
    });
    it("empty snapshot is zero", () => {
        expect(fleetCounts([])).toEqual({ working: 0, waiting: 0 });
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Append to `jarviscards.ts`:

```ts
// fleetCounts tallies working + waiting(=asking) from a fleet snapshot; idle/gone are excluded.
export function fleetCounts(snapshot: { state: string }[]): { working: number; waiting: number } {
    let working = 0;
    let waiting = 0;
    for (const w of snapshot) {
        if (w.state === "working") {
            working++;
        } else if (w.state === "asking") {
            waiting++;
        }
    }
    return { working, waiting };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/view/agents/jarviscards.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/jarviscards.ts frontend/app/view/agents/jarviscards.test.ts
git commit -m "feat(channels): fleetCounts helper"
```

---

## Phase 4 — Frontend components

### Task 9: `steerWorker` action

**Files:**
- Modify: `frontend/app/view/agents/channelactions.ts`

- [ ] **Step 1: Add `steerWorker`**

Append to `channelactions.ts` (after `sendChannelMessage`):

```ts
// steerWorker injects a directive into a live worker's terminal (Override on an answered card) and
// records a directive message, mirroring the composer's steer branch. workerORef is a "tab:<id>" oref;
// the roster entry supplies the blockId to write to. No-ops (returns false) if the worker is gone.
export async function steerWorker(args: {
    channelId: string;
    workerORef: string;
    agents: AgentVM[];
    text: string;
}): Promise<boolean> {
    const { channelId, workerORef, agents, text } = args;
    if (!workerORef.startsWith("tab:")) {
        return false;
    }
    const worker = agents.find((a) => a.id === workerORef.slice("tab:".length));
    if (!worker?.blockId) {
        return false;
    }
    await RpcApi.ControllerInputCommand(TabRpcClient, {
        blockid: worker.blockId,
        inputdata64: stringToBase64(text + "\r"),
    });
    await post(channelId, "directive", "you", text, workerORef);
    return true;
}
```

- [ ] **Step 2: Verify `post`, `stringToBase64`, `AgentVM` are in scope**

`post` is a module-private function already defined in this file; `stringToBase64` is imported from `@/util/util`; `AgentVM` from `./agentsviewmodel`. All already imported at the top of `channelactions.ts` — no new imports needed. Confirm by reading the import block.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors (baseline api.test.ts errors only).

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/channelactions.ts
git commit -m "feat(channels): steerWorker action for Override"
```

---

### Task 10: `selectChannel` stamps read

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts` (`selectChannel`, lines 44-47)

- [ ] **Step 1: Update `selectChannel` to stamp the read timestamp**

Replace `selectChannel` (lines 44-47) with:

```ts
export async function selectChannel(channelId: string): Promise<void> {
    await WOS.loadAndPinWaveObject<Channel>(WOS.makeORef("channel", channelId));
    globalStore.set(activeChannelIdAtom, channelId);
    // stamp last-read so the rail unread badge clears (fire-and-forget; failure is non-fatal)
    RpcApi.SetChannelReadCommand(TabRpcClient, { channelid: channelId, ts: Date.now() }).catch(() => {});
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors. (`SetChannelReadCommand` exists from Task 4's regen.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/channelsstore.ts
git commit -m "feat(channels): stamp read:ts on channel select"
```

---

### Task 11: Shared `OptionList` component

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx`

- [ ] **Step 1: Add the `OptionList` component**

Add near the other row helpers in `channelssurface.tsx` (e.g. after `Tag`, before `AskRow`), importing the card types at the top of the file (add to the existing import group): `import { parseCardData, autonomyExplainer, fleetCounts, type JarvisCardData } from "./jarviscards";` and `import { steerWorker } from "./channelactions";` (extend the existing `./channelactions` import).

```tsx
// A radio-style option list used by the escalation card (deliver an answer) and Override (steer). When
// `chosen` is set, that option is marked; clicking any option calls onPick with its index.
function OptionList({
    options,
    chosen,
    onPick,
    disabled,
}: {
    options: { label: string; sub?: string }[];
    chosen?: number;
    onPick: (idx: number) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex flex-col gap-2">
            {options.map((o, i) => (
                <button
                    key={i}
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(i)}
                    className="flex items-start gap-2.5 rounded-[10px] border border-edge-mid bg-surface-raised px-3 py-2.5 text-left hover:border-edge-strong disabled:opacity-50"
                >
                    <span
                        className={
                            "mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border " +
                            (i === chosen ? "border-accent" : "border-edge-strong")
                        }
                    >
                        {i === chosen ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                    </span>
                    <span className="min-w-0">
                        <span className="block text-[13px] font-semibold text-primary">{o.label}</span>
                        {o.sub ? <span className="mt-0.5 block text-[11.5px] text-muted">{o.sub}</span> : null}
                    </span>
                </button>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors (component is unused until Tasks 12-13 — that's fine; it's referenced by name, not exported, so add it in the same commit as its first use to avoid an unused warning. If the linter flags unused, proceed — the next task uses it).

- [ ] **Step 3: Commit (fold with Task 12 if lint blocks on unused)**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(channels): shared OptionList component"
```

---

### Task 12: `EscalationRow` (clickable options → deliver)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`GatekeeperRow` currently handles both kinds; split escalation out)

- [ ] **Step 1: Add `EscalationRow`**

Add after `GatekeeperRow`:

```tsx
// The escalation card: an amber attention card whose options are clickable. Selecting one delivers the
// answer to the still-blocked worker via AnswerAgentCommand (the same path AnswerBar uses), then shows a
// resolved footer. Falls back to the flat text for legacy messages with no structured data.
function EscalationRow({ msg, agents, now }: { msg: ChannelMessage; agents: AgentVM[]; now: number }) {
    const card = parseCardData(msg);
    const [picked, setPicked] = useState<number | null>(null);
    const worker = card ? workerFor(agents, card.workerORef) : undefined;
    const workerName = worker?.name ?? "worker";
    const deliver = (idx: number) => {
        if (!card) {
            return;
        }
        setPicked(idx);
        fireAndForget(() =>
            RpcApi.AnswerAgentCommand(TabRpcClient, {
                oref: card.askORef,
                answers: [{ selectedindexes: [idx] }],
            })
        );
    };
    return (
        <div className="flex items-start gap-3">
            <Avatar name="jarvis" />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">jarvis</span>
                    <Tag label="escalation" tone="asking" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <div className="rounded-[9px] border border-asking/40 bg-lane-asking px-3.5 py-3">
                    {card ? (
                        <>
                            {card.reason ? (
                                <p className="mb-2 text-[12.5px] leading-[1.55] text-ink-mid">
                                    <span className="text-muted">Why I'm not deciding this: </span>
                                    {card.reason}
                                </p>
                            ) : null}
                            <p className="mb-3 text-[14px] font-semibold leading-[1.5] text-primary">{card.question}</p>
                            {picked == null ? (
                                <OptionList options={card.options} onPick={deliver} disabled={!worker} />
                            ) : (
                                <div className="flex items-center gap-2 text-[12px] text-secondary">
                                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                    You chose <b className="text-primary">{card.options[picked]?.label}</b> — sent to{" "}
                                    {workerName}, resuming.
                                </div>
                            )}
                            {!worker && picked == null ? (
                                <p className="mt-2 text-[11px] text-muted">{workerName} has exited — can't deliver.</p>
                            ) : null}
                        </>
                    ) : (
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{msg.text}</div>
                    )}
                </div>
            </div>
        </div>
    );
}
```

Note: `AnswerAgentCommand({ oref, answers })` takes `answers: AgentAnswerItem[]` where `AgentAnswerItem` is `{ selectedindexes?: number[] }` (verified in `frontend/types/gotypes.d.ts`) — the code above uses `{ selectedindexes: [idx] }`, matching `buildAskAnswers`.

- [ ] **Step 2: Route `jarvis-escalation` to `EscalationRow`**

In `ChannelsSurface`'s message map (the `m.kind === "jarvis-answered" || m.kind === "jarvis-escalation"` branch, ~line 724), split the two:

```tsx
                                    ) : m.kind === "jarvis-answered" ? (
                                        <GatekeeperRow key={m.id} model={model} agents={agents} msg={m} now={now} />
                                    ) : m.kind === "jarvis-escalation" ? (
                                        <EscalationRow key={m.id} agents={agents} msg={m} now={now} />
                                    ) : (
```

(`GatekeeperRow` gains `model` + `agents` props in Task 13.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(channels): functional escalation card with deliverable options"
```

---

### Task 13: Rebuild `GatekeeperRow` (answered card + Override)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`GatekeeperRow`, current lines ~237-260)

- [ ] **Step 1: Replace `GatekeeperRow`**

Replace the current `GatekeeperRow` with the answered-only rich version (escalation now lives in `EscalationRow`):

```tsx
// The Gatekeeper "answered for you" card: shows the worker's question, the option Jarvis chose, and its
// reasoning, with an Override that reveals the options so you can steer the worker to a different one.
// Legacy messages (no structured data) fall back to the flat muted text card.
function GatekeeperRow({
    model,
    agents,
    msg,
    now,
}: {
    model: AgentsViewModel;
    agents: AgentVM[];
    msg: ChannelMessage;
    now: number;
}) {
    const card = parseCardData(msg);
    const [overriding, setOverriding] = useState(false);
    const [steered, setSteered] = useState<number | null>(null);
    const worker = card ? workerFor(agents, card.workerORef) : undefined;
    const workerName = worker?.name ?? "worker";
    const doOverride = (idx: number) => {
        if (!card) {
            return;
        }
        setSteered(idx);
        setOverriding(false);
        fireAndForget(async () => {
            await steerWorker({
                channelId: msg.reforef ? msg.reforef : (globalStore.get(activeChannelIdAtom) ?? ""),
                workerORef: card.workerORef,
                agents,
                text: `reconsider — use ${card.options[idx]?.label}`,
            });
        });
    };
    return (
        <div className="flex items-start gap-3">
            <Avatar name="jarvis" />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">jarvis</span>
                    <Tag label="answered" tone="muted" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <div className="rounded-[9px] border border-edge-mid bg-surface-raised px-3.5 py-3">
                    {card && card.choice != null ? (
                        <>
                            <div className="mb-2.5 rounded-[8px] border border-edge-faint bg-background/40 px-3 py-2">
                                <div className="mb-0.5 font-mono text-[11px] font-semibold text-ink-mid">
                                    {workerName} asked
                                </div>
                                <div className="text-[13px] text-secondary">{card.question}</div>
                            </div>
                            <div className="mb-1 flex items-baseline gap-2">
                                <span className="text-[12px] text-muted">Jarvis chose</span>
                                <span className="text-[14px] font-semibold text-primary">
                                    {card.options[card.choice]?.label}
                                </span>
                            </div>
                            {card.reason ? (
                                <p className="text-[13px] leading-[1.55] text-secondary">{card.reason}</p>
                            ) : null}
                            <div className="mt-3 flex items-center gap-2.5 border-t border-edge-faint pt-2.5">
                                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                <span className="flex-1 text-[11.5px] text-muted">
                                    {steered != null
                                        ? `steered ${workerName} → ${card.options[steered]?.label}`
                                        : `${workerName} resumed on its own`}
                                </span>
                                {steered == null && worker ? (
                                    <button
                                        type="button"
                                        onClick={() => setOverriding((v) => !v)}
                                        className="cursor-pointer rounded-[6px] border border-edge-mid px-2.5 py-1 font-mono text-[11px] text-ink-mid hover:border-edge-strong"
                                    >
                                        Override
                                    </button>
                                ) : null}
                            </div>
                            {overriding ? (
                                <div className="mt-2.5">
                                    <div className="mb-1.5 text-[11px] text-muted">Steer {workerName} to:</div>
                                    <OptionList options={card.options} chosen={card.choice} onPick={doOverride} />
                                </div>
                            ) : null}
                        </>
                    ) : (
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{msg.text}</div>
                    )}
                </div>
            </div>
        </div>
    );
}
```

Note: add `globalStore` and `activeChannelIdAtom` to the file's imports if not present (`globalStore` from `@/app/store/jotaiStore`; `activeChannelIdAtom` is already imported from `./channelsstore`). `globalStore` is already imported at the top of `channelssurface.tsx`.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 3: Run the full FE unit suite (guard against regressions)**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(channels): rich Gatekeeper answered card with Override→steer"
```

---

### Task 14: `ContextPanel` — Jarvis header, autonomy explainer, fleet counts

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`ContextPanel`, current lines ~533-575)

- [ ] **Step 1: Replace `ContextPanel`**

Replace the current `ContextPanel` with (keeps the existing worker list + asking + project sections; adds the Jarvis header, autonomy explainer, and fleet counts):

```tsx
// The right context panel: a Jarvis "fleet manager" header, the per-channel autonomy explainer keyed to
// the active tier, and the fleet dispatched here with working/waiting counts, the ones blocked on you,
// and the bound project. Auto-hides below ~1040px pane width so it never steals the message column.
function ContextPanel({
    model,
    channel,
    agents,
}: {
    model: AgentsViewModel;
    channel: Channel | null;
    agents: AgentVM[];
}) {
    const snapshot = channel ? buildFleetSnapshot(channel, agents) : [];
    const asking = snapshot.filter((w) => w.state === "asking");
    const counts = fleetCounts(snapshot);
    const tier = tierFromMeta(channel?.meta as Record<string, unknown> | undefined);
    const explainer = autonomyExplainer(tier);
    const label = "mb-2 font-mono text-[9px] uppercase tracking-[.09em] text-muted";
    return (
        <aside className="hidden w-[248px] flex-none flex-col overflow-y-auto border-l border-border bg-background px-4 py-4 @[1040px]:flex">
            <div className="mb-4 flex items-center gap-2.5">
                <Avatar name="jarvis" />
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold text-primary">Jarvis</div>
                    <div className="font-mono text-[10.5px] text-muted">Fleet manager</div>
                </div>
                <span className="flex items-center gap-1 font-mono text-[10px] text-success">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" /> live
                </span>
            </div>

            <div className={label}>Autonomy in #{channel?.name ?? "channel"}</div>
            <div className="mb-5 rounded-[9px] border border-accent/25 bg-accentbg/20 px-3 py-2.5">
                <p className="mb-2.5 text-[11.5px] leading-[1.5] text-secondary">{explainer.blurb}</p>
                <div className="flex flex-col gap-1.5">
                    {explainer.checklist.map((c) => (
                        <div key={c.label} className="flex items-center gap-2">
                            <span className={c.active ? "text-success" : "text-edge-strong"}>
                                {c.active ? "✓" : "–"}
                            </span>
                            <span className={c.active ? "text-[11.5px] text-secondary" : "text-[11.5px] text-muted"}>
                                {c.label}
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            <div className={label}>
                Fleet here · {counts.working} working · {counts.waiting} waiting
            </div>
            {snapshot.length === 0 ? (
                <p className="text-[11.5px] text-muted">No workers dispatched here yet.</p>
            ) : (
                snapshot.map((w) => <WorkerRow key={w.oref} model={model} w={w} />)
            )}

            {asking.length > 0 ? (
                <>
                    <div className={`${label} mt-5`}>Needs you · {asking.length}</div>
                    <div className="flex flex-col gap-2">
                        {asking.map((w) => (
                            <div
                                key={w.oref}
                                className="rounded-[7px] border border-asking/40 bg-lane-asking px-2.5 py-2 text-[11px] leading-[1.45] text-secondary"
                            >
                                <span className="font-mono text-accent-soft">{w.name}</span>
                                {w.askText ? ` — ${w.askText}` : ""}
                            </div>
                        ))}
                    </div>
                </>
            ) : null}

            <div className={`${label} mt-5`}>Project</div>
            <div className="break-all font-mono text-[11px] text-muted">{channel?.projectpath || "—"}</div>
        </aside>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(channels): Jarvis fleet-manager panel with autonomy explainer + counts"
```

---

### Task 15: Rail tier chips + unread badges

**Files:**
- Modify: `frontend/app/view/agents/channelrail.tsx`

- [ ] **Step 1: Add imports + render chip and badge**

At the top of `channelrail.tsx`, add:

```tsx
import { tierFromMeta } from "./channelmessages";
import { tierChip, unreadCount, READ_TS_META } from "./jarviscards";
```

Then inside the channel `.map((c) => { ... })`, compute per-channel values and render the tier chip (always) and an unread badge (when > 0). Replace the button's inner content (the `#`, name, and ask-dot block, lines ~57-78) with:

```tsx
                    const active = c.oid === activeId;
                    const tier = tierFromMeta(c.meta as Record<string, unknown> | undefined);
                    const chip = tierChip(tier);
                    const unread = unreadCount(c.messages, c.meta?.[READ_TS_META] as number | undefined);
                    return (
                        <button
                            key={c.oid}
                            type="button"
                            onClick={() => onSelect(c.oid)}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left",
                                active ? "bg-accentbg" : "hover:bg-surface-hover"
                            )}
                        >
                            <span
                                className={cn(
                                    "font-mono text-[13px] font-semibold",
                                    active ? "text-accent" : "text-muted"
                                )}
                            >
                                #
                            </span>
                            <span
                                className={cn(
                                    "flex-1 truncate text-[13px]",
                                    active ? "font-semibold text-primary" : "font-medium text-ink-mid"
                                )}
                            >
                                {c.name}
                            </span>
                            {unread > 0 ? (
                                <span className="flex-none rounded-full bg-asking px-1.5 py-px font-mono text-[9px] font-semibold text-background">
                                    {unread}
                                </span>
                            ) : null}
                            {channelHasAsk(c, agents) ? (
                                <span
                                    title="an agent here needs you"
                                    className="h-2 w-2 flex-none rounded-full bg-asking"
                                />
                            ) : null}
                            <span
                                title={`autonomy: ${tier}`}
                                className="flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border border-edge-mid bg-surface-raised font-mono text-[9px] font-bold text-ink-mid"
                            >
                                {chip}
                            </span>
                        </button>
                    );
```

Also add the `AUTONOMY` column header: change the "Channels" header block (lines 40-44) to a flex row:

```tsx
                <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                        Channels
                    </span>
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.06em] text-muted">
                        autonomy
                    </span>
                </div>
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors. (`Channel` has `.messages`, `.meta`, `.name`, `.oid` per `gotypes.d.ts`.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/channelrail.tsx
git commit -m "feat(channels): rail tier chips + unread badges"
```

---

### Task 16: Composer tier-aware placeholder + Jarvis avatar glyph

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`Avatar` ~lines 78-87; `ChannelsSurface` composer placeholder ~line 739)

- [ ] **Step 1: Give Jarvis a diamond glyph in `Avatar`**

Replace `Avatar` (lines 78-87) with:

```tsx
// 32px rounded avatar. Jarvis (the manager) gets a diamond glyph on an accent gradient; everyone else
// gets their name's initial, colored deterministically.
function Avatar({ name }: { name: string }) {
    if (name.toLowerCase() === "jarvis") {
        return (
            <div className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] bg-accent">
                <span className="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-background" />
            </div>
        );
    }
    return (
        <div
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] font-mono text-[13px] font-bold text-background"
            style={{ backgroundColor: avatarColor(name) }}
        >
            {(name.charAt(0) || "?").toUpperCase()}
        </div>
    );
}
```

- [ ] **Step 2: Make the composer placeholder tier-aware**

In `ChannelsSurface`, the `askHint`/placeholder is built ~line 602/739. Add a tier-aware prefix. After the `tier` value is computed (it already is: `const tier = tierFromMeta(...)`), change the `<Composer ... placeholder=...>` prop (~line 739) to:

```tsx
                    placeholder={
                        tier === "gatekeeper"
                            ? `Message #${active?.name ?? "channel"} — Jarvis is handling routine questions`
                            : tier === "delegator"
                              ? `Message #${active?.name ?? "channel"} — @jarvis <goal> to dispatch workers`
                              : `Message #${active?.name ?? "channel"}…${askHint} · @jarvis to summarize`
                    }
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(channels): Jarvis diamond avatar + tier-aware composer placeholder"
```

---

## Phase 5 — Verification

### Task 17: Full verification + CDP visual check

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 pre-existing `frontend/tauri/api.test.ts` baseline errors.

- [ ] **Step 2: Full unit suites**

Run: `npx vitest run frontend/app/view/agents/ && go test ./pkg/jarvis/ ./pkg/wstore/`
Expected: all PASS.

- [ ] **Step 3: Rebuild backend for the live app**

Run: `task build:backend`
Expected: builds `wavesrv` + `wsh` into `dist/bin/`.

- [ ] **Step 4: CDP visual verification**

With the dev app running (`tail -f /dev/null | task dev`), drive Channels over CDP (see `scripts/cdp-e2e.mjs`) and screenshot:
- Rail shows per-channel tier chip (C/G/D) + an unread badge on a channel with new messages; selecting it clears the badge.
- A gatekeeper auto-answer renders the rich card (worker asked → Jarvis chose → reason → resumed footer → Override); clicking Override reveals options and steering posts a directive.
- An escalation renders clickable options; picking one shows the resolved footer.
- Right panel shows the Jarvis header, the autonomy explainer matching the active tier, and `N working · M waiting`.
- Composer placeholder changes with the tier; Jarvis rows show the diamond avatar.

Compare against `C:/Users/kael02/Downloads/wave-handoff (9)/wave/project/Wave-jarvis.dc.html` (open in Chrome to screenshot the reference).

- [ ] **Step 5: Confirm repo state**

Run: `git status --short`
Expected: clean (all work committed across the phase commits above).

---

## Self-Review notes (author)

- **Spec coverage:** all four approved groups are covered — Gatekeeper card (Tasks 2/3/13), escalation options (Tasks 3/11/12), right panel (Tasks 8/14), rail+composer (Tasks 4/10/15/16); data carrier (Task 1); Override→steer (Task 9/13); lightweight unread (Tasks 4/6/10/15); Attach omitted per decision.
- **Type consistency:** `JarvisCardData` fields (`askORef`, `workerORef`, `question`, `options[{label,sub}]`, `choice?`, `reason?`) are identical in Go (`cards.go`) and TS (`jarviscards.ts`). `AnswerAgentCommand({oref, answers})` with `AgentAnswerItem.selectedindexes` verified against generated types.
- **Known follow-ups (out of scope):** attachments; unread read-receipt across devices; escalation card does not currently re-render to "resolved" if the ask is answered from the cockpit AnswerBar instead (both resolve the same ask server-side; the escalation card just keeps showing options until reload — acceptable for v1).
