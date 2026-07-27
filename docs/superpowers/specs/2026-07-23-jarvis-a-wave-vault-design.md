# Jarvis sub-project A — Wave Vault foundation — design

**Date:** 2026-07-23
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [meta spec](2026-07-23-jarvis-second-brain-meta-spec.md)).

## Where A sits

Sub-project **A** of the [Jarvis second-brain meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the storage substrate the rest of v1 rests on. Everything above it (B dossier, C recall, D attribution, E continuity) reads and writes through A's two APIs. The meta spec's contract-first build order is `G → F → A/B → C → D → E`; G shipped and F is in flight against an SQLite recall **shim**, so A is built now as the first real-substrate slice — the thing that eventually replaces F's shim behind the same higher contracts.

This spec assumes the [Wave Vault brief](../briefs/2026-07-22-jarvis-second-brain-wave-vault-brief.md) (approved storage direction), the [Jarvis second-brain design](2026-07-22-jarvis-second-brain-design.md) (write-ownership contract, recall layers), and the meta spec's [cross-cutting invariants](2026-07-23-jarvis-second-brain-meta-spec.md#cross-cutting-invariants). It inherits as hard constraints: invariant 1 (determinism boundary = cost boundary — **everything A does is deterministic and free; A never calls a model**), invariant 3 (Markdown is canonical; any index is rebuildable), invariant 4 (collection boundary in code, not prompt), and invariant 5 (region-aware, diff-validated, conflict-aware write-ownership).

## What A delivers

1. **A git-backed Wave Vault** — created/located at a user-selectable path (default `~/.waveterm/vault/`), its own git repo, scaffolded with the collection boundary (`memory/ · tasks/{active,archive}/ · decisions/ · attachments/`).
2. **A deterministic read API** — structured frontmatter query, full-text search, the bounded wikilink-neighborhood walk, per-node content hash — all scoped per caller by the collection boundary.
3. **A region-aware write path** — the generic splice + diff-validate + conflict-aware mechanism that can only mutate machine-owned regions. The *mechanism* is A's; *which* regions are machine-owned is B's policy, passed in as a `RegionSpec`.
4. **Ownership-staged commits with a coarse cadence** — consumers trigger narrative commits at lifecycle boundaries; A guarantees durability with an idle-debounce + quit safety flush; machine changes are authored as `Jarvis`, human changes as the user.
5. **A rebuildable derived layer** — an in-memory index (frontmatter + full-text + wikilink graph + content hash) kept out of the vault, rebuilt on demand from the files.

A is a pure Go package (`pkg/wavevault`) consumed **in-process** by B/C/E/F inside `wavesrv`. It exposes **no wshrpc/wire types**, ships **no frontend**, and needs **no `task generate`**.

## What A deliberately does NOT do

- **No model calls.** A is entirely deterministic (invariant 1). Summarization, synthesis, and traversal navigation live above A.
- **No embedding index** (v2) and **no persistent on-disk derived index** — the derived layer is in-memory and rebuilt on demand. Persistence is added only when C's needs or a measured scan cost justify it (measure before optimizing).
- **No dossier schema and no concrete machine regions** — that is sub-project B. A defines the `RegionSpec` *mechanism* only.
- **No memvault migration / unification.** The existing memory vault (`pkg/memvault`, `~/.waveterm/memory`) and the Memory surface are left untouched; the two durable-knowledge roots coexist. Recorded in `docs/deferred.md` ("Jarvis sub-project A — memory vault coexists, unify later").
- **No hunk-level ownership staging** — ownership staging is file-granular in v1 (see §6).
- **No cross-machine sync** — a user-configured git remote provides it; Wave implements no sync.
- **No wire/RPC surface** — A's consumers are in-process Go; the RPC surface belongs to F.

## Architecture

`pkg/wavevault`, a sibling to `pkg/memvault` and `pkg/gitinfo`. Git is shelled out to the `git` binary (no go-git), following `gitinfo`'s deliberate convention — A adds the write side (`init`/`add`/`commit --author`) that `gitinfo` (query + worktree + revert only) lacks. A owns its **own lossless parser**, distinct from memvault's lossy typed parser, because the region-aware splice requires byte-exact round-trips.

Proposed files:

| File | Responsibility |
|---|---|
| `vault.go` | Locate/create/`git init` the vault; resolve the path from config; scaffold the collection dirs; the `Vault` handle + `Scope`/`Retriever`. |
| `parse.go` | Lossless parse (`ordered frontmatter + verbatim body + links + content hash`) and serialize (byte-exact round-trip). |
| `read.go` | The read API: `Query` / `Search` / `Expand` / `Read`, scoped. |
| `index.go` | The in-memory derived layer: build-on-demand, per-file invalidation. |
| `region.go` | `RegionSpec` (the A/B contract), `RegionEdit`, and the splice + diff-validate core. |
| `write.go` | `Write` (splice + diff-validate + conflict-aware), tracking the machine-written file set. |
| `commit.go` | Ownership-staged `Commit(label)`; idle-debounce + quit safety flush. |
| `git.go` | Thin git shell-out helpers (`init`/`add`/`commit`/`status`/`config`), mirroring `gitinfo`'s `run`/`runErr` pattern with a fixed timeout. |

## 1. Vault layout, bootstrap, collection boundary

Zero-config. On first use A resolves the vault path — default `~/.waveterm/vault/`, overridable via a new config key `jarvis:vaultpath` → `Settings.JarvisVaultPath` (mirroring memvault's `memory:vaultpath`/`MemoryVaultPath`, resolved via `wconfig.GetWatcher().GetFullConfig()` + `wavebase.ExpandHomeDirSafe`) — creates the directory tree, and `git init`s it if it is not already a repo:

```text
<vault>/
├── memory/
├── tasks/
│   ├── active/
│   └── archive/
├── decisions/
└── attachments/
```

On init A ensures a repo-local git identity exists (`git config user.name/user.email`), falling back to the OS user (or a `Wave <wave@localhost>` default) if none is resolvable, so human-authored commits can never fail with "unknown identity".

**Collection boundary = `Scope`** (invariant 4). A `Scope` is a set of collections. A hands each caller a **scoped retriever** via `v.Retriever(scope)`; that retriever's `Query`/`Search`/`Expand`/`Read` **physically only walk the scoped collection dirs**. A worker-prompt retriever is constructed *without* `tasks/` (only `memory/` + that task's constraining decisions), so it **cannot** see other tasks — the boundary is enforced by the tool set handed to the caller, not by a prompt. Interactive callers get an all-collections scope.

## 2. Parse / serialize (lossless)

A's parser is its own, distinct from memvault's typed `parseNote` (which reads only known keys and discards the rest). A parses a file into:

```go
type Node struct {
    ID          string            // frontmatter id/name, else filename stem
    Path        string            // absolute
    Collection  string            // memory | tasks | decisions | attachments
    Frontmatter *orderedmap       // ALL keys, order-preserving
    Links       []string          // [[targets]] from the body, in order, deduped
    ContentHash string            // sha256 of the raw file bytes
    UpdatedTs   int64             // mtime, UnixMilli
}
```

Serialize round-trips **byte-exact** for any region the write path does not touch — this is the precondition that lets the splice mutate one region and leave everything else provably unchanged. Wikilink extraction reuses the same `[[...]]` grammar memvault uses. memvault is not modified (coexist decision).

## 3. Read API (deterministic, free)

All methods hang off a scoped retriever and read from the in-memory index (§4):

- `Query(filter Filter) ([]Node, error)` — structured frontmatter `WHERE` (status, ticket id, tags, actor, dates, wikilink presence). Answers the bulk of recall as a filter over the frontmatter index.
- `Search(query string) ([]Hit, error)` — full-text over body prose + fenced records; deterministic keyword/phrase match, returning the node + matching section refs.
- `Expand(seeds []string, opts ExpandOpts) (*Subgraph, error)` — the **bounded wikilink-neighborhood walk**: breadth-first from the seed nodes, following typed edges, to a bounded `Depth` and `Fanout`, optionally filtered to named `EdgeTypes`. Returns the assembled subgraph (nodes + edges) and the traversal paths. This is A's primitive; C later drives the model loop that picks seeds and requests one more named expansion — A just walks. It lives in A now (no deferral to C).
- `Read(id string) (*NodeWithBody, error)` — the node plus its verbatim body and content hash.

The traversal path returned by `Expand` **is** the citation material grounding consumes (invariant 7); A surfaces the path, freshness resolution against authoritative stores happens above A at synthesis time.

## 4. Derived layer (in-memory, rebuildable)

A single in-memory structure built on demand from a directory scan and cached for the process lifetime: the frontmatter index (for `Query`), a full-text index (for `Search`), the wikilink graph (for `Expand`), and per-node content hashes. Invalidation is per-file on any write A performs and on an mtime change detected at read time. **No persistent SQLite index in v1** — "rebuildable from the files" (invariant 3) is satisfied trivially because there is no standing store to drift. C's cache-tier learning store is a separate concern A does not own.

## 5. Write API — region-aware, diff-validated, conflict-aware

The novel core. The **mechanism** is A's; the **policy** (which regions are machine-owned) is B's, expressed as a `RegionSpec` passed in per write:

```go
type RegionSpec struct {
    MachineKeys []string // frontmatter keys Jarvis exclusively owns
    Blocks      []string // named delimited blocks Jarvis exclusively owns
}

type RegionEdit struct {
    Kind  RegionKind // FrontmatterKey | Block
    Name  string     // the frontmatter key or block name
    Value string     // the new value for that region
}

func (v *Vault) Write(id string, spec RegionSpec, edits []RegionEdit, baseHash string) (*WriteResult, error)
```

**Machine regions are identified two ways** (per the design doc): reserved **frontmatter keys** (`spec.MachineKeys`) and named **delimited blocks** in the body using HTML-comment markers `<!-- jarvis:begin NAME -->` … `<!-- jarvis:end NAME -->` (`spec.Blocks`). Everything else — non-reserved frontmatter keys, all prose outside marked blocks — is human-owned.

**The write sequence:**

1. **Parse** the current file into regions.
2. **Splice** each `RegionEdit` into its target frontmatter key or delimited block, leaving all other bytes untouched.
3. **Diff-validate:** reconstruct the *human projection* (the file with all machine regions stripped) of the old and new content and require them **byte-identical**. If the projection changed, the splice leaked outside a machine region → **reject the write** (error, nothing written). The model/caller cannot emit a write that clobbers human text.
4. **Write** to the working tree (staged on disk, **not** committed — commit cadence is §6), record the file in the machine-written set, invalidate its index entry.

**Conflict-awareness (optimistic concurrency, mirroring memvault's mtime guard with a content hash):** the caller passes `baseHash` — the hash it last read. Before writing, A compares the on-disk hash to `baseHash`:

- **Match** → clean splice, write.
- **Mismatch** (the file changed underneath — an external Obsidian/git edit) → A re-reads current content and **re-splices the machine edits onto the current file**, preserving the human's prose edits. It returns `Conflict=true`. If the concurrent edit changed a **machine** region (a human edited inside a machine-owned region — the one true conflict), those regions are returned in `WriteResult.ConflictRegions` and are **not** overwritten: the human's value wins and is flagged; only the non-conflicting machine edits apply. Never a silent clobber.

```go
type WriteResult struct {
    Hash            string
    Conflict        bool
    ConflictRegions []string
}
```

Long-term provenance ("who last wrote this region") is answerable from **git blame** over the ownership-staged commits (§7) — the brief's stated enforcement mechanism — so the live write path needs only the `baseHash` guard, not a persistent per-region authorship snapshot.

## 6. Commit machinery & cadence

`Commit(boundaryLabel string) error` stages **by ownership** and produces up to two commits:

1. Stage the machine-written file set (tracked by the write path) → commit authored as **`Jarvis <jarvis@wave.local>`** (via `git -c user.name=Jarvis -c user.email=…​ commit`), message from `boundaryLabel`.
2. Stage the remaining changed files (human/external edits) → commit under the **repo's own git identity**.

**Ownership staging is file-granular in v1.** A file edited by *both* Jarvis and a human within one flush window commits wholesale under the human identity (hunk-level `git add -p` splitting is deferred — rare, and the diff-validated write path already covers the dangerous case of a human editing a machine region).

**Cadence (consumers trigger + A guarantees safety):** consumers (B/E, the task lifecycle) call `Commit(boundary)` at started/paused/completed — these are the narrative commits `git log` reads as the task's story. A additionally owns an **idle-debounce flush** (writes reset a timer; on idle A commits any pending staged writes under a clearly-labelled safety commit) and a **quit-time safety flush**, so a crash or a consumer that forgets a boundary never loses staged work. In the common case a consumer commits at the boundary and nothing is pending at idle, so the safety flush rarely fires and the log stays narrative.

## 7. Error handling

- **Not a git repo / `git init` fails** → surfaced to the caller; A does not silently operate on a non-repo vault (git is the write-ownership enforcement mechanism, so it is required, not optional).
- **Unresolvable git identity** → prevented at init by the repo-local fallback identity (§1); a commit never fails for "unknown identity".
- **Diff-validation failure** (a splice would touch a human region) → the write is rejected with an error and nothing is written; this is a programming error in the caller's `RegionSpec`/edits, surfaced loudly.
- **Concurrent external edit** → not an error; the conflict-aware path re-splices and flags (§5).
- **Commit failure** (git error mid-flush) → logged; staged working-tree writes are preserved on disk for the next flush, so durability degrades to "committed later", never "lost".
- **Corrupt/unparseable file in a scan** → skipped with a log line (mirroring memvault's tolerant `WalkDir`), never fails the whole scan.

## 8. Seams A exposes

- **Read API** (consumed by C, and by F once the shim is replaced): `Query` / `Search` / `Expand` / `Read` on a scoped `Retriever`; `Node` carries the per-node `ContentHash` C's learning-store invalidation keys on.
- **Write API + `RegionSpec`** (consumed by B, and by anything that writes the vault): the region-aware `Write` + ownership-staged `Commit`. `RegionSpec` is the **A/B contract** — B supplies the concrete machine keys + block names; A enforces them generically.
- **Collection boundary** (`Scope`/`Retriever`): the enforcement point for invariant 4, honored by C's per-caller retrievers.

## 9. Testing

Go tests only (backend package, no jsdom). Real `git` in a temp dir, matching `gitinfo`'s existing test pattern.

- **parse/serialize** — lossless byte-exact round-trip including unknown frontmatter keys and body; content-hash stability and change-detection.
- **read API** — `Query`/`Search`/`Expand` over a temp fixture vault; `Expand` respects `Depth`/`Fanout`/`EdgeTypes` bounds and dedupes; dangling `[[links]]` produce no edge.
- **write path** — splice a machine frontmatter key and a delimited block; **diff-validator rejects** an edit whose value would alter a human region; `Conflict=true` + `ConflictRegions` when the file changed underneath and a machine region was externally edited; human prose preserved across a re-splice.
- **collection boundary** — a worker-scoped retriever (no `tasks/`) returns nothing from `tasks/`, while an interactive-scoped retriever sees it.
- **commit / cadence** — `git init` on first use + fallback identity; ownership staging (a machine-written file lands in a `Jarvis`-authored commit, a human-written file in a user-authored commit); idle/quit safety flush commits pending staged writes; `Commit(label)` uses the label as the message.

## File-touch map

**Go — new:**
- `pkg/wavevault/vault.go`, `parse.go`, `read.go`, `index.go`, `region.go`, `write.go`, `commit.go`, `git.go` (+ `*_test.go` per the testing section).

**Go — modified:**
- `pkg/wconfig` — add the `jarvis:vaultpath` setting (`Settings.JarvisVaultPath`) mirroring `MemoryVaultPath`; regenerate the config schema (`task generate` / `generateschema`, per its normal flow — this is a settings addition, not a wshrpc type).

**Docs:**
- `docs/deferred.md` — the memvault-coexist entry is already recorded (2026-07-23).
- Meta-spec tracking-table A-row link — added at A's feature-commit time (avoid mid-plan edits to that shared file, per the F-cycle precedent).

## Open risks

- **Config-schema regeneration** — adding `JarvisVaultPath` touches the generated config schema; regenerate via the normal path and verify the baseline stays clean. It is not a wshrpc type, so the codegen-bootstrap gotcha does not apply, but the schema generator must still run.
- **Full-text without an index** — `Search` over an on-demand scan is O(vault size) per query. Fine at v1 scale (dozens–hundreds of small files); if a populated vault profiles hot, the in-memory index (already built for `Query`) absorbs it, and persistence is the documented next lever — not a v1 concern.
- **Cross-restart conflict provenance** — the live write path uses a `baseHash` guard, not a persistent per-region authorship snapshot; precise "human vs machine last wrote this region" across restarts leans on git blame over the ownership-staged commits. Acceptable and by design (the brief names git blame as the enforcement mechanism), but it means the conflict path errs toward flagging rather than silently trusting an in-memory record it no longer has.
- **Windows path limits** — vault node filenames must stay bounded (memvault already hit MAX_PATH via unbounded slugs); reuse a bounded-slug discipline for any A-generated filename.
