# Activity Surface — Design Spec (Phase 2)

> Captured 2026-06-26. The first **Phase 2** surface of the agent-cockpit redesign.
> Reads on top of [`redesign-meta-spec.md`](../../redesign-meta-spec.md) (§4 surface
> inventory, §6 data flow, §9 open questions). Source of truth for the visual:
> `wave-handoff/wave/project/Wave-cockpit-live.dc.html:543-575` (the `isActivity` block).

## 1. Goal

Build the **Activity** surface: "one cross-project event stream — every agent event,
grouped by project," with type filters and one-click jump to source. It replaces the
`PlaceholderSurface` branch for `surface === "activity"` in `cockpitshell.tsx`.

This is the first surface that reads **beyond the live roster**. Every other surface today
derives from `liveAgentsAtom` (currently-running sessions). Activity adds a second,
file-backed source — the persisted session transcripts that `/resume` reads — and
normalizes both live and on-disk events into one stream.

## 2. The governing principle: the Activity ↔ Sessions boundary

Two surfaces touch session history. Their roles are deliberately disjoint, and that
boundary resolves every scope question in this spec:

- **Activity** (this surface) = a recent, glance-able **triage feed**. "What have my
  agents been doing, and where do I need to step in?"
- **Sessions** (next Phase 2 surface) = the durable, searchable **archive**. "Browse /
  search / resume past runs."

Consequences, applied below: Activity is **bounded to recent** (full history is Sessions'
job), and **Jump is live-only** in this cut (rendering/resuming a past run is Sessions'
job). Activity must not grow search, pagination, or a transcript viewer — those duplicate
Sessions and blur the boundary.

## 3. Data source (decision: file-derived, durable, both agents)

Activity sources events from the persisted transcript JSONL files — the same files
`/resume` lists — **not** from an ephemeral in-memory log and **not** from a new backend
event store. Rationale: durable across restarts, zero new Go, reuses existing machinery,
and doubles as the Sessions data source.

Storage layout (verified on disk):

| | Claude Code | Codex |
|---|---|---|
| Root | `~/.claude/projects/<sanitized-cwd>/` | `~/.codex/sessions/YYYY/MM/DD/` |
| File | `<session-uuid>.jsonl` | `rollout-<ISO-ts>-<uuid>.jsonl` |
| First line | `{"type":"mode"...}` / `file-history-snapshot` | `{"type":"session_meta","payload":{...}}` |
| **Project** | the directory name (free) | `session_meta.payload.cwd` (one header read) |

**Agent separation** is by **source root** — a 100%-reliable, zero-parse discriminator:
files under `.claude/projects` are `agent:"claude"`; files under `.codex/sessions` are
`agent:"codex"`. This matches the existing fallback in `transcriptregistry.ts`
(`agentFromPath`: `.claude` checked before `.codex`). The first cut ingests **both**.

Project-label asymmetry to design around: Claude's project is free (directory name →
`projectNameFromTranscriptPath`); Codex's requires reading the file's `session_meta`
header for `cwd`, then deriving the label.

Codex subagents: a Codex day-folder mixes top-level sessions and subagent rollouts
(`thread_source:"subagent"`, with `parent_thread_id` and `source.subagent.other` in the
header — e.g. a "guardian" judge). v1 attributes events to the file's own session and
**excludes** subagent rollouts from the feed (they are internal noise, consistent with the
Codex projector already dropping `event_msg` guardian noise). Revisit if subagent activity
proves useful.

## 4. Architecture

```
sources ───────────────────► extract ──────────► store ────────► ActivitySurface
 • live (liveEntriesByIdAtom,   ActivityEvent[]    activityEventsAtom    (NavRail → "activity")
   already in memory)          {id, agent,         (merge + dedupe,
 • on-disk recent sessions       project, type,     group by project,
   (discover → read → parse)     ts, agentName,     apply filter)
                                 text, sessionPath,
                                 live}             activityFilterAtom
```

New frontend modules (all pure-logic + thin-view, mirroring the existing agents/ pattern;
no new Go, no `task generate`):

- **`activitydiscovery.ts`** — enumerate recent session files. Lists `~/.claude/projects/*`
  and `~/.codex/sessions/YYYY/MM/DD` via `FileListCommand`; `FileInfoCommand` for mtimes.
  Returns `SessionDescriptor[]` `{path, agent, project, mtime}`. Claude project from the
  dir name; Codex project from a one-line header read. Impure (RPC); thin.
