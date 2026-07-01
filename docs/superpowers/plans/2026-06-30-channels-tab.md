# Channels Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `channels` cockpit surface as a conversational agent-dispatch surface — type a message, `@<runtime>` spawns a brand-new worker, `@<name>` steers a live one, asks/status surface inline — persisted as an addressable `waveobj` so a future orchestrator can attach to it.

**Architecture:** A `Channel` is a `waveobj` (id + `Messages []ChannelMessage`) persisted in SQLite via `wstore`; appends broadcast through the existing `Event_WaveObjUpdate` / WOS pinning path (no custom event, no migration). Three new wshrpc commands (`CreateChannel`, `GetChannels`, `PostChannelMessage`) are the human's — and the future manager's — verb surface; steering reuses `ControllerInputCommand` and answering reuses `AnswerAgentCommand`. Dispatched workers become normal roster `AgentVM` rows, so the dispatch row shows a live status pill and an ask row reuses `AnswerBar` — nothing about live progress is duplicated from Cockpit.

**Tech Stack:** Go (waveobj/wstore, wshrpc), `task generate` codegen, React 19 + jotai + Tailwind v4 (@theme tokens), vitest.

**Spec:** `docs/superpowers/specs/2026-06-30-channels-tab-design.md`
**Roadmap (why the verb-as-command / channel-as-object constraints):** `docs/orchestrator-roadmap.md`

---

## Conventions & gotchas (read once)

- **Never hand-edit generated files.** `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, and `pkg/wshrpc/wshclient/wshclient.go` come from `task generate`. Edit the Go source, regenerate.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo). Baseline has 3 pre-existing `frontend/tauri/api.test.ts` errors — those are expected, anything else is yours.
- **No SCSS, no hardcoded colors.** Use the @theme utility classes already used by `activitysurface.tsx` (`bg-surface`, `border-border`, `text-primary`, `text-secondary`, `text-muted`, `text-ink-mid`, `border-accent`, `bg-accentbg`, `text-accent-soft`, `border-edge-strong`, `bg-surface-hover`, `text-asking`).
- **Coordination note:** Tasks 6 edits `cockpitshell.tsx` + `placeholdersurface.tsx`, which the in-flight Sessions tab also edits. Trivial 2-line merges; rebase on top of Sessions if it landed first.
- **Adding a wshrpc command requires only:** the interface line + `Command*Data`/`Command*RtnData` structs in `pkg/wshrpc/wshrpctypes.go`, and the server method in `pkg/wshrpc/wshserver/wshserver.go`. Dispatch is reflection-driven; clients regenerate.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `pkg/waveobj/wtype.go` | `Channel` waveobj type + `ChannelMessage` struct + OType registration | Modify |
| `pkg/wstore/wstore_channel.go` | `CreateChannel` / `GetChannels` / `PostChannelMessage` (+ pure `NewChannelMessage`) | Create |
| `pkg/wstore/wstore_channel_test.go` | unit test the pure message builder/appender | Create |
| `pkg/wshrpc/wshrpctypes.go` | 3 interface lines + Command data/rtn structs | Modify |
| `pkg/wshrpc/wshserver/wshserver.go` | 3 command implementations (call wstore + `wcore.SendWaveObjUpdate`) | Modify |
| `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go` | generated bindings | Regenerated (`task generate`) |
| `frontend/app/view/agents/channelmessages.ts` | pure `parseMentions` + `planMessage` (routing decision) | Create |
| `frontend/app/view/agents/channelmessages.test.ts` | vitest for the pure helpers | Create |
| `frontend/app/view/agents/channelsstore.ts` | channel-list atom + active-channel pin + loaders | Create |
| `frontend/app/cockpit/cockpit-actions.ts` | `launchAgent` returns the new `tabId` | Modify |
| `frontend/app/view/agents/channelactions.ts` | impure `sendChannelMessage` (dispatch / steer / post) | Create |
| `frontend/app/view/agents/channelssurface.tsx` | the surface: switcher + timeline + composer | Create |
| `frontend/app/view/agents/cockpitshell.tsx` | render `ChannelsSurface` for `surface === "channels"` | Modify |
| `frontend/app/view/agents/placeholdersurface.tsx` | drop the now-unused `channels` title | Modify |

---

## Task 1: `Channel` waveobj type + pure message helpers

Define the persisted object and the pure (DB-free) message construction/append logic. The pure helpers are unit-tested here; the DB wrappers (Task 2) are thin.

**Files:**
- Modify: `pkg/waveobj/wtype.go`
- Create: `pkg/wstore/wstore_channel.go`
- Test: `pkg/wstore/wstore_channel_test.go`

- [ ] **Step 1: Define the `Channel` type + `ChannelMessage` struct**

In `pkg/waveobj/wtype.go`, find the OType constants block (the `const (` group containing `OType_Tab = "tab"`) and add a constant:
```go
	OType_Channel = "channel"
```

Find the `ValidOTypes` map (entries like `OType_Tab: true,`) and add:
```go
	OType_Channel: true,
```

Find `AllWaveObjTypes()` (returns a slice of `reflect.TypeOf(&Tab{})`, etc.) and add to the returned slice:
```go
		reflect.TypeOf(&Channel{}),
```

Then add the type definitions near the other waveobj types (after the `Tab` struct):
```go
// ChannelMessage is one entry in a Channel's append-only log. Kind is "human" (typed by the user),
// "directive" (a steer sent to a live worker), or "dispatch" (a worker was spawned). RefORef points
// at the related object when there is one: "tab:<id>" for a dispatch/directive target. Asks and live
// status are NOT stored here — they render from the live roster (see the Channels surface).
type ChannelMessage struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Author  string `json:"author"`            // "you" | runtime | worker name
	Text    string `json:"text"`
	RefORef string `json:"reforef,omitempty"` // related object oref, e.g. "tab:<id>"
	Ts      int64  `json:"ts"`                // UnixMilli
}

