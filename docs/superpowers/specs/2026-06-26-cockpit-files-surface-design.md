# Files Surface — Design Spec (Phase 2)

> Captured 2026-06-26. A **Phase 2** surface of the agent-cockpit redesign, sibling to the
> [Activity surface](./2026-06-26-cockpit-activity-surface-design.md). Reads on top of
> [`redesign-meta-spec.md`](../../redesign-meta-spec.md) (§4 surface inventory, §6 data
> flow, §9 open questions). Source of truth for the visual:
> `wave-handoff/wave/project/Wave-cockpit-live.dc.html:733-804` (the `isFiles` block).

## 1. Goal

Build the **Files** surface: a **read-only, glance-able view of what the focused agent has
changed** in its worktree — a changed-file list (per-file git status), the branch and net
`+adds −dels`, and a per-file diff (or plain view for new files). It replaces the
`PlaceholderSurface` branch for `surface === "files"` in `cockpitshell.tsx`.

Purpose is **triage, not browsing**: "what did this agent touch, and what does the change
look like?" — answered without leaving the cockpit and without a writable editor.

## 2. The governing principle: changed-files-only, focused-agent-scoped

Two scope decisions resolve most questions in this spec:

- **Scoped to the focused agent's worktree.** Files binds to `focusIdAtom` (the same agent
  identity the Agent surface uses). There is no cross-project picker in v1 — the handoff's
  `toggleProjects` control renders as a deferred stub. Reaching Files means "I'm looking at
  *this* agent; show me its changes."
- **Lists only changed files.** The left pane is exactly what `git status` reports
  (modified / added / deleted / untracked), not a full recursive project tree. This is the
  triage need, and it sidesteps gitignore handling, lazy folder loading, and arbitrary file
  reads entirely. Unchanged files/folders from the mockup are out of v1.

Consequence: the data need is small and precise — one status query + one diff-per-clicked-file.

## 3. Data source (decision: transcript for cwd, git for branch + changes)

