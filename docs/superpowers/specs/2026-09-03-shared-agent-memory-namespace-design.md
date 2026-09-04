# Shared Agent Memory — Namespace & Injection Design Spec

**Date:** 2026-09-03
**Status:** Design approved; implementation not started
**Scope:** The vault ↔ Claude Code sharing path — `pkg/memvault` harvest and projection, `wsh agent-memory-project`, and Claude's hook wiring. Pi, Codex, and opencode paths are unchanged.

## 1. Context

`pkg/memvault` is already the shared store between runtimes, with harvest (in) and projection (out):

| direction | mechanism | status |
|---|---|---|
| Claude → vault | `HarvestClaudeHubs()` folds `~/.claude/projects/*/memory` notes in | working |
| Pi → vault | `waveterm-memory.ts` `session_shutdown` → `wsh agent-memory-hook --transcript` | working |
| Codex → vault | `harvest.go` parses `~/.codex/memories/MEMORY.md` | working |
| vault → Pi | `Project()` → `~/.pi/agent/memory/projects/<label>.md` | working |
| vault → Codex/opencode | ARC-MEMORY region in `~/.codex/AGENTS.md` | working |
| vault → Claude | `exportToHub()` drops note files into the hub | half-wired |

The hook tables are asymmetric:

| | donate (transcript → vault) | receive (vault → runtime) |
|---|---|---|
| Pi | `session_shutdown` → `agent-memory-hook` | `session_start` → `agent-memory-project` |
| Claude | `SessionEnd` → `agent-memory-hook` | **nothing** |

Claude Code has no `SessionStart` memory hook. It donates every session and never pulls back. `exportToHub()` does write vault notes into the hub as files, but nothing triggers `Project()` for a Claude cwd, and nothing surfaces those files once written — `MEMORY.md` is the only thing loaded into context, and Arc does not maintain it.

Claude differs from Pi and Codex in a way that matters here: it **records memory directly** via the memory tool, authoring structured files into the hub. Pi's and Codex's stores are curated `MEMORY.md` files that harvest scrapes. Claude's hub is a live authored store that Arc also writes into.

## 2. Problem

### 2.1 The echo guard is one-sided

`exportToHub()` (projection.go:194) skips notes where `Note.Source == "claude"`, so Arc will not push Claude's own notes back at Claude. But `HarvestClaudeHubs()` → `foldHubNote()` has **no source filter**: it folds every hub note into the vault, including the `source: agent` files Arc itself wrote there. Content-hash dedupe (`existing[h]`) prevents duplicate writes but not duplicate registration.

Measured census of the waveterm hub (54 notes):

| notes | provenance | gardener |
|---|---|---|
| 40 | no `source:` — authored by the memory tool | clean |
| 14 | `source: agent` — written by `exportToHub` | 14/14 `gardener_flag: duplicate`, all `reviewed: false` |

Every Arc-written note in the hub is flagged a duplicate. This is the round-trip, not noise.

### 2.2 One namespace, two contracts

Because Claude authors into the same directory Arc writes into, two writers with different conventions share a namespace. Observed consequences in the waveterm hub:

- **12 orphan files** — Arc's writes carry no `MEMORY.md` index line, so they are invisible to the only file Claude loads. All 12 are `source: agent`.
- **35 dead index links** of 77 — Arc's gardener removes files that Claude's hand-maintained index still references. Content is unrecoverable; the hooks remain and read as known facts.
- **Attribution laundering** — harvest re-ingests Arc's output as Claude-authored knowledge.

Pi does not have this problem because its projection target is a *different directory* from its harvest source. From projection.go:113:

> pi-memory's ambient injection only ever reads MEMORY.md, the daily log, and the scratchpad, and HarvestPiMemory only parses MEMORY.md — so these files are pull-only.

Pi's separation is structural. Claude's projection target *is* its harvest path.

### 2.3 The payload is too large to inject wholesale

The rendered Pi projection for this project is the payload any Claude injection would carry:

```
~/.pi/agent/memory/projects/waveterm.md   66,324 bytes   40 facts   ~16,500 tokens
```

Facts average ~1,650 chars because they carry full **Why:** / **How to apply:** bodies. Injecting that at every session start is not viable.

## 3. Goals

1. Claude Code receives project-scoped facts originating in Pi, Codex, and its own past sessions.
2. Harvest has no echo path — Arc's own output can never be re-ingested as Claude-authored.
3. Per-session context cost is bounded and predictable.
4. Retrieval of full bodies requires no new tool, protocol, or server.
5. Claude's memory-tool namespace is restored to a single writer.

## 4. Non-goals

- **Repairing `MEMORY.md`'s existing rot.** Once Arc stops writing to the hub, the 35 dead links and index drift are a separate one-time cleanup, tracked independently.
- **Reclaiming the 19 legacy memories** stranded under the old `C---Users--` double-dash encoding, or the 6 in per-worktree hubs. Separate migration.
- **Changing Pi, Codex, or opencode paths.** They work; this spec ports their pattern rather than altering them.
- **Adding a `memory_search` tool or MCP server.** Rejected in §5.3.
- **Retrieval ranking or embeddings.** At ~40 facts per project, a flat manifest is sufficient.

## 5. Design principles

### 5.1 Separate by directory, not by filter

A source filter in harvest would fix the echo, but leaves both writers in one namespace and keeps orphans and index drift alive. Directory separation fixes echo, orphans, and drift with one change, and it is the pattern Pi already proves.

### 5.2 Manifest in context, bodies on disk

Context carries one line per fact — enough to know a fact exists and whether it bears on the task. Bodies stay on disk and are read when relevant. This inverts the current failure, where content is on disk and *nothing* signals its existence.

