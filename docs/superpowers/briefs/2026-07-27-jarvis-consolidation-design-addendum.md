# Jarvis consolidation — design addendum: the polymorphic Stage

- **Date:** 2026-07-27
- **Status:** Awaiting visual design
- **Audience:** Claude Design
- **Design target:** `wave` project → `Wave-jarvis-consolidated.dc.html` (revise in place)
- **Follows:** `2026-07-27-jarvis-consolidation-ui-design-brief.md`
- **Scope:** Two missing states plus three factual corrections. The shell is settled — do not redesign it.

## What is settled

`Wave-jarvis-consolidated.dc.html` is approved as the shell. Specifically: the Subjects column, the
Stage (header → record band → thread → composer), the context rail, the graph as an overlay that closes
into an object, `@jarvis` posting into the current thread instead of navigating, and the narrow-window
collapse order with the thread and composer never collapsing. None of that is in question here.

## The gap

The Subjects column holds two kinds of thing — channels (`#`) and conversations (`~`) — and, per the
decision below, will hold three. Every one of the 11 live states draws the Stage for a **channel**: the
header carries an autonomy control and a ⚙ channel-profile button, a task record band is docked above the
thread, and the rail's third section is "Fleet · this channel".

Select a `~` conversation and all four of those are about something that does not exist. The design does
not say what the Stage becomes. That is the state where "one Stage whose subject changes" either holds as a
model or turns out to be a channel Stage with two orphan cases parked next to it — so it needs drawing,
not inferring.

## Decision taken since the brief

**Dossiers become a third subject kind.** The old Tasks surface was a browsable list of every dossier;
that capability is kept rather than dropped, and it lands in the Subjects column as a third group
alongside channels and conversations. So a dossier can be *selected directly*, not only reached through a
run that touched it.

This is a scope decision, not a layout one — how a selected dossier presents on the Stage is open, and is
the second state this addendum asks for.

## What to draw

**State A — the Stage with a conversation selected.** What the Stage header carries when there is no
channel; whether the record band appears at all and if so what it is derived from; what the composer's
"Talking to" chip reads when there is no worker to talk to; what becomes of the rail's Fleet section; and
whether the phase pipeline strip is simply absent.

**State B — the Stage with a dossier selected.** A dossier selected directly is not the same as a dossier
reached as a band above a run's thread: there is no run on the Stage under it. What occupies the thread
region, and what the composer targets.

Facts that bound both, and nothing beyond them:

- A conversation has a title, a history of user turns and Jarvis answers with numbered citations,
  retrieval steps, and grounding sources. It has no channel, no runs, no workers, no autonomy tier, and no
  profile. Today it lives on its own surface as history rail │ conversation + composer │ grounding rail.
- A conversation carries no attribution edge of its own. It may be *about* a dossier without being
  attributed to one.
- A dossier has: machine-maintained acceptance criteria, blockers and a refs index (read-only); human
  notes (editable); an append-only decision log; a status of active/paused/done; and zero or more
  attributed runs with typed edges. All of that is already drawn inside the expanded record band — the
  question is the frame around it when the dossier is the subject rather than an annotation.

## Three corrections to the existing states

**1. Autonomy is a three-tier nested ladder, not a two-state toggle.** The tiers are
`concierge → gatekeeper → delegator`, each implying the one below, and the top tier carries a separate
dispatch mode of `report | manage | fanout`. The stage header currently draws a binary switch labelled
"Handling asks ↔ Observing". Three tiers plus a mode need to be readable at a glance and changeable;
whether all of that belongs in the header or splits between the header and the ⚙ drawer is open.

**2. A run has zero or more attributed dossiers, not exactly one.** Attribution returns a list, each edge
carrying a confidence bucket (`weak | medium | strong`) and a state (`informing | confirmed`). **Zero is
the common case today** — most runs have no dossier at all. The record band is drawn only for the single
confirmed-dossier case. Needed: the band with no dossier, and the band with several. Edge state and
confidence currently appear only inside the expanded panel; on the collapsed one-line band the user cannot
tell a confirmed attribution from a weak inferred one.

**3. The nav rail has no needs-you badge.** Today two disjoint counts sit on two entries: asks from
channel-dispatched workers, and asks from standalone ones. Merging Channels away leaves the
channel-dispatched count without a home, and a blocked worker must stay visible from every other surface —
so the Jarvis entry needs a badge treatment that the current rail does not draw.

## Unchanged constraints

Dark theme only. 46px app bar, 78px nav rail. Nav rail goes to 8 entries. No second command palette — ⌘P
stays the only global entry. Needs-you is never suppressed by a Space filter. Memory keeps its own graph
and stays a separate nav entry. Live worker output must never be torn down to make room for anything.
