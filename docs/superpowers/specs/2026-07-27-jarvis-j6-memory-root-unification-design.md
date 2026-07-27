# Jarvis J6 — memory root unification design

**Issue:** [J6 in `docs/jarvis-second-brain-open-issues.md`](../../jarvis-second-brain-open-issues.md) —
two durable-knowledge roots. **Date:** 2026-07-27. **Effort:** M.

## Problem

The open-issues entry frames J6 as architectural tidiness and states that unification "is a
consolidation, not a capability change". That is wrong, and the correction is the reason to do the work.

`~/.waveterm/vault/memory/` **has no writer and never has.** A grep for `CollMemory` across `pkg/`
finds the constant, `scaffoldDirs`, the two `Scope` constructors, and `resolvePath` — nothing writes
there. It is scaffolded on every `OpenVault` and included in `AllScope()` and `WorkerScope()`, so every
vault-backed consumer reads it, and every one of them reads nothing:

- `jarvisrecall.retrieve` → `selectSeeds` + `Expand` over the vault Retriever
- `jarvisembed` index / reconcile
- `jarvisattrib` semantic attribution (L4)
- `jarvisproactive` gate (S3)
- U3's whole-vault graph surface

Meanwhile the durable knowledge, measured on the development machine 2026-07-27:

| Root | Notes | Owner |
|---|---|---|
| `~/.waveterm/vault/memory/` | **0** | vault — what Jarvis reads |
| `~/.waveterm/memory/` | 1 | `memvault` legacy root |
| `~/.claude/projects/*/memory/` (14 hubs) | 286 | Claude; written by `memvault` projection + learn |
| `~/.codex/memories/` | 76 | Codex; harvested by `memvault` |
| `~/.waveterm/memory-archive/` | 12 | `memvault` archive (never scanned) |

The only path by which a memory note reaches recall today is an explicit user attachment —
`resolveAttached`'s `"memory"` case, which reaches into `memvault.ScanVault` directly. So recall already
straddles both roots, inconsistently: attached notes come from one root, traversed notes from another
that is empty.

**Consequence:** the second brain's memory lane is a no-op. Unifying it also produces the populated
vault J5 is blocked on.

## Constraint: "one root on disk" cannot be literal

`~/.claude/projects/*/memory/` and `~/.codex/memories/` are the agents' **native** memory directories.
`memvault`'s projection and harvest write there deliberately so the agents load that memory natively,
without Wave running. Moving them would break the agents. Only the Wave-owned legacy root
(`~/.waveterm/memory`) is Wave's to migrate.

So unification means: **one registry of roots, one write target, one graph** — with the agent-native
directories federated as read-only mirrors.

## Prior evidence gathered

- All 282 hub notes carrying frontmatter `name:` have **globally unique** slugs, so cross-hub
  `[[wikilinks]]` resolve cleanly — federating gains edges rather than creating collisions.
- The only ID clash is the 4 per-hub `MEMORY.md` index files, which carry no frontmatter `name:` and so
  all resolve to ID `MEMORY`. They use `[](file.md)` markdown links, not wikilinks, so they contribute
  no edges — they are junk nodes, not a graph hazard.

## Design

### 1. `pkg/memroots` — the registry

One leaf package answering "where does durable knowledge live". Imported by `memvault` and `wavevault`;
imports neither (only `wavebase` + `wconfig`, which both already use). Two consumers by construction —
the same ≥2-real-users bar sub-project F's tiering deferral set.

```go
type Mirror struct { Path, Source string }   // Source: "vault" | "claude" | "codex"

func VaultRoot() string                     // ~/.waveterm/vault   (jarvis:vaultpath override)
func MemoryRoot() string                    // <VaultRoot>/memory  — the single write target
func LegacyRoot() string                    // ~/.waveterm/memory  — the root being retired
func Mirrors() []Mirror                     // EXTERNAL roots only: ~/.claude/projects,
                                            //   ~/.codex/memories, + memory:vaultpath if custom
func AllRoots() []Mirror                    // MemoryRoot tagged "vault", then Mirrors()
func ProjectHash(cwd string) string         // "C:\U\k\p" → "C--U-k-p" (Claude's hub dir naming)
func RegistryProjects() map[string]string   // wconfig Projects: name → path
func LabelFromHash(hash string, projects map[string]string) string
func ScopeForHubDir(hubDir string) string   // "C--Users-…-krypton" → "krypton"
func ScopeForPath(rootPath, source, filePath string) string   // → project label, else "shared"
const IndexFile = "MEMORY.md"               // an index, not knowledge — both scanners skip it
```

