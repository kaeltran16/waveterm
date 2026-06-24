# Feature Triage — Agent Cockpit Direction

> Captured 2026-06-23. Working notes for deciding which 1DevTool features to bring into Wave. Revisit later.

## Sources

- **Interactive build sheet (selectable):** https://claude.ai/code/artifact/a8eaddf4-c2b7-4d99-ab62-2a6dc0f72da9
- **Competitor feature list:** https://1devtool.com/features

## Decision so far

**Direction:** extend Wave into an agent-orchestration cockpit — do *not* build a new terminal. Wave already gives the hard, undifferentiated foundation (PTY, cross-platform rendering, layout engine, config, SSH, blocks, `wshrpc`). The only features that are both hard *and* differentiating are the AI-agent layer, and those cost the same either way.

**Thesis of the selected set:** the agent layer plus the infra that directly supports it. Skip the HTTP/DB/Design/Docker sub-apps and everything mobile/remote — that's a different product.

## Reconciliation against the current repo

The `agents` subsystem (`frontend/app/view/agents/*`) is already mature and covers more than the selection assumed.

### Drop — already built

| Selected | Where it lives | Note |
|---|---|---|
| Multi-Agent Terminals | `frontend/app/view/agents/*` | This *is* the agents subsystem. Done. |
| Real-Time Claude Usage | `agents.tsx` ProviderPlan / MiniGauge | Full: 5h + weekly, per-provider, reset timers. |
| AI Usage Dashboard | same | Covered by per-provider usage. Only a cost estimate may be missing — verify. |
| Terminal Dashboard (kanban) | agents asking/working/idle sections | Already grouped by state. Keep only if literal draggable columns are wanted. |
| Drag Files Into AI Prompt | `aipanel/aidroppedfiles.tsx` | Done for the AI panel. |
| Multi-Project Workspace | workspaces | Have. |
| Smart File Explorer | preview / file tree | Have. |
| Keyboard Shortcuts | `store/keymodel.ts` | Have. |
| Terminal Fonts | config (`term:fontfamily/size`) | Have. |

### Keep, but shrink — partial today

| Selected | Already have | What's left | Effort |
|---|---|---|---|
| AI Diff Review Panel | `view/aifilediff/` viewer (read-only) | Add accept/revert + track files across agents | H → M |
| Resume UI / Prompt History / Session Continuity | transcripts + `util/historyutil.ts` | One cross-session browse/resume/search surface (see merges) | M–L |
| VS Code File Search | `element/search.tsx` (per-view; regex/case/word) | Promote to project-wide scope + ripgrep backend | smaller M |
| Drag-Drop Paths into Terminal | AI-panel drop only | Path-insert on terminal blocks | T |
| One-Click Agent Launchers | launcher view + sidebar widgets + loom launcher | Agent buttons on the empty grid | T |
| Sub-Agent Badge & History | **Shipped in the session sidebar**: inline lifecycle tree (type + working→✓/✗), driven by `SubagentStart`/`SubagentStop` hooks | Carry it into the **cockpit**, which has *zero* subagent code today — a cockpit-centric redesign regresses it unless reproduced. Net-new on top: click-to-live-tail a child via `transcript_path` (richer than the sidebar's hook-only lifecycle) | M → H |

### Keep at full size — net-new

| Selected | Reality check | Effort |
|---|---|---|
| Channel Chat | `loom` is only a git-TUI launcher (Ctrl+G) today; coordination surface is net-new | H |
| AI Agent Orchestrator (@agent) | `1devtool-orchestrator` skill exists (external); no in-app @agent delegation | H |
| AI Memory Manager *(added post-triage)* | Absent — no memory view in the agents subsystem. Cross-project browse/search/edit of agent memory; adjacent to the Sessions & Resume cluster but a distinct surface. The interactive-graph view is the costly half. | M → H |
| Git Worktrees | Absent. Highest-leverage infra for parallel agents | M |
| Menu Bar Tray | Absent (Electron main) | M |
| Send File to Terminal | Absent (no unified send dialog) | T–M |
| Open in External Editor | Absent, but `launch-editor` already in package.json (unused) | T |
| Command Palette | Absent; realistic effort is M, not T | M |
| Jump-To-Bottom Pill | Absent | T |
| Terminal Hover Preview | Absent | T |

### Merges

- **AI Activity Logs + Unified Activity Feed** → one cross-project event feed with one-click jump. (Today only inline sidebar status dots exist.)
- **Resume UI + Prompt History + Session Continuity + (Maybe) Combine Sessions** → one "Sessions & Resume" surface, not four features.
- **AI Usage Dashboard + Real-Time Claude Usage** → already one, already done.

### Correction

- **Theme Options** was marked Have (Dark/Light/System). Wave's app chrome is **hardcoded dark** — only terminal ANSI themes are user-themeable. Light/system is **absent**. Either drop it or treat config-driven chrome theming as a real M feature — the one move that unlocks both app themes and a theme editor. The whole shell runs off ~38 CSS vars in `frontend/tailwindsetup.css` and `frontend/app/theme.scss`, so it's a contained lift.

## Net effect

"Add" pile drops from ~21 to a real backlog of ~12, plus **Agent Memory** added after the initial pass (~13). Three of the scariest are already done. The genuine heavy lifts are **Channel Chat**, the **@agent Orchestrator**, and — once its graph view is in scope — **Agent Memory**. `loom` gives the widget/launcher hook to hang the channel surface on.

## Architecture notes for later

- **New views register in** `frontend/app/block/blockregistry.ts` via `BlockRegistry.set(viewType, ViewModelClass)`. Pattern: ViewModel class (`viewType`, `viewIcon`, `viewName`, `viewComponent`) + component dir under `frontend/app/view/{name}/`.
- **Agent-status colors for the dashboard** can ride existing per-block/per-tab metadata: `frame:bordercolor`, `frame:activebordercolor`, `tab:flagcolor`, `frame:title/icon/text` — no new styling primitives needed.
- **User customization surfaces** (config files): `settings.json`, `termthemes.json`, `backgrounds.json`, `widgets.json`, `presets.json`, `connections.json`. Override precedence: block metadata > connection > settings > defaults.

## Next step

Turn the remaining ~12 into a phased plan mapped to the actual files (new views via `blockregistry.ts`; extensions inside the agents subsystem). Suggested first phase: Git Worktrees + the Activity Feed merge + the cheap polish bundle (external editor, jump-to-bottom, hover preview, terminal path-insert), since they unblock and de-friction the agent workflow before tackling Channel Chat / @agent.