**cwd** is the one need read before git — straight from the persisted transcript, reusing
the existing one-read pattern (`liveagents.ts` `fetchPreviousInfo` →
`GetAgentTranscriptCommand`) — because we must know *where* to run git. Branch, the changed
files, and the diff all come from the two new git commands (branch is near-free, folded into
RPC #1):

| Need | Source |
|---|---|
| **cwd** (where to run git) | transcript records carry `"cwd"` (Claude, per-record, verified on disk); Codex `session_meta.payload.cwd` — **zero git** |
| **branch** (header) | git `rev-parse --abbrev-ref HEAD`, folded into **RPC #1** (authoritative — the transcript's `gitBranch` can be stale if the agent switched branches); transcript `gitBranch` is an optional display fallback when git is unavailable |
| **changed files** (status glyph + adds/dels) | **new git RPC #1** — `git status --porcelain` + `git diff --numstat` |
| **one file's diff** (on click) | **new git RPC #2** — `git diff -- <path>`; untracked → plain content |

Rationale for git over alternatives (meta-spec §9): there is **no existing git RPC** in the
codebase (verified — `pkg` grep finds only an unrelated `cmd:cwd` meta field), so the git
half is net-new regardless. The rejected meta-spec "reuse `preview`/`codeeditor`" option
structurally cannot deliver this surface — there is nothing to diff against without git, and
Monaco (`codeeditor/diffviewer.tsx`) re-adds the startup weight the trim-cockpit pass
removed and diverges from the handoff's hand-rolled diff. We shell out to the `git` binary
(read-only subcommands) rather than add a `go-git` dependency (minimize deps; git is always
present where agents run).

**Diff baseline:** all uncommitted vs `HEAD`. Tracked changes (M / D / staged-A) →
`git diff HEAD -- <path>` hunks; untracked (`??`) → plain content (no diff).

## 4. Architecture

```
focusIdAtom ─► liveAgent.transcriptPath ─► GetAgentTranscript(head) ─► agentcwd.ts ─► cwd
   cwd ─► GitChangesCommand ─► gitstatus.ts ─► filesChangesAtom ──────► left tree
   (select path) ─► GitDiffCommand(cwd,path) ─► gitdiff.ts ─► filesDiffAtom ─► center pane
   "Open in editor" ─► existing Tauri open_external(absPath)
```

### 4.1 Backend (two new read-only commands; thin Go, parse in TS)

Go runs **fixed** git subcommands (never arbitrary exec) and returns **raw stdout**. The
risky parsing lives in pure, fixture-tested TS (§5), matching the `transcriptprojection.ts`
grain.

```go
// pkg/wshrpc/wshrpctypes.go — interface methods + structs
GitChangesCommand(ctx context.Context, data CommandGitChangesData) (*CommandGitChangesRtnData, error)
GitDiffCommand(ctx context.Context, data CommandGitDiffData)       (*CommandGitDiffRtnData, error)

type CommandGitChangesData struct { Cwd string `json:"cwd"` }
type CommandGitChangesRtnData struct {
    Branch  string `json:"branch"`
    StatusZ string `json:"statusz"` // raw `git status --porcelain=v1 -z`
    Numstat string `json:"numstat"` // raw `git diff --numstat HEAD`
    IsRepo  bool   `json:"isrepo"`
}

type CommandGitDiffData struct {
    Cwd  string `json:"cwd"`
    Path string `json:"path"`
}
type CommandGitDiffRtnData struct {
    Diff      string `json:"diff"`      // raw unified diff (tracked changes)
    Content   string `json:"content"`   // plain text (untracked / new files)
    Untracked bool   `json:"untracked"`
}
```

**Touchpoints (exact):** `wshrpctypes.go` (interface + structs) → `wshserver/wshserver.go`
(impl, mirroring `GetAgentTranscriptCommand`) → `task generate` regenerates `wshclient.go`
**and** `frontend/app/store/wshclientapi.ts`. Command dispatch is reflection-based over the
`WshServer` interface — no manual registry. A small `pkg/gitinfo` holds the exec helper:
`exec.CommandContext(ctx, "git", "-C", cwd, …)` with a context timeout; read-only
subcommands only; "not a repo" → `IsRepo:false` (not an error).

### 4.2 Frontend modules (mirroring the `agents/` pattern; thin views over pure logic)

- **`gitstatus.ts`** — *pure*. `(statusZ, numstat) → GitChange[]` `{path, status, adds, dels}`
  + net totals. Joins porcelain entries with numstat by path. No React, no Wave imports.
- **`gitdiff.ts`** — *pure*. Raw unified diff → the handoff line model
  `{gOld, gNew, sign, text, kind}`; untracked content → all-plain lines.
- **`agentcwd.ts`** — *pure*. transcript lines → cwd (Claude `cwd`; Codex `session_meta.cwd`).
- **`filesstore.ts`** — jotai atoms on `AgentsViewModel` (§4.3).
- **`filessurface.tsx`** — the handoff-parity view (§6). Hand-rolled JetBrains-Mono line
  list; **no Monaco**.

### 4.3 State (atoms added to `AgentsViewModel`)

- `filesChangesAtom` — `{branch, files: GitChange[], adds, dels, isRepo}` loaded from RPC #1
  for the focused agent.
- `filesSelectedPathAtom: PrimitiveAtom<string | null>` — the selected file (default: first
  changed file, or null).
- `filesDiffAtom` — `{lines, isDiff, adds, dels, hunkLabel}` for the selected path, loaded
  lazily from RPC #2 on selection.

Follows the model-singleton convention (simple atoms as fields; updates via `globalStore`).
**Load lifecycle:** load on surface entry and when `focusIdAtom` changes; re-run on explicit
refresh. (Working-tree state is effectively static between agent turns; no live tailing in
v1.)

## 5. Extraction & rendering

| Concern | Detail |
|---|---|
| **Status glyph** | porcelain code → `M` (modified), `A` (added/staged-new), `D` (deleted), `?` (untracked), `R` (renamed). Colors via `@theme` tokens (no raw hex). |
| **adds/dels** | per-file from `numstat`; untracked files counted as all-adds (or shown as new). |
| **Diff lines** | unified-diff hunks → `{gOld, gNew, sign:'+'/'−'/' ', text}`; `@@` header → `hunkLabel`. |
| **Plain view** | untracked/new file content → single-gutter line list. |
| **Binary** | numstat `-`/`-` or binary diff → "binary file, no preview". |

`gitstatus.ts` and `gitdiff.ts` are fixture-tested (`*.test.ts`) against captured real git
output, including negatives: clean tree, rename, untracked-only, deleted file, binary.

## 6. UI — handoff parity

Faithful rebuild of `Wave-cockpit-live.dc.html:733-804` in Tailwind v4 `@theme` tokens (no
raw hex/rgba — add tokens to `tailwindsetup.css` if a needed color is missing):

- **Left pane (292px):** header `Files` + `read-only` badge; project button showing
  `filesDir` (the cwd basename) — **deferred stub** (no picker in v1); branch chip +
  `+adds −dels`. Below: the changed-file list — per row a file icon, path, and the colored
  status glyph. Selecting a row sets `filesSelectedPathAtom`.
- **Center pane:** file header (path + status badge + `Read-only` + **Open in editor ↗**);
  then either the **diff view** (`+adds −dels` + hunk label bar, then the gutter line list:
  old# / new# / sign / text) or the **plain view** (single gutter + text) for untracked.

## 7. Actions

- **Open in editor** → existing Tauri `open_external(absPath)` (resolve `cwd` + relative
  path). The only outbound action; everything else is read-only.
- **Project picker** (`toggleProjects`) → deferred stub; logged in `docs/deferred.md`.

## 8. Reuse map

| Need | Reused (existing) |
|---|---|
| Focused agent identity | `focusIdAtom` (`agents.tsx`) |
| Agent → transcript path | `liveAgent.transcriptPath` (`liveagents.ts:53`, from `status.transcriptpath`) |
| Read transcript head (for cwd) | `GetAgentTranscriptCommand` (generated wshrpc client) |
| Project/cwd conventions | `projectname.ts`, `cwdToServiceLabel` (`session-models/sessionviewmodel.ts`) |
| Open externally | Tauri `open_external` (`commands.rs`) |
| Surface routing | `cockpitshell.tsx` switch; `navrail.tsx` already lists "files" |
| Theme tokens | `tailwindsetup.css` `@theme` (foundation already landed) |

## 9. Testing

- **Pure unit tests (vitest):** `gitstatus.test.ts` (porcelain+numstat join, all status
  codes, clean tree, rename, untracked, binary), `gitdiff.test.ts` (hunk parsing, additions,
  deletions, new-file, plain content), `agentcwd.test.ts` (Claude + Codex cwd extraction,
  missing cwd).
- **Go:** a small `pkg/gitinfo` test against a temp git repo (status/diff/numstat/not-a-repo)
  if the exec helper carries logic beyond a passthrough; otherwise covered by the TS parsers.
- **Visual:** CDP dev-app screenshot vs the handoff design (no jsdom render harness).

## 10. What this retires

The Phase 1b Agent-rail placeholders **Branch** and **Files touched** (`docs/deferred.md`)
gain a real source: the same `GitChangesCommand` + `gitstatus.ts` (branch + changed-file
list) can feed the Agent details rail. Wiring those is a follow-on, noted in the deferred
log, not v1 scope here.

## 11. Open questions / deferred

- **Remote worktrees** — v1 runs git on the wavesrv (local) host. SSH/WSL agent worktrees
  need the command routed to `wsh` on that host; deferred (same command impl can live on
  `wsh`).
- **Project picker** — the handoff's cross-project `toggleProjects` picker is a deferred
  stub in v1 (Files is focused-agent-scoped).
- **Codex cwd/branch** — Codex `session_meta.payload.cwd` for cwd; branch from git (Codex
  transcripts have no `gitBranch`). Resolve cwd extraction against Codex fixtures during impl.
- **Live refresh** — v1 reloads on surface/focus change, not on a file watcher. Revisit if a
  live-updating diff proves useful.
- **Rename precision** — porcelain `R` handling (old→new path) rendered minimally in v1.

## 12. Decision log

- **F1 — Scope:** focused agent's worktree (bound to `focusIdAtom`); no cross-project picker
  in v1 (deferred stub).
- **F2 — Tree content:** changed files only (`git status`), not a full recursive tree —
  matches triage, avoids gitignore/lazy-load/arbitrary-reads.
- **F3 — Data source:** transcript for cwd (free, read before git); two new read-only git
  RPCs for branch + changed files + per-file diff. Rejected: reuse `preview`/`codeeditor`
  (can't produce git data; Monaco is heavy + off-design).
- **F4 — Parse split:** thin Go (return raw git stdout) + pure fixture-tested TS parsers,
  matching `transcriptprojection.ts`; keeps generated wire types stable.
- **F5 — Baseline:** all uncommitted vs `HEAD`; untracked → plain view.
- **F6 — Deps:** shell out to the `git` binary (read-only); no `go-git` dependency.
- **F7 — Rendering:** hand-rolled JetBrains-Mono diff/plain line list per the handoff; no
  Monaco.
