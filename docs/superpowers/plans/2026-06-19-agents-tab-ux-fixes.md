# Agents Tab UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix ten UX/correctness issues on the Wave Terminal Agents view and its sidebar entry, in four independently-shippable phases.

**Architecture:** The Agents view is a pure projection of `sessionSidebarViewModelAtom` + per-block `agent:status`/`agent:ask` WPS events. New logic lands in the pure modules (`agentsviewmodel.ts`, `transcriptprojection.ts`, `sessionviewmodel.ts`) with vitest unit tests; React components stay thin. Only Phase 3 opens a write path back to the agent (reusing the existing `ControllerInputCommand` RPC). No backend changes; no `task generate`.

**Tech Stack:** TypeScript, React 19, Jotai, Tailwind v4, motion/react, react-markdown, vitest. Go backend untouched.

---

## Conventions for every task

- **Test runner:** `npx vitest run <file>` for one file; `npm test` watches. Run from the project root (`C:\Users\kael02\IdeaProjects\waveterm`) — never `cd` into a subdir.
- **Imports:** `@/...` for cross-tree, relative only within the same dir. Named exports only. 4-space indent.
- **Null checks off:** use `== null` / `!= null`, never `=== undefined`.
- **Commits (IMPORTANT — repo owner's git workflow overrides the skill's per-task commits):** Do **not** commit per task. Each phase ends with a single commit step that **requires explicit user approval first** (show files + message, ask "Awaiting approval. Proceed? (yes/no)"). Before committing, re-check `git status`/branch (shared working tree). Conventional commits: `type(scope): description`.
- **Comments:** only "why", lowercase, only when non-obvious. Never describe what the code does.

## File Structure

