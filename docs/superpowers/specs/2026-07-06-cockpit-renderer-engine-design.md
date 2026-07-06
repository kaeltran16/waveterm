# Cockpit renderer P1 — the engine

**Date:** 2026-07-06
**Status:** Design spec. Phase 1 of the [renderer roadmap](./2026-07-06-cockpit-renderer-roadmap.md).
**Scope:** Frontend only. No backend changes.

## Problem

The transcript feed reduces every tool call to `verb + target` and discards `tool_result` content,
so you cannot see what an agent actually changed or what its commands printed without dropping into
the terminal. A busy agent (dozens of edits) also can't be shown richly inline without the card
exploding.

## Goal

Build the reusable engine that makes tool work legible, and prove it with the three highest-value
tools: **Edit/Write** (diffs) and **Bash** (command output). Deliver:

- A projection that retains structured per-action **detail** from the transcript.
- A feed that **coalesces by target** so scale never floods the card, with richer always-on tool
  lines and **failures floated up**.
- A **universal detail modal** — the single drill-in for full content.

## Non-goals

- Grep/Read/Web/MCP/Skill rendering (P2), prose/thinking/timestamps (P3), subagents (deferred).
- Any change to the git Diff surface — it stays the separate repo's-eye view.
- Syntax highlighting or new dependencies.

## Design

### 1. Data model — `ActionDetail` (in `agentsviewmodel.ts`, beside `AgentEntry`)

The `action` variant of `AgentEntry` (`agentsviewmodel.ts:12`) gains an **optional** `detail`. Optional
is load-bearing: every existing consumer (`NarrationTimeline`, `recentActions`, `summarizeActions`,
`AgentDetailsRail`, the Codex projector) keeps working untouched.

```ts
export interface EditHunk { old: string; new: string; add: number; del: number }

export type ActionDetail =
    | { type: "edit"; file: string; hunks: EditHunk[] }              // Edit / MultiEdit / Write
    | { type: "run"; command: string; output?: string; isError?: boolean }; // Bash
// P2 extends this union: "search" | "read" | "web" | "skill". P1 ships only edit + run.

export type AgentEntry =
    | { kind: "message"; text: string }
    | { kind: "user"; text: string }
    | { kind: "action"; verb: string; target: string; outcome?: "ok" | "fail"; note?: string;
        detail?: ActionDetail };
```

- **Write** has no prior content in the transcript → represented as one all-additions hunk
  (`old: ""`, `add: <lines>`, `del: 0`) so the modal renders it uniformly.
- **`add`/`del`** are line counts derived from the hunk strings (`new`/`old` newline counts). This
  is an approximation (a one-line replace counts +1/−1), which is accurate enough for a summary and
  needs no diff library. `replace_all` edits count a single occurrence; noted as a known limitation.

### 2. Projection (`transcriptprojection.ts`)

`projectTranscript` already walks `tool_use` and `tool_result` blocks. Extend it to populate `detail`:

- `Edit` → `{type:"edit", file, hunks:[{old:old_string, new:new_string, …}]}`.
- `MultiEdit` → one `edit` detail with a hunk per `edits[]` entry.
- `Write` → `{type:"edit", file, hunks:[{old:"", new:content, …}]}`.
- `Bash` → `{type:"run", command}`; on the matching `tool_result`, set `output` and `isError`.
- A helper normalizes `tool_result.content` (which is a **string OR an array of `{type:"text",text}`**)
  into one string.

**Size cap:** `output` and each hunk string are capped in the projection (e.g. head+tail to ~8 KB /
~200 lines with a `"…N lines elided…"` marker) so accumulated `detail` cannot grow unbounded as the
streamed line buffer grows. The cap constant lives with the projector.

Stays pure/deterministic. The `TranscriptProjector.project` signature is unchanged — `detail` rides
inside the returned `AgentEntry[]`, so it flows to every consumer automatically. The **Codex**
projector is not modified in P1; it simply omits `detail` (graceful).

### 3. Feed — coalesce by target (`agentsviewmodel.ts` + `narrationtimeline.tsx`)

**New pure function** (beside `groupTimeline`/`summarizeActions`, unit-tested):

```ts
export interface GroupRollup {
    files: { file: string; add: number; del: number; edits: number }[]; // edit details, merged by file
    commands: { command: string; isError: boolean; index: number }[];   // run details
    others: { verb: string; count: number }[];                          // everything else, counted
}
export function rollupGroup(actions: AgentActionEntry[]): GroupRollup;
```

