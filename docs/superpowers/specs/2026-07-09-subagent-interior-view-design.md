# Subagent Interior View — Design Spec

**Date:** 2026-07-09
**Status:** Design approved (brainstorm complete); ready for implementation plan
**Base:** Supersedes the data-source half of the 2026-06-15 *Subagent Visibility* spec (which targeted the
now-removed session sidebar and chose hooks-only, lifecycle-only). The lifecycle tree it described has
since shipped in the cockpit (`agenttree.tsx`); this spec adds the **interior** and pivots the data
source from ephemeral hooks to the on-disk subagent transcripts.

## 1. What this adds

Inside the **focused-agent view** (`agentsurface.tsx`: tree | center | rail), clicking a subagent child
in the left tree opens **that child's full live transcript** in the center pane. The tree's data source
moves to the on-disk `subagents/` directory, which — as a side effect of using the real files — also
gives the child rows **real success/failure outcomes** and **history that survives the parent's turn**
(both dead/absent today).

Today the tree shows child **type + a working dot** and nothing else: clicking a child does nothing,
children never flip to ✓/✗ (the `SubagentStop` hook emits no status), and the whole list is wiped the
instant the parent goes idle. This spec closes all three gaps with one architectural move.

## 2. Goals & non-goals

**Goals**
- Click a subagent child → read its complete, **live-tailing** interior transcript in the center pane.
- Real per-child **success / failure / working** state, derived from real data, not a status-less hook.
- Child list **persists** for the session (history), not cleared on the parent's idle transition.
- **Zero new rendering / streaming code** — reuse the parent-transcript machinery verbatim.

**Non-goals (v1)**
- **Cockpit-card fan-out badge** (`⑃ N` on `agentrow.tsx`). Deferred to a fast follow; keeps v1 to the
  focused view.
- **Codex subagents.** Codex has no confirmed per-subagent transcript files; Codex parents simply show
  no children (graceful degradation).
- **Replying to / steering a subagent.** Subagents run inside the parent's process; there is no input
  channel. Read-only interior.
- **Nested subagents (depth > 1).** Rendered flat at the top level if they appear; deep nesting is out.
- **Deleting the vestigial hook path.** Left dormant in v1 (see §8); removed in a later cleanup.

## 3. Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Source of truth | **On-disk `subagents/*.jsonl`** (glob + activity-driven refetch) | The files carry the interior, the outcome, and persistence. One source (KISS). The hook path only ever had half the data, ephemerally. |
| Interior placement | **Center-pane swap + breadcrumb** (option A) | Reuses the exact pane and renderer the parent uses; one focus at a time; lightest. (Split/drawer considered and rejected — see §7.) |
| Interior rendering | **Narration** (`NarrationTimeline`), not a terminal | A subagent has no PTY; the center's terminal stack can't host it. Narration is the renderer we already reuse. |
| Correlation (row ↔ file) | **Match `child.firstPrompt === parentTask.input.prompt`** | The child file has no type field and no `toolu_` back-ref, but its first user message is the verbatim Task prompt. Content-match disambiguates parallel same-type spawns. Spike-gated (§9). |
| Type label | Parent Task `input.subagent_type` (via the match) | The only place the pretty `Explore`/`Plan` label exists. Fallback: first line of the prompt. |
| Outcome | Parent Task `tool_result.is_error` (via the match) | The child file has no explicit terminal marker; the parent's tool_result is the authoritative done/failed signal. |
| Liveness (tree) | Refetch `GetSubagentsCommand` on **parent-transcript activity** | Child spawn (Task tool_use) and completion (tool_result) both land in the parent transcript, so the existing activity signal captures both transitions. No new stream. Mirrors `cardgitstore`. |
| Liveness (interior) | **Direct tail of the child file** via `livetranscript` | The child streams its own tool calls live even while the parent is quiet ("waiting on workers"). |
| Backend surface | **One thin RPC** (glob + head-read); no parsing | The WebView can't touch the filesystem; everything else stays as pure, testable TS. |

