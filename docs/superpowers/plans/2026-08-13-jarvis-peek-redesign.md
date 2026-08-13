# Jarvis Peek Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Jarvis peek as a 420px balanced hub with stable System status, Recent updates, and Ask Jarvis modules while preserving all existing reads, actions, and persistence.

**Architecture:** Keep the existing pure derivations and action runner as the source of truth. Regroup their output inside `PetPeek`, keep `PetErrand` focused on draft/submission rendering, and use `FloatingFocusManager` around the existing anchored popover for dialog focus. Render behavior stays frontend-only; the only non-visual behavior change separates composer input locking from submission blocking and closes the peek when handing focus to the existing prune confirmation modal.

**Tech Stack:** React 19, TypeScript, Jotai, Tailwind CSS 4 theme tokens, `@floating-ui/react`, Motion `PopoverReveal`, Vitest, CDP UI scenarios.

## Global Constraints

- Preserve the three peer modules exactly: **System status**, **Recent updates**, and **Ask Jarvis**.
- Nominal panel width is `420px`; cap it to `calc(100vw - 16px)` and cap height to `calc(100vh - 16px)`.
- Keep both existing bottom-corner placements and the existing `12px` anchor offset.
- The header never scrolls; the body is the outer fallback scroll region.
- Waiting items, Recent updates, and the errand reply each remain independently bounded.
- Preserve `conditionLine`, `recallLine`, `passLine`, `actsForRecall`, `actsForVault`, `actsForAttention`, and `actsForEvent` as the behavioral sources of truth.
- Preserve all current RPCs, atoms, tier checks, navigation targets, streaming behavior, and channel persistence.
- Use Tailwind utilities and existing `@theme` tokens only. Add no SCSS, raw component colors, global stylesheet rules, or component-specific CSS hooks.
- Add no dependency, backend change, generated file, RPC, migration, atom, poller, or persisted setting.
- Do not hand-edit generated files and do not run `task generate`.
- Follow the repository's no-jsdom convention: pure behavior belongs in Vitest; rendered behavior belongs in CDP.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`; bare `npx tsc` is prohibited because it stack-overflows in this repository.
- Keep unrelated working-tree changes untouched: `docs/deferred.md`, `pkg/memvault/projection.go`, `pkg/memvault/projection_test.go`, `pkg/wshrpc/wshserver/wshserver_ask_test.go`, `docs/superpowers/plans/2026-08-13-pi-ask-prose-bridge.md`, and `docs/superpowers/specs/2026-08-13-jarvis-landing-briefing-design.md` belong to other work.
- Never commit without explicit user approval. Unlike the generic skill template, this repository batches the spec, plan, implementation, and tests into one final feature commit.

---

## File Structure

| File                                                               | Responsibility in this change                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `frontend/app/view/jarvis/peterrandmodel.test.ts`                  | Regression contract for input locking versus Ask-button blocking.                                                         |
| `frontend/app/view/jarvis/peterrandmodel.ts`                       | Pure composer availability state: `inputDisabled`, `submitDisabled`, reason, runtime.                                     |
| `frontend/app/view/jarvis/peterrand.tsx`                           | Ask Jarvis module body, active-channel copy, harness metadata, submission, and bounded reply.                             |
| `frontend/app/view/jarvis/petactrun.test.ts`                       | Regression contract for handing clear-superseded focus from the peek to the confirmation modal.                           |
| `frontend/app/view/jarvis/petactrun.ts`                            | Close the peek only after the existing confirmation modal opens successfully.                                             |
| `frontend/app/view/jarvis/petstore.ts`                             | Extend the existing dev-only CDP hook with a deterministic ephemeral peek reset; no production or persisted state change. |
| `frontend/app/view/jarvis/petpeek.tsx`                             | Structured panel shell, status grid, priority banner, waiting list, update feed, focus management, and full-view handoff. |
| `scripts/cdp/scenarios.mjs`                                        | New empty/narrow/focus scenario plus scoped updates to the populated volunteer scenario.                                  |
| `docs/superpowers/specs/2026-08-13-jarvis-peek-redesign-design.md` | Approved design; include in the final feature commit.                                                                     |
| `docs/superpowers/plans/2026-08-13-jarvis-peek-redesign.md`        | This implementation plan; include in the final feature commit.                                                            |

No new source file is needed. The component has one consumer, and the existing pure modules already own the non-visual decisions.

---

### Task 1: Separate composer input locking from submission blocking

**Files:**

- Modify: `frontend/app/view/jarvis/peterrandmodel.test.ts:1-49`
- Modify: `frontend/app/view/jarvis/peterrandmodel.ts:19-46`
- Modify: `frontend/app/view/jarvis/peterrand.tsx:20-75`

**Interfaces:**

- Consumes: `petErrandState(input: PetErrandStateInput)` and the existing `HarnessInfo` catalog.
- Produces: `PetErrandState = { inputDisabled: boolean; submitDisabled: boolean; reason: string | null; runtime: string }`.
- Produces: an empty draft leaves the input editable but disables Ask.
- Produces: no channel or a streaming reply disables both input and Ask.

- [ ] **Step 1: Replace the model tests with the desired state contract**

Keep the existing `harnesses` fixture and replace the `describe("petErrandState", ...)` body with:

