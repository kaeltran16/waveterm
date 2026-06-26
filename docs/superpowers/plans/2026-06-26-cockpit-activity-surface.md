# Activity Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cockpit's **Activity** surface — a recent, cross-project, type-filterable feed of agent lifecycle events (Started/Asked/Committed/Errored/Finished), sourced from the persisted Claude Code + Codex session transcripts.

**Architecture:** All-frontend, zero new Go. A pure extractor turns raw transcript JSONL into `ActivityEvent[]` (one extractor per agent format, sibling to the existing `AgentEntry[]` projectors). A discovery module enumerates recent session files via existing file RPCs; a loader reads them newest-first up to a cap and within a recent window. A thin surface component renders the handoff design, grouped by project, with live-only "Jump → source".

**Tech Stack:** React 19, jotai, Tailwind v4 (`@theme` tokens), vitest. wshrpc client (`RpcApi`): `FileListCommand`, `GetAgentTranscriptCommand`. Spec: `docs/superpowers/specs/2026-06-26-cockpit-activity-surface-design.md`.

---

## Git workflow (project override)

Per `CLAUDE.md` (STRICT git workflow), **do not commit per task.** Each task ends when its tests pass. A single approval-gated commit at the very end (Task 8) folds in the spec, this plan, and all code as one `feat(cockpit): …` commit.

## File structure

| File | Responsibility | Status |
|---|---|---|
| `frontend/app/view/agents/activityevents.ts` | Pure: types + per-format raw-JSONL → `ActivityEvent[]` extractors | Create |
| `frontend/app/view/agents/activityevents.test.ts` | Unit tests for the extractors | Create |
| `frontend/app/view/agents/activitydiscovery.ts` | Enumerate recent Claude + Codex session files (RPC) | Create |
| `frontend/app/view/agents/activitystore.ts` | Pure group/filter + the impure loader + `activityEventsAtom` | Create |
| `frontend/app/view/agents/activitystore.test.ts` | Unit tests for group/filter | Create |
| `frontend/app/view/agents/activitysurface.tsx` | Handoff-parity surface component | Create |
| `frontend/app/view/agents/agents.tsx` | Add `ActivityType` re-export usage + `activityFilterAtom` | Modify |
| `frontend/app/view/agents/cockpitshell.tsx` | Route `surface === "activity"` to `ActivitySurface` | Modify |
| `frontend/app/view/agents/placeholdersurface.tsx` | Drop the now-unused `activity` title | Modify |

`FileInfo` is an ambient global type (declared in `frontend/types/gotypes.d.ts`) — no import needed.

Run a single test file with: `npx vitest run frontend/app/view/agents/<file>.test.ts`

---

## Task 1: ActivityEvent types + Claude extractor

**Files:**
- Create: `frontend/app/view/agents/activityevents.ts`
- Test: `frontend/app/view/agents/activityevents.test.ts`

- [ ] **Step 1: Write the failing test (Claude path)**

Create `frontend/app/view/agents/activityevents.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { extractClaudeEvents } from "./activityevents";

const base = { agent: "claude", sessionPath: "/p/s.jsonl", agentName: "sess", project: "waveterm", live: false } as const;
const L = (o: object): string => JSON.stringify(o);

const lines = [
    L({ type: "user", timestamp: "2026-06-20T10:00:00.000Z", message: { content: "fix the bug" } }),
    L({ type: "assistant", timestamp: "2026-06-20T10:00:05.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'git commit -m "fix race"' } }] } }),
    L({ type: "assistant", timestamp: "2026-06-20T10:00:08.000Z", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } }),
    L({ type: "user", timestamp: "2026-06-20T10:00:09.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] } }),
    L({ type: "assistant", timestamp: "2026-06-20T10:00:12.000Z", message: { content: [{ type: "tool_use", id: "t3", name: "AskUserQuestion", input: { questions: [{ question: "Which approach?" }] } }] } }),
    L({ type: "assistant", timestamp: "2026-06-20T10:00:20.000Z", message: { content: [{ type: "text", text: "All done." }] } }),
];

describe("extractClaudeEvents", () => {
    it("extracts the five event types, in ts order, with text and project", () => {
        const evs = extractClaudeEvents(lines, base);
        expect(evs.map((e) => e.type)).toEqual(["started", "committed", "errored", "asked", "finished"]);
        expect(evs[0].text).toBe("fix the bug");
        expect(evs[1].text).toBe("fix race");
        expect(evs[2].text).toContain("npm test");
        expect(evs[3].text).toBe("Which approach?");
        expect(evs.every((e) => e.project === "waveterm")).toBe(true);
    });
    it("omits finished and stamps live/liveId when the session is live", () => {
        const evs = extractClaudeEvents(lines, { ...base, live: true, liveId: "tab1" });
        expect(evs.some((e) => e.type === "finished")).toBe(false);
        expect(evs.every((e) => e.live && e.liveId === "tab1")).toBe(true);
    });
    it("does not treat a non-commit Bash as committed", () => {
        const only = [L({ type: "assistant", timestamp: "2026-06-20T10:00:00.000Z", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "git status" } }] } })];
        expect(extractClaudeEvents(only, base).some((e) => e.type === "committed")).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/activityevents.test.ts`
