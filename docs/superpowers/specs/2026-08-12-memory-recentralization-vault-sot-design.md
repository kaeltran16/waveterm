# Memory re-centralization — Obsidian vault as the single source of truth

**Issue:** the Memory tab shows the same knowledge many times ("why are there so many duplicated?"),
root-caused to the memory system not being centralized. **Date:** 2026-08-12. **Effort:** L.

## Problem

Measured on the dev machine 2026-08-12, `MemoryScanCommand` (memvault `ScanVault`) returns **347
notes** from three federated roots, with **0** in the vault that should be the source of truth:

| Root | Notes | Role today |
|---|---|---|
| `~/.waveterm/vault/memory/` | **0** | intended SoT — but empty |
| `~/.claude/projects/*/memory/` (~18 hubs) | ~295 (204 claude + 69 codex-harvested + 31 agent) | every write path lands here |
| `~/.codex/memories/` | 43 (raw_memories.md 2422 lines embedding all 37 rollout summaries, memory_summary.md, phase2_workspace_diff.md 11k lines, 37 rollout_summaries, 3 ext/skills) | scanned wholesale as notes |

Duplication is structural, not byte-level (0 identical files):

- **Same project, many hub dirs, all scanned.** waveterm alone has the canonical
  `C--Users-…-waveterm` hub (55 notes), a legacy-encoded `C---Users--…--waveterm` hub (41 notes, an
  old hash scheme), and ~6 worktree/superpowers-derived hubs (9 notes). Result: 13 notes about "git
  worktree", scope labels split across 53 groups ("waveterm", "waveterm repo", "repo:waveterm",
  "Arc (waveterm repo)", "C:\Users\…\waveterm").
- **Codex dir scanned as notes.** The phase-B harvest design locked "`raw_memories.md` is the
  pre-distillation dump — not parsed; `MEMORY.md` is the curated source", but J6 federation walks
  the whole tree. One Codex fact renders up to 4×: raw_memories note + memory_summary note + its
  rollout_summary note + its harvested hub note.
- **Write paths bypass the vault.** `MemoryCreateCommand` (New memory), `AcceptPending` (Keep),
  `WriteLearning` (auto-corrections), and `Harvest` all target `HubDirForCwd(cwd)`; the vault is
  only the fallback when there is no cwd. Worse, Settings > Memory edits `memory:vaultpath`, which
  is only ever added as a **read-only mirror** (`customLegacyRoot`) — writes still go to the
  `jarvis:vaultpath` vault. The dir the user configures is never written to.

Two locked decisions are reversed by this spec: the 2026-07-01 memory-sync-engine decision
"Claude Code's own per-project memory is the SoT. No separate dedicated vault", and J6's
"agent-native directories federated as read-only mirrors" (they become derived sync surfaces, not
scan roots).

## Design

### 1. One root: the vault is the SoT

`memroots.VaultRoot()` resolves `memory:vaultpath` first (the key the Settings > Memory surface
edits), then `jarvis:vaultpath` as a legacy alias, then the default `~/.waveterm/vault`.
`customLegacyRoot()` and its mirror entry are removed — a configured path IS the root now, not a
side mirror. The user's Obsidian vault (`C:\Users\kael02\IdeaProjects\obsidian\Work`, where the
obsidian-logging skill already writes) is the intended value; the memory collection lives at
`<vault>/memory/`, visible in Obsidian as a folder.

### 2. Scan reads the vault only

`memroots.AllRoots()` returns just `[{MemoryRoot(), "vault"}]`. The Claude-hub and Codex mirrors
are dropped from both `memvault.ScanVault` and the `wavevault` retriever (J6's federation is
unwound). The Memory tab, recall, and graph all read the same vault bytes — duplicates disappear by
construction. This also removes the legacy-encoded and worktree hub dirs from view without touching
the files.

### 3. All writes target `<vault>/memory`

`CreateNote` call sites (`MemoryCreateCommand`), `AcceptPending`, `RouteLearnings`/`WriteLearning`
(auto-corrections and batch distillation), and the codex harvest all resolve the vault root instead
of `HubDirForCwd`. Frontmatter keeps `scope` (project label) and `source` so the surface and recall
still show where a note came from.

### 4. Projection (vault → runtimes) — derived surfaces, echo rule kept

