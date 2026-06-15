# Wave Agent Sessions — Design Spec

**Working title:** Wave Agent Sessions (rename freely)
**Date:** 2026-06-12
**Status:** Design approved (brainstorm complete); spike pending
**Base:** Fork of [wavetermdev/waveterm](https://github.com/wavetermdev/waveterm) (Apache-2.0), cloned at `C:\Users\kael02\IdeaProjects\waveterm`
**File references** below point at the upstream clone and were verified by source inspection on 2026-06-12.

## 1. What this is

A fork of Wave Terminal that replaces the tab bar with a **vertical session sidebar** purpose-built for driving many coding-agent CLIs (Claude Code, Codex) at once. Sessions are auto-grouped by the service they run in, show **live per-session status** (working / waiting-for-you / done), and a pinned group keeps the few you're actively driving on top.

It is **not** a new terminal. It reuses Wave's PTY handling, block tiling, persistence, SSH, and theming. The fork's net-new surface is one React sidebar component, one `wsh` subcommand, and one small backend RPC. Everything else is reuse.

## 2. Goal & non-goals

**Goal:** a cohesive redesign where session organization (grouping + pinning) and per-session status are first-class, so a user running 5–15 agent sessions across a microservice monorepo can see at a glance which agent needs them and switch instantly.

**Non-goals (v1):**
- Search over sessions (deferred — YAGNI; structure + pinning + keyboard nav cover switching).
- A custom main-area layout engine (reuse Wave's existing block tiling).
- Manual/custom session groups (auto-grouping only in v1).
- Replacing Wave AI or any other Wave feature.

## 3. Key decisions (and why)

| Decision | Choice | Rationale |
|---|---|---|
| Build strategy | Disciplined **fork** of Wave's frontend | Only option that delivers the cohesive redesign; greenfield would re-implement Wave's mature terminal/PTY/persistence; stock Wave can't replace the tab-bar UI. |
| Sidebar insertion | Replace `<VTabBar>` at `frontend/app/workspace/workspace.tsx:135` | Wave already mounts a vertical bar there behind `app:tabbar === "left"`; exact, known seam. |
| Session unit | One Wave **tab** = one session (default: a single terminal block) | Tabs are already first-class `WaveObj`s with metadata + ordering; reuse their store and RPCs. |
| Organization | Auto **service** groups + **Pinned** group, collapsible, no search | User-validated model (hybrid). Search deferred. |
| Row density | **Informative** rows (agent + service + status dot + activity line) | User-selected; the activity line is sourceable (see §6). |
| "Needs you" semantics | **Amber = actively blocked only** (permission/idle prompt); finished turn = grey "done · your move" | Keeps amber meaningful; validated. |
| Grouping key | **Nearest marker-file dir** (walk up from cwd), not git root | Repo is a monorepo — git root collapses all services into one group. Verified against the real repo (§5). |
| Status mechanism | Agent's own **hooks → reporter script → `wsh`** | Lowest-risk, highest-fidelity; the agent knows its own state. PTY-activity heuristic is a documented fallback only. |
| Status rollout | **Spike first** (`wsh badge`), then custom `wsh agentstatus` event | Proves the riskiest loop for ~zero cost; ~90% of the spike carries forward. |
| Main area | **Unchanged** — single terminal default + Wave's tiling | Diff/dual-agent views are existing block arrangements, not new code. |

## 4. Architecture — where it plugs into Wave

```
┌─ SessionSidebar (NEW React component) ─────────────┐
│  reads atoms.workspace.tabids (reactive)           │
│  + useWaveObjectValue<Tab>(tab) per tab            │
│  + block.meta["cmd:cwd"] -> service group (RPC)    │
│  + agent:status event -> status dot + detail line  │
│  renders: Pinned group, service groups, B-rows     │
└───────▲─────────────────────────────────┬──────────┘
        │ Jotai atoms / waveobj:update      │ EventSub("agent:status")
        │                                   ▼
┌───────┴───────────────────────────────────────────┐
│  Wave backend (mostly stock)                       │
│  + wsh agentstatus  (NEW ~20-line subcommand)      │
│  + Event_AgentStatus (NEW broker event)            │
│  + GetSessionGroup(cwd) RPC (NEW marker walk-up)   │
└───────▲────────────────────────────────────────────┘
        │ wsh agentstatus --state … --detail …
┌───────┴───────────────────────────────────────────┐
│  Reporter script (NEW) — runs as an agent hook     │
│  reads stdin JSON + $WAVETERM_BLOCKID, maps        │
│  event -> {state, detail}, calls wsh               │
└────────────────────────────────────────────────────┘
```

**Reuse map (no new code):**

| Need | Reused Wave primitive | Location |
|---|---|---|
| Tab list, reactive | `atoms.workspace` → `tabids` | `frontend/app/store/global-atoms.ts:50` |
| Per-tab object | `useWaveObjectValue<Tab>(makeORef("tab", id))` | `frontend/app/store/wos.ts:251` |
| Tab metadata read/write | `getOrefMetaKeyAtom` / `RpcApi.SetMetaCommand` | `global.ts:139`, `wshclientapi.ts:856` |
| Status dot rendering | `TabBadges` + `getTabBadgeAtom` | `frontend/app/tab/tabbadges.tsx`, `badge.ts:116` |
| Reorder / rename / activate | existing `UpdateWorkspaceTabIdsCommand`, `UpdateTabNameCommand` | `vtabbar.tsx:315,379` |
| Terminal cwd | `block.meta["cmd:cwd"]` (OSC 7) | `frontend/app/view/term/osc-handlers.ts:264` |
| Per-session id (env) | `WAVETERM_BLOCKID` (already injected) | `pkg/blockcontroller/blockcontroller.go:459` |
| Event bus | `wps.Broker.Publish` → `EventSubCommand` | `pkg/wps/wps.go`, `pkg/web/ws.go` |
| `wsh` IPC entry | `wsh` connects via `WAVETERM_JWT`; `EventPublishCommand` | `cmd/wsh/cmd/wshcmd-root.go:153` |

## 5. Service grouping

Each tab's working directory lives on its terminal block as `block.meta["cmd:cwd"]` (set via OSC 7 shell integration; reactive). The group is **not** the git root — the SIEM repo is a monorepo (single `.git`, no nested repos), so git-root grouping collapses every service into one group.

**Rule — nearest service root:** walk *up* from the terminal's cwd until a marker file is found; the group = that directory.
- **Markers (priority order):** `pom.xml` (this repo is Java/Maven), then generic: `go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `build.gradle`, `Dockerfile`.
- **Fallback chain:** nearest marker → git root → raw cwd.
- **Label = marker dir name.** Edge fallback: if that name matches a version pattern (`v\d+`, `version-*`), use the **parent** dir name (real case: `CYbersecurity/version-1.1/pom.xml` → label `CYbersecurity`, not `version-1.1`).

**Verified against the real repo:** `src/<Service>/pom.xml` layout with 60+ Maven modules (`CorrelationEngine`, `KafkaToSolr`, `ActionDeduplicator`, dozens of `Parser_*`). Walk-up from any cwd inside a service normalizes to that service.

**Implementation:** a small cached backend RPC `GetSessionGroup(cwd) → { root, label }` (the walk-up + marker check, results cached per cwd). Keeps the "auto, zero upkeep" property.

**Caveats stated in the design:**
- Requires shell integration active for accurate cwd; without it, cwd falls back to launch dir.
- Nested Maven multi-module submodules could make "nearest pom" land on a submodule — rare in this repo's flat `src/*` layout; rule is "nearest marker," accepted.
- Service names get long (`Parser_microsoft_activedirectoryandwindows_2011_1r7`) → the sidebar **must truncate group/row labels with ellipsis + full name on hover**.

## 6. The session sidebar (UI spec)

**Structure (top → bottom):**
1. **Pinned** group (★) — sessions the user is actively driving; `meta["session:pinned"] === true`. Sits above all service groups.
2. **Service groups** — one collapsible group per service that has ≥1 session, label per §5, with a session count. Collapsed groups (`▸`) show an **aggregate status dot** = highest-priority status among hidden sessions (amber > green > grey), so a blocked session still surfaces when collapsed.

**Row (Informative / "B"):**
- Status **dot** (left): green = working, amber = waiting/blocked, grey = idle/done.
- **Primary line:** agent name (+ service when in Pinned, since the group no longer implies it), e.g. `claude · CorrelationEngine`.
- **Secondary line (detail):** the activity string, e.g. `editing CorrelationEngine.java`, `running tests`, `approve edit to runner.go?`, `done · your move`, `idle · 12m`.
- **Active session:** blue left-accent + tint.
- **Blocked session:** amber left-accent + tint (the only thing that turns a row amber).

**Agent identity** (`claude` vs `codex`): set in `meta["session:agent"]` when the fork launches a typed session; the reporter's event also carries it as a cross-check.

**Custom tab-meta keys** (stored on the open `meta` JSON map via `SetMetaCommand`; durable across restart):
- `session:pinned` (bool), `session:agent` (string). v1 may write via `meta as any`; durable typing = add to Go `MetaTSType` + regenerate `gotypes.d.ts` (a later cleanup, not a blocker).

**Data flow (all client-side, reactive):** `atoms.workspace.tabids` → per tab `useWaveObjectValue<Tab>` (name, meta, blockids) → terminal block `cmd:cwd` → `GetSessionGroup` → group; status dot + detail from the `agent:status` event keyed by block id. Idle duration ("12m") rendered from the last event timestamp via a 1/min re-render tick.

## 7. Status system

**Mechanism:** the agent reports its own state through its hook system. A single **reporter script** is the hook command for both agents:
1. Agent hook pipes event JSON to the reporter on stdin.
2. Reporter reads `$WAVETERM_BLOCKID` from the inherited session env.
3. Reporter maps event → `{ state, detail }` and calls `wsh` scoped to that block.
4. Sidebar subscribes to the event and renders.

**Claude Code event → state mapping (verified against the hooks docs):**

| State | Hook event + condition | Field used |
|---|---|---|
| working | `UserPromptSubmit` (enter working) | — |
| working + detail "editing X" | `PreToolUse`, `tool_name == "Edit"/"Write"` | `tool_input.file_path` |
| working + detail "running tests" | `PreToolUse`, `tool_name == "Bash"` | `tool_input.command` (mapped, e.g. `mvn test`/`go test` → "running tests"; else truncated cmd) |
| **waiting (amber)** | `Notification`, `notification_type ∈ {permission_prompt, idle_prompt}` (and/or `PermissionRequest`) | `message` |
| idle/done (grey) | `Stop` | `stop_reason` |

Working-detail is **sticky** between tool calls (shows last action during LLM thinking) — accepted. Hook config lives in `.claude/settings.json`; hooks may be `"async": true` to never block the agent.

**Codex:** has a parallel `[hooks]` system (`PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `UserPromptSubmit`) plus a `notify` program, so the same reporter applies. **To verify during implementation:** exact Codex payload field names (assumed parallel to Claude Code), and the one-time **hook-trust** step (`--dangerously-bypass-hook-trust` for unattended trust).

**Rollout (spike first):**
- **Phase 0 — spike (zero fork):** `.claude/settings.json` hooks → reporter → existing `wsh badge` (icon only). Proves: hooks fire live, `WAVETERM_BLOCKID` correlation holds, Codex hook-trust works, the loop feels legible. Validates the *state loop*, not the detail line.
- **Promotion:** swap the reporter's sink from `wsh badge` to a new `wsh agentstatus --state … --detail … --agent …` that publishes `Event_AgentStatus` (scoped to the block ORef). ~3 shallow files, mirroring `cmd/wsh/cmd/wshcmd-badge.go`.

**Fallback (documented, secondary):** PTY-activity heuristic at the output chokepoint `HandleAppendBlockFile` (`pkg/blockcontroller/blockcontroller.go:369`) for tools that can't run hooks. Noisy (can't tell "thinking" from "idle"); not used for hook-capable agents.

## 8. Main area

Unchanged from stock Wave. Selecting a session opens its single terminal block full-pane. "Terminal + diff" and "dual agents" are existing Wave block arrangements available on demand via tiling — no new code. A thin convenience keybinding to split in a diff view for the active session's cwd may be added in polish.

## 9. Phasing

- **Phase 0 — Status spike.** Hooks + reporter + `wsh badge`. Decision gate: does live per-session status feel right? (If no, rethink before any fork code.)
- **Phase 1 — Sidebar.** `SessionSidebar` replacing `VTabBar`: Pinned + service groups + B-rows, reusing `TabBadges` for dots. Grouping by `cmd:cwd` directly at first (before the RPC). Active/blocked accents, collapse, aggregate dots.
- **Phase 2 — Real status + grouping.** `wsh agentstatus` + `Event_AgentStatus` + reporter promotion (detail line); `GetSessionGroup` marker-walk-up RPC with label heuristic.
- **Phase 3 — Polish.** Persisted collapse state, keyboard quick-switch/cycle, long-name truncation + hover, typed meta keys, optional diff-split keybinding.

## 10. Fork hygiene

Keep changes **additive** (new files) over edits, to minimize upstream rebase pain. Edits to existing files are limited to: `workspace.tsx:135` (swap component), a few registrations (new `wsh` subcommand, new event constant, new RPC, optional new config key + `SettingsType` field). Track upstream `main`; rebase the small diff periodically. Own the build/sign/release pipeline.

## 11. Testing

- **Grouping & view-model = pure functions**, unit-tested with no running Wave: `(tabs, cwd→group, meta) → grouped view model`; the marker walk-up + version-dir label fallback (table-driven, incl. the `version-1.1` case); aggregate-dot priority.
- **Reporter mapping = pure function:** event JSON → `{state, detail}`; table-driven over Claude Code (and Codex) payloads incl. the `mvn test → "running tests"` mapping.
- **`wsh agentstatus`** tested like existing `wsh` subcommands.
- Sidebar component: render-level checks that status atoms drive the right dot/accent.

## 12. Open questions / to verify

- **Codex payloads & hook-trust** — confirm field names and the trust step in Phase 0.
- **Durable meta typing** — when to promote `session:pinned`/`session:agent` from `meta as any` to typed `MetaTSType` keys (cosmetic; pick during Phase 1).
- **GitHub fork setup** — create the user's fork remote and rebase strategy before Phase 1 lands code.
- **Project name** — replace the "Wave Agent Sessions" working title.
- **macOS left-tab special case** — `workspace.tsx:112` suppresses the horizontal bar differently on macOS in left mode; confirm the sidebar swap handles window-drag chrome on the target OS (Windows is primary).
