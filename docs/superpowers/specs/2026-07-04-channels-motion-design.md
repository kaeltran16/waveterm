# Channels surface motion — Design

Date: 2026-07-04
Surface: **Channels** (`frontend/app/view/agents/channelssurface.tsx` + `channelrail.tsx`), a surface in
the app-wide animation revamp (`docs/superpowers/animation-revamp-tracker.md`). Reuses the cockpit motion
tokens (`frontend/app/element/motiontokens.ts`) and the existing CSS keyframes (`pulseDot`, `breatheGlow`,
`settle` in `frontend/tailwindsetup.css`) — no new tokens, one new pure helper file.

## Problem

The Channels surface is a two-pane chat with **zero** motion. Messages snap into the stream, switching a
channel hard-cuts the whole message set, the streaming consult/jarvis reply blocks pop in, an escalation
card that needs you sits inert as a static amber box, and the rail's active-channel highlight swaps
instantly. Against a cockpit that now moves with intent (`b3ccce07`) and a Sessions surface that reflows,
Channels reads as inert — and, worse, its "needs you" states don't get the attention treatment the same
concept gets on Cockpit.

## Surface as-built

Left `ChannelRail` (search box [visual], channel list with active highlight + unread badge + attention
dot + autonomy chip, "+ New channel" → project picker). Right: a header (channel name, project path,
autonomy tier toggle), a scrollable message stream, and an always-visible card composer with @mention
highlighting + suggestion dropdown.

The message stream renders five row types off `active.messages`, filtering out `consult-reply` /
`jarvis-reply` (those are folded into their parent rows):

- `MessageRow` — dispatch / directive / human note; a dispatch shows a live worker status pill + `open ↗`
  and, when the worker is asking, an inline `AnswerBar`.
- `ConsultRow` — an `ask @runtime` question with its replies grouped beneath by consultId; each runtime
  shows its persisted reply or, until that lands, live streaming text (`consultStreamsAtom`).
- `JarvisRow` — a `@jarvis` query + its single grouped reply (persisted or live).
- `GatekeeperRow` — jarvis "answered for you" card (question, chosen option, reasoning, Override).
- `EscalationRow` — jarvis escalated an ask **to you**: amber card with clickable options; picking one
  delivers the answer to the still-blocked worker.

Two facts shape what motion is possible:

1. **Messages arrive live.** New rows are appended as you send, as workers dispatch, and as jarvis/consult
   replies land — so unlike Sessions, there is a genuine steady-state "new item arrived" moment.
2. **The surface swaps its entire dataset on channel switch.** `selectChannel` changes `activeChannelIdAtom`
   and the stream re-renders a different message set. A naive entrance animation would fire a full-list
   cascade on every switch — the central nuance this design must defeat.

## North star (inherited from the revamp)

**Motion is functional first: it must make a state change more legible.** The genuine state changes here
are: *a new message arrived*, *a reply is streaming vs. complete*, *this card needs you*, and *you switched
the active channel*. Each maps to an existing moment; nothing decorative is added. No entrance cascade on
mount or channel switch. Reduced motion honored.

## Locked decisions (from the brainstorm)

- **Scope = core + attention.** m1 message entrance, m5 streaming, m7 rail micro (the tracker line) **plus**
  m3 attention glow on the escalation card and m7 `pulseDot` on the rail attention dot — so Channels treats
  "needs you" the way Cockpit already does. m4 completion-settle on stream finish is included as a light
  touch, flagged as the first thing to cut.
- **Switch/mount is silent; only true arrivals animate.** Selecting a channel (or first mount) presents its
  existing messages with no entrance. Only a message that arrives *after* the channel is settled fades in.
- **Streaming text never animates per-token.** The reply block rides its row's entrance; the text updates in
  place so a fast token stream cannot strobe (this is what m5 protects).
- **Escalation glows; Gatekeeper stays calm.** Only `EscalationRow` (asking *you*) breathes, and only while
  unresolved. `GatekeeperRow` already handled it — no glow.
- **Reduced motion** via `<MotionConfig reducedMotion="user">` (Framer) + `motion-reduce:animate-none` on
  every CSS keyframe (`pulseDot`, `breatheGlow`, `settle`).

### Out of scope