### 5.3 Retrieval reuses an existing capability

Claude can already read and grep files. A search tool would buy retrieval quality that ~40 flat facts do not need, at the cost of an interface to build, version, and keep working across runtimes. The manifest ends with the directory path; retrieval is a file read.

## 6. Architecture

### 6.1 Projection target

Add a Claude projection target at `~/.claude/projects/<ProjectHash(cwd)>/shared/`, a sibling of the existing `memory/` hub.

`ClaudeHubDirs()` enumerates `~/.claude/projects/*/memory` (projection.go:329), so a sibling `shared/` directory is outside the harvest path **by construction**. No source-filter logic is required to prevent the echo; the layout prevents it.

`exportToHub()` stops targeting `memory/` and writes here instead. Note format is unchanged.

### 6.2 Manifest format

Rendered fresh on each injection from the notes in `shared/`:

```
## Shared project memory: waveterm
Facts from past Claude, Pi, and Codex sessions on this project.
Read the full body of any fact from: ~/.claude/projects/<hash>/shared/<name>.md

- radar-channel-path-separator-gotcha — channel path is raw, report path is canonPath'd; FE comparisons must normalize separators
- wsh-not-on-path-empty-cockpit-cards — non-interactive launch leaves wsh off PATH, reporter no-ops, cockpit stays empty
...
```

Budget: ~40 facts × ~120 chars ≈ 5 KB ≈ **1.2k tokens** per session.

**Blocking gap:** `foldHubNote()` (harvest.go:228) writes `name` + `metadata` + body and **drops `description`**. Vault notes have no short form, so there is nothing to build a manifest line from today. Fix: preserve `description` on fold — Claude-authored notes already carry one — and synthesize a first-sentence description for Pi/Codex-sourced facts, which have none.

### 6.3 `wsh agent-memory-project --inject`

Extend the existing command (`cmd/wsh/cmd/wshcmd-agent-memory-project.go`) rather than adding a new one. With `--inject` it performs the projection, then writes the rendered manifest to stdout in the SessionStart hook's JSON envelope.

Fail-safe behavior matches the existing command exactly: absent `WAVETERM_JWT_TOKEN`, RPC setup failure, or an empty `--cwd` all return nil with **no stdout output**. A bare Claude session outside Wave must behave as if the hook did not exist.

### 6.4 Hook wiring

Register in `~/.claude/settings.json` under `SessionStart`, installed by `wsh install-agent-hooks` alongside the existing `SessionEnd` memory hook.

Injection is session-start only. `UserPromptSubmit` already runs `agent-hook` every turn; adding memory there would multiply the cost by turn count for facts that do not change mid-session.

## 7. Migration

The 14 `source: agent` notes in the hub are Arc's output in Claude's namespace and must be evicted.

**Precondition (blocking):** for each of the 14, verify its `source_hash` resolves to a note present in the vault. Eviction proceeds only for notes that pass. Any that fail are moved to `shared/` instead of deleted — a fact that exists nowhere else must not be destroyed by a namespace cleanup.

**Rollback:** eviction moves files to `shared/`; it does not delete. Restoring is a move back. Stage 1 and stage 3 are revertible by reverting the commit; no data is rewritten in place.

## 8. Delivery sequence

1. **Stop the pollution.** Repoint `exportToHub()` from `memory/` to `shared/`. Three lines. Independently valuable and shippable alone — today every Arc write is re-folded and flagged duplicate on each cycle. No migration, no hook changes.
2. **Evict the 14**, subject to the §7 precondition.
3. **Manifest and injection.** `description` on fold, manifest renderer, `--inject`, `SessionStart` registration in `install-agent-hooks`.

Stage 1 is worth doing whether or not stages 2 and 3 proceed.

## 9. Testing

Backend unit tests beside the existing `projection_test.go` and `harvest_test.go`:

- `exportToHub` writes to `shared/`, and `ClaudeHubDirs()` does not enumerate it — the echo guarantee, asserted directly.
- Round-trip: export a vault note, run `HarvestClaudeHubs()`, assert the vault gains no note and no `duplicate` flag is produced.
- `foldHubNote` preserves an existing `description` and synthesizes one when absent.
- Manifest renders one line per note, and is empty (not malformed) for an empty `shared/`.
- `--inject` emits nothing when the JWT is absent, when `--cwd` is empty, and when RPC setup fails.
- Migration precondition: a note whose hash is missing from the vault is moved, not deleted.

Live verification: start a Claude session in this repo, confirm the manifest appears in context, confirm a fact written from a Pi session in the same project reaches it, and confirm a session started outside Wave is unaffected.

## 10. Open questions

1. **SessionStart output schema.** The manifest is expected to go in `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`. Confirm against the installed Claude Code version before implementing §6.3 — a malformed envelope degrades session start on every project, which is this design's largest blast radius.
2. **Scope of injected facts.** Project-scoped only, or project plus `scope: global`? Global facts are largely process preferences, which are arguably CLAUDE.md's job.
3. **Staleness.** Nothing expires a projected fact. The gardener flags `drift` (2 notes today) but nothing acts on it for projected content.

## 11. Success criteria

1. A fact recorded in a Pi session on this project is visible to a Claude session in the same project, without either runtime writing to the other's authored store.
2. `HarvestClaudeHubs()` produces zero `gardener_flag: duplicate` notes across a full harvest cycle.
3. The waveterm hub contains only memory-tool-authored notes; every note has a `MEMORY.md` index line.
4. Per-session injection cost stays under 2k tokens at 40 facts.
5. A Claude session outside Wave shows no behavior change.
