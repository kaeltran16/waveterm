# Agents Panel — Design Spec

**Date:** 2026-06-17
**Status:** Design approved (brainstorm complete); implementation plan pending
**Base:** Extends the session sidebar (Phases 1–3 + loom integration). Adds one new Wave view type (`agents`) and a pinned launcher in `sessionsidebar.tsx`. Builds on the prior agent-manager brainstorm (pull answer-channel, Claude-Code-only, permissions out of scope).

## UI reference (visual companion mockups — the design source of truth)

The UI was designed interactively; these self-contained HTML mockups are the **authoritative visual spec**. Open them in a browser. Match this layout, spacing, color, and interaction — do not redesign from the prose.

- **`assets/2026-06-17-agents-panel/01-locked-design-sidebar-and-view.html`** — the locked design: the sidebar with the pinned **Agents** launcher + `N asking` badge + divider above `+ New Tab`, *and* the Agents view open beside it. **Primary reference.**
- **`assets/2026-06-17-agents-panel/02-agents-view-fullscreen.html`** — the Agents view at full scale: section grouping (`needs you` / `working` / `idle`), an asking card with long scrollable previous-info (messages + actions), working one-liners, idle straggler.
- **`assets/2026-06-17-agents-panel/03-placement-options.html`** — the three placement options considered; #3 (sidebar-pinned launcher) was chosen. Context for §4.