- **`activityevents.ts`** — **pure**, the riskiest logic, fixture-tested. Raw JSONL
  `lines: string[]` → `ActivityEvent[]`, one extractor per agent format (sibling of the
  transcript projectors — see §5). No React, no Wave imports.
- **`activitystore.ts`** — jotai atoms on `AgentsViewModel`: merge file events with the
  live in-memory events, dedupe, group by project, apply the active type filter.
- **`activitysurface.tsx`** — the handoff-parity view (§7).

### 4.1 State (atoms added to `AgentsViewModel`)

- `activityFilterAtom: PrimitiveAtom<ActivityType | "all">` — the selected filter chip,
  default `"all"`.
- `activityEventsAtom` — derived/loaded event set (see §6 for the load lifecycle).

Follows the model-singleton convention (simple atoms as fields; updates via `globalStore`).

## 5. Event taxonomy & extraction

The design dictates five types. Each is reconstructed from raw lines:

| Type | Token color | Claude signal | Codex signal |
|---|---|---|---|
| **Started** | green | `SessionStart` hook line / first turn (timestamped) | `session_meta` (timestamp) |
| **Asked** | amber | `tool_use` `name === "AskUserQuestion"` | best-effort; deferred if absent (see Open Questions) |
| **Committed** | periwinkle | `Bash` `tool_use` whose `command` matches `git commit` | `shell_command` function_call whose `command` matches `git commit` |
| **Errored** | red | `tool_result` `is_error === true` | `*_output` with non-zero exit (`outputIsError`) |
| **Finished** | muted | `Stop` hook line / last assistant turn | last `response_item` |

Why a raw-line extractor and not the existing `AgentEntry[]` projection: the projection
discards exactly what the taxonomy needs — per-event **timestamps**, **session
boundaries** (Claude `SessionStart`/`Stop` hook attachments; Codex `session_meta`), and
**specific tool identity** (`AskUserQuestion`; `git commit`). The extractor parses raw
JSON lines directly, reusing the proven conventions from `transcriptprojection.ts` /
`codextranscriptprojection.ts` (Claude `Bash`→command target, `is_error`→fail; Codex
`Exit code: N` / `metadata.exit_code`). It is one extractor per format, selected by the
`agent` tag, fixture-tested like `transcriptprojection.test.ts`.