```ts
describe("petErrandState", () => {
  it("locks both controls when there is no channel", () => {
    expect(
      petErrandState({
        channel: false,
        draft: "ask",
        busy: false,
        runtime: "opencode",
        saving: false,
        harnesses,
      })
    ).toEqual({
      inputDisabled: true,
      submitDisabled: true,
      reason: "no channel active",
      runtime: "opencode",
    });
  });

  it("locks both controls while a reply is streaming", () => {
    expect(
      petErrandState({
        channel: true,
        draft: "ask",
        busy: true,
        runtime: "opencode",
        saving: false,
        harnesses,
      })
    ).toEqual({
      inputDisabled: true,
      submitDisabled: true,
      reason: "busy",
      runtime: "opencode",
    });
  });

  it("keeps an empty draft editable while blocking only submission", () => {
    expect(
      petErrandState({
        channel: true,
        draft: "  ",
        busy: false,
        runtime: "opencode",
        saving: false,
        harnesses,
      })
    ).toEqual({
      inputDisabled: false,
      submitDisabled: true,
      reason: "empty draft",
      runtime: "opencode",
    });
  });

  it("keeps the draft editable while the harness choice is unresolved", () => {
    expect(
      petErrandState({
        channel: true,
        draft: "ask",
        busy: false,
        runtime: "",
        saving: false,
        harnesses,
      })
    ).toEqual({
      inputDisabled: false,
      submitDisabled: true,
      reason: "Choose a harness",
      runtime: "",
    });

    const notInstalled = harnesses.map((h) => (h.runtime === "opencode" ? { ...h, installed: false } : h));
    expect(
      petErrandState({
        channel: true,
        draft: "ask",
        busy: false,
        runtime: "opencode",
        saving: false,
        harnesses: notInstalled,
      })
    ).toEqual({
      inputDisabled: false,
      submitDisabled: true,
      reason: "Choose a harness",
      runtime: "opencode",
    });
  });

  it("keeps the draft editable while the harness preference is saving", () => {
    expect(
      petErrandState({
        channel: true,
        draft: "ask",
        busy: false,
        runtime: "opencode",
        saving: true,
        harnesses,
      })
    ).toEqual({
      inputDisabled: false,
      submitDisabled: true,
      reason: "saving harness preference…",
      runtime: "opencode",
    });
  });

  it("enables both controls for a non-empty draft and valid harness", () => {
    expect(
      petErrandState({
        channel: true,
        draft: "ask",
        busy: false,
        runtime: "opencode",
        saving: false,
        harnesses,
      })
    ).toEqual({
      inputDisabled: false,
      submitDisabled: false,
      reason: null,
      runtime: "opencode",
    });
  });
});
```

The mutation this catches is the current bug: returning one shared `disabled: true` value for an empty draft makes the input impossible to type into.

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
npx vitest run frontend/app/view/jarvis/peterrandmodel.test.ts
```

Expected: FAIL because `inputDisabled` and `submitDisabled` are absent; the empty-draft expectation must report `undefined` instead of `false`/`true`.

- [ ] **Step 3: Replace the model result type and function**

Replace the file's opening availability comment with:

```ts
// Pure availability derivation for Pet Errand. No channel or an in-flight reply locks the field;
// draft and harness validity block dispatch without blocking composition. Keeping those decisions separate
// prevents an empty draft from disabling the very field needed to make it non-empty.
```

Replace `PetErrandState` and `petErrandState` in `peterrandmodel.ts` with:

```ts
export interface PetErrandState {
  inputDisabled: boolean;
  submitDisabled: boolean;
  reason: string | null;
  runtime: string;
}

export function petErrandState(input: PetErrandStateInput): PetErrandState {
  if (!input.channel) {
    return {
      inputDisabled: true,
      submitDisabled: true,
      reason: "no channel active",
      runtime: input.runtime,
    };
  }
  if (input.busy) {
    return {
      inputDisabled: true,
      submitDisabled: true,
      reason: "busy",
      runtime: input.runtime,
    };
  }
  if (input.runtime === "") {
    return {
      inputDisabled: false,
      submitDisabled: true,
      reason: "Choose a harness",
      runtime: input.runtime,
    };
  }
  if (input.saving) {
    return {
      inputDisabled: false,
      submitDisabled: true,
      reason: "saving harness preference…",
      runtime: input.runtime,
    };
  }
  const harness = input.harnesses.find((candidate) => candidate.runtime === input.runtime);
  if (harness == null || !harness.installed || !supportsOperation(harness, "consult")) {
    return {
      inputDisabled: false,
      submitDisabled: true,
      reason: "Choose a harness",
      runtime: input.runtime,
    };
  }
  if (input.draft.trim() === "") {
    return {
      inputDisabled: false,
      submitDisabled: true,
      reason: "empty draft",
      runtime: input.runtime,
    };
  }
  return {
    inputDisabled: false,
    submitDisabled: false,
    reason: null,
    runtime: input.runtime,
  };
}
```

- [ ] **Step 4: Update the existing composer to consume the split state before the visual rewrite**

In `peterrand.tsx`:

1. Keep `const blocked = state.reason;` for copy.
2. Change the send guard to:

```ts
if (!prompt || state.submitDisabled || channel == null) {
  return;
}
```

3. Change the input props to:

```tsx
disabled={state.inputDisabled}
placeholder={
    state.inputDisabled
        ? blocked === "no channel active"
            ? "Select a channel to ask Jarvis"
            : blocked === "busy"
              ? "Jarvis is thinking"
              : (blocked ?? "Ask Jarvis anything")
        : "Ask Jarvis anything"
}
```

4. Change the Ask button's disabled prop to:

```tsx
disabled={state.submitDisabled}
```

Do not change layout classes in this task; Task 3 replaces the presentation once this behavior is green.

- [ ] **Step 5: Run the focused tests and typecheck**

Run:

```bash
npx vitest run frontend/app/view/jarvis/peterrandmodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: 6 model tests PASS and TypeScript exits `0`.

- [ ] **Step 6: Record the task checkpoint without committing**

Run:

```bash
git diff --check -- \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrand.tsx
git diff --stat -- \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrand.tsx
```

Expected: no whitespace errors and only the three listed files in this checkpoint. Do not commit.

---

### Task 2: Hand confirmation-modal focus off cleanly

**Files:**

- Modify: `frontend/app/view/jarvis/petactrun.test.ts:51-136`
- Modify: `frontend/app/view/jarvis/petactrun.ts:89-99`

**Interfaces:**

- Consumes: `runAct(model, act)` and `petPeekOpenAtom`.
- Produces: successful `clear-superseded` opens the existing confirmation and closes the peek.
- Produces: a synchronous confirmation-host failure leaves the peek open and reports the error through `petActStateAtom`.

- [ ] **Step 1: Add the failing focus-handoff assertions**

In the shared `afterEach`, add:

```ts
globalStore.set(petPeekOpenAtom, false);
```

Replace the two `runAct — clear superseded` tests with:

