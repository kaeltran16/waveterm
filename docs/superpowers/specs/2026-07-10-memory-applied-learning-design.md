# Memory → Applied Learning — design

2026-07-10. User request: "what else should i add to improve the app" → narrowed through
brainstorming to: deepen the Memory surface into a closed loop where agents *capture* learnings
themselves and old learnings get *pruned*, instead of memory being a human-authored viewer that
only accumulates.

## Problem

The memory system today (`pkg/memvault/`, `frontend/app/view/agents/mem*`) is a multi-root markdown
vault rendered as a graph — the "one shared brain" model where Claude's per-project memory dir
(`~/.claude/projects/<hash>/memory/`) is the hub, and Codex/Gemini are lackeys that receive a
projection and feed harvested facts back. It works, but it is **one-directional and human-driven**:

- **Write** = a human typing into `NewMemoryModal`, plus an auto-harvest of Codex's `MEMORY.md`.
  **Claude agents never write memory through the cockpit** — that seam does not exist.
- **Read-into-behavior** = Claude reads its own hub dir natively; lackeys read a projected steering
  region. The cockpit doesn't actually influence whether memory changes behavior — it hopes Claude
  reads it.
- **No removal signal.** The brain only grows. The user's concrete pain: *"right now there are too
  many outdated memories and I am having trouble removing them."* There is no way to tell which
  notes are stale or superseded, so cruft accumulates and manual cleanup is untenable.

"Applied learning" means closing both open ends: agents capture learnings on their own, and the
same pass that captures also marks old learnings for removal. Capture and cleanup are two outputs
of one distillation pass, which is why they are one spec.

## Non-goals (YAGNI)

- **No launch-time prompt injection for Claude.** Writing to `HubDirForCwd(cwd)` *is* the read path
  — Claude Code reads that dir natively next session. No prompt plumbing needed.
- **No new sync engine.** Reuse the existing harvest (`harvest.go`) and projection (`projection.go`)
  machinery; do not build a parallel path.
- **No precise applied-counting.** Inferring "was this note acted on" is fuzzy. The pruning signals
  below are coarse-by-design and sufficient.
- **No auto-delete.** Every removal is human-confirmed.
- **Claude only for v1.** Cross-agent capture/pruning is out of scope.

## Design

### 1. Capture — the write side (the missing seam)

A new **SessionEnd reporter hook** lives under `~/.claude` alongside the existing status/ask/usage
reporters (external to this repo; see `docs/agents/`). It is the same lifecycle seam the Obsidian
session-log logger already uses (`docs/superpowers/specs/2026-06-29-obsidian-session-log-design.md`).

On session end it runs a headless distillation — the same `claude -p` pattern Jarvis already uses:

- **`claude -p --model claude-haiku-4-5`** over the **recent transcript tail**, prompted to extract
  *only* durable learnings in the existing taxonomy (`feedback`, `project`, `reference`, plus the
  new `learning` type — see §4). Whether a turn was a correction is the model's judgment call inside
  the prompt, not a transcript heuristic ("use the model for judgment, code for determinism").
- **Fallback to `claude-sonnet-5`** (1M context) when the tail exceeds ~150K tokens (Haiku 4.5 is
  200K; long coding sessions can overflow it). The tail is bounded to a recent-turn window rather
  than the whole transcript — durable learnings and corrections almost always surface near where
  they happened, and the full transcript is rarely needed to find them.
- Output is **structured** (a JSON list of candidate notes: `type`, `scope`, `body`, why,
  how-to-apply) so the hook does deterministic routing, not the model.

Model rationale: because these are Claude Code agents, the distillation draws on the user's own
Claude usage/rate-limit budget — the same 5h window the cockpit's rate-limit donuts track. Haiku is
cheap **and** light on that budget, so distillation doesn't compete with real agent work for
headroom. Sonnet is invoked only on the rare oversized transcript. Opus is never used here.

### 2. Trust model — hybrid auto-commit / review

- **Corrections / feedback → auto-commit.** Written straight to the hub via
  `CreateNote(HubDirForCwd(cwd), …)`, flagged `machine-authored, unreviewed`, dedup'd by content
  hash (reuse `factHash` / `existingHashes` from `harvest.go`). The loop closes instantly — the next
  session in that project reads them natively. This is the highest-signal, lowest-volume, most
  behavior-changing class, and the one you never want repeated.
- **Everything noisier (project facts, prefs) → review tray.** Lands in a pending queue on the
  Memory surface. Nothing enters the brain until the user approves / edits / rejects.

Attention is spent where signal is ambiguous (the tray), not on the high-signal stuff (which just
works).

### 3. Read-into-behavior

