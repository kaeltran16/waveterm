# Channels — Wave-jarvis handoff parity

**Date:** 2026-07-02
**Status:** Design — approved for planning
**Surface:** `frontend/app/view/agents/channelssurface.tsx` (+ rail, store, actions) and `pkg/jarvis/watcher.go`

## Problem

The shipped Channels surface was built against the *older* handoff (`wave-handoff/wave/project/Wave-cockpit-live.dc.html`, the `isChat` section). The newer handoff `Wave-jarvis.dc.html` (2026-07-01 bundle) re-adds Jarvis-manager richness the current UI lacks:

- Gatekeeper **"answered for you"** card is flat text (`Answered → "X" — why`) instead of the handoff's nested card (worker question → Jarvis's choice → reasoning → resumed footer → Override).
- **Escalation** renders as plain text; the handoff shows **clickable option buttons** that resolve the fork.
- Right panel has no **Jarvis "Fleet manager" header**, no **"Autonomy in #channel"** explainer, no **working/waiting** counts.
- Rail has no **per-channel tier chip** and no **unread badge**.
- Composer lacks the **tier-aware placeholder**; Jarvis has no distinct **avatar glyph**.

The root cause for the two card gaps: `pkg/jarvis/watcher.go` *has* the full structured ask (`baseds.AgentAskData` — worker `ORef`, `Questions[0]` with `Options`, the chosen index, the reason) but `postAnswered`/`postEscalation` **flatten it to a text string**. `ChannelMessage` is `{id, kind, author, text, reforef, ts}` — no structured payload survives.

## Goals

Bring Channels to full **functional** parity with `Wave-jarvis.dc.html` across four areas: the Gatekeeper answered card, escalation options, the right panel, and the rail/composer chrome.

Non-goals: attachments (no backing — the Attach button is omitted), unread read-receipts across devices, any redesign beyond the handoff.

## Decisions (from brainstorming)