```ts
describe("runAct — clear superseded", () => {
  it("opens the existing confirm modal, then closes the peek so focus scopes do not compete", async () => {
    globalStore.set(petPeekOpenAtom, true);
    const act: PetAct = {
      id: "vault:clear-superseded",
      verb: "do",
      label: "Clear 2 superseded",
      op: { kind: "clear-superseded", count: 2 },
    };

    await runAct(model, act);

    expect(confirmPruneAllSuperseded).toHaveBeenCalledWith(2);
    expect(globalStore.get(petPeekOpenAtom)).toBe(false);
    expect(globalStore.get(petActStateAtom)["vault:clear-superseded"]).toBeUndefined();
  });

  it("keeps the peek open and reports the failure when the confirm modal cannot open", async () => {
    globalStore.set(petPeekOpenAtom, true);
    confirmPruneAllSuperseded.mockImplementation(() => {
      throw new Error("modal host missing");
    });
    const act: PetAct = {
      id: "vault:clear-superseded",
      verb: "do",
      label: "Clear 1 superseded",
      op: { kind: "clear-superseded", count: 1 },
    };

    await runAct(model, act);

    expect(globalStore.get(petPeekOpenAtom)).toBe(true);
    expect(globalStore.get(petActStateAtom)["vault:clear-superseded"]).toEqual({
      status: "error",
      text: "modal host missing",
    });
  });
});
```

The mutation this catches is closing before the confirmation opens: that would hide a modal-host failure instead of leaving it beside the act.

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
npx vitest run frontend/app/view/jarvis/petactrun.test.ts
```

Expected: FAIL because a successful clear leaves `petPeekOpenAtom` true.

- [ ] **Step 3: Close only after the confirmation host accepts the modal**

Replace the `clear-superseded` branch in `perform` with:

```ts
if (op.kind === "clear-superseded") {
  // The confirmation owns focus from here. Close only after pushModal succeeds so a missing modal host
  // can still report beside this act instead of disappearing with the peek.
  confirmPruneAllSuperseded(op.count);
  globalStore.set(petPeekOpenAtom, false);
  clearActState(act.id);
  return;
}
```

- [ ] **Step 4: Run the runner test and its neighboring act-contract test**

Run:

```bash
npx vitest run \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petacts.test.ts
```

Expected: both files PASS.

- [ ] **Step 5: Record the task checkpoint without committing**

Run:

```bash
git diff --check -- \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petactrun.ts
git diff --stat -- \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petactrun.ts
```

Expected: no whitespace errors and only the two listed files in this checkpoint. Do not commit.

---

### Task 3: Build and verify the structured Jarvis hub

**Files:**

- Modify: `scripts/cdp/scenarios.mjs:3055-3255,3900-3930`
- Modify: `frontend/app/view/jarvis/petstore.ts:195-223`
- Modify: `frontend/app/view/jarvis/petpeek.tsx:18-347`
- Modify: `frontend/app/view/jarvis/peterrand.tsx:12-87`

**Interfaces:**

- Consumes: Task 1's `PetErrandState.inputDisabled` and `submitDisabled`.
- Consumes: Task 2's successful confirmation-modal handoff.
- Consumes: `PetExpression`, `PetPosture`, `PetSignals`, `conditionLine`, `postureFor`, `recallLine`, `passLine`, and all four `actsFor*` functions.
- Produces: `[data-pet-peek]` with `role="dialog"`, an accessible label, and stable `[data-pet-section="status|updates|ask"]` sections.
- Produces: `[data-pet-peek-header]`, `[data-pet-peek-body]`, `[data-pet-errand-input]`, and `button[aria-label="Close Jarvis panel"]` for behavior-oriented CDP assertions.
- Produces: dev-only `__wavePetStore.resetPeek()` to clear ephemeral peek history before the empty-state scenario.
- Produces: `PetErrand({ channel }: { channel: Channel | null })`.

- [ ] **Step 1: Add a rendered regression scenario before changing the component**

Add this scenario immediately before `jarvisVolunteer` in `scripts/cdp/scenarios.mjs`:

```js
const jarvisPeek = {
  name: "jarvis-peek",
  surface: "cockpit",
  async arrange(h) {
    // petSaidAtom is session-scoped. Reloading gives this scenario a deterministic empty feed while
    // the persisted watermark still prevents old backend facts from speaking again.
    await h.ev("location.reload()");
    await h.ev("new Promise((r) => setTimeout(r, 2500))");
    const reset = await h.ev(`(() => {
            const store = globalThis.__wavePetStore;
            if (typeof store?.resetPeek !== 'function') return false;
            store.resetPeek();
            return true;
        })()`);
    return { reset };
  },
  async assert(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok, detail });
    const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
    const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      for (const type of ["keyDown", "keyUp"]) {
        await h.cdp("Input.dispatchKeyEvent", {
          type,
          key,
          code,
          windowsVirtualKeyCode,
          modifiers,
        });
      }
      await settle(350);
    };

    const creatureFocused = await h.ev(`(() => {
            const creature = document.querySelector('[aria-label="Jarvis condition"]');
            if (!creature) return false;
            creature.focus();
            return document.activeElement === creature;
        })()`);
    await press("Enter", "Enter", 13);

    const structure = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            if (!panel) return null;
            const labelledBy = panel.getAttribute('aria-labelledby');
            const label = labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : null;
            const sections = [...panel.querySelectorAll('[data-pet-section]')]
                .map((section) => section.getAttribute('data-pet-section'));
            const updates = panel.querySelector('[data-pet-section="updates"]');
            const input = panel.querySelector('[data-pet-errand-input]');
            const health = panel.querySelector('[data-pet-health]')?.textContent?.trim() ?? null;
            return {
                role: panel.getAttribute('role'),
                label,
                sections,
                health,
                close: panel.querySelector('button[aria-label="Close Jarvis panel"]') != null,
                panelFocused: document.activeElement === panel,
                emptyUpdates: (updates?.innerText || '').includes('No updates yet'),
                inputDisabled: input?.disabled ?? null,
                inputPlaceholder: input?.getAttribute('placeholder') ?? null,
            };
        })()`);
    rec(
      "1. keyboard open renders a labelled three-section dialog and focuses its container",
      creatureFocused === true &&
        structure?.role === "dialog" &&
        structure?.label === "Jarvis" &&
        JSON.stringify(structure?.sections) === JSON.stringify(["status", "updates", "ask"]) &&
        ["Needs attention", "Window constrained", "Vault needs review", "Needs you", "All quiet"].includes(
          structure?.health
        ) &&
        structure?.close === true &&
        structure?.panelFocused === true,
      JSON.stringify({ creatureFocused, structure })
    );

    await press("Tab", "Tab", 9);
    const firstTab = await h.ev(`(() => ({
            text: (document.activeElement?.innerText || '').trim(),
            inside: document.querySelector('[data-pet-peek]')?.contains(document.activeElement) ?? false,
        }))()`);
    await press("Tab", "Tab", 9, 8);
    const wrappedInside = await h.ev(
      `document.querySelector('[data-pet-peek]')?.contains(document.activeElement) ?? false`
    );
    rec(
      "2. Tab starts at Open full view and reverse traversal stays inside the dialog",
      firstTab.inside === true && firstTab.text === "Open full view" && wrappedInside === true,
      JSON.stringify({ firstTab, wrappedInside })
    );
    rec(
      "3. the empty/no-channel state is explicit without inventing activity",
      ctx.reset === true &&
        structure?.emptyUpdates === true &&
        structure?.inputDisabled === true &&
        structure?.inputPlaceholder === "Select a channel to ask Jarvis",
      JSON.stringify(structure)
    );
    await h.shot("cdp-shots/jarvis-peek-empty.png");

    await h.cdp("Emulation.setDeviceMetricsOverride", {
      width: 440,
      height: 420,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await settle(450);
    const narrow = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            const header = document.querySelector('[data-pet-peek-header]');
            const body = document.querySelector('[data-pet-peek-body]');
            if (!panel || !header || !body) return null;
            const rect = panel.getBoundingClientRect();
            const headerTop = Math.round(header.getBoundingClientRect().top);
            body.scrollTop = body.scrollHeight;
            const headerAfterScroll = Math.round(header.getBoundingClientRect().top);
            return {
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                horizontalOverflow: panel.scrollWidth - panel.clientWidth,
                bodyScrollable: body.scrollHeight > body.clientHeight,
                headerStayed: headerTop === headerAfterScroll,
            };
        })()`);
    rec(
      "4. the panel stays inside a 440x420 viewport with a fixed header and no horizontal overflow",
      narrow != null &&
        narrow.left >= 8 &&
        narrow.right <= narrow.viewportWidth - 8 &&
        narrow.top >= 8 &&
        narrow.bottom <= narrow.viewportHeight - 8 &&
        narrow.horizontalOverflow <= 0 &&
        narrow.bodyScrollable === true &&
        narrow.headerStayed === true,
      JSON.stringify(narrow)
    );
    await h.shot("cdp-shots/jarvis-peek-narrow.png");

    await press("Escape", "Escape", 27);
    const dismissed = await h.ev(`(() => ({
            panelGone: document.querySelector('[data-pet-peek]') == null,
            focusReturned: document.activeElement?.getAttribute('aria-label') === 'Jarvis condition',
        }))()`);
    rec(
      "5. Escape closes only the peek and returns focus to the creature",
      dismissed.panelGone === true && dismissed.focusReturned === true,
      JSON.stringify(dismissed)
    );
    const stayed = (await h.activeSurfaceLabel()) === SURFACE_LABEL.cockpit;
    rec("6. dismissing the global peek stays on the current surface", stayed, String(stayed));
    return steps;
  },
  async teardown(h) {
    await h.cdp("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 950,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await h.ev(`(() => {
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            return true;
        })()`);
    await h.goto("cockpit");
  },
};
```