## 4. How Claude Code stores subagents (verified 2026-07-09)

Verified against real transcripts under `~/.claude/projects/…`:

- Each subagent is a **complete transcript file**: `<parentDir>/<sessionId>/subagents/agent-<agentId>.jsonl`.
- Record shapes are **identical to a parent Claude transcript** (`type: "assistant"|"user"`,
  `message.content` blocks, `tool_use`/`tool_result`), so `projectTranscript()` handles them unchanged.
- Top-level keys: `agentId, cwd, entrypoint, gitBranch, isSidechain, message, parentUuid, promptId,
  sessionId, timestamp, type, userType, uuid, version`. **No** `subagent_type`/`agent_type` field; **no**
  `toolu_` back-reference to the parent Task call.
- The child's **first user message is the verbatim Task prompt** (e.g. `"Explore the Wave Terminal repo
  at …"`), which equals the parent Task `tool_use.input.prompt`. This is the correlation key.
- The parent's Task `tool_result` contains **no** `agentId` (checked: no 16-hex refs), so there is no
  direct id link — content-match is the available join.

**Already wired (to be superseded as the tree's source):** `wshcmd-agenthook.go` emits `PreToolUse{Task}`
→ subagent *start* (keyed by `tool_use_id`, with `subagent_type`) and `SubagentStop` → *stop* (no
status); `agentstatusstore.ts` reduces these into `getSubagentsAtom(oref)` with a 60s TTL and an
idle-clear; `agenttree.tsx` renders the rows. The status-less stop is why ✓/✗ never appear; the
idle-clear is why there is no history; the `tool_use_id` key does not match the on-disk `agentId`, which
is why this path cannot open an interior.

## 5. Architecture

```
Claude Code (parent in a terminal block)
  ├─ writes parent transcript  <parentDir>/<sessionId>.jsonl        (Task tool_use + tool_result)
  └─ writes child transcripts  <parentDir>/<sessionId>/subagents/agent-<agentId>.jsonl
        │
        ▼  (glob + head-read; filesystem access)
  wavesrv:  GetSubagentsCommand(parentTranscriptPath)
        │     -> []{ agentId, transcriptPath, firstPrompt, startedAtMs }
        ▼
  Frontend
    • subagentsstore.ts   loads on focus + on parent-transcript activity (debounced)
    • extractSubagentSpawns(parentLines)  -> []{ toolUseId, subagentType, prompt, done, failed }   (pure)
    • correlateSubagents(spawns, files)   -> SubagentVM[] { agentId, transcriptPath, type, state }  (pure)
        │
        ├─ agenttree.tsx   child rows (existing UI) now fed by the disk store; onClick -> focusSubagentAtom
        └─ agentsurface.tsx center: focusSubagentAtom set ->
              breadcrumb (◂ parent › <type>) + <NarrationTimeline> fed by livetranscript(child path);
              terminal stack hidden (not unmounted). Esc / breadcrumb clears -> parent terminal returns.
```

## 6. Backend — `GetSubagentsCommand`

New wshrpc command (regenerated bindings via `task generate`). Input: the parent transcript path (already
carried on the agent as `AgentStatusData.TranscriptPath`). Behavior:

1. Derive the dir: `<dir(path)>/<basename(path) without .jsonl>/subagents/`.
2. Glob `agent-*.jsonl`.
3. For each, **head-read the first record** → `{ agentId, firstPrompt (first user message text),
   startedAtMs (record timestamp or file mtime) }` and its `transcriptPath`.
4. Return `[]SubagentFileInfo`. Missing dir → empty slice (not an error).

Deliberately no correlation, no outcome logic, no tail — those are pure TS (§7). Tailing a selected
child reuses `GetAgentTranscriptCommand` unchanged. Go test over a fixture `subagents/` dir.

## 7. Frontend

- **`transcriptprojection.ts` — `extractSubagentSpawns(lines)` (pure, new).** Walks Task `tool_use`
  blocks → `{ toolUseId, subagentType, prompt }`; matches each to its `tool_result` → `{ done, failed }`
  (`is_error`). Mirrors the existing `extractTasks`. Table-driven tests.
- **`correlateSubagents(spawns, files)` (pure, new).** Join by `firstPrompt === prompt`
  (whitespace-normalized; prefix fallback; `startedAt` tie-break) → `SubagentVM { agentId,
  transcriptPath, type, state }` where `state = !done ? "working" : failed ? "failure" : "success"`.
- **`subagentsstore.ts` (new).** Atom family keyed by parent id. Loads `GetSubagentsCommand` on focus and
  on parent-transcript activity (debounced ~4s, the `cardgitstore` pattern), correlates against the
  parent's already-streamed spawns (from `livetranscript`), exposes `SubagentVM[]`. Persists for the
  session (no idle-clear).
- **`agenttree.tsx`.** Point the child rows at the disk store instead of `getSubagentsAtom`. The row UI
  (connectors, colored dots, expand/count) is unchanged; ✓/✗ now actually populate. Add `onClick` on a
  child row → set `focusSubagentAtom { parentId, agentId, transcriptPath, label }`.
- **`agentsurface.tsx` center.** When `focusSubagentAtom` is set and its parent is focused, render a
  **breadcrumb bar** (`◂ <parent> › <type>`, click/Esc to return) + `<NarrationTimeline>` fed by
  `livetranscript` tailing the child `transcriptPath`, as an overlay; set the keep-alive terminal stack
  to `hidden` (never unmount — preserves the TUI anti-stacking invariant documented in the file).

**Rejected placements** (from the visual brainstorm): *split center* (parent + child side-by-side) — good
"control room" feel but costs horizontal room at cockpit density; *right drawer* — fights the details
rail for the right edge. Center-swap won on simplicity and pane reuse.

## 8. Reuse & what we don't build

- **Renderer:** reuse `projectTranscript` + `NarrationTimeline`. The child JSONL is byte-compatible.
- **Streaming:** reuse `livetranscript.ts` + `GetAgentTranscriptCommand` (tails any path).
- **Tree UI:** reuse `agenttree.tsx` rows.
- **Vestigial:** the hook subagent path (`agenthook.go` deltas, `agentstatusstore` reducer/TTL,
  `baseds.AgentSubagentDelta`) is no longer the tree's source. Left dormant in v1 (removing it is a
  separate change with its own blast radius); flagged for a later cleanup once the disk path is proven.