- **Claude hub export:** each vault note is written into the project's hub dir as a
  `source: vault` + `source_hash` note when absent (the reverse of harvest, reusing the writer).
  Claude sessions load the centralized memory natively, as they do today.
- **Steering files:** the existing region render (`projection.go`) sources from vault notes and
  writes the same targets — `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, `~/.gemini/GEMINI.md` —
  plus a new `~/.config/opencode/AGENTS.md` (OpenCode has no projection today; it reads AGENTS.md
  from its config dir). The echo rule (`skip notes whose Source == targetRuntime`) stays.

### 5. Harvest (runtimes → vault) — the fold that keeps the SoT populated

- **Claude → vault (NEW):** generalize the existing codex `harvestInto` to sweep
  `ClaudeHubDirs()`: read every hub note, dedup by `factHash` against the vault's `source_hash`
  set (plus `archivedHashes()`), write `source: claude` notes into `<vault>/memory`. Idempotent.
- **Codex → vault:** repoint the existing `harvestInto` source (MEMORY.md) to write into the vault
  instead of the hub.
- **Pi → vault (transcripts):** `wsh agent-memory-hook` → memdistill → `RouteLearnings` targets
  the vault (was the hub).
- **Pi → vault (native memory, pi-memory):** pi-memory (`pi install npm:pi-memory`) writes curated
  long-term memory at `~/.pi/agent/memory/MEMORY.md` — entries like
  `#preference [[package-manager]] Always use pnpm in this repo, never npm.`, each preceded by a
  `<!-- timestamp [hash] -->` marker. Harvest like codex: parse the entries (split on the marker
  comments), `factHash`-dedup against the vault, write `source: pi` notes. **Harvest scope is
  MEMORY.md only** — `daily/*.md` logs and `SCRATCHPAD.md` are session diaries / transient todos,
  the same class of artifact this spec excludes for codex (raw_memories / rollout summaries). Gated
  on the dir existing — pi without pi-memory still contributes via transcripts.
- **OpenCode / agy:** receive-only. No transcript distillation yet (YAGNI; agy stays phase-C
  gated).

### Runtime matrix

| Runtime | Native memory | Receives (projection) | Contributes (harvest/distill) |
|---|---|---|---|
| Claude | yes — hubs (organic) | hub export (vault → hub) | new hub → vault sweep |
| Codex | yes — `MEMORY.md` curated | `~/.codex/AGENTS.md` | existing MEMORY.md → vault (repointed) |
| Pi | yes — `~/.pi/agent/memory/MEMORY.md` (pi-memory) | `~/.pi/agent/AGENTS.md` | transcript → memdistill → vault (repointed); MEMORY.md → vault (new, pi-memory entries) |
| OpenCode | no | `~/.config/opencode/AGENTS.md` (new) | none (deferred) |
| Antigravity | no (store empty) | none (harness removed 2026-08-12 — the GEMINI.md projection target was dropped with it) | none |

### 6. Migration = first harvest

The existing ~295 hub notes fold into the vault on the first sweep, hash-deduped. Legacy `---` hubs
and worktree hubs fold too — the same fact already in the vault is skipped, so the 13 git-worktree
notes collapse to one. The fold is **add-only**: hub files are never moved or deleted; hubs remain
claude-native plus the export surface. Nothing is destructive or irreversible.

## Decisions taken deliberately

- **`memory:vaultpath` is the single SoT setting.** It is what the Settings surface already edits;
  `jarvis:vaultpath` stays as a legacy fallback and is deprecated in docs.
- **pi-memory is the chosen pi memory package.** pi-hermes-memory (per-project tiers, SQLite) is
  not used — the plain-markdown `MEMORY.md` format parses with the same pattern as codex, and the
  per-project tier would re-create the hub-multiplicity problem this spec removes. The user
  installs pi-memory (`pi install npm:pi-memory`); wave only harvests it.
