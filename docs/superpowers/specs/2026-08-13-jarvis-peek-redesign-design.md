# Jarvis peek redesign — a balanced hub instead of a diagnostic stack

**Date:** 2026-08-13
**Status:** Design approved
**Scope:** Frontend-only redesign of the existing Jarvis peek panel

Companion to `2026-08-04-jarvis-pet-design.md` and `2026-08-06-jarvis-acts-design.md`. Those documents still own the creature's registers, condition precedence, capabilities, and action semantics. This document changes how the existing information is grouped and presented.

## 1. Why

The peek began as a compact condition readout and accumulated actions, waiting items, spoken history, a last-pass reading, and an errand composer. The behavior is useful; the visual structure has not kept pace.

The current `326px` panel presents almost everything as one narrow vertical stack:

- a developer-facing expression kind beside the title;
- a condition sentence that often repeats the Recall row;
- five diagnostic rows with 9–11.5px labels and body text;
- a separately divided “What I've said” region;
- a composer whose disabled state dominates its placeholder;
- a final “Open Jarvis” link detached from the header.

The result is technically complete but visually undifferentiated. Telemetry, activity, actions, and asking compete at the same level. Empty states still consume substantial height, while important actions look like small incidental links.

The redesign treats the peek as a **balanced hub** with three peer jobs:

1. understand Jarvis's current system condition;
2. review what Jarvis recently said or did;
3. ask Jarvis to do an errand.

None is the permanent primary workflow. The hierarchy must make all three immediately legible without turning the anchored panel into a full surface.

## 2. Goals and non-goals

### Goals

- Give System status, Recent updates, and Ask Jarvis stable, equally legible sections.
- Keep the highest-priority condition and its remedy together.
- Make busy waiting and activity states predictable without allowing either to consume the panel.
- Improve typography, spacing, targets, focus behavior, and accessible naming.
- Preserve every existing read, action, stream, navigation path, and source of truth.
- Correct the existing composer-state conflation so an empty draft disables Ask without disabling the input.
- Use existing Tailwind `@theme` tokens exclusively.

### Non-goals

- No new Go, RPC, generated type, atom, poller, or persistence work.
- No change to condition precedence, act availability, tier checks, or errand dispatch semantics.
- No new Jarvis capability or inference.
- No redesign of the creature, speech bubble, or full Jarvis surface.
- No new shared component system for one panel.

## 3. Chosen direction

The panel becomes a **420px structured stack**: a compact header followed by three bordered modules. Width is capped to the available viewport so the same component remains usable in a narrow desktop window.

The structured stack was selected over two alternatives:

- **Tabbed hub:** calmer at rest, but hides two of the three peer jobs and adds navigation inside a transient popover.
- **Command center:** scans quickly, but a status rail beside an activity feed is too dense and operational for a 420px conversational panel.

Keeping the current width was rejected. At 326px, a balanced hub can only be achieved by hiding content or retaining the current tiny type and controls. A 500px mini-workspace was also rejected because it covers too much terminal content and begins competing with the full Jarvis surface.

## 4. Information architecture

### 4.1 Header

The header is navigation chrome, not a fourth content section. It contains:

1. **Jarvis** identity;
2. one plain-language health badge derived from the existing expression;
3. **Open full view**, using the existing `openJarvis` behavior;
4. an icon close button with the accessible name **Close Jarvis panel**.

The health badge replaces the raw `cannot-see`, `tired`, `drifting`, and `at-rest` strings. It stays qualitative and uses the existing condition expression plus `postureFor(signals)`. Condition takes precedence; posture affects the badge only when the condition is at rest:

| Condition and posture           | Header label       |
| ------------------------------- | ------------------ |
| `cannot-see`                    | Needs attention    |
| `tired`                         | Window constrained |
| `drifting`                      | Vault needs review |
| `at-rest` + any waiting posture | Needs you          |
| `at-rest` + `none`              | All quiet          |

Attention counts remain with the nav badge, preserving the pet design's rule that the creature does not duplicate that number. “All quiet” means no active condition or waiting posture; it does not claim that unread signals are healthy.

### 4.2 System status

System status contains three layers in a fixed order.

#### Priority banner

When the current expression is not `at-rest`, the existing `conditionLine(expression, now)` becomes the banner's primary sentence. When `recallLine` or the vault reading adds a specific reason or count, that detail appears once as supporting text in the same banner. The banner uses icon, text, and tone; color is never the only signal.

The current condition's acts are promoted into this banner:

- `cannot-see` → `actsForRecall(indexStatus)`;
- `drifting` → `actsForVault(pruneCandidates)`;
- `tired` → no action, because a rate-limit countdown has no remedy.

A promoted condition's reason and acts do not repeat in its metric cell; that cell reduces to the compact state. If a lower-priority metric is also actionable, its detail and acts remain inside that metric. Act outcomes render beside or directly below the act that produced them.

At rest, the banner is absent. The module remains present through its diagnostic grid.

#### Stable 2×2 diagnostic grid

The grid always contains the same four cells in the same positions:

