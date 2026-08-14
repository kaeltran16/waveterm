# Jarvis S3 Proactive Card Deep-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the S3 proactive "related prior work" card navigable — clicking it opens the cited vault node in its native surface (dossier → Jarvis surface subject, memory note → Memory surface).

**Architecture:** Pure FE slice. A new pure function `proactiveNavOref(vm)` maps the suggestion's already-persisted `sourceType`/`nodeId` (run.Meta payload, no backend change) to an oref (`task:<id>` / `memnote:<id>`), and the card passes it to the existing `openORef` navigator. The shared `AmbientCard` shell gains an optional `onClick` that renders its body as a real button; the other two consumers are untouched.

**Tech Stack:** React 19 + TypeScript, vitest (pure unit tests only — no jsdom, standing repo convention), CDP scenario harness (`task verify:ui`).

## Global Constraints

- No backend, wshrpc, waveobj, or `task generate` changes — the payload already carries `nodeId` + `sourceType` in `run.Meta["jarvis:proactive"]`.
- No jsdom render/snapshot tests — testable logic is pure `.ts` with `.test.ts` beside it; thin `.tsx` renders, verified live via CDP.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows; baseline is clean — any error is yours).
- Comments explain "why", never "what"; colors from `@theme` tokens, never raw hex.
- The mapping is FE-side by design: `openref.ts` is the single home of oref nav kinds; the briefing explicitly declined a global `vault:` alias (`briefingmodel.ts:81`). Do not add one.
- A decision hit is deliberately non-navigable (no `decision:` nav kind; zero decisions in the live corpus — honest no-op, never an error).

---
### Task 1: Pure nav mapping + unit tests

**Files:**
- Modify: `frontend/app/view/agents/proactive.ts` (append after `dismissProactive`)
- Test: `frontend/app/view/agents/proactive.test.ts`

**Interfaces:**
- Consumes: `ProactiveVM` (already exported from `proactive.ts`: `{ nodeId: string; sourceType: string; title: string; snippet: string; why: string }`).
- Produces: `proactiveNavOref(vm: ProactiveVM | null): string | null` — the oref the card passes to `openORef`; `null` means "not navigable".

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/proactive.test.ts`:

```ts
import { proactiveNavOref, readProactiveSuggestion, type ProactiveVM } from "./proactive";

function vm(over: Partial<ProactiveVM> = {}): ProactiveVM {
    return { nodeId: "n-1", sourceType: "memory", title: "t", snippet: "s", why: "w", ...over };
}

