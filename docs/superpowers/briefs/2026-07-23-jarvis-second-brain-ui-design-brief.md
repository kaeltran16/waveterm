# Jarvis second brain — UI design brief

**Date:** 2026-07-23  
**Status:** Ready for visual design  
**Audience:** Claude Design  
**Design target:** `wave` project, proposed file `Wave-jarvis-second-brain.dc.html`  
**Scope:** Product and interaction design only. This is not an implementation spec or plan.

## The design problem

Jarvis is evolving from a Channels-bound fleet manager into Wave's app-wide second brain. It should help the user recall what happened, recover context, understand why decisions were made, and continue work across agents, Channels, Runs, sessions, Radar findings, commits, memories, and task records.

The primary experience is **Jarvis itself**, not a task manager or knowledge dashboard. Tasks are only one kind of source Jarvis may understand. A user should not need to organize their work around tasks before Jarvis becomes useful.

Design a Jarvis-first experience with two depths:

1. a fast, global question from the existing command palette;
2. a full Jarvis surface for persistent, multi-turn work.

The transition between them should feel continuous: a quick question can grow into a conversation without losing its answer, context, or sources.

## Product hierarchy

The UI hierarchy is:

1. **Jarvis conversation** — the primary interaction.
2. **Current context** — what Jarvis is reasoning about now.
3. **Grounding sources** — the records supporting an answer.
4. **Native source surfaces** — where the user inspects or edits the underlying object.

Sources may include:

- memories and decisions;
- agents and sessions;
- Channels and Runs;
- Radar findings;
- commits, diffs, verification evidence, and artifacts;
- tasks or ticket dossiers when they exist.

Do not elevate any one source type into the main navigation or dominant visual structure. In particular, do not make Tasks the second brain's home screen.

## Core experience

### 1. Full Jarvis surface

Jarvis should be a first-class cockpit surface in the main navigation.

The surface should support:

- starting a new conversation;
- returning to recent conversations;
- multi-turn questions and follow-ups;
- streamed answers and visible working/tool activity without overwhelming the answer;
- explicit grounding citations;
- inspection of the context currently available to Jarvis;
- opening a cited source in its native Wave surface;
- continuing or acting on an answer where appropriate.

The visual center of gravity must be the conversation. Conversation history and source context are supporting regions and may collapse when space is constrained.

A likely desktop composition is:

- a lightweight conversation-history region;
- a flexible central conversation;
- a contextual source/grounding region.

This is a starting constraint, not a demand for a conventional three-column chat layout. Explore a composition that feels native to the existing Wave cockpit.

### 2. Global quick ask

Reuse Wave's existing `Ctrl+P` command palette rather than inventing a second global command bar or shortcut.

A user should be able to enter a Jarvis question from any surface. The design should show:

- how the palette distinguishes a Jarvis question from search, navigation, and launch actions;
- the compact answering state;
- citations or source indicators in limited space;
- weak-answer and not-found states;
- a clear **Continue in Jarvis** handoff to the full surface.

The full conversation must inherit the quick question, answer, and attached context.

### 3. Contextual entry points

Existing surfaces should offer small, local ways to ask Jarvis about the selected object, for example:

- **Ask Jarvis about this Run**
- **Explain this Radar finding**
- **What changed since this session?**
- **Recall related decisions**

These actions open Jarvis with the object already attached as context. They should feel like entry points into the same assistant, not separate assistants embedded throughout the app.

Avoid large inline chat panels on every surface.

## Context and scope

Jarvis should inherit useful context from where it was invoked:

- from the global palette: current project and current surface;
- from a Channel or Run: that object and its related live records;
- from Memory: the selected note and its links;
- from Radar: the finding, evidence, and originating Run when available.

The user must always be able to see the effective scope before sending and adjust it without understanding retrieval mechanics.

Explore compact scope controls in or near the composer, such as:

- current object;
- current project;
- all Wave knowledge;
- explicitly attached sources.

The scope UI should answer “what will Jarvis look at?” without becoming a database-query builder. Default intelligently; make correction easy.

## Answers and grounding

Trust is a central visual requirement. Every factual answer based on Wave knowledge should make its grounding inspectable.

Design answers with:

- unobtrusive inline citations;
- a source list that shows source type, title, project, age, and freshness where relevant;
- a visible path back to the authoritative object;
- clear separation between confirmed facts, inference, and weak candidates;
- an explicit **Not found** result rather than a fabricated answer;
- stale or unavailable source treatment.

Opening a citation should navigate to or reveal the native source. Jarvis may summarize a Run, decision, task record, or memory, but it does not replace the source's owning surface.

