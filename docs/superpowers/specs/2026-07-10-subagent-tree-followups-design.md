# Subagent-tree v1 follow-ups — design

**Date:** 2026-07-10
**Status:** Design approved (brainstorm complete); plan pending
**Base:** Completes three of the four follow-ups parked by the shipped *Subagent Interior View*
(`docs/superpowers/specs/2026-07-09-subagent-interior-view-design.md` §11). The interior, the disk-backed
tree, and real per-child success/failure already ship. This spec closes the remaining actionable gaps.

## 1. What this adds

Three independent follow-ups on the shared disk-backed subagent data layer
(`GetSubagentsCommand` → `SubagentFileInfo` → `correlateSubagents` → `SubagentVM[]` in `subagentsByIdAtom`):

- **#5 — child-file "done" signal.** Kill the perpetual "working" dot on the ~4% of children that never
  resolve because their spawn has no parent `Task` `tool_result` (workflow/Workflow-tool orchestrated).
- **#3 — retire the vestigial hook path.** Migrate the two surfaces still reading the ephemeral,
  hook-fed `getSubagentsAtom` onto the disk store, then delete the dead subagent-delta path.
- **#1 — cockpit-card fan-out badge.** Bring fan-out to the at-a-glance grid: a `⑃ N` badge + peek on
  the card (`agentrow.tsx`), fed by the same disk store the focused-view tree already uses.

Two of the original four follow-ups are **closed, not built** (see §9): **Codex subagents** (no
per-subagent transcript files exist) and **deep nesting** (0 nested `subagents/*/subagents` dirs across
619 real child files — Claude Code writes a flat layout; Task-tool subagents cannot spawn tracked
subagents).

## 2. Goals & non-goals

**Goals**
- A terminated orphan child resolves to an honest **`done`** state instead of a misleading "working".
- One source of subagent truth (the disk store); the ephemeral hook subagent path is gone.
- The card grid shows fan-out at a glance, consistent with the focused-view tree.

**Non-goals**
- Deriving success/failure for orphan children. The child file carries no accept/reject signal (only that
  it finished), so `done` is deliberately outcome-neutral. Real ✓/✗ stays reserved for children the
  parent judged via `tool_result.is_error`.
- Steering/replying to a subagent (read-only, per the interior spec).
- Codex subagents and deep nesting (§9 — closed with evidence).
- Reworking the tree/interior UI that already ships.

## 3. Scope decisions

| Decision | Choice | Rationale |
|---|---|---|
| Orphan-resolved state | **New neutral `done`** (not reuse `success`) | `end_turn` proves the child *finished*, not that the parent accepted it. `success`/`failure` remain the parent's real judgment; conflating "finished" with "succeeded" would make the green dot meaningless. |
| "Done" detection source | **Tail-read the child's last record** in the backend | The child file has no explicit terminal marker field, but empirically its last record is always a final assistant text turn (§4). Detecting that is a one-record read; no new stream, no parsing in the WebView. |
| Hook-path retirement | **Migrate consumers first, then delete** | `getSubagentsAtom` is *not* dead (deferred.md was stale) — the rail and the Runs orchestrator still read it live. Delete only after both move to the disk store. |
| Card load wiring | **Extract the tree's load effect into a shared hook** | The grid (`cockpitsurface.tsx`) has zero subagent awareness. The tree already loads the store for every roster agent; DRY that effect so the grid and the Runs surface reuse it rather than copy it. |
| Nested rendering | **Not built** | 0 nested dirs on disk (§9). Building recursion for non-existent data is YAGNI; the current flat rendering is already the correct graceful fallback. |

## 4. Evidence — how a child transcript terminates (verified 2026-07-10)

Scanned all 619 `subagents/agent-*.jsonl` under `~/.claude/projects`:

