# Jarvis Pet Announcement Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire three announcement channels — `notify`, `agent:ask`, and background-agent-finished — into the Jarvis pet's existing voice pipeline so the avatar speaks them as bubbles.

**Architecture:** Three new pure adapters in `petjoin.ts` convert wire payloads to `PetEvent`s; two new `waveEventSubscribeSingle` subscriptions in `petsources.tsx` (notify, ask) and a diff in `backgroundagentsstore.ts` (bg-finished) push into the existing `petEventsAtom` → `nextUtterance` → bubble → unread dot → peek pipeline. The ask channel is gated by a pure focus check so asks you are already looking at stay silent. Frontend-only; no Go, no codegen, no migration.

**Tech Stack:** React 19, jotai, Vitest, TypeScript (strict), Tailwind v4 tokens.

## Global Constraints

- **Tokens only — follow existing design patterns, never invent colors, never hard-code.** Every UI class in this plan must already exist in `frontend/tailwindsetup.css` (`@theme` tokens: `text-secondary`, `text-muted`, `border-border`, `bg-surface-raised`, …). NO new colors, NO raw hex (`#13171d`), NO `rgb(...)`, NO inline `style=` attributes, NO inventing new shades or opacities. When a new UI element needs a style, copy the class string from the nearest existing element in the same file (the codebase pattern: e.g. `petpeek.tsx`'s event text uses `text-[11.5px] leading-[1.45] text-secondary`, and its dimmed meta line uses `text-muted`). The bubble itself needs no styling change at all — `KIND_LABEL` is text only.
- **No guessing:** adapters are total — unknown payloads yield `null`/`{}`, never a fabricated utterance.
- **No numbers:** notifications and asks enter the Voice register only; `petcondition.ts` and posture are untouched.
- **No Go:** do not touch `pkg/` or run `task generate`.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json` (bare `npx tsc` stack-overflows on this repo). Baseline is clean — any error is yours.
- **Tests:** `npx vitest run frontend/app/view/jarvis` for the jarvis view; targeted file runs listed per step.
- **Git:** per project rules, NO per-task commits and no commit at all without explicit user approval. Task steps end at a test/typecheck gate, not a commit. One commit at the end of Task 6, after approval.
- Spec: `docs/superpowers/specs/2026-08-14-jarvis-avatar-announcement-channels-design.md`.

---

### Task 1: PetEvent shape + bubble labels

Widen the `PetEvent` kind union and add the optional `detail` field; register the two new labels in the bubble's exhaustive label map. TS enforces the map completeness.

**Files:**
- Modify: `frontend/app/view/jarvis/petvoice.ts` (kind union + `detail` field)
- Modify: `frontend/app/view/jarvis/petbubble.tsx` (`KIND_LABEL` map)
- Modify: `frontend/app/view/jarvis/petvoice.test.ts`

**Interfaces:**
- Produces: `PetEvent["kind"]` now includes `"notify" | "ask"`; `PetEvent` gains optional `detail?: string` (bubble never shows it; the peek renders it dimmed). `KIND_LABEL` covers every kind.

- [ ] **Step 1: Widen the kind union and add `detail` in `petvoice.ts`**

In `frontend/app/view/jarvis/petvoice.ts`, replace the `kind:` union (currently lines ~28-38) with:

```ts
    kind:
        | "resume"
        | "sweep"
        | "distill-batch"
        | "bg-agent-done"
        // volunteered knowledge: what Jarvis knows about your work, not what the system did
        | "recall"
        | "connection"
        | "loose-end"
        | "ledger"
        // announcement channels: notifications and pending agent questions
        | "notify"
        | "ask";
    text: string;
    // message body / question body — the bubble shows only `text`; the peek renders this dimmed
    detail?: string;
```

- [ ] **Step 2: Add the two labels in `petbubble.tsx`**

In `frontend/app/view/jarvis/petbubble.tsx`, inside the `KIND_LABEL: Record<PetEvent["kind"], string>` map (currently lines ~30-38), add:

```ts
    notify: "Notice",
    ask: "Asking you",
```

(Order in the object does not matter; `bg-agent-done: "While you were out"` already exists.)

- [ ] **Step 3: Add a flow-through test in `petvoice.test.ts`**

In `frontend/app/view/jarvis/petvoice.test.ts`, inside the existing `describe("nextUtterance", ...)` block, add:

```ts
    it("treats a notify event as a normal utterance", () => {
        const e = ev("n1", 1000, { kind: "notify" });
        const spoken = nextUtterance([e], null);
        expect(spoken.utterance).toEqual(e);
    });
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run frontend/app/view/jarvis/petvoice.test.ts`
Expected: PASS (new + existing cases).

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean — proves `KIND_LABEL` covers the widened union.

---

### Task 2: The adapters — `petjoin.ts`

Three pure, total adapters plus the ask focus gate. All live beside the existing `eventFromActivity` / `eventFromVolunteer` adapters, same conventions (unknown input → `null`/`{}`/`[]`).

**Files:**
- Modify: `frontend/app/view/jarvis/petjoin.ts`
- Modify: `frontend/app/view/jarvis/petjoin.test.ts`

**Interfaces:**
- Consumes: `PetEvent` (Task 1), `NotifyCommandData`, `AgentAskData`, `BackgroundAgentData` (global wire types, no import needed), `AgentVM` (`import type { AgentVM } from "@/app/view/agents/agentsviewmodel";` — the module already imports from there).
- Produces:
  - `eventFromNotify(d: NotifyCommandData | null | undefined, nowMs: number, seq: number): PetEvent | null`
  - `eventFromAsk(d: AgentAskData | null | undefined): { event?: PetEvent; cancelId?: string }`
  - `askAgent(agents: ReadonlyArray<AgentVM>, askOref: string | undefined): AgentVM | undefined` — the roster VM whose `blockId` matches the ask's block oref (its `id` is the tab the Agent surface focuses)
  - `shouldSpeakAsk(askOref: string | undefined, ctx: AskGateCtx): boolean` with `export interface AskGateCtx { surface: string; focusTabId: string | undefined; askTabId: string | undefined; focusedBlockId: string | null }`
  - `agentFinishedFromDiff(prev: ReadonlyArray<BackgroundAgentData>, next: ReadonlyArray<BackgroundAgentData>, dismissed: ReadonlySet<string>, nowMs: number): PetEvent[]`

- [ ] **Step 1: Write the failing tests in `petjoin.test.ts`**

Append to `frontend/app/view/jarvis/petjoin.test.ts` (the existing imports at the top — `describe, expect, it` from vitest — are already there; extend the `import { ... } from "./petjoin"` list):

```ts
import {
    agentFinishedFromDiff,
    askAgent,
    eventFromAsk,
    eventFromNotify,
    shouldSpeakAsk,
    type AskGateCtx,
} from "./petjoin";
```

Then append the test blocks:

```ts
function notify(over: Partial<NotifyCommandData> = {}): NotifyCommandData {
    return { title: "build finished", message: "all 214 tests green", level: "info", ...over };
}

describe("eventFromNotify", () => {
    it("turns a notification into an event: title is the utterance, message is the detail", () => {
        const e = eventFromNotify(notify(), 1000, 1);
        expect(e).toEqual({
            id: "notify:1000:1",
            at: 1000,
            kind: "notify",
            text: "build finished",
            detail: "all 214 tests green",
        });
    });

    it("ignores a missing or empty title", () => {
        expect(eventFromNotify(null, 1000, 1)).toBeNull();
        expect(eventFromNotify(notify({ title: "" }), 1000, 1)).toBeNull();
    });

    it("leaves detail unset when there is no message", () => {
        expect(eventFromNotify(notify({ message: "" }), 1000, 2)?.detail).toBeUndefined();
    });
});

function ask(over: Partial<AgentAskData> = {}): AgentAskData {
    return {
        oref: "block:abc",
        askid: "ask-1",
        ts: 2000,
        questions: [{ question: "which rollout approach?", header: "Rollout", options: [] }],
        ...over,
    };
}

describe("eventFromAsk", () => {
    it("turns a raised ask into an event keyed by askid", () => {
        expect(eventFromAsk(ask())).toEqual({
            event: { id: "ask:ask-1", at: 2000, kind: "ask", text: "which rollout approach?", ref: "block:abc" },
        });
    });

    it("a cleared ask yields a cancel id, never an event", () => {
        expect(eventFromAsk(ask({ cleared: true }))).toEqual({ cancelId: "ask:ask-1" });
    });

    it("an ask with no questions, or no data at all, yields nothing", () => {
        expect(eventFromAsk(ask({ questions: [] }))).toEqual({});
        expect(eventFromAsk(null)).toEqual({});
    });
});

describe("askAgent", () => {
    it("finds the roster agent whose block matches the ask oref", () => {
        const agents = [{ id: "tab1", name: "radar-triage", blockId: "abc" } as unknown as AgentVM];
        expect(askAgent(agents, "block:abc")?.id).toBe("tab1");
    });

    it("yields undefined when nothing matches", () => {
        expect(askAgent([], "block:abc")).toBeUndefined();
    });
});

function gateCtx(over: Partial<AskGateCtx> = {}): AskGateCtx {
    return { surface: "jarvis", focusTabId: undefined, askTabId: undefined, focusedBlockId: null, ...over };
}

describe("shouldSpeakAsk", () => {
    it("suppresses when keyboard focus is inside the ask's block", () => {
        expect(shouldSpeakAsk("block:abc", gateCtx({ focusedBlockId: "abc" }))).toBe(false);
    });

    it("suppresses on the agent surface when that agent is focused", () => {
        expect(shouldSpeakAsk("block:abc", gateCtx({ surface: "agent", focusTabId: "tab1", askTabId: "tab1" }))).toBe(false);
    });

    it("speaks when a different agent is focused", () => {
        expect(shouldSpeakAsk("block:abc", gateCtx({ surface: "agent", focusTabId: "tab2", askTabId: "tab1" }))).toBe(true);
    });

    it("speaks when the ask's agent is not on the roster", () => {
        expect(shouldSpeakAsk("block:abc", gateCtx({ surface: "agent", focusTabId: "tab1", askTabId: undefined }))).toBe(true);
    });

    it("speaks when there is no oref to match against", () => {
        expect(shouldSpeakAsk(undefined, gateCtx({ focusedBlockId: "abc" }))).toBe(true);
    });
});

function bg(over: Partial<BackgroundAgentData> = {}): BackgroundAgentData {
    return { sessionid: "s1", cwd: "/x", kind: "background", name: "radar-triage", state: "working", startedts: 1, ...over };
}

describe("agentFinishedFromDiff", () => {
    it("reports a background agent that disappeared between polls", () => {
        expect(agentFinishedFromDiff([bg()], [], new Set(), 3000)).toEqual([
            { id: "bgdone:s1:3000", at: 3000, kind: "bg-agent-done", text: "radar-triage finished" },
        ]);
    });

    it("ignores agents still present", () => {
        expect(agentFinishedFromDiff([bg()], [bg()], new Set(), 3000)).toEqual([]);
    });

    it("ignores dismissed ids", () => {
        expect(agentFinishedFromDiff([bg()], [], new Set(["s1"]), 3000)).toEqual([]);
    });

    it("ignores non-background entries", () => {
        expect(agentFinishedFromDiff([bg({ kind: "agent" })], [], new Set(), 3000)).toEqual([]);
    });

    it("never reports on a first load (empty prev)", () => {
        expect(agentFinishedFromDiff([], [bg()], new Set(), 3000)).toEqual([]);
    });

    it("falls back to a generic name when the agent has none", () => {
        expect(agentFinishedFromDiff([bg({ name: "" })], [], new Set(), 3000)[0]?.text).toBe("A background agent finished");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/petjoin.test.ts`
Expected: FAIL — the new imports (`eventFromNotify`, `eventFromAsk`, `askAgent`, `shouldSpeakAsk`, `agentFinishedFromDiff`, `AskGateCtx`) do not exist yet.

- [ ] **Step 3: Implement the adapters in `petjoin.ts`**

Append to `frontend/app/view/jarvis/petjoin.ts` (after `passLine`). First extend the import line at the top (`import { providerLabel } ...` stays; add AgentVM):

```ts
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
```

Then append:

```ts
// A notification is a message from elsewhere, so the text passes through verbatim — rewriting it would
// be guessing (design §2). The title is the utterance; the message body rides as detail for the peek.
// The id is session-unique (`seq` from the caller): notify events are ephemeral wave events, so no
// cross-reload stability is needed, and the pair `nowMs`/`seq` keeps same-millisecond events distinct.
export function eventFromNotify(
    d: NotifyCommandData | null | undefined,
    nowMs: number,
    seq: number
): PetEvent | null {
    const title = d?.title?.trim() ?? "";
    if (!title) {
        return null;
    }
    return {
        id: `notify:${nowMs}:${seq}`,
        at: nowMs,
        kind: "notify",
        text: title,
        detail: d.message?.trim() || undefined,
    };
}

// The raise/clear pair shares the askid so the cleared event can retract the pending one. A raised ask
// without a question carries nothing to say; a cleared ask carries no utterance at all, only the retract.
export interface AskEventResult {
    event?: PetEvent;
    cancelId?: string;
}

export function eventFromAsk(d: AgentAskData | null | undefined): AskEventResult {
    if (d == null || !d.askid) {
        return {};
    }
    if (d.cleared) {
        return { cancelId: `ask:${d.askid}` };
    }
    const question = d.questions?.[0]?.question?.trim() ?? "";
    if (!question) {
        return {};
    }
    return {
        event: {
            id: `ask:${d.askid}`,
            at: d.ts > 0 ? d.ts : Date.now(),
            kind: "ask",
            text: question,
            ref: d.oref || undefined,
        },
    };
}

// The roster join: an ask's block oref matches the roster row's termBlockOref, whose id IS the tab the
// Agent surface focuses. `blockId` is the oref with the "block:" prefix stripped (agentsviewmodel.ts:519).
// The VM is returned whole: the gate needs the tab id, and the open affordance needs the name.
export function askAgent(agents: ReadonlyArray<AgentVM>, askOref: string | undefined): AgentVM | undefined {
    const oid = askOref?.split(":")[1];
    if (oid == null) {
        return undefined;
    }
    return agents.find((a) => a.blockId === oid);
}

// The focus gate (design §4.2): an ask you are already looking at is already reported — speaking it too
// would be the double-count the report-once rule exists to prevent. Suppressed when keyboard focus sits
// inside the ask's block (cockpit) or when the Agent surface is focused on that agent's tab. Everything
// else speaks. An oref the gate cannot match always speaks: absence of evidence is not suppression.
export interface AskGateCtx {
    surface: string;
    focusTabId: string | undefined;
    askTabId: string | undefined;
    focusedBlockId: string | null;
}

export function shouldSpeakAsk(askOref: string | undefined, ctx: AskGateCtx): boolean {
    if (askOref == null) {
        return true;
    }
    const oid = askOref.split(":")[1];
    if (oid != null && ctx.focusedBlockId != null && oid === ctx.focusedBlockId) {
        return false;
    }
    if (ctx.surface === "agent" && ctx.askTabId != null && ctx.askTabId === ctx.focusTabId) {
        return false;
    }
    return true;
}

// A background agent finishing is a presence→absence transition in the poll listing. The first load
// diffs against nothing (prev is empty) so it can never fabricate completions, and a dismissed id is
// excluded so the Dismiss button cannot fake one either. Each finisher is one event; the voice speaks
// the newest and the peek keeps the rest.
export function agentFinishedFromDiff(
    prev: ReadonlyArray<BackgroundAgentData>,
    next: ReadonlyArray<BackgroundAgentData>,
    dismissed: ReadonlySet<string>,
    nowMs: number
): PetEvent[] {
    const nextIds = new Set(next.filter((a) => a?.kind === "background").map((a) => a.sessionid));
    return prev
        .filter((a) => a?.kind === "background" && a.sessionid && !nextIds.has(a.sessionid) && !dismissed.has(a.sessionid))
        .map((a) => ({
            id: `bgdone:${a.sessionid}:${nowMs}`,
            at: nowMs,
            kind: "bg-agent-done",
            text: `${(a.name ?? "").trim() || "A background agent"} finished`,
        }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/petjoin.test.ts`
Expected: PASS — all new cases plus the existing adapter tests.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean.

---

### Task 3: Subscription wiring — notify and ask into the pet

`petstore.ts` gains `removePetEvent`; `petsources.tsx` gains the two live subscriptions (notify, ask) with the focus gate; `cockpit-root.tsx` passes the model.

**Files:**
- Modify: `frontend/app/view/jarvis/petstore.ts`
- Modify: `frontend/app/view/jarvis/petsources.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx`

**Interfaces:**
- Consumes: `eventFromNotify`, `eventFromAsk`, `askAgent`, `shouldSpeakAsk`, `AskGateCtx` (Task 2); `pushPetEvent` (existing, petstore.ts:93); `focusedBlockId` from `@/util/focusutil`.
- Produces: `removePetEvent(id: string): void` in `petstore.ts`. `PetSources` now takes `{ model: AgentsViewModel }`.

- [ ] **Step 1: Add `removePetEvent` to `petstore.ts`**

Directly below `pushPetEvent` (petstore.ts:93-98), add:

```ts
// Retract a pending event (an ask cleared before it was spoken). Dedupe-by-id means the same id cannot
// be re-queued afterwards, so the retract is safe even if the raise and the clear arrive in one tick.
export function removePetEvent(id: string): void {
    const events = globalStore.get(petEventsAtom).filter((e) => e.id !== id);
    globalStore.set(petEventsAtom, events);
}
```

- [ ] **Step 2: Wire the subscriptions in `petsources.tsx`**

In `frontend/app/view/jarvis/petsources.tsx`:

1. Extend imports (current lines 22-29) with:

```ts
import type { AgentsViewModel } from "./agents";
import { focusedBlockId } from "@/util/focusutil";
import {
    askAgent,
    eventFromAsk,
    eventFromNotify,
    shouldSpeakAsk,
    type AskGateCtx,
} from "./petjoin";
import { petIndexAtom, pushPetEvent, recordPass, removePetEvent } from "./petstore";
```

2. Change the component signature (line 113) to:

```ts
export function PetSources({ model }: { model: AgentsViewModel }) {
```

3. Add a module-level counter next to `ACTIVITY_BACKLOG` (line 32):

```ts
// session-unique sequence for notify event ids (the events themselves are session-scoped)
let notifySeq = 0;
```

4. Inside the existing `useEffect`, after the `unsubVolunteer` subscription (currently lines 137-146) and before the `return`, add:

```ts
        const unsubNotify = waveEventSubscribeSingle({
            eventType: "notify",
            handler: (event) => {
                const mapped = eventFromNotify(event?.data as NotifyCommandData | undefined, Date.now(), ++notifySeq);
                if (mapped != null) {
                    pushPetEvent(mapped);
                }
            },
        });
        const unsubAsk = waveEventSubscribeSingle({
            eventType: "agent:ask",
            handler: (event) => {
                const data = event?.data as AgentAskData | undefined;
                const out = eventFromAsk(data);
                if (out.cancelId != null) {
                    removePetEvent(out.cancelId);
                    return;
                }
                if (out.event == null) {
                    return;
                }
                const agent = askAgent(globalStore.get(model.agentsAtom), data?.oref);
                const ctx: AskGateCtx = {
                    surface: globalStore.get(model.surfaceAtom),
                    focusTabId: globalStore.get(model.focusIdAtom),
                    askTabId: agent?.id,
                    focusedBlockId: focusedBlockId(),
                };
                if (!shouldSpeakAsk(data?.oref, ctx)) {
                    return;
                }
                // `agent:<tabId>` is the oref openORef routes to openTerminal (openref.ts "agent"
                // case); askAboutSource tolerates the unknown sourceType (generic chip, never a wrong
                // destination — jarvissubjectstore.ts:305). A roster-less ask still speaks, just with
                // no open affordance — the same rule as a volunteer with no ref.
                pushPetEvent(
                    agent != null
                        ? {
                              ...out.event,
                              sources: [{ ref: `agent:${agent.id}`, title: agent.name || "the ask", sourceType: "" }],
                          }
                        : out.event
                );
            },
        });
```

5. Extend the cleanup `return` (currently `unsub(); unsubVolunteer();`) to also call `unsubNotify(); unsubAsk();`.

- [ ] **Step 3: Pass the model in `cockpit-root.tsx`**

At `frontend/app/cockpit/cockpit-root.tsx` line 103, change:

```tsx
            <PetSources />
```
to:
```tsx
            <PetSources model={model} />
```

(`model` is the `agentsModelRef.current` binding already in scope at line 68.)

- [ ] **Step 4: Typecheck and run the jarvis tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean.

Run: `npx vitest run frontend/app/view/jarvis`
Expected: PASS.

---

### Task 4: Background-agent-finished — the poll diff

`backgroundagentsstore.ts` runs `agentFinishedFromDiff` where prev/next naturally meet, and the Dismiss button registers into a guard set.

**Files:**
- Modify: `frontend/app/view/agents/backgroundagentsstore.ts`

**Interfaces:**
- Consumes: `agentFinishedFromDiff` (Task 2), `pushPetEvent` (petstore.ts:93), `backgroundAgentsAtom` (same file).
- Produces: module-level `dismissedAgentIds: Set<string>`; `dismissBackgroundAgent` now registers its id; `loadBackgroundAgents` pushes finished events after a successful load.

- [ ] **Step 1: Add the imports**

In `frontend/app/view/agents/backgroundagentsstore.ts`, extend the existing imports (line 1-12 block) with:

```ts
import { agentFinishedFromDiff } from "@/app/view/jarvis/petjoin";
import { pushPetEvent } from "@/app/view/jarvis/petstore";
```

- [ ] **Step 2: Add the dismissed guard and wire the diff**

1. Below `let loadSeq = 0;` (current line ~25), add:

```ts
// ids the user dismissed via the strip's × button — a disappearance they caused must not read as a
// completion. Session-scoped: a reload forgets it, and the poll diff has nothing to prove to history.
const dismissedAgentIds = new Set<string>();
```

2. In `dismissBackgroundAgent` (current lines 32-44), add the guard as the first statement:

```ts
    dismissedAgentIds.add(sessionId);
```

3. In `loadBackgroundAgents` (current lines 47-65), read the previous listing before the store update, and push diff events after a successful load. The function currently is:

```ts
export async function loadBackgroundAgents(): Promise<void> {
    const seq = ++loadSeq;
    try {
        const rtn = await RpcApi.GetBackgroundAgentsCommand(TabRpcClient, {});
        if (seq !== loadSeq) {
            return;
        }
        globalStore.set(backgroundAgentsAtom, rtn.agents ?? []);
        globalStore.set(backgroundAgentsErrorAtom, false);
    } catch {
        if (seq !== loadSeq) {
            return;
        }
        globalStore.set(backgroundAgentsErrorAtom, true);
    }
}
```

Replace it with:

```ts
export async function loadBackgroundAgents(): Promise<void> {
    const seq = ++loadSeq;
    try {
        const rtn = await RpcApi.GetBackgroundAgentsCommand(TabRpcClient, {});
        if (seq !== loadSeq) {
            return;
        }
        const prev = globalStore.get(backgroundAgentsAtom);
        globalStore.set(backgroundAgentsAtom, rtn.agents ?? []);
        globalStore.set(backgroundAgentsErrorAtom, false);
        // the one place prev and next meet; a failed load kept the last-good list and runs no diff
        for (const ev of agentFinishedFromDiff(prev, rtn.agents ?? [], dismissedAgentIds, Date.now())) {
            pushPetEvent(ev);
        }
    } catch {
        if (seq !== loadSeq) {
            return;
        }
        globalStore.set(backgroundAgentsErrorAtom, true);
    }
}
```

- [ ] **Step 3: Typecheck and run the tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean.

Run: `npx vitest run frontend/app/view/jarvis`
Expected: PASS (the diff logic is covered by the Task 2 adapter tests; `backgroundagentsstore.ts` has no test file of its own).

---

### Task 5: The peek's detail line

The peek renders `event.detail` dimmed below the event text when present, using existing tokens only.

**Files:**
- Modify: `frontend/app/view/jarvis/petpeek.tsx` (`UpdateItem`, around lines 277-296)

**Interfaces:**
- Consumes: `PetEvent.detail` (Task 1).

- [ ] **Step 1: Add the detail line**

In `frontend/app/view/jarvis/petpeek.tsx`, inside `UpdateItem`, immediately after the `event.text` span (currently line 284):

```tsx
                <span className="text-[11.5px] leading-[1.45] text-secondary">{event.text}</span>
```

add:

```tsx
                {event.detail ? (
                    <span className="mt-0.5 block text-[11.5px] leading-[1.45] text-muted">{event.detail}</span>
                ) : null}
```

Both classes are existing `@theme` tokens already used in this same component — `text-secondary` for the event text, `text-muted` for the dimmed meta line (the detail line reuses the exact size/leading of the text above it). No new color, no hex, no inline style (see Global Constraints).

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean.

---

### Task 6: Full verification

- [ ] **Step 1: Full test suite for the jarvis view**

Run: `npx vitest run frontend/app/view/jarvis`
Expected: PASS.

- [ ] **Step 2: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 3: Live smoke (manual, in the running dev app)**

1. `wsh notify "build finished" --level info` (or from a pi session: `wave_notify`) — the avatar speaks a `Notice` bubble; auto-dismisses to the unread dot; the peek shows the row with the message as the dimmed detail line. The toast still appears.
2. From an agent session, raise an AskUserQuestion while focused on that agent on the Agent tab — no bubble. Raise another while on the Jarvis surface — `Asking you` bubble appears; answering it removes the peek row.
3. Launch a background agent (`claude agents` job), let it finish — `While you were out — <name> finished` bubble. Dismissing via the strip's × instead produces no bubble.

- [ ] **Step 4: Commit (requires explicit user approval)**

```bash
git add docs/superpowers/specs/2026-08-14-jarvis-avatar-announcement-channels-design.md docs/superpowers/plans/2026-08-14-jarvis-avatar-announcement-channels.md frontend/app/view/jarvis/petvoice.ts frontend/app/view/jarvis/petvoice.test.ts frontend/app/view/jarvis/petbubble.tsx frontend/app/view/jarvis/petjoin.ts frontend/app/view/jarvis/petjoin.test.ts frontend/app/view/jarvis/petstore.ts frontend/app/view/jarvis/petsources.tsx frontend/app/view/jarvis/petpeek.tsx frontend/app/cockpit/cockpit-root.tsx frontend/app/view/agents/backgroundagentsstore.ts
git commit -m "feat(jarvis): pet speaks notify, agent asks, and background-agent completions"
```

Spec and plan docs fold into this feature commit (per project convention — never a separate docs-only commit).
