# Channels 2-pane redesign — design

**Date:** 2026-07-01
**Status:** design, pending review
**Source of truth (visual):** `wave-handoff/wave/project/Wave-cockpit-live.dc.html`, the `isChat` surface (lines 727–799).

## Problem

The shipped Channels tab (`frontend/app/view/agents/channelssurface.tsx`) is a bare single
column: a "Channels" title with channel **pills** in the top bar, tight message rows with no
avatars, and a plain textarea composer. The handoff mockup for this surface is a **2/3-column
Slack-style layout** — channel rail, avatar'd message stream, card composer. The shipped view
carries none of that visual language, so it reads as unfinished next to the Cockpit surface
(which was brought to handoff parity).

This redesign brings Channels to the handoff's **visual language** and moves channels into a
proper left rail, while deliberately **not** building the mockup's team-chat chrome that has no
backing data in a single-user agent tool.

## Goals

- Adopt the handoff's message-stream look: colored avatars, `agent`/`ask`/`asking` tags, roomy
  typography (14px/1.6 body, 20px row gaps), `#`-prefixed channel header with a subtitle.
- Move channels from cramped top-bar pills into a **244px left channel rail** with search and a
  `+ New channel` action.
- Rebuild the composer as the handoff's rounded **card** (`@ mention agent` + `Send ⏎`).
- Fold **every existing feature** into the new skin with no loss: consult reply cards, dispatch
  status pill + `open ↗`, and the in-place `AnswerBar` for an asking worker.
- Add a cheap, real **attention dot** on channels that have an agent waiting on you.

## Non-goals (dropped or deferred, with rationale)

This is a single-user agent-dispatch surface, not team chat. The mockup's remaining chrome
assumes multiple humans and persistent presence, so:

- **Members rail ("In this channel") — dropped.** In a solo tool the "members" are you + whatever
  agents posted, which the message avatars and the Cockpit roster already show. A 212px rail to
  restate that is dead weight.
- **Direct / DM section — dropped.** A "DM with an agent" is just a channel with one participant;
  agents are spawned per task, not persistent people. No new capability.
- **Unread counters — dropped**, replaced by the attention dot (see below). Message counts are
  low-value when messages appear because *you* acted.
- **Pin context / Attach — deferred as real features, not faked.** Both map to genuine agent
  workflows (pinning curated context injected into dispatches/consults; attaching a file for an
  agent to read) and deserve their own specs with backend work. We will not ship decorative stubs.

## Layout

The Channels surface becomes a horizontal 2-pane fill (it sits to the right of the app's existing
shell nav rail, so visually the app reads as three columns — the shell rail is not part of this
surface):

```
┌──────────────┬────────────────────────────────────────────┐
│ channel rail │ # payments-api                             │
│  244px       │ ~/code/payments-api          (header)      │
│              ├────────────────────────────────────────────┤
│ Search       │  ◐ you   9:41                              │
│ CHANNELS     │    @claude harden webhook verification     │
│  # general   │  ◑ claude  [dispatch]  9:41               │
│  # payments  │    …  ● working   open ↗                  │
│    (active)  │  ◐ you   [ask]  9:43                      │
│  # auth  ●   │    ┌ codex ─────────────┐                 │
│  # data      │    └ antigravity ───────┘                 │
│              │  ◑ claude  [asking]  now                  │
│ + New channel│    ┌ answer bar (1 · … / 2 · …) ┐         │
│              ├────────────────────────────────────────────┤
│              │  ┌ Message #payments-api…            ┐    │
│              │  │ @ mention agent            Send ⏎  │    │
│              │  └────────────────────────────────────┘    │
└──────────────┴────────────────────────────────────────────┘
```

Message stream and composer are capped at `max-width: 760px` (matches the handoff).

## Components

`channelssurface.tsx` is rewritten. Current sub-components (`ConsultRow`, `AskRow`, `Row`) are
kept but restyled; the top-level surface changes from a `flex-col` to a `flex` row with two panes.