`Mirrors()` is **externals only** so `wavevault` keeps walking its own `<root>/memory` exactly as it
does today and cannot double-scan it. `AllRoots()` is the memvault-shaped view.

`projectHash`, `labelFromHash` and `registryProjects` **move here** from `memvault/projection.go`, and
`deriveScope`'s body becomes `ScopeForPath`. This is required, not opportunistic: `wavevault` needs the
same project label and the same scope derivation, and a second copy would recreate exactly the
two-packages-hardcode-the-same-value desync that produced J8. `memvault.projectLabel` (a different
function, cwd-keyed, used only by projection) stays put.

### 2. `wavevault` — mirrors inside the memory collection

`Retriever.load()` gains one behavior: when the scope includes `CollMemory`, also walk
`memroots.Mirrors()`, tagging each node `Collection = "memory"` plus two new `Node` fields:

```go
Source string   // "vault" | "claude" | "codex"
Scope  string   // project label from ScopeForHubDir, else "shared"
```

These deliberately reuse `memvault.Note`'s existing vocabulary so both projections use one word per
concept, which is what makes a later full fold cheap.

Three properties:

- **Read-only by construction.** `resolvePath` walks only collections under `v.Root`, so `Write` cannot
  reach a mirrored file. `Commit`'s git operations are `v.Root`-scoped, so mirrors never enter vault
  history. Both get a test, not a comment.
- **Precedence becomes explicit.** `load()` today does `if !dup { order = append }` then
  unconditionally `byID[n.ID] = n` — last-seen wins for content, first-seen for ordering. Harmless with
  one root, nondeterministic across several. New rule, matching `ScanVault`'s existing one: the vault's
  own `memory/` wins; otherwise first-seen wins.
- **No signature changes.** `Scope`, `AllScope`, `WorkerScope`, `Retriever` and every consumer call site
  are untouched; consumers pick the notes up without edits.

`Node` is **not** an RPC type — `wshserver_jarvis.go` maps it through `vaultNodeToGraphNode` into
`wshrpc.GraphNode` — so adding fields to it requires no `task generate` and no TS churn. The payoff
lands instead in `jarvisrecall.nodeCandidate`, which today sets no `project` at all while its sibling
`memoryCandidate` sets `project: n.Scope`: one line makes vault citations name their project the same
way memvault ones already do.

### 3. `memvault` — derive, don't define

- `type Root = memroots.Mirror` (a type **alias** — the fields are already identical, so existing
  `memvault.Root{Path:…, Source:…}` literals in consumers and tests keep compiling).
- `VaultRoots()` returns `memroots.AllRoots()`; `buildRoots` and its test are deleted, replaced by
  `memroots`' own composition test.
- `DefaultVaultPath()` returns `memroots.MemoryRoot()`.
- `deriveScope` delegates to `memroots.ScopeForPath`.
- `ScanVault` skips `memroots.IndexFile`.
- `projectHash` / `labelFromHash` / `registryProjects` call sites (`HubDirForCwd`, `Harvest`,
  `repoPathForHubDir`, `Project`, `deriveScope`) switch to the `memroots` exports.

`VaultRoots()`'s contract is unchanged, so `memdistill`, `memgarden`, `reporadar` and
`wshserver_memory` need no edits. If any of them breaks, the derivation is wrong.

`MemoryCreateCommand`'s fallback target moves from `~/.waveterm/memory` to `<vault>/memory` and stays a
plain `os.WriteFile` — no vault commit. That is already semantically right: `CreateHuman` exists so
human-authored files stay out of `machineFiles` and get swept up by the next `add -A`, and cockpit notes
are human-authored. Routing them through the vault write API would produce a `WriteResult` we discard.

`memory-pending` and `memory-archive` stay where they are. They are a review queue and a recycle bin,
not durable knowledge. Under `vault/memory/` they would be pulled into the graph; elsewhere inside the
vault they would commit unreviewed machine drafts into its history.

### 4. Migration

`memroots.MigrateLegacyRoot()` — it owns the root registry, so it owns retiring a root. Steps:

1. If the **default** `~/.waveterm/memory` exists, move each `*.md` into `<vault>/memory/`.
2. A destination slug collision is **skipped, never overwritten**, and logged with both paths.
3. Remove the source dir only once empty.
4. Absent dir, or a second run, is a no-op — `stat` and return.