## 9. Risk / Phase 0 spike

**The one gate:** confirm `child.firstUserMessage === parentTask.input.prompt` is a reliable exact match
across real multi-subagent transcripts (including parallel same-type spawns). Dump a handful of live
spawns and compare. If exact equality is flaky: whitespace-normalize, then prefix-match on the first N
chars, then tie-break by `startedAt` order. Gate: is the join reliable enough to key the interior link?
If not even the fallback holds, the tree stays disk-backed for interior/history but the *type label*
degrades to "first line of prompt" — the feature still ships, minus the pretty `Explore`/`Plan` label.

Everything else is low-risk reuse of proven machinery.

## 10. Testing

- **Pure functions:** `extractSubagentSpawns`, `correlateSubagents` — table-driven over parallel spawns,
  same-type spawns, error outcomes, missing matches.
- **Backend:** `GetSubagentsCommand` — Go test over a fixture `subagents/` dir (present, empty, missing).
- **View seam:** center-swap sets/clears on select and Esc; terminal stack stays mounted (hidden), not
  remounted.

## 11. Out of scope / follow-ups

1. **Cockpit-card fan-out badge** (`⑃ N` + peek on `agentrow.tsx`) — the deferred v1 half; brings fan-out
   to the at-a-glance grid.
2. **Codex subagents** — if/when Codex grows per-subagent files.
3. **Retire the vestigial hook path** — delete once disk-source-of-truth is proven in the field.
4. **Deep nesting** — a child that itself fans out.