- **Last record is always a text block** (619/619 `('text',)`); **0** files end on a pending `tool_use`.
- Last-record type: 596 `assistant`, 23 `user`.
- `stop_reason`: 502 `end_turn`, 2 `stop_sequence`, 115 absent (the `user` tails + assistants without the
  field).
- **0** nested `*/subagents/*/subagents` directories.

**Terminal rule:** a child is **done** when its last record is a terminal assistant turn — a `text` block
with `stop_reason` `end_turn`/`stop_sequence` and no pending `tool_use`. A live child, by contrast, has a
trailing `tool_use` (awaiting result) or a `user` `tool_result` record mid-flight. The only imprecision is
a child read in the instant between its final text and the parent recording the `tool_result` — it shows
`done` a few seconds before it would show `success`/`failure`. Acceptable.

## 5. Shared foundation (prerequisite for all tracks)

**(a) `SubagentState` gains `done`.** `frontend/app/view/agents/session-models/sessionviewmodel.ts:13`:
`"working" | "success" | "failure" | "done"`. Consumers add a neutral color for it: the tree's `SUB_COLOR`
map (`agenttree.tsx`), the Runs inline dot ternary (`runssurface.tsx`), and the new card peek. `done` uses
a muted/secondary token (no green). `rollUpStatus` and `subagentExpanded` are unchanged and already correct
— a `done` child is not "working", so it neither lifts the parent dot nor forces auto-expand.

**(b) Extract `useSubagentTracking(agents)`.** Lift the disk-load effect from `agenttree.tsx:192-218`
(refresh-on-enter, `scheduleSubagents` debounce-on-activity via `lastActivityByIdAtom`, `dropSubagents`
on-leave) into a hook co-located with `subagentsstore.ts`. The tree switches to the hook (pure refactor).
It is then reused by the card grid (#1) and the Runs surface (#3), so the load logic lives once.

## 6. Track A — #5 child-file "done" signal

**Backend** (`pkg/wshrpc/wshserver` `listSubagents` + `SubagentFileInfo`): today it head-reads the first
record. Add a **tail-read of the last record** and set a new `Done bool` on `SubagentFileInfo` per the
§4 terminal rule (also carry the terminal timestamp if cheap, for future ordering — optional). Missing/
unreadable file → `Done:false`. Regenerate bindings (`task generate`). Go test over fixtures: a terminated
child, a mid-run child (trailing `tool_use`), and an empty dir.

**Pure** (`correlateSubagents`, `subagentcorrelate.ts`): extend the fallback. Current logic leaves an
unmatched file `"working"`; change to:

- spawn matched → `state` from the spawn (`!done → working`, `failed → failure`, else `success`) — unchanged.
- **no spawn match + `file.done` → `"done"`** (new).
- no spawn match + not done → `"working"` (unchanged).

Extend `subagentcorrelate.test.ts` with the orphan-done and orphan-working cases.

## 7. Track B — #3 retire the vestigial hook path

**Migrate consumers to the disk store:**

1. **`agentdetailsrail.tsx:56`** — replace `useAtomValue(getSubagentsAtom(\`block:${agent.blockId}\`))`
   with `useAtomValue(subagentsByIdAtom)[agent.id] ?? []`. The rail renders inside the focused view, where
   the tree already populates the store for `agent.id` — no new load needed.
2. **`runssurface.tsx` `SubagentRows`** — it is called `leadId={w.id}` where `w` is a worker `AgentVM`
   carrying `w.transcriptPath`. Load the run's workers via the shared `useSubagentTracking` hook (at the
   `PhaseRail`/`RunsView` level, over `workers`), and read `subagentsByIdAtom[leadId]` in `SubagentRows`.

**Delete the dead path (only after 1–2 land):**

