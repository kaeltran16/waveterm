# Memory sync — Phase C (agy harvest) — spike findings & no-go

Date: 2026-07-01
Status: **closed — no-go.** agy stays receive-only.
Builds on: `2026-07-01-memory-sync-engine-design.md` (Phase C), `2026-06-30-memory-sync-spike.md`
Supersedes: the parent design's **Phase C** plan ("protobuf-decode the conversation store to harvest agy's learned facts").

## Decision

**Phase C is closed as no-go. agy remains receive-only.** The Claude → agy projection (Phase A,
shipped) already delivers the shared brain into agy via `~/.gemini/GEMINI.md`. There is no native
agy memory to harvest, so the harvest half of the loop does not apply to agy. The memory-sync loop
is complete for the two runtimes that *have* distilled memory: **Claude ↔ Codex** (Phase B).

This is the escape hatch the parent design explicitly reserved: *"if [the source] proves out, agy
becomes a full participant; if not, agy stays receive-only — no loss to A/B."*

## Why — the founding premise was invalidated by ground truth

Phase C was scoped as "protobuf-decode agy's conversation store to harvest its learned facts." An
on-disk investigation of the live agy stores (2026-07-01) shows **there are no learned facts to
harvest** — agy distills nothing durable. The protobuf angle was a red herring twice over.

### What was inspected

The machine has three agy dirs. The CLI (`agy`, what the cockpit launches) writes to
`~/.gemini/antigravity-cli/`:

| Candidate source | What it actually is | Harvestable facts? |
|---|---|---|
| `~/.gemini/GEMINI.md` | **0 bytes** — the steering file = our Phase A *projection target*, not a source | No |
| `knowledge/` (all 3 stores) | **empty** — only a 0-byte `knowledge.lock` | No — agy's native Knowledge store never populates |
| `conversations/*.db` | protobuf-encoded SQLite (`trajectory_meta` + `steps`, raw turn payloads) | No — raw conversation, not distilled |
| `brain/<conv-id>/*.md` | readable markdown, but **per-task status/plan reports** (`scenario_implementation_progress.md`, `blockers_and_gaps_log.md`, `implementation_plan.md`, `task.md`, `walkthrough.md`) | No — project status docs, not durable reusable facts |
| `brain/<conv-id>/.system_generated/logs/transcript.jsonl` | **plain JSON** session transcript (`{step_index, source, type, status, created_at, content}`) | No — raw history, not memory |
| `implicit/*.pb` | tiny protobuf, no readable content | No |

### Corroboration (web, 2026-07-01)

agy CLI is very new (announced Google I/O 2026-05-19; replaced Gemini CLI 2026-06-18; Go rewrite),
which is why native memory is immature. The authoritative confirmation is the Mem0 integration
writeup:

> "Antigravity CLI has **no built-in persistent memory**… Antigravity keeps session logs: a
> transcript you scroll through manually. That's **history**. Memory is different: it's context
> that surfaces automatically when relevant. Antigravity has the first. It doesn't have the second."

Sources:
- <https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>
- <https://mem0.ai/blog/add-persistent-memory-to-google-antigravity-cli-with-mem0-mcp>

### Two consequences

1. **No decode was ever needed** — the `transcript.jsonl` is plain JSON. The parent design's
   "protobuf schema decode" work item is moot.
2. **Even fully decoded, there is nothing to harvest** — the payloads are raw turn-by-turn
   conversation, not the curated `## Reusable knowledge` bullets that make Codex harvest a simple
   parse. The Codex-vs-agy harvest asymmetry the design *predicted* is now *proven*: Codex distills
   facts (harvest = parse); agy distills nothing (harvest would mean *manufacturing* facts).

## Options considered and rejected

- **Transcript distillation (LLM pass over `transcript.jsonl`).** Would build the memory feature
  agy itself lacks: LLM-distill session transcripts into candidate facts, write to the hub with
  `source: agy`. Rejected for now — speculative signal/noise, an LLM call per harvest, and a
  fundamentally different feature from the parse-based Codex harvest. If agy write-back is ever
  wanted, this is the path, and it deserves its own brainstorm — not a silent Phase C expansion.
- **Parse `brain/*.md` task reports.** Deterministic, but the content is project *status* (staged
  files, test counts, blockers), not durable reusable facts — low-value, noisy hub entries.
- **Mem0 MCP.** Third-party; out of scope for the in-cockpit sync engine.

## Net

Memory-sync final shape:
- **Projection (hub → lackeys):** Claude → Codex (`AGENTS.md`) + Claude → agy (`GEMINI.md`). Shipped (Phase A).
- **Harvest (lackeys → hub):** Codex `MEMORY.md` → hub. Designed (Phase B), pending review/plan/build.
- **agy harvest:** not applicable — no source. agy is a permanent receive-only participant unless/until
  it grows a native distilled-memory store (or we add transcript distillation as a separate feature).

Revisit only if a future agy release populates `knowledge/` with distilled entries — at which point
harvest becomes a markdown/JSON parse, not a protobuf decode.