`MigrateLegacyRoot` itself is a plain idempotent function, callable any number of times. The
**call site** is guarded: `wavevault.OpenVault` invokes it under a package-level `sync.Once`, so two
concurrent opens cannot race on the same file moves. It is called from `OpenVault` (the production path)
and **not** from `openVaultAt`, so `OpenVaultAtForTest` never triggers it and fixture vaults stay
hermetic. Tests call `MigrateLegacyRoot` directly against temp dirs, including twice in a row.

A `memory:vaultpath` set to a custom directory is **never moved** — it enters `Mirrors()` and is read in
place. The file-moving path only ever runs against Wave's own default location.

## Decisions taken deliberately

**Federation is unconditional — no kill-switch config.** A `memory:federate` flag would be
config-before-needed. Embeddings are already off by default from J2, so the cost below only lands on a
deliberate opt-in.

**The Memory surface keeps `memvault`'s read path.** The open-issues entry lists "the Memory surface
reads through the vault API" as a verify item; this slice does not do it. `memvault.Note`'s typed
projection (`Reviewed`, `CapturedAt`, `GardenerFlag`, `SupersededBy`) drives the review / prune /
archive UI, and re-deriving it from `Node.Frontmatter`'s generic `map[string]any` buys nothing while
touching 17 files across 5 packages. After this slice both APIs read the same bytes from the same roots,
which is the property that mattered. Amend that verify line in the open-issues doc rather than leave it
looking unmet.

**Cross-project notes are tagged, not filtered.** Retrieval does not filter by project: seeds are
query-matched, so another project's note surfaces only when it genuinely matches, and "you already
solved this in krypton" is the payoff federation is for. `Source` + `Scope` exist so a citation can say
where a note came from instead of silently presenting another project's note as this project's. Real
per-project filtering (extending `inScope` to nodes) stays possible later.

## Consequences accepted, not solved

- **Embedding cost.** The first `jarvisembed` reconcile after embeddings are enabled will index ~363
  nodes instead of ~0, on the operator's own key (BYOK, invariant 12). Intended, not a regression — but
  it is real spend and should be known before flipping J2's toggle.
- **U3 graph density.** `Retriever.Graph()` goes from ~3 nodes to ~366. J5 already lists dense-graph
  legibility as a verify item; this makes it live rather than theoretical. Not tuned here.
- **4 fewer Memory-surface rows.** Skipping `MEMORY.md` removes the four colliding `MEMORY` entries the
  surface shows today.
- **Retriever load cost.** ~363 files read + parsed per logical operation, no cache.
  `MemoryScanCommand` already does exactly this on every Memory-surface load, and on the recall path it
  sits behind a multi-second model call, so it is noise. Revisit only on a latency complaint.

## Testing

**`memroots`** — table tests: default vs custom `memory:vaultpath`; mirror list composition; hub-dir →
project label (registry hit, and the trailing-segment fallback); index-file constant.

**`wavevault`** — a fixture vault plus two fake mirror roots, asserting: mirrored notes appear in
`CollMemory`; they carry the right `Source` / `Scope`; a wikilink across two roots resolves to an edge;
`Write` and `resolvePath` cannot reach a mirrored path; `git status` in the vault stays clean after a
mirror scan; an ID present in both the vault's `memory/` and a mirror resolves to the vault's copy;
`MEMORY.md` is absent from the graph.

**Migration** — happy path; collision is skipped and reported; absent source dir; custom
`memory:vaultpath` untouched; second run is a no-op.

**Regression** — `go test ./pkg/...`. `memdistill`, `memgarden`, `reporadar` and `wshserver_memory`
should need no changes.

## Verify (against the real machine)

1. One Wave-owned root on disk: `~/.waveterm/memory` gone, its note under `~/.waveterm/vault/memory/`.
2. `MemoryScanCommand` still returns ~363 notes with correct `Source` / `Scope`, minus the 4 `MEMORY`
   rows.
3. A vault `Retriever` with `AllScope()` returns those same notes — the assertion that the memory lane
   is no longer empty.
4. A recall whose answer lives only in a Claude hub note cites that note **without** the user attaching
   it. This is the end-to-end proof and the thing that is impossible today.
5. `git -C ~/.waveterm/vault status` is clean after a recall.

## Out of scope

Folding the Memory surface onto the vault read API (§ Decisions). Moving the agent-native directories
(§ Constraint). Per-project retrieval filtering (§ Decisions). Calibrating any constant this exposes —
that is J5, and this slice is its precondition.