| Cell    | Existing source                         | Content                                                                                                |
| ------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Recall  | `petIndexAtom` + `recallLine`           | compact state when promoted; otherwise status, reason, and acts                                        |
| Window  | `signals.rateLimit`                     | provider, used percentage, and reset; explicit “no reading” when absent                                |
| Vault   | `signals.decay` + `memPruneAtom`        | compact state when promoted; otherwise queue/stale detail and existing Review/Clear acts               |
| Waiting | `attentionAtom` + `postureFor(signals)` | “Nothing” when empty; otherwise the leading waiting kind and oldest age, never the aggregate nav count |

Labels are supporting metadata; values and actions carry the visual weight. Unknown readings remain unknown rather than being presented as healthy.

#### Waiting items

When attention exists, the actual items render below the grid. Each item keeps its source, action/kind, age, and tier-gated acts from `actsForAttention`. Actions stay on the exact item they affect.

The list is bounded so it cannot displace Recent updates and Ask Jarvis. Overflow scrolls within the waiting region.

### 4.3 Recent updates

“What I've said” becomes **Recent updates**. This is a vocabulary and grouping change, not a new event model.

- `petSaidAtom` remains the feed.
- `petLastPassAtom` + `passLine(lastPass, now)` move from the diagnostic stack into the section header/supporting metadata because they describe activity rather than system health.
- Each utterance retains its kind, age, text, and existing product acts from `actsForEvent`.
- The empty state reads “No updates yet” and still shows the last-pass reading when one exists.
- The update list remains bounded and scrollable.

This keeps the level (“a pass happened”) visible without presenting it as a fifth system diagnostic.

### 4.4 Ask Jarvis

`PetErrand` remains its own component and becomes the body of the third module.

- The section header names the active destination channel or states **No channel selected**.
- The input remains first in visual and keyboard order.
- Disabled copy says what must happen: **Select a channel to ask Jarvis**. Runtime and save errors continue to use the existing `petErrandState` reason.
- `petErrandState` separates `inputDisabled` from `submitDisabled`: no channel and an in-flight reply lock the input; an empty draft, invalid harness, or saving preference disables only Ask. This fixes the existing state conflation that makes an active-channel empty input impossible to type into.
- The HarnessPicker and destination are supporting metadata below the field.
- The Ask button becomes a clear primary control when enabled and a quiet disabled control otherwise.
- Streaming status and replies remain below the composer, with their existing bounded result region. Errors use text plus the error tone.

The backend continues to persist the response into the channel; closing the peek does not lose it.

## 5. Visual system

The redesign uses Tailwind utilities and the established tokens in `frontend/tailwindsetup.css`.

- **Panel:** `--color-surface-raised`, `--color-border`, `--shadow-popover`, large radius.
- **Modules:** `--color-surface` or the existing darker surface role, bordered with the edge ramp.
- **Primary text:** `text-primary` / `text-secondary`; metadata uses `text-muted` only at sizes and contrast already supported by the theme.
- **Status:** `error`, `warning`, `success`, and accent tokens; never raw colors and never color alone.
- **Actions:** primary condition remedy and enabled Ask receive stronger fill/contrast; secondary acts remain quiet bordered or tinted controls.
- **Typography:** 14px identity, 12–13px body/value text, and 10–11px uppercase or monospaced metadata. The redesign does not introduce body copy below the current readable metadata floor.
- **Spacing:** 12px panel rhythm, 10–12px module padding, and visibly separated action groups. Dividers exist inside modules rather than between every line in the panel.

No SCSS rule or component-specific class hook is added.

## 6. Growth, scrolling, and responsive behavior

- Nominal width is 420px.
- Width is capped to `calc(100vw - 16px)`; Floating UI's existing `shift({ padding: 8 })` keeps it onscreen.
- Maximum height is the available viewport minus the same edge allowance.
- The header does not scroll.
- The body is the outer fallback scroll region when the complete panel exceeds available height.
- Waiting items and Recent updates each have bounded inner regions so one feed cannot consume the balanced hub.
- The existing errand reply remains bounded.
- The 2×2 grid remains stable at normal desktop widths. The width cap prevents horizontal overflow in a narrow window; values may wrap rather than truncate meaningful state.

The two existing bottom-corner placements and 12px anchor offset remain unchanged.

## 7. Interaction and accessibility

The current click/outside-click/Escape behavior remains, with focus management added.

- The panel is a labelled dialog associated with the Jarvis title.
- Opening focuses the dialog container without automatically focusing the text input or triggering an action.
- Tab order follows visual order: full view, close, priority action, metric/waiting actions, update actions, composer controls.
- `FloatingFocusManager` contains keyboard focus while the dialog is open; the existing backdrop continues to block pointer interaction with the application beneath it.
- Escape closes only the peek; the existing global keybinding guard continues to prevent surface navigation.
- Dismissal by Escape, close button, or outside press returns focus to the creature when it is still mounted. A navigation act does not return focus to the creature; the destination surface owns the handoff.
- Every interactive control has a visible `focus-visible` treatment.
- The close glyph has an accessible name; iconography is decorative when adjacent text already names the state.
- Existing keyboard activation of the creature by Enter or Space remains unchanged.

