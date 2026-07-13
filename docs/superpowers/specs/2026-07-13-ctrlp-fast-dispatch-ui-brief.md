# Ctrl+P fast-dispatch — UI design brief

**Audience:** a design agent with no access to this codebase or the originating conversation. Everything you need is here. Produce a visual design (layout, states, styling notes, ideally an annotated mockup) for the change described below. The wiring is already specced; your job is how it *looks and reads*.

---

## 1. What this is

Wave Terminal's cockpit has a **command palette** — a `Ctrl+P` overlay for fuzzy-searching and jumping to things. We're extending it so you can also **launch AI-agent work by typing a goal and picking a mode**, without leaving the keyboard. Think Raycast/VS Code command palette, but the top of the list can *do work with the text you typed* instead of just navigating.

The palette is a **secondary/fast path** — there's a full composer elsewhere that's the primary launcher. This is the keyboard shortcut to the same actions. Keep it lean.

Product context: a "channel" is a workspace bound to a project. You launch agents (Claude, Codex) into the active channel to work on a goal. "Runs" are managed multi-phase agent jobs.

---

## 2. The palette as it exists today (your visual baseline — match it)

A centered modal overlay, dark cockpit aesthetic. Structure:

```
┌───────────────────────────────────────────────┐
│ 🔍  Search agents, sessions, commands…    [esc] │   ← search header (border-bottom)
├───────────────────────────────────────────────┤
│ COMMANDS                                        │   ← group label
│   Go to Channels                                │
│   Go to Sessions                                │
│   New agent                                     │
│   New project                                   │
│   Keyboard shortcuts                            │
│ AGENTS                                          │
│   fix-auth — refactor login          ⏎          │   ← selected row (accent bg)
│     myproject · working                         │      title + subtitle
│ SESSIONS                                        │
│   Add dark mode                          2h     │   ← right-aligned age hint
│     webapp · main · claude-opus                 │
└───────────────────────────────────────────────┘
```

Concrete styling already in use (reuse these tokens/sizes so the new group is seamless — all colors are `@theme` tokens, never raw hex):

- **Overlay:** width `min(640px, 93vw)`, max-height `70vh`, vertical flex.
- **Search header:** `border-b`, padding `px-4 py-[13px]`, a 15×15 magnifier glyph in `text-muted`, input at `14px` `text-primary` (placeholder `text-muted`), and a small `esc` pill on the right (`font-mono 10.5px`, `text-muted`, thin border, rounded 5px).
- **Group label:** `font-mono 10px`, `font-semibold`, `uppercase`, letter-spacing `0.1em`, `text-muted`, padding `px-4 pt-2 pb-1`.
- **Row:** full-width button, `px-4 py-[7px]`, `gap-3`, left-aligned.
  - Title: `13px`, truncates. Selected → `text-primary`; unselected → `text-secondary`.
  - Subtitle (optional): `font-mono 10.5px`, `text-muted`.
  - Right hint (optional, e.g. session age): `font-mono 10.5px`, `text-muted`.
  - **Selected row:** background `bg-accentbg`, and a small `⏎` return glyph appears at the right in `text-accent-soft` (`11px`). Hover (unselected) → `bg-surface-hover`. ~140ms color transition.
- Keyboard: ↑/↓ move a single selection across the whole flattened list (wrapping), Enter fires it, Esc closes.

---

## 3. What we're adding — a "Launch" lead group

When the user has typed a goal **and** a channel is active, a **new group appears at the very top**, above Commands/Agents/Sessions. Its label is dynamic:

```
LAUNCH IN #<channel name>
```

It contains **four action rows**. Critically, these rows are **not filtered by what you type** — the typed text is the *goal you're launching*, not a search filter. So all four always show (when the group shows at all), regardless of the query. The rows:

| Row label        | What it does                                              |
|------------------|-----------------------------------------------------------|
| **Quick · claude** | Spawn one worker on the goal, no phases. *(default-selected)* |
| **Run · pipeline** | A managed multi-phase run using the channel's strategy. The `pipeline` suffix is dynamic — it may read `Run · orchestrator`, or just `Run` before the strategy loads. |
| **Ask · claude**   | One-shot consult, no worker spawned.                       |
| **Ask · codex**    | One-shot consult against a different model, no worker.     |

Behavior that shapes the design:

- **Quick is preselected by default**, so hitting Enter right after typing a goal fires Quick. (The existing selection/`⏎` treatment applies.)
- The group **only appears** when: query is non-empty *and* a channel is active. Empty query or no active channel → palette looks exactly as today (no launch group). So this group is additive and never disrupts the default view.
- After firing any row, the palette closes and the app switches to the channels surface so the result is visible.
- The user **never types `@` or any incantation** — picking a row is the whole interaction. The goal is whatever they typed in the search box.

---

## 4. The core design problem to solve

Two *semantically different* kinds of rows now share one list:

1. **Launch rows** — *act on the text you typed* (your text is a goal → do work).
2. **Everything below** (Commands/Agents/Sessions) — *navigate/filter* (your text is a search query).

A user typing `fix the login race condition` should instantly understand that the top rows will **launch that as a goal**, while the rows below are just filtered navigation. Right now nothing distinguishes them but the group label. **Make the distinction obvious and calm** — not loud, but unmistakable.

Open questions for you to design (these are latitude, not requirements):

- **How to signal "this launches your text as a goal."** Options: echo the trimmed goal into each row (e.g. `Quick · claude → "fix the login race condition"`), a per-mode verb/icon, a subtle accent treatment on the whole group, a one-line footer describing what the selected row will do (the composer uses a footer like `→ pipeline run in <project>`). Pick what reads cleanest.
- **Per-mode affordance:** should each mode have a glyph/icon (Quick ⚡, Run ▸▸, Ask ?) or a subtitle explaining it? Keep it legible at `13px` in a dense list.
- **The dynamic `Run` label:** design the loaded state (`Run · pipeline` / `Run · orchestrator`) and the not-yet-loaded state (plain `Run`). Avoid layout shift when the suffix appears.
- **Search header placeholder:** today it says `Search agents, sessions, commands…`. Consider whether it should hint at launching (e.g. when a channel is active) — or stay as-is. Your call; note the tradeoff.
- **Empty/edge states:** what the palette shows when there's a channel but no query (unchanged), and when there's a query but no active channel (no launch group — is any hint warranted, or stay silent? spec leans silent).

## 5. Constraints

- **Match the existing overlay** in §2 — same width, header, group-label style, row metrics, selection treatment. This is one new group inside the current palette, not a redesign of it.
- **Colors via `@theme` tokens only** (`text-primary`, `text-secondary`, `text-muted`, `bg-accentbg`, `text-accent-soft`, `bg-surface-hover`, `border`, `border-edge-mid`, …). No raw hex/rgba. If you need a new token, name it and say why.
- Dark cockpit aesthetic; keyboard-first; dense but breathable. Respect reduced-motion.
- Don't redesign Commands/Agents/Sessions — they stay as-is beneath the launch group.

## 6. Deliverable

An annotated mockup (or a tight visual spec) covering: the launch group in place above the existing groups, the default-selected Quick row, the four rows with your chosen mode affordance, the dynamic Run-label states, and how a launch row reads differently from a navigation row. Note anything you changed from the baseline and why.
