# Projects Registry + New Agent Launcher — Design

**Date:** 2026-06-26
**Status:** Draft (awaiting review)
**Design source of truth:** `wave-handoff/wave/project/Wave-cockpit-live.dc.html` (the updated handoff). Relevant regions: New Agent modal `newAgentOpen` (~L1068-1126), New Project modal `newProjectOpen` (~L1136-1153), the `+ New project` switcher footer (~L61), and the `Component` script handlers (`createProject`, `naProjects`, `naRuntimes`, `naStartup`, `naLaunchLabel`, `naShowTask` ~L2213-2293).

## 1. Overview

Turn the cockpit's `+ New agent` button into a real, end-to-end launcher backed by a real **Projects** concept.

The complete loop: **add a project** (register an existing local folder) → click **New agent** → pick that project + a runtime + a task → an agent process actually starts in that directory (optionally in a fresh git worktree) → it appears in the roster, filterable under that project.

Today the `+ New agent` button (`frontend/app/cockpit/app-bar.tsx:58`) calls `newAgentSession` (`frontend/app/cockpit/cockpit-actions.ts`), which spawns a bare `claude` terminal full-pane with no directory, task, or project. There is no notion of a project beyond a derived label (`AgentVM.project`). This feature replaces that with a designed modal flow and a durable registry.

## 2. Goals / Non-goals

**Goals**
- A durable, user-managed projects registry: name → local path.
- A **New Project** modal (Name + Local path) that validates the path and writes the registry.
- The project switcher lists real registered projects (merged with live-derived ones) and gains the `+ New project` entry point.
- A **New Agent** modal matching the handoff: runtime (Claude Code / Codex / Antigravity / Terminal), project, task, startup command, worktree branch.
- A real launch: start the chosen runtime in the chosen project directory with the task as its initial prompt; the new session joins the roster.
- Optional git worktree creation on launch (the agent runs in the worktree).

**Non-goals**
- Cloning from a git remote (explicitly rejected — register existing folders only).
- Removing/cleaning up worktrees (we only *create* on launch).
- A projects-management surface beyond add + switch (no rename/delete UI this pass).
- Wiring the other handoff surfaces that happen to read projects (channels, files, memory scopes). They may consume the new registry later; this spec only touches the switcher and the two modals.

## 3. Architecture

Three layers, each mirroring an existing Wave pattern so there is minimal novel infrastructure.

### 3.1 Projects registry (Go config)

Mirror `connections.json` exactly (`pkg/wconfig/settingsconfig.go`):

- `const ProjectsFile = "projects.json"`.
- `type ProjectKeywords struct { Path string \`json:"path"\` }` (room to grow; only `path` for now).
- `FullConfigType.Projects map[string]ProjectKeywords \`json:"projects"\``.
- `ReadFullConfig()` reads `projects.json` into `.Projects` (parallel to how it reads connections).
- `SetProjectConfigValue(name string, toMerge waveobj.MetaMapType) error` mirroring `SetConnectionsConfigValue` (read file → merge entry → `WriteWaveHomeConfigFile(ProjectsFile, m)` under `configWriteLock`).
- Schema generation picks up the new file (`cmd/generateschema`).

The config filewatcher already pushes the full config to the frontend on change, so a registry write propagates live with no extra wiring.

### 3.2 RPC

Two new typed wshrpc commands (`pkg/wshrpc/wshrpctypes.go` interface + types; implemented in `pkg/wshrpc/wshserver/wshserver.go`; bindings via `task generate`):

1. `CreateProjectCommand{ Name string; Path string }`
   - Validates: `Name` non-empty (trimmed); `Path` non-empty, expanded (`~`), exists, and is a directory. On failure returns a typed error.
   - On success calls `SetProjectConfigValue(name, {path})`.
2. `CreateWorktreeCommand{ ProjectPath string; Branch string } -> { WorktreePath string }` (Phase 3)
   - Shells out to `git worktree add` (see §6).

