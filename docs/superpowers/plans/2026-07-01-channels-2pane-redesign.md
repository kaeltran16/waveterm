# Channels 2-pane Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Channels tab to the handoff's 2-pane Slack-style visual language (left channel rail + avatar'd message stream + card composer), folding in the already-implemented consult streaming timeout fix, in a single final commit.

**Architecture:** Frontend-only. No `Channel` waveobj / wshrpc / Go changes. Two new pure derivations (`avatarColor`, `channelHasAsk`) are unit-tested; the React surface is presentational and verified via CDP on the live dev app (no render-test harness exists). The current `channelssurface.tsx` is rewritten from a single `flex-col` column into a `flex` row of a new `ChannelRail` component + an inline message area.

**Tech Stack:** React 19, jotai, Tailwind 4 (`@theme` tokens), vitest, Go (wavesrv rebuild for the consult fix), Chrome DevTools Protocol for visual verification.

**Commit policy (overrides skill default):** Per the user's git rule, do **NOT** commit per task. All work batches into ONE approval-gated commit in the final task. Each task ends by running its tests/verification, not by committing.

---

## Spec

Design doc: `docs/superpowers/specs/2026-07-01-channels-2pane-redesign-design.md`.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `frontend/tailwindsetup.css` | Add the 6-token avatar identity palette under `@theme` | Modify |
| `frontend/app/view/agents/channelderive.ts` | Pure derivations: `avatarColor(name)`, `channelHasAsk(channel, agents)` | Create |
| `frontend/app/view/agents/channelderive.test.ts` | Unit tests for both derivations | Create |
| `frontend/app/view/agents/channelrail.tsx` | Left 244px pane: search box, channel list with active highlight + attention dot, `+ New channel` + project picker | Create |
| `frontend/app/view/agents/channelssurface.tsx` | Top-level 2-pane container + inline message area (header, avatar'd rows, consult/dispatch/ask, card composer) | Rewrite |
| `pkg/wshrpc/wshserver/wshserver.go`, `pkg/consult/*`, `frontend/app/view/agents/channelactions.ts` | Consult streaming fix (already implemented) | Verify only |

---

### Task 1: Fold in and verify the consult streaming fix

The consult fix is already implemented in the working tree (`channelactions.ts` passes `{ timeout: 130_000 }`; `wshserver.go` debug logging removed; `exec.go`/`consult.go` pty + JSONL parsing). The running dev binary still contains the old debug logging, so the backend must be rebuilt and relaunched, then verified end-to-end. No code changes here — this task makes the live env match source and confirms no regression before the redesign.

**Files:**
- Verify (no edit): `frontend/app/view/agents/channelactions.ts`, `pkg/wshrpc/wshserver/wshserver.go`, `pkg/consult/exec.go`, `pkg/consult/consult.go`

- [ ] **Step 1: Confirm the source is clean (no debug leftovers) and builds**

Run:
```bash
grep -rn "consult-dbg\|truncForLog" pkg/wshrpc/wshserver/wshserver.go || echo "CLEAN"
go build ./pkg/wshrpc/wshserver/ && echo "build OK"
```
Expected: `CLEAN` then `build OK`.

- [ ] **Step 2: Rebuild the backend binary**

Run:
```bash
task build:server --force
```
Expected: builds `dist/bin/wavesrv.x64.exe` with no errors. (`--force` because Task's fingerprint can skip Go rebuilds; the binary must be fresh.)

- [ ] **Step 3: Relaunch the dev app so it respawns wavesrv from the new binary**

Touch the Tauri entry to trigger a `cargo tauri dev` rebuild + relaunch (which respawns wavesrv):
```bash
touch src-tauri/src/main.rs
```
Wait for the app to come back up (CDP responds):
```bash
until curl -s http://localhost:9222/json/version >/dev/null 2>&1; do sleep 2; done; echo "app up"
```
Expected: `app up`. (If the dev app is not running, start it with `tail -f /dev/null | task dev` in the background first.)

- [ ] **Step 4: Verify all three runtimes stream a reply end-to-end (CDP)**

Using the CDP eval helper (`scratchpad/cdp-eval.mjs` pattern: attach to `:9222` page target, `Runtime.evaluate`), navigate to Channels, type `ask @claude @codex @antigravity reply with exactly one word: pong`, click Send, wait ~15s, then read the last consult block:
```bash
node <cdp-eval> '(() => { const t=document.body.innerText; const i=t.lastIndexOf("reply with exactly one word: pong"); return t.slice(i,i+600); })()'
```
Expected: the tail contains `claude … pong`, `codex … pong`, `antigravity … pong` — no `consulting…`, no `consult failed`.

- [ ] **Step 5: No commit** (batched into the final task).

---

### Task 2: Add the avatar identity palette to the theme

Deterministic per-author avatar colors must come from `@theme` tokens (project rule: no raw hex/rgba in code). Add a dedicated 6-color identity palette.

**Files:**
- Modify: `frontend/tailwindsetup.css` (inside the `@theme` block, after the `--color-working: #54c79a;` line at ~line 67)

- [ ] **Step 1: Add the palette tokens**

Insert after the `--color-working: #54c79a;` line:
```css
    /* Channel avatar identity palette (deterministic per author; see channelderive.ts) */
    --color-avatar-1: #7c95ff;
    --color-avatar-2: #54c79a;
    --color-avatar-3: #f0625a;
    --color-avatar-4: #e6b450;
    --color-avatar-5: #c98fe6;
    --color-avatar-6: #9aa3ad;
```

- [ ] **Step 2: Verify the dev server picks up the tokens**

Tailwind 4 `@theme` HMR-reloads. Confirm no CSS build error in the dev output (or run `task check:ts` later in Task 7). No dedicated test for CSS tokens.

- [ ] **Step 3: No commit.**

---

### Task 3: `avatarColor` derivation (TDD)

**Files:**
- Create: `frontend/app/view/agents/channelderive.ts`
- Test: `frontend/app/view/agents/channelderive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/channelderive.test.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { avatarColor, channelHasAsk } from "./channelderive";

describe("avatarColor", () => {
    it("is deterministic for the same name", () => {
        expect(avatarColor("codex")).toBe(avatarColor("codex"));
    });

    it("pins 'you' to the accent token, case-insensitively", () => {
        expect(avatarColor("you")).toBe("var(--color-accent)");
        expect(avatarColor("YOU")).toBe("var(--color-accent)");
    });

    it("returns a palette token for other names", () => {
        const palette = new Set([
            "var(--color-avatar-1)",
            "var(--color-avatar-2)",
            "var(--color-avatar-3)",
            "var(--color-avatar-4)",
            "var(--color-avatar-5)",
            "var(--color-avatar-6)",
        ]);
        expect(palette.has(avatarColor("claude"))).toBe(true);
        expect(palette.has(avatarColor("antigravity"))).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts`
Expected: FAIL — cannot resolve `./channelderive` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `frontend/app/view/agents/channelderive.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for the Channels surface: a deterministic per-author avatar color, and whether a
// channel currently has a dispatched worker waiting on you (drives the rail's attention dot).

import type { AgentVM } from "./agentsviewmodel";

// identity palette tokens (defined in tailwindsetup.css @theme). "you" is pinned to the accent.
const AVATAR_TOKENS = [
    "var(--color-avatar-1)",
    "var(--color-avatar-2)",
    "var(--color-avatar-3)",
    "var(--color-avatar-4)",
    "var(--color-avatar-5)",
    "var(--color-avatar-6)",
];

export function avatarColor(name: string): string {
    if (name.toLowerCase() === "you") {
        return "var(--color-accent)";
    }
    let h = 0;
    for (let i = 0; i < name.length; i++) {
        h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return AVATAR_TOKENS[h % AVATAR_TOKENS.length];
}
```

- [ ] **Step 4: Run test to verify avatarColor passes**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts -t avatarColor`
Expected: the 3 `avatarColor` tests PASS. (`channelHasAsk` tests still fail — added next task.)

- [ ] **Step 5: No commit.**

---

### Task 4: `channelHasAsk` derivation (TDD)

**Files:**
- Modify: `frontend/app/view/agents/channelderive.ts`
- Test: `frontend/app/view/agents/channelderive.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `frontend/app/view/agents/channelderive.test.ts`:
```ts
const agent = (id: string, state: AgentVM["state"]): AgentVM =>
    ({ id, name: id, task: "", state }) as AgentVM;

const chan = (messages: unknown[]): Channel => ({ messages } as unknown as Channel);

describe("channelHasAsk", () => {
    it("is true when a dispatched worker is asking", () => {
        const ch = chan([{ kind: "dispatch", reforef: "tab:a1" }]);
        expect(channelHasAsk(ch, [agent("a1", "asking")])).toBe(true);
    });

    it("is false when the dispatched worker is only working", () => {
        const ch = chan([{ kind: "dispatch", reforef: "tab:a1" }]);
        expect(channelHasAsk(ch, [agent("a1", "working")])).toBe(false);
    });

    it("is false when no dispatch/directive references an asking agent", () => {
        const ch = chan([{ kind: "human", reforef: "" }]);
        expect(channelHasAsk(ch, [agent("a1", "asking")])).toBe(false);
    });

    it("is true via a directive (steer) reference too", () => {
        const ch = chan([{ kind: "directive", reforef: "tab:a2" }]);
        expect(channelHasAsk(ch, [agent("a2", "asking")])).toBe(true);
    });

    it("is false for a channel with no messages", () => {
        expect(channelHasAsk(chan([]), [agent("a1", "asking")])).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify the new tests fail**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts -t channelHasAsk`
Expected: FAIL — `channelHasAsk` is not exported.

- [ ] **Step 3: Add the implementation**

Append to `frontend/app/view/agents/channelderive.ts`:
```ts
// A channel is "waiting on you" when any worker it dispatched (or steered) is currently asking.
// GetChannels returns each channel's messages, so resolve dispatch/directive refORefs ("tab:<id>")
// against the live roster. Presence of any asking agent short-circuits the message scan.
export function channelHasAsk(channel: Channel, agents: AgentVM[]): boolean {
    const askingIds = new Set(agents.filter((a) => a.state === "asking").map((a) => a.id));
    if (askingIds.size === 0) {
        return false;
    }
    for (const m of channel.messages ?? []) {
        if ((m.kind === "dispatch" || m.kind === "directive") && m.reforef?.startsWith("tab:")) {
            if (askingIds.has(m.reforef.slice(4))) {
                return true;
            }
        }
    }
    return false;
}
```

- [ ] **Step 4: Run the full test file**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 5: No commit.**

---

### Task 5: `ChannelRail` component

The left 244px pane. Presentational over existing atoms + the two derivations. No unit test (no render harness); verified in Task 7 via CDP.

**Files:**
- Create: `frontend/app/view/agents/channelrail.tsx`

- [ ] **Step 1: Write the component**

Create `frontend/app/view/agents/channelrail.tsx`:
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Channels left rail: search box (visual for now), the channel list with active highlight and an
// attention dot when a channel has a worker waiting on you, and a "+ New channel" action that opens the
// project picker. Replaces the old top-bar channel pills.

import { cn } from "@/util/util";
import type { AgentVM } from "./agentsviewmodel";
import { channelHasAsk } from "./channelderive";

export function ChannelRail({
    channels,
    activeId,
    agents,
    projects,
    picking,
    onSelect,
    onToggleNew,
    onPickProject,
}: {
    channels: Channel[] | null;
    activeId: string | undefined;
    agents: AgentVM[];
    projects: Record<string, { path?: string }>;
    picking: boolean;
    onSelect: (id: string) => void;
    onToggleNew: () => void;
    onPickProject: (name: string, path: string) => void;
}) {
    return (
        <div className="flex w-[244px] flex-none flex-col border-r border-border bg-surface">
            <div className="border-b border-edge-faint px-3.5 py-3">
                <div className="flex items-center gap-2 rounded-[8px] border border-edge-mid bg-surface-raised px-2.5 py-1.5 text-muted">
                    <span className="h-[11px] w-[11px] rounded-full border-[1.4px] border-current" />
                    <span className="text-[12.5px]">Search channels</span>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
                <div className="px-2 pt-1.5 pb-1">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                        Channels
                    </span>
                </div>
                {(channels ?? []).map((c) => {
                    const active = c.oid === activeId;
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
                            {channelHasAsk(c, agents) ? (
                                <span
                                    title="an agent here needs you"
                                    className="h-2 w-2 flex-none rounded-full bg-asking"
                                />
                            ) : null}
                        </button>
                    );
                })}
                <button
                    type="button"
                    onClick={onToggleNew}
                    className="mt-2 flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-ink-mid hover:bg-surface-hover"
                >
                    <span className="font-mono text-[13px] font-semibold text-muted">+</span>
                    <span className="flex-1 text-[13px] font-medium">New channel</span>
                </button>
                {picking ? (
                    <div className="mt-1 flex flex-col gap-1 px-1.5">
                        {Object.entries(projects).map(([name, p]) => (
                            <button
                                key={name}
                                type="button"
                                onClick={() => onPickProject(name, p?.path ?? "")}
                                className="cursor-pointer truncate rounded-[7px] border border-border bg-surface-raised px-2.5 py-1.5 text-left text-[12px] font-medium text-ink-mid hover:border-accent"
                            >
                                {name}
                            </button>
                        ))}
                        {Object.keys(projects).length === 0 ? (
                            <span className="px-1 text-[11px] text-muted">
                                No projects — add one from the Cockpit “+ New project”.
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors in `channelrail.tsx` (baseline has ~3 pre-existing errors in `frontend/tauri/api.test.ts` only).

- [ ] **Step 3: No commit.**

---

### Task 6: Rewrite `channelssurface.tsx` to the 2-pane layout

Replace the single-column surface with a `flex` row of `ChannelRail` + an inline message area (header, avatar'd rows, consult/dispatch/ask reskinned, card composer with `@ mention agent`). Send logic and atom wiring are unchanged.

**Files:**
- Rewrite: `frontend/app/view/agents/channelssurface.tsx`

- [ ] **Step 1: Replace the file contents**

Overwrite `frontend/app/view/agents/channelssurface.tsx` with:
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels surface: a conversational agent-dispatch surface, in the handoff's 2-pane chat layout.
// Left: the channel rail. Right: an avatar'd message stream + a card composer. Type a message;
// @<runtime> spawns a worker, @<name> steers a live one, `ask @<runtime>` runs a one-shot consult,
// plain text posts a note. Dispatched workers become roster rows, so a dispatch row shows a live
// status pill and an asking worker reuses AnswerBar — Cockpit still owns monitoring; this surface
// carries the dialogue and links out (↗).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { AnswerBar } from "./answerbar";
import { toggleSelection, type AgentVM } from "./agentsviewmodel";
import { sendChannelMessage } from "./channelactions";
import { avatarColor } from "./channelderive";
import type { RosterEntry } from "./channelmessages";
import { ChannelRail } from "./channelrail";
import {
    activeChannelAtom,
    activeChannelIdAtom,
    channelsAtom,
    consultStreamsAtom,
    createChannel,
    loadChannels,
    selectChannel,
    type ConsultStream,
} from "./channelsstore";
import { projectsAtom } from "./projectsstore";

const STATE_DOT: Record<string, string> = {
    working: "var(--color-success)",
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

function consultIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("consult:") ? refORef.slice("consult:".length) : undefined;
}

function timeLabel(ts: number, now: number): string {
    return now - ts < 60_000 ? "now" : new Date(ts).toLocaleTimeString();
}

// 32px rounded avatar with the author's initial, colored deterministically by name.
function Avatar({ name }: { name: string }) {
    return (
        <div
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] font-mono text-[13px] font-bold text-background"
            style={{ backgroundColor: avatarColor(name) }}
        >
            {(name.charAt(0) || "?").toUpperCase()}
        </div>
    );
}

function Tag({ label, tone }: { label: string; tone: "muted" | "asking" }) {
    if (tone === "asking") {
        return (
            <span className="rounded-[4px] bg-asking px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-background">
                {label}
            </span>
        );
    }
    return (
        <span className="rounded-[4px] border border-edge-mid bg-surface-raised px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-ink-mid">
            {label}
        </span>
    );
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
        <div className="rounded-[9px] border border-asking/40 bg-lane-asking p-3">
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

// A consult question with its replies grouped underneath by consultId. Each runtime shows either its
// persisted consult-reply (preferred) or, until that arrives, the live streaming text.
function ConsultRow({
    msg,
    allMessages,
    streams,
    now,
}: {
    msg: ChannelMessage;
    allMessages: ChannelMessage[];
    streams: Record<string, ConsultStream>;
    now: number;
}) {
    const consultId = consultIdOf(msg.reforef);
    const replies = consultId
        ? allMessages.filter((m) => m.kind === "consult-reply" && consultIdOf(m.reforef) === consultId)
        : [];
    const repliedRuntimes = new Set(replies.map((r) => r.author));
    const liveKeys = consultId
        ? Object.keys(streams).filter((k) => k.startsWith(`${consultId}:`) && !repliedRuntimes.has(k.split(":")[1]))
        : [];
    return (
        <div className="flex items-start gap-3">
            <Avatar name={msg.author} />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">{msg.author}</span>
                    <Tag label="ask" tone="muted" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <p className="mb-2.5 text-[14px] leading-[1.6] text-secondary">{msg.text || "(empty)"}</p>
                <div className="flex flex-col gap-2">
                    {replies.map((r) => (
                        <div key={r.id} className="rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5">
                            <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">{r.author}</div>
                            <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{r.text}</div>
                        </div>
                    ))}
                    {liveKeys.map((k) => {
                        const runtime = k.split(":")[1];
                        const s = streams[k];
                        return (
                            <div key={k} className="rounded-[9px] border border-accent/40 bg-accentbg/30 px-3 py-2.5">
                                <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">
                                    {runtime} {s.status === "streaming" ? "· consulting…" : ""}
                                </div>
                                <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">
                                    {s.text || "…"}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

// A dispatch / directive / human message row: avatar + author + optional tag + body, plus (for a
// dispatch) the live worker status pill, open link, and — when asking — the inline AnswerBar.
function MessageRow({
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
    const worker = msg.reforef ? workerFor(agents, msg.reforef) : undefined;
    const isDispatch = msg.kind === "dispatch";
    return (
        <div className="flex items-start gap-3">
            <Avatar name={msg.author} />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">{msg.author}</span>
                    {isDispatch ? <Tag label="dispatch" tone="muted" /> : null}
                    {isDispatch && worker?.state === "asking" ? <Tag label="asking" tone="asking" /> : null}
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <p className="text-[14px] leading-[1.6] text-secondary">{msg.text || "(empty)"}</p>
                {isDispatch && worker ? (
                    <div className="mt-2 flex items-center gap-2.5">
                        <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: STATE_DOT[worker.state] ?? "var(--color-muted)" }}
                        />
                        <span className="font-mono text-[10.5px] text-muted">{worker.state}</span>
                        <button
                            type="button"
                            onClick={() => jumpToAgent(model, worker.id)}
                            className="cursor-pointer font-mono text-[10.5px] text-accent-soft hover:text-accent"
                        >
                            open ↗
                        </button>
                    </div>
                ) : null}
                {isDispatch && worker && worker.state === "asking" ? (
                    <div className="mt-2">
                        <AskRow model={model} agent={worker} />
                    </div>
                ) : null}
            </div>
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
    const consultStreams = useAtomValue(consultStreamsAtom);
    const [draft, setDraft] = useState("");
    const [picking, setPicking] = useState(false);
    const [installedRuntimes, setInstalledRuntimes] = useState<string[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        fireAndForget(loadChannels);
    }, []);
    useEffect(() => {
        fireAndForget(async () => {
            const rtn = await RpcApi.ListConsultRuntimesCommand(TabRpcClient);
            setInstalledRuntimes((rtn.runtimes ?? []).filter((r) => r.installed).map((r) => r.runtime));
        });
    }, []);

    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));
    const messages = active?.messages ?? [];
    const askHint = installedRuntimes.length > 0 ? ` · ask @${installedRuntimes.join(" / @")} for a one-shot review` : "";

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

    const insertMention = () => {
        setDraft((d) => (d.length > 0 && !d.endsWith(" ") ? d + " @" : d + "@"));
        textareaRef.current?.focus();
    };

    // A channel is bound to a project at creation, so every dispatch has a valid cwd (no unbound state).
    const pickProject = (name: string, path: string) => {
        setPicking(false);
        fireAndForget(async () => {
            await createChannel(name, path);
        });
    };

    return (
        <div className="absolute inset-0 flex">
            <ChannelRail
                channels={channels}
                activeId={activeId}
                agents={agents}
                projects={projects}
                picking={picking}
                onSelect={(id) => fireAndForget(() => selectChannel(id))}
                onToggleNew={() => setPicking((p) => !p)}
                onPickProject={pickProject}
            />

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex flex-none items-center gap-2.5 border-b border-border bg-background px-[22px] py-3.5">
                    <span className="font-mono text-[17px] font-bold text-muted">#</span>
                    <div className="min-w-0">
                        <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-primary">
                            {active?.name ?? "no channel"}
                        </div>
                        {active?.projectpath ? (
                            <div className="truncate font-mono text-[11.5px] text-muted">{active.projectpath}</div>
                        ) : null}
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-[22px]">
                    <div className="flex max-w-[760px] flex-col gap-5">
                        {channels == null ? (
                            <div className="mt-10 text-center text-[13px] text-muted">Loading…</div>
                        ) : !activeId ? (
                            <div className="mt-10 text-center text-[13px] text-muted">
                                No channel yet — click <span className="text-secondary">+ New channel</span> to create
                                one bound to a project.
                            </div>
                        ) : messages.length === 0 ? (
                            <div className="mt-10 text-center text-[13px] text-muted">
                                Empty channel. Try <span className="font-mono text-secondary">@claude do something</span>.
                            </div>
                        ) : (
                            messages
                                .filter((m) => m.kind !== "consult-reply")
                                .map((m) =>
                                    m.kind === "consult" ? (
                                        <ConsultRow
                                            key={m.id}
                                            msg={m}
                                            allMessages={messages}
                                            streams={consultStreams}
                                            now={now}
                                        />
                                    ) : (
                                        <MessageRow key={m.id} model={model} agents={agents} msg={m} now={now} />
                                    )
                                )
                        )}
                    </div>
                </div>

                <div className="flex-none px-6 pb-[18px] pt-2">
                    <div className="max-w-[760px] rounded-[12px] border border-edge-mid bg-surface-raised px-[15px] py-3">
                        <textarea
                            ref={textareaRef}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    send();
                                }
                            }}
                            rows={1}
                            placeholder={`Message #${active?.name ?? "channel"}…${askHint}`}
                            disabled={!activeId}
                            className="min-h-[22px] w-full resize-none bg-transparent text-[14px] text-primary placeholder:text-muted focus:outline-none disabled:opacity-50"
                        />
                        <div className="mt-2.5 flex items-center gap-2.5">
                            <button
                                type="button"
                                onClick={insertMention}
                                disabled={!activeId}
                                className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11.5px] text-ink-mid hover:border-edge-strong disabled:opacity-50"
                            >
                                @ mention agent
                            </button>
                            <div className="flex-1" />
                            <button
                                type="button"
                                onClick={send}
                                disabled={!activeId}
                                className="shrink-0 cursor-pointer rounded-[8px] bg-accent px-[15px] py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-50"
                            >
                                Send ⏎
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (only the ~3 pre-existing `frontend/tauri/api.test.ts` baseline errors).

- [ ] **Step 3: No commit.**

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend test suite**

Run: `npx vitest run`
Expected: all tests pass, including the 8 new `channelderive` tests. No regressions in `channelmessages.test.ts`.

- [ ] **Step 2: Typecheck the whole frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 pre-existing `frontend/tauri/api.test.ts` errors (baseline). No new errors.

- [ ] **Step 3: Visual verification on the live dev app (CDP)**

The redesign is pure FE — Vite HMR applies it without a backend rebuild (Task 1 already rebuilt the backend). Ensure the dev app is up (`:9222`), navigate to Channels, and screenshot with `node scripts/cdp-shot.mjs <out.png>`. Confirm:
- 2-pane layout: left channel rail (search box, `#`-prefixed channels, active highlight), right message area.
- Avatars (colored initials) on message rows; `dispatch`/`ask`/`asking` tags render.
- A channel with an asking dispatched worker shows the amber attention dot in the rail.
- A consult (`ask @codex say pong`) streams into a reply card in the new skin.
- Composer card with `@ mention agent` (inserts `@`) + `Send ⏎`.

Expected: matches the approved mockup; no console errors (check via CDP `Runtime` / `read_console_messages`).

- [ ] **Step 4: No commit.**

---

### Task 8: Single commit (approval-gated)

Per the user's git rule, present the batched change and get explicit approval before committing. This one commit contains both the consult streaming fix and the Channels redesign.

**Files:** all changes from Tasks 1–6.

- [ ] **Step 1: Show the full status and diff summary**

Run: `git status && git --no-pager diff --stat`
Expected files (M/A):
- M `frontend/app/view/agents/channelactions.ts` (consult timeout — already present)
- M `pkg/wshrpc/wshserver/wshserver.go`, `pkg/consult/consult.go`, `pkg/consult/exec.go`, `pkg/consult/consult_test.go` (consult fix)
- M `frontend/tailwindsetup.css` (avatar palette)
- A `frontend/app/view/agents/channelderive.ts`, `channelderive.test.ts`, `channelrail.tsx`
- M `frontend/app/view/agents/channelssurface.tsx` (rewrite)
- A `docs/superpowers/specs/2026-07-01-channels-2pane-redesign-design.md`, `docs/superpowers/plans/2026-07-01-channels-2pane-redesign.md`
- (plus any `package.json`/lock or other pre-existing working-tree changes — confirm they belong before staging)

- [ ] **Step 2: Present the commit message and ask for approval**

Proposed message:
```
feat(channels): 2-pane handoff redesign + fix consult streaming timeout

Rebuild the Channels tab to the handoff's Slack-style 2-pane layout: a left
channel rail (with an attention dot when a channel has an agent waiting),
avatar'd message rows, and a card composer. Members rail / DMs / unread
counters are intentionally omitted (no backing data in a single-user tool);
Pin/Attach are deferred as real features.

Also fixes consults never streaming a reply: the wshrpc handler applied its
5s DefaultTimeoutMs to the streaming ConsultCommand, killing it before the
first chunk (~6s). The FE now passes a 130s RpcOpts timeout.
```
Then ask: "Awaiting approval. Proceed? (yes/no)".

- [ ] **Step 3: On approval, stage and commit**

Only the files listed in Step 1 (do not use `git add -A` if unrelated working-tree changes exist). Then commit with the approved message. Do not add a co-author. Do not push unless asked.

---

## Self-Review

**Spec coverage:** 2-pane layout (Tasks 5–6), left channel rail replacing pills (Task 5), avatars + tags + typography (Task 6), attention dot (Tasks 4–5), composer card + `@mention` (Task 6), consult/dispatch/AskRow folded in (Task 6), dropped members/DM/unread (by omission — Task 6 renders none), Pin/Attach deferred (not built), avatar palette from `@theme` (Task 2), no backend changes (only the pre-existing consult fix verified in Task 1), unit tests for both derivations (Tasks 3–4), CDP visual (Task 7). All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output.

**Type consistency:** `avatarColor(name: string): string` and `channelHasAsk(channel: Channel, agents: AgentVM[]): boolean` are used identically in `channelrail.tsx`/`channelssurface.tsx`. `ChannelRail` prop names (`channels`, `activeId`, `agents`, `projects`, `picking`, `onSelect`, `onToggleNew`, `onPickProject`) match the call site in `ChannelsSurface`. `Channel`/`ChannelMessage` are ambient globals (no import). `AgentVM` imported from `./agentsviewmodel` in both new files. `STATE_DOT`, `workerFor`, `consultIdOf` preserved with identical signatures.