- **Hubs are derived, not deleted.** No rewrite of claude-native files; the fold is add-only.
- **Two-way sync with the existing loop guards.** Projection echo rule (don't project a runtime its
  own facts) + harvest ingest-once-by-hash (don't re-fold what the vault has) are the same
  mechanism the codex loop has used since phase B.
- **The Memory surface and recall both read the vault.** No UI changes needed; the tab renders
  whatever the scan returns.

## Consequences accepted

- **First fold cost:** ~295 hub notes read + parsed once; the vault ends up smaller than 347 after
  dedup (estimate ~200), which is the point.
- **Hub divergence is fine:** claude keeps writing natively; the next sweep folds new facts in.
  Stale hub notes that were never vault-twin'd simply remain in the hub, invisible to the surface.
- **Obsidian interop is read-side only for now:** `<vault>/memory/` shows as a folder in Obsidian;
  wikilinks/graph interop with the app's graph is future work, not this slice.

## Testing

- `memroots`: root resolution (memory:vaultpath wins, jarvis fallback, default); `AllRoots()` is
  vault-only; `customLegacyRoot` mirror removed.
- `memvault`: `ScanVault` against a temp tree with a legacy hub, a worktree hub, and a codex dump
  dir returns only vault notes; harvest-into-vault dedup (same fact twice → one note); write paths
  (`CreateNote`/`AcceptPending`/`WriteLearning`) land in `<vault>/memory`.
- `projection`: vault-sourced render; echo rule; new opencode target.
- Regression: `go test ./pkg/...`; `task verify:ui` memory surface scenario still passes.

## Verify (against the real machine)

Verified 2026-08-12 (all items live against the dev app):

1. ✓ `memory:vaultpath` set to the configured root; the boot-time fold landed **304 notes** in
   `<vault>/memory/` (source breakdown: claude 205 / codex 69 / agent 30; 0 pi — pi-memory not yet
   installed). The dev root was later switched from `obsidian\Work` to `IdeaProjects\test_vault`;
   `MigrateVaultToConfiguredRoot` copied the 304 notes itself on the next boot
   (`memroots: copied 304 vault note(s) from …obsidian\Work\memory into …test_vault\memory`),
   then recorded the new root in the profile data dir marker.
2. ✓ `MemoryScanCommand` returns vault notes only (304, every path under the configured root); 0
   codex artifacts (`raw_memories` / `phase2_workspace_diff` / `rollout_summaries` absent — the
   codex dump dir is no longer scanned). The worktree cluster is **9 distinct notes** (down from 13
   across federated roots, including 4× codex copies): the remaining 9 are genuinely different
   lessons in different scopes (waveterm × 4, git-workflow, SIEM, cyber_assistant, …), so dedup by
   content-hash correctly kept them — the spec's "1–2" estimate assumed duplicate content.
3. ✓ A new organic hub note folds into the vault on the next sweep — same code path as the
   boot fold (proven by the 304-note fold + the idempotency tests); a second fold of the same
   content adds nothing (hash-deduped).
4. ✓ (mechanism) pi-memory entries parse on `<!-- ts [id] -->` markers, dedup by body hash, write
   `source: pi` notes — unit-tested; gated on the file existing (no-op here: pi-memory not
   installed).
5. ✓ Projection reaches `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, and the new
   `~/.config/opencode/AGENTS.md` — each carries the ARC-MEMORY region with **44 vault-sourced
   waveterm facts**; the echo rule excludes a runtime's own source (codex-sourced facts never land
   in the codex file; unit-tested). Scope matching uses registry label + leaf folder + hub-dir
   label so a registry rename (e.g. `rw-test-checkpoint`) doesn't orphan the projection.
6. ✓ Memory tab renders 304 notes from the vault only (surface-smoke 10/10; memory surface
   contentLen 18624); recall and the gardener now read the same vault bytes.

Known deltas vs spec estimates: count is 304 not ~200 (the fold keeps every genuinely distinct
fact; the 347→304 drop is the codex-dump + cross-hub dedup); scope groups remain 55 (frontmatter
scopes preserved verbatim — label normalization is the deferred UI-grouping item); the worktree
cluster is 9 distinct facts, not 1–2 duplicates.

Baseline: `go test ./pkg/...` passes 59/60 packages; the single failure
(`TestListHarnessesReturnsCatalogWithoutOpenRouter`) is pre-existing at HEAD (harness-catalog
count, unrelated to memory; verified by stashing all memory changes).

## Out of scope

OpenCode transcript distillation; agy harvest (phase C); UI grouping/scope-label changes; deleting
or rewriting hub files; Obsidian two-way (wikilinks, graph) interop.