Expected: FAIL — `extractClaudeEvents` is not exported / module not found.

- [ ] **Step 3: Implement the types + Claude extractor**

Create `frontend/app/view/agents/activityevents.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure extraction of lifecycle ActivityEvents from raw transcript JSONL lines. Sibling of the
// AgentEntry[] projectors (transcriptprojection.ts / codextranscriptprojection.ts): those discard
// timestamps, session boundaries, and tool identity — exactly what the Activity taxonomy needs — so
// this parses raw lines itself. No React, no Wave runtime imports.

import { extractAiTitle } from "./transcriptprojection";

export type ActivityType = "started" | "asked" | "committed" | "errored" | "finished";

export interface ActivityEvent {
    id: string; // `${sessionPath}#${index}` — stable per extraction
    agent: string; // "claude" | "codex"
    agentName: string; // display name
    project: string; // group key
    type: ActivityType;
    ts: number; // epoch ms
    text: string; // one-line summary
    sessionPath: string;
    live: boolean; // session is in the current live roster (drives Jump)
    liveId?: string; // tabId when live (jump target)
}

export interface ExtractBase {
    agent: string;
    sessionPath: string;
    agentName: string; // fallback name (live roster name, or file-derived)
    project: string; // fallback project (claude: from path; codex: overridden by session_meta)
    live: boolean;
    liveId?: string;
}

interface RawEvent {
    type: ActivityType;
    ts: number;
    text: string;
}

const COMMIT_RE = /\bgit\s+commit\b/;
const MAX_TEXT = 100;

function clip(s: string): string {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 1) + "…" : t;
}

function commitSubject(command: string): string {
    const m = command.match(/-m\s+["']([^"']+)["']/);
    return m ? clip(m[1]) : "committed";
}

function askText(input: any): string {
    const q = input?.questions?.[0];
    const s = typeof q?.question === "string" ? q.question : typeof q?.header === "string" ? q.header : "asked a question";
    return clip(s);
}

function recTs(rec: any): number {
    const t = typeof rec?.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    return Number.isNaN(t) ? 0 : t;
}

function finalize(raw: RawEvent[], base: ExtractBase, name: string, project: string): ActivityEvent[] {
    return raw
        .filter((e) => e.ts > 0)
        .sort((a, b) => a.ts - b.ts)
        .map((e, i) => ({
            id: `${base.sessionPath}#${i}`,
            agent: base.agent,
            agentName: name,
            project,
            type: e.type,
            ts: e.ts,
            text: e.text,
            sessionPath: base.sessionPath,
            live: base.live,
            liveId: base.liveId,
        }));
}

export function extractClaudeEvents(lines: string[], base: ExtractBase): ActivityEvent[] {
    const raw: RawEvent[] = [];
    const cmdById = new Map<string, string>(); // tool_use id -> command (for error text)
    let firstTs = 0;
    let lastTs = 0;
    let firstUser = "";
    let lastAssistant = "";
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        const ts = recTs(rec);
        if (ts > 0) {
            if (firstTs === 0) {
                firstTs = ts;
            }
            lastTs = ts;
        }
        if (rec.type === "assistant" && Array.isArray(rec?.message?.content)) {
            for (const b of rec.message.content) {
                if (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
                    lastAssistant = b.text;
                } else if (b?.type === "tool_use" && typeof b.name === "string") {
                    const cmd = typeof b?.input?.command === "string" ? b.input.command : "";
                    if (typeof b.id === "string") {
                        cmdById.set(b.id, cmd || b.name);
                    }
                    if (b.name === "AskUserQuestion") {
                        raw.push({ type: "asked", ts, text: askText(b.input) });
                    } else if (b.name === "Bash" && COMMIT_RE.test(cmd)) {
                        raw.push({ type: "committed", ts, text: commitSubject(cmd) });
                    }
                }
            }
        } else if (rec.type === "user") {
            const content = rec?.message?.content;
            if (typeof content === "string") {
                if (firstUser === "" && content.trim() !== "") {
                    firstUser = content;
                }
            } else if (Array.isArray(content)) {
                for (const b of content) {
                    if (b?.type === "text" && firstUser === "" && typeof b.text === "string" && b.text.trim() !== "") {
                        firstUser = b.text;
                    }
                    if (b?.type === "tool_result" && b?.is_error === true && typeof b.tool_use_id === "string") {
                        raw.push({ type: "errored", ts, text: `failed: ${clip(cmdById.get(b.tool_use_id) ?? "a command")}` });
                    }
                }
            }
        }
    }
    if (firstTs > 0) {
        raw.push({ type: "started", ts: firstTs, text: firstUser ? clip(firstUser) : "started session" });
    }
    if (!base.live && lastTs > 0) {
        raw.push({ type: "finished", ts: lastTs, text: lastAssistant ? clip(lastAssistant) : "finished" });
    }
    const name = extractAiTitle(lines) ?? base.agentName;
    return finalize(raw, base, name, base.project);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/activityevents.test.ts`
Expected: PASS (3 tests).

---

## Task 2: Codex extractor + dispatcher

**Files:**
- Modify: `frontend/app/view/agents/activityevents.ts`
- Test: `frontend/app/view/agents/activityevents.test.ts`

- [ ] **Step 1: Add the failing Codex tests**

Append to `frontend/app/view/agents/activityevents.test.ts`:

```ts
import { extractCodexEvents, extractEvents } from "./activityevents";

