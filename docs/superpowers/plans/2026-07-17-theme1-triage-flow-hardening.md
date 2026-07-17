# Theme 1 — Triage-flow hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five confirmed dead-ends in the cockpit's "answer agent asks in place" triage flow (T1, T2, T4, C1, C2 from the design brief); T3 is deliberately declined.

**Architecture:** Frontend-only. The core state fix (T1) re-keys "answered" and answer-draft state from the agent id to the stable per-ask id (`AgentAsk.askId`). The rest are small wiring fixes: auto-advance on submit (T2), a conditional render + Enter guard (T4), a shared-modal keyboard chord + autofocus (C1), and making dead rail rows actionable (C2). Pure logic is extracted and unit-tested; DOM/wiring is typechecked + CDP-verified per the repo convention (there is no jsdom/render harness for the cockpit).

**Tech Stack:** React 19, jotai, TypeScript, Vitest, Tailwind 4. Source: `frontend/app/view/agents/` + `frontend/app/modals/`.

## Global Constraints

- **Source of truth for answered-ask identity is `AgentAsk.askId`** (derived from `AgentAskData.askid`, always present on the live path via `withAsk`). **Never** use `ask.oref` for ask identity — it is the block oref, reused across successive asks from the same block.
- **Do not hand-edit generated files.** No wire-protocol/type changes are needed in this slice.
- **tsc gotcha:** typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0) — any error it reports is yours.
- **No new SCSS / no hardcoded colors** — use existing Tailwind `@theme` utility tokens already present in the touched markup.
- **Commits are batched at the end pending explicit user approval** (per user git policy). Each task below ends at a verified, working state; the final commit covers the whole slice plus this plan doc. Do **not** commit per-task.
- **Pre-existing known test failure:** `pkg/tsgen TestGenerateWaveEventTypes` fails on a clean baseline (stale fixture) — unrelated to this slice, ignore it. Frontend vitest baseline is clean.

---

### Task 1: T1 — askid-scoped "answered" + answer-draft state

