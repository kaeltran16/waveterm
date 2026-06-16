# Session Reordering + Model Display in the Sidebar — Design Spec

**Date:** 2026-06-16
**Status:** Design approved (brainstorm complete)
**Base:** Extends [Wave Agent Sessions](./2026-06-12-wave-agent-sessions-design.md) and [Subagent Visibility](./2026-06-15-subagent-visibility-design.md). Additive only — no change to the session-as-tab model, grouping, or the status/subagent event path.
**Mechanism verified** against the live reporter (`agent-status-spike/agent_status_reporter.py`), the user's real Claude Code transcripts, and current Claude Code hook docs (`code.claude.com/docs/en/hooks`) on 2026-06-16.

## 1. What this adds

Two independent sidebar enhancements, requested together:

- **A — Reorder within a group:** drag a session row to a new position among its group-mates. Today within-group order is fixed (first-appearance in `workspace.tabids`).
- **B — Model display:** show which model each session — and each subagent — is running, as a quiet right-aligned tag. Verified that subagents genuinely diverge from the parent (e.g. a subagent on `claude-sonnet-4-6` under an opus parent), so per-subagent model is real signal, not noise.

The two share nothing but the sidebar; they can ship in either order (A is simpler and fully unblocked).

## 2. Goals & non-goals

**Goals:**
- Drag a row to re-position it within its group; the new order persists and survives reload.
- At a glance, see the model of each active session and of each subagent it spawned, while work is happening.

**Non-goals (v1):**
- Cross-group drag (moving a session into a *different* cwd group). Out — a session's group is its working directory; dragging across groups would imply a cwd change. A cross-group drop is a no-op.
- A separate sidebar-only ordering independent of the tab bar (see §4 — we reuse `tabids`).
- Showing a subagent's model at the instant of spawn — it does not exist yet (§5). It appears a beat into the subagent's run.
- Per-message / per-turn model history. Only the current model.

## 3. Feature A — Reorder within a group

### 3.1 Mechanism
Native HTML5 drag-and-drop, matching the existing tab bar (`frontend/app/tab/vtab.tsx:150` uses `draggable` + `onDragStart/Over/Drop/End`, no drag library — also satisfies "minimize dependencies").

- `SessionRow` becomes `draggable`. `onDragStart` records the dragged `tabId` and its group key.
- `onDragOver` on a row in the **same group** shows an insertion indicator (top/bottom border) and allows the drop; on a different-group row it does not.
- `onDrop` computes the new member order and persists it. `onDragEnd` clears drag state.

### 3.2 Persistence — single source of truth
Reordering rewrites `workspace.tabids` and persists via the existing **`UpdateWorkspaceTabIdsCommand`** RPC (the same call the tab bar uses, `tabbar.tsx:448`). Consequence, accepted: **the tab bar order changes too.** One order, no divergence. The rejected alternative — a separate `session:order` meta — adds state and lets the two views disagree (YAGNI).

### 3.3 The slot-preserving reorder (pure function)
A group's rows are not necessarily contiguous in `tabids` (other groups can interleave). So we do **not** splice the array. Instead we keep the exact slot positions the group already occupies and rewrite only those slots with the new member order:

```ts
// pure, no React / no runtime imports — lives in sessionviewmodel.ts
reorderWithinGroup(
  tabids: string[],
  memberIds: string[],   // the group's tabIds, in current visual order
  draggedId: string,
  targetId: string,
  placeBefore: boolean,
): string[]
// 1. newOrder = memberIds with draggedId removed, re-inserted before/after targetId
// 2. slots = memberIds.map(id => tabids.indexOf(id)).sort(asc)   // positions the group owns
// 3. result = [...tabids]; slots.forEach((slot, i) => result[slot] = newOrder[i])
```

This guarantees group order (first-appearance) and every other group stay byte-for-byte identical; only the within-group sequence changes. Works unchanged for the **Pinned** group (`memberIds` = pinned tabIds). A drag that resolves to the same position returns the input unchanged (no RPC).

### 3.4 Wiring
- `sessionviewmodel.ts`: add `reorderWithinGroup` (pure).
- `sessionsidebarmodel.ts`: add `reorderSession(memberIds, draggedId, targetId, placeBefore)` — reads `tabids`, calls `reorderWithinGroup`, fires `UpdateWorkspaceTabIdsCommand`; no-op if order unchanged or workspace missing.
- `sessionrow.tsx`: drag props + insertion indicator.
- `sessionsidebar.tsx`: pass the group's `memberIds` and drag handlers into each row.

## 4. Feature B — Model display

### 4.1 Verified data reality (why this shape)
| Question | Finding |
|---|---|
| Is the model in hook payloads? | **No.** Only `SessionStart` *may* carry `model` (not guaranteed); `PreToolUse`/`PostToolUse`/`Stop`/`SubagentStart`/`SubagentStop` do not. No `$CLAUDE_MODEL` env var. |
| Where is it then? | The **transcript JSONL** records `"model":"claude-opus-4-8"` on each assistant message — in both the parent transcript and each subagent's own `…/<session>/subagents/agent-<id>.jsonl`. Every hook payload carries `transcript_path`. |
| When does a subagent's model exist? | Only on its **first assistant response** (≈line 4 of its transcript). At `SubagentStart` the transcript holds only the prompt — no model yet. |
| Do subagents differ from the parent? | **Yes** (observed `claude-sonnet-4-6` subagent under an opus parent). So per-subagent model is informative. |

Conclusion: the model must come from the **reporter reading the transcript**; Wave stays a passthrough for a `model` string. The earliest a subagent's model is knowable is a beat into its run — so the reporter polls for it (§4.3).