A new package `pkg/gitinfo` (does not exist yet) houses the git worktree helper. It is the first git shell-out in the backend; keep it minimal (`os/exec` to `git`, parse exit/stderr into typed errors).

### 3.3 Frontend

- `projectsAtom` derived from `fullConfigAtom.projects` (in `frontend/app/store/global-atoms.ts`, beside `settingsAtom`). This is the single source of truth for registered projects.
- A small pure helper module (e.g. `frontend/app/view/agents/projectsstore.ts` + tests) with:
  - `mergedProjects(registry, agents)` → switcher list (registry ∪ distinct live `AgentVM.project`).
  - `launchableProjects(registry)` → New Agent chips (registry only; these have real paths).
  - `buildLaunchBlock({ runtime, startupCommand, task, cwd })` → the `CreateBlock` meta object (pure; unit-tested).
  - `runtimeStartupCommand(runtime)` and `runtimeLaunchLabel(runtime)` mirroring the handoff derivations.
- Two modal components under `frontend/app/view/agents/`: `newprojectmodal.tsx`, `newagentmodal.tsx`. Rendered from the cockpit shell, gated by atoms.
- New orchestration atoms on `AgentsViewModel` (`agents.tsx`): `newAgentOpenAtom`, `newProjectOpenAtom`, `naRuntimeAtom`, `naProjectAtom`, `naTaskAtom`, `naStartupAtom`, `naBranchAtom`, plus New Project form atoms (`npNameAtom`, `npPathAtom`, `npErrorAtom`).
- `projectswitcher.tsx`: list = `mergedProjects(...)`; add the `+ New project` footer that opens the New Project modal.
- `app-bar.tsx`: the `+ New agent` button opens the New Agent modal (replaces the direct `newAgentSession` call).

**Styling:** build the modals in Tailwind using the existing cockpit `@theme` tokens (as `app-bar.tsx` does — `bg-surface-raised`, `border-edge-mid`, `text-primary`, `bg-accent`, etc.). Translate the handoff's raw hex to tokens; **no raw hex/rgba in className/style, no new SCSS** (project conventions). Match the handoff layout and spacing.

## 4. Data model

`projects.json` (under the Wave config home):

```json
{
  "payments-api": { "path": "/Users/kael/code/payments-api" },
  "web-dashboard": { "path": "/Users/kael/code/web-dashboard" }
}
```

- **Key** = project name (display label, unique).
- **path** = absolute local directory (validated to exist on create).

`AgentVM.project` (a derived label, unchanged) is used only to *merge* live agents into the switcher list. Launch targets always come from the registry, which has paths.

## 5. The two modals

### 5.1 New Project (register existing folder)

| Field | Behavior |
|---|---|
| **Name** | Required. Trim; Create disabled until non-empty (handoff: `createBtn*` gates on `npName.trim().length > 0`). |
| **Local path** | Required for us (the handoff mockup discards it; we need it). Placeholder `~/code/my-service`. `~` expanded server-side. |

- **Trigger:** `+ New project` footer in the switcher dropdown.
- **Create** → `CreateProjectCommand{ name, path }`. On the typed error (missing/!dir path, duplicate name) show an inline error under the offending field; keep the modal open. On success: close, clear fields, set the switcher filter to the new project.
- **Esc / backdrop / Cancel** close and clear.

> Deviation from the handoff mockup: the mockup's `createProject` stores only the name in an in-memory `extraProjects` array and discards the path. We store name → path durably and require a valid path. This is the intended real behavior; the mockup is a visual stand-in.

### 5.2 New Agent (unified launcher)