Palette/type already in the mockups (reuse, don't reinvent): canvas `#0b0e14`, borders `#1c2230`/`#20242b`, amber "asking" accent `#d29922`, green "working" `#3fb950`, idle `#4a5260`, primary text `#e6edf3`, muted `#6b7585`/`#7d8896`, the "Yes" button green `#238636`. Messages render as prose; actions render as a dim monospace strip with a left border.

## 1. What this is

A single Wave view — **"Agents"** — that shows every running agent in one scrollable surface. Agents that are blocked on a decision expand inline with their recent context (the messages and actions leading to the question) and an answer control; agents that are working or idle collapse to a one-line status. It is reached from a launcher pinned at the top of the session sidebar.

The job of this surface is **answering agents' questions and seeing their progress** — the two things the user does by hand today across N parallel agent sessions. It is deliberately **not** a question router or an inbox: questions are just a state an agent is in, shown in the context of what that agent has been doing.

## 2. Problem

Running multiple coding agents across multiple worktrees is overwhelming because of **simultaneity** (N agents needing attention at once) and because each interaction carries two costs: *"which task is this?"* (the sidebar labels by environment, not by what the agent is doing) and *"is the work correct?"* (the question gates reviewing the work). The session sidebar already answers "which sessions exist + their status." This view adds what the sidebar lacks: each agent's **previous info** and **inline answering**, in one place.

## 3. Scope / non-goals

**In scope (v1)**
- A new `agents` view type (BlockRegistry), rendered as a single scrollable surface.
- A pinned **Agents launcher + "N asking" badge** at the top of the session sidebar, opening the view.
- Roster of all agents with live status, sorted **asking → working → idle**, reusing the existing agent-status source.
- For **asking** agents: inline **previous info** (recent messages + actions leading to the question) + the question + an answer control.
- For **working** agents: a one-line row with a live activity line.
- For **idle** agents: a one-line row flagging "stopped without asking" with a peek action.
- The **pull answer-channel**: agents ask via an `ask_human` tool → MCP elicitation → a Wave-side decision queue; the user's answer returns as the elicitation result and unblocks the agent. No LLM in the loop.
- **Previous info** sourced as a **deterministic projection of the agent's transcript** (no LLM).

**Non-goals (this cut)**
- **Make-a-rule / auto-answer.** Deterministic matching of a future ask to a stored rule is its own design problem (free-form questions don't match deterministically without an LLM, which breaks the zero-token premise). Documented fast-follow.
- **Risk tags, "sent" strip + undo.** Cheap additions deferred until the core surface is in use.
- **Conversational manager ("B").** A chat that reasons across agents is a later layer over the *same* queue, not v1.
- **Slide-in panel placement (Wave-AI-style).** The launcher opens the view as a tab; an "answer from any tab" overlay is a later upgrade.
- **Embedded loom diff pane.** The diff is a pull-up (a link that launches loom), not an inline rendered pane.
- **Permissions / tool-approval routing.** The user runs `--dangerously-skip-permissions`; the surface routes real *questions*, not approvals.
- **Push / keystroke injection** answer channel. Rejected in the prior brainstorm (fragile + token-heavy).
- **Codex or other agents.** Claude Code only (Codex hooks are experimental and disabled on Windows, the dev platform).

## 4. Layout & components

```
┌ sidebar ────────────┐   ┌ Agents view ───────────────────────────────┐
│ ⬤ Agents   [3 asking]│   │ Agents        3 asking · 4 working · 1 idle │
│ ───────────────────  │   │ ── needs you ─────────────────────────────  │
│ ＋ New Tab           │   │ ┌ loom · Fix duplicate-session race   4m ┐ │
│ ───────────────────  │   │ │ <recent messages + actions, scroll>     │ │
│ ▾ Pinned        (1)  │   │ │ Q Should I guard …?   [Yes] [No] [reply] │ │
│   ● loom        opus │   │ └─────────────────────────────────────────┘ │
│ ▾ waveterm      (2)  │   │ ┌ waveterm · Migrate badges …          1m ┐ │
│   ● waveterm    opus │   │ │ … [Keep] [Delete] [Deprecate]            │ │
│   ● waveterm-2  son. │   │ └─────────────────────────────────────────┘ │
│ ▾ obsidian      (2)  │   │ ── working ──────────────────────────────── │
│   …                  │   │ ● waveterm-2  Add settings search  ⟳ go test │
└──────────────────────┘   │ ● obsidian    Daily note backlinks ⟳ editing │
                           │ ── idle ─────────────────────────────────── │
                           │ ● obsidian-2  stopped without asking · peek  │
                           └─────────────────────────────────────────────┘
```

- **`AgentsViewModel`** (`frontend/app/view/agents/agents-model.ts`) — implements `ViewModel`; `viewType = "agents"`, `noPadding`. Atoms follow the Jotai model pattern (simple atoms as fields; derived in constructor). Reads cross-agent state from a shared store (below); does not own per-session data.
- **`AgentsView`** (`agents.tsx`) — scroll column: a section per state (`needs you` / `working` / `idle`), rendering `AskCard` / `WorkingRow` / `IdleRow`.
- **`AskCard`** — header (status dot, agent name, task, age) · **previous info** (messages + actions, scrollable, with `full transcript` and `diff in loom` links) · question · answer control (option pills from the ask payload, or Yes/No, plus a free-text reply input).
- **`WorkingRow`** / **`IdleRow`** — one-line: status dot, name, task, and a live activity line (working) or "stopped without asking · peek" (idle).
- **Sidebar change** (`sessionsidebar.tsx`) — a pinned **Agents** launcher with a derived `N asking` badge above the existing `+ New Tab` button, separated by a divider. Opens/focuses the Agents view.

**Sort order:** `asking → working → idle`; within a state, by how long blocked / most recent activity.

## 5. Data flow

1. **Roster + status** — from the existing agent-status events (`agentstatusstore.ts`), the same source the session sidebar consumes. No new discovery mechanism; the view shows *all* tracked agents (sessions + subagents).
2. **Asking state + the question** — an agent calls the **`ask_human`** MCP tool when it needs a decision. This triggers an **MCP elicitation**; an **Elicitation hook** routes the elicitation into a **Wave-side decision queue keyed by session**. The agent blocks on the elicitation. The `AskCard` renders the queued ask.
3. **Previous info** — a **deterministic projection of the agent's transcript** (the Claude Code session JSONL): assistant text blocks → *messages*; `tool_use` entries → *action lines* (verb + target); `tool_result` → outcome (`✓`/`✗`). No summarization, no LLM. Rendered most-recent-last, ending at the question; older history is scrolled to (faded top), with `full transcript` / `diff in loom` as deeper pull-ups.
4. **Answer** — the user picks an option / types a reply. The value is returned as the **elicitation result**, which unblocks the agent. Deterministic; the terminal is never in the loop.
5. **Idle straggler** — a **Stop / Notification hook** firing with no pending ask flags the agent "stopped without asking"; `peek` opens its transcript/diff. Passive and deterministic — no classifier.

## 6. The `ask_human` payload (the contract)

The panel's richness comes from the transcript projection (§5.3) plus a **light** ask payload — *not* a heavy self-contained payload:

| Field | Required | Purpose |
|---|---|---|
| `question` | yes | The decision text shown in the `AskCard`. |
| `options[]` | no | Labels rendered as answer pills (e.g. `Keep` / `Delete` / `Deprecate`). Absent → default Yes/No + reply. |
| `recommendation` | no | The agent's suggested answer, shown under the question. |

Previous info is **not** in the payload (it is read from the transcript), keeping the ask cheap to produce. Agents are steered to use `ask_human` (rather than printing a question and stopping) via a CLAUDE.md / output-style convention.

## 7. Error handling & edge cases

- **No agents:** empty state ("No agents running").
- **Question present, transcript unreadable:** render the question + answer control alone, with a "previous info unavailable" note. The ask is still answerable.
- **Agent dies / is answered elsewhere while waiting:** drop it from `needs you`; if the elicitation is gone, disable the answer control with a "no longer waiting" note.
- **Multiple asks from one session:** one outstanding elicitation per session is expected; the latest pending ask is the active one.
- **Answer submitted but the agent already unblocked:** the elicitation result is a no-op; surface a quiet "already resolved."

## 8. Testing / verification

- **Unit:** the transcript → previous-info projection (messages/actions/outcome extraction) — real logic, worth covering, including the transcript-unreadable path.
- **Unit:** the decision-queue model (add ask, resolve/return answer, sort order, drop-on-death).
- **Live (consistent with sidebar/loom verification):** the view renders the roster and updates on status events; submitting an answer unblocks a real agent; the idle-straggler flag appears on a Stop with no ask; the sidebar badge count tracks pending asks.

## 9. Build notes / reuse

- **New:** the `agents` view (`frontend/app/view/agents/*`) + BlockRegistry registration; a shared decision-queue store (Jotai, per the model pattern); the `ask_human` MCP tool + Elicitation-hook routing into the queue; the transcript-projection module.
- **Reuse:** `agentstatusstore` (roster + status + idle signals), `sessiongroupstore` (grouping), the session sidebar (pinned launcher + badge), loom (diff pull-up via the existing `Cmd:Shift:g` launch / a future `loom diff --print`), Claude Code Stop/Notification hooks.
- **Edit:** `sessionsidebar.tsx` (pinned Agents launcher + badge + divider, above `+ New Tab`); possibly `agentstatusstore.ts` to expose "asking" state.

## 10. Open items for the implementation plan

1. **Transcript access from in-repo.** The status reporter is out-of-repo; the panel needs an in-repo path (Go/RPC) to read a session's transcript JSONL for the projection. This is the largest unknown and should be resolved first in planning.
2. **`ask_human` MCP packaging & registration.** Where the MCP server lives, how it's registered with Claude Code, and how the Elicitation hook routes into the Wave queue (vs. a blocking MCP tool — hooks/elicitation preferred per the prior brainstorm's doc check).
3. **Live vs on-demand previous info.** Recommend: working agents show a live activity line (from status events); full previous-info is projected when an agent is *asking* (or on open), not streamed continuously.
4. **"Asking" as a first-class status.** How a pending elicitation maps to the sidebar status/badge and the view's `needs you` section.

## 11. Phased path (longer arc)

Concierge / decision-inbox (**this**) → **Gatekeeper** (auto-handles routine calls, escalates real forks) → **Delegator** (spawns + manages workers). Make-a-rule, risk tags, the conversational manager (B), and the slide-in panel are layers over this same queue, deferred until the core surface is in use.