Do not visualize the full knowledge graph by default. A traversal path may be shown when it materially explains the answer, but the graph is evidence, not the main interface.

## Conversation character

Jarvis is an engineering partner, not a generic chatbot.

The UI should make these behaviors feel natural:

- **Recall:** “Why did we avoid per-run worktrees?”
- **Continuity:** “Where did we leave the channel-scaling work?”
- **Synthesis:** “What do the recent Radar findings have in common?”
- **Preparation:** “What context should the next worker receive?”
- **Action:** “Open the Run that produced this decision.”

Answers should be concise by default and expand through follow-up. Suggested prompts may appear only in empty states; avoid a permanent dashboard of canned capabilities.

## Required design states

Produce enough states to settle the interaction, not only the ideal populated screen:

1. Jarvis surface — first use / no conversations.
2. Jarvis surface — active multi-turn conversation.
3. Grounded answer — several mixed source types and one expanded source.
4. Jarvis working — retrieval/tool activity while the answer streams.
5. Weak grounding — candidates found, but confidence is insufficient.
6. Not found — no supporting source.
7. Source unavailable or stale.
8. Global quick ask — composing.
9. Global quick ask — compact cited answer.
10. Quick ask — continued into the full Jarvis surface.
11. Contextual invocation from a Run or Radar finding.
12. Narrow-window behavior with supporting regions collapsed.

Use believable Wave content in the mockups. Example source labels and identifiers may be fabricated for presentation, but should read as placeholders rather than real project claims.

## Existing Wave design language

Build on the existing dark cockpit rather than introducing a new visual system.

Relevant design references in the `wave` Claude Design project:

- `Wave-cockpit-live.dc.html`
- `Wave-jarvis.dc.html`
- `Wave-memory.dc.html`
- `Wave-design-system.dc.html`
- `tokens/colors.css`
- `tokens/spacing.css`
- `tokens/typography.css`

Important product constraints:

- dark mode only; do not design a light/Paper variant;
- preserve the existing 46px app bar and 78px navigation rail;
- use the established typography, spacing, color tokens, radii, and restrained motion;
- Jarvis should feel native to the cockpit, not like an embedded third-party chat app;
- regular conversational output remains primary; special visual treatments are conditional on the content;
- avoid raw hex colors in implementation annotations—refer to design tokens.

The existing app-bar search opens the `Ctrl+P` palette. Its placeholder and affordance may change to communicate that users can search, launch work, or ask Jarvis.

## Inspiration, not templates

Useful interaction references:

- **Raycast:** Quick AI can hand a question and its history into the full AI Chat workspace.
- **Mem:** chat is primary while notes appear as attached context.
- **Notion:** workspace answers expose citations and allow source scoping.
- **Granola:** chat scope follows the user's current location, from one record to the whole workspace.
- **Tana:** structured knowledge objects remain sources inside a first-class conversation.

Do not copy their visual styling. The transferable pattern is **quick ask → deep conversation → inspectable sources**.

## Deliberate non-goals

- A Tasks-first dashboard or task-management product
- A generic document browser presented as the second brain
- A permanent assistant side panel consuming space on every surface
- Separate assistant instances for Channels, Runs, Memory, or Radar
- A graph-first interface
- A second command palette or a new global shortcut competing with `Ctrl+P`
- Obsidian UI, Canvas, Dataview, or plugin compatibility
- Model selection, prompt engineering, retrieval configuration, or implementation architecture
- Light mode

## Design latitude

The following are intentionally left to visual exploration:

- whether conversation history is a persistent rail, collapsible drawer, or another native pattern;
- whether source context is a rail, expandable answer region, or hybrid;
- how Jarvis's identity appears without becoming decorative or anthropomorphic;
- how much retrieval/tool activity is visible by default;
- the exact citation and source-card treatment;
- how quick ask visually transforms from palette results into an answer;
- how supporting regions collapse at narrower widths.

Prefer the simplest composition that makes conversation, scope, and trust immediately understandable.

## Success criteria

The design succeeds when:

- the first impression is “this is Jarvis,” not “this is a task manager” or “this is a notes app”;
- a user can ask from anywhere without deciding where the information is stored;
- it is always clear what context Jarvis is using;
- grounded claims can be verified without cluttering the answer;
- a quick question can become a persistent conversation without a context break;
- tasks remain useful sources but do not dominate the product hierarchy;
- the interface remains recognizably Wave.

## Deliverable

Create a desktop-first interactive design in the `wave` project, proposed as `Wave-jarvis-second-brain.dc.html`, covering the required states above. Include concise annotations for interaction behavior where a static frame would be ambiguous. Reuse the existing Wave design system and representative cockpit shell rather than redrawing the surrounding application from scratch.