| Field | Behavior |
|---|---|
| **Runtime** | 4 cards: `claude` (Claude Code, ✳), `codex` (Codex, `{ }`), `antigravity` (Antigravity, ◭), `terminal` (Terminal, `›_`). Default `claude`. |
| **Project** | Chips from `launchableProjects(registry)`. Selecting sets the launch `cwd`. If the registry is empty, show an empty-state nudging `+ New project`. |
| **Task** | Textarea. **Shown only when runtime ≠ terminal** (`naShowTask`). Becomes the agent's initial prompt. |
| **Startup command** | Mono input, defaults to the runtime command (`claude`/`codex`/`antigravity`; empty for terminal, placeholder `bash`). Editable; overrides the command actually run. |
| **Worktree branch** | Input prefilled `feat/new-agent`. Phase 3 wires it; Phase 1–2 render it (see §6 / §9). |

- **Footer:** `Starting in {project}`; Cancel; primary button labeled **Launch agent** (or **Open terminal** when runtime = terminal).
- **Trigger:** app-bar `+ New agent` button and ⌘N.
- The existing `openTerminal(agentId)` / `t`-key behavior (open an *existing* agent's terminal) is unrelated and unchanged.

## 6. Launch flow

`launchAgent` (replaces the stub) builds a block via `ObjectService.CreateBlock` — **no new Go for the core launch**, since term blocks honor `cmd:cwd`, `cmd:args`, `cmd:shell` (`pkg/waveobj/metaconsts.go:52-57`, `shellcontroller.go:405`, `durableshellcontroller.go:236`).

Resolve `cwd`:
- **Phase 2 (no worktree):** `cwd = registry[project].path`.
- **Phase 3 (worktree):** call `CreateWorktreeCommand{ projectPath: registry[project].path, branch }`; `cwd =` returned worktree path. On worktree error, surface inline and do not launch.

Build the block meta (`buildLaunchBlock`, pure + tested):
- **Agent runtimes** (`claude`/`codex`/`antigravity`): `{ view: "term", controller: "cmd", "cmd": <startupCommand>, "cmd:cwd": <cwd>, "cmd:args": [<task>], "cmd:shell": false }` when a task is present. The task is passed as a **single positional argument** (`claude "do X"` starts interactive with that prompt). Startup commands are tokenized on spaces best-effort if customized with flags (noted limitation).
- **Terminal runtime:** a default shell block `{ view: "term", controller: "shell", "cmd:cwd": <cwd> }` — no task, no cmd.

Then set `terminalTargetAtom` to the new block id and route `surfaceAtom` to `"agent"` (same mechanism `newAgentSession` uses today). The new `claude`/`codex` session, running with the Wave env, is picked up by the external reporter and joins the roster automatically.

`newAgentSession` is refactored: its body becomes the `terminal` runtime path of `buildLaunchBlock` + route. The app-bar no longer calls it directly; the modal's `launchAgent` does.

## 7. Worktree (Phase 3)

`pkg/gitinfo.CreateWorktree(projectPath, branch) (worktreePath string, err error)`:

- **Location (sibling dir):** `<dirname(projectPath)>/<basename(projectPath)>-worktrees/<flatten(branch)>`, where `flatten` replaces `/` with `-` (e.g. `feat/new-agent` → `feat-new-agent`). Pure path derivation is unit-tested.
- **Base ref:** current HEAD of the project repo (`git worktree add` defaults to HEAD).
- **Branch / worktree existence:**
  - target worktree dir already exists → reuse it (return its path);
  - branch exists but has no worktree → `git -C <project> worktree add <wtPath> <branch>`;
  - otherwise → `git -C <project> worktree add <wtPath> -b <branch>` (off HEAD).
- **Errors:** not a git repo, path collision with a non-worktree dir, git failure → typed error, surfaced inline in the modal; launch aborts.
- **Out of scope:** removing worktrees, choosing a non-default base, dirty-tree handling beyond what git itself rejects.

## 8. Error handling

- **Config write** is serialized by the existing `configWriteLock`; surface write failures as a typed RPC error.
- **CreateProjectCommand:** validation failures (empty/non-existent/non-dir path, duplicate name) → typed errors → inline modal errors. Never write a partial/invalid entry.
- **CreateWorktreeCommand:** non-repo / git failures → typed errors → inline; no block created.
- **CreateBlock failure:** surface in the modal; keep it open.
- All boundary errors carry a human-readable message; nothing is silently swallowed.

## 9. Placeholders / deferred

- **Worktree branch field in Phases 1–2:** rendered for visual fidelity but inert (launch uses the project path). Logged in `docs/deferred.md` until Phase 3 lands. (Per the project convention of rendering designed-but-unbacked fields rather than omitting them.)
- **Codex / Antigravity runtimes:** selectable and launch their command, but those binaries may not be installed; a missing binary surfaces as a normal terminal error. No availability detection this pass.

## 10. Testing

- **Go unit:** `SetProjectConfigValue` round-trip (read/merge/write to a temp config dir); `CreateProjectCommand` validation (missing/non-dir/dup); worktree path derivation (`flatten` + sibling layout); worktree branch logic against a temp git repo (new branch, existing branch, existing worktree).
- **Frontend unit (vitest, following `projectname.test.ts` / `agentsviewmodel.test.ts`):** `mergedProjects` (registry ∪ live, dedup), `launchableProjects`, `runtimeStartupCommand`/`runtimeLaunchLabel`, `buildLaunchBlock` (agent vs terminal; task present/absent; cwd wiring), New Project form validation.
- **Visual (dev):** CDP screenshots (`scripts/cdp-shot.mjs`, `:9222`) of both modals and the switcher footer; verify the full loop end-to-end in `task dev`.

## 11. Phasing (for the plan)

- **Phase 1 — Projects foundation:** Go config (`projects.json`, `FullConfigType.Projects`, `SetProjectConfigValue`) + `CreateProjectCommand` + `task generate`; `projectsAtom`; New Project modal; switcher `+ New project` footer + merged list. Deliverable: add-a-project works and shows in the switcher.
- **Phase 2 — New Agent launcher (closes the loop):** New Agent modal + `buildLaunchBlock` + `launchAgent` launching into the project path; app-bar/⌘N open the modal; `newAgentSession` refactor. Deliverable: add project → launch agent in its dir → roster.
- **Phase 3 — Worktree:** `pkg/gitinfo` + `CreateWorktreeCommand` + wire the branch field so launch runs in a sibling worktree off HEAD.

## 12. File inventory

**Backend**
- `pkg/wconfig/settingsconfig.go` — `ProjectsFile`, `ProjectKeywords`, `FullConfigType.Projects`, `ReadFullConfig`, `SetProjectConfigValue`.
- `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshserver/wshserver.go` — `CreateProjectCommand`, `CreateWorktreeCommand`.
- `pkg/gitinfo/` (new) — `CreateWorktree`.
- generated: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `schema/` (via `task generate`).

**Frontend**
- `frontend/app/store/global-atoms.ts` — `projectsAtom`.
- `frontend/app/view/agents/projectsstore.ts` (new, + test) — pure helpers.
- `frontend/app/view/agents/newprojectmodal.tsx`, `newagentmodal.tsx` (new).
- `frontend/app/view/agents/agents.tsx` — orchestration atoms.
- `frontend/app/view/agents/projectswitcher.tsx` — merged list + footer.
- `frontend/app/view/agents/cockpitshell.tsx` (or shell) — render the modals.
- `frontend/app/cockpit/app-bar.tsx` — button opens the modal.
- `frontend/app/cockpit/cockpit-actions.ts` — `launchAgent` builder; `newAgentSession` refactor.
- `docs/deferred.md` — worktree-field placeholder note (until Phase 3).

## 13. Open questions

None outstanding — all design decisions resolved during brainstorming (register-existing-folder; `projects.json` storage; registry-backed launchable chips; task-as-positional-prompt; worktree as Phase 3, sibling dir, base = current HEAD).