- **Composer / suggestion-dropdown / project-picker / PlanChip motion.** Left snappy. (The composer is
  always visible — this is not the Agent surface's m6 composer reveal.)
- **`open ↗` cross-surface jump.** Jumping to the Agent surface is a surface switch; that motion belongs to
  the tracker's *Cross-surface tab transitions* row.
- **Rail hover/press restyle, delete-affordance cross-fade.** Already present; unchanged.
- **New tokens or a shared `<MotionList>` extraction.** Row bodies differ per surface; the only shared part
  is a thin wrapper + `cardVariants`. Extract later if a real cross-surface pattern emerges (YAGNI).

## Moment mapping

Onto the revamp's existing eight-moment vocabulary:

| Channels state change | Moment | Primitive |
|---|---|---|
| New message appended to the stream | m1 (item entrance) | `cardVariants` (opacity+scale) |
| Streaming consult/jarvis reply text | m5 (streaming line) | opacity-only entrance via row; text updates in place, no per-token anim |
| Reply stream finishes (streaming → done) | m4 (completion settle) | `settle` one-shot on the reply block |
| Escalation card needs you (until picked) | m3 (attention) | `breatheGlow` (token-amber, persistent) |
| Rail: a channel here needs you | m7 (status pulse) | `pulseDot` on the attention dot |
| Rail: active channel changes | m7 (micro) | CSS `transition-colors` at `durMicro` |
| Card grows (Override expands options) | m2 (list reflow) | `layout` on the row wrapper |
| Channel switch / first mount | — (silent by design) | no-cascade guard (see mechanism) |

## Mechanism

### 1. Scaffold

Wrap `ChannelsSurface`'s returned tree (the outer `absolute inset-0 flex`, covering rail + stream) in
`<MotionConfig reducedMotion="user">`. Framer then keeps opacity and drops the scale offset under reduced
motion with no per-variant work.

### 2. No-cascade guard — new `channelsmotion.ts` (+ `.test.ts`)

`AnimatePresence initial={false}` suppresses entrances for children present on *first* render, but a channel
switch adds a fresh set of children *after* first render — they would cascade. So the entrance decision is
per-message, gated by a small **pure** helper:

```ts
export interface EntranceState { channelId: string | undefined; seen: Set<string>; }

// Rules:
//  - channel changed (or first mount): animate nothing; seed `seen` with all current ids.
//  - same channel: animate ids not yet in `seen`; add them to `seen`.
export function computeEntrances(
    prev: EntranceState,
    channelId: string | undefined,
    messageIds: string[],
): { animate: Set<string>; state: EntranceState }
```

Wiring in `channelssurface.tsx`: hold `EntranceState` in a `useRef`. Compute `animate` in the render body
from the ref's current value (read-only), then commit the returned `state` back to the ref in a
`useLayoutEffect` keyed on `[activeId, messageIds]` — so the ref never mutates during render (strict-mode
safe). Each row passes `initial={animate.has(msg.id) ? "initial" : false}`. Result: switch/mount silent,
genuine arrivals fade in.

The pure `computeEntrances` mapping is the unit-testable surface (mirrors `sessionsmotion.ts`).

### 3. Message entrance — m1

Wrap the `messages.filter(...).map(...)` output in `<AnimatePresence mode="popLayout" initial={false}>`.
Rather than converting each of the five row components to `motion.div` (they are custom components, so
`popLayout` would need `forwardRef` on all five), wrap each rendered row in a single shared
`motion.div` at the map site:

```tsx
<motion.div key={m.id} layout variants={cardVariants}
    initial={animate.has(m.id) ? "initial" : false} animate="animate">
  {renderRow(m)}
</motion.div>
```

`cardVariants` is opacity+scale only (no x/y — guardrail). `layout` on this **wrapper** (a container, never
a streaming-text node) gives m2 reflow when a card below grows (Gatekeeper Override expanding, an inline
`AnswerBar` appearing). No `exit` variant: messages are not removed in normal use, and `popLayout` +
`layout` handle any reflow; adding `exit` would only matter if messages were deleted, which they are not.

### 4. Streaming replies — m5 + m4

No structural change to `ConsultRow`/`JarvisRow`'s text handling: the reply block is already always present
(live "…" → persisted text) and reconciles by position, so the live→persisted swap is already seamless and
the text updates in place — exactly m5 (no per-token animation, no strobe). The block inherits the row's m1
fade via the wrapper in #3.

m4 adds a one-shot **`settle`** on a reply block the moment its stream completes. A reply is "streaming"
while a live entry exists for it (`streams[key].status === "streaming"`) and "done" once the persisted reply
is present. On that transition, apply `animate-[settle_0.5s_ease-out] motion-reduce:animate-none` to the
block for ~520ms, then clear (the `agentrow.tsx` `justFinished` pattern: a `useState` flag + `setTimeout`
matching `@keyframes settle`'s .5s). This is the one touch that adds local state to the row components; if it
reads as fussy in the live app, cut it — m1/m5 stand alone.

### 5. Attention — m3 (escalation) + m7 (rail dot)

- **`EscalationRow`:** while `picked == null`, add `animate-[breatheGlow_2.4s_ease-in-out_infinite]
  motion-reduce:animate-none` to the amber card (`bg-lane-asking` container). Once `picked != null` the card
  is resolved → drop the class (calm). Verbatim reuse of the `agentrow.tsx` asking-card treatment.
- **Rail attention dot** (`channelrail.tsx`, the `bg-asking` dot titled "an agent here needs you"): add
  `animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none`. `pulseDot` is the unified 1.6s status pulse
  used across the app.

### 6. Rail selection micro — m7

The channel `<button>` toggles `bg-accentbg` / `hover:bg-surface-hover` and its `#` + label colors on
selection. Add `transition-colors duration-[140ms]` (= `MOTION.durMicro`) so the active swap eases instead
of snapping. Pure CSS — the sanctioned fallback for pre-existing hover/press micro. Hover unchanged.

## Isolation / boundaries

- **New logic is one pure function** (`computeEntrances`) with a unit test; everything else is declarative
  Framer wiring + CSS utility classes.
- **`cardVariants` stays the single source of card/list feel** — Channels reuses it verbatim; the guard
  toggles *whether* a row's entrance plays, never *what* it looks like.
- **No store, action, or token changes.** `channelsstore`, `channelactions`, `motiontokens.ts`, and
  `tailwindsetup.css` are untouched (the keyframes already exist).

## Reduced motion & no-cascade (revamp guardrails)

- **Reduced motion:** `<MotionConfig reducedMotion="user">` drops scale/transform for m1/m5; every CSS
  keyframe (`breatheGlow`, `pulseDot`, `settle`) carries `motion-reduce:animate-none`. No un-guarded loops.
- **No cascade:** `computeEntrances` guarantees channel switch and first mount fire zero entrances; only
  messages appended while a channel is settled animate. `AnimatePresence initial={false}` is the second belt.

## Testing

- **Unit (vitest):** `channelsmotion.test.ts` asserts `computeEntrances` — first mount animates nothing and
  seeds `seen`; a channel switch animates nothing and reseeds; a same-channel append animates only the new
  id(s); a re-render with no new ids animates nothing; ids removed from the set are handled without error.
- **Visual (CDP screenshot harness on the live dev app):** send a message → single row fades in (no cascade);
  switch channels → populated stream appears silently; a consult/jarvis reply streams then settles; an
  escalation card breathes until answered; rail attention dot pulses; active-channel highlight eases;
  reduced-motion degrades to opacity-only / no loops. No jsdom render harness exists for the cockpit (per
  `CLAUDE.md`) — use `scripts/inject-live-agents.mjs` + `scripts/cdp-shot.mjs`.

## Files

| File | Change |
|---|---|
| `frontend/app/view/agents/channelsmotion.ts` + `.test.ts` | **new.** Pure `computeEntrances` no-cascade guard + unit test. |
| `frontend/app/view/agents/channelssurface.tsx` | `MotionConfig` wrap; `AnimatePresence mode="popLayout" initial={false}` + per-row `motion.div` wrapper (`cardVariants` + `layout`); wire the entrance guard (ref + `useLayoutEffect`); m4 `settle` on reply completion in `ConsultRow`/`JarvisRow`; m3 `breatheGlow` on `EscalationRow`. |
| `frontend/app/view/agents/channelrail.tsx` | m7 `transition-colors duration-[140ms]` on the channel button; `pulseDot` on the attention dot. |

## Tracker update

On landing, flip the **Channels** row in `docs/superpowers/animation-revamp-tracker.md` to ✅ with the commit
SHA and a one-line note (message entrance + no-cascade guard, streaming settle, escalation glow, rail
selection micro + attention-dot pulse).
