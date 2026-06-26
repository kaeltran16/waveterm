# Deferred work

Running log of intentionally-deferred features. Each entry records what was deferred, why,
where it would plug in, and how to pick it back up. Append new entries at the top.

## Files surface — deferred (v1)

- **Codex cwd via tail read:** `loadFilesForAgent` reads the transcript TAIL for cwd. Claude's
  cwd recurs on most records (resolves), but Codex's cwd is only on the first-line `session_meta`,
  so Codex resolves only for sessions short enough to fit the tail. To fix: add a head-read option
  to `GetAgentTranscriptCommand` (or a tiny dedicated command) and use it for Codex.
- **Remote worktrees:** git runs on the wavesrv (local) host. SSH/WSL agent worktrees need the
  `GitChanges`/`GitDiff` commands routed to `wsh` on that host (same impl can live on `wsh`).
- **Project picker:** the handoff's cross-project `toggleProjects` picker is a stub — Files is
  focused-agent-scoped. The left header shows the cwd basename but does not switch projects.
- **Agent-rail placeholders:** Branch + Files-touched in the Agent details rail (Phase 1b) can now
  be fed by `GitChangesCommand` + `gitstatus.ts`; wiring is a follow-on, not done here.
- **Live visual verification (CDP) deferred:** Task 9 of the plan (CDP screenshot vs the handoff)
  was deferred because a dev app was already bound to `:9222` and shares the `waveterm-dev` data
  home; do the visual pass when that port is free, focusing a real agent (mock roster resolves to
  "Not a git repository").

## Usage-bar token counts (fabricated)

- **What:** the cockpit right-rail usage bars (5-hour window / Weekly) render a `used / limit tok` line
  (handoff lines 326/331), but the figure is **fabricated** — `used = pct% × FAKE_TOKEN_LIMIT`, where the
  ceilings (2.2M / 44M) are hardcoded handoff values, not telemetry.
- **Why fabricated, not real:** `AgentUsage` (`baseds.AgentUsage`) carries no token totals — only
  `fivehourpct`, `fivehourreset`, `weekpct`, `weekreset`. The fake number makes the bar layout judgeable
  during the visual pass; it must not be read as real usage.
- **Where it plugs in:** `FAKE_TOKEN_LIMIT` + `UsageBar` in `frontend/app/view/agents/cockpitsurface.tsx`
  (marked `PLACEHOLDER`).
- **To resume:** extend `AgentUsage` (and the statusLine reporter that fills it) with per-window token
  used/limit fields, then feed real values into `UsageBar` and delete `FAKE_TOKEN_LIMIT`.
- **Deferred:** 2026-06-25, during the cockpit handoff-parity pass.

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
