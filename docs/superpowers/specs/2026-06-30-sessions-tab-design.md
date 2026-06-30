# Sessions tab: a runtime-agnostic resumable-session archive

Date: 2026-06-30
Scope: feature (extend an existing backend scan + build a new cockpit NavRail surface). Spec only — hands off to writing-plans.
Builds on `2026-06-29-agent-tab-resume-sessions.md` (the Agent-tab resume hero, which this promotes to a full surface).

## Problem

The `sessions` NavRail entry exists but renders `PlaceholderSurface` ("Coming soon"). The only place to resume a
past session today is the Agent-tab "No terminal running" hero — a 5-row, Claude-only, 14-day preview that's hidden
the moment any agent is live. There is no browsable archive of past work, and the Activity surface already defers to
a Sessions surface that doesn't exist yet (`activitysurface.tsx`: *"Jump is live-only: ended sessions render no Jump
button (deferred to the Sessions surface)"*).

This spec promotes the hero into a full surface: a searchable, **runtime-agnostic** archive of past resumable
sessions, with Resume as the primary action. The plumbing (`pkg/agentsessions`, `GetRecentSessions`,
`recentsessionsstore`) already exists and is reused.

## Decisions (locked via brainstorming, 2026-06-30)

Settled interactively; recorded so the plan doesn't relitigate them.

- **Runtime-agnostic + extensible.** Not Claude-only. The Go scan becomes a small **provider registry** (a slice of
  descriptors) so future runtimes are a one-descriptor add. Today's providers: Claude and Codex. `antigravity` and
  others come later with no view/transport changes.
- **One unified list with a per-row runtime tag.** Claude and Codex sessions interleave in a single newest-first
  list; each row is badged by runtime for identification.
- **Scope = past sessions only.** Ended/resumable sessions across runtimes. Live agents stay on the Agent tab; this
  surface does not reconcile the live roster (rejected "past + live unified" scope). No mutations — no rename / pin /
  delete (rejected "past + management" scope).
- **Resume is wired for both Claude and Codex** (verified, see below). A runtime whose resume isn't wired would
  degrade to a read-only row (empty `ResumeCommand`), but no shipping runtime is read-only.
- **Flat newest-first + client-side search + filter chips.** A search box (matches task / project / branch) and chips
  for runtime and project, over a flat list. Not grouped-by-project.
- **Window 30 days, cap 100.** Tunable; search/filter is client-side over that set. All-time / server-side search is
  deferred.

## Codex resume — verified against the binary

`codex-cli 0.142.4`, `codex resume --help`:

```
Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]
  [SESSION_ID]  Session id (UUID) or session name. UUIDs take precedence...
```

The session id is the **UUID** on the first line of each rollout file, `session_meta.payload.session_id`
(also embedded in the filename `rollout-<timestamp>-<uuid>.jsonl`, but read from `session_meta`, not parsed from the
name). The same `session_meta` line carries `cwd` (→ project path/name) and `git.branch`; the model comes from
`turn_context` lines (as `usagestats.extractCodex` already reads).

- Claude resume: `claude --resume <id>`, `id` = JSONL filename stem.
- Codex resume: `codex resume <id>`, `id` = `session_meta.session_id`.

This is why `SessionInfo.ID` is "the resume key," **not** "the filename stem" — for Codex those differ. Each
provider's `extract` sets `ID` to its own resume key; `resumeCmd` consumes it.

## Architecture / data flow

```
~/.claude/projects/**/*.jsonl       ─┐
~/.codex/sessions/**/rollout-*.jsonl ┼─ provider registry ─▶ ScanSessions ─▶ GetRecentSessions (wshrpc)
(future runtime roots…)             ─┘   merge · mtime-sort desc · cap                  │
                                                                                        ▼
                                                    sessionsArchiveStore (atom; window 30d / cap 100)
                                                                                        │
                                       SessionsSurface (search + runtime/project chips, flat newest-first)
                                                                                        │ Resume(s)
                                                                                        ▼
                       launchAgent({ runtime, startupCommand: s.resumeCommand, projectPath, projectName })
                                                                                        │
                                          (launchAgent already sets surface→"agent" + focuses the new tab)
                                                                                        ▼
                                                       new session tab ▶ live agent ▶ real TUI
```