### 4.2 Data path (rides the existing reporter → event → atom path)
```
reporter reads model from transcript
  parent:   tail-read last assistant "model" from transcript_path  (on every state report)
  subagent: poll …/subagents/agent-<id>.jsonl for first "model"    (after SubagentStart)
  → wsh agentstatus … --model claude-opus-4-8
  → AgentStatusData.Model  /  AgentSubagentDelta.Model     (new field)
  → event → atom → SessionRowVM.model / SubagentVM.model
  → quiet right-aligned tag; modelLabel(id) -> "opus"  (full id on hover title)
```

### 4.3 Reporter changes (`agent-status-spike/agent_status_reporter.py`, outside this repo)
- `read_last_model(path)` — bounded **tail** read (~last 64KB) for the parent's current model. O(64KB) regardless of session length.
- `read_first_model(path)` — head scan for the first assistant `"model"` (subagent).
- Derive the subagent transcript path from the payload (`transcript_path` dir + `session_id` + `subagents/agent-<agent_id>.jsonl`).
- Parent state events (working/waiting/idle): append `--model <id>` from `read_last_model`.
- `SubagentStart`: emit the start delta **immediately** (row appears as working, unchanged), then a **bounded poll** (~250ms interval, ~5s ceiling) on the subagent transcript; on first model, emit a **model-update** delta. Times out silently if the subagent errors before responding.
- `SubagentStop`: emit stop; also carry `--model` (read from the subagent transcript) as a backstop for very fast subagents the poll missed.
- All reads/polls are async (hook is `"async": true`) and failures are swallowed — a reporter fault must never surface to the agent.

### 4.4 Transport + reducer (Wave)
- `pkg/baseds/baseds.go`: add `Model string \`json:"model,omitempty"\`` to `AgentStatusData` **and** `AgentSubagentDelta`; add `SubagentAction_Model = "model"`.
- `cmd/wsh/cmd/wshcmd-agentstatus.go`: add `--model` (string) and `--subagent-model` (bool). `--subagent-model --id X --model Y` publishes a delta with `Action: model`. `--model` also populates parent `AgentStatusData.Model` and is accepted on `--subagent-stop`.
- `task generate` regenerates `frontend/types/gotypes.d.ts`.
- `sessionviewmodel.ts`:
  - `SubagentVM` gains `model?`. `SubagentDelta.action` gains `"model"` and `model?`.
  - `reduceSubagents` handles `"model"`: update the matching subagent's `model` in place (append a `working` entry with the model if its start was missed). `start`/`stop` are unchanged except they may also carry `model`.
  - `SessionInput` and `SessionRowVM` gain `model?`; `toRow` passes it through.
  - new pure `modelLabel(id?: string): string` → `opus` / `sonnet` / `haiku` / `fable` by substring, else a trimmed fallback.
- `agentstatusstore.ts`: map `data.subagent.action === "model"` to a `"model"` delta carrying `data.subagent.model`; thread `model` on start/stop too; the parent status atom already stores the full `AgentStatusData` (now incl. `model`).
- `sessionsidebarmodel.ts`: pull `agentStatus.model` into `SessionInput.model`.

### 4.5 UI
- **Session row:** a quiet, dim, lowercase model tag, right-aligned (`ml-auto`), left of the subagent count / hover icons; `title` shows the full model id. Rendered whenever a model is known.
- **Subagent row:** the model tag is shown **only when it differs from the parent's model**, to keep the inline tree calm (most subagents inherit the parent — showing it everywhere is noise; the *exceptions* are the signal). Requires passing the parent model down to `SubagentRow`.
- **Exact styling (size/color/weight) is finalized against rendered rows during implementation.** Static mockups did not adequately convey density on the ~210px column; the reliable judgment is on the real component. The data/architecture above is fixed; only the visual polish is deferred to live tuning.

## 5. Risks & open items
- **Undocumented-format coupling.** Transcript layout and the per-message `model` field are not contract-guaranteed; a future Claude Code change degrades model tags to blank (fail-soft, nothing else breaks). This is the feature's real cost and lives outside this repo (the reporter).
- **Fast subagents.** A subagent that finishes before the poll catches its first model falls back to the `SubagentStop` model read; if even that is empty, no tag (acceptable).
- **Fan-out resource blip.** Heavy parallel fan-out keeps N short-lived idle poller processes alive ≤5s each — a transient, bounded memory blip on the dev machine; the agent is never blocked (async, off critical path).
- **Codex parity.** Model display depends on the reporter; for non-Claude agents without a transcript in this format, tags simply don't appear (graceful degradation), same posture as subagent visibility.

## 6. Testing
- **`reorderWithinGroup` (pure):** table tests — move up/down, interleaved groups untouched, pinned group, no-op when position unchanged, single-member group.
- **`modelLabel` (pure):** id → label incl. unknown-id fallback.
- **`reduceSubagents` (pure):** `model` updates an existing subagent; `model` before `start` appends a working entry; `stop` after `model` preserves the model; `model` action never changes `state`.
- **Reporter (pure parts, in the spike):** `decide()` emits `--model` on parent states; transcript model extraction (`read_first_model`/`read_last_model`) over sample JSONL.
- **`SessionRow` / `SubagentRow` render:** session tag shows on known model; subagent tag shows only when ≠ parent.

## 7. Suggested implementation order
1. **Feature A** (reorder) — self-contained, no reporter dependency, immediate value.
2. **Feature B transport** — `baseds` + `wsh --model/--subagent-model` + `task generate`.
3. **Feature B reporter** — transcript reads + subagent poll (in the spike).
4. **Feature B frontend** — reducer `model` action, `modelLabel`, row tags + live styling tuning.
