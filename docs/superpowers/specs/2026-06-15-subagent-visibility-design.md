# Subagent Visibility in the Session Sidebar — Design Spec

**Date:** 2026-06-15
**Status:** Design approved (brainstorm complete); depends on Phase 2 event work
**Base:** Extends [Wave Agent Sessions](./2026-06-12-wave-agent-sessions-design.md). Additive only — no change to the session-as-tab model, grouping, or pinning.
**Mechanism verified** against current Claude Code docs (`code.claude.com/docs/en/hooks`, `/sub-agents`, `/agent-view`) on 2026-06-15.

## 1. What this adds

A coding-agent session (one Wave tab = one terminal running Claude Code / Codex) can fork **subagents** mid-turn. Today the sidebar collapses all of that into one row + one dot, so you can't tell a session spun up five workers from one that's sitting idle.

This adds **one concept**: a session row can reveal the subagents it spawned, as an inline tree of child rows, auto-expanded while work is happening. It surfaces the subagent **lifecycle** (started → finished, which type, succeeded or failed) — not their interior (see §4 for why that boundary is hard).

## 2. Goal & non-goals

**Goal:** at a glance, see which sessions have live subagents and how many, and on expand, see each subagent's type and outcome — so a user driving 5–15 agent sessions knows which ones are fanning out work versus stalled.

**Non-goals (v1):**
- Live per-subagent activity ("now editing X") — not observable from the parent (§4); explicitly out.
- Per-subagent "blocked / needs permission" amber — not observable from the parent (§4); out.
- The full task **description** per subagent — not in the documented payload (§4); the row shows subagent **type**.
- Orchestration (spawning/approving subagents from the sidebar). Visibility only.
- Persisting subagent state across reconnect — it's ephemeral and clears each turn (YAGNI).

## 3. Key decisions (and why)

| Decision | Choice | Rationale |
|---|---|---|
| Source of subagent signal | Parent-session **`SubagentStart` / `SubagentStop`** hooks | Dedicated, documented events carrying `agent_type` + `agent_id`; no inference from tool calls. Fire in the parent context, so the existing reporter (parent `.claude/settings.json`) catches them. |
| Correlation (parallel subagents) | **`agent_id`** (unique per invocation) | Documented stable key; matches start→stop without hashing descriptions. |
| Row label | Subagent **`agent_type`** (e.g. `Explore`, `Plan`, `general-purpose`) | The only identity field documented in the subagent hook payloads. Task `description` is not exposed there — see §4. Short, fits the narrow column. |
| States | `working` → `success` / `failure` (from `completion_status`) | All from `SubagentStop`. Per-subagent amber dropped — unavailable from parent (§4). |
| Presentation | **Inline tree** under the session row | User-selected. Always-visible-while-active beats on-demand for the monitoring use case. |
| Differentiation | **Tree connectors `├─ └─` + hollow marker `◦`/`✓`/`✗`** vs the session's filled `●` | User-selected. Indentation alone is ambiguous (nav already indents group→session); connectors + a different marker shape make a subagent unmistakably a child, not a peer process. |
| Expand timing | **Auto-expand on first spawn; collapse + clear on session `Stop`** | Reflow tied to the turn (~one open + one close), not per-subagent, so a ~210px column stays calm even with subagent waves. Manual toggle overrides until next turn. |
| Transport | Overload the planned **`Event_AgentStatus`** with an optional `subagent` delta | No new event constant / subscription. Smallest additive change. |
| State ownership | **Frontend reducer**, keyed by block id | Matches the spec's client-side-reactive philosophy; no backend state for ephemeral data. |

## 4. How Claude Code exposes subagents (verified)

Subagents (`Agent` tool — renamed from `Task` in v2.1.63 — i.e. the `/agents` feature) run **in the parent's process**: no `Block`, no PTY, no `WAVETERM_BLOCKID` of their own. The only parent-observable signal is hooks.

**What we get (documented, parent-context hooks):**

| Event | Key payload fields |
|---|---|
| `SubagentStart` | `agent_type`, `agent_id`, `session_id`, `cwd`, `transcript_path` |
| `SubagentStop` | `agent_id`, `agent_type`, `reason` (`completed\|error\|timeout\|cancelled`), `completion_status` (`success\|failure\|other`) |

(`PreToolUse`/`PostToolUse` on `tool_name == "Agent"`, correlatable by `tool_id`, are an equivalent fallback and the only place an undocumented task `description` *might* appear — a spike-only stretch.)

**The hard boundary — what is NOT observable from the parent:**
- **A subagent's own tool calls do not fire the parent's hooks.** Live "now editing X" requires hooks defined *inside* the subagent (its frontmatter `hooks:` or a plugin in its context). Out of scope for v1.
- **Permission prompts inside a subagent** don't surface through the parent's hook chain. Background subagents auto-deny prompts; a foreground subagent waiting on permission leaves the parent's `Agent` tool still running, so the **parent even reads as `working` (green), not blocked**. This is a known fidelity gap.

**Other channels considered and rejected for this case:**
- `claude agents --json` (v2.1.139+): polling, and explicitly **excludes in-session subagents** (lists background *sessions* only).
- Transcript JSONL (`parent_tool_use_id` tags subagent messages): not a documented stable real-time interface.
- Agent SDK streaming: only if we own the process; we don't (interactive terminal).
- OpenTelemetry / status line: no subagent data / output-only.