## Backend — `pkg/agentsessions` (the extensible seam)

Replace the single hardcoded Claude walk with a provider registry (a slice, not a framework):

```go
type provider struct {
    runtime   string                                    // row tag: "claude" | "codex" | …
    root      string                                    // ~/.claude/projects, ~/.codex/sessions
    matches   func(name string) bool                    // "*.jsonl" vs "rollout-*.jsonl"
    extract   func(id string, lines []string) *SessionInfo  // id = filename stem; extract may override ID
    resumeCmd func(s *SessionInfo) string                // "" = not resumable → read-only row
}
```

- `ScanSessions` iterates providers, runs the existing stat-then-read-only-newest scan per root, merges, sorts by
  `LastActiveTs` desc, applies the cap. The newest-first read optimization (only read enough files to fill the cap)
  is preserved per provider.
- **`SessionInfo` gains `Runtime` (already present) used as the tag, and a new `ResumeCommand string`.** The resume
  string moves out of the frontend (the hero hardcodes `claude --resume ${id}` today) into the provider — one
  authoritative place per runtime.
- **Claude provider** = today's logic, factored into a descriptor. `extract` keeps `ID = filename stem`;
  `resumeCmd = "claude --resume " + s.ID`.
- **Codex provider** (new) — root `~/.codex/sessions`, matches `rollout-*.jsonl`. `extract`:
  - `ID` ← `session_meta.payload.session_id` (overrides the filename-stem id).
  - `ProjectPath`/`ProjectName` ← `session_meta.payload.cwd`.
  - `Branch` ← `session_meta.payload.git.branch`.
  - `Model` ← last `turn_context` model (mirror `usagestats.extractCodex`).
  - `Task` ← first human prompt. **Open extraction detail** (resolve when writing the extractor): Codex stores the
    first user message in a different line shape than Claude's plain-string `message.content`; the plan identifies
    the exact line type (`response_item` / `event_msg`) against a fixture before coding.
  - `TokensTotal` ← optional; reuse the cumulative-max approach from `usagestats` if cheap, else 0 (not load-bearing
    for this surface).
  - `resumeCmd = "codex resume " + s.ID`.
- Adding a future runtime = append one descriptor. No transport / store / view change.

## Transport

**Reuse `GetRecentSessionsCommand`** — the surface calls `{ windowdays: 30, limit: 100 }`; the hero keeps
`{ windowdays: 14, limit: 5 }`. The only wire change is the regenerated bindings carrying the new `ResumeCommand`
field (`task generate`). No new command (DRY).

## Frontend

1. **`sessionsarchivestore.ts`** — its own atom + loader (`window 30 / cap 100`), separate from the hero's
   `recentSessionsAtom` so the two callers don't fight over one cached list. `null` = not loaded, `[]` = loaded-empty;
   scan failure → `[]` (never errors the surface). Pure client-side `searchSessions(list, query)` and
   `filterSessions(list, {runtime, project})` helpers, unit-testable.
2. **`sessionssurface.tsx`** — the surface view. Header (title + subtitle), a search input, filter chips for runtime
   (derived from the loaded set: All / Claude / Codex / …) and project, then a flat newest-first list. Each row:
   task (or "(untitled session)"), a **runtime tag**, and `project · branch · model · tokens · age`. A **Resume**
   button when `resumecommand` is non-empty; a muted read-only affordance otherwise. Resume →
   `launchAgent(model, { runtime, startupCommand: s.resumecommand, task: "", projectPath, projectName })`.
   Loads on mount (like `ActivitySurface`). Built with @theme tokens (no SCSS, no hardcoded colors).