Add `jarvisPeek` immediately before `jarvisVolunteer` in the exported `SCENARIOS` array.

Update `jarvisVolunteer` in the same red-test edit:

1. Normalize an already-open panel with `button[aria-label="Close Jarvis panel"]`, not visible `Esc` text.
2. Treat `document.querySelector('[data-pet-peek]') != null` as the open marker.
3. Scope product acts to the panel:

```js
const verbs = await h.ev(`(() => {
    const panel = document.querySelector('[data-pet-peek]');
    return {
        open: panel?.querySelector('[data-pet-act$=":open"]') != null,
        ask: panel?.querySelector('[data-pet-act$=":ask"]') != null,
    };
})()`);
```

4. Click the product with:

```js
const clicked = await h.ev(`(() => {
    const button = document.querySelector('[data-pet-peek] [data-pet-act$=":open"]');
    if (!button) return "no Open control";
    button.click();
    return true;
})()`);
```

5. Treat `document.querySelector('[data-pet-peek]') == null` as the closed marker in the assertion and teardown.

- [ ] **Step 2: Run the new CDP scenario and verify the red state**

With the current dev app running from this implementation tree, run:

```bash
task verify:ui -- jarvis-peek
```

Expected: FAIL at step 1 because the current panel has no dialog role, no accessible close button, no `status|updates|ask` section contract, and no `resetPeek` test hook. A connection error is not a valid red state; start `task dev` and rerun until the scenario reaches the assertion.

- [ ] **Step 3: Make the empty-state setup deterministic through the existing dev hook**

Move the existing `if (import.meta.env.DEV) { ... }` hook in `petstore.ts` below `petErrandAtom`, then replace it with:

```ts
// CDP drives inputs that are either too expensive to arrange through production (a volunteer judge) or
// must be deterministic (the empty peek). This is compiled out of production builds.
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).__wavePetStore = {
    pushPetEvent,
    resetPeek: () => {
      globalStore.set(petEventsAtom, []);
      globalStore.set(petSaidAtom, []);
      globalStore.set(petBubbleAtom, null);
      globalStore.set(petUnreadAtom, false);
      globalStore.set(petActStateAtom, {});
      globalStore.set(petErrandAtom, null);
    },
  };
}
```

Do not clear or persist `petWatermarkAtom`, `petLastPassAtom`, `petIndexAtom`, or the corner. The hook resets only ephemeral panel state and remains behind `import.meta.env.DEV`.

- [ ] **Step 4: Replace the flat row helpers with structured local presentation helpers**

In `petpeek.tsx`, update imports as follows:

```ts
import { activeChannelAtom, channelsAtom } from "@/app/view/agents/channelsstore";
import { FloatingFocusManager, autoUpdate, offset, shift, useFloating, type Placement } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { AlertTriangle, X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { conditionLine, postureFor, type PetExpression, type PetPosture, type PetSignals } from "./petcondition";
import type { PetEvent } from "./petvoice";
```

Keep the existing imports not replaced by this block. Remove the old `TONE`, `Row`, and `SectionLabel` declarations. Replace `Acts` and `Waiting` with these helpers:

