# Merge Activity into Sessions: one master-detail agent-session surface

Date: 2026-07-10
Scope: feature. Backend parser unification (Go) + frontend surface rewrite + retire the Activity surface. Spec only — hands off to writing-plans.

Imports the design mockup `Wave-sessions.dc.html` (claude.ai/design project "wave"). The mockup is the visual target; this spec reconciles it with how the cockpit actually behaves.

## Problem

The cockpit has two NavRail surfaces that are two views over the **same** on-disk transcript corpus
(`~/.claude/projects/**`, `~/.codex/sessions/**`), parsed by **two independent pipelines**:

- **Activity** (`activitysurface.tsx` + `activityevents.ts` + `activitydiscovery.ts` + `activitystore.ts`) — a
  fine-grained cross-project *event* feed, extracted **in the frontend** (per-line → many lifecycle events per
  session), reconciled with the live roster to offer **Jump**.
- **Sessions** (`sessionssurface.tsx` + `sessionsarchivestore.ts` → `GetRecentSessions` → `pkg/agentsessions`) — a
  coarse per-session resumable *archive*, folded **in Go** (per-file → one summary row), which deliberately does **not**
  reconcile live agents and offers **Resume**.

Same data, parsed twice, no shared parser; the "first human prompt = title" and "project = cwd basename" logic is
duplicated across languages. The two surfaces were designed as complementary halves — Activity's own comment defers
ended-session jumps "to the Sessions surface," and the Sessions spec (below) notes Activity "already defers to a
Sessions surface." Merging them is the natural consolidation: it removes a redundant nav entry and collapses the
double-parse into one source of truth.

## Supersedes / builds on