const cbase = { agent: "codex", sessionPath: "/c/r.jsonl", agentName: "codex", project: "", live: false } as const;

describe("extractCodexEvents", () => {
    const clines = [
        L({ type: "session_meta", timestamp: "2026-06-21T09:00:00.000Z", payload: { cwd: "C:\\Users\\me\\IdeaProjects\\krypton", thread_source: "parent" } }),
        L({ type: "response_item", timestamp: "2026-06-21T09:00:03.000Z", payload: { type: "function_call", call_id: "c1", name: "shell_command", arguments: '{"command":"git commit -m \\"add index\\""}' } }),
        L({ type: "response_item", timestamp: "2026-06-21T09:00:05.000Z", payload: { type: "function_call", call_id: "c2", name: "shell_command", arguments: '{"command":"go test ./..."}' } }),
        L({ type: "response_item", timestamp: "2026-06-21T09:00:07.000Z", payload: { type: "function_call_output", call_id: "c2", output: "Exit code: 1\nFAIL" } }),
        L({ type: "response_item", timestamp: "2026-06-21T09:00:10.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed." }] } }),
    ];
    it("extracts project from session_meta cwd and the codex event types", () => {
        const evs = extractCodexEvents(clines, cbase);
        expect(evs.map((e) => e.type)).toEqual(["started", "committed", "errored", "finished"]);
        expect(evs.every((e) => e.project === "krypton")).toBe(true);
        expect(evs[1].text).toBe("add index");
        expect(evs[2].text).toContain("go test");
    });
    it("excludes subagent rollouts entirely", () => {
        const sub = [L({ type: "session_meta", timestamp: "2026-06-21T09:00:00.000Z", payload: { cwd: "/x/y", thread_source: "subagent" } }), ...clines.slice(1)];
        expect(extractCodexEvents(sub, cbase)).toEqual([]);
    });
});

