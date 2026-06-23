# Agent tab auto-naming — sidebar rows labeled by ai-title

Each agent's session row in the vertical nav auto-labels itself with the agent's
current **task summary** (Claude Code's `ai-title`) instead of the bare agent/tab
name. The label is **derived, never persisted** — a manual rename always wins and is
never overwritten.

`rowLabel` precedence (`frontend/app/tab/sessionsidebar/sessionviewmodel.ts`):

```
customLabel (manual rename, session:label)  ??  title (ai-title)  ??  agent name  ??  "session"
```

If rows show only the agent/tab name and never the task summary, **no title is
reaching Wave** — almost always the producer half (below), not the FE.

## Why the title rides the hook reporter, not the statusLine

Unlike usage (which has no hook and must ride the statusLine — see
[usage-reporting.md](./usage-reporting.md)), the title rides the **same
`agent:status` state event** that already carries state/detail/model. It is produced
by `agent_status_reporter.py` (external repo `agent-status-spike`), wired into Claude
Code lifecycle hooks (`PreToolUse`, `Stop`, …).

The reporter already tail-reads the parent transcript to find `--model`; the title
extraction piggybacks on that same read. The ai-title is **not** in the hook payload —
it lives only in the transcript JSONL as `{"type":"ai-title","aiTitle":"…"}` records,
which Claude Code re-emits (and refines) roughly once per turn. The **last** one is
current.

## Data flow

```
Claude Code transcript JSONL   ({"type":"ai-title","aiTitle":"…"} near each turn's end)
        │
        ▼  agent-status-spike/agent_status_reporter.py : read_last_title()  (tail ~64KB)
   wsh agentstatus --state … --model … --title "<ai-title>"   (only on parent STATE events)
        │
        ▼  cmd/wsh/cmd/wshcmd-agentstatus.go : agentStatusRun()
   publishes an `agent:status` WaveEvent  { state, …, title }
        │
        ▼  frontend/app/tab/sessionsidebar/agentstatusstore.ts : setupAgentStatusSubscription()
   data.state truthy  →  globalStore.set(getAgentStatusAtom(oref), data)   (stores whole payload incl. title)
        │
        ▼  frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts : sessionSidebarViewModelAtom
   title = agentStatus?.title  →  SessionInput.title
        │
        ▼  sessionviewmodel.ts : rowLabel()   →   customLabel ?? title ?? agent
```

**The title must ride a state event.** `setupAgentStatusSubscription` only stores the
payload `if (data.state)` — a delta-only event (e.g. usage) is ignored for the row
atom. So `--title` is attached only in the reporter's parent-state branch (alongside
`--model`), never on subagent/usage deltas. All parent state events (working / waiting
/ idle) carry it, so the row keeps its label through the whole turn, including idle.

## Why a 64KB tail-read reliably catches the title

`--model` is safe to tail-read because `"model"` appears on every assistant turn. The
ai-title is emitted less often, so the worry was that in a long transcript the last one
sits above a 64KB tail window. Measured across real transcripts up to ~11MB, the **last
ai-title sits 193–24,525 bytes from EOF** — Claude emits it at the end of each turn, so
the existing 64KB tail comfortably catches it. `read_last_title` parses per-line JSON
(titles are free text and may contain quotes, which a regex would truncate) and skips
the partial leading line a mid-file tail read produces.

## Reporter implementation (external)

`agent_status_reporter.py` — two pure helpers (`_last_title_in`, `read_last_title`,
unit-tested in `test_reporter.py`) plus the wiring in `main()`'s parent-state branch:

```python
transcript_path = event.get("transcript_path")
parent_model = read_last_model(transcript_path)
if parent_model:
    tail = tail + ["--model", parent_model]
title = read_last_title(transcript_path)
if title:
    tail = tail + ["--title", title]
```

## Verifying

- `wsh agentstatus --help | grep title` — confirm the installed binary has `--title`.
- Reporter logic on a real transcript (no publish):
  ```python
  from agent_status_reporter import read_last_title
  read_last_title("/path/to/<session>.jsonl")   # → e.g. "Fix duplicate-session race"
  ```
- Live: with an agent active in a Wave block, its sidebar row relabels to the task
  summary within a turn (the next `PreToolUse`/`Stop` hook). A manual rename overrides
  it; clearing the rename reverts to the auto label.

## Behavior notes

- **Non-destructive.** `session:label` stays the user's manual override; the auto label
  is computed at render time and never written back.
- **Idle keeps the label.** The idle state event still carries `--title`, so a finished
  agent's row stays labeled with its last task summary.
- A fresh session before Claude has generated a title sends no `--title`; the row falls
  back to the agent/tab name until the first ai-title lands.
- In-repo wiring shipped in `1326371c`; the reporter `--title` passthrough (the producer
  half) is the piece that actually lights it up.