1. **Structured data carrier:** add one optional `data string` (JSON) field to `ChannelMessage`. It is JSON-embedded in the channel object, so **no DB migration**. Covers both cards from one source of truth; survives reload.
2. **Override = steer, revealing the option list.** Clicking Override on the answered card expands the original options (Jarvis's pick marked); choosing a different one steers the worker (`reconsider — use {label}`) via the existing steer path. Reuses the escalation card's option component (DRY).
3. **Unread = lightweight, real.** A per-channel `lastReadTs` in `channel.meta`, written on channel select via a new `SetChannelReadCommand` (mirrors `SetChannelTierCommand`). Unread = messages with `ts > lastReadTs && author !== "you"`.
4. **Attach button: omitted** (no attachment backing; a dead control violates the "no fabricated UI" rule).

## Architecture

### Backend (Go) — one struct field + watcher payloads

**`pkg/waveobj` `ChannelMessage`:** add `Data string \`json:"data,omitempty"\``. Regenerate TS (`task generate`) → `frontend/types/gotypes.d.ts` gains `data?: string`.

**`pkg/jarvis/watcher.go`:** define the payload and populate it. The card data schema (`JarvisCardData`, serialized into `Data`):

```
{
  "workerORef": string,                 // baseds.AgentAskData.ORef — deliver/steer target
  "question":   string,                 // Questions[0] question text
  "options":    [ { "label": string, "sub"?: string } ],  // Options[].Label / .Description
  "choice"?:    number,                 // index Jarvis picked — answered only
  "reason"?:    string                  // decision.Reason
}
```

- `postAnswered(channelId, q, chosenIdx, reason, workerORef)` — was `(channelId, optionLabel, reason)`. Builds `JarvisCardData` with `choice = chosenIdx`, marshals into `Data`. Keeps the existing flat `text` as fallback.
- `postEscalation(channelId, data, reason)` — already holds `data`; add `Data` payload (no `choice`). Keeps flat `text`.
- The worker **name** is NOT stored; the FE resolves it from the roster via `workerORef` (see `workerFor`), falling back to the ORef when the worker is gone.

**`pkg/wshrpc` `SetChannelReadCommand`** (mirror `SetChannelTierCommand`): `CommandSetChannelReadData { ChannelId string; Ts int64 }` writes `meta["read:ts"] = Ts` on the channel. Implement in `wshserver`, add to `wshclient`/generated api.

### Frontend

New pure helpers (in `channelderive.ts` or a new `jarviscards.ts`):

- `parseCardData(msg: ChannelMessage): JarvisCardData | null` — JSON-parse `msg.data`, guard shape; `null` for legacy messages (→ text fallback).
- `unreadCount(messages, lastReadTs): number` — `ts > lastReadTs && author !== "you"`.
- `autonomyExplainer(tier): { blurb: string; checklist: {label; active: boolean}[] }` — static copy per tier (concierge/gatekeeper/delegator).
- `tierChip(tier): { letter: "C"|"G"|"D"; ... }` — rail chip.
- `fleetCounts(snapshot): { working: number; waiting: number }` — from `buildFleetSnapshot` states.

Component changes in `channelssurface.tsx`:

- **`GatekeeperRow`** — when `parseCardData` returns a payload with `choice`: render nested `{worker} asked: {question}` sub-card, `Jarvis chose {options[choice].label}`, `reason`, footer `● {worker} resumed on its own` + **Override**. Override toggles an inline `<OptionList>` (shared with escalation) with `choice` marked; picking another option calls the steer action. Legacy (no data) → current flat text.
- **New `EscalationRow`** (split out of `GatekeeperRow`'s escalation branch) — amber card; renders `<OptionList options={data.options}>`; click → `AnswerAgentCommand({ oref: data.workerORef, answers: [{ SelectedIndexes: [idx] }] })`; on success show resolved footer. Legacy → flat text.
- **New shared `OptionList`** component — radio-style option buttons with `label` + `sub`, an optional marked index, and an `onPick(idx)` — used by both escalation (deliver) and Override (steer).
- **`ContextPanel`** — prepend the `Jarvis / Fleet manager ● live` header + diamond avatar; add the "Autonomy in #{channel}" explainer card (`autonomyExplainer(tier)`); change the workers header to `FLEET HERE · {working} working · {waiting} waiting` (`fleetCounts`).
- **`ChannelRail`** (`channelrail.tsx`) — per-row tier chip (`tierFromMeta(c.meta)`) + unread badge (`unreadCount`). `selectChannel` (in `channelsstore.ts`) also fires `SetChannelReadCommand({ channelId, ts: Date.now() })` and optimistically sets `meta["read:ts"]`.
- **`Composer`** — tier-aware placeholder keyed off the active tier. No Attach button.
- **`Avatar`** — a Jarvis branch renders the diamond/gem glyph (matching the handoff) instead of the `J` initial.

### Steer action (Override)

Add `steerWorker(model, workerORef, text)` to `channelactions.ts`: resolve the worker's `blockId` from the roster (via `workerORef`), `ControllerInputCommand({ blockid, inputdata64: base64(text + "\r") })`, and `post(channelId, "directive", "you", text, workerORef)` — identical to the composer's existing `steer` branch. Override calls it with `reconsider — use {label}`.

## Data flow

1. Worker asks → watcher classifies. **Answered:** `DeliverAnswer` → `postAnswered` writes `text` + `Data{choice}`. **Escalated:** `postEscalation` writes `text` + `Data` (ask left pending server-side).
2. Message streams to FE (existing `wps` channel-message flow). `parseCardData` drives the rich card.
3. Escalation option click → `AnswerAgentCommand(workerORef, idx)` (same path as `AnswerBar`) → worker unblocks → FE shows resolved footer.
4. Override click → option list → steer directive to the worker's terminal + a `directive` message.
5. Channel select → `SetChannelReadCommand` stamps `lastReadTs`; rail unread recomputes to 0.

## Error handling / edge cases

- **Legacy messages** (no `data`): every rich renderer falls back to the existing flat `text`. No breakage for historical channels.
- **Worker gone** when Override/escalation-resolve is attempted: `workerFor` returns undefined → disable the action with a muted "worker exited" note; escalation delivery no-ops gracefully.
- **Escalation already answered elsewhere** (`AnswerAgentCommand` fails / ask cleared): show the flat text + a muted "resolved" state; do not crash.
- `data` present but malformed → `parseCardData` returns `null` → text fallback.

## Testing

Pure vitest (behavior, not internals):
- `parseCardData` — valid payload, missing `choice`, malformed JSON, absent → `null`.
- `unreadCount` — own messages excluded, boundary `ts === lastReadTs`, no `lastReadTs`.
- `autonomyExplainer` — correct active-checklist item per tier.
- `fleetCounts` — working/waiting tally from mixed snapshot states.
- `tierChip` — meta → letter.

Go:
- watcher payload builder — `postAnswered`/`postEscalation` produce the expected `JarvisCardData` JSON (question, options, choice, reason, workerORef) from a sample `AgentAskData`.

Final: CDP visual check against `Wave-jarvis.dc.html` (rail chips/unread, both cards, right panel, composer).

## Files touched

- `pkg/waveobj/wtype.go` — `ChannelMessage.Data`
- `pkg/jarvis/watcher.go` — `JarvisCardData`, `postAnswered`/`postEscalation`
- `pkg/wstore/wstore_channel.go` — `SetChannelRead` (+ `NewChannelMessage` data variant)
- `pkg/wshrpc/wshrpctypes.go`, `wshserver`, generated api — `SetChannelReadCommand`
- `frontend/types/gotypes.d.ts` — regenerated
- `frontend/app/view/agents/channelssurface.tsx` — `GatekeeperRow`, `EscalationRow`, `OptionList`, `ContextPanel`, `Composer`, `Avatar`
- `frontend/app/view/agents/channelrail.tsx` — tier chip + unread badge
- `frontend/app/view/agents/channelactions.ts` — `steerWorker`
- `frontend/app/view/agents/channelsstore.ts` — `selectChannel` stamps read
- `frontend/app/view/agents/jarviscards.ts` (new) — pure helpers + tests