**Phase 1**
- Modify `frontend/app/tab/sessionsidebar/sessionviewmodel.ts` — `isAgentsTab` on `SessionInput`/`SessionRowVM`; `rowLabel` suffix suppression (#7).
- Modify `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts` — detect the agents block, set `isAgentsTab` (#7).
- Modify `frontend/app/tab/sessionsidebar/sessionrow.tsx` — accept `isAgentsTab`, hide pin (#7).
- Modify `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` — pass `isAgentsTab`; badge padding (#10).
- Modify `frontend/app/view/agents/outputpanel.tsx` — stable-width meta (#5).
- Create `frontend/app/view/agents/markdownmessage.tsx` — lightweight markdown renderer (#4).
- Modify `frontend/app/view/agents/narrationtimeline.tsx` — render messages via markdown; render `user` entries (#4, #8).
- Modify `frontend/app/view/agents/transcriptprojection.ts` — project `user` text turns (#8).
- Modify `frontend/app/view/agents/agentsviewmodel.ts` — `AgentEntry` `user` variant (#8); `isAskStale` (#9).
- Modify `frontend/app/view/agents/liveagents.ts` — drop stale asks (#9).
- Create `frontend/app/view/agents/idlesection.tsx` — collapsed idle section (#3).
- Modify `frontend/app/view/agents/agents.tsx` — render idle section (#3).
- Tests: `sessionviewmodel.test.ts`, `agentsviewmodel.test.ts`, create `transcriptprojection.test.ts`.

**Phase 2**
- Create `frontend/app/view/agents/statusdot.tsx` — shared status dot (#1).
- Modify `askcard.tsx`, `outputpanel.tsx` — use `StatusDot` (#1).
- Modify `sessionrow.tsx` only if the sidebar-dot root cause is in-repo (#1, after diagnosis).

**Phase 3**
- Create `frontend/app/view/agents/agentcomposer.tsx` — per-panel input (#6).
- Modify `agentsviewmodel.ts` — `blockId` on `AgentVM`/`LiveAgentInput`/`agentVMFromInput` (#6).
- Modify `liveagents.ts` — populate `blockId` (#6).
- Modify `outputpanel.tsx`, `askcard.tsx`, `idlesection.tsx` — mount the composer (#6).

**Phase 4**
- Create `frontend/app/view/agents/panelsizes.ts` — in-memory size store (#2).
- Modify `agentsviewmodel.ts` — `reorderList` pure helper (#2).
- Modify `agents.tsx` — flex-wrap container + DnD reorder + resize wrapper (#2).
- Modify `outputpanel.tsx` — drag handle on the header (#2).

---

# PHASE 1 — Presentation + correctness

### Task 1: Sidebar — Agents tab label has no service suffix (#7, pure)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`
- Test: `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `sessionviewmodel.test.ts` (inside the existing `describe("buildSessionViewModel", ...)` or a new describe):

```ts
it("agents tab is pinned with no service suffix and is flagged", () => {
    const out = buildSessionViewModel([
        {
            tabId: "t1",
            name: "Agents",
            pinned: true,
            serviceLabel: "ungrouped",
            status: "idle",
            active: false,
            isAgentsTab: true,
        } as SessionInput,
    ]);
    expect(out.pinned).toHaveLength(1);
    expect(out.pinned[0].label).toBe("Agents");
    expect(out.pinned[0].isAgentsTab).toBe(true);
});

it("a normal pinned row still gets the service suffix", () => {
    const out = buildSessionViewModel([
        { tabId: "t2", name: "loom", pinned: true, serviceLabel: "waveterm", status: "idle", active: false } as SessionInput,
    ]);
    expect(out.pinned[0].label).toBe("loom · waveterm");
});
```

Ensure `SessionInput` is imported in the test (it already imports from `./sessionviewmodel`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: FAIL — `isAgentsTab` not on the VM / label still `"Agents · ungrouped"`.

- [ ] **Step 3: Add `isAgentsTab` to the interfaces and use it in `rowLabel`/`toRow`**

In `sessionviewmodel.ts`, add the field to `SessionInput` (after `pinned: boolean;`):

```ts
    isAgentsTab?: boolean;
```

Add to `SessionRowVM` (after `pinned: boolean;`):

```ts
    isAgentsTab?: boolean;
```

Change `rowLabel` to suppress the suffix for the agents tab:

```ts
function rowLabel(s: SessionInput, includeService: boolean): string {
    const custom = s.customLabel && s.customLabel.length > 0 ? s.customLabel : undefined;
    const agent = s.agent && s.agent.length > 0 ? s.agent : s.name;
    const base = custom ?? (agent && agent.length > 0 ? agent : "session");
    return includeService && !s.isAgentsTab ? `${base} · ${s.serviceLabel}` : base;
}
```

In `toRow`, carry the flag onto the VM (add to the returned object):

```ts
        isAgentsTab: s.isAgentsTab ?? false,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`
Expected: PASS.

### Task 2: Sidebar model — detect the agents block (#7)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts:40-91`

- [ ] **Step 1: Detect the agents view block in the per-tab loop**

In the `sessions` map, the block loop currently only finds the term block. Add agents detection. Replace the loop and the returned object's tail:

```ts
        let cwd: string | undefined;
        let termBlockId: string | undefined;
        let isAgentsTab = false;
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "agents") {
                isAgentsTab = true;
            }
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwd = block.meta["cmd:cwd"];
                termBlockId = blockId;
                break;
            }
        }
```

Add `isAgentsTab` to the returned `SessionInput` object (alongside `pinned`):

```ts
            isAgentsTab,
```

- [ ] **Step 2: Verify no type errors**

Confirm VSCode shows no problems in `sessionsidebarmodel.ts`. (Per repo rules, no errors == compiles.)

### Task 3: Sidebar row — hide the pin icon on the agents tab (#7)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx:29-77,206-215`

- [ ] **Step 1: Add the prop**

In `SessionRowProps` add (after `pinned: boolean;`):

```ts
    isAgentsTab?: boolean;
```

Destructure it in the component signature (after `pinned,`):

```ts
    isAgentsTab,
```

- [ ] **Step 2: Guard the thumbtack render**

Wrap the existing pin `<i>` (the `makeIconClass("thumbtack", true)` block near the end of `SessionRow`) so it does not render for the agents tab:

```tsx
            {!isAgentsTab && (
                <i
                    className={cn(
                        makeIconClass("thumbtack", true) + " text-[10px]",
                        pinned ? "opacity-90" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
                    )}
                    onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin();
                    }}
                />
            )}
```

### Task 4: Sidebar — pass the flag + fix the "N asking" badge padding (#7, #10)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx` (SessionRow render site; badge at `:177`)

- [ ] **Step 1: Pass `isAgentsTab` to every `SessionRow`**

Find where `<SessionRow ... />` is rendered (it maps over `vm.pinned` and each group's `sessions`). Add the prop from the row VM:

```tsx
                            isAgentsTab={row.isAgentsTab}
```

(Use the same variable name the existing map uses for the row; if it is `s` or `session`, use `s.isAgentsTab`.)

- [ ] **Step 2: Fix the badge padding**

At `sessionsidebar.tsx:177`, change the badge className from:

```tsx
                            className="ml-auto rounded-[9px] bg-[#d29922] px-2 text-[10px] font-bold text-black"
```

to:

```tsx
                            className="ml-auto rounded-[9px] bg-[#d29922] px-2 py-0.5 text-[10px] font-bold leading-none text-black"
```

- [ ] **Step 3: Verify in the dev app**

Launch the dev app (see "Running the dev app" at the bottom). Confirm: the Agents row reads "Agents" (no "· ungrouped"), has no pin icon, and the "1 asking" pill has even vertical padding.

### Task 5: Working panel — stop the per-second layout shift (#5)

**Files:**
- Modify: `frontend/app/view/agents/outputpanel.tsx:83-100`

- [ ] **Step 1: Make the meta strip fixed-width / tabular**

The right-side meta span (the one with `ml-auto ... text-[11px]`) reflows because the age/`since` strings change width each tick. Add `tabular-nums` and right-align with a reserved width so digit/label changes don't move the task label. Change the opening of that `<span>`:

```tsx
                <span className={cn("ml-auto flex shrink-0 items-center gap-1 tabular-nums text-[11px]", quiet ? "text-[#d29922]" : "text-[#7d8896]")}>
```

Wrap the `since` value in a fixed-width, right-aligned inline-block so "9s" → "10s" → "1m" don't shift neighbors. Replace the `<span>{since}</span>` with:

```tsx
                            <span className="inline-block w-7 text-right">{since}</span>
```

- [ ] **Step 2: Verify in the dev app**

With a working agent streaming, watch the header for ~10s. Expected: the model/age/since text updates without the task label jumping.

### Task 6: Lightweight markdown for agent messages (#4)

**Files:**
- Create: `frontend/app/view/agents/markdownmessage.tsx`
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`

- [ ] **Step 1: Create the markdown renderer**

`frontend/app/view/agents/markdownmessage.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Lightweight inline markdown for narration lines. Deliberately NOT the full element/markdown.tsx
// (which wraps every render in OverlayScrollbars + a TOC + rehypeRaw); raw HTML is not enabled here,
// so transcript text cannot inject markup.
export function MarkdownMessage({ text, className }: { text: string; className?: string }) {
    return (
        <div className={cn("agent-md", className)}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
    );
}
```

- [ ] **Step 2: Render messages through it in the timeline**

In `narrationtimeline.tsx`, import it:

```ts
import { MarkdownMessage } from "./markdownmessage";
```

In the `e.kind === "message"` branch, replace the bare `{e.text}` with:

```tsx
                        <MarkdownMessage text={e.text} />
```

- [ ] **Step 3: Add minimal prose styling**

Append to `frontend/app/view/agents/` styles — if there is no view-local stylesheet, add the rules to `frontend/tailwindsetup.css` under a clearly-scoped selector. Add:

```css
.agent-md p { margin: 0 0 0.4em; }
.agent-md p:last-child { margin-bottom: 0; }
.agent-md ul, .agent-md ol { margin: 0.2em 0 0.4em 1.1em; }
.agent-md code { font-size: 0.92em; background: rgba(255,255,255,0.06); padding: 0 3px; border-radius: 3px; }
.agent-md pre { background: rgba(255,255,255,0.05); padding: 8px; border-radius: 6px; overflow-x: auto; }
.agent-md h1, .agent-md h2, .agent-md h3 { font-size: 1em; font-weight: 600; margin: 0.3em 0; }
```

- [ ] **Step 4: Verify in the dev app**

With an agent emitting markdown (lists, `code`, bold), confirm it renders formatted, not literal, and code blocks scroll horizontally inside the panel rather than widening it.

### Task 7: Project the user's own turns (#8, pure)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:7-10` (AgentEntry type)
- Modify: `frontend/app/view/agents/transcriptprojection.ts:54-104`
- Test: create `frontend/app/view/agents/transcriptprojection.test.ts`

- [ ] **Step 1: Extend the AgentEntry union**

In `agentsviewmodel.ts`, change the `AgentEntry` type to add the user variant:

```ts
export type AgentEntry =
    | { kind: "message"; text: string }
    | { kind: "user"; text: string }
    | { kind: "action"; verb: string; target: string; outcome?: "ok" | "fail"; note?: string };
```

- [ ] **Step 2: Write the failing test**

Create `frontend/app/view/agents/transcriptprojection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectTranscript } from "./transcriptprojection";

const L = (obj: unknown) => JSON.stringify(obj);

describe("projectTranscript user turns", () => {
    it("projects a user string turn as a user entry, in order", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
            L({ type: "user", message: { content: "do the thing" } }),
        ]);
        expect(out).toEqual([
            { kind: "message", text: "Hello" },
            { kind: "user", text: "do the thing" },
        ]);
    });

    it("projects a user text block as a user entry", () => {
        const out = projectTranscript([
            L({ type: "user", message: { content: [{ type: "text", text: "option B" }] } }),
        ]);
        expect(out).toEqual([{ kind: "user", text: "option B" }]);
    });

    it("emits no user entry for a tool_result-only record but still applies the outcome", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
            L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ kind: "action", verb: "ran", outcome: "ok" });
    });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: FAIL — user entries not produced; first test gets only the assistant message.

- [ ] **Step 4: Rework the loop to handle user text (string + blocks)**

In `transcriptprojection.ts`, replace the body of `projectTranscript`'s `for (const line of lines)` loop with this structure (the assistant branch is unchanged in behavior; the array guard moves inside each branch so string user content is reachable):

```ts
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec.type === "assistant") {
            const content = rec?.message?.content;
            if (!Array.isArray(content)) {
                continue;
            }
            for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
                    entries.push({ kind: "message", text: block.text });
                    continue;
                }
                if (block?.type === "tool_use" && typeof block.name === "string") {
                    const action: ActionEntry = { kind: "action", verb: verbFor(block.name), target: targetFor(block.input) };
                    entries.push(action);
                    if (typeof block.id === "string") {
                        actionById.set(block.id, action);
                    }
                }
            }
            continue;
        }
        if (rec.type === "user") {
            const content = rec?.message?.content;
            if (typeof content === "string") {
                if (content.trim() !== "") {
                    entries.push({ kind: "user", text: content });
                }
                continue;
            }
            if (!Array.isArray(content)) {
                continue;
            }
            for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
                    entries.push({ kind: "user", text: block.text });
                    continue;
                }
                if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
                    continue;
                }
                const action = actionById.get(block.tool_use_id);
                if (action == null) {
                    continue;
                }
                if (block.is_error === true) {
                    action.outcome = "fail";
                } else if (action.verb === "ran") {
                    action.outcome = "ok";
                }
            }
        }
    }
```

Keep the existing `const entries: AgentEntry[] = [];` and `const actionById = ...` lines above the loop, and the `return entries;` below it.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Then run the existing suite to confirm no regression: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS for both.

### Task 8: Render user turns inline, Claude-Code style (#8)

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`

- [ ] **Step 1: Add a render branch for `kind: "user"`**

In the `.map`, the conditional currently handles `message` vs (else) `action`. Make it explicit. Change `e.kind === "message" ? (...) : (...)` to first handle `user`. Add this branch (before the action fallback). Replace the `entries.map((e, i) => e.kind === "message" ? (` opening so the chain is message → user → action:

```tsx
            {entries.map((e, i) =>
                e.kind === "message" ? (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, ease: "easeOut" }}
                        className={cn(
                            "mt-2.5 text-[13px]",
                            i === lastMessageIdx ? "border-l-2 border-[#3fb950] pl-2 text-[#f0f6fc]" : "text-[#dde3ea]"
                        )}
                    >
                        <MarkdownMessage text={e.text} />
                    </motion.div>
                ) : e.kind === "user" ? (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, ease: "easeOut" }}
                        className="mt-2.5 flex gap-1.5 text-[12.5px] text-[#7d8896]"
                    >
                        <span className="select-none text-[#6b7585]">&gt;</span>
                        <span className="whitespace-pre-wrap">{e.text}</span>
                    </motion.div>
                ) : (
```

Leave the existing action `motion.div` as the final `(...)` branch and the closing `)` unchanged.

- [ ] **Step 2: Verify in the dev app**

In a panel where you answered a question, confirm your answer appears inline with a muted `>` marker, distinct from the agent's markdown output.

### Task 9: Self-healing ask-clear (#9, pure + wiring)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Modify: `frontend/app/view/agents/liveagents.ts:32-59`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `agentsviewmodel.test.ts`:

```ts
import { isAskStale } from "./agentsviewmodel"; // add to the existing import list at top

describe("isAskStale", () => {
    it("stale when a newer working/idle status supersedes the ask", () => {
        expect(isAskStale(1_000, 2_000, "working")).toBe(true);
        expect(isAskStale(1_000, 2_000, "idle")).toBe(true);
    });
    it("not stale while waiting, when status is not newer, or when a ts is missing", () => {
        expect(isAskStale(1_000, 2_000, "waiting")).toBe(false);
        expect(isAskStale(1_000, 1_000, "working")).toBe(false);
        expect(isAskStale(1_000, 500, "working")).toBe(false);
        expect(isAskStale(undefined, 2_000, "working")).toBe(false);
        expect(isAskStale(1_000, undefined, "working")).toBe(false);
    });
});
```

(Adjust the top `import { ... } from "./agentsviewmodel"` to include `isAskStale` rather than adding a second import line.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `isAskStale` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `agentsviewmodel.ts` (near `withAsk`):

```ts
/** Pure: a pending ask is stale once the agent has demonstrably resumed — a newer status update
 *  (statusTs > askTs) reporting working/idle. A blocked agent emits no fresh working/idle status
 *  until it resumes, so this only fires after the question was resolved by some path (terminal,
 *  panel, or the agent moving on). The PostToolUse clear hook is the fast path; this is the fallback. */
export function isAskStale(askTs: number | undefined, statusTs: number | undefined, statusState: string): boolean {
    if (askTs == null || statusTs == null) {
        return false;
    }
    if (statusState !== "working" && statusState !== "idle") {
        return false;
    }
    return statusTs > askTs;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply it in the live roster**

In `liveagents.ts`, import `isAskStale`:

```ts
import { agentVMFromInput, askingCount, isAskStale, withAsk, type AgentEntry, type AgentVM } from "./agentsviewmodel";
```

In `liveAgentBaseAtom`, replace the final push line that calls `withAsk(...)` with a stale check:

```ts
        const ask = get(getAgentAskAtom(row.termBlockOref));
        const effectiveAsk = ask && !isAskStale(ask.ts, status.ts, status.state) ? ask : null;
        agents.push(withAsk(vm, effectiveAsk, now));
```

(`status` is the `getAgentStatusAtom(row.termBlockOref)` value already read above in this loop; `status.ts` and `status.state` are on `AgentStatusData`.)

- [ ] **Step 6: Verify in the dev app**

Trigger an agent question (panel shows the AskCard), then answer it **in the agent's own terminal tab**. Expected: within one status update, the AskCard clears from the Agents tab on its own.

### Task 10: Idle agents — collapsed, expandable section (#3)

**Files:**
- Create: `frontend/app/view/agents/idlesection.tsx`
- Modify: `frontend/app/view/agents/agents.tsx:60-62,124,216-217`

- [ ] **Step 1: Create the idle section component**

`frontend/app/view/agents/idlesection.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatAge, type AgentVM } from "./agentsviewmodel";

export function IdleSection({ agents, onOpen }: { agents: AgentVM[]; onOpen: (id: string) => void }) {
    const [open, setOpen] = useState(false);
    if (agents.length === 0) {
        return null;
    }
    return (
        <div className="shrink-0">
            <div
                className="flex cursor-pointer items-center gap-2 py-1.5 text-[11px] text-[#8b949e]"
                onClick={() => setOpen((v) => !v)}
            >
                <span className="text-[9px]">{open ? "▾" : "▸"}</span>
                <span className="uppercase tracking-wide">Idle</span>
                <span className="ml-auto tabular-nums opacity-70">{agents.length}</span>
            </div>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        className="flex flex-col gap-1 overflow-hidden"
                    >
                        {agents.map((a) => (
                            <div
                                key={a.id}
                                onClick={() => onOpen(a.id)}
                                className="flex cursor-pointer items-center gap-2.5 rounded-[6px] px-2 py-1.5 hover:bg-white/[0.04]"
                            >
                                <span className="h-2 w-2 shrink-0 rounded-full bg-[#7d8590]" />
                                <b className="shrink-0 text-[12.5px] text-[#c9d1d9]">{a.name}</b>
                                <span className="truncate text-[12px] text-[#6b7585]">{a.activity}</span>
                                <span className="ml-auto shrink-0 text-[10.5px] text-[#6b7585]">{formatAge(a.activeMs)} idle</span>
                            </div>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
```

- [ ] **Step 2: Render it in AgentsView**

In `agents.tsx`, destructure idle (line ~62):

```ts
    const { asking, working, idle } = groupAgents(agents);
```

Update the `empty` check (line ~124) so a tab with only idle agents is not "empty":

```ts
    const empty = asking.length === 0 && working.length === 0 && idle.length === 0;
```

Import the section near the other imports:

```ts
import { IdleSection } from "./idlesection";
```

Render it after the `working.length > 0` grid block (just before the closing `</div>` of the content area at line ~217):

```tsx
                <IdleSection agents={idle} onOpen={open} />
```

- [ ] **Step 3: Verify in the dev app**

With at least one finished (idle) agent, confirm an "Idle N" header appears at the bottom, collapsed by default, and expands to compact rows that open the terminal on click.

### Task 11: Phase 1 commit (gated)

- [ ] **Step 1: Run the full agents + sidebar test suites**

Run: `npx vitest run frontend/app/view/agents/ frontend/app/tab/sessionsidebar/`
Expected: all PASS.

- [ ] **Step 2: Self-review the diff**

Run: `git status` and `git --no-pager diff --stat`. Confirm only the Phase 1 files changed; re-check the branch (shared working tree).

- [ ] **Step 3: Request approval, then commit**

Show the file list + proposed message, ask "Awaiting approval. Proceed? (yes/no)". On yes:

```bash
git add frontend/app/view/agents/ frontend/app/tab/sessionsidebar/
git commit -m "feat(agents): markdown narration, idle section, user turns, self-healing ask-clear, sidebar polish"
```

---

# PHASE 2 — Live status dots (#1)

### Task 12: Shared status dot for the in-view panels (#1)

**Files:**
- Create: `frontend/app/view/agents/statusdot.tsx`
- Modify: `frontend/app/view/agents/askcard.tsx:120`, `frontend/app/view/agents/outputpanel.tsx:70-77`

- [ ] **Step 1: Create the dot component**

`frontend/app/view/agents/statusdot.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { motion } from "motion/react";
import type { AgentState } from "./agentsviewmodel";

// Single source of truth for the in-view dot. Colors mirror the sidebar STATUS_COLOR map.
const COLOR: Record<AgentState, string> = { asking: "#d29922", working: "#3fb950", idle: "#7d8590" };

export function StatusDot({ state, quiet, className }: { state: AgentState; quiet?: boolean; className?: string }) {
    const hollow = state === "working" && quiet;
    return (
        <motion.span
            className={cn("h-2 w-2 shrink-0 rounded-full", hollow ? "border border-[#4a5260] bg-transparent" : "", className)}
            style={hollow ? undefined : { backgroundColor: COLOR[state] }}
            animate={
                state === "working" && !quiet
                    ? { scale: [1, 1.25, 1], opacity: [1, 0.7, 1] }
                    : state === "asking"
                      ? { opacity: [1, 0.5, 1] }
                      : { scale: 1, opacity: 1 }
            }
            transition={
                state === "idle" || hollow
                    ? { duration: 0 }
                    : { duration: state === "working" ? 1.6 : 1.2, repeat: Infinity, ease: "easeInOut" }
            }
        />
    );
}
```

- [ ] **Step 2: Use it in the working panel**

In `outputpanel.tsx`, import `StatusDot` and replace the existing `motion.span` dot (the one with `quiet ? "border ... bg-transparent" : "bg-[#3fb950]"`) with:

```tsx
                <StatusDot state="working" quiet={quiet} />
```

- [ ] **Step 3: Use it in the ask card**

In `askcard.tsx`, import `StatusDot` and replace the static `<span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />` with:

```tsx
                    <StatusDot state="asking" />
```

- [ ] **Step 4: Verify in the dev app**

Confirm the working dot pulses green (hollow when quiet) and the ask dot pulses amber, consistent with the sidebar.

### Task 13: Diagnose the sidebar dot (#1) — investigation, then conditional fix

**Files:**
- Read/modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx:117-132`, `frontend/app/tab/sessionsidebar/agentstatusstore.ts`

> This task is a diagnosis. Use superpowers:systematic-debugging. Do **not** change code before the cause is confirmed.

- [ ] **Step 1: Reproduce**

Launch the dev app with an agent that transitions working → waiting → working. Watch the sidebar dot. Record what you see (color changes? never changes? changes only on reload?).

- [ ] **Step 2: Confirm whether the data changes**

Verify the `agent:status` events arrive with changing `state`. Either: (a) connect over CDP (dev app exposes :9222 — see the `cdp-verify-dev-app` note) and read the atom, or (b) temporarily add `console.log("agent:status", data.oref, data.state)` in `agentstatusstore.ts`'s handler (`setupAgentStatusSubscription`), reproduce, then read it via `read_console_messages` / DevTools. Remove the log after.

- [ ] **Step 3: Branch on the finding**

- **If the state value changes but the dot color does not:** the render is the bug. Most likely the `motion.span`'s `animate` prop is interfering with the inline `style.backgroundColor`. Fix: drive the color through motion by passing it in `animate` (e.g. `animate={{ backgroundColor: STATUS_COLOR[status], ...}}`) instead of (or in addition to) the static `style`, OR add `key={status}` to force a remount on status change. Apply the minimal change in `sessionrow.tsx:117-132`, re-verify.
- **If the state value does NOT change (events absent or stuck):** the cause is upstream (the external reporter / hook wiring, outside this repo). Do not patch the view. Document the finding and the exact missing/stale event, and report it as an external follow-up.

- [ ] **Step 4: Record the outcome**

Write a one-paragraph result (cause + fix-or-deferred) into the plan's Phase 2 notes section below.

### Task 14: Phase 2 commit (gated)

- [ ] **Step 1:** `npx vitest run frontend/app/view/agents/` — confirm green (no logic changed, but guard against accidental breakage).
- [ ] **Step 2:** Self-review the diff; re-check branch.
- [ ] **Step 3:** Request approval, then commit:

```bash
git add frontend/app/view/agents/statusdot.tsx frontend/app/view/agents/askcard.tsx frontend/app/view/agents/outputpanel.tsx frontend/app/tab/sessionsidebar/sessionrow.tsx
git commit -m "feat(agents): unify live status dot in the agents view (+ sidebar dot fix if in-repo)"
```

(Drop `sessionrow.tsx` from the add if Task 13 concluded the cause is external.)

**Phase 2 notes (Task 13 outcome — DIAGNOSED 2026-06-19, no in-repo fix):**

Controlled CDP reproduction in the dev app: drove one block (T6) through working→waiting→working via injected `agent:status` events and read the dot after each transition. The dot color tracked every transition — `var(--color-accent)` (working) → `var(--color-warning)` (waiting) → `var(--color-accent)` (working, captured mid-tween at `rgb(129,191,72)` as the 300ms CSS `transition-[background-color]` ran). Other agents' injected dots (asking=warning, idle=muted) resolved to the exact `@theme` RGBs too.

**Root cause: there is no in-repo render bug.** The chain `agent:status` → `agentstatusstore` (sets the atom on every truthy `state`, `agentstatusstore.ts:107-108`) → `sessionSidebarViewModelAtom` → `SessionRow` → `style={{backgroundColor: STATUS_COLOR[status]}}` + CSS transition works end-to-end. The plan's hypothesized interference (motion `animate` overriding the inline `backgroundColor`) is disproven: `animate` only drives `scale`/`opacity` (`sessionrow.tsx:122-128`), never `backgroundColor`. Any real-world "stuck sidebar dot" is therefore **upstream event delivery** — the out-of-repo status reporter not emitting changed states — not a view defect. **Resolution: branch (b) — do not patch the view; `sessionrow.tsx` is excluded from the Phase 2 commit. External follow-up: verify the reporter emits a fresh `agent:status` on each working/waiting transition.**

---

# PHASE 3 — Per-agent input (#6)

### Task 15: Thread the terminal blockId into AgentVM (#6, pure)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts:30-42,99-129`
- Modify: `frontend/app/view/agents/liveagents.ts:44-56`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `describe("agentVMFromInput", ...)` block:

```ts
    it("carries the terminal blockId", () => {
        const vm = agentVMFromInput({ id: "tab-1", name: "x", status: "working", blockId: "uuid-1" }, NOW);
        expect(vm.blockId).toBe("uuid-1");
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `blockId` not on `LiveAgentInput` / not copied.

- [ ] **Step 3: Add the field and copy it**

In `agentsviewmodel.ts`: add to `AgentVM` (after `transcriptPath?`):

```ts
    blockId?: string; // terminal block OID — target for ControllerInputCommand
```

Add to `LiveAgentInput` (after `transcriptPath?`):

```ts
    blockId?: string;
```

In `agentVMFromInput`, add to the `vm` object literal (after `transcriptPath: input.transcriptPath,`):

```ts
        blockId: input.blockId,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (existing `toEqual` tests tolerate the extra `blockId: undefined`).

- [ ] **Step 5: Populate it in the live roster**

In `liveagents.ts`, inside `liveAgentBaseAtom`'s loop, derive the OID from `row.termBlockOref` ("block:<uuid>") and pass it into `agentVMFromInput`'s input object (add the field next to `transcriptPath`):

```ts
                blockId: row.termBlockOref?.split(":")[1],
```

### Task 16: The per-panel composer component (#6)

**Files:**
- Create: `frontend/app/view/agents/agentcomposer.tsx`

- [ ] **Step 1: Create it**

`frontend/app/view/agents/agentcomposer.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget, stringToBase64 } from "@/util/util";
import { useState } from "react";

// Sends free text to an agent's terminal block. "\r" submits (the PTY treats CR as Enter), mirroring
// how term-model writes xterm input via ControllerInputCommand.
export function AgentComposer({ blockId, placeholder }: { blockId?: string; placeholder: string }) {
    const [text, setText] = useState("");
    const send = () => {
        const t = text.trim();
        if (!t || !blockId) {
            return;
        }
        fireAndForget(() =>
            RpcApi.ControllerInputCommand(TabRpcClient, { blockid: blockId, inputdata64: stringToBase64(t + "\r") })
        );
        setText("");
    };
    return (
        <div className="flex shrink-0 items-center gap-2 border-t border-[#1c2230] px-[14px] py-2">
            <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        send();
                    }
                }}
                placeholder={placeholder}
                className="min-w-0 flex-1 rounded-[6px] border border-[#2c3340] bg-transparent px-2.5 py-1 text-[12px] text-[#e6edf3] outline-none placeholder:text-[#6b7585]"
            />
            <button
                type="button"
                onClick={send}
                disabled={!text.trim() || !blockId}
                className="shrink-0 cursor-pointer rounded-[5px] border border-[#2c3340] px-2.5 py-1 text-[11px] text-[#c9d1d9] hover:bg-white/[0.04] disabled:opacity-40"
            >
                Send
            </button>
        </div>
    );
}
```

### Task 17: Mount the composer in the working panel, ask card, and idle rows (#6)

**Files:**
- Modify: `frontend/app/view/agents/outputpanel.tsx`
- Modify: `frontend/app/view/agents/askcard.tsx`
- Modify: `frontend/app/view/agents/idlesection.tsx`

- [ ] **Step 1: Working panel footer**

In `outputpanel.tsx`, import `AgentComposer`. Add it as the last child of the panel's outer `div` (after the scroll area and the new-pill `AnimatePresence`):

```tsx
            <AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} />
```

- [ ] **Step 2: Ask card free-text reply**

In `askcard.tsx`, import `AgentComposer`. Add it just before the closing `</div>` of the card (after the Submit row), so the human can type a custom reply instead of picking an option:

```tsx
            <AgentComposer blockId={agent.blockId} placeholder={`reply to ${agent.name}…`} />
```

- [ ] **Step 3: Idle expanded row**

In `idlesection.tsx`, import `AgentComposer`. Inside each expanded idle row container, add the composer below the row content so a finished agent can be re-prompted:

```tsx
                                <AgentComposer blockId={a.blockId} placeholder={`message ${a.name}…`} />
```

(Move the row's inner content into a column `div` if needed so the composer sits beneath the name/activity line rather than inline.)

- [ ] **Step 4: Verify in the dev app**

For a working agent and a finished (idle) agent: type a message + Enter, and confirm it appears in that agent's terminal (open the terminal to check) and the agent acts on it. Confirm the Send button is disabled when empty or when `blockId` is missing.

### Task 18: Phase 3 commit (gated)

- [ ] **Step 1:** `npx vitest run frontend/app/view/agents/` — green.
- [ ] **Step 2:** Self-review diff; re-check branch.
- [ ] **Step 3:** Request approval, then commit:

```bash
git add frontend/app/view/agents/
git commit -m "feat(agents): per-panel composer to message working/idle/asking agents"
```

---

# PHASE 4 — Resizable / reorderable working grid (#2)

### Task 19: Pure reorder helper (#2, pure)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `agentsviewmodel.test.ts` (and add `reorderList` to the top import):

```ts
describe("reorderList", () => {
    it("moves an id before/after a target", () => {
        expect(reorderList(["a", "b", "c"], "a", "c", false)).toEqual(["b", "c", "a"]);
        expect(reorderList(["a", "b", "c"], "c", "a", true)).toEqual(["c", "a", "b"]);
    });
    it("no-ops on self, or when an id is absent", () => {
        expect(reorderList(["a", "b"], "a", "a", true)).toEqual(["a", "b"]);
        expect(reorderList(["a", "b"], "z", "a", true)).toEqual(["a", "b"]);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `reorderList` not exported.

- [ ] **Step 3: Implement it**

Add to `agentsviewmodel.ts`:

```ts
/** Pure: move draggedId before/after targetId in a flat id list. Returns the input on a no-op
 *  (self-drop, or either id absent). Never mutates the input. */
export function reorderList(ids: string[], draggedId: string, targetId: string, placeBefore: boolean): string[] {
    if (draggedId === targetId || !ids.includes(draggedId) || !ids.includes(targetId)) {
        return ids;
    }
    const without = ids.filter((id) => id !== draggedId);
    const idx = without.indexOf(targetId);
    const at = placeBefore ? idx : idx + 1;
    return [...without.slice(0, at), draggedId, ...without.slice(at)];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS.

### Task 20: In-memory panel size store (#2)

**Files:**
- Create: `frontend/app/view/agents/panelsizes.ts`

- [ ] **Step 1: Create it**

`frontend/app/view/agents/panelsizes.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// In-memory only (resets on full reload — YAGNI). Keyed by agent id so a panel keeps its size
// across re-renders and reorders within a session.
const sizes = new Map<string, { w: number; h: number }>();

export function getPanelSize(id: string): { w: number; h: number } | undefined {
    return sizes.get(id);
}

export function setPanelSize(id: string, w: number, h: number): void {
    sizes.set(id, { w, h });
}
```

### Task 21: Resizable + draggable working grid (#2)

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:192-216`
- Modify: `frontend/app/view/agents/outputpanel.tsx` (drag handle on the header)

- [ ] **Step 1: Track order + drag state in AgentsView**

In `agents.tsx`, add imports:

```ts
import { reorderList } from "./agentsviewmodel";
import { getPanelSize, setPanelSize } from "./panelsizes";
```

Inside `AgentsView`, after the existing `useState`/effects, derive an ordered working list (order persisted in component state, new agents appended, departed ones dropped):

```ts
    const [order, setOrder] = useState<string[]>([]);
    const [dragId, setDragId] = useState<string>();
    useEffect(() => {
        const ids = working.map((w) => w.id);
        setOrder((prev) => {
            const kept = prev.filter((id) => ids.includes(id));
            const added = ids.filter((id) => !kept.includes(id));
            return [...kept, ...added];
        });
    }, [working.map((w) => w.id).join(",")]);
    const orderedWorking = order.map((id) => working.find((w) => w.id === id)).filter(Boolean) as AgentVM[];
```

- [ ] **Step 2: Replace the grid with a flex-wrap of resizable, draggable panels**

Replace the `working.length > 0 && (...)` block's grid container and its `working.map` with:

```tsx
                {working.length > 0 && (
                    <div className="flex min-h-0 flex-1 flex-wrap content-start gap-2.5 overflow-y-auto">
                        <AnimatePresence mode="popLayout">
                            {orderedWorking.map((a) => (
                                <ResizablePanel
                                    key={a.id}
                                    id={a.id}
                                    onDragStart={() => setDragId(a.id)}
                                    onDropOn={(targetId, before) => {
                                        if (dragId) {
                                            setOrder((o) => reorderList(o, dragId, targetId, before));
                                        }
                                        setDragId(undefined);
                                    }}
                                >
                                    <WorkingPanel agent={a} now={now} onOpen={open} />
                                </ResizablePanel>
                            ))}
                        </AnimatePresence>
                    </div>
                )}
```

- [ ] **Step 3: Add the ResizablePanel wrapper in agents.tsx**

Add this component above `AgentsView` in `agents.tsx`:

```tsx
function ResizablePanel({
    id,
    onDragStart,
    onDropOn,
    children,
}: {
    id: string;
    onDragStart: () => void;
    onDropOn: (targetId: string, before: boolean) => void;
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        const saved = getPanelSize(id);
        if (saved) {
            el.style.width = `${saved.w}px`;
            el.style.height = `${saved.h}px`;
        }
        const ro = new ResizeObserver(() => setPanelSize(id, el.offsetWidth, el.offsetHeight));
        ro.observe(el);
        return () => ro.disconnect();
    }, [id]);
    return (
        <motion.div
            ref={ref}
            layout
            layoutId={id}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                onDropOn(id, e.clientX < rect.left + rect.width / 2);
            }}
            style={{ width: 420, height: 260, minWidth: 320, minHeight: 180, resize: "both", overflow: "hidden" }}
            className="relative"
            data-agent-id={id}
        >
            <div
                draggable
                onDragStart={onDragStart}
                className="absolute right-2 top-2 z-10 cursor-grab select-none text-[12px] text-[#6b7585] active:cursor-grabbing"
                title="Drag to reorder"
            >
                ⠿
            </div>
            {children}
        </motion.div>
    );
}
```

Note: the inline `style` sets the *initial* size and enables CSS `resize`; the browser then mutates inline width/height on drag, which the `ResizeObserver` records into the size store. On re-mount the saved size is re-applied. `motion`'s `layout` is kept for reorder animation; if resize and layout animation fight, drop `layout`/`layoutId` from this wrapper.

- [ ] **Step 4: Verify in the dev app**

With 2-3 working agents: drag a panel's corner to resize (width + height both change and stick across the 1s ticks); drag the ⠿ handle onto another panel to reorder. Confirm a third panel wraps to a new row rather than squeezing.

### Task 22: Phase 4 commit (gated)

- [ ] **Step 1:** `npx vitest run frontend/app/view/agents/` — green.
- [ ] **Step 2:** Self-review diff; re-check branch.
- [ ] **Step 3:** Request approval, then commit:

```bash
git add frontend/app/view/agents/
git commit -m "feat(agents): resizable + reorderable working panels (in-memory sizing)"
```

---

## Running the dev app

Use the project's existing dev workflow (see the `run`/`verify` skills and the `cdp-verify-dev-app` note for driving the GUI over CDP on :9222). Do not run `go build`/`task package` just to check compilation — VSCode problems cover TS/Go errors.

## Self-Review (completed by plan author)

**Spec coverage:** #1 → Tasks 12-13; #2 → Tasks 19-21; #3 → Task 10; #4 → Task 6; #5 → Task 5; #6 → Tasks 15-17; #7 → Tasks 1-4; #8 → Tasks 7-8; #9 → Task 9; #10 → Task 4. All ten covered.

**Placeholder scan:** No TBD/TODO; every code step shows code; visual tasks have explicit dev-app verification instead of fake unit tests.

**Type consistency:** `isAskStale(askTs, statusTs, statusState)`, `reorderList(ids, draggedId, targetId, placeBefore)`, `AgentVM.blockId`, `LiveAgentInput.blockId`, `AgentEntry` `{kind:"user"}`, `SessionInput/SessionRowVM.isAgentsTab`, `getPanelSize/setPanelSize`, `AgentComposer({blockId, placeholder})`, `StatusDot({state, quiet})`, `MarkdownMessage({text})` — names are used consistently across tasks.

**Known soft spots flagged in-plan:** Task 13 is investigative (branches on root cause); Task 21 notes the motion-`layout` vs CSS-`resize` interaction to drop if they conflict.