3. **`cockpitshell.tsx`** — one branch swap: `surface === "sessions"` renders `<SessionsSurface>` instead of falling
   through to `<PlaceholderSurface>`.
4. **`agentlaunchhero.tsx`** (hero cleanup) — `resume()` uses `s.resumecommand` instead of the hardcoded
   `claude --resume ${id}` string. Single source of truth; the hero and the surface now resume identically.
5. **`placeholdersurface.tsx`** — drop the now-unused `sessions` title entry.

## Components (isolation)

1. `pkg/agentsessions` (Go) — provider registry + Claude/Codex extractors. One job: list recent resumable sessions
   across runtimes. Unit-testable against fixture transcript dirs (Claude + Codex).
2. `GetRecentSessions` (reused) — transport; only the bindings change.
3. `sessionsarchivestore.ts` — fetch + cache + pure search/filter helpers. No view.
4. `sessionssurface.tsx` — the surface view. No fetching beyond reading the store.
5. `cockpitshell.tsx` / `agentlaunchhero.tsx` / `placeholdersurface.tsx` — small wiring edits.

## Error handling

- Scan fails / no transcripts / unreadable or malformed lines → that file/session is skipped silently; the surface
  shows its empty state, never an error.
- A session missing required fields (no resume key, no cwd) is dropped, not rendered partial.
- Resume into a moved/deleted cwd → `launchAgent` starts the terminal there and the runtime surfaces the error in the
  PTY. Mirror, don't pre-validate (terminal-owns-its-errors stance, consistent with the live-TUI design).
- An empty `ResumeCommand` (a future read-only runtime) → row renders without a Resume button; never a broken button.

## Deferred (noted, not built)

- **Past + live unified.** Live agents are not reconciled into this list; they stay on the Agent tab. The Activity
  surface's "Jump for ended sessions" remains satisfied by Resume here, not a live Jump.
- **All-time / server-side search.** Search/filter is client-side over the 30d / 100-cap window. A larger or
  unbounded archive with server-side query is a later enhancement.
- **Mutations.** Rename / label / pin / delete (Codex even exposes `archive`/`delete` subcommands) are out of scope.
- **TokensTotal for Codex** may be approximate or 0 in the first cut; it's not load-bearing for resume.
- **Resuming non-interactive Codex sessions** (`codex exec` rollouts) — included in the list if present; resume is
  attempted and the PTY surfaces any "non-interactive session" complaint. Not pre-filtered this pass.

## Testing / verification

- Go: `pkg/agentsessions` — provider merge/sort/cap, plus Claude and Codex extractors against fixture transcript dirs
  (Codex fixture: a `session_meta` first line + `turn_context` + a first user prompt). Assert `ID` = resume key and
  `ResumeCommand` shape per runtime.
- vitest: `sessionsarchivestore` search + filter helpers; the surface's pure bits (tag, row formatting).
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline has 3 pre-existing
  `api.test.ts` errors).
- CDP (live dev app): open the Sessions surface — rows render across both runtimes with correct tags; search and
  chips filter; clicking Resume on a Claude row and a Codex row each launches a terminal (`--resume` / `resume <id>`)
  that becomes a live agent on the Agent tab.

## Implementation outline (writing-plans will expand)

1. `pkg/agentsessions`: introduce the provider registry; factor the Claude logic into a descriptor; add `ResumeCommand`
   to `SessionInfo`. Go test still green.
2. Add the Codex provider (root, matcher, extractor, `resumeCmd`); Codex fixture test. Resolve the first-prompt line
   shape against a real rollout.
3. `task generate` for the `ResumeCommand` binding.
4. `sessionsarchivestore.ts`: loader (30/100) + search/filter helpers (+ vitest).
5. `sessionssurface.tsx`: the surface (search + chips + flat list + Resume); @theme tokens.
6. Wire `cockpitshell.tsx`; clean up `placeholdersurface.tsx`; switch the hero's `resume()` to `s.resumecommand`.
7. Tests + CDP verify across both runtimes.
```
