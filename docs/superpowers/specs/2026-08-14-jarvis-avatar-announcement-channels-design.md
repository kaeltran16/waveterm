# The pet learns to speak the announcement bus

**Date:** 2026-08-14 · **Status:** Design settled. **Type:** Design doc for the Jarvis pet's voice
register. Builds on [the pet design](2026-08-04-jarvis-pet-design.md) (the four registers, §5's
pure-adapter rule, §4 decision 8) and [the avatar design](2026-08-04-jarvis-avatar-design.md) (form and
renderer). Not an implementation plan; the plan is a separate step.

## 1. Why

The pet design's Voice register ("things that happen") is half-empty. Three of its kinds are live
(`resume`, `sweep`, `distill-batch`); `bg-agent-done` is in the kind union and the bubble label map but
has **no producer anywhere in the codebase** — a background agent finishing is invisible to the pet.
Meanwhile two announcement channels already flow over the wave event bus into the cockpit and stop
there:

- **`notify`** (`wsh notify` / the `wave_notify` tool) renders as a toast that auto-dismisses in 6
  seconds and is gone forever. A notification missed while you are looking elsewhere is simply lost.
- **`agent:ask`** (an agent raising an AskUserQuestion) renders only inside the Agent surface. When you
  are anywhere else, a pending question is invisible until the nav badge or posture happens to reflect
  it.

The pet is the one object in the app that survives a surface switch and the one surface that is
always on screen. Both channels are exactly the "things that happen" the Voice register exists to
say. This design wires them in, and finally produces the orphaned `bg-agent-done` kind.

## 2. Scope

Three channels feed the pet's voice, all frontend-only (no Go, no codegen, no migration):

1. **`notify`** — every level (`info` / `warn` / `error`), spoken as-is. The toast stays; the pet is an
   additional delivery, not a replacement.
2. **`agent:ask`** — a raised ask is spoken; a cleared ask removes the pending event so it is never
   spoken late. Subject to the focus gate (§4.2).
3. **Background-agent finished** — diff of the existing 10s `claude agents` poll: an entry present in
   one poll and gone in the next means the agent finished. Produces the `bg-agent-done` kind.

Deliberately out of scope: persistence of notifications (they stay ephemeral, same contract as the
toast), replacing or restyling the toast, and the remaining event-bus siblings (`badge`,
`block:jobstatus`, `userinput`, `connchange`, `agent:status` transitions other than the bg poll —
noisy, low-level, or already owned by other surfaces).

## 3. The shape change

`PetEvent` grows two optional fields and the kind union grows two entries. Absent fields are today's
behavior — every existing producer and consumer is untouched:

```ts
kind:
    | "resume" | "sweep" | "distill-batch" | "bg-agent-done"
    | "recall" | "connection" | "loose-end" | "ledger"
    | "notify" | "ask";            // new
detail?: string;                   // new — bubble never shows it; the peek renders it dimmed
```