type Channel struct {
	OID         string           `json:"oid"`
	Version     int              `json:"version"`
	Name        string           `json:"name"`
	ProjectPath string           `json:"projectpath,omitempty"` // binds dispatches to a repo; "" = unbound
	CreatedTs   int64            `json:"createdts"`
	Messages    []ChannelMessage `json:"messages,omitempty"`
	Meta        MetaMapType      `json:"meta"`
}

func (*Channel) GetOType() string {
	return OType_Channel
}
```

- [ ] **Step 2: Write the failing test for the pure helpers**

Create `pkg/wstore/wstore_channel_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestNewChannelMessage_setsFieldsAndId(t *testing.T) {
	m := NewChannelMessage("dispatch", "codex", "build the auth refactor", "tab:abc", 1717000000000)
	if m.ID == "" {
		t.Fatalf("expected a generated ID")
	}
	if m.Kind != "dispatch" || m.Author != "codex" || m.Text != "build the auth refactor" {
		t.Errorf("unexpected message: %+v", m)
	}
	if m.RefORef != "tab:abc" || m.Ts != 1717000000000 {
		t.Errorf("unexpected ref/ts: %+v", m)
	}
}

func TestAppendChannelMessage_appendsInOrder(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1"}
	appendChannelMessage(ch, NewChannelMessage("human", "you", "first", "", 1))
	appendChannelMessage(ch, NewChannelMessage("human", "you", "second", "", 2))
	if len(ch.Messages) != 2 {
		t.Fatalf("want 2 messages, got %d", len(ch.Messages))
	}
	if ch.Messages[0].Text != "first" || ch.Messages[1].Text != "second" {
		t.Errorf("wrong order: %+v", ch.Messages)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails to compile**

Run: `go test ./pkg/wstore/ -run TestNewChannelMessage`
Expected: FAIL — `undefined: NewChannelMessage`, `undefined: appendChannelMessage`.

- [ ] **Step 4: Implement the channel store file with the pure helpers**

Create `pkg/wstore/wstore_channel.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// NewChannelMessage builds a log entry with a fresh id. Pure (no DB) so it is unit-testable.
func NewChannelMessage(kind, author, text, refORef string, ts int64) waveobj.ChannelMessage {
	return waveobj.ChannelMessage{
		ID:      uuid.NewString(),
		Kind:    kind,
		Author:  author,
		Text:    text,
		RefORef: refORef,
		Ts:      ts,
	}
}

// appendChannelMessage mutates the channel's log. Pure; the DB write is in PostChannelMessage.
func appendChannelMessage(ch *waveobj.Channel, msg waveobj.ChannelMessage) {
	ch.Messages = append(ch.Messages, msg)
}

// CreateChannel persists a new channel bound to projectPath ("" = unbound).
func CreateChannel(ctx context.Context, name, projectPath string) (*waveobj.Channel, error) {
	ch := &waveobj.Channel{
		OID:         uuid.NewString(),
		Name:        name,
		ProjectPath: projectPath,
		CreatedTs:   time.Now().UnixMilli(),
		Meta:        make(waveobj.MetaMapType),
	}
	if err := DBInsert(ctx, ch); err != nil {
		return nil, err
	}
	return ch, nil
}

// GetChannels lists all channels (newest-first by creation).
func GetChannels(ctx context.Context) ([]*waveobj.Channel, error) {
	chans, err := DBGetAllObjsByType[*waveobj.Channel](ctx, waveobj.OType_Channel)
	if err != nil {
		return nil, err
	}
	return chans, nil
}

// PostChannelMessage appends a message to a channel and returns the stored message. The caller
// publishes the WaveObjUpdate so the pinned frontend atom live-updates.
func PostChannelMessage(ctx context.Context, channelId string, msg waveobj.ChannelMessage) (*waveobj.ChannelMessage, error) {
	err := DBUpdateFnErr(ctx, channelId, func(ch *waveobj.Channel) error {
		appendChannelMessage(ch, msg)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &msg, nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/wstore/ -run "TestNewChannelMessage|TestAppendChannelMessage"`
Expected: PASS.

- [ ] **Step 6: Build the whole backend to confirm registration compiles**

Run: `go build ./pkg/...`
Expected: no errors. (If `DBUpdateFnErr` has a different signature than `func(ctx, id, func(*T) error) error`, fix the call to match — grep `func DBUpdateFnErr` in `pkg/wstore/wstore_dbops.go`.)

- [ ] **Step 7: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/wstore/wstore_channel.go pkg/wstore/wstore_channel_test.go
git commit -m "feat(channels): Channel waveobj + persisted message log"
```

---

## Task 2: wshrpc commands + codegen

Expose `CreateChannel` / `GetChannels` / `PostChannelMessage` over wshrpc. These are the verb-as-command surface (the future manager calls the same ones).

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerated: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`

- [ ] **Step 1: Add the interface lines**

In `pkg/wshrpc/wshrpctypes.go`, in the `WshRpcInterface` interface (near `GetRecentSessionsCommand` at line 99), add:
```go
	CreateChannelCommand(ctx context.Context, data CommandCreateChannelData) (*waveobj.Channel, error)
	GetChannelsCommand(ctx context.Context) (*CommandGetChannelsRtnData, error)
	PostChannelMessageCommand(ctx context.Context, data CommandPostChannelMessageData) (*waveobj.ChannelMessage, error)
```
(`waveobj` is already imported in this file — it's used by other commands.)

- [ ] **Step 2: Add the command data structs**

In `pkg/wshrpc/wshrpctypes.go`, near the `CommandGetRecentSessions*` structs (line ~667), add:
```go
type CommandCreateChannelData struct {
	Name        string `json:"name"`
	ProjectPath string `json:"projectpath,omitempty"`
}

type CommandGetChannelsRtnData struct {
	Channels []*waveobj.Channel `json:"channels"`
}

type CommandPostChannelMessageData struct {
	ChannelId string `json:"channelid"`
	Kind      string `json:"kind"`
	Author    string `json:"author"`
	Text      string `json:"text"`
	RefORef   string `json:"reforef,omitempty"`
}
```

- [ ] **Step 3: Implement the three commands**

In `pkg/wshrpc/wshserver/wshserver.go`, near `GetRecentSessionsCommand` (line ~1490), add. Confirm the file already imports `wstore` and `wcore`; if not, add `"github.com/wavetermdev/waveterm/pkg/wstore"` and `"github.com/wavetermdev/waveterm/pkg/wcore"` to the import block.
```go
func (ws *WshServer) CreateChannelCommand(ctx context.Context, data wshrpc.CommandCreateChannelData) (*waveobj.Channel, error) {
	ch, err := wstore.CreateChannel(ctx, data.Name, data.ProjectPath)
	if err != nil {
		return nil, fmt.Errorf("creating channel: %w", err)
	}
	return ch, nil
}

func (ws *WshServer) GetChannelsCommand(ctx context.Context) (*wshrpc.CommandGetChannelsRtnData, error) {
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing channels: %w", err)
	}
	return &wshrpc.CommandGetChannelsRtnData{Channels: chans}, nil
}

func (ws *WshServer) PostChannelMessageCommand(ctx context.Context, data wshrpc.CommandPostChannelMessageData) (*waveobj.ChannelMessage, error) {
	msg := wstore.NewChannelMessage(data.Kind, data.Author, data.Text, data.RefORef, time.Now().UnixMilli())
	stored, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg)
	if err != nil {
		return nil, fmt.Errorf("posting channel message: %w", err)
	}
	// live-update the pinned frontend channel atom via the existing waveobj:update path
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return stored, nil
}
```
(If `time` is not yet imported in `wshserver.go`, add `"time"`.)

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: success.

- [ ] **Step 5: Verify the generated types exist**

Run: `grep -n "PostChannelMessageCommand" frontend/app/store/wshclientapi.ts && grep -n "type Channel = " frontend/types/gotypes.d.ts && grep -n "type ChannelMessage = " frontend/types/gotypes.d.ts`
Expected: a client method line, plus `Channel` and `ChannelMessage` TS types (the latter with `messages?: ChannelMessage[];`).

- [ ] **Step 6: Build the backend**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
git commit -m "feat(channels): wshrpc create/list/post commands"
```

---

## Task 3: Pure message parsing + routing decision

Two pure functions: `parseMentions` (split `@tokens` from body) and `planMessage` (decide dispatch vs steer vs post). Unit-tested with no React/RPC.

**Files:**
- Create: `frontend/app/view/agents/channelmessages.ts`
- Test: `frontend/app/view/agents/channelmessages.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/channelmessages.test.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseMentions, planMessage } from "./channelmessages";

describe("parseMentions", () => {
    it("returns no mentions for plain text", () => {
        expect(parseMentions("hello there")).toEqual({ mentions: [], body: "hello there" });
    });
    it("extracts leading mentions and strips them from the body", () => {
        expect(parseMentions("@codex build the auth refactor")).toEqual({
            mentions: ["codex"],
            body: "build the auth refactor",
        });
    });
    it("lowercases mentions and keeps interior text intact", () => {
        expect(parseMentions("@API-Auth do the thing")).toEqual({ mentions: ["api-auth"], body: "do the thing" });
    });
});

const roster = [
    { id: "t1", name: "api-auth", blockId: "b1" },
    { id: "t2", name: "web", blockId: "b2" },
];

describe("planMessage", () => {
    it("plans a dispatch when the mention is a known runtime", () => {
        expect(planMessage("@codex build it", roster)).toEqual({
            kind: "dispatch",
            runtime: "codex",
            text: "build it",
        });
    });
    it("plans a steer when the mention is a live worker name", () => {
        expect(planMessage("@api-auth run the tests", roster)).toEqual({
            kind: "steer",
            targetId: "t1",
            blockId: "b1",
            text: "run the tests",
        });
    });
    it("plans a plain post when there is no actionable mention", () => {
        expect(planMessage("just a note", roster)).toEqual({ kind: "post", text: "just a note" });
    });
    it("treats an unknown mention as a plain post (kept verbatim)", () => {
        expect(planMessage("@nobody hi", roster)).toEqual({ kind: "post", text: "@nobody hi" });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts`
Expected: FAIL — cannot resolve `./channelmessages`.

- [ ] **Step 3: Implement the pure helpers**

Create `frontend/app/view/agents/channelmessages.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure parsing for the Channels composer. `parseMentions` splits leading @tokens from the message
// body; `planMessage` decides what a send means: @<runtime> -> dispatch a new worker, @<live name>
// -> steer that worker's PTY, otherwise -> post a plain message. No React, no RPC — unit-testable.

import type { Runtime } from "./launch";

const RUNTIMES: Runtime[] = ["claude", "codex", "antigravity", "terminal"];

export interface ParsedMentions {
    mentions: string[]; // lowercased, in order
    body: string; // message with leading mentions stripped
}

export function parseMentions(text: string): ParsedMentions {
    const mentions: string[] = [];
    let rest = text.trimStart();
    const re = /^@([\w./-]+)\s+/;
    let m = re.exec(rest);
    while (m) {
        mentions.push(m[1].toLowerCase());
        rest = rest.slice(m[0].length);
        m = re.exec(rest);
    }
    return { mentions, body: rest };
}

export interface RosterEntry {
    id: string; // tabId
    name: string;
    blockId?: string; // terminal block OID — steer target
}

export type MessagePlan =
    | { kind: "dispatch"; runtime: Runtime; text: string }
    | { kind: "steer"; targetId: string; blockId?: string; text: string }
    | { kind: "post"; text: string };

export function planMessage(text: string, roster: RosterEntry[]): MessagePlan {
    const { mentions, body } = parseMentions(text);
    const first = mentions[0];
    if (first && (RUNTIMES as string[]).includes(first)) {
        return { kind: "dispatch", runtime: first as Runtime, text: body };
    }
    if (first) {
        const target = roster.find((r) => r.name.toLowerCase() === first);
        if (target) {
            return { kind: "steer", targetId: target.id, blockId: target.blockId, text: body };
        }
    }
    // no actionable mention -> post the original text verbatim (so an unknown @handle is preserved)
    return { kind: "post", text };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelmessages.ts frontend/app/view/agents/channelmessages.test.ts
git commit -m "feat(channels): pure mention parsing + message routing"
```

---

## Task 4: Channels store (atoms + loaders) and `launchAgent` returning the tabId

The store fetches the channel list, pins the active channel (live message updates via WOS), and exposes loaders. `launchAgent` is changed to return the new `tabId` so a dispatch can record it as `RefORef`.

**Files:**
- Modify: `frontend/app/cockpit/cockpit-actions.ts`
- Create: `frontend/app/view/agents/channelsstore.ts`

- [ ] **Step 1: Make `launchAgent` return the new tabId**

In `frontend/app/cockpit/cockpit-actions.ts`, change the signature `): Promise<void> {` to `): Promise<string> {`, and at the very end of the function (after `globalStore.set(model.surfaceAtom, "agent");`) add:
```ts
    return tabId;
```
(Existing callers ignore the return value, so this is backward-compatible.)

- [ ] **Step 2: Implement the store**

Create `frontend/app/view/agents/channelsstore.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels store: the channel list (channelsAtom), the active channel id, and a pinned WOS atom for
// the active channel so its message log live-updates through the existing waveobj:update path. The
// list is loaded on demand; messages need no separate fetch — they are a field on the pinned object.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";

// null = not loaded yet; [] = loaded-empty.
export const channelsAtom = atom<Channel[] | null>(null) as PrimitiveAtom<Channel[] | null>;
export const activeChannelIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

// The active channel, pinned via WOS so backend appends live-update it. null until an id is set.
export const activeChannelAtom: Atom<Channel | null> = atom((get) => {
    const id = get(activeChannelIdAtom);
    if (!id) {
        return null;
    }
    return get(WOS.getWaveObjectAtom<Channel>(WOS.makeORef("channel", id))) ?? null;
});

let loading = false;

export async function loadChannels(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.GetChannelsCommand(TabRpcClient);
        const list = (rtn.channels ?? []).sort((a, b) => b.createdts - a.createdts);
        globalStore.set(channelsAtom, list);
        // auto-select the newest channel and pin it
        const cur = globalStore.get(activeChannelIdAtom);
        if (!cur && list.length > 0) {
            await selectChannel(list[0].oid);
        }
    } catch {
        globalStore.set(channelsAtom, []);
    } finally {
        loading = false;
    }
}

// Pin the channel object so WOS mirrors its updates into getWaveObjectAtom, then mark it active.
export async function selectChannel(channelId: string): Promise<void> {
    await WOS.loadAndPinWaveObject<Channel>(WOS.makeORef("channel", channelId));
    globalStore.set(activeChannelIdAtom, channelId);
}

export async function createChannel(name: string, projectPath: string): Promise<string> {
    const ch = await RpcApi.CreateChannelCommand(TabRpcClient, { name, projectpath: projectPath });
    await loadChannels();
    await selectChannel(ch.oid);
    return ch.oid;
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3 pre-existing `api.test.ts` ones. (If `WOS.loadAndPinWaveObject`/`getWaveObjectAtom`/`makeORef` are not exported under those names, grep `export` in `frontend/app/store/wos.ts` and use the real names — they are confirmed exported there.)

- [ ] **Step 4: Commit**

```bash
git add frontend/app/cockpit/cockpit-actions.ts frontend/app/view/agents/channelsstore.ts
git commit -m "feat(channels): channels store + launchAgent returns tabId"
```

---

## Task 5: Channel actions (impure send) + the surface

Wire the composer's send to the routing decision, then build the surface (switcher + timeline + composer).

**Files:**
- Create: `frontend/app/view/agents/channelactions.ts`
- Create: `frontend/app/view/agents/channelssurface.tsx`

- [ ] **Step 1: Implement the impure send action**

Create `frontend/app/view/agents/channelactions.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Impure side of the Channels composer: turns a typed message into the right verb-command(s).
// dispatch -> launchAgent (a new worker) + a "dispatch" message; steer -> ControllerInputCommand
// (inject into a live worker's PTY) + a "directive" message; post -> a "human" message. Every branch
// records a channel message so the timeline is the single source of truth (and a manager can replay it).

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stringToBase64 } from "@/util/util";
import type { AgentsViewModel } from "./agents";
import { planMessage, type RosterEntry } from "./channelmessages";
import { runtimeStartupCommand } from "./launch";

async function post(channelId: string, kind: string, author: string, text: string, refORef: string): Promise<void> {
    await RpcApi.PostChannelMessageCommand(TabRpcClient, {
        channelid: channelId,
        kind,
        author,
        text,
        reforef: refORef,
    });
}

export async function sendChannelMessage(args: {
    model: AgentsViewModel;
    channelId: string;
    projectPath: string;
    projectName: string;
    roster: RosterEntry[];
    text: string;
}): Promise<void> {
    const { model, channelId, projectPath, projectName, roster, text } = args;
    const plan = planMessage(text, roster);
    if (plan.kind === "dispatch") {
        const tabId = await launchAgent(model, {
            runtime: plan.runtime,
            startupCommand: runtimeStartupCommand(plan.runtime),
            task: plan.text,
            projectPath,
            projectName: projectName || "agent",
        });
        await post(channelId, "dispatch", plan.runtime, plan.text, `tab:${tabId}`);
        return;
    }
    if (plan.kind === "steer") {
        if (plan.blockId) {
            await RpcApi.ControllerInputCommand(TabRpcClient, {
                blockid: plan.blockId,
                inputdata64: stringToBase64(plan.text + "\r"),
            });
        }
        await post(channelId, "directive", "you", plan.text, `tab:${plan.targetId}`);
        return;
    }
    await post(channelId, "human", "you", plan.text, "");
}
```

- [ ] **Step 2: Build the surface**

Create `frontend/app/view/agents/channelssurface.tsx`:
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels surface: a conversational agent-dispatch surface. Type a message; @<runtime> spawns a new
// worker, @<name> steers a live one, plain text posts a note. Dispatched workers become roster rows,
// so a dispatch row shows a live status pill and an asking worker reuses AnswerBar — Cockpit still owns
// monitoring; this surface only carries the dialogue and links out (↗).

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { AnswerBar } from "./answerbar";
import { toggleSelection, type AgentVM } from "./agentsviewmodel";
import { sendChannelMessage } from "./channelactions";
import type { RosterEntry } from "./channelmessages";
import { activeChannelAtom, activeChannelIdAtom, channelsAtom, createChannel, loadChannels, selectChannel } from "./channelsstore";
import { projectsAtom } from "./projectsstore";

const STATE_DOT: Record<string, string> = {
    working: "var(--color-accent)",
    asking: "var(--color-asking)",
    idle: "var(--color-muted)",
};

// resolve a dispatch/directive RefORef ("tab:<id>") to the live roster row, if still present
function workerFor(agents: AgentVM[], refORef: string): AgentVM | undefined {
    if (!refORef.startsWith("tab:")) {
        return undefined;
    }
    const id = refORef.slice(4);
    return agents.find((a) => a.id === id);
}

function jumpToAgent(model: AgentsViewModel, id: string) {
    globalStore.set(model.focusIdAtom, id);
    globalStore.set(model.terminalTargetAtom, undefined);
    globalStore.set(model.surfaceAtom, "agent");
}

// An asking worker's answer row, reusing the cockpit's AnswerBar + model answer state.
function AskRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const answerSel = useAtomValue(model.answerSelAtom);
    const setAnswerSel = useSetAtom(model.answerSelAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const toggle = (qi: number, oi: number) => {
        const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
        setAnswerSel((prev) => ({ ...prev, [agent.id]: toggleSelection(prev[agent.id] ?? {}, qi, oi, multi) }));
    };
    return (
        <div className="mt-2 rounded-[8px] border border-asking/40 bg-accentbg/40 p-3">
            <div className="mb-1.5 text-[12px] font-semibold text-asking">{agent.name} is asking</div>
            <AnswerBar
                agent={agent}
                selections={answerSel[agent.id] ?? {}}
                sent={sentIds.has(agent.id)}
                numbered
                onToggle={toggle}
                onSubmit={() => model.submitAnswer(agent.id)}
            />
        </div>
    );
}

function Row({ model, agents, msg, now }: { model: AgentsViewModel; agents: AgentVM[]; msg: ChannelMessage; now: number }) {
    const worker = msg.reforef ? workerFor(agents, msg.reforef) : undefined;
    const isDispatch = msg.kind === "dispatch";
    return (
        <div className="border-b border-edge-faint px-1 py-3 last:border-b-0">
            <div className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] font-semibold text-primary">{msg.author}</span>
                {isDispatch ? (
                    <span className="rounded-[5px] border border-border px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.08em] text-muted">
                        dispatch
                    </span>
                ) : null}
                <span className="ml-auto font-mono text-[10.5px] text-muted">
                    {now - msg.ts < 60_000 ? "now" : new Date(msg.ts).toLocaleTimeString()}
                </span>
            </div>
            <div className="mt-1 text-[13.5px] leading-[1.5] text-secondary">{msg.text || "(empty)"}</div>
            {isDispatch && worker ? (
                <div className="mt-1.5 flex items-center gap-2">
                    <span className="h-[8px] w-[8px] rounded-full" style={{ backgroundColor: STATE_DOT[worker.state] ?? "var(--color-muted)" }} />
                    <span className="font-mono text-[10.5px] text-muted">{worker.state}</span>
                    <button
                        type="button"
                        onClick={() => jumpToAgent(model, worker.id)}
                        className="cursor-pointer font-mono text-[10.5px] text-ink-mid hover:text-accent-soft"
                    >
                        open ↗
                    </button>
                </div>
            ) : null}
            {isDispatch && worker && worker.state === "asking" ? <AskRow model={model} agent={worker} /> : null}
        </div>
    );
}

export function ChannelsSurface({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const activeId = useAtomValue(activeChannelIdAtom);
    const active = useAtomValue(activeChannelAtom);
    const agents = useAtomValue(model.agentsAtom);
    const now = useAtomValue(model.nowAtom);
    const projects = useAtomValue(projectsAtom); // Record<string, { path?: string }>
    const [draft, setDraft] = useState("");
    const [picking, setPicking] = useState(false);
    useEffect(() => {
        fireAndForget(loadChannels);
    }, []);

    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));
    const messages = active?.messages ?? [];

    const send = () => {
        const text = draft.trim();
        if (!text || !activeId) {
            return;
        }
        setDraft("");
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: activeId,
                projectPath: active?.projectpath ?? "",
                projectName: active?.name ?? "agent",
                roster,
                text,
            })
        );
    };

    // A channel is bound to a project at creation, so every dispatch has a valid cwd (no unbound state).
    const pickProject = (name: string, path: string) => {
        setPicking(false);
        fireAndForget(async () => {
            await createChannel(name, path);
        });
    };

    return (
        <div className="absolute inset-0 flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-[30px] py-3">
                <h1 className="text-[18px] font-bold tracking-[-0.02em] text-primary">Channels</h1>
                <div className="ml-3 flex flex-wrap gap-1.5">
                    {(channels ?? []).map((c) => (
                        <button
                            key={c.oid}
                            type="button"
                            onClick={() => fireAndForget(() => selectChannel(c.oid))}
                            className={cn(
                                "cursor-pointer rounded-[7px] border px-[11px] py-[5px] text-[12px] font-medium",
                                c.oid === activeId
                                    ? "border-accent bg-accentbg text-accent-soft"
                                    : "border-border bg-surface text-ink-mid hover:border-edge-strong"
                            )}
                        >
                            {c.name}
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={() => setPicking((p) => !p)}
                        className="cursor-pointer rounded-[7px] border border-border bg-surface px-[11px] py-[5px] text-[12px] font-medium text-ink-mid hover:border-accent"
                    >
                        + New
                    </button>
                </div>
            </div>

            {picking ? (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-[30px] py-2.5">
                    <span className="text-[11px] text-muted">New channel in project:</span>
                    {Object.entries(projects).map(([name, p]) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => pickProject(name, p?.path ?? "")}
                            className="cursor-pointer rounded-[7px] border border-border bg-surface px-[11px] py-[5px] text-[12px] font-medium text-ink-mid hover:border-accent"
                        >
                            {name}
                        </button>
                    ))}
                    {Object.keys(projects).length === 0 ? (
                        <span className="text-[11px] text-muted">No projects registered — add one from the Cockpit “+ New project”.</span>
                    ) : null}
                </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto px-[30px] py-4">
                <div className="mx-auto max-w-[820px]">
                    {channels == null ? (
                        <div className="mt-10 text-center text-[13px] text-muted">Loading…</div>
                    ) : !activeId ? (
                        <div className="mt-10 text-center text-[13px] text-muted">
                            No channel yet — click <span className="text-secondary">+ New</span> to create one bound to a project.
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="mt-10 text-center text-[13px] text-muted">
                            Empty channel. Try <span className="font-mono text-secondary">@claude do something</span>.
                        </div>
                    ) : (
                        messages.map((m) => <Row key={m.id} model={model} agents={agents} msg={m} now={now} />)
                    )}
                </div>
            </div>

            <div className="border-t border-border px-[30px] py-3">
                <div className="mx-auto flex max-w-[820px] items-end gap-2">
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                send();
                            }
                        }}
                        rows={1}
                        placeholder="Message, or @claude / @codex to dispatch, @worker to steer…"
                        disabled={!activeId}
                        className="min-h-[38px] flex-1 resize-none rounded-[9px] border border-border bg-surface px-[13px] py-[9px] text-[13px] text-primary placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                    />
                    <button
                        type="button"
                        onClick={send}
                        disabled={!activeId}
                        className="shrink-0 cursor-pointer rounded-[8px] border border-accent bg-accentbg px-[15px] py-[9px] text-[12.5px] font-semibold text-accent-soft hover:brightness-110 disabled:opacity-50"
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3 pre-existing `api.test.ts` ones. (If `toggleSelection` is not exported from `agentsviewmodel.ts`, confirm via `grep "export function toggleSelection" frontend/app/view/agents/agentsviewmodel.ts` — it is used by `cockpitsurface.tsx`. If `stringToBase64` import path differs, grep its export in `frontend/util/util.ts`.)

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/channelactions.ts frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(channels): dispatch/steer/post actions + the surface view"
```

---

## Task 6: Wire the surface into the cockpit shell

**Files:**
- Modify: `frontend/app/view/agents/cockpitshell.tsx`
- Modify: `frontend/app/view/agents/placeholdersurface.tsx`

- [ ] **Step 1: Import and branch in the shell**

In `frontend/app/view/agents/cockpitshell.tsx`, add the import after the `ActivitySurface` import (line 8):
```tsx
import { ChannelsSurface } from "./channelssurface";
```
Then add a branch in the surface switch, before the `activity` branch (so it reads naturally; placement among the else-ifs is functionally irrelevant). Insert between the `agent` branch close and the `activity` branch:
```tsx
                ) : surface === "channels" ? (
                    <ChannelsSurface model={model} />
```
The switch becomes:
```tsx
                ) : surface === "agent" ? (
                    <AgentSurface model={model} tabId={tabId} />
                ) : surface === "channels" ? (
                    <ChannelsSurface model={model} />
                ) : surface === "activity" ? (
                    <ActivitySurface model={model} />
```

- [ ] **Step 2: Drop the now-handled placeholder title**

In `frontend/app/view/agents/placeholdersurface.tsx`, remove the `channels` entry from `TITLES`:
```tsx
const TITLES: Record<string, string> = {
    sessions: "Sessions",
    files: "Files",
    memory: "Memory",
};
```
(If the Sessions tab already removed `sessions`, leave its removal as-is and only remove `channels`.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3 pre-existing `api.test.ts` ones.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/cockpitshell.tsx frontend/app/view/agents/placeholdersurface.tsx
git commit -m "feat(channels): wire Channels surface into the NavRail"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Go tests**

Run: `go test ./pkg/wstore/ ./pkg/wshrpc/...`
Expected: PASS (incl. the new `wstore_channel_test.go`).

- [ ] **Step 2: Go build**

Run: `go build ./pkg/... ./cmd/...`
Expected: no errors.

- [ ] **Step 3: Frontend unit tests**

Run: `npx vitest run`
Expected: PASS (existing suite + the new `channelmessages.test.ts`).

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` errors.

- [ ] **Step 5: CDP visual verification (live dev app)**

Start the dev app keeping wavesrv's stdin alive (a closed stdin makes wavesrv exit on EOF): `tail -f /dev/null | task dev`. Then over CDP on `:9222` (`node scripts/cdp-shot.mjs channels.png`, `Runtime.evaluate` to drive):
- Open the **Channels** NavRail item; click **+ New** and pick a registered project; confirm the channel appears in the switcher and persists.
- Send `@claude <task>` → a new agent tab is created (visible on Cockpit), and a **dispatch** row appears with a live status dot + `open ↗`. Click `open ↗` → focuses that agent on the Agent surface.
- When that worker asks, confirm an **ask row** renders inline and answering it (click an option) clears the ask (reuses `AnswerAgentCommand`).
- With a live worker named `<name>`, send `@<name> <text>` → confirm the text is injected into that worker's PTY (its terminal shows the input) and a **directive** row is recorded.
- Reload check: the message log survives a backend round-trip (it is persisted on the `Channel` waveobj).

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(channels): verification fixups"
```

---

## Notes for the executor

- **Verb-as-command / channel-as-object are deliberate** (see `docs/orchestrator-roadmap.md`): keep every send going through `PostChannelMessageCommand` and keep the channel a persisted `waveobj`. A future manager attaches to a channel by id and calls the same commands — do not shortcut the message log with surface-local state.
- **v1 boundary:** the dispatch *spawn* runs in the frontend (`launchAgent` is a FE function that creates the tab). A fully server-side spawn (what a headless manager needs) is intentionally deferred to the orchestrator phase. Steering is already a backend command (`ControllerInputCommand`).
- **No new event/migration:** live message updates ride the existing `waveobj:update` path via `wcore.SendWaveObjUpdate` + WOS pinning. Per-append JSON rewrite is acceptable at coordination-channel volume; high-volume append is a deferred concern (a dedicated message table) — see the spec's Deferred section.
- **Asks/status are not stored** — they render from the live roster (`getAgentAskAtom` is unnecessary here because dispatched workers are `AgentVM` rows carrying `.ask`; the surface reuses `AnswerBar` + `model.submitAnswer`). Diff stats (+adds/−dels) on dispatch rows stay deferred.
- **No SCSS, no hardcoded colors**; only the @theme utilities listed in Conventions.
- **Two deliberate simplifications of the spec (flagged for the user):**
  1. **Bind-at-creation, not unbound-then-pop-launcher.** The spec allowed unbound channels whose first dispatch pops the New Agent launcher pre-filled. That needs modal-prefill surgery + an UpdateChannel-to-bind. v1 instead binds a project at creation (the `+ New` project picker), so every dispatch has a valid cwd and there is no unbound error branch. Simpler, removes a whole edge case.
  2. **No worktree-by-default for dispatched workers (deferred).** The spec wanted each dispatch in a fresh worktree (parallel-safe). `launchAgent` only creates a worktree when given a `branch`, and a unique branch needs the repo's branch list (a git round-trip + `deriveBranch`). v1 launches the worker directly in the channel's project dir; **parallel dispatches into the same project share a working tree** (footgun if you run two writers at once). To add worktree-by-default later: fetch branch names, `deriveBranch(projectName, names)`, and pass `branch` to `launchAgent` in `sendChannelMessage` (the worktree path is already proven by the New Agent modal).
- **Per the user's git workflow:** fold the spec + this plan into the feature commit series as appropriate and get explicit approval before any push.
```