**Root cause:** `sentIdsAtom`, `answerSelAtom`, `answerTextAtom`, `answerTabAtom` are keyed by `agentId` and never cleared. After the first answer, `submitAnswer` early-returns on `sent.has(agentId)` and `AnswerBar` renders a frozen "✓ Answered" — so a second ask from the same agent is un-answerable and submit is silently blocked.

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (add `askSentKey` pure helper)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts` (add `askSentKey` describe block + import)
- Modify: `frontend/app/view/agents/agents.tsx:161-176` (`submitAnswer` keys by `askSentKey`)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (`sent` prop by askId + a draft-reset effect + a `deleteKey` helper)
- Modify: `frontend/app/view/agents/channelsprimitives.tsx:114` (`sent` prop by askId)

**Interfaces:**
- Produces: `askSentKey(agent: AgentVM): string | undefined` — returns `agent.ask?.askId`. Consumed by `submitAnswer` and the two `sent` render sites; and by Task 2 indirectly (same `submitAnswer`).

- [ ] **Step 1: Write the failing test** — append to `frontend/app/view/agents/agentsviewmodel.test.ts` and add `askSentKey` to the top-of-file import from `./agentsviewmodel`:

```ts
describe("askSentKey", () => {
    it("returns the ask's askId as the answered-ask identity", () => {
        const a = mk("agent-1", "asking", {
            ask: { questions: [{ question: "Q?" }], askId: "ask-1", oref: "block:abc" },
        });
        expect(askSentKey(a)).toBe("ask-1");
    });
    it("distinguishes two successive asks from the same agent (same id, new askId)", () => {
        const ask1 = mk("agent-1", "asking", { ask: { questions: [], askId: "ask-1", oref: "block:abc" } });
        const ask2 = mk("agent-1", "asking", { ask: { questions: [], askId: "ask-2", oref: "block:abc" } });
        expect(askSentKey(ask1)).not.toBe(askSentKey(ask2));
    });
    it("is NOT the block oref (oref is reused across asks)", () => {
        const a = mk("agent-1", "asking", { ask: { questions: [], askId: "ask-1", oref: "block:abc" } });
        expect(askSentKey(a)).not.toBe("block:abc");
    });
    it("is undefined when the agent has no ask", () => {
        expect(askSentKey(mk("agent-1", "working"))).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "askSentKey"`
Expected: FAIL — `askSentKey is not a function` / import error.

- [ ] **Step 3: Add the helper** — in `frontend/app/view/agents/agentsviewmodel.ts`, immediately after `hasAnswerableAsk` (near line 675):

```ts
/** Pure: the identity of an agent's *current ask* — the stable per-ask id, NOT the block oref (which is
 *  reused across successive asks from the same block). Single source for "which ask was answered", so a
 *  second ask from the same agent is never locked by the first. Undefined when the agent is not asking. */
export function askSentKey(agent: AgentVM): string | undefined {
    return agent.ask?.askId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "askSentKey"`
Expected: PASS (4 tests).

- [ ] **Step 5: Re-key `submitAnswer` by askId** — in `frontend/app/view/agents/agents.tsx`. Add `askSentKey` to the existing `./agentsviewmodel` import (line 11-19), then replace the method body (lines 161-176):

```ts
    submitAnswer(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        const askKey = agent ? askSentKey(agent) : undefined;
        const sent = globalStore.get(this.sentIdsAtom);
        if (!agent || askKey == null || sent.has(askKey)) {
            return;
        }
        const qs = agent.ask?.questions ?? [];
        const sel = globalStore.get(this.answerSelAtom)[agentId] ?? {};
        const txt = globalStore.get(this.answerTextAtom)[agentId] ?? {};
        const oref = agent.ask?.oref;
        if (!canSubmitAsk(qs, sel, txt) || !oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers: buildAskAnswers(qs, sel, txt) }));
        globalStore.set(this.sentIdsAtom, new Set(sent).add(askKey));
    }
```

- [ ] **Step 6: Re-key the cockpit `sent` render prop** — in `frontend/app/view/agents/cockpitsurface.tsx`, add `askSentKey` to the `./agentsviewmodel` import block (lines 12-30) and change line 326 inside `renderCard`:

```tsx
                sent={sentIds.has(askSentKey(a) ?? "")}
```

- [ ] **Step 7: Re-key the Channels `sent` render prop** — in `frontend/app/view/agents/channelsprimitives.tsx`, add `askSentKey` to its `./agentsviewmodel` import, and change line 114 inside `AskRow`:

```tsx
                sent={sentIds.has(askSentKey(agent) ?? "")}
```

- [ ] **Step 8: Add the draft-reset effect + `deleteKey` helper** — in `frontend/app/view/agents/cockpitsurface.tsx`. First add a module-level helper (below the `useModelAtom` helper, near line 76):

```tsx
// Delete one agent's entry from a per-agent record atom (no-op if absent). Used to reset answer drafts
// when an agent's ask identity changes.
function deleteKey<T>(atomRef: PrimitiveAtom<Record<string, T>>, id: string) {
    const prev = globalStore.get(atomRef);
    if (!(id in prev)) {
        return;
    }
    const next = { ...prev };
    delete next[id];
    globalStore.set(atomRef, next);
}
```

Then, inside `CockpitSurface`, add the effect near the other cursor/asking effects (after the block ending at line 244). It needs `useRef` (already imported) and `model`/`asking` (already in scope):

```tsx
    // Reset an agent's answer drafts when its ask identity changes, so a fresh ask never inherits the
    // previous ask's selections/text/tab (T1). Keyed on each asking agent's askId; the first sighting of
    // an ask clears nothing (drafts are already empty) and just records the id.
    const seenAskIdRef = useRef<Map<string, string>>(new Map());
    useEffect(() => {
        for (const a of asking) {
            const askId = a.ask?.askId;
            if (askId == null || seenAskIdRef.current.get(a.id) === askId) {
                continue;
            }
            seenAskIdRef.current.set(a.id, askId);
            deleteKey(model.answerSelAtom, a.id);
            deleteKey(model.answerTextAtom, a.id);
            deleteKey(model.answerTabAtom, a.id);
        }
    }, [asking.map((a) => `${a.id}:${a.ask?.askId ?? ""}`).join(",")]);
```

- [ ] **Step 9: Typecheck + full vitest for the file**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean).
Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (all, including the 4 new `askSentKey` tests).

- [ ] **Step 10: Manual reasoning checkpoint (no commit).** Confirm: (a) answering ask-1 sets `sentIds = {askId-1}`; (b) when ask-2 arrives (`askId-2`), `sent` prop = `has(askId-2)` = false → live picker renders; (c) the reset effect clears the stale ask-1 drafts on the askId change. Record status in the checkpoint summary.

---

### Task 2: T2 — advance the cursor to the next waiting ask on submit

**Root cause:** neither the Enter branch (`usecockpitkeyboard.ts:91-98`) nor `submitAnswer` moves the cursor; reaching the next ask needs a separate `n` press, and there is no mouse path at all. Fold the advance into `submitAnswer`'s success path so keyboard and mouse both get it.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (`submitAnswer` success tail)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts` (one added `nextAskId` case)

**Interfaces:**
- Consumes: `nextAskId(ids, current)` and `groupAgents(agents).asking` (both already exported from `./agentsviewmodel`).

- [ ] **Step 1: Write the failing test** — add one case to the existing `describe("nextAskId", ...)` block in `agentsviewmodel.test.ts` (documents "the last remaining ask leaves the cursor in place"):

```ts
    it("wraps to itself for a single ask (last one stays put)", () => {
        expect(nextAskId(["only"], "only")).toBe("only");
    });
```

- [ ] **Step 2: Run test to verify it fails-or-passes as expected**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "nextAskId"`
Expected: PASS — this case already holds under the current `nextAskId` implementation (wrap-around), so it is a regression guard, not a red test. (If it unexpectedly fails, stop — `nextAskId` was changed.)

- [ ] **Step 3: Fold the advance into `submitAnswer`** — in `frontend/app/view/agents/agents.tsx`, add `groupAgents` and `nextAskId` to the `./agentsviewmodel` import, and append to the end of `submitAnswer` (after the `sentIdsAtom` set from Task 1):

```ts
        // advance triage to the next asking agent so answering keeps moving without a separate `n` press
        // (T2). The just-answered agent is still in `asking` (state flips later), so nextAskId cycles past
        // it; a lone remaining ask wraps to itself and the cursor stays put.
        const askingIds = groupAgents(globalStore.get(this.agentsAtom)).asking.map((a) => a.id);
        const next = nextAskId(askingIds, agentId);
        if (next != null) {
            globalStore.set(this.cursorIdAtom, next);
        }
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Run the view-model tests**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS.

- [ ] **Step 6: Manual reasoning checkpoint (no commit).** Confirm the ordering source matches the keyboard `n` handler (`groupAgents(agents).asking`, `cockpitsurface.tsx:80,294`) so submit-advance and `n`-advance traverse the same list.

---

### Task 3: T4 — hide the idle reply box when the agent has no live terminal block

**Root cause:** `IdleSection` mounts `AgentComposer` unconditionally (`idlesection.tsx:60`); `send()` no-ops on missing `blockId` but Enter calls it regardless (`agentcomposer.tsx:63-71`) — a keyboard user hits a silent dead-end.

**Files:**
- Modify: `frontend/app/view/agents/agentcomposer.tsx` (export a `canSendComposer` predicate; use it in `send()`, Enter guard, and the button)
- Test: `frontend/app/view/agents/agentcomposer.test.ts` (new — `canSendComposer`)
- Modify: `frontend/app/view/agents/idlesection.tsx:60` (conditional render)

**Interfaces:**
- Produces: `canSendComposer(text: string, blockId?: string): boolean`.

- [ ] **Step 1: Write the failing test** — create `frontend/app/view/agents/agentcomposer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canSendComposer } from "./agentcomposer";

describe("canSendComposer", () => {
    it("is false when block-less (idle composer with no live terminal — T4)", () => {
        expect(canSendComposer("hello", undefined)).toBe(false);
    });
    it("is false when text is empty or whitespace", () => {
        expect(canSendComposer("", "block:1")).toBe(false);
        expect(canSendComposer("   ", "block:1")).toBe(false);
    });
    it("is true with non-empty text and a live block", () => {
        expect(canSendComposer("hi", "block:1")).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentcomposer.test.ts`
Expected: FAIL — `canSendComposer` is not exported.

- [ ] **Step 3: Add the predicate and use it** — in `frontend/app/view/agents/agentcomposer.tsx`, add the export just above the `AgentComposer` component (after the `ComposerMaxH` const, near line 10):

```tsx
/** Pure: a composer can send only with non-empty text AND a live terminal block. Shared by send(),
 *  the Enter guard, and the button's disabled state so all three agree (T4). */
export function canSendComposer(text: string, blockId?: string): boolean {
    return text.trim() !== "" && blockId != null;
}
```

Replace `send()` (lines 47-56) to use it:

```tsx
    const send = () => {
        if (!canSendComposer(text, blockId)) {
            return;
        }
        fireAndForget(() =>
            RpcApi.ControllerInputCommand(TabRpcClient, {
                blockid: blockId!,
                inputdata64: stringToBase64(text.trim() + "\r"),
            })
        );
        setText("");
    };
```

The Enter handler already calls `send()`, which now no-ops when block-less — that satisfies the defense-in-depth requirement (Enter cannot silently drop text). Also swap the button's disabled expression (line 78) to the shared predicate:

```tsx
                disabled={!canSendComposer(text, blockId)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentcomposer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Hide the composer for a block-less idle agent** — in `frontend/app/view/agents/idlesection.tsx`, change line 60 from an unconditional mount to:

```tsx
                                    {a.blockId ? (
                                        <AgentComposer blockId={a.blockId} placeholder={`message ${a.name}…`} />
                                    ) : null}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 4: C1 — wire Cmd/Ctrl+Enter to launch in the New-agent modal + autofocus the Task field

**Root cause:** the Launch button advertises a `⌘Enter` chord (`newagentmodal.tsx:630`) but has only `onClick`; `ModalShell` wires only Escape (`modalshell.tsx:34-41`); the Task textarea has no autofocus.

**Files:**
- Modify: `frontend/app/modals/modalshell.tsx` (add optional `onSubmit`, fire on Cmd/Ctrl+Enter)
- Modify: `frontend/app/view/agents/newagentmodal.tsx` (pass `onSubmit={launch}`; add `taskRef` + autofocus effect)

**Interfaces:**
- Consumes: `ModalShell` gains `onSubmit?: () => void`. Existing modals that omit it are unaffected (the chord only fires when `onSubmit` is set).

- [ ] **Step 1: Extend `ModalShell`** — in `frontend/app/modals/modalshell.tsx`, add `onSubmit?: () => void;` to `ModalShellProps` (after `onClose`, line 15), add `onSubmit` to the destructured props (line 22-29), and extend the keydown effect (lines 30-41):

```tsx
    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            } else if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSubmit();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose, onSubmit]);
```

- [ ] **Step 2: Typecheck the shell change in isolation**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no consumer passes `onSubmit` yet — the new optional prop breaks nothing).

- [ ] **Step 3: Wire the modal's submit + autofocus** — in `frontend/app/view/agents/newagentmodal.tsx`:

(a) add a ref near the other refs (after line 63, `reqIdRef`):

```tsx
    const taskRef = useRef<HTMLTextAreaElement>(null);
```

(b) add an autofocus effect (place it beside the other `open`-gated effects, e.g. after the effect ending at line 137):

```tsx
    // Focus the Task field when the modal opens (C1). runtime is intentionally out of deps — switching
    // runtime while the modal is open must not steal focus back to the task box.
    useEffect(() => {
        if (open && runtimeShowsTask(runtime)) {
            taskRef.current?.focus();
        }
    }, [open]);
```

(c) attach the ref to the Task textarea (line 366-371):

```tsx
                            <textarea
                                ref={taskRef}
                                value={task}
                                onChange={(e) => setTask(e.target.value)}
                                placeholder="Describe what this agent should do…"
                                className="h-[84px] w-full resize-none rounded-[10px] border border-edge-mid bg-surface px-[13px] py-[11px] text-[13.5px] leading-normal text-primary outline-none focus:border-accent-700"
                            />
```

(d) pass `onSubmit` to `ModalShell` (line 269):

```tsx
        <ModalShell open={open} onClose={close} onSubmit={() => void launch()} className="flex flex-col w-[min(640px,93vw)] max-h-[86vh]" dismissOnBackdrop={false}>
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Note: `launch()` already self-validates (sets an inline error and returns when the form is invalid), so the chord is a no-op on an invalid form — identical gating to the button. No unit test: this is DOM/keyboard wiring with no pure core (verified by typecheck + CDP per repo convention).

---

### Task 5: C2 — make cockpit rail "Recent activity" rows actionable

**Root cause:** rows are non-interactive `<div>`s (`cockpitrail.tsx:167-190`); the Sessions feed's equivalent rows are clickable `<button>`s. Each `RecentActivityItem.id` is the agent id, so a row can focus/scroll to that agent using the grid's existing jump path (`setCursorId` + `scrollToPulse`, the same as the keyboard `n` handler).

**Files:**
- Modify: `frontend/app/view/agents/cockpitrail.tsx` (add `onSelectAgent` prop; row `<div>` → `<button>`)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (pass `onSelectAgent`)

**Interfaces:**
- Consumes: `CockpitRail` gains `onSelectAgent: (id: string) => void`.

- [ ] **Step 1: Add the prop to `CockpitRail`** — in `frontend/app/view/agents/cockpitrail.tsx`, extend the `CockpitRail` props (the object destructure + its type, lines 76-88):

```tsx
export function CockpitRail({
    model,
    usageDonuts,
    windowTokens,
    recent,
    now,
    onSelectAgent,
}: {
    model: AgentsViewModel;
    usageDonuts: ReturnType<typeof mergeRateLimitWindows>;
    windowTokens: WindowTokens | null;
    recent: ReturnType<typeof buildRecentActivity>;
    now: number;
    onSelectAgent: (id: string) => void;
}) {
```

- [ ] **Step 2: Convert the row to a focusable button** — replace the row `<div key={e.id} ...>` block (lines 167-190) with a `<button>` that calls `onSelectAgent`; the inner content is unchanged:

```tsx
                                          {recent.map((e) => (
                                              <button
                                                  key={e.id}
                                                  type="button"
                                                  onClick={() => onSelectAgent(e.id)}
                                                  className="flex w-full gap-[11px] border-b border-border py-[9px] text-left hover:bg-white/[0.03]"
                                              >
                                                  <span
                                                      className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full"
                                                      style={{ backgroundColor: RECENT_DOT[e.state] }}
                                                  />
                                                  <div className="min-w-0 flex-1">
                                                      <div className="text-[12px] leading-[1.4] text-secondary">
                                                          <span className="font-mono font-semibold text-primary">
                                                              {e.agent}
                                                          </span>{" "}
                                                          <InlineMarkdown text={e.text} />
                                                      </div>
                                                      <div className="mt-[3px] font-mono text-[10px] text-muted">
                                                          {e.typeLabel} ·{" "}
                                                          {now - e.ts < 60_000
                                                              ? "just now"
                                                              : `${formatAge(now - e.ts)} ago`}
                                                      </div>
                                                  </div>
                                              </button>
                                          ))}
```

- [ ] **Step 3: Pass `onSelectAgent` from the surface** — in `frontend/app/view/agents/cockpitsurface.tsx`, update the `CockpitRail` usage (line 504). `setCursorId` and `scrollToPulse` are already in scope:

```tsx
            <CockpitRail
                model={model}
                usageDonuts={usageDonuts}
                windowTokens={windowTokens}
                recent={recent}
                now={now}
                onSelectAgent={(id) => {
                    setCursorId(id);
                    scrollToPulse(id);
                }}
            />
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Note: clicking a row moves the cursor and scrolls the agent's grid card into view with a pulse. If the referenced agent is not currently in the grid (e.g. parked-idle or filtered out), `scrollToPulse` is a soft no-op and the cursor-valid effect keeps the cursor consistent — acceptable; the row is no longer a dead `<div>`. No pure unit test (DOM wiring — verified by typecheck + CDP).

---

## Final verification (whole slice)

- [ ] **V1: Full typecheck** — `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
- [ ] **V2: Full frontend test run** — `npx vitest run frontend/app/view/agents/` → all pass, including the new `askSentKey`, `nextAskId` single-ask, and `canSendComposer` tests.
- [ ] **V3: CDP visual verification (optional, user-driven).** Per CLAUDE.md, in-cockpit flow is verified over CDP against the dev app. Because that requires running the worktree's dev app (a second `wavesrv`/Tauri instance, which can conflict with a running main-dir dev app), do this only with the user's go-ahead. Scenario: `node scripts/inject-live-agents.mjs <two-asks-same-agent>` (or the closest scenario), then drive the answer flow and confirm: T1 second ask answerable; T2 cursor advances on submit; T4 block-less idle shows no composer; C1 Cmd/Ctrl+Enter launches; C2 rail row click scrolls to the agent. If CDP is skipped, report V3 as **not dynamically verified** (typecheck + unit tests + code review only).
- [ ] **V4: Self-review the diff** — no debug statements, no commented-out code, comments explain "why".
- [ ] **V5: Commit (requires explicit user approval).** One commit for the whole slice + this plan doc. Then update `docs/deferred.md` Theme 1 entry / brief status to reflect shipped (in the same commit).

## Self-Review (author checklist — completed)

1. **Spec coverage:** T1 → Task 1; T2 → Task 2; T4 → Task 3; C1 → Task 4; C2 → Task 5; T3 → intentionally omitted (declined in brief). All five shipping fixes mapped.
2. **Placeholder scan:** no TBD/TODO; every code step shows full code.
3. **Type consistency:** `askSentKey(agent)` returns `string | undefined`; all three call sites coalesce with `?? ""` before `Set.has`. `deleteKey<T>` matches all three per-agent record atoms. `onSelectAgent`/`onSubmit` signatures consistent across producer/consumer.