- **Claude:** writing to `HubDirForCwd(cwd)` *is* the read path — no launch injection.
- **Lackeys (Codex/Gemini):** already handled — a machine-written learning flows out through
  `renderFacts` → `Project(cwd)` on their next launch, identical to a human note. The echo rule
  (`source: codex` notes aren't projected back to Codex) already covers machine provenance; extend
  it so `source: agent` learnings project normally.
- **New:** generate a hub-side `MEMORY.md` index (Codex has one; the Claude hub does not) so there
  is a single injectable digest available if explicit injection is ever wanted. Written by the same
  hook after commit; regenerated, not hand-edited.

### 4. Data-model changes (small, additive)

- Add `learning` to the `metadata.type` enum: `memtypes.ts` (`META`), the graph legend
  (`memgraph.tsx`), and `NewMemoryModal` `TYPES`.
- Extend the `frontmatter` struct (`memvault.go`) and `Note` with provenance:
  `source: agent`, `source_hash`, `captured_at`, `reviewed: bool`. Mirrors `writeHarvestedNote`.

### 5. Pruning — the cleanup loop (directly attacks the stated pain)

"Outdated" memories are one of two things, needing different signals. Both are produced by the same
distillation pass that captures (§1), so cleanup is free output of capture.

- **Superseded (strong signal).** While distilling, the pass also asks *"does anything I'm learning
  contradict or replace an existing hub note?"* — a direct semantic judgment, far more reliable than
  inferring application. When it fires, the old note gets a **`superseded_by` → [new note]**
  frontmatter link. High-confidence prune candidate with a stated reason.
- **Stale (weak signal).** A coarse **`last_referenced`** timestamp, bumped when the distiller
  reports a note was in-context and relevant to the finished session. Notes untouched for a long
  stretch surface as low-confidence candidates. Deliberately coarse — "hasn't been relevant in N
  days" is enough to make cleanup tractable; precise applied-counting is not worth the complexity.

Both feed a **Cleanup queue** (see §6). Removal is always human-confirmed — a memory wrongly flagged
and silently deleted is gone for good, and the whole premise is that the current pile can't be
trusted blindly; neither should the pruner be. The pruner proposes, the user disposes.

New frontmatter: `superseded_by` (wikilink), `last_referenced` (timestamp).

### 6. UI — Memory surface

- **Review tray** (§2): collapsible "N pending" section listing candidate notes with approve / edit
  / reject. New RPC `MemoryReviewList`; accept/reject reuse `MemoryCreateCommand` /
  `MemoryDeleteCommand`.
- **Cleanup queue** (§5): prune candidates sorted strongest-first (superseded before stale), each
  showing *why* (superseded by X / not referenced since Y), one-click remove and batch-remove via
  `MemoryDeleteCommand`.
- **Machine-authored badge** on auto-committed learnings — distinct node style in `memgraph.tsx`,
  one-click demote-to-review or delete.

### 7. RPC / backend surface

Additions to the existing 8 memory RPCs (`wshserver.go`, typed in `wshrpctypes.go`, TS in
`wshclientapi.ts` via `task generate`):

- `MemoryReviewList` — pending candidate notes for the tray.
- `MemoryPruneList` — prune candidates (superseded + stale) with reasons.
- Accept/reject/remove reuse existing `MemoryCreate` / `MemoryDelete`.

The distillation hook itself talks to `wavesrv` over `wsh` (a new thin command, e.g.
`MemoryLearnCommand`, that routes candidates to auto-commit vs. tray and applies `superseded_by` /
`last_referenced`), parallel to how the reporter hooks emit events today.

## Seams reused (no new infrastructure)

| Need | Existing seam |
|---|---|
| Machine-authored note with provenance | `writeHarvestedNote` (`harvest.go`) |
| Content-hash dedup | `factHash` / `existingHashes` (`harvest.go`) |
| Write to the project's hub | `CreateNote(HubDirForCwd(cwd), …)` (`memvault.go`) |
| Lackey read-into-behavior | `renderFacts` → `Project(cwd)` (`projection.go`) |
| SessionEnd lifecycle trigger | Obsidian session-log hook pattern |
| Headless distillation | Jarvis `claude -p` pattern |
| Remove a note | `MemoryDeleteCommand` |

## Open question resolved during design

- **Applied-tracking vs. pruning.** Initial design framed §5 as `applied_count` evidence. User
  reframed the real need as pruning outdated memories → §5 rewritten around `superseded_by` (strong,
  reliable) + coarse `last_referenced` (weak), dropping fuzzy applied-counting.

## Scope

One coherent spec, one implementation plan. Capture (§1–4, §7) and pruning (§5–6) share the single
distillation pass and the same data-model/RPC changes, so they are not separable without duplicating
that pass.