describe("proactiveNavOref", () => {
    it("maps a dossier hit to task:<nodeId>", () => {
        expect(proactiveNavOref(vm({ sourceType: "dossier" }))).toBe("task:n-1");
    });

    it("maps a memory hit to memnote:<nodeId>", () => {
        expect(proactiveNavOref(vm({ sourceType: "memory" }))).toBe("memnote:n-1");
    });

    it("returns null for a decision hit (no open path)", () => {
        expect(proactiveNavOref(vm({ sourceType: "decision" }))).toBeNull();
    });

    it("returns null for an empty nodeId", () => {
        expect(proactiveNavOref(vm({ nodeId: "" }))).toBeNull();
    });

    it("returns null for an unknown sourceType", () => {
        expect(proactiveNavOref(vm({ sourceType: "weird" }))).toBeNull();
    });

    it("returns null for a null vm", () => {
        expect(proactiveNavOref(null)).toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/proactive.test.ts`
Expected: FAIL — `proactiveNavOref is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `frontend/app/view/agents/proactive.ts`:

```ts
// maps a suggestion to the oref openORef navigates to; null = not navigable. The kind
// vocabulary lives in openref.ts (task:/memnote:/run:/channel:/agent:); a decision has no
// nav kind of its own (openref.ts header: it addresses its parent record via `anchor`,
// which this payload does not carry) — so it maps to null, never an error.
export function proactiveNavOref(vm: ProactiveVM | null): string | null {
    if (vm == null || vm.nodeId === "") {
        return null;
    }
    switch (vm.sourceType) {
        case "dossier":
            return `task:${vm.nodeId}`;
        case "memory":
            return `memnote:${vm.nodeId}`;
        default:
            return null;
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/proactive.test.ts`
Expected: PASS — all tests green (existing 4 + new 6).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/proactive.ts frontend/app/view/agents/proactive.test.ts
git commit -m "feat(jarvis): proactive card nav mapping (sourceType -> oref)"
```

---
### Task 2: AmbientCard optional onClick

**Files:**
- Modify: `frontend/app/view/agents/ambientcard.tsx`

**Interfaces:**
- Consumes: nothing new (props today: `eyebrow`, `dismissLabel`, `onDismiss`, `children`).
- Produces: `AmbientCard` gains optional `onClick?: () => void` — when set, the card body (eyebrow + children) renders as a `<button type="button">`; when absent, renders exactly as today. The dismiss × stays a sibling button (no nested buttons, no stopPropagation).

- [ ] **Step 1: Change the component**

Replace the `AmbientCardProps` type and the `AmbientCard` function in `frontend/app/view/agents/ambientcard.tsx`:

```tsx
type AmbientCardProps = {
    eyebrow: React.ReactNode;
    dismissLabel: string;
    onDismiss: () => void;
    children: React.ReactNode;
    // when set, the card body becomes a real button (S3 deep-link); the dismiss × stays a
    // sibling so the two never nest.
    onClick?: () => void;
};

export function AmbientCard({ eyebrow, dismissLabel, onDismiss, children, onClick }: AmbientCardProps) {
    const body = (
        <>
            <div className={cn("mb-0.5", AMBIENT_EYEBROW)}>{eyebrow}</div>
            {children}
        </>
    );
    return (
        <div className={cn("mb-3 flex items-start gap-2", AMBIENT_BOX)}>
            {onClick != null ? (
                <button type="button" onClick={onClick} className="min-w-0 flex-1 cursor-pointer text-left">
                    {body}
                </button>
            ) : (
                <div className="min-w-0 flex-1">{body}</div>
            )}
            <button
                type="button"
                aria-label={dismissLabel}
                onClick={onDismiss}
                className="flex-none rounded-[4px] px-1.5 py-px text-[13px] leading-none text-muted hover:text-secondary"
            >
                ×
            </button>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck + run the agents unit suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — Expected: clean (exit 0).
Run: `npx vitest run frontend/app/view/agents` — Expected: PASS (existing tests; markup-only change, no new jsdom tests per repo convention — this change's behavioral gate is Task 4's CDP step).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/ambientcard.tsx
git commit -m "feat(jarvis): AmbientCard body renders as a button when onClick is set"
```

---
### Task 3: ProactiveCard wiring + render site

**Files:**
- Modify: `frontend/app/view/agents/proactiveviews.tsx`
- Modify: `frontend/app/view/jarvis/ambientrailview.tsx:38`

**Interfaces:**
- Consumes: `proactiveNavOref` (Task 1); `openORef(model: AgentsViewModel, oref: string, anchor?: string): Promise<void>` from `@/app/view/jarvis/openref`; `AgentsViewModel` type from `./agents` (existing import convention in `view/agents/*.tsx`).
- Produces: `ProactiveCard({ model, run })` — the card navigates on click when navigable; dismissal unchanged.

- [ ] **Step 1: Wire the card**

In `frontend/app/view/agents/proactiveviews.tsx`:

```tsx
import { useAtomValue } from "jotai";
import { openORef } from "@/app/view/jarvis/openref";
import { AmbientCard } from "./ambientcard";
import { dismissProactive, dismissedProactiveAtom, proactiveNavOref, readProactiveSuggestion } from "./proactive";
import type { AgentsViewModel } from "./agents";

export function ProactiveCard({ model, run }: { model: AgentsViewModel; run: Run }) {
    const dismissed = useAtomValue(dismissedProactiveAtom);
    const vm = readProactiveSuggestion(run);
    if (!vm || dismissed.has(run.oid)) {
        return null;
    }
    const oref = proactiveNavOref(vm);
    return (
        <AmbientCard
            eyebrow={`Related prior work · ${vm.sourceType}`}
            dismissLabel="Dismiss suggestion"
            onDismiss={() => dismissProactive(run)}
            onClick={oref != null ? () => void openORef(model, oref) : undefined}
        >
            <div className="truncate text-[12.5px] font-semibold text-secondary" title={vm.title}>
                {vm.title}
            </div>
            {vm.snippet ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted">{vm.snippet}</div> : null}
        </AmbientCard>
    );
}
```

- [ ] **Step 2: Pass the model at the render site**

In `frontend/app/view/jarvis/ambientrailview.tsx:38`, change:

```tsx
{model.proactiveRun != null ? <ProactiveCard model={model} run={model.proactiveRun} /> : null}
```

(`model` is already in scope — `ambientSection` obtains it via `ambientRailFor(input)`.)

- [ ] **Step 3: Typecheck + run the agents and jarvis unit suites**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — Expected: clean (exit 0).
Run: `npx vitest run frontend/app/view/agents frontend/app/view/jarvis` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/proactiveviews.tsx frontend/app/view/jarvis/ambientrailview.tsx
git commit -m "feat(jarvis): proactive card navigates to the cited vault node on click"
```

---
### Task 4: CDP scenario — click navigates to the Memory surface

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (the `jarvis-proactive` scenario, ~line 952; fixture consts ~line 940)

**Interfaces:**
- Consumes: nothing new — the scenario's existing `setmeta` injection + `h.ev`/`h.rpc` harness.
- Produces: the scenario's assert covers the click → Memory-surface switch (verification gate for Tasks 2–3; wiring verified live, no jsdom).

- [ ] **Step 1: Switch the injected fixture to a memory hit**

In `scripts/cdp/scenarios.mjs`, the fixture is currently a *decision* hit — with Task 1's mapping that is the non-navigable path, so the click could never fire. Change it to a memory hit with a distinctive id:

```js
const PROACTIVE_SUGGESTION = {
    status: "hit",
    nodeId: "verify-proactive-nav",
    sourceType: "memory",
    title: PROACTIVE_TITLE,
    snippet: "chose drop-oldest to bound memory",
    why: "Related to this run",
};
```

- [ ] **Step 2: Add the click + navigation assert**

In the scenario's `assert(h, ctx)` (after the existing render/dismiss steps), append a click step. The Memory surface header renders the unique string "What your agents remember" (`memorysurface.tsx:72` — absent anywhere else, unlike the rail label "Memory"), so poll body text for it:

```js
await h.ev("new Promise((r) => setTimeout(r, 500))");
let clicked = false;
for (let i = 0; i < 20; i++) {
    clicked = await h.ev(`(() => {
        const b = [...document.querySelectorAll('button')].find(
            (x) => (x.textContent || '').includes('${PROACTIVE_TITLE}')
        );
        if (!b) return false;
        b.click();
        return true;
    })()`);
    if (clicked) break;
    await h.ev("new Promise((r) => setTimeout(r, 500))");
}
steps.push({ ok: clicked, desc: "the suggestion card is present and clickable" });
let onMemory = false;
for (let i = 0; i < 20; i++) {
    await h.ev("new Promise((r) => setTimeout(r, 500))");
    onMemory = await h.ev(`(() => (document.body.innerText || '').includes('What your agents remember'))()`);
    if (onMemory) break;
}
steps.push({ ok: onMemory, desc: "clicking the card navigates to the Memory surface (memnote:<id>)" });
```

Note: the injected `nodeId` need not exist in the vault — `selectNote` opens the rail with the id selected even when unresolvable (documented degradation in the spec §3); this step verifies the navigation mechanics.

- [ ] **Step 3: Run the scenario**

Run: `task verify:ui -- jarvis-proactive`
Expected: the scenario passes, including the two new steps. (Requires the live dev app on :9222 per `task verify:ui`; the existing render + dismiss steps must stay green — dismissal is unchanged.)

- [ ] **Step 4: Commit (feature + docs, per repo convention: spec/plan fold into the feature commit)**

```bash
git add scripts/cdp/scenarios.mjs docs/superpowers/specs/2026-08-14-jarvis-s3-proactive-deep-link-design.md docs/superpowers/plans/2026-08-14-jarvis-s3-proactive-deep-link.md
git commit -m "feat(jarvis): proactive card deep-link opens the cited vault node

click the related-prior-work card to jump to its source: dossier hits open the
jarvis dossier subject, memory hits open the memory surface note. pure FE slice
over the existing run.Meta payload + openORef; AmbientCard body becomes a button
when navigable. spec + plan folded in."
```

---
## Self-Review Notes

- **Spec coverage:** §1 mapping → Task 1; §2 component + render site → Tasks 2–3; §3 degradation (empty nodeId / unknown sourceType → non-clickable) → Task 1 tests + Task 3 wiring; Testing (unit + CDP) → Tasks 1 and 4. Out-of-scope items (Ask Jarvis action, `why` rendering, decision nav kind, `vault:` alias) are deliberately absent — no tasks.
- **No placeholders:** every step carries the exact code or command it needs; no "add error handling" or "similar to" refs.
- **Type consistency:** `proactiveNavOref(vm: ProactiveVM | null): string | null` defined in Task 1 is the exact call in Task 3 (`const oref = proactiveNavOref(vm)`); `openORef(model, oref)` matches the existing signature (`(model: AgentsViewModel, oref: string, anchor?: string)`); `ProactiveCard({ model, run })` matches the render-site change in Task 3 Step 2.