```tsx
type StatusTone = "ok" | "warning" | "error" | "unknown";
type ActTone = "primary" | "quiet";

const STATUS_DOT: Record<StatusTone, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  unknown: "bg-ink-faint",
};

const POSTURE_LABEL: Record<PetPosture, string> = {
  "review-gate": "Review gate",
  escalation: "Escalation",
  "blocked-worker": "Blocked worker",
  none: "Nothing",
};

const HEALTH_STYLE = {
  error: "border-error/30 bg-error/10 text-error-soft",
  warning: "border-warning/30 bg-warning/10 text-warning-soft",
  success: "border-success/30 bg-success/10 text-success-soft",
} as const;

function healthFor(
  expression: PetExpression,
  posture: PetPosture
): { label: string; style: keyof typeof HEALTH_STYLE } {
  if (expression.kind === "cannot-see") {
    return { label: "Needs attention", style: "error" };
  }
  if (expression.kind === "tired") {
    return { label: "Window constrained", style: "warning" };
  }
  if (expression.kind === "drifting") {
    return { label: "Vault needs review", style: "warning" };
  }
  if (posture !== "none") {
    return { label: "Needs you", style: "warning" };
  }
  return { label: "All quiet", style: "success" };
}

function actLeavesPeek(act: PetAct): boolean {
  return act.verb !== "do" || act.op.kind === "clear-superseded";
}

function Acts({
  model,
  acts,
  tone = "quiet",
  className,
  onLeave,
}: {
  model: AgentsViewModel;
  acts: PetAct[];
  tone?: ActTone;
  className?: string;
  onLeave: () => void;
}) {
  const state = useAtomValue(petActStateAtom);
  if (acts.length === 0) {
    return null;
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {acts.map((act, index) => {
        const current = state[act.id];
        const primary = tone === "primary" && index === 0;
        return (
          <span key={act.id} className="flex max-w-full min-w-0 items-center gap-1.5">
            <button
              type="button"
              data-pet-act={act.id}
              disabled={current?.status === "running"}
              onClick={() => {
                if (actLeavesPeek(act)) {
                  onLeave();
                }
                fireAndForget(() => runAct(model, act));
              }}
              className={cn(
                "min-h-8 max-w-full whitespace-normal rounded-[7px] px-2.5 text-left text-[11px] font-semibold",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                "disabled:cursor-default disabled:bg-surface-hover disabled:text-muted",
                primary
                  ? "bg-accent text-background hover:bg-accenthover"
                  : "border border-edge-mid bg-surface-raised text-accent-soft hover:bg-surface-hover"
              )}
            >
              {act.label}
            </button>
            {current?.text != null ? (
              <span
                className={cn("text-[10.5px] leading-[1.35]", current.status === "error" ? "text-error" : "text-muted")}
              >
                {current.text}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function PanelSection({
  name,
  labelId,
  title,
  meta,
  children,
}: {
  name: "status" | "updates" | "ask";
  labelId: string;
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-pet-section={name}
      aria-labelledby={labelId}
      className="overflow-hidden rounded-[10px] border border-border bg-surface"
    >
      <div className="flex min-h-[40px] items-center gap-2 border-b border-border px-3">
        <h3
          id={labelId}
          className="flex-none font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-muted"
        >
          {title}
        </h3>
        {meta != null ? (
          <span className="ml-auto min-w-0 text-right text-[10px] leading-[1.35] text-muted">{meta}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatusMetric({
  label,
  value,
  detail,
  tone,
  className,
  children,
}: {
  label: string;
  value: string;
  detail?: string;
  tone: StatusTone;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 p-2.5", className)}>
      <span className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
        <span className={cn("h-[5px] w-[5px] flex-none rounded-full", STATUS_DOT[tone])} />
        {label}
      </span>
      <strong className="mt-1.5 block text-[11.5px] font-semibold leading-[1.35] text-secondary">{value}</strong>
      {detail != null ? <span className="mt-0.5 block text-[10px] leading-[1.35] text-muted">{detail}</span> : null}
      {children}
    </div>
  );
}

function WaitingItems({
  model,
  items,
  channels,
  now,
  onLeave,
}: {
  model: AgentsViewModel;
  items: AttentionItem[];
  channels: Channel[] | null;
  now: number;
  onLeave: () => void;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="max-h-[144px] overflow-y-auto border-t border-border">
      {items.map((item) => {
        const channel = (channels ?? []).find((candidate) => candidate.oid === item.channelid);
        const tier = tierFromMeta(channel?.meta);
        return (
          <div key={item.key} className="flex flex-col gap-1.5 border-b border-border px-3 py-2.5 last:border-b-0">
            <div className="flex min-w-0 items-start gap-2">
              <span className="min-w-0 flex-1 text-[11.5px] font-medium leading-[1.35] text-secondary">
                {item.source || item.text}
              </span>
              <Acts model={model} acts={actsForAttention(item, tier)} onLeave={onLeave} />
            </div>
            <span className="font-mono text-[9.5px] text-muted">
              {item.action} · {ageLabel(Math.max(0, now - item.waitingsince))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function UpdateItem({
  model,
  event,
  now,
  noteExists,
  onLeave,
}: {
  model: AgentsViewModel;
  event: PetEvent;
  now: number;
  noteExists: (id: string) => boolean | undefined;
  onLeave: () => void;
}) {
  return (
    <div className="grid grid-cols-[2px_minmax(0,1fr)] gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0">
      <span className="rounded-full bg-edge-strong" />
      <div className="min-w-0">
        <span className="text-[11.5px] leading-[1.45] text-secondary">{event.text}</span>
        <span className="mt-1 block font-mono text-[9.5px] text-muted">
          {event.kind} · {ageLabel(Math.max(0, now - event.at))}
        </span>
        <Acts model={model} acts={actsForEvent(event, noteExists)} className="mt-1.5" onLeave={onLeave} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Regroup `PetPeek` data and add modal focus management**

At the top of `PetPeek`, add these reads beside the existing atom reads:

```ts
const items = useAtomValue(attentionAtom);
const channels = useAtomValue(channelsAtom);
const activeChannel = useAtomValue(activeChannelAtom);
```

After `const now = useAtomValue(model.nowAtom);`, replace the old close/placement setup with:

```ts
const posture = postureFor(signals);
const health = healthFor(expression, posture);
const titleId = useId();
const panelRef = useRef<HTMLDivElement | null>(null);
const returnFocusRef = useRef<HTMLElement | null>(anchor);

