# Agents Tab — Live Output & Triage Redesign

**Date:** 2026-06-19
**Status:** Design approved (brainstorm complete); implementation plan pending
**Base:** Reworks the existing `agents` view (`frontend/app/view/agents/`) from the agents-panel design + dual-answer-ask work. The session sidebar (`sessionsidebar.tsx`) is the master roster and is **unchanged**. Adds one streaming RPC and an fsnotify-based transcript watcher.

## UI reference (visual companion mockups — the design source of truth)

The UI was designed interactively; these self-contained HTML mockups are the **authoritative visual spec**. Open them in a browser. Match this layout, spacing, color, and interaction — do not redesign from the prose. (Drafted in the gitignored `.superpowers/brainstorm/` companion; copied here so they're durable and reach a worktree.)

- **`assets/2026-06-19-agents-tab-triage/01-full-height-output.html`** — **Primary reference.** The Agents tab at real height beside the existing sidebar: a height-filling column of output panels; asking panel sized to its content, working panels flex-sharing the remainder, each scrolling internally to its latest line.
- **`assets/2026-06-19-agents-tab-triage/02-multi-agent-output.html`** — the multi-agent output stack: asking-first ordering, the amber asking panel with question + answer pills, working panels with the narration timeline + overflow fade/scrollbar.
- **`assets/2026-06-19-agents-tab-triage/03-narration-extract.html`** — raw transcript → distilled panel: which lines are kept (reasoning) vs dropped (tool plumbing). Documents §5.
- **`assets/2026-06-19-agents-tab-triage/04-stream-architecture.html`** — the streaming-transcript data flow (backend watcher → stream channel → `projectTranscript` → render). Documents §6–7.
- **`assets/2026-06-19-agents-tab-triage/00-current-state-before.html`** — the view as it ships today, for contrast.

Palette/type already in the mockups (reuse, don't reinvent): canvas `#0b0e14`, borders `#1c2230`/`#20242b`, amber "asking" accent `#d29922`, green "working" `#3fb950`, idle `#4a5260`, primary text `#e6edf3`/`#f0f6fc`, muted `#6b7585`/`#7d8896`, dim action strip `#5c6675` with `#7d8896` verbs, fail `#f85149`, selection blue `#58a6ff`. Reasoning renders as prose; actions render as a dim monospace `verb target ✓/✗` strip.

## 1. What this is

A redesign of the **Agents tab content** so it shows, at a glance, **what each active agent is currently thinking** — its narration — with room to actually read it. The tab becomes a height-filling column of per-agent **output panels**: one panel per active agent, asking agents first, each showing the live transcript narration. The existing session sidebar remains the roster/navigation; this view is purely the live output.

## 2. Problem

The current Agents view groups agents into `asking / working / idle` one-liner rows. Two concrete failures (from the brainstorm):

1. **Working rows show nothing useful.** A working agent collapses to `name + activity`, which in practice is empty or a tool-status fragment. You can't tell what the agent is doing without opening its terminal.
2. **No room for the agent's reasoning.** What the user cares about is the agent's *narration* ("All 4 fail as expected. Creating the detector.") — not the tool commands, file diffs, or command output. The old rows surface none of it; the asking card shows a one-shot snapshot that never updates.

A note on grouping: a mid-brainstorm iteration added **project grouping** to the view, but the sidebar already groups by project (`sessionCwdsAtom` → grouped `vm.groups`). The final design deliberately omits in-view grouping to avoid that duplication: the sidebar owns the roster + project grouping; the Agents tab owns live output + answering.

## 3. Scope / non-goals

**In scope (v1)**
- Rework the `agents` view into a **height-filling column of output panels** (no `asking/working/idle` section list, no in-view project grouping).
- **Working panel:** the live narration timeline — reasoning prominent, tool calls as thin `verb target ✓` markers, tool output hidden behind a "show tool output" toggle. Header: `● name · project · task`, `model · elapsed · ⟳ <since-last-activity>`, "Open terminal".
- **Asking panel:** amber-bordered; the narration so far + the question + answer pills (reusing the existing dual-answer `AskCard` flow). Sized to its content.
- **Ordering:** asking first, then working by most-recent activity. **Idle agents hidden** (they remain in the sidebar).
- **Sizing:** output column fills the tab height; asking panels size to content; working panels flex-share the remainder with a min-height floor; the column scrolls when crowded; each panel scrolls internally, pinned to its latest line unless the user scrolled up.
- **Live transport:** a new streaming transcript RPC (`StreamAgentTranscriptCommand`) backed by an **fsnotify** offset-tail watcher; the frontend opens one stream per visible panel.
- Narration sourced as a **deterministic projection** of the transcript (`projectTranscript`, reused) — no LLM.

**Non-goals (this cut)**
- **Triage overview / needs-you summary.** Considered and dropped: asks fold into their own panel; the sidebar carries roster duty.
- **In-view project grouping / a roster rail.** The sidebar already does this; rebuilding it in the view is pure duplication.
- **Idle-agent panels.** Hidden here; reachable via the sidebar.
- **Remote / SSH agent streaming.** Transcripts live where `claude` runs; a remote watcher (precedent: `RemoteStreamCpuDataCommand`) is a documented future axis. v1 is local-first — note the seam, don't build it.
- **Richer answering** (multiSelect / freeform / multi-question inline) — unchanged from current dual-answer behavior; still falls back to the terminal.
- **Manager / orchestration layers** (conversational manager, auto-answer rules, spawning workers).
- **Migrating the asking card's one-shot previous-info fetch onto the stream.** Clean follow-on; left alone to avoid disturbing the dual-answer flow (the ask moment is intentionally frozen).
- **Changing sidebar click behavior.** A sidebar row still jumps to the terminal tab; not expanded here.

## 4. Layout & components

```
┌ sidebar (unchanged) ─┐   ┌ Agents tab — output column (fills height) ──────────┐
│ ⬤ Agents   [1 asking]│   │ ┌ loom · waveterm · duplicate-session race   4m ──┐ │  asking
│ ───────────────────  │   │ │ Both clone paths conflict; I need a decision…   │ │  (amber,
│ ＋ New Tab           │   │ │ Which cloning approach? [Deep][Shallow][Ref][▸] │ │   sized to
│ ▾ waveterm      (3)  │   │ └─────────────────────────────────────────────────┘ │   content)
│   ● loom        opus │   │ ┌ cyber-detector · Harden…    opus · 8m · ⟳12s ───┐ │  working
│   ● graphify  sonnet │   │ │ All 4 fail as expected. Creating the detector.  │ │  (flex-fill,
│   ○ review-spec      │   │ │   wrote defense_evasion_detector.py             │ │   internal
│ ▾ cyber_anomaly… (1) │   │ │   ran   pytest -k detector ✓                    │ │   scroll →
│   ● cyber-detector   │   │ │ Task 5 ✅ … Starting Task 6 (the scheduler job). │ │   latest)
└──────────────────────┘   │ └─────────────────────────────────────────────────┘ │
                           │ ┌ graphify · Build knowledge graph  sonnet · 2m ──┐ │  working
                           │ │ … Clustering 38 nodes into communities now.     │ │  (flex-fill)
                           │ └─────────────────────────────────────────────────┘ │
                           └──────────────────────────────────────────────────────┘
```

**Division of labor**
| Surface | Role | Change |
|---|---|---|
| Session sidebar | Master roster — project groups, `N asking` badge, status, model, subagents. Click → terminal. | Unchanged |
| Agents tab | Height-filling column of live output panels; answering. | Reworked |

**Panel header:** status dot (amber asking / green working) · agent name · `project · task` (project derived from the transcript path, §6) · right-aligned `model · elapsed · ⟳ <since-last-activity>` · "Open terminal" (`setActiveTab(agent.id)`).

**Working panel body:** the narration timeline rendered by the existing `PreviousInfo` component (extended: latest message accented `#f0f6fc` with a green left-border; container is `flex:1; min-height:0; overflow-y:auto`, auto-scrolled to bottom). Actions are the dim monospace strip. The mockups show a "show tool output ▸" affordance; **v1 omits it** (don't ship a dead control) — reserved as a future affordance, see §11.

**Asking panel body:** the narration so far + the existing `AskCard` question/pills/submit (dual-answer). `flex:none` so the whole question is always visible.

## 5. Reasoning vs. action vs. output (the data model)

The distinction is structural, from the transcript JSONL block `type` — not a heuristic. `projectTranscript` (`frontend/app/view/agents/transcriptprojection.ts`) already implements it and is reused unchanged:

| Transcript block | Category | Rendered as |
|---|---|---|
| `assistant` → `text` | **reasoning / narration** | prose `{kind:"message"}` (prominent) |
| `assistant` → `tool_use` (`name`) | **action** | dim `verb target` line `{kind:"action"}` |
| `user` → `tool_result` (`is_error`) | **action output (plumbing)** | only updates the matching action's `✓/✗`; content discarded |
| `assistant` → `thinking` | internal chain-of-thought | **skipped** (not narration) |

Because `tool_result` content is discarded at projection time, a large tool output (e.g. a 500-line pytest log) collapses to a single `✓` on an existing action — keeping both transports incremental (§6–7).

## 6. Transport: streaming transcript RPC (fsnotify offset-tail)

Reuses the established streaming-RPC pattern (`chan RespOrErrorUnion[T]` → generated `AsyncGenerator`, consumed with `for await`; cf. `FileListStreamCommand`, `StreamCpuDataCommand`).

**Declaration** (`pkg/wshrpc/wshrpctypes.go`, then `task generate`):
```go
StreamAgentTranscriptCommand(ctx context.Context, data CommandStreamAgentTranscriptData) chan RespOrErrorUnion[AgentTranscriptUpdate]

type CommandStreamAgentTranscriptData struct {
    Path      string `json:"path"`
    TailLines int    `json:"taillines,omitempty"` // backlog size for the first chunk
}
type AgentTranscriptUpdate struct {
    Lines []string `json:"lines"` // raw JSONL lines; projection stays on the frontend (the seam)
}
```

**Server** (`pkg/wshrpc/wshserver/transcript.go`, beside the existing `readTranscriptTail`):
1. Emit a **backlog** chunk first — reuse `readTranscriptTail(path, taillines)` verbatim — and record the file's byte offset (size).
2. **fsnotify-watch the project directory** (fsnotify watches dirs; precedent `pkg/wconfig/filewatcher.go` — `NewWatcher`, `watcher.Add(dir)`, goroutine `select` over `Events`/`Errors`), filtering events to the one session `<id>.jsonl`.
3. On a write event: `seek(offset)` → read to EOF → split complete lines → **buffer a partial trailing line** until its `\n` → emit new lines → advance offset.
4. **Truncation/rotation:** if `offset > size`, reset offset to 0 and re-emit (rare; transcripts are append-only).
5. `defer close(ch)` and tear down the watcher when `ctx` is cancelled (frontend closed the stream). Debounce bursts (~100–200ms) so a rapid append sequence doesn't become an event storm.

## 7. Frontend data flow & lifecycle

```
StreamAgentTranscriptCommand (AsyncGenerator)
  → accumulate raw lines per agent
  → projectTranscript(lines)            // UNCHANGED — §5
  → entriesByIdAtom[agentId]            // keyed atom, like previousInfoByIdAtom
  → <PreviousInfo> renders              // UNCHANGED renderer (extended for accent + scroll)
```

- A small **stream controller** (a model method / `useEffect` per visible panel) opens the stream, accumulates lines, projects, and writes `entriesByIdAtom`.
- **Lifecycle = the subscription.** Panel mounts → stream opens → watcher runs. Panel unmounts (agent leaves the active set, tab hidden) → effect cleanup cancels `ctx` → goroutine + watcher tear down. No global event bus, no refcounting.
- One stream per **visible** panel. With idle hidden and the asking/working set bounded by what's active, concurrency stays small.
- The view derives its agent set from the existing roster (`liveAgentBaseAtom` / `sessionSidebarViewModelAtom` + `getAgentStatusAtom`); `withAsk` still overlays the `agent:ask` WPS event onto asking agents (unchanged).

## 8. Sizing model

- Output column: `display:flex; flex-direction:column; height:100%`.
- **Asking panels:** `flex:none` (natural content height — full question always visible).
- **Working panels:** `flex:1 1 0; min-height:<floor>` so they evenly share leftover height; body is `flex:1; min-height:0; overflow-y:auto`.
- **Internal scroll:** auto-pin to bottom (latest narration) **only if the user is already near the bottom** — the terminal/log "stick-to-bottom unless scrolled away" rule.
- **Crowding:** when summed min-heights exceed the viewport, the column scrolls; each panel keeps its floor.
- **Liveness:** `⟳ <since-last-activity>` in the header so a quiet agent (mid long tool call) reads as quiet, not current.

## 9. Reused vs. new

**Reused (unchanged or lightly extended):** `projectTranscript`, `readTranscriptTail`, the `agent:ask` WPS flow + `withAsk` + `AskCard` (dual-answer), the derived roster atoms, the entire session sidebar, the project-name derivation idea (transcript path's encoded cwd → last segment).

**New:** `StreamAgentTranscriptCommand` + the fsnotify offset-tail watcher (`transcript.go`); `AgentTranscriptUpdate` / `CommandStreamAgentTranscriptData` types; the per-panel stream controller + `entriesByIdAtom`; the output-panel components (working panel, asking panel wrapper) + the flex-height column; the `PreviousInfo` extensions (latest-line accent, scroll container).

**Removed:** the `asking/working/idle` section grouping + `WorkingRow`/`IdleRow` one-liners in `agents.tsx` (superseded by output panels).

## 10. Testing

- **Pure units:** `projectTranscript` reasoning/action/skip-`thinking` mapping (already covered; extend for `thinking`); offset-tail line-buffering (partial line across reads, truncation reset) — Go unit test on the tail/buffer helper; project-name derivation from an encoded path; ordering (asking-first, working-by-recency, idle excluded).
- **Lifecycle (live):** stream opens for a visible panel and the watcher is torn down on unmount (verified live per the CDP dev-app flow); new transcript lines append to the panel and it stays pinned to latest.
- **Behavior, not internals:** assert the panel shows the latest narration line and that tool output is absent by default.

## 11. Open questions / future

- **"Show tool output" toggle.** Reserved in the header; revealing `tool_result` content needs the projection to optionally carry it. Deferred — confirm whether it's wanted before building.
- **Remote/SSH agents.** Watcher must run on the remote `wsh` (`RemoteStream…` precedent). Out of scope; seam noted.
- **Unify the asking card onto the stream.** Today the ask uses a one-shot fetch (frozen at the question moment). Migrating it to the live stream is a clean follow-on.
- **Many concurrent agents.** If open-stream count ever grows large, cap concurrently-streamed panels (stream only what's in the viewport) — measure first.