- `agentstatusstore.ts` — remove the `if (data.subagent != null) {…}` reduce block, the idle-clear of the
  subagent list/expand inside the `data.state` branch, `getSubagentsAtom`, `scheduleSubagentExpiry`,
  `normalizeSubagentStatus`, `COMPLETED_SUBAGENT_TTL_MS`, and the `reduceSubagents`/`SubagentDelta` import.
  **Keep** the usage + rate-limit branch, the `data.state` status atom + `persistClaudeResume`, and the
  expand atoms (`getSubagentExpandAtom`/`toggleSubagentExpand` — the disk tree uses them).
- `sessionviewmodel.ts` — remove `reduceSubagents` and `SubagentDelta`. **Keep** `SubagentVM`,
  `SubagentState`, `rollUpStatus`, `subagentExpanded`.
- `pkg/baseds/baseds.go` — remove `AgentSubagentDelta`, the `SubagentAction_*`/`SubagentStatus_*` constants,
  and the `AgentStatusData.Subagent` field. Regenerate bindings.
- `cmd/wsh/cmd/wshcmd-agenthook.go` — remove the `agentEmission.Subagent` field, the `SubagentStop` case,
  and the subagent-delta half of the `Task` `PreToolUse` branch. **Keep** the parent-state `working`
  emission that the same Task branch produces (line 33-34 note).
- `sessionsidebarmodel.ts:79` — clean its `getSubagentsAtom` read (legacy sidebar model; confirm live vs
  dead during the plan and remove accordingly).

Go build + `task generate` + tsc must be clean after deletion (unused-symbol errors are the checklist).

## 8. Track C — #1 cockpit-card fan-out badge

- **`cockpitsurface.tsx`** — call `useSubagentTracking(agents)` (the §5b hook) so the grid populates
  `subagentsByIdAtom` for every rendered card. Currently the grid loads nothing.
- **`agentrow.tsx`** — read `subagentsByIdAtom[agent.id]`. When non-empty, render a `⑃ N` badge in the
  card's status band (near the diff-stats affordance). Hover → a compact **peek** popover listing each
  child (state dot + `type`), reusing the tree row's visual vocabulary. The badge/peek is read-only;
  clicking focuses the agent (`focusIdAtom`) so its tree + interior are one step away. No new RPC, no new
  store — a second consumer of the existing atom.

## 9. Out of scope (closed with evidence, recorded in deferred.md)

- **#2 Codex subagents** — no per-subagent transcript files exist for Codex; parents show no children
  (graceful degradation). Reopen if/when Codex grows per-subagent files.
- **#4 Deep nesting (depth > 1)** — 0 nested `subagents/*/subagents` dirs across 619 real files; CC writes
  a flat layout. Reopen only if a nested child file is ever observed. Current flat rendering already
  degrades correctly.

## 10. Testing

- **Pure:** `correlateSubagents` orphan-`done`/orphan-`working` (Track A); existing spawn-match tests stay
  green through the deletion (Track B).
- **Backend:** `GetSubagentsCommand` tail-read over fixtures — terminated, mid-run, empty (Track A).
- **Build gates:** Go build, `task generate`, and `node --stack-size=4000 …/tsc.js --noEmit` clean after
  the deletion (Track B) — unused symbols are the completeness check.
- **Visual (CDP, no jsdom harness):** the `⑃ N` badge + peek on the grid (Track C); rail + Runs subagent
  rows still populate after migration (Track B). `scripts/cdp-shot.mjs`.

## 11. Rollout, ordering & independence

Land order (each its own commit; spec folds into the first per the repo git rule):

1. **Shared foundation** (§5): `done` state + `useSubagentTracking` extraction (tree refactor).
2. **Track A** (#5): backend done-signal + `correlateSubagents` fallback — improves every consumer.
3. **Track B** (#3): migrate rail + Runs, then delete the hook path.
4. **Track C** (#1): grid load + card badge/peek.

The foundation lands first because both #1 and #3-Runs consume the shared hook and the `done` state. After
that the three tracks are independent — any can be deferred without blocking the others (e.g. if the Runs
`transcriptPath` proves unreachable in some run shape, that migration and the final deletion wait while #5
and #1 still ship).