| Component | Responsibility |
|---|---|
| `ChannelRail` (new) | Left 244px pane: search box (visual only for v1), `CHANNELS` section listing `channelsAtom` as `#`-prefixed rows with active highlight + attention dot, `+ New channel` action that opens the existing project-picker flow. Replaces the top-bar pills. |
| `MessageArea` (new wrapper) | Center pane: `#` + channel name header with `ProjectPath` subtitle, scrolling message list (capped 760px), composer card. |
| `MessageRow` | Generalizes today's `Row`: 32px avatar (initial, deterministic color) + author + optional tag (`dispatch`) + time + body. Dispatch rows keep the status dot + state label + `open ↗`, and render `AskRow` when the worker is `asking`. |
| `ConsultRow` | Same grouping logic as today (question + replies-by-consultId + live streams), reskinned: the question gets the `you` avatar + `ask` tag; reply/stream cards become `#13171d` bordered cards. |
| `AskRow` | Unchanged behavior (reuses `AnswerBar` + model answer state), restyled to the amber `asking` card. |
| `Composer` | Rounded card; textarea styled as the card body; `@ mention agent` button focuses the textarea and inserts `@`; `Send ⏎`. No Attach. |

Boundaries: `ChannelRail` depends only on `channelsAtom` / `activeChannelIdAtom` / the attention
derivation; `MessageArea` owns the stream + composer. Both are pure presentation over existing
atoms — no new store surface beyond the two derivations below.

## Derived data (no backend changes)

**Avatar color** — deterministic per author so the same name is always the same color. A small
pure helper `avatarColor(name: string): string` hashes the name into a fixed handoff palette
(`#7c95ff`, `#54c79a`, `#e06c6c`, `#e6b450`, `#c98fe6`, `#6a7280`); `you` is pinned to the accent
blue. Unit-tested for stability and determinism. Lives in a new `channelavatar.ts`.

**Attention dot** — a channel shows the amber dot when any live worker it dispatched is currently
`asking`. `GetChannels` already returns each channel's `Messages`, so the mapping is client-side:
for a channel, collect `refORef` values of kind `dispatch`/`directive` (`tab:<id>`), resolve each
against `agentsAtom`, and light the dot if any resolved agent has `state === "asking"`. Exposed as
a derived helper `channelHasAsk(channel, agents): boolean`, unit-tested.

- **Known v1 limitation:** `channelsAtom` is a load-time snapshot (`loadChannels`), so a worker
  dispatched *after* the last load won't light a dot until channels reload. Mitigation: call
  `loadChannels()` after a dispatch (cheap, already how creation refreshes). The *active* channel
  is always live via WOS; the dot mainly matters for background channels, where a slight lag is
  acceptable.

## Data model impact

**None.** No changes to the `Channel` waveobj, wshrpc commands, or Go backend. The header subtitle
uses the existing `ProjectPath` (there is no `topic` field and we are not adding one). All new
behavior is frontend-only, derived from atoms that already exist.

## Testing

- **Unit (vitest):** `avatarColor` — determinism + palette membership + `you` pinning;
  `channelHasAsk` — dot on/off across dispatch refORef → asking/working/absent agent, and channels
  with no dispatch messages. Extend the existing `channelmessages.test.ts` pattern in a new
  `channelavatar.test.ts` / colocated test.
- **Visual (CDP, per project convention):** drive the live dev app on `:9222`, screenshot the
  Channels tab, confirm the 2-pane layout, avatars, tags, attention dot, and that a consult /
  dispatch / asking flow renders correctly in the new skin.
- No behavior regressions: consult streaming, dispatch, steer, and answer submission are unchanged
  paths — the send logic in `channelactions.ts` is untouched.

## Open defaults (confirm on review)

These were decided as sensible defaults; flag any you'd change:

1. Search box in the rail is **visual-only** for v1 (no channel filtering yet) — or wire it to
   filter the list (cheap). Default: visual-only.
2. `@ mention agent` button just focuses + inserts `@` (no picker popover). Default: yes.
3. `+ New channel` reuses the current inline project-picker, re-homed under the rail. Default: yes.
4. Attention dot uses the snapshot-with-reload approach above. Default: yes.
```