`@floating-ui/react` is already the positioning dependency. `FloatingFocusManager` is the focus-management implementation; no custom tab-loop logic is introduced.

## 8. Component and data boundaries

The redesign is a frontend regrouping with two bounded interaction corrections: composer input locking is separated from submission blocking, and clear-superseded hands focus from the peek to the existing confirmation modal. Neither changes RPCs, persisted data, action availability, or backend semantics.

### `petpeek.tsx`

`PetPeek` continues to own:

- floating placement and anchor wiring;
- open/close behavior;
- reads from the existing signal, memory, attention, activity, and act-state atoms;
- navigation to the full Jarvis surface.

Small local presentational functions replace the generic `Row` shape:

- section shell;
- status metric;
- waiting item/list;
- recent update item;
- existing Acts rendering, adapted to primary/secondary placement without changing the `PetAct` contract.

They stay local because the redesign has one consumer. No speculative shared card system is introduced.

### `peterrand.tsx` and `peterrandmodel.ts`

`PetErrand` keeps its draft and `sendErrand` data flow. Its section-body markup, control sizing, focus styles, status placement, and copy change. `petErrandState` widens from one ambiguous `disabled` field to explicit `inputDisabled` and `submitDisabled` fields; its existing runtime selection and reason derivation remain authoritative.

### `petactrun.ts`

The existing clear-superseded branch still invokes `confirmPruneAllSuperseded`. After the confirmation host accepts the modal, it closes the peek so the two modal focus scopes cannot compete. A synchronous modal-host failure leaves the peek open and continues through the existing per-act error path.

### Unchanged source-of-truth flow

```text
existing atoms/signals
  -> conditionLine / recallLine / passLine / actsFor*
  -> structured status, update, and composer modules
  -> runAct / sendErrand / openJarvis
  -> existing RPCs, channel persistence, and polling refresh
```

The redesign does not cache or reinterpret backend state.

## 9. Error and unknown states

- A failed act reports on the banner, metric, waiting item, or update where that act lives; never in a detached toast.
- Running acts remain disabled according to the existing act state.
- Clear-superseded opens the existing confirmation modal, then closes the peek so two modal focus scopes never compete. If opening the confirmation fails, the peek stays open and reports the failure on that act.
- Errand streaming and error states remain inside Ask Jarvis.
- Missing rate-limit, decay, memory, or last-pass readings keep their existing honest “no reading” / “not read yet” semantics.
- A product known to be gone still suppresses its dead Open act through the existing three-state `noteExists` check.
- Navigation acts close the peek exactly as today, avoiding an overlay stranded over a new surface.

## 10. Verification

### Existing behavior tests

Run the focused pure suites that own the data and action contracts:

```bash
npx vitest run \
  frontend/app/view/jarvis/petcondition.test.ts \
  frontend/app/view/jarvis/petacts.test.ts \
  frontend/app/view/jarvis/petjoin.test.ts \
  frontend/app/view/jarvis/peterrandmodel.test.ts \
  frontend/app/store/keybindings/bindings.test.ts
```

No jsdom render test is added. If a new pure presentation mapper becomes necessary, test its behavior in a colocated `.test.ts`; do not test class strings or internal markup.

### Typecheck

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

### Live CDP verification

Update the existing `jarvis-volunteer` scenario in `scripts/cdp/scenarios.mjs`:

- scope panel queries to `[data-pet-peek]`;
- replace its dependency on visible `Esc` text with the close button's accessible name or a stable panel selector;
- assert the three section headings render;
- preserve the existing Open/Ask product and navigation assertions;
- verify keyboard open, Escape close, and focus return;
- capture the empty and injected-activity panel screenshots;
- pin a narrow viewport and assert the panel stays within its bounds without horizontal overflow.

The final visual check uses the live app and theme tokens, not the brainstorming mockup.

## 11. Expected files

- `frontend/app/view/jarvis/petpeek.tsx`
- `frontend/app/view/jarvis/peterrand.tsx`
- `frontend/app/view/jarvis/peterrandmodel.ts`
- `frontend/app/view/jarvis/peterrandmodel.test.ts`
- `frontend/app/view/jarvis/petactrun.ts`
- `frontend/app/view/jarvis/petactrun.test.ts`
- `frontend/app/view/jarvis/petstore.ts` (dev-only CDP reset added to the existing `__wavePetStore` hook)
- `scripts/cdp/scenarios.mjs`

No new presentation mapper is planned: the layout consumes the existing pure derivations directly. No generated file, backend package, global stylesheet, or SCSS file changes.

## 12. Success criteria

The redesign is successful when:

1. the panel reads as three deliberate peer modules at a glance;
2. the highest-priority issue and its remedy are visually adjacent and not duplicated;
3. populated waiting or update data cannot push the composer out indefinitely;
4. all existing actions, replies, unknown states, and navigation paths still work;
5. keyboard users can enter, traverse, dismiss, and return from the panel predictably;
6. the 420px panel stays inside both normal and narrow desktop viewports;
7. no raw component color, new SCSS, backend behavior, or duplicate source of truth is introduced.
