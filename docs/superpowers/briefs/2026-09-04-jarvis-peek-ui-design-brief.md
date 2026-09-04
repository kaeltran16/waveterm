# Jarvis peek — UI design brief

**Date:** 2026-09-04
**Status:** Ready for visual design. One product decision taken (see §3); the composition is open.
**Audience:** Claude Design
**Design target:** `wave` project, proposed file `Wave-jarvis-peek.dc.html`
**Scope:** Product and interaction design of one anchored panel. Not an implementation spec or plan.
**Supersedes (visually):** `docs/superpowers/specs/2026-08-13-jarvis-peek-redesign-design.md` §1, §3, §4, §5, §6. That spec's §7 (interaction and accessibility) still stands and is a constraint here, not a suggestion.
**Still authoritative:** `docs/superpowers/specs/2026-08-04-jarvis-pet-design.md` (the creature's registers, condition precedence, and the two crossing rules) and `docs/superpowers/specs/2026-08-06-jarvis-acts-design.md` (what an act is and when one may be offered).

## 1. The design problem

The peek is the panel that opens when you click the Jarvis creature in the corner of the cockpit. It is the only Jarvis surface available from every other surface without navigating away.

It was redesigned once, on 2026-08-13, from "a diagnostic stack" into "a balanced hub" — three peer sections given deliberately equal weight: **System status**, **Recent updates**, **Ask Jarvis**. That spec states its premise explicitly: *"None is the permanent primary workflow."*

**That premise is what produced the panel we have, and the premise is the thing being overturned.** Three peers with equal weight is the same as no hierarchy. The result is technically complete and reads as telemetry.

### Measured, from the running app

Captured over CDP at a 1600×950 window, with the user's real state: embeddings off, 9 vault notes to review, nothing waiting, no channel selected.

- The panel is **418 × 693 px** — 73% of the window height — anchored above the bottom-right creature.
- **Two of the four status tiles report absence**: `Window / No reading / Usage unavailable` and `Waiting / Nothing / No action needed`.
- **The same fact is stated twice.** A red banner reads *"I cannot see as well right now — embeddings are off, so recall is keyword-only"*; the Recall tile below it reads *"Unavailable"*. The code suppresses one when the other is showing, via `expression.kind !== "cannot-see"` checks scattered through the render — the conditional itself is the evidence that the two are redundant.
- **The empty updates state costs 78px** to say nothing happened: a section header, *"not read yet"*, *"No updates yet"*, and *"Jarvis will keep spoken updates and their actions here."*
- **The ask row states its disabled condition three times** in a 90px band: *"No channel selected"* (section meta), *"Select a channel to ask Jarvis"* (placeholder), *"No destination"* (footer).
- **Eight distinct font sizes** in one 420px panel: 9, 9.5, 10, 10.5, 11, 11.5, 12.5, 14px, across 24 declarations.
- **The voice flips register.** The banner speaks as Jarvis in first person; everything around it is `SYSTEM STATUS` in mono uppercase over dotted metric tiles.

### The failure mode to avoid

**Becoming a dashboard.** A creature that exists so the system "stops hiding things" (pet design §2) has turned into a status board that reports the absence of things. If the mockup contains a metrics grid, sparklines, a gauge, or any tile whose populated state is the word "Nothing", it has failed regardless of how good it looks.

The opposite failure is equally available: **becoming a second Jarvis surface.** The peek is a transient popover over whatever the user was doing. It is not a workspace, and anything that wants a 500px+ composition belongs on the Jarvis surface behind the "Open full view" link that is already there.

## 2. What exists today

Implementation: `frontend/app/view/jarvis/petpeek.tsx` (683 lines), with the ask composer split into `peterrand.tsx` and its pure state in `peterrandmodel.ts`. Mounted globally from `frontend/app/cockpit/cockpit-root.tsx`, so it opens over **every** surface.

Current composition, top to bottom:

1. **Header** (52px) — "Jarvis", a health badge, "Open full view", a close button.
2. **System status** card — an optional priority banner, then a fixed 2×2 grid (Recall / Window / Vault / Waiting), then the waiting-item list when attention exists.
3. **Recent updates** card — the `petSaidAtom` feed with a last-pass reading in the header.
4. **Ask Jarvis** card — a text field, an Ask button, a harness picker, and the destination.

The creature itself is a corner dweller in one of the **two bottom corners** (left or right, drag to move, position persisted). The peek anchors above it with a 12px offset and shifts to stay on screen. **Do not redesign the creature, its speech bubble, or its corner behaviour** — that is settled and measured (pet design §9).

## 3. The decision already taken

The peek's three jobs are **not** peers. They rank:

1. **Do what needs doing.** The queue of things waiting on the user leads the panel and carries its actions inline.
2. **See what happened.** Spoken updates are a second group in the *same* list, not a second card — deduplicated against the queue, because an ask is currently both.
3. **Ask Jarvis.** A compose bar, always available, that names where the reply will land.

**Everything that can be acted on becomes a row carrying its own action. Everything that cannot becomes one line of text.** Nothing renders to announce that nothing is wrong.

This ranking is settled. How it becomes a composition is the design work.

## 4. The content inventory

Every item below already exists in the frontend and costs nothing new to render. **No new backend, RPC, or inference is in scope.** A design that needs a reading not on this list is proposing new engineering and should say so loudly.

### The queue — `attentionAtom`, polled every 10s

Server-computed in `pkg/jarvis/attention.go`. Five kinds, each an `AttentionItem`:

| Kind | Means | Its action label |
| --- | --- | --- |
| `gate` | a run phase is waiting on approval | Review |
| `escalation` | a Gatekeeper escalation from a worker | Decide |
| `ask` | an agent is blocked on a question | Answer |
| `dag-gate` | a DAG stage awaits review | Review |
| `dag-blocked` | N consecutive failures — retry or skip | Review |

Each carries: `source` (the run goal or worker name), `text` (a one-line explanation), `action`, `waitingsince` (for an age), plus `channelid` / `channelname` / `runid`. Acts come from `actsForAttention(item, tier)` and are **gated by the channel's autonomy tier** — the same item offers different buttons in different channels, and an item with no `runid` offers none at all.

### The updates — `petSaidAtom`, session-scoped, capped at 20

Everything the creature has said aloud this session, newest first. Ten kinds: `resume`, `sweep`, `distill-batch`, `bg-agent-done`, `recall`, `connection`, `loose-end`, `ledger`, `notify`, `ask`. Each has `text`, an optional dimmed `detail`, an age, and acts from `actsForEvent`.

**These overlap the queue.** A pending ask is an `AttentionItem` keyed `ask:<block-oref>` *and* a `PetEvent` with `id: ask:<askid>` carrying the same oref. It must appear once. The pet design's crossing rule already governs this: *"Report each thing once. The event is the transition, the condition is the level."*

### The conditions — three ranked signals, `PetSignals`

Strict precedence, never blended (pet design §4 decision 4): `cannot-see` › `tired` › `drifting`, else `at-rest`.

| Expression | Source | Reads | Has a remedy? |
| --- | --- | --- | --- |
| `cannot-see` | embedding index state (`off` / `stale`) | recall is degraded or unavailable | **Yes** — `actsForRecall` |
| `tired` | highest 5-hour provider utilisation + reset time | the usage window is constrained | **No** — a countdown has no action |
| `drifting` | vault decay: queue depth + stale-note count | the vault needs tending | **Yes** — `actsForVault` |

`tired` having no remedy is deliberate and documented: *"a row with genuinely nothing to do returns [] and stays a readout — the rate-limit countdown is that row, and it is honest rather than an omission."*

### The acts

An act is one of three verbs, and the type is closed:

- **`do`** — executes in place and reports its outcome beside the button (`reconcile-index`, `clear-superseded`, gate approve/sendback).
- **`open`** — navigates and therefore **closes the peek** (an oref, the Memory upkeep queue, or the Settings embeddings section).
- **`ask`** — seeds a question about a source.

A `do` act has a transient status (`running` / `done` / `error`) with text that renders next to it. **The design must show where an act's outcome text goes**, including a two-line error, without the row jumping.

### The ask composer

A text field, an Ask button, a harness picker (`Pi ▾` etc.), a destination channel, and a streamed reply that renders below the field while it arrives. `petErrandState` distinguishes a locked input (no destination, or a reply in flight) from a blocked submit (empty draft, no harness chosen, preference saving).

**The destination is broken today, and fixing it is in scope.** The composer reads the *Jarvis surface's* selected channel, which nothing sets at boot: `primeChannels` deliberately fetches the channel list without selecting, and the Jarvis surface's first neutral entry lands on Briefing rather than a channel. So on a fresh launch the field is dead everywhere until the user goes to Jarvis and clicks a channel. The panel needs its own destination — defaulting sensibly, visible, and changeable — so a global creature stops depending on a surface the user may never have opened.

## 5. Required design states

Produce enough states to settle the interaction, not only the populated ideal.

1. **The state the panel is built for** — a live queue (a gate, an escalation, an ask) plus a couple of recent updates, with a condition also degraded. This is the primary frame.
2. **All quiet** — no queue, no updates, no degraded condition. This is the most common state and today it costs 693px. Show what it collapses to.
3. **The user's actual state** — nothing waiting, but recall off *and* the vault drifting. Two conditions, both actionable, no queue. Show that two conditions do not become a wall.
4. **A condition with no remedy** — `tired`, a countdown with no button, sitting beside conditions that do have one. It must not read as a broken row.
5. **A long queue** — eight or more waiting items. Show what scrolls, what stays pinned, and how the user knows there is more.
6. **An act mid-flight and an act that failed** — the running state and a two-line error, in place, without the row reflowing.
7. **The ask composer streaming a reply** — the panel is a popover with a bounded height, and a reply arrives progressively into it.
8. **The ask composer with no destination yet** — if your composition still permits that state, show how it asks for one. One statement, not three.
9. **Narrow window** — the panel caps at `calc(100vw - 16px)`; the reference narrow case is a 440×420 viewport. Show what collapses and in what order.
10. **The creature in the opposite corner** — the panel anchors above either bottom corner, so its content must not assume which side it grew from.

Use believable Wave content — real-shaped run goals, channel names, worker names. Fabricated values are fine for presentation but should read as placeholders, not as claims about the project.

## 6. Constraints

Hard, in roughly descending cost of getting them wrong.

- **The creature never renders a count.** Pet design §4 decision 2: *"nav badge keeps the count, creature expresses kinds only."* The nav rail's Jarvis badge shows the number and stays visible behind the peek's backdrop. So a header badge may say *"Needs you"* — never *"2 need you"* — and a group heading may not carry a tally. The list's own length is the count. **If your composition genuinely needs a number, say so and argue it; do not quietly add one.**
- **Report each thing once.** An ask that is both queued and spoken renders once. This is a design rule, not only an implementation detail.
- **Nothing appears that does not carry its own remedy** — or is honestly a readout. Acts belong on the exact row they affect, never collected into a toolbar.
- **Dark mode only.** No light or Paper variant, permanently.
- **Tokens only, no raw hex.** Runtime theming overrides the same `--color-*` custom properties, so a hardcoded colour silently opts out of all six theme presets. Families available: surfaces (`--color-surface`, `--color-surface-raised`, `--color-surface-hover`), text (`--color-primary`, `--color-secondary`, `--color-ink-mid`, `--color-muted`, `--color-ink-faint`), edges (`--color-border`, `--color-edge-mid`, `--color-edge-strong`), accent (`--color-accent`, `--color-accent-soft`, `--color-accentbg`), status (`--color-error`, `--color-warning`, `--color-success`, each with a `-soft` variant). Definitions are in `frontend/tailwindsetup.css`.
- **Status is never colour alone** — always paired with an icon, a dot, or a label.
- **Geometry.** 420px nominal width, capped to `calc(100vw - 16px)`; height capped to `calc(100vh - 16px)`; anchored 12px above the creature in either bottom corner, shifting to stay on screen. Reference window is 1600×950; the app bar is 46px and the nav rail 78px, both of which stay put behind the panel.
- **Keep the header pinned.** Something in the panel must scroll rather than the panel growing to the viewport; the header must survive that scroll. The narrow-window scenario asserts this.
- **Interaction and accessibility, inherited whole from the prior spec §7:** a labelled `dialog` with `aria-modal`; opening focuses the panel container, not the text field; tab order follows visual order and currently begins at "Open full view"; focus is trapped while open; Escape, the close button, and a backdrop press all dismiss and return focus to the creature; every control has a visible focus ring. **Escape must dismiss only the peek** — the global `surface:back-home` binding is gated on the peek's open atom, and without that guard Escape also ejects the user to the Cockpit.
- **A navigating act hands focus to its destination**, not back to the creature.
- **Verification is by screenshot over CDP, not render tests.** There are deliberately no jsdom tests in this repo. Prefer compositions that are unambiguous in a still frame. A `jarvis-peek` scenario already asserts the dialog's structure, tab order, bounded geometry, and dismissal paths; it will be updated to the new structure, so name your regions clearly enough to assert against.

## 7. Deliberate non-goals

- **The creature, the speech bubble, the corner placement, the drag behaviour.** Settled and measured; do not redraw.
- **The full Jarvis surface.** "Open full view" already exists and stays.
- **The nav rail, the app bar, the cockpit shell.**
- **Any new backend, RPC, poller, or persisted object.** Frontend regrouping of existing reads only.
- **Changing condition precedence, act availability, or tier gating.**
- **Counts on the creature** (see §6).
- **A settings or preferences area inside the panel.**
- **Light mode.**
- **Onboarding, first-run, or an off switch.** Explicitly deprioritised — this is a personal-use application.

## 8. Design latitude

This is the actual design work.

- **How a condition reads next to a queue item.** They are different kinds of thing — a standing level versus a discrete waiting item — and today they look identical. Whether conditions sit above the list, inside it, in the header, or somewhere else entirely is open.
- **Whether the two list groups are visually distinguished at all**, and how, given the panel is 420px wide and a heading costs ~24px.
- **What the header carries.** Identity, a qualitative state word, the two controls — or less.
- **Where the non-actionable readings live** (the usage window, when the vault was last swept, when Jarvis last ran a pass), or whether they earn a place in the panel at all rather than moving to the Jarvis surface.
- **Row density.** Two lines per item is the current idiom; one line fits twice as many before scrolling. Both are defensible.
- **What the resting state actually is.** "All quiet" with nothing to do is the most frequent state of this panel. It could be one line, or it could be something better than a line — but it must not be a page of empty cards.
- **How the destination channel is chosen and displayed** in the composer.
- **What collapses first at narrow widths.**

Prefer the simplest composition that makes *what needs me, what happened, and what can I ask* answerable in one glance at a still frame.

## 9. Success criteria

- The resting panel is a small fraction of its current 693px, and the reduction comes from removing absence, not from hiding things that exist.
- A user with three things waiting can act on all three without scrolling and without leaving the panel.
- No fact appears twice anywhere in the panel, in any state.
- Every actionable reading carries its action; the one non-actionable condition (`tired`) reads as honest rather than broken.
- The ask composer is usable on a fresh launch from any surface, and names where the reply lands — once.
- The panel reads as Jarvis speaking, not as a monitoring console.
- It remains a popover: it never looks like it wants to be a surface.
- The type scale is materially smaller than eight sizes.
- Escape, close, and backdrop still dismiss cleanly, and focus returns to the creature.

## 10. Deliverable

A desktop-first interactive design in the `wave` project, proposed as `Wave-jarvis-peek.dc.html`, covering the states in §5. Include interaction annotations wherever a static frame is ambiguous — particularly around scroll boundaries, where act outcome text appears, and what the panel does as a reply streams in.

Reuse the existing Wave design system and cockpit shell. `Wave-jarvis-consolidated.dc.html` and `Wave-cockpit-live.dc.html` are the closest existing relatives for shell and Jarvis vocabulary; confirm the project's current file list before assuming a reference exists. Token definitions live in `frontend/tailwindsetup.css`.

## 11. Open questions for the designer

1. **Does the header need a state word at all**, given the conditions are visible immediately below it and the nav badge already carries the count?
2. **Should the composer be pinned or scroll with the content?** Pinned guarantees it is always reachable and costs ~64px of every state including the empty one.
3. **Is "since you looked" the right second group**, or is spoken history better reached from the full Jarvis view given it is session-scoped and capped at 20?
4. **What happens to the last-pass reading** (*"snapshot 12m ago"*)? It currently sits in the updates header and is the panel's only evidence that Jarvis is running at all.