describe("extractEvents dispatcher", () => {
    it("routes codex to the codex extractor", () => {
        const evs = extractEvents([L({ type: "session_meta", timestamp: "2026-06-21T09:00:00.000Z", payload: { cwd: "/a/b/opal" } })], cbase);
        expect(evs[0]?.type).toBe("started");
        expect(evs[0]?.project).toBe("opal");
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/activityevents.test.ts`
Expected: FAIL — `extractCodexEvents` / `extractEvents` not exported.

- [ ] **Step 3: Implement the Codex extractor + dispatcher**

Append to `frontend/app/view/agents/activityevents.ts`:

```ts
// Codex rollout helpers — mirror the private logic in codextranscriptprojection.ts (not exported
// there). Small and stable; duplicated rather than widening that module's API.
function shellCommand(argsRaw: unknown): string {
    if (typeof argsRaw !== "string") {
        return "";
    }
    try {
        const a = JSON.parse(argsRaw);
        return typeof a?.command === "string" ? a.command : "";
    } catch {
        return "";
    }
}

function outputIsError(output: unknown): boolean {
    if (typeof output !== "string") {
        return false;
    }
    const m = output.match(/Exit code:\s*(\d+)/);
    if (m) {
        return m[1] !== "0";
    }
    try {
        const p = JSON.parse(output);
        return typeof p?.metadata?.exit_code === "number" ? p.metadata.exit_code !== 0 : false;
    } catch {
        return false;
    }
}

function projectFromCwd(cwd: string): string {
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
}

export function extractCodexEvents(lines: string[], base: ExtractBase): ActivityEvent[] {
    const raw: RawEvent[] = [];
    const cmdById = new Map<string, string>();
    let firstTs = 0;
    let lastTs = 0;
    let firstUser = "";
    let lastAssistant = "";
    let project = base.project;
    let isSubagent = false;
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        const ts = recTs(rec);
        if (ts > 0) {
            if (firstTs === 0) {
                firstTs = ts;
            }
            lastTs = ts;
        }
        if (rec.type === "session_meta") {
            const p = rec.payload ?? {};
            if (typeof p.cwd === "string" && p.cwd) {
                project = projectFromCwd(p.cwd);
            }
            if (p.thread_source === "subagent") {
                isSubagent = true;
            }
            continue;
        }
        if (rec.type !== "response_item" || rec.payload == null) {
            continue;
        }
        const p = rec.payload;
        if (p.type === "message" && Array.isArray(p.content)) {
            for (const b of p.content) {
                if (p.role === "assistant" && b?.type === "output_text" && typeof b.text === "string" && b.text.trim() !== "") {
                    lastAssistant = b.text;
                }
                if (
                    p.role === "user" &&
                    b?.type === "input_text" &&
                    firstUser === "" &&
                    typeof b.text === "string" &&
                    b.text.trim() !== "" &&
                    !b.text.startsWith("<environment_context") &&
                    !b.text.startsWith("<skill>")
                ) {
                    firstUser = b.text;
                }
            }
        } else if (p.type === "function_call") {
            const cmd = shellCommand(p.arguments);
            if (typeof p.call_id === "string") {
                cmdById.set(p.call_id, cmd || (typeof p.name === "string" ? p.name : ""));
            }
            if (p.name === "shell_command" && COMMIT_RE.test(cmd)) {
                raw.push({ type: "committed", ts, text: commitSubject(cmd) });
            }
        } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
            if (typeof p.call_id === "string" && outputIsError(p.output)) {
                raw.push({ type: "errored", ts, text: `failed: ${clip(cmdById.get(p.call_id) ?? "a command")}` });
            }
        }
    }
    if (isSubagent) {
        return []; // v1: exclude subagent rollouts (spec §3)
    }
    if (firstTs > 0) {
        raw.push({ type: "started", ts: firstTs, text: firstUser ? clip(firstUser) : "started session" });
    }
    if (!base.live && lastTs > 0) {
        raw.push({ type: "finished", ts: lastTs, text: lastAssistant ? clip(lastAssistant) : "finished" });
    }
    const name = project || base.agentName;
    return finalize(raw, base, name, project);
}

export function extractEvents(lines: string[], base: ExtractBase): ActivityEvent[] {
    return base.agent === "codex" ? extractCodexEvents(lines, base) : extractClaudeEvents(lines, base);
}
```

- [ ] **Step 4: Run to verify all extractor tests pass**

Run: `npx vitest run frontend/app/view/agents/activityevents.test.ts`
Expected: PASS (5 tests total).

---

## Task 3: Store — pure group/filter + atom

**Files:**
- Create: `frontend/app/view/agents/activitystore.ts`
- Test: `frontend/app/view/agents/activitystore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/activitystore.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./activityevents";
import { applyFilter, groupByProject } from "./activitystore";

const e = (project: string, type: ActivityEvent["type"], ts: number): ActivityEvent => ({
    id: `${project}-${ts}`,
    agent: "claude",
    agentName: project,
    project,
    type,
    ts,
    text: type,
    sessionPath: `/p/${project}.jsonl`,
    live: false,
});

describe("applyFilter", () => {
    it("returns all events for 'all' and only matching type otherwise", () => {
        const evs = [e("a", "asked", 1), e("a", "committed", 2)];
        expect(applyFilter(evs, "all")).toHaveLength(2);
        expect(applyFilter(evs, "asked").map((x) => x.type)).toEqual(["asked"]);
    });
});

describe("groupByProject", () => {
    it("groups by project, newest-first within and across groups, counts attn", () => {
        const evs = [e("alpha", "started", 10), e("beta", "asked", 30), e("alpha", "asked", 20)];
        const groups = groupByProject(evs);
        expect(groups.map((g) => g.project)).toEqual(["beta", "alpha"]); // beta's newest (30) > alpha's newest (20)
        const alpha = groups.find((g) => g.project === "alpha")!;
        expect(alpha.events.map((x) => x.ts)).toEqual([20, 10]); // newest-first within group
        expect(alpha.count).toBe(2);
        expect(alpha.attn).toBe(1); // one "asked"
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/activitystore.test.ts`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Implement the store (pure parts + atom + loader)**

Create `frontend/app/view/agents/activitystore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Activity surface store: the loaded event set (activityEventsAtom), pure group/filter helpers, and
// the impure loader. The loader reads recent session files newest-first (discoverSessions) up to a
// cap and within a recent window; live sessions are just recent files flagged live=true (so Jump
// works) — no separate live-event path, no dedupe (single source).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { extractEvents, type ActivityEvent, type ActivityType } from "./activityevents";
import { discoverSessions } from "./activitydiscovery";
import type { AgentsViewModel } from "./agents";

export const ACTIVITY_WINDOW_DAYS = 7;
export const ACTIVITY_EVENT_CAP = 200;
export const ACTIVITY_TAIL_LINES = 2000;

export const activityEventsAtom = atom<ActivityEvent[]>([]) as PrimitiveAtom<ActivityEvent[]>;

export interface ActivityGroup {
    project: string;
    count: number;
    attn: number; // unanswered-question events drive the group's attention badge
    events: ActivityEvent[];
}

export function applyFilter(events: ActivityEvent[], filter: ActivityType | "all"): ActivityEvent[] {
    return filter === "all" ? events : events.filter((e) => e.type === filter);
}

export function groupByProject(events: ActivityEvent[]): ActivityGroup[] {
    const byProj = new Map<string, ActivityEvent[]>();
    for (const ev of events) {
        const key = ev.project || "—";
        const arr = byProj.get(key);
        if (arr) {
            arr.push(ev);
        } else {
            byProj.set(key, [ev]);
        }
    }
    const groups: ActivityGroup[] = [];
    for (const [project, evs] of byProj) {
        const sorted = [...evs].sort((a, b) => b.ts - a.ts);
        groups.push({ project, count: sorted.length, attn: sorted.filter((e) => e.type === "asked").length, events: sorted });
    }
    return groups.sort((a, b) => (b.events[0]?.ts ?? 0) - (a.events[0]?.ts ?? 0));
}

let loading = false;

function norm(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
}

export async function loadActivity(model: AgentsViewModel): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const liveByPath = new Map<string, string>();
        for (const a of globalStore.get(model.agentsAtom)) {
            if (a.transcriptPath) {
                liveByPath.set(norm(a.transcriptPath), a.id);
            }
        }
        const sessions = await discoverSessions();
        const now = Date.now();
        const windowMs = ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        const events: ActivityEvent[] = [];
        for (const s of sessions) {
            if (events.length >= ACTIVITY_EVENT_CAP) {
                break;
            }
            let lines: string[];
            try {
                const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: s.path, maxlines: ACTIVITY_TAIL_LINES });
                lines = rtn.lines ?? [];
            } catch {
                continue;
            }
            const liveId = liveByPath.get(norm(s.path));
            const evs = extractEvents(lines, {
                agent: s.agent,
                sessionPath: s.path,
                agentName: s.name,
                project: s.project,
                live: liveId != null,
                liveId,
            });
            for (const ev of evs) {
                if (now - ev.ts <= windowMs) {
                    events.push(ev);
                }
            }
        }
        globalStore.set(activityEventsAtom, events.slice(0, ACTIVITY_EVENT_CAP));
    } finally {
        loading = false;
    }
}
```

Note: this imports `discoverSessions` from a module created in Task 4. Tests in this task only exercise `applyFilter`/`groupByProject`, but the file must compile — so do Task 4 before running the full typecheck (Task 8). The vitest run below only loads this module's pure exports; if vitest fails to resolve `./activitydiscovery`, complete Task 4 first.

- [ ] **Step 4: Run to verify the pure tests pass**

Run: `npx vitest run frontend/app/view/agents/activitystore.test.ts`
Expected: PASS (2 tests). (If a resolution error for `./activitydiscovery` appears, complete Task 4, then re-run — it will pass.)

---

## Task 4: Session discovery (RPC)

**Files:**
- Create: `frontend/app/view/agents/activitydiscovery.ts`

This module is impure (file RPCs) and has no logic worth unit-testing beyond what the extractors cover; it is verified by the typecheck (Task 8) and the live CDP check (Task 8). Build it to compile and match the loader's `SessionDescriptor` contract.

- [ ] **Step 1: Implement discovery**

Create `frontend/app/view/agents/activitydiscovery.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Discover recent agent session transcript files for the Activity surface. Claude lives under
// ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl (project = dir name, free); Codex under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (project resolved later from the file's session_meta).
// Agent identity = source root. ~ is expanded by the file backend (FileListCommand). Zero new Go.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { projectNameFromTranscriptPath } from "./projectname";

const CLAUDE_ROOT = "~/.claude/projects";
const CODEX_ROOT = "~/.codex/sessions";
const CODEX_WALK_FILE_BUDGET = 400; // bound the date-tree walk

export interface SessionDescriptor {
    path: string;
    agent: string; // "claude" | "codex"
    project: string; // claude: from path; codex: "" (resolved by the extractor)
    name: string;
    modtime: number; // sort key only; unit-agnostic (monotonic)
}

async function listDir(path: string): Promise<FileInfo[]> {
    try {
        return await RpcApi.FileListCommand(TabRpcClient, { path, opts: { all: true } });
    } catch {
        return [];
    }
}

function isJsonl(fi: FileInfo): boolean {
    return !fi.isdir && (fi.name ?? "").endsWith(".jsonl");
}

function byNameDesc(a: FileInfo, b: FileInfo): number {
    return (b.name ?? "").localeCompare(a.name ?? "");
}

async function discoverClaude(): Promise<SessionDescriptor[]> {
    const out: SessionDescriptor[] = [];
    for (const proj of (await listDir(CLAUDE_ROOT)).filter((d) => d.isdir)) {
        for (const f of (await listDir(proj.path)).filter(isJsonl)) {
            const project = projectNameFromTranscriptPath(f.path);
            out.push({ path: f.path, agent: "claude", project, name: project, modtime: f.modtime ?? 0 });
        }
    }
    return out;
}

async function discoverCodex(): Promise<SessionDescriptor[]> {
    const out: SessionDescriptor[] = [];
    for (const y of (await listDir(CODEX_ROOT)).filter((d) => d.isdir).sort(byNameDesc)) {
        for (const m of (await listDir(y.path)).filter((d) => d.isdir).sort(byNameDesc)) {
            for (const d of (await listDir(m.path)).filter((dd) => dd.isdir).sort(byNameDesc)) {
                for (const f of (await listDir(d.path)).filter((fi) => isJsonl(fi) && (fi.name ?? "").startsWith("rollout-"))) {
                    out.push({ path: f.path, agent: "codex", project: "", name: "codex", modtime: f.modtime ?? 0 });
                }
                if (out.length >= CODEX_WALK_FILE_BUDGET) {
                    return out;
                }
            }
        }
    }
    return out;
}

export async function discoverSessions(): Promise<SessionDescriptor[]> {
    const [claude, codex] = await Promise.all([discoverClaude(), discoverCodex()]);
    return [...claude, ...codex].sort((a, b) => b.modtime - a.modtime);
}
```

- [ ] **Step 2: Verify the store + discovery compile together**

Run: `npx vitest run frontend/app/view/agents/activitystore.test.ts`
Expected: PASS (2 tests) — `./activitydiscovery` now resolves.

---

## Task 5: Wire the filter atom into the model

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/agents.tsx`, add to the import block near the other `./` imports (after line 14, `import { liveAgentsAtom } from "./liveagents";`):

```ts
import type { ActivityType } from "./activityevents";
```

- [ ] **Step 2: Add the filter atom field**

In `frontend/app/view/agents/agents.tsx`, immediately after the line `chipFilterAtom = atom<ChipFilter>("all");` (line 55), add:

```ts
    // Activity surface: selected type filter chip (spec §4.1). Default "all".
    activityFilterAtom = atom<ActivityType | "all">("all");
```

- [ ] **Step 3: Verify it typechecks**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors referencing `agents.tsx` or `activity*` (baseline has ~3 pre-existing errors in `frontend/tauri/api.test.ts` only).

---

## Task 6: ActivitySurface component

**Files:**
- Create: `frontend/app/view/agents/activitysurface.tsx`

- [ ] **Step 1: Implement the component**

Create `frontend/app/view/agents/activitysurface.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Activity surface (handoff parity: Wave-cockpit-live.dc.html:543-575). Recent cross-project event
// feed, type-filterable, grouped by project. Loads on mount via loadActivity. Jump is live-only:
// ended sessions render no Jump button (deferred to the Sessions surface).

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { ActivityEvent, ActivityType } from "./activityevents";
import { activityEventsAtom, applyFilter, groupByProject, loadActivity } from "./activitystore";
import type { AgentsViewModel } from "./agents";
import { formatAge } from "./agentsviewmodel";

const TYPE_META: Record<ActivityType, { label: string; color: string }> = {
    started: { label: "Started", color: "var(--color-success)" },
    asked: { label: "Asked", color: "var(--color-asking)" },
    committed: { label: "Committed", color: "var(--color-accent)" },
    errored: { label: "Errored", color: "var(--color-error)" },
    finished: { label: "Finished", color: "var(--color-muted)" },
};

const CHIPS: { key: ActivityType | "all"; label: string }[] = [
    { key: "all", label: "All events" },
    { key: "asked", label: "Asked" },
    { key: "errored", label: "Errored" },
    { key: "committed", label: "Committed" },
    { key: "started", label: "Started" },
    { key: "finished", label: "Finished" },
];

function ago(now: number, ts: number): string {
    return now - ts < 60_000 ? "just now" : `${formatAge(now - ts)} ago`;
}

function jump(model: AgentsViewModel, e: ActivityEvent): void {
    if (!e.live || !e.liveId) {
        return;
    }
    globalStore.set(model.focusIdAtom, e.liveId);
    globalStore.set(model.terminalTargetAtom, undefined);
    globalStore.set(model.surfaceAtom, "agent");
}

export function ActivitySurface({ model }: { model: AgentsViewModel }) {
    const events = useAtomValue(activityEventsAtom);
    const filter = useAtomValue(model.activityFilterAtom);
    const now = useAtomValue(model.nowAtom);
    useEffect(() => {
        void loadActivity(model);
    }, [model]);
    const groups = groupByProject(applyFilter(events, filter));
    return (
        <div className="absolute inset-0 overflow-y-auto bg-background">
            <div className="mx-auto max-w-[820px] px-[30px] pb-[70px] pt-[30px]">
                <div className="mb-5">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Activity</h1>
                    <p className="text-[13.5px] text-secondary">Every agent event, grouped by project.</p>
                </div>
                <div className="mb-7 flex flex-wrap gap-2">
                    {CHIPS.map((c) => {
                        const active = filter === c.key;
                        const dot = c.key !== "all" ? TYPE_META[c.key].color : undefined;
                        return (
                            <button
                                key={c.key}
                                type="button"
                                onClick={() => globalStore.set(model.activityFilterAtom, c.key)}
                                className={cn(
                                    "cursor-pointer rounded-[8px] border px-[13px] py-[6px] text-[12px] font-medium",
                                    active
                                        ? "border-accent bg-accentbg text-accent-soft"
                                        : "border-border bg-surface text-ink-mid hover:border-edge-strong"
                                )}
                            >
                                {dot ? (
                                    <span className="mr-1.5" style={{ color: dot }}>
                                        ●
                                    </span>
                                ) : null}
                                {c.label}
                            </button>
                        );
                    })}
                </div>
                {groups.length === 0 ? (
                    <div className="mt-10 text-center text-[13px] text-muted">No recent activity.</div>
                ) : (
                    groups.map((g) => (
                        <div key={g.project} className="mb-[30px]">
                            <div className="mb-1.5 flex items-center gap-2.5">
                                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-accent-soft">
                                    {g.project}
                                </span>
                                <div className="h-px flex-1 bg-border" />
                                {g.attn > 0 ? (
                                    <span className="rounded-[5px] bg-accentbg px-1.5 font-mono text-[9.5px] font-semibold text-asking">
                                        {g.attn} need you
                                    </span>
                                ) : null}
                                <span className="font-mono text-[10.5px] font-semibold text-muted">{g.count}</span>
                            </div>
                            {g.events.map((e) => (
                                <div key={e.id} className="flex gap-4 border-b border-edge-faint px-1 py-3.5 hover:bg-surface">
                                    <span className="w-[42px] shrink-0 pt-0.5 text-right font-mono text-[11.5px] text-muted">
                                        {now - e.ts < 60_000 ? "now" : formatAge(now - e.ts)}
                                    </span>
                                    <span
                                        className="mt-1 h-[9px] w-[9px] shrink-0 rounded-full"
                                        style={{ backgroundColor: TYPE_META[e.type].color }}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="text-[13.5px] leading-[1.5] text-secondary">
                                            <span className="font-mono text-[13px] font-semibold text-primary">{e.agentName}</span> {e.text}
                                        </div>
                                        <div className="mt-[5px] flex items-center gap-2">
                                            <span
                                                className="font-mono text-[10px] font-medium uppercase tracking-[0.06em]"
                                                style={{ color: TYPE_META[e.type].color }}
                                            >
                                                {TYPE_META[e.type].label}
                                            </span>
                                            <span className="font-mono text-[10.5px] text-muted">{ago(now, e.ts)}</span>
                                        </div>
                                    </div>
                                    {e.live ? (
                                        <button
                                            type="button"
                                            onClick={() => jump(model, e)}
                                            className="shrink-0 cursor-pointer self-center rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-medium text-ink-mid hover:border-accent hover:text-accent-soft"
                                        >
                                            Jump →
                                        </button>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors in `activitysurface.tsx`.

---

## Task 7: Route the surface + remove the placeholder entry

**Files:**
- Modify: `frontend/app/view/agents/cockpitshell.tsx`
- Modify: `frontend/app/view/agents/placeholdersurface.tsx`

- [ ] **Step 1: Import and route ActivitySurface**

In `frontend/app/view/agents/cockpitshell.tsx`, add the import alongside the other surface imports:

```ts
import { ActivitySurface } from "./activitysurface";
```

Then change the surface switch (currently `cockpit` / `agent` / `PlaceholderSurface`) so the `agent` branch chains into an `activity` branch. Replace:

```tsx
                ) : surface === "agent" ? (
                    <AgentSurface model={model} tabId={tabId} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
```

with:

```tsx
                ) : surface === "agent" ? (
                    <AgentSurface model={model} tabId={tabId} />
                ) : surface === "activity" ? (
                    <ActivitySurface model={model} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
```

- [ ] **Step 2: Drop the now-unused `activity` placeholder title**

In `frontend/app/view/agents/placeholdersurface.tsx`, remove the `activity` line from `TITLES` (activity no longer routes to the placeholder):

```ts
const TITLES: Record<string, string> = {
    channels: "Channels",
    sessions: "Sessions",
    files: "Files",
    memory: "Memory",
    usage: "Usage",
};
```

- [ ] **Step 3: Verify it typechecks**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

---

## Task 8: Full verification + single commit

**Files:** none (verification + commit)

- [ ] **Step 1: Run the full frontend test suite**

Run: `npx vitest run`
Expected: PASS — all pre-existing tests plus the 7 new tests (5 in `activityevents.test.ts`, 2 in `activitystore.test.ts`).

- [ ] **Step 2: Typecheck the whole frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 pre-existing `frontend/tauri/api.test.ts` errors (the documented baseline); nothing in `activity*`, `agents.tsx`, `cockpitshell.tsx`, `placeholdersurface.tsx`.

- [ ] **Step 3: Visual check on the live dev app (CDP)**

Start the dev app if not running (`task dev`), navigate the cockpit to the Activity rail item, then:

Run: `node scripts/cdp-shot.mjs activity-surface.png`
Expected: a PNG showing the Activity header, the six filter chips with colored dots, per-project groups with counts, event rows with colored dots + TYPE labels + "Xm ago", and "Jump →" only on live-session rows. Compare against `wave-handoff/wave/project/Wave-cockpit-live.dc.html:543-575`.

Sanity-check the data path: at least one project group appears (your `~/.claude/projects` has recent waveterm sessions), clicking a type chip filters the feed, and clicking a non-"all" chip with no matching events shows "No recent activity."

- [ ] **Step 4: Self-review the diff**

Run: `git status` and `git --no-pager diff --stat`
Confirm: only the 9 files in the File Structure table are touched; no debug logging, no commented-out code.

- [ ] **Step 5: Present for approval, then commit (single commit)**

Per `CLAUDE.md`, show the file list (M/A/D) + the message, then ask "Awaiting approval. Proceed? (yes/no)". The spec and this plan fold into the same commit. Proposed message:

```
feat(cockpit): Activity surface — cross-project event feed

Phase 2 Activity surface: a recent, type-filterable feed of agent
lifecycle events (Started/Asked/Committed/Errored/Finished) derived from
persisted Claude Code + Codex session transcripts. Zero new Go — reuses
the file-list/transcript RPCs and the per-format parsing conventions.
Bounded to a 7-day window + 200-event cap; Jump is live-only (historical
jump deferred to the Sessions surface).
```

On approval:

```bash
git add docs/superpowers/specs/2026-06-26-cockpit-activity-surface-design.md \
        docs/superpowers/plans/2026-06-26-cockpit-activity-surface.md \
        frontend/app/view/agents/activityevents.ts \
        frontend/app/view/agents/activityevents.test.ts \
        frontend/app/view/agents/activitydiscovery.ts \
        frontend/app/view/agents/activitystore.ts \
        frontend/app/view/agents/activitystore.test.ts \
        frontend/app/view/agents/activitysurface.tsx \
        frontend/app/view/agents/agents.tsx \
        frontend/app/view/agents/cockpitshell.tsx \
        frontend/app/view/agents/placeholdersurface.tsx
git commit
```

---

## Self-review

**1. Spec coverage:**
- §2 Activity↔Sessions boundary → enforced by Task 6 (live-only Jump) + Task 3/5 bounds. ✓
- §3 file-derived, both agents, root discriminator, Codex subagent exclusion → Tasks 2 (subagent exclusion), 4 (roots). ✓
- §4 architecture (4 modules + atoms) → Tasks 1–6. ✓
- §5 taxonomy + raw-line extraction → Tasks 1–2. ✓ (Started/Finished derived from first/last record ts rather than hooks — within the spec's stated "first turn / last turn" fallback; hook lines are not reliably present.)
- §6 bounds + load lifecycle (7d/200/newest-first, live-as-flagged-file, no dedupe) → Task 3 loader + Task 4 discovery. ✓ (Refinement vs spec's "live merge": live sessions are recent files flagged `live=true`; no separate live path — strictly simpler, same result.)
- §7 UI parity + theme tokens → Task 6. ✓
- §8 Jump live-only, ended rows omit button → Task 6 `jump()` + conditional render. ✓
- §9 reuse map → `extractAiTitle`, `projectNameFromTranscriptPath`, `FileListCommand`, `GetAgentTranscriptCommand`, `focusIdAtom`/`surfaceAtom`, theme tokens all used. ✓
- §10 tests → Tasks 1–3 unit tests; §10 visual → Task 8 CDP. ✓
- §11 deferred (Codex "Asked" absent, subagent exclusion, historical Jump, commit precision) → reflected in code comments + behavior. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**3. Type consistency:** `ActivityEvent`/`ActivityType`/`ExtractBase` defined in Task 1 and used identically in Tasks 2–6. `SessionDescriptor` defined in Task 4 matches the loader's usage in Task 3 (`path`, `agent`, `project`, `name`, `modtime`). `extractEvents`/`extractClaudeEvents`/`extractCodexEvents`, `applyFilter`/`groupByProject`/`loadActivity`/`activityEventsAtom`, `discoverSessions` — names consistent across tasks. `activityFilterAtom` typed `ActivityType | "all"` in Task 5 and consumed as such in Task 6. ✓
```
