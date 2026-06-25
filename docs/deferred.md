# Deferred work

Running log of intentionally-deferred features. Each entry records what was deferred, why,
where it would plug in, and how to pick it back up. Append new entries at the top.

## Agent (Focus) surface placeholders (Phase 1b)

- **What:** the Agent 3-pane focus surface (`frontend/app/view/agents/agentsurface.tsx` +
  `agenttree.tsx` / `agenttranscript.tsx` / `agentdetailsrail.tsx`) renders to full handoff
  parity, but several fields/actions have no backing data and ship as marked placeholders /
  disabled affordances:
  - **git Branch** — left-tree parent subtitle + Details "Branch" row (static `main`).
  - **Files touched + per-file git status (M / + / −)** — static placeholder list in the rail.
  - **Tokens (total)** — the Details "Tokens" row derives input tokens from context
    (`contextpct × contextmax`); there is no cumulative total-token figure.
  - **Pause / Resume / Stop** — rendered disabled ("coming soon"); `Open terminal` is the only
    live lifecycle action.
  - **Suggestion chips** — footer chips above the composer are static/disabled (no generator).
- **Why deferred:** Phase 1 is "≈ no new backend" (meta-spec §8) — 1b is a pure
  view-composition pass. Git branch/status and an agent-lifecycle control RPC are backend work;
  a suggestion generator is its own feature. The user chose render-everything (placeholders +
  disabled) over omission, for handoff visual parity.
- **Where it plugs in:** git Branch + Files-touched arrive with the **P2 Files** surface (it
  needs git anyway); Pause/Resume/Stop need a lifecycle control RPC (P2/P3); Tokens-total needs
  a usage extension; suggestion chips need a generator. Each placeholder carries a
  `PLACEHOLDER`/`DISABLED` code comment pointing at spec §8.
- **To resume:** when building P2 Files, add a git-worktree info source (branch + per-file
  status) and feed the tree subtitle + Details "Branch" + the Files-touched list; for lifecycle,
  add a control RPC and enable the disabled buttons; replace the static suggestions with a
  real generator. Full detail:
  `docs/superpowers/specs/2026-06-25-cockpit-phase1b-agent-surface-design.md` §8.
- **Deferred:** 2026-06-25, during the cockpit Phase 1b Agent-surface build.

## Command palette (⌘K)

- **What:** the centered search box in the cockpit top app bar — `Search agents, sessions,
  commands…` with a `⌘K` hint badge. Shipped as a **render-only stub**: the box is drawn to
  match the handoff, but clicking it / pressing `Ctrl+K` does nothing.
- **Why deferred:** no palette component exists anywhere in the codebase (grepped — it only
  appears in the handoff mockup). A real searchable command overlay (fuzzy match over
  agents/sessions/commands, keyboard nav, action dispatch) is its own feature, separate from
  the handoff-parity visual pass.
- **Where it plugs in:** the app-bar stub button in `frontend/app/cockpit/` (see the
  cockpit handoff-parity spec). The no-op `onClick` and a global `Ctrl+K` chord would open the
  overlay.
- **To resume:** build a palette overlay (cmdk-style), wire the stub button's `onClick` plus a
  `Ctrl+K` keybinding to open it, and feed it the roster (`model.agentsAtom`), sessions, and a
  command registry.
- **Deferred:** 2026-06-25, during the cockpit handoff-parity pass.
