# Jarvis consolidation — UI design brief

**Date:** 2026-07-27
**Status:** Ready for visual design
**Audience:** Claude Design
**Design target:** `wave` project, proposed file `Wave-jarvis-consolidated.dc.html`
**Scope:** Product and interaction design only. Not an implementation spec or plan.
**Supersedes (visually):** the surface composition in `Wave-jarvis-second-brain.dc.html`, `Wave-jarvis.dc.html`, and the Channels frames of `Wave-cockpit-live.dc.html` — all three describe pieces that this brief merges into one.

## The design problem

Jarvis is one thing, but it currently occupies **four separate entries in the cockpit navigation rail**: Channels, Jarvis, Graph, and Tasks. A fifth region (Jarvis's own "Fleet" mode) duplicates chrome that already exists on Channels.

This is a regression against the second brain's own governing invariant. From `docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md`, cross-cutting invariant 8:

> **Presence D.** Ambient signals + `Ctrl+P` reuse + **a first-class Jarvis surface**. No second command palette, no new global shortcut, no permanent assistant panel on every surface, and Tasks do not dominate the hierarchy.

*A* first-class Jarvis surface. Singular. The fragmentation was incidental, not designed: the Tasks surface (sub-project U2) and the Graph surface (U3) each added a nav entry as they shipped, and U3's own spec wanted the slot next to Jarvis but was placed elsewhere purely to avoid disturbing existing keyboard chords.

**Design one Jarvis surface that absorbs all four.** The user has explicitly chosen the widest merge: Channels — where work is dispatched and driven — comes inside too.

### The two failures this must fix

The user named two specific pains, and the design is measured against them:

1. **Navigation cost.** Things used together live apart. Driving a run, reading the task record that run belongs to, asking what happened last time, and seeing what a record connects to are four destinations.
2. **Duplicated UI.** The same components are built twice or three times (evidence below).

### The failure mode to avoid

**Four nav entries becoming four sub-tabs is not a solution.** It would shorten the nav rail while leaving hop count identical — every hop simply moves one level inward. If the design contains a `Runs │ Recall │ Tasks │ Graph` mode switch, it has renamed the problem rather than solved it. Name and avoid this.

## What exists today

Factual inventory. This is the current state, not a proposed structure.

### Nav entry 1 — Channels

*"A channel is its runs."* Project-bound channels; each channel holds Runs; each Run holds phases and live worker agents.

- A channel list column (`w-[244px]`), with per-channel live state.
- A channel header carrying an **autonomy tier toggle** (concierge / gatekeeper — "Observing" vs "Handling asks") and a **⚙ profile drawer** (playbook, principles, run engine, plan gate).
- A collapsible channel-overview strip with free-text human notes.
- A **run strip** — the runs in this channel, selectable, dismissable, plus "new run".
- A **run body** — the selected run's phases, workers, live transcript narration, ask-in-place answering, and a proactive "related prior work" card.
- A **two-face composer**: a *Launch* face that creates runs, and a *Talk* face that messages the selected run's live worker. It accepts typed commands — `@run` (full strategy), `@quick` (one worker), `@ask` (one-shot consult, no worker), `@jarvis` (fleet summary).
- A right rail with three sections: **Needs you**, **Consults** (ask-mode results), **Fleet here** (worker roster, working/waiting counts, cost).

### Nav entry 2 — Jarvis

Two modes behind a toggle.

**Recall mode** — the second brain:
- A conversation history column (`w-[240px]`).
- A conversation: user turns, Jarvis turns, streamed working steps (done/active/pending), answer text with inline numbered citations, and three terminal states (answered / weak grounding / not found).
- A composer for asking.
- A right rail of **grounding source cards**: source type, title, project, age, and freshness (fresh / stale / unavailable).

**Fleet mode** — a per-channel fleet manager:
- A channel `<select>`, the autonomy toggle, the ⚙ profile drawer, a worker roster, working/waiting counts, cost, and a "Summarize the fleet" action.

### Nav entry 3 — Tasks

Task dossiers — the machine-maintained record of a piece of work.
- A dossier list column (`w-[280px]`), grouped Active / Paused / Done.
- A detail view: a read-only **machine-maintained panel** (acceptance, state, blockers, refs — with a lock affordance), read-only human **Notes**, and an **append-only decisions log**. Two human writes exist: append a decision, and set status (with a confirmation on terminal transitions).
- No right rail.

### Nav entry 4 — Graph

The whole vault as a force-directed map — several hundred nodes.
- Node kinds: task, decision, memory, run. Clicking a task blooms its attributed Run nodes.
- Edges encode three dimensions simultaneously: `informing` (dashed) vs `confirmed` (solid); confidence bucket → opacity and width; semantically-inferred provenance → a distinct hue. A provisional inferred edge must never read like a canonical dispatch one.
- A selection card naming the focused node.
- No rails, and **no way to get from a node to the thing it represents** — cross-surface navigation was deferred.

### A fifth vault view, outside this merge

**Memory** is a separate nav entry with its own Graph │ List toggle over the same vault (memory notes are vault nodes; the Graph surface's renderer is a fork of Memory's). Memory is **out of scope for this merge** and stays a separate nav entry — but it means two force-directed graph renderers exist over overlapping data. The design need not solve this; it should not make it worse.

## Duplication evidence

Concrete, measured. This is what "duplicated UI" means here.

| What | Where it lives twice or three times |
|---|---|
| The left column | Three near-identical `border-r bg-surface` columns at 244px, 240px, and 280px |
| The right rail | Two instances of the *same shared component* (`CollapsibleRail`, 300px open / 44px collapsed), differing only in which sections they carry |
| Worker roster + autonomy toggle + ⚙ profile drawer + working/waiting counts + cost | Channels' header and right rail; **and again** in Jarvis's Fleet mode, re-derived from the identical helper functions. ~207 lines of pure duplication. |
| A composer | Channels (two faces, typed commands) and Jarvis Recall (its own) |
| A force-directed graph renderer | The Graph surface and the Memory surface |

Jarvis's Fleet mode is the clearest case: it reads the *same* active-channel state as Channels and calls the *same* snapshot/count/cost helpers, so the two surfaces can never disagree — because one is a copy of the other.

## The object model

What the four surfaces are views of, and how the objects already relate. This is the substrate a design can lean on.

- A **Channel** is bound to a project and owns **Runs**.
- A **Run** has phases and live **worker agents**; a worker can be *working*, *asking* (blocked on a human answer), or *idle*.
- A **Dossier** is the durable record of a task: objective, status, acceptance criteria, blockers, a machine-maintained refs index, human notes, and an append-only decisions log.
- **Attribution edges** already join dossiers to the Runs that worked on them, typed by relationship (`informing` / `confirmed`) and confidence.
- A **Conversation** is a Jarvis recall thread; its answers cite **grounding cards** that point at dossiers, memory notes, decisions, and runs.
- The **vault graph** is all of the above as nodes and edges.

Two cross-cutting mechanisms already exist and must survive:

- **Spaces (task focus).** An app-bar chip makes one dossier the app-wide lens; surfaces scope to that task's attributed runs, with a "show all" escape hatch. Critically: **needs-you signals are never suppressed by a Space filter.** Today Spaces scopes the agent roster and Channels; a merged surface means it scopes more.
- **Ambient attribution.** Rows on other surfaces carry task tags derived from those attribution edges (solid = confirmed, dashed = informing).

## Entry points that must land somewhere

These handoffs exist today and each currently targets a specific nav entry. A merged surface must give every one of them a destination. Several exist *only because* the pieces are separate tabs.

1. **Nav rail click** — no context.
2. **`Ctrl+P` → Ask Jarvis** — a question from any surface.
3. **Contextual entry** — "Ask Jarvis about this" from a Memory note, Run, or Radar finding; arrives with the object attached as a source chip and a suggested prompt.
4. **`@jarvis <focus>` typed in a Channels composer** — today this switches nav entry, flips Jarvis into Fleet mode, and runs a fleet summary scoped to that channel. A cross-tab hop that a merge should make unnecessary.
5. **Radar finding → investigation** — arrives as a *drafted, unstarted* run goal with attached files and evidence signals, awaiting review and a "start" confirmation.
6. **"Open run"** — deep-link to a specific run inside a specific channel.
7. **Space chip → "Open dossier"** — deep-link to the focused task's record.

## Required design states

Produce enough states to settle the interaction, not only the ideal populated screen.

1. **First use** — no channels, no tasks, no conversations. What does the surface invite?
2. **A live run** — workers working, transcript narrating, phases progressing.
3. **A run blocked on the user** — a worker asking a question, answerable in place, with numbered options.
4. **Multiple channels with mixed live state** — how attention is routed when two channels are working and a third is asking.
5. **A task dossier** — machine-maintained regions visibly read-only, human notes, append-only decisions log, status transition.
6. **A task and its runs together** — the attribution join made visible: this record, and the work attributed to it.
7. **A multi-turn Jarvis conversation with grounding** — mixed source types, inline citations, one source expanded.
8. **Jarvis working** — retrieval activity visible while the answer streams.
9. **Weak grounding, and not found** — both as first-class results, not error states.
10. **A stale or unavailable source.**
11. **The vault graph at scale** — several hundred nodes, typed edges, and the path from a node back to the thing it represents.
12. **Space focus active** — a task is the lens: what is scoped, what is hidden, where the escape hatch is, and how needs-you still gets through.
13. **A Radar handoff landing** — a drafted investigation awaiting review and start.
14. **Fleet view of a channel** — roster, autonomy tier, working/waiting counts, cost, summarize action.
15. **Narrow window** — what collapses, and in what order.

Use believable Wave content. Fabricated identifiers and titles are fine for presentation but should read as placeholders, not real project claims.

## Constraints

Product constraints that bind any design.

- **Dark mode only.** No light or Paper variant — permanently out of scope.
- **Preserve the 46px app bar and the 78px nav rail.** The app bar carries the Space chip and the search affordance that opens `Ctrl+P`.
- **The nav rail goes from 11 entries to 8** (Channels, Graph, and Tasks are absorbed). Remaining: Cockpit, Jarvis, Agent, Radar, Sessions, Diff, Memory, Usage, plus Settings. A side benefit: keyboard chords are bound to only the first 8 rail entries today, so Graph, Tasks, and Usage are currently unreachable by chord; at 8, every entry gets one.
- **No second command palette and no new global shortcut.** `Ctrl+P` is the only global entry.
- **Use the established design tokens** — typography, spacing, color, radii, restrained motion. No raw hex in annotations; refer to tokens.
- **Jarvis must feel native to the cockpit**, not like an embedded third-party chat app.
- **Grounding is first-class.** Every factual claim cites its source; "not found" and "weak candidate" are rewarded terminal states, never confabulated over. Stale and unavailable sources are surfaced, not hidden.
- **The human owns material decisions.** Machine-maintained regions are visibly not editable; decisions append rather than overwrite; terminal status transitions confirm.
- **Live terminal content must not be casually torn down.** Agent transcripts and live worker output are expensive to remount; a design that repeatedly destroys and rebuilds the region showing them will feel broken. Prefer compositions where the live region persists.

## Deliberate non-goals

- A mode switcher that reproduces the four nav entries as four sub-entries.
- A Tasks-first dashboard, or a graph-first interface. Neither task records nor the graph may become the surface's home screen.
- Folding **Memory** into this merge — it stays a separate nav entry.
- A permanent assistant panel on every other surface, or separate assistant instances per surface.
- Model selection, prompt engineering, or retrieval configuration exposed as UI.
- Obsidian UI, Canvas, Dataview, or plugin compatibility.
- Light mode.
- Redrawing the surrounding cockpit from scratch — reuse the existing shell.

## Design latitude

These are genuinely open. They are the design work, and this brief deliberately does not answer them.

- **How the user moves between a run, a task record, a conversation, and the graph.** This is the central question. Whether that is one region that changes contents, several regions coexisting, an overlay, a spatial arrangement, or something else is unspecified.
- Whether Channels, Tasks, and conversation history remain three separate lists, become one list, or are reached some other way entirely.
- Whether the graph is a region, an overlay, a background, a zoom level, or a navigational device — and how a node connects back to the object it represents.
- Whether the run-driving composer and the ask-Jarvis composer become one input or stay distinct, and how a user knows which one they are talking to. Note that the typed command language (`@run` / `@quick` / `@ask` / `@jarvis`) already spans both dispatching work and asking questions.
- Where the fleet controls live once Fleet mode is gone — the autonomy toggle, the ⚙ profile drawer, the roster, cost, and the fleet summary all need a home.
- How grounding sources and channel context (Needs you / Consults / Fleet) coexist, given both are currently the same collapsible rail component.
- How Jarvis's identity reads in a surface that is now also where work gets dispatched — without becoming decorative or anthropomorphic.
- What collapses first at narrow widths.

Prefer the simplest composition that makes the current subject, its context, and its grounding immediately understandable.

## Success criteria

The design succeeds when:

- **Hop count actually drops.** Driving a run, reading its task record, and asking what happened before are not three destinations. If the mockup still requires the same number of moves as today, it has failed regardless of how short the nav rail got.
- The first impression is still *"this is Jarvis"* — not a task manager, not a graph browser, not a project dashboard.
- Nothing on screen is a second copy of something else on screen. In particular, exactly one worker roster, one autonomy control, one profile drawer, and one grounding treatment exist.
- It is always clear what Jarvis is looking at, and what would happen if you typed into the composer.
- A blocked worker gets the user's attention even when a Space filter is active.
- Every one of the seven entry points above has a visible, unambiguous landing place.
- The interface remains recognizably Wave.

## Deliverable

A desktop-first interactive design in the `wave` project, proposed as `Wave-jarvis-consolidated.dc.html`, covering the required states above. Include concise interaction annotations where a static frame would be ambiguous. Reuse the existing Wave design system and cockpit shell.

Existing references in the `wave` project: `Wave-cockpit-live.dc.html`, `Wave-jarvis.dc.html`, `Wave-jarvis-second-brain.dc.html`, `Wave-memory.dc.html`, `Wave-design-system.dc.html`, `tokens/colors.css`, `tokens/spacing.css`, `tokens/typography.css`.
