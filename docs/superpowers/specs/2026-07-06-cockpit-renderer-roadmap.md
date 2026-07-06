# Cockpit data renderer — overhaul roadmap

**Date:** 2026-07-06
**Status:** Decision doc (roadmap). Governs the phase specs that follow.

## Why

The cockpit's transcript→feed renderer (`transcriptprojection.ts` → `NarrationTimeline` →
`MarkdownMessage`) shows *what an agent is doing* but not *what it actually did*. Every tool call
collapses to `verb + target`; `tool_result` content is discarded; assistant prose renders code as
plain text; and some tools (notably `Skill`) dump their entire payload inline and flood the feed.

The data to fix this is **already on the wire** — `StreamAgentTranscriptCommand` streams full
`tool_use` inputs and `tool_result` content; the projection just throws it away. So this is a
frontend re-projection + render effort, with **no expected Go/Rust changes**.

## The unifying contract

"Improve the renderer" is not N features. Under one pattern it is **one engine plus small plug-ins**.
Every tool type supplies three things:

1. **A compact feed line** — one glanceable row (`auth.go +40 −12 · 5 edits`), never the raw payload.
2. **A detail payload** — the structured data retained by the projection (`ActionDetail`).
3. **A modal pane** — the universal drill-in, rendered per type from the payload.

The feed stays compact and coalesces at scale; the modal is the single home for full content
(diffs, command output, matches, skill text, …). Covering the feed while reading detail is
intentional — you are focused on that detail.

```
transcript JSONL → projection (+detail) → feed (compact line / coalesced group) → click → modal (adaptive pane)
```

Two aggregation rules, on purpose:
- **Feed** coalesces *per chronological burst* (extends the existing `groupTimeline`), so the story
  stays in order.
- **Modal** aggregates *globally per target*, so the drill-in is the complete picture (e.g. all
  edits to `limiter.go` across the session, not one burst's fragment).

## Phases

Each phase gets its own spec → plan → implementation cycle. Later phases inherit P1's contract.

| Phase | Scope | Notes |
|---|---|---|
| **P1 · Engine** | The contract itself: `ActionDetail` projection model, coalesce-by-target feed, universal detail modal, failures float-up. Proven by **Edit/Write diffs + Bash output**. | The only phase that adds infrastructure. Spec: `2026-07-06-cockpit-renderer-engine-design.md`. |
| **P2 · Cheap wins** | Additive tool variants on P1's contract: **Grep/Glob** (match count + list), **Read** (line range), **Web/MCP** (URL/args/result), **Skill-call collapse** (feed line + full text in modal). | Each = one `ActionDetail` variant + one modal pane + one feed line. Low risk. |
| **P3 · Prose & structure** | Cross-cutting: code-block polish (no dep), **thinking blocks** (collapsible fold), timestamps/duration, turn grouping. | Touches `MarkdownMessage` + feed layout; no new detail plumbing. |

## Deferred (own future session)

- **Subagents (`Task`) renderer.** A `Task`'s modal pane should embed the subagent's *own* transcript
  rendered recursively by the same feed. This needs subagent-transcript stream plumbing and is a
  design in its own right. **P1 builds the modal so a subagent pane can slot in later**, but does not
  design it.

## Constraints (all phases)

- Frontend only; no backend changes. Data comes from the already-streamed transcript.
- All projection/rollup logic stays **pure and deterministic** (no React, no LLM) and unit-tested;
  there is no render-test harness — component appearance is verified live over CDP.
- Multi-agent projector registry (`TranscriptProjector`) must keep working: new fields are optional,
  so the Codex projector degrades gracefully until it populates them.
- Bound render cost: cap large payloads (first/last N lines + "show more").