- `notify` events: `text` = the notification title (verbatim), `detail` = the message body (verbatim).
- `ask` events: `text` = the question text (verbatim, first question's `question`), `detail` = unset
  (options render in the ask's own UI), `ref` = the ask's block oref so the peek can open it.
- `bg-agent-done` events: `text` = `<title or name> finished`, `detail` unset.

The bubble shows **title only** (decided in review): the "one utterance" discipline from the pet
design holds, and a long message body never stretches the 268px bubble. The message body lives in the
peek's detail line.

## 4. Design

### 4.1 The adapters — `petjoin.ts` gains three pure, total functions

Same seam as `eventFromActivity` / `eventFromVolunteer`: wire shapes in, `PetEvent`-shaped results
out, unknown input yielding `null`/`undefined` rather than a guess.

- `eventFromNotify(data: NotifyCommandData | null | undefined): PetEvent | null` — `null` unless a
  non-empty title exists. `id` = `notify:<ts>:<seq>` (session-unique; notify events are ephemeral, so
  cross-reload stability is not needed), `at` = `Date.now()`.
- `eventFromAsk(data: AgentAskData | null | undefined): { event?: PetEvent; cancelId?: string }` —
  a raised ask (`cleared` unset, at least one question) yields `event` with
  `id: "ask:" + data.askid` (stable across the raise/clear pair) and `ref: data.oref`. A cleared ask
  yields `cancelId` (same id), so the store can drop the pending event. Anything else yields neither.
- `agentFinishedFromDiff(prev, next, dismissed): PetEvent[]` — entries of `kind: "background"` present
  in `prev` and absent from `next` (matched by `sessionid`), excluding `dismissed` ids, yield one
  `bg-agent-done` event each (`id: "bgdone:" + sessionid + ":" + ts`).

### 4.2 The ask focus gate

An ask is **not** spoken when you are already looking at it — reporting it would be the double-count
the design's report-once rule exists to prevent. The gate is a pure function beside the adapter:

```ts
shouldSpeakAsk(oref: string, ctx: { surface: SurfaceKey; focusTabId?: string; focusedBlockId: string | null }): boolean
```

- **Suppressed** when the surface is `agent` and the ask's tab (resolved block oref → blockid →
  containing tab via the model's `tabModel`) equals `focusTabId` — the ask UI is in the focused
  agent's interior.
- **Suppressed** when the ask's blockid equals `focusedBlockId()` — keyboard focus is inside that
  block in the cockpit.
- **Spoken** otherwise (different agent focused, other surfaces, the block not in view).

A suppressed ask is dropped entirely — no bubble, no unread dot, no peek entry; the in-context ask UI
is the notification. Its `cleared` event then finds nothing to remove, which is a silent no-op.

### 4.3 The bubble labels

`KIND_LABEL` in `petbubble.tsx` is an exhaustive `Record<PetEvent["kind"], string>` — TS enforces the
additions. The wording follows the existing terse-fragment grammar ("Where we were", "Still open",
"Work state"):

| Kind | Label | Note |
|---|---|---|
| `notify` | `Notice` | single noun, matches "Work state"; decided in review |
| `ask` | `Asking you` | gerund phrase, matches "Still open" |
| `bg-agent-done` | `While you were out` | **existing** entry — it was placed in the map before its producer existed |

The peek row header already renders `{event.kind} · {ageLabel(...)}` with raw kind strings ("sweep ·
5m"); `notify` and `ask` fit that pattern unchanged. The peek gains one line of rendering: when
`detail` is present, show it dimmed below the event text, using the existing secondary-text style.

### 4.4 Wiring

Three additions, all following existing patterns:

- **`petsources.tsx`** — two `waveEventSubscribeSingle` subscriptions beside the existing
  `memory:activity` / `jarvis:volunteer` ones, for `notify` and `agent:ask`. The ask handler runs the
  focus gate with live context: `globalStore.get(model.surfaceAtom)`,
  `globalStore.get(model.focusIdAtom)`, and `focusedBlockId()`. `PetSources` gains a `model` prop
  (cockpit-root already constructs the model and renders `<PetSources />`; the other pet components
  already take it). The notify handler pushes `eventFromNotify`; the ask handler pushes the raised
  event or removes the pending one (`removePetEvent(cancelId)`, a small new export in `petstore.ts`
  beside `pushPetEvent`).
- **`backgroundagentsstore.ts`** — `loadBackgroundAgents` already sees `prev` and `next` in one place.
  After a successful load it runs `agentFinishedFromDiff` and pushes any events via
  `pushPetEvent`. `dismissBackgroundAgent` registers its `sessionid` in a module-level `Set`
  (session-scoped, like the store) so the Dismiss button cannot fake a completion. No diff runs on a
  failed load (the last-good list is kept, so a network blip fabricates nothing), and the first
  successful load establishes the baseline — it diffed against nothing.

Data flow: event → subscription → adapter (pure) → `pushPetEvent` / `removePetEvent` →
`petEventsAtom` → `petvoice.nextUtterance` (watermark) → bubble → auto-dismiss → unread dot → peek
history. Nothing else changes: toast, posture, condition, and the peek's composition stay as they are.

## 5. Constraints

- **Tokens only.** All new UI (the peek's detail line) uses existing Tailwind classes
  (`text-secondary` and friends from `@theme`); no new colors, no raw hex, no inline styles. The
  bubble itself needs no styling change at all — `KIND_LABEL` is text only.
- **No guessing.** Adapters are total; a payload the UI has not been taught falls through to silence,
  never to a fabricated utterance.
- **No numbers.** Notifications and asks enter the Voice register, never the condition/posture
  registers; the pet's no-numbers contract is untouched.
- **No Go, no codegen, no migration.** The wave events (`notify`, `agent:ask`) and the
  `GetBackgroundAgentsCommand` read already exist.

## 6. Error handling

- Malformed payloads (empty title, ask with no questions and `cleared` unset, unknown kind strings)
  yield `null` / `undefined` in the adapters — skipped, never a broken bubble.
- A dropped `claude agents` poll keeps the last-good list and runs no diff — no fabricated
  "finished".
- A cleared ask with no pending event is a silent no-op.
- Notifications are ephemeral by design (wave events, gone on reload) — the same contract as the
  toast; the watermark has no interaction with them.

## 7. Testing

Pure modules, per the codebase convention (`petjoin.test.ts` mirrors the existing adapter tests):

- `eventFromNotify`: title/detail split; empty title → null; level is ignored (not part of the
  event).
- `eventFromAsk`: raised → event with stable id + ref; cleared → cancelId; neither → empty.
- `shouldSpeakAsk`: agent surface + matching focus tab → suppressed; cockpit block focus → suppressed;
  different agent focused → spoken; unknown surface → spoken.
- `agentFinishedFromDiff`: gone → event; still present → none; dismissed id → none; non-background
  entries ignored; empty prev (first load) → none.
- `petvoice`/`petbubble`: the new kinds flow through `nextUtterance` and satisfy the exhaustive
  `KIND_LABEL` map (TS enforces the latter at build time).
- No jsdom render tests; the existing CDP `surface-smoke` scenario already guards that a new global
  subscription does not break any surface.

## 8. Verification

- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` clean.
- `npx vitest run frontend/app/view/jarvis` green.
- Live: `wsh notify` a test message (bubble + peek), an AskUserQuestion from a real agent with the
  focus gate exercised on both sides (focused → silent, elsewhere → spoken), and a background agent
  finishing.

## 9. Rejected, and why

- **Persist notifications** (backend store read path so they survive reload). Contradicts the notify
  system's designed ephemerality; YAGNI for a 6-second channel.
- **Replace the toast.** The user's review chose "avatar speaks it" over "replaces the toast
  entirely"; a toast is still the right delivery when the avatar is occluded.
- **`agent:status` transitions as utterances.** Overlaps `agent:ask` (the "asking" state) and the
  cockpit's own agent roster; working-state churn is noise. The bg poll diff is the one valuable
  signal and is covered by the third channel.
- **`badge` / `block:jobstatus` / `userinput` / `connchange`.** Low-level chrome or terminal state,
  already visible where it matters.
- **Bubble shows title + message.** Review decided title-only; the message body lives in the peek's
  detail line.