- **Supersedes** `2026-06-30-sessions-tab-design.md` in two decisions:
  - its "**Scope = past sessions only … does not reconcile the live roster**" is **reversed** — the merged surface
    reconciles live agents to switch Jump vs Resume (that spec's "Deferred: Past + live unified" is now built);
  - its "**flat newest-first, not grouped**" list becomes **master-detail, grouped by recency**.
  - Retained from it: runtime-agnostic provider registry, per-row runtime tag, Codex/Claude resume keys, the
    30-day/100-cap window, terminal-owns-its-errors stance.
- **Absorbs** `2026-06-26-cockpit-activity-surface*` — the Activity surface and its FE extraction pipeline are retired;
  its lifecycle taxonomy (`started/asked/committed/errored/finished`) moves into Go.

## Decisions (locked via brainstorming, 2026-07-10)

- **Unify the parser in Go.** Port the FE lifecycle extraction (`activityevents.ts` → `extractClaudeEvents` /
  `extractCodexEvents`) into `pkg/agentsessions`, extracted in the same pass that already folds the summary. The FE
  extraction files are deleted. Single source of truth for both the summary list and the merged event feed.
- **Cross-project.** The list stays global across repos (as both surfaces are today), grouped by recency. The mockup's
  single-repo topbar switcher is a separate, not-yet-wired concept and is out of scope here.
- **Live reconciliation stays on the frontend.** Go cannot know live tab IDs. The FE overlays the live roster
  (`model.agentsAtom`) onto the Go sessions by `transcriptPath`, which flips a row from **Resume** (ended) to
  **Jump/Open** (live) and relabels its status to **Running**. This corrects the mockup, which wrongly shows "Resume"
  on live rows.
- **Per-session detail reuses `NarrationTimeline`.** The selected-session timeline (per-tool granularity, matching the
  mockup) reuses the existing `transcriptprojection.ts` / `NarrationTimeline` (already the live Agent-tab renderer,
  already collapses tool bursts) by lazily reading that one session's transcript on select. Go stays scoped to
  lifecycle+summary; the cross-session **"All activity"** feed uses the coarse Go events (per-tool across every agent
  would be an unreadable firehose).
- **"Needs attention" = `asked` + `errored`**, not the mockup's `failed || waiting`. Preserves the cockpit's most
  important signal (a pending ask / "N need you"), which the mockup dropped.
- **@theme tokens only.** The mockup is raw hex (`#7c95ff`, `#0c0e11`, …). All of it maps to existing tokens in
  `tailwindsetup.css`; no hardcoded colors, no SCSS.

## Architecture / data flow

```
~/.claude/projects/**/*.jsonl        ─┐
~/.codex/sessions/**/rollout-*.jsonl  ┼─ provider registry ─▶ scan (one pass): fold summary + extract lifecycle events
(future runtime roots…)              ─┘        │
                                               ├─▶ GetRecentSessions (lean: summary only)  ──▶ recentsessionsstore (hero, 14d/5)
                                               └─▶ GetSessionsActivity (rich: +events +status +duration) ──┐
                                                                                                           ▼
                                                                          sessionsArchiveStore atom (SessionActivity[], 30d/100)
                                                                                                           │
                                          ┌─ FE live overlay (agentsAtom × transcriptPath) → live/liveId/Running ─┘
                                          ▼
                          SessionsSurface (master-detail; groups Live now / Today / Earlier; filters All/Live/Done/Needs attention)
                                          │
             ┌── "All activity" selected ─┴── a session selected ──┐
             ▼                                                      ▼
   merged cross-session lifecycle feed              detail header + timeline:
   (Go events, project-tagged)                        live/ended → lazy GetAgentTranscript → transcriptprojection → NarrationTimeline
                                                       action: live → Jump (focusIdAtom + surface="agent") · ended → Resume (launchAgent)
```

## Backend — `pkg/agentsessions`

The existing `scanProvider` already reads each candidate file's lines to fold a `SessionInfo`. In that **same read**,
also extract lifecycle events and derive card fields — no extra file reads.

- **Port the extractors.** Translate `activityevents.ts` `extractClaudeEvents` / `extractCodexEvents` (lifecycle
  taxonomy `started | asked | committed | errored | finished`, timestamped, one-line `text`, `MAX_TEXT=100` clip,
  commit-subject and ask-question parsing, Codex subagent exclusion) into Go, per provider. This is the bulk of the
  work (~120 TS lines → Go).
- **Do NOT gate `finished` on liveness in Go.** The FE extractor suppresses `finished` for live sessions; Go can't know
  liveness. Go always emits the trailing event; the FE live overlay relabels a live session's status to Running.
- **Derive per session** (from the extracted events):
  - `StartedTs` = first event ts; `DurationMs` = last − first.
  - `Status` (archival): `waiting` if the trailing event is an unanswered `asked`; `failed` if the session ended on an
    `errored` with no later success; else `done`. (Exact heuristic finalized against fixtures in the plan.)
    `running` is **not** a Go status — the FE overlay sets it.
- **Two projections over one scan** (DRY): the core scan always extracts events; `GetRecentSessions` maps to the lean
  wire type (drops events) so the launch hero's payload doesn't bloat; `GetSessionsActivity` maps to the rich type.

## Transport — wire types + one new command

Add to `pkg/wshrpc/wshrpctypes.go` (then `task generate` regenerates TS + Go bindings — never hand-edit generated
files):

```go
type SessionEvent struct {
    Type string `json:"type"` // started|asked|committed|errored|finished
    Ts   int64  `json:"ts"`
    Text string `json:"text"`
}

type SessionActivity struct {
    SessionInfo                 // embed the existing wire type (id, runtime, project*, branch, task, model, tokenstotal, lastactivets, resumecommand)
    Status     string         `json:"status"`     // done|failed|waiting (FE overlays "running")
    StartedTs  int64          `json:"startedts"`
    DurationMs int64          `json:"durationms"`
    Events     []SessionEvent `json:"events"`
}

type CommandGetSessionsActivityData    struct { WindowDays int `json:"windowdays"`; Limit int `json:"limit"` }
type CommandGetSessionsActivityRtnData struct { Sessions []SessionActivity `json:"sessions"` }
```

- Add `GetSessionsActivityCommand(ctx, CommandGetSessionsActivityData) (*CommandGetSessionsActivityRtnData, error)` to
  the `WshRpcInterface` (alongside `GetRecentSessionsCommand` at wshrpctypes.go:102); implement in
  `pkg/wshrpc/wshserver/wshserver.go` mapping `agentsessions` → the wire type (mirrors the existing `GetRecentSessions`
  handler that maps internal `SessionInfo` → wire `SessionInfo`).
- `GetRecentSessions` is **kept** (lean; the hero at `recentsessionsstore.ts` uses 14d/5) — it just becomes a thinner
  projection of the same core scan.

## Frontend

1. **`sessionsarchivestore.ts`** — loader switches to `GetSessionsActivityCommand({ windowdays: 30, limit: 100 })`;
   atom holds `SessionActivity[]` (`null`=unloaded, `[]`=loaded-empty; scan failure → `[]`, never errors the surface).
   Add pure helpers (unit-testable, no React): `groupByRecency(list, now)` → Live now / Today / Earlier;
   `filterByStatus(list, "all"|"live"|"done"|"needs")` (needs = `asked`+`errored`); `mergedFeed(list)` → cross-session
   events newest-first, each tagged with its session title/project.
2. **Live overlay** — a derived atom `sessionsWithLiveAtom` = base `SessionActivity[]` × `agentsAtom` matched on
   normalized `transcriptPath` (reuse the `norm()` + liveByPath pattern from `activitystore.loadActivity:85-90`), so
   live status updates reactively as the roster changes (better than the old load-time snapshot). Sets `live`,
   `liveId`, and status→`running`.
3. **`sessionssurface.tsx`** — rewritten as master-detail:
   - **Left (~392px):** pinned "All activity" card (merged-feed selector + total-event count), then session cards
     grouped Live now / Today / Earlier, cross-project, each with status pill, `repo · branch · duration · tokens`,
     pulsing dot when live. Status/recency **filter chips**: All / Live / Done / Needs attention. Keep a **runtime tag**
     per row (Claude/Codex) — do not drop the runtime dimension the archive has today.
   - **Right:** "All activity" → merged lifecycle feed (Go events, project/agent-tagged). A selected session → detail
     header (icon, status pill, `repo/branch/started/tokens`, **Jump/Open** when live else **Resume**) + timeline
     rendered by `NarrationTimeline` from a lazily-fetched transcript (`GetAgentTranscriptCommand` on select →
     `transcriptprojection`).
   - Resume path unchanged: `launchAgent(model, { runtime, startupCommand: s.resumecommand, projectPath, projectName })`.
     Jump path: `focusIdAtom = liveId` + `surfaceAtom = "agent"` (mirror `activitysurface.tsx:50-57` / `openTerminal`).
4. **Retire the Activity surface:**
   - Delete `activitysurface.tsx`, `activityevents.ts`, `activitydiscovery.ts`, `activitystore.ts` (and their tests).
   - Remove `"activity"` from the `SurfaceKey` union (`agents.tsx:25-34`), from `SURFACE_ORDER` (`agents.tsx:37-46`),
     and from NavRail `ICON` + `ITEMS` (`navrail.tsx:23-44`) incl. the `Activity` lucide import.
   - Move `ActivityType` off the deleted module: the event-type union now comes from the generated `SessionEvent`
     binding; retire `agents.tsx:21` import and repurpose `activityFilterAtom`/`activityProjectFilterAtom` (89-91) into
     the sessions surface's status-filter + selected-session atoms (or local state).
   - `cockpitshell.tsx`: drop the `activity` branch; `sessions` already routes to `SessionsSurface`.
   - Ctrl+1..8 (`bindings.ts:42-47`) follow `SURFACE_ORDER.slice(0,8)` automatically; removing `activity` shifts the
     numbering by one from that slot on — acceptable, documented.
5. **Startup-pref migration** (`cockpitprefsstore.ts:11`) — a persisted `cockpit.startup.surface === "activity"` must
   coerce to `"sessions"` on read (a removed key would otherwise render nothing). Add a tiny read-time migration.

## Event taxonomy & color mapping

- Real types `started/asked/committed/errored/finished` map to the mockup's chips: `run`←started, `commit`←committed,
  `fail`←errored, `note`←asked (amber), `finish`←finished. The mockup's `edit`/`tool` rows only appear in the
  single-session detail, which is `NarrationTimeline` (its own richer renderer) — not the Go lifecycle set.
- Colors: accent (`#7c95ff`→`accent`/`accent-soft`), success (`#5fc95a`→success token), danger (`#f0625a`→danger),
  amber/waiting (`#e6b450`→warning), surfaces/borders/text → existing `surface`/`border`/`muted*` tokens. No raw hex.

## Error handling

- Malformed/unreadable lines or files → skipped silently (existing behavior); surface shows its empty state, never an
  error.
- A session with no events / no resume key → dropped, not rendered partial.
- Resume/Jump into a moved cwd → the PTY surfaces the error (terminal-owns-its-errors); do not pre-validate.
- Live overlay match miss (a live agent with no on-disk transcript yet) → it simply appears when its file lands; the
  roster remains the source for the Cockpit/Agent tabs regardless.

## Non-goals / deferred

- Project-scoped (single-repo) mode + topbar project switcher — stays cross-project.
- Per-tool events in Go — detail granularity comes from the FE narration projection, not Go.
- Mutations (rename/pin/delete), all-time/server-side search — as before, deferred.
- The mockup's global `⌘K` search and usage gauge in the topbar are existing/separate concerns, untouched here.

## Concurrent-edit caution

`narrationtimeline.tsx`, `transcriptprojection.ts`, and `recentactivity.ts` currently carry **uncommitted changes** in
the working tree (in-flight transcript-renderer work). Reusing `NarrationTimeline`/`transcriptprojection` for the
detail pane intersects with those files. Re-check `git status`/branch before editing, reconcile with the in-flight
edits, and stage only this feature's files. (`recentactivity.ts` is not in the Explore map's Activity/Sessions set —
confirm its role during planning before assuming it's part of the retirement.)

## Testing / verification

- Go: `pkg/agentsessions` — Claude + Codex event extraction against fixture transcript dirs (assert taxonomy,
  ordering, clip, commit-subject, ask-text, Codex subagent exclusion); `Status`/`StartedTs`/`DurationMs` derivation
  incl. waiting/failed edge cases. Parity check that the ported Go events match the retired TS extractor on a shared
  fixture.
- vitest: `sessionsarchivestore` helpers (`groupByRecency`, `filterByStatus`, `mergedFeed`) and the live-overlay atom
  (live → Running + Jump; ended → Resume); startup-pref migration (`"activity"` → `"sessions"`).
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean).
- CDP (live dev app): Activity gone from the rail; Sessions opens master-detail; "All activity" shows the merged feed;
  selecting a live session shows its narration + **Jump** (lands on Agent tab); selecting an ended session shows
  **Resume**; Needs-attention chip surfaces asks/errors; Ctrl-number chords land on the shifted surfaces.

## Implementation outline (writing-plans will expand)

1. `pkg/agentsessions`: port Claude + Codex lifecycle extractors; derive `Status`/`StartedTs`/`DurationMs`; core scan
   emits events once. Go fixtures + tests green.
2. `wshrpctypes.go`: add `SessionEvent`/`SessionActivity`/`GetSessionsActivity*`; `task generate`; implement handler in
   `wshserver.go`; keep `GetRecentSessions` as lean projection.
3. `sessionsarchivestore.ts`: switch loader to `GetSessionsActivity`; add grouping/filter/merged-feed helpers +
   `sessionsWithLiveAtom` overlay (+ vitest).
4. `sessionssurface.tsx`: master-detail rewrite (left list + chips, right merged-feed / narration detail, Jump vs
   Resume); @theme tokens.
5. Retire Activity: delete the four files + tests; edit `agents.tsx`, `navrail.tsx`, `cockpitshell.tsx`; add the
   startup-pref migration.
6. Tests + CDP verify.