const close = () => {
  returnFocusRef.current = anchor;
  globalStore.set(petPeekOpenAtom, false);
};
const leavePeek = () => {
  returnFocusRef.current = null;
};

const { refs, floatingStyles, context } = useFloating({
  open,
  placement: PLACEMENT[corner],
  strategy: "fixed",
  middleware: [offset(12), shift({ padding: 8 })],
  whileElementsMounted: autoUpdate,
});

useEffect(() => {
  refs.setPositionReference(anchor);
}, [anchor, refs]);

useEffect(() => {
  if (open) {
    returnFocusRef.current = anchor;
  }
}, [anchor, open]);

useEffect(() => {
  if (!open) {
    return;
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      returnFocusRef.current = anchor;
      globalStore.set(petPeekOpenAtom, false);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [anchor, open]);
```

Keep the existing `noteExists`, index status, recall, rate-limit, and decay reads. Delete the old `openJarvis` declaration, then add these view derivations before `return` (the replacement `openJarvis` is the final declaration in this block):

```ts
const recallActs = actsForRecall(indexStatus);
const vaultActs = actsForVault(pruneCandidates);
const priorityActs = expression.kind === "cannot-see" ? recallActs : expression.kind === "drifting" ? vaultActs : [];
const priorityDetail =
  expression.kind === "cannot-see"
    ? recall.text
    : expression.kind === "drifting"
      ? decay != null && decay.staleNotes > 0
        ? `${decay.staleNotes} marked stale`
        : "Review the cleanup queue."
      : null;

const recallValue =
  indexStatus == null
    ? "Not read yet"
    : indexStatus.state === "ok"
      ? "Ready"
      : indexStatus.state === "stale"
        ? "Stale"
        : "Unavailable";
const recallTone: StatusTone = indexStatus == null ? "unknown" : indexStatus.state === "ok" ? "ok" : "error";

const windowValue =
  rl == null
    ? "No reading"
    : expression.kind === "tired"
      ? "Constrained"
      : `${providerLabel(rl.provider)} · ${Math.round(rl.pct)}% used`;
const windowDetail =
  expression.kind === "tired"
    ? undefined
    : rl == null
      ? "Usage unavailable"
      : rl.resetAt != null
        ? `resets in ${formatReset(rl.resetAt, now)}`
        : "current five-hour window";

const vaultValue =
  decay == null
    ? "No reading"
    : decay.queueDepth === 0
      ? "Clear"
      : expression.kind === "drifting"
        ? "Needs review"
        : `${decay.queueDepth} to review`;
const vaultDetail =
  expression.kind === "drifting"
    ? undefined
    : decay == null
      ? "Cleanup status unavailable"
      : decay.queueDepth === 0
        ? "No cleanup needed"
        : `${decay.staleNotes} stale`;
const vaultTone: StatusTone = decay == null ? "unknown" : decay.queueDepth === 0 ? "ok" : "warning";

const oldestWaiting = items.length === 0 ? null : Math.min(...items.map((item) => item.waitingsince));
const waitingValue = POSTURE_LABEL[posture];
const waitingDetail =
  oldestWaiting == null ? "No action needed" : `oldest · ${ageLabel(Math.max(0, now - oldestWaiting))}`;

const openJarvis = () => {
  leavePeek();
  globalStore.set(model.surfaceAtom, "jarvis");
  globalStore.set(petPeekOpenAtom, false);
};
```

Replace the current returned panel markup with this structure:

```tsx
return (
  <>
    {open ? <div className="fixed inset-0 z-[64]" onClick={close} /> : null}
    <div ref={refs.setFloating} style={floatingStyles} className="z-[65]">
      <FloatingFocusManager
        context={context}
        disabled={!open}
        initialFocus={panelRef}
        returnFocus={returnFocusRef}
        modal
      >
        <PopoverReveal
          open={open}
          origin={ORIGIN[corner]}
          className="flex max-h-[calc(100vh-16px)] w-[calc(100vw-16px)] max-w-[420px] flex-col overflow-hidden rounded-[12px] border border-border bg-surface-raised shadow-popover"
        >
          <div
            ref={panelRef}
            data-pet-peek="1"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col focus:outline-none"
          >
            <div
              data-pet-peek-header
              className="flex min-h-[52px] flex-none items-center gap-2 border-b border-border px-3.5"
            >
              <h2 id={titleId} className="text-[14px] font-bold text-primary">
                Jarvis
              </h2>
              <span
                data-pet-health
                className={cn(
                  "inline-flex min-w-0 max-w-[132px] items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold",
                  HEALTH_STYLE[health.style]
                )}
              >
                <span className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
                <span className="truncate">{health.label}</span>
              </span>
              <div className="flex-1" />
              <button
                type="button"
                aria-label="Open full Jarvis view"
                onClick={openJarvis}
                className="min-h-8 flex-none whitespace-nowrap rounded-[7px] px-2 text-[11px] text-muted hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="min-[380px]:hidden">Open</span>
                <span className="hidden min-[380px]:inline">Open full view</span>
              </button>
              <button
                type="button"
                aria-label="Close Jarvis panel"
                onClick={close}
                className="flex h-8 w-8 items-center justify-center rounded-[7px] border border-border text-muted hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X aria-hidden="true" size={15} strokeWidth={2} />
              </button>
            </div>

            <div data-pet-peek-body className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
              <PanelSection name="status" labelId={`${titleId}-status`} title="System status">
                {expression.kind !== "at-rest" ? (
                  <div
                    className={cn(
                      "m-2.5 rounded-[9px] border p-2.5",
                      expression.kind === "cannot-see"
                        ? "border-error/30 bg-error/10"
                        : "border-warning/30 bg-warning/10"
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle
                        aria-hidden="true"
                        size={17}
                        className={cn(
                          "mt-0.5 flex-none",
                          expression.kind === "cannot-see" ? "text-error" : "text-warning"
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "text-[12.5px] font-semibold leading-[1.4]",
                            expression.kind === "cannot-see" ? "text-error" : "text-warning"
                          )}
                        >
                          {conditionLine(expression, now)}
                        </p>
                        {priorityDetail != null ? (
                          <p className="mt-1 text-[10.5px] leading-[1.4] text-muted">{priorityDetail}</p>
                        ) : null}
                        <Acts model={model} acts={priorityActs} tone="primary" className="mt-2" onLeave={leavePeek} />
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="grid grid-cols-2">
                  <StatusMetric
                    label="Recall"
                    value={recallValue}
                    detail={expression.kind === "cannot-see" ? undefined : recall.text}
                    tone={recallTone}
                    className="border-r border-border"
                  >
                    {expression.kind !== "cannot-see" ? (
                      <Acts model={model} acts={recallActs} className="mt-2" onLeave={leavePeek} />
                    ) : null}
                  </StatusMetric>
                  <StatusMetric
                    label="Window"
                    value={windowValue}
                    detail={windowDetail}
                    tone={rl == null ? "unknown" : expression.kind === "tired" ? "warning" : "ok"}
                  />
                  <StatusMetric
                    label="Vault"
                    value={vaultValue}
                    detail={vaultDetail}
                    tone={vaultTone}
                    className="border-r border-t border-border"
                  >
                    {expression.kind !== "drifting" ? (
                      <Acts model={model} acts={vaultActs} className="mt-2" onLeave={leavePeek} />
                    ) : null}
                  </StatusMetric>
                  <StatusMetric
                    label="Waiting"
                    value={waitingValue}
                    detail={waitingDetail}
                    tone={items.length === 0 ? "ok" : "warning"}
                    className="border-t border-border"
                  />
                </div>

                <WaitingItems model={model} items={items} channels={channels} now={now} onLeave={leavePeek} />
              </PanelSection>

              <PanelSection
                name="updates"
                labelId={`${titleId}-updates`}
                title="Recent updates"
                meta={passLine(lastPass, now)}
              >
                {said.length === 0 ? (
                  <div className="grid grid-cols-[2px_minmax(0,1fr)] gap-2.5 px-3 py-3">
                    <span className="rounded-full bg-edge-strong" />
                    <div>
                      <span className="block text-[11.5px] font-medium text-secondary">No updates yet</span>
                      <span className="mt-1 block text-[10px] leading-[1.4] text-muted">
                        Jarvis will keep spoken updates and their actions here.
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="max-h-[176px] overflow-y-auto">
                    {said.map((event) => (
                      <UpdateItem
                        key={event.id}
                        model={model}
                        event={event}
                        now={now}
                        noteExists={noteExists}
                        onLeave={leavePeek}
                      />
                    ))}
                  </div>
                )}
              </PanelSection>

              <PanelSection
                name="ask"
                labelId={`${titleId}-ask`}
                title="Ask Jarvis"
                meta={activeChannel == null ? "No channel selected" : `#${activeChannel.name}`}
              >
                <PetErrand channel={activeChannel} />
              </PanelSection>
            </div>
          </div>
        </PopoverReveal>
      </FloatingFocusManager>
    </div>
  </>
);
```

Remove the old bottom `Open Jarvis` button; its behavior now lives in the header.

- [ ] **Step 6: Rewrite `PetErrand` as the Ask section body**

Remove the `activeChannelAtom` import. Change the function signature and returned markup to:

```tsx
export function PetErrand({ channel }: { channel: Channel | null }) {
  const errand = useAtomValue(petErrandAtom);
  const pref = useAtomValue(harnessPreferenceAtom);
  const harnesses = useAtomValue(harnessesAtom);
  const [draft, setDraft] = useState("");

  const busy = errand?.status === "streaming";
  const state = petErrandState({
    channel: channel != null,
    draft,
    busy,
    runtime: pref.runtime,
    saving: pref.saving,
    harnesses,
  });
  const placeholder = state.inputDisabled
    ? state.reason === "no channel active"
      ? "Select a channel to ask Jarvis"
      : state.reason === "busy"
        ? "Jarvis is thinking"
        : (state.reason ?? "Ask Jarvis anything")
    : "Ask Jarvis anything";
  const hint =
    state.reason != null &&
    state.reason !== "empty draft" &&
    state.reason !== "no channel active" &&
    state.reason !== "busy"
      ? state.reason
      : busy
        ? "Jarvis is thinking"
        : "Replies are saved to the active channel";

  const send = () => {
    const prompt = draft.trim();
    if (!prompt || state.submitDisabled || channel == null) {
      return;
    }
    setDraft("");
    fireAndForget(() => sendErrand(channel.oid, state.runtime, prompt));
  };

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <input
          data-pet-errand-input
          aria-label="Ask Jarvis"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              send();
            }
          }}
          disabled={state.inputDisabled}
          placeholder={placeholder}
          className="min-h-9 min-w-0 flex-1 rounded-[8px] border border-border bg-background px-2.5 text-[11.5px] text-secondary placeholder:text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default"
        />
        <button
          type="button"
          onClick={send}
          disabled={state.submitDisabled}
          className="min-h-9 flex-none rounded-[8px] bg-accent px-3 text-[11px] font-bold text-background hover:bg-accenthover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:bg-surface-hover disabled:text-muted"
        >
          Ask
        </button>
      </div>

      <div className="mt-2 flex min-w-0 items-center gap-2 text-[9.5px] text-muted">
        <HarnessPicker operation="consult" placement="top-start" />
        <span className="min-w-0 flex-1 truncate">{hint}</span>
        <span className="flex-none font-mono">{channel == null ? "No destination" : `→ #${channel.name}`}</span>
      </div>

      {errand != null ? (
        <div className="mt-2.5 border-t border-border pt-2.5">
          <span className="font-mono text-[9.5px] text-muted">
            {errand.runtime} · {errand.status === "streaming" ? "thinking" : errand.status}
          </span>
          <span
            className={cn(
              "mt-1 block max-h-[120px] overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-[1.45]",
              errand.status === "error" ? "text-error" : "text-secondary"
            )}
          >
            {errand.text}
          </span>
        </div>
      ) : null}
    </div>
  );
}
```

Keep the existing state reads, Enter behavior, `sendErrand`, and streamed reply semantics exactly as shown.

- [ ] **Step 7: Format the changed frontend and scenario files**

Run:

```bash
npx prettier --write \
  frontend/app/view/jarvis/petpeek.tsx \
  frontend/app/view/jarvis/peterrand.tsx \
  frontend/app/view/jarvis/petstore.ts \
  scripts/cdp/scenarios.mjs
```

Expected: Prettier exits `0` and touches only the listed files.

- [ ] **Step 8: Run focused behavior tests and typecheck**

Run:

```bash
npx vitest run \
  frontend/app/view/jarvis/petcondition.test.ts \
  frontend/app/view/jarvis/petacts.test.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petjoin.test.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/store/keybindings/bindings.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: all focused tests PASS and TypeScript exits `0`.

- [ ] **Step 9: Run the empty, narrow, focus, and populated UI checks**

With `task dev` still running from this tree, run:

```bash
task verify:ui -- jarvis-peek jarvis-volunteer
```

Expected:

- `jarvis-peek`: 6/6 steps PASS;
- `jarvis-volunteer`: the bubble, scoped product Open/Ask acts, navigation, and close assertions PASS;
- `cdp-shots/jarvis-peek-empty.png` shows the empty/no-channel balanced hub;
- `cdp-shots/jarvis-peek-narrow.png` shows a bounded panel with the header visible;
- `cdp-shots/jarvis-volunteer-peek.png` shows the populated Recent updates module.

Open `cdp-shots/index.html` manually and reject the task if any of these are true:

- the priority banner repeats the same reason in the Recall cell;
- a waiting or update list pushes Ask Jarvis out without a scrollbar;
- header controls wrap;
- text or controls clip at 440px;
- focus styling is invisible against the active theme;
- the panel visually reads as one undifferentiated list instead of three modules.

- [ ] **Step 10: Run targeted lint and formatting checks**

Run:

```bash
npx eslint \
  frontend/app/view/jarvis/petpeek.tsx \
  frontend/app/view/jarvis/peterrand.tsx \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/petactrun.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petstore.ts \
  scripts/cdp/scenarios.mjs
npx prettier --check \
  frontend/app/view/jarvis/petpeek.tsx \
  frontend/app/view/jarvis/peterrand.tsx \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/petactrun.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petstore.ts \
  scripts/cdp/scenarios.mjs
```

Expected: both commands exit `0`. If ESLint reports a repository baseline issue outside these files, record it separately; do not reformat or refactor unrelated code.

- [ ] **Step 11: Record the task checkpoint without committing**

Run:

```bash
git diff --check -- \
  frontend/app/view/jarvis/petpeek.tsx \
  frontend/app/view/jarvis/peterrand.tsx \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/petactrun.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petstore.ts \
  scripts/cdp/scenarios.mjs
git diff --stat -- \
  frontend/app/view/jarvis/petpeek.tsx \
  frontend/app/view/jarvis/peterrand.tsx \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/petactrun.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petstore.ts \
  scripts/cdp/scenarios.mjs
```

Expected: no whitespace errors and only the eight implementation files in the scoped stat. Do not commit.

---

### Task 4: Perform final regression review and prepare the single commit gate

**Files:**

- Review: all files listed under File Structure
- Do not modify unrelated working-tree files

**Interfaces:**

- Consumes: all Task 1–3 outputs.
- Produces: fresh verification evidence, a self-reviewed diff, and a precisely scoped staging command.

- [ ] **Step 1: Run the complete focused regression suite fresh**

Run:

```bash
npx vitest run \
  frontend/app/view/jarvis/petcondition.test.ts \
  frontend/app/view/jarvis/petacts.test.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petjoin.test.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/store/keybindings/bindings.test.ts
```

Expected: every listed test file PASS with zero failures.

- [ ] **Step 2: Run the complete TypeScript check fresh**

Run:

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: exit `0` with no type errors.

- [ ] **Step 3: Run the live UI scenarios fresh**

Run:

```bash
task verify:ui -- jarvis-peek jarvis-volunteer
```

Expected: both scenarios PASS and the contact sheet is regenerated.

- [ ] **Step 4: Self-review only the feature diff**

Run:

```bash
# The spec and plan are intentionally untracked until the commit gate, so inspect them explicitly.
git diff --no-index -- /dev/null docs/superpowers/specs/2026-08-13-jarvis-peek-redesign-design.md || test $? -eq 1
git diff --no-index -- /dev/null docs/superpowers/plans/2026-08-13-jarvis-peek-redesign.md || test $? -eq 1
npx prettier --check \
  docs/superpowers/specs/2026-08-13-jarvis-peek-redesign-design.md \
  docs/superpowers/plans/2026-08-13-jarvis-peek-redesign.md

git diff -- \
  frontend/app/view/jarvis/petpeek.tsx \
  frontend/app/view/jarvis/peterrand.tsx \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/petactrun.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petstore.ts \
  scripts/cdp/scenarios.mjs
git diff --check -- \
  frontend/app/view/jarvis/petpeek.tsx \
  frontend/app/view/jarvis/peterrand.tsx \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/petactrun.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petstore.ts \
  scripts/cdp/scenarios.mjs
```

Reject the diff if it contains debug logging, commented-out code, raw colors, new SCSS, generated-file edits, duplicate state, a document-wide CDP button query, or changes outside the listed feature files.

- [ ] **Step 5: Report the verification evidence and request commit approval**

Report:

- exact Vitest file/test counts;
- TypeScript exit status;
- CDP scenario step counts;
- changed feature-file list;
- any skipped visual inspection or residual risk.

Do not say the work is complete if the live dev app was unavailable or the contact sheet was not inspected.

- [ ] **Step 6: Commit only after explicit approval**

After the user explicitly authorizes a commit, run:

```bash
git add \
  docs/superpowers/specs/2026-08-13-jarvis-peek-redesign-design.md \
  docs/superpowers/plans/2026-08-13-jarvis-peek-redesign.md \
  frontend/app/view/jarvis/petpeek.tsx \
  frontend/app/view/jarvis/peterrand.tsx \
  frontend/app/view/jarvis/peterrandmodel.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/view/jarvis/petactrun.ts \
  frontend/app/view/jarvis/petactrun.test.ts \
  frontend/app/view/jarvis/petstore.ts \
  scripts/cdp/scenarios.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "feat(jarvis): redesign the peek as a balanced hub"
```

Expected: exactly one feature commit containing the approved spec, this plan, implementation, and tests. Never stage the unrelated files named in Global Constraints, and never push without separate explicit approval.