Each `ActivityEvent` carries: `agent`, `project`, `type`, `ts` (epoch ms), `agentName`,
`text` (one-line summary), `sessionPath`, and `live` — drives Jump (§8). `live` is computed
by matching `sessionPath` against the live roster's transcript paths
(`liveAgentsAtom` exposes each running agent's `transcriptPath` from `status.transcriptpath`);
a match also yields the live agent's `id` (tabId) as the Jump target.

## 6. Discovery bounds & load lifecycle (decision: recent-window + cap)

Activity is a recent triage feed, so it is bounded — full history is Sessions' job.

- **mtime prefilter:** consider only session files modified within `ACTIVITY_WINDOW_DAYS`
  (start at **7**). Cheap — `FileInfoCommand` only, no read.
- **Read newest-first until a cap:** sort candidates by mtime desc; read + extract each
  (tail-read via `GetAgentTranscriptCommand`, bounded tail like the live stream's
  `STREAM_TAIL_LINES`); stop once `ACTIVITY_EVENT_CAP` (start at **200**) events are
  collected. The cap is the real bound; the window only prunes the candidate set.
- **No "load older" in Activity.** Hitting the bound is the cue to open Sessions.
- **Live merge:** events from currently-live sessions also arrive via the existing live
  streams (`liveEntriesByIdAtom`) — surfaced live, deduped against file-sourced events by
  `(sessionPath, ts, type)`.
- **Refresh:** loaded when the surface is first shown; re-run discovery on surface
  re-entry. (Live events update continuously; historical files are effectively static.)

Named constants (`ACTIVITY_WINDOW_DAYS`, `ACTIVITY_EVENT_CAP`, tail size) — no magic
numbers.

## 7. UI — handoff parity

Faithful rebuild of `Wave-cockpit-live.dc.html:543-575` in Tailwind v4 `@theme` tokens
(no raw hex/rgba — add tokens to `tailwindsetup.css` if a needed color is missing):

- Header: **"Activity"** / "Every agent event, grouped by project."
- Filter chips: **All events · Asked** (amber dot) **· Errored** (red) **· Committed**
  (periwinkle) **· Started** (green) **· Finished**. Active chip uses the selected
  treatment; sets `activityFilterAtom`.
- Per-project groups: `PROJECT ──────── ⟨attention badge⟩ ⟨count⟩`. Attention badge shows
  when the group has unanswered Asked events.
- Event row: `time (right, mono) · colored dot · agentName (bold mono) + text · TYPE
  (uppercase, colored) + "Xm ago" · Jump →`.

Entry point already exists: the cockpit rail's "View all →" button
(`cockpitsurface.tsx:609`) already routes to `surface === "activity"`.

## 8. Jump → source (decision: live-only in v1)

- **Live event** (`live === true`) → switch to the Agent surface focused on that agent
  (`globalStore.set(focusIdAtom, id)` + `surfaceAtom = "agent"`), identical to a cockpit
  row click.
- **Ended session** → **no Jump button** (omitted, not disabled — avoids a greyed-out
  graveyard). Rendering/resuming a past run is Sessions' job; when Sessions lands, ended
  rows gain an "Open in Sessions →" affordance.

## 9. Reuse map

| Need | Reused (existing) |
|---|---|
| Discriminate agent by root/path | the `agentFromPath` pattern in `transcriptregistry.ts` (the event extractors themselves are new, selected by `agent` tag inside `activityevents.ts` — a separate output contract from the `AgentEntry[]` projectors) |
| Claude project label | `projectNameFromTranscriptPath` |
| Enumerate session files | `FileListCommand`, `FileInfoCommand` (generated wshrpc client) |
| Read a transcript | `GetAgentTranscriptCommand` (one-shot), `StreamAgentTranscriptCommand` (live tail) |
| Live events in memory | `liveEntriesByIdAtom`, `lastActivityByIdAtom` (`livetranscript.ts`) |
| Surface routing | `cockpitshell.tsx` switch; `navrail.tsx` already lists "activity" |
| Jump-to-focus | `focusIdAtom` + `surfaceAtom` (`agents.tsx`) |
| Theme tokens | `tailwindsetup.css` `@theme` (foundation already landed) |

## 10. Testing

- **Pure unit tests (vitest):** `activityevents.test.ts` against captured Claude + Codex
  fixture lines covering each of the 5 types (and the negatives: a non-commit Bash, a
  zero-exit output). `activitystore` tests for grouping-by-project, filter application,
  newest-first ordering, dedupe of live-vs-file events, and the event cap.
- **Visual:** CDP dev-app screenshot vs the handoff design, per the project's
  visual-verification flow (no jsdom render harness).

## 11. Open questions / deferred

- **Codex "Asked" detection** — Codex lacks Claude's `AskUserQuestion` tool. Determine
  whether a Codex ask maps to a recognizable rollout record; if not, Asked is Claude-only
  for now (the chip still renders, faithfully, and stays empty for Codex). Resolve during
  implementation against fixtures.
- **Codex subagent attribution** — v1 excludes subagent rollouts. Revisit if surfacing
  them (attributed to the parent) proves useful.
- **Historical Jump** — wired to "Open in Sessions →" when the Sessions surface lands.
- **Committed precision** — `git commit` detection is a command-substring match; refine
  (exclude `--dry-run`, `git commit --amend` semantics) against fixtures if needed.

## 12. Decision log

- **A1 — Source:** file-derived from persisted transcripts (durable, zero new Go), not an
  in-memory log or a new backend store.
- **A2 — Agents:** ingest both Claude + Codex from v1; discriminate by source root.
- **A3 — Bounds:** recent-window (7-day mtime prefilter) + 200-event cap, newest-first; no
  pagination (full history is Sessions).
- **A4 — Jump:** live-only in v1; ended rows omit Jump (deferred to Sessions), not
  disabled.
- **A5 — Extractor:** parse raw JSONL (not projected `AgentEntry[]`), one extractor per
  format, because the taxonomy needs timestamps + session boundaries + tool identity that
  the projection discards.