`NarrationTimeline`'s `group` branch (currently the weak "6 tools · 4 read" summary,
`narrationtimeline.tsx:125-155`) renders the rollup instead:

- **File rows** — `auth.go +40 −12 · 5 edits`, click → modal focused on that file.
- **Command rows** — `ran go test · exit 1`; a failed command shows a **one-line** error summary
  (last non-empty output line) inline and is not folded; successes stay counted. Click → modal.
- **Others** — the existing per-verb counts.

Short runs (< `CollapseRunThreshold`) still render as individual `ToolLine`s, now enriched: an edit
line shows `+add −del`, a run line shows exit state. Any line with `detail` is clickable → modal.

Coalescing here is **per burst** (chronological), consistent with `groupTimeline`.

### 4. Universal detail modal (`agentdetailmodal.tsx`, new)

- **Data source:** reads the agent's entries live — `liveEntriesByIdAtom[agentId] ?? previousInfo`
  (`livetranscript.ts`) — and aggregates **globally per target**: all `edit` details merged by file
  (full agent diff for each file), all `run` details as commands.
- **Layout:** left sidebar = *Files* (with +/− stats) + *Commands* (with ✓/✗); right pane adapts —
  a file renders its `old→new` hunks (all edits, in order); a command renders its full `output`.
- **Open state:** a small store `agentdetailmodalstore.ts` holds
  `{ agentId, focus: {kind:"file"|"command", key} } | null`. Feed click sets it; Esc/backdrop clears.
- **Host:** reuse the cockpit's modal infrastructure. Implementation picks between the
  `modalsModel`/`ModalsRenderer` registry (`frontend/app/modals`) and the open-atom + conditional-mount
  pattern the cockpit's own modals use (`newagentmodal`, etc.); the plan decides after a closer look.
- **Extensibility (deferred hooks):** the right pane switches on `ActionDetail.type`, so P2 panes
  (search/web/skill) and a later subagent pane are additive.

## Data flow

```
StreamAgentTranscriptCommand
  → projectTranscript (+detail)            [transcriptprojection.ts]
  → liveEntriesByIdAtom                     [livetranscript.ts]
  → NarrationTimeline (rollupGroup, enriched ToolLine)   [narrationtimeline.tsx]
  → click sets agentdetailmodalstore
  → AgentDetailModal (global per-target aggregation)     [agentdetailmodal.tsx]
```

## Testing

No jsdom/render harness exists; pure logic is unit-tested and appearance is verified live over CDP
(`scripts/cdp-shot.mjs`).

- `transcriptprojection.test.ts` — extend: Edit/MultiEdit/Write → `edit` detail + correct `add/del`;
  Bash → `run` detail with output; `tool_result` content as **both** string and array forms;
  `is_error` → `isError`; size-cap elision.
- `timelinerollup.test.ts` (new) — `rollupGroup`: merges edits by file with summed stats + edit
  counts; groups commands; failure flagged; others counted; empty input.
- Manual/CDP: feed rollup rows, failure one-liner, modal open/aggregate/switch/close.

## Files touched

- `agentsviewmodel.ts` — `ActionDetail`/`EditHunk` types; `detail?` on the action entry; `rollupGroup`.
- `transcriptprojection.ts` — populate `detail`; `tool_result` content normalizer; size cap.
- `narrationtimeline.tsx` — enriched `ToolLine`; rollup-based `group` render; failure one-liner; click→modal.
- `agentdetailmodal.tsx` *(new)* — the modal.
- `agentdetailmodalstore.ts` *(new)* — open-state atom.
- `cockpitsurface.tsx` (or the chosen modal host) — mount the modal.
- Tests: `transcriptprojection.test.ts`, `timelinerollup.test.ts` *(new)*.

## Risks & open questions

- **Perf/memory:** `projectTranscript` re-projects the whole accumulated line buffer per chunk;
  `detail` adds arrays. The size cap bounds per-payload growth; the stream already tail-limits to
  300 lines. Watch for large-session cost during CDP verification.
- **Stat accuracy:** newline-count `add/del` and `replace_all` single-count are deliberate
  approximations. Acceptable for a summary; revisit only if it misleads.
- **Modal host choice** — registry vs open-atom pattern — resolved in the plan.
- **Codex** shows no `detail` until its projector is extended (out of P1 scope) — graceful, not a bug.

## Out of scope

Git Diff surface; backend; P2/P3 tool types and prose; subagents.