Conclusion: hooks (`SubagentStart`/`SubagentStop`) are the right and only clean fit, and they support exactly the lifecycle tree this spec scopes — nothing more.

## 5. Architecture (additive; rides the existing reporter → event → atom path)

```
Claude Code (parent session in a terminal block)
  │  SubagentStart {agent_type, agent_id}
  │  SubagentStop  {agent_id, completion_status}
  ▼
Reporter script (existing hook command; reads $WAVETERM_BLOCKID)
  │  wsh agentstatus --subagent-start --id <agent_id> --type <agent_type>
  │  wsh agentstatus --subagent-stop  --id <agent_id> --status <success|failure>
  ▼
wsh agentstatus (planned subcommand + new subagent flags)
  │  publishes Event_AgentStatus { subagent: {action, id, type, status} } scoped to block ORef
  ▼
Frontend
  • event sub reduces deltas into subagentsByBlock: Map<blockId, SubagentVM[]>
  • on the session's idle/Stop transition → clear that block's list
  • sessionSidebarViewModelAtom (already finds the term block per tab) attaches the list to SessionRowVM
  • SessionRow renders chevron + count; SubagentRow renders the tree child
```

- **`SubagentVM`** = `{ id, type, state: "working" | "success" | "failure" }`.
- **`Event_AgentStatus`** gains an optional `subagent?: { action: "start" | "stop"; id: string; type: string; status?: "success" | "failure" }`.
- **Parent rollup:** the session row's dot reflects children (any `working` child ⇒ parent at least `working`); the parent's own status still dominates for amber (parent blocked, unchanged).
- **Auto-expand state:** derived `expanded = manualOverride[blockId] ?? hasWorkingSubagents(blockId)`; `manualOverride` resets on the turn-end (idle) transition.

## 6. UI spec

**Session row (parent):** unchanged single line, plus — when it has ≥1 subagent this turn — a **chevron** (expand toggle; `stopPropagation` so the row click still selects the tab, mirroring the thumbtack) and a small **count badge**. Dot rolls up children.

**Subagent row (child):** rendered only when expanded.
- **Connector:** `├─` / `└─` guide (last child gets `└─`), in a dim rail color.
- **Marker:** hollow `◦` (working) → `✓` (success) / `✗` (failure) — a different *shape* than the session's filled `●`, so it never reads as a peer process.
- **Label:** `agent_type`, 13px, dim, truncated with ellipsis + `title` on hover.
- Indent ~18px beyond the session row (group → session → subagent).

**Lifecycle (per §3 timing):** idle session = collapsed, grey. First `SubagentStart` ⇒ auto-expand; children appear `working`, flip to `✓`/`✗` on stop and linger. Session `Stop` ⇒ collapse + clear. Manual collapse/expand overrides until the next turn.

## 7. Reliability, risks, open questions

- **Version dependence:** the richer `SubagentStart`/`SubagentStop` payloads (`agent_id`, `completion_status`) are documented for current Claude Code; confirm the installed version emits them. **Phase 0 spike** logs raw hook payloads to verify field presence and interleaving under parallel subagents.
- **Codex parity:** Codex's subagent/hook model is unconfirmed — verify whether it emits an equivalent start/stop signal; if not, subagent rows simply don't appear for Codex sessions (graceful degradation).
- **Parent-green-while-foreground-subagent-blocked** (§4): accepted v1 gap. A future option is shipping the reporter hook *into* subagent definitions/plugins to recover per-subagent prompts and live activity.
- **Nested subagents** (depth ≤5 for background): v1 renders one level of children; deeper nesting is flattened or ignored (decide in plan — lean: flatten to the top level).
- **Task description** on rows: only if undocumented `PreToolUse{Agent}` `tool_input` reliably carries it — spike-gated stretch goal, not v1.

## 8. Phasing

- **Phase 0 (spike, shared with parent-status spike):** add `SubagentStart`/`SubagentStop` to the reporter; log raw payloads. Confirm field presence, `agent_id` correlation, parallel interleaving, and Codex behavior. Gate: is the lifecycle signal clean enough to render?
- **Phase 2b (after `Event_AgentStatus` exists):** subagent flags on `wsh agentstatus`; payload extension; frontend reducer + `subagentsByBlock`; `SubagentRow` + chevron/count + auto-expand. (Cannot ride the Phase 0 `wsh badge` spike — a badge carries one status, not a list.)
- **Phase 3 (polish):** persisted manual-expand prefs, success/failure counts on the collapsed badge, optional task-description label if the spike proved it reachable.

## 9. Testing

- **Reducer = pure function:** `(prior list, Event_AgentStatus delta) → list`; table-driven over start/stop/interleaved-parallel/clear-on-idle.
- **Auto-expand derivation = pure function:** `(subagents, manualOverride, turnState) → expanded`.
- **View-model:** session VM attaches the right children and rolled-up dot.
- **Reporter mapping = pure function:** `SubagentStart`/`SubagentStop` JSON → `wsh` args (incl. `completion_status` → `success`/`failure`).
- **`SubagentRow` render:** correct connector (`├─` vs `└─`), marker shape per state, truncation + hover-title.
