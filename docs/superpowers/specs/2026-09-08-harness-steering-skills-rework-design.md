# Harness steering & skills — shared content with per-harness deltas

Date: 2026-09-08
Status: design (approved in conversation 2026-09-08)
Supersedes: `2026-09-07-harness-config-sync-design.md` (the projection/junction model below replaces
its steering-region-only preview and its junction-based skills delivery)

## Why this replaces the previous design

The previous design shipped and was unusable on a vault that had never been seeded:

- The Steering tab previewed **only** the `ARC-STEERING` region. With no region written anywhere, a
  54KB `~/.codex/AGENTS.md` rendered as `(nothing projected here yet)` — the tab showed an empty
  slice of a file full of the user's rules, and never the file.
- The seed gesture (`AgentSyncAdoptCommand`) had exactly one frontend caller, inside the skills
  rail's per-skill conflict card. That card needs a selected canonical skill; a fresh vault has zero.
  So the migration could not be started from the UI at all.
- The collection line read `4 not projected` while `Sync harnesses` dry-ran to zero actions and the
  plan card said `Everything is already in sync.` — `projectSteering` returns early when the
  canonical doc is missing.
- Adoption, had it been reachable, would have been blocked: 5 carried lines (4 pi, 1 codex) with no
  UI to fold them in, and one skill collision with no non-destructive resolution.

Two premises turned out to be wrong, and both are corrected here.

**Junctions cannot express a per-harness variant.** The one skill collision on the real tree,
`1devtool-orchestrator`, is not hand-copy drift. The codex and opencode copies are 104 lines each and
differ in exactly two places:

```
5c5      < tool: codex                      > tool: opencode
104c104  < Use your shell-exec turn… Codex's sandbox needs network access…
         > Use your shell tool…
```

That is a deliberate per-harness variant. A junction gives every harness byte-identical content by
construction, so `--prefer` can only delete one copy and point its harness at the other's `tool:`
key. Every available resolution broke a harness. Real files, plus an explicit delta, make the variant
representable.

**The markers are the mechanism, not the content.** A file needs some boundary or a re-sync
clobbers whatever the harness holds of its own. That is all the region is for. Putting the marker
comments and the region-only slice on screen presented plumbing as the product.

## What the user actually wants

One body of instructions synced across all harnesses, plus the ability to edit a particular
harness's file. Same for skills: one shared `SKILL.md`, plus a delta where a harness needs one.

Both tabs therefore reduce to one idea — **shared content, per-harness delta, one sync** — which is a
smaller system than the one it replaces.

## Inventory (measured 2026-09-08, not carried over from the previous spec)

Steering, home-level:

| File                           | Bytes | Own block (before any marker) | Has ARC-MEMORY |
| ------------------------------ | ----- | ----------------------------- | -------------- |
| `~/.claude/CLAUDE.md`          | 4132  | 53 lines                      | no             |
| `~/.codex/AGENTS.md`           | 54123 | 49 lines                      | yes            |
| `~/.pi/agent/AGENTS.md`        | 23000 | 57 lines                      | yes            |
| `~/.config/opencode/AGENTS.md` | 50735 | 0 lines                       | yes            |

No file carries an `ARC-STEERING` region. Codex is 54KB of which the own block is 3.4KB — the rest is
the memory projection, which is a separate, working feature and is not touched by this design.

Skills, home-level, user-authored:

| Skill                   | Harnesses       | Contents                         |
| ----------------------- | --------------- | -------------------------------- |
| `effort-tracking`       | claude          | `SKILL.md`                       |
| `graphify`              | claude          | `SKILL.md`, `.graphify_version`  |
| `1devtool-orchestrator` | codex, opencode | `SKILL.md`                       |
| `code-simplifier`       | codex           | `SKILL.md`, `agents/openai.yaml` |
| `review-plan`           | codex           | `SKILL.md`, `agents/openai.yaml` |
| `review-spec`           | codex           | `SKILL.md`, `agents/openai.yaml` |

The format is identical everywhere: `SKILL.md` with YAML frontmatter (`name`, `description`) plus a
markdown body. The entire harness-specific surface is two things:

1. **Extra frontmatter keys.** `tool: codex` vs `tool: opencode` is the only key that differs between
   two copies of the same skill on this tree.
2. **Sidecar files.** `agents/openai.yaml` is a codex-only launcher descriptor (`display_name`,
   `short_description`, `default_prompt`). Nothing else has one.

## Model

```
Shared                     Per-harness delta            Result on disk
─────────────────────────  ───────────────────────────  ─────────────────────────────
vault/steering/AGENTS.md   the harness file's own text  ~/.codex/AGENTS.md =
                           (outside every marker)         own + ARC-STEERING + ARC-MEMORY

vault/skills/<n>/SKILL.md  vault/skills/<n>/.arc/       ~/.codex/skills/<n>/ =
vault/skills/<n>/**          <runtime>.yaml   (fm keys)   shared tree
                             <runtime>/**     (sidecars)  + merged frontmatter
                                                          + sidecar files
                                                          + .arc-managed
```

Saving Shared writes to every present harness immediately (decided 2026-09-08). There is no
per-harness hold-back state; a harness deliberately left stale is not a workflow anyone asked for.

## Steering

### Zones

A harness file reads as three zones, assembled by `ReadHarness` from three pure slicers:

```go
type HarnessDoc struct {
    Runtime, Path string
    Present       bool
    Own           string // blockBefore: text ahead of the first managed marker — the harness's own rules
    Shared        string // regionBody: the body inside the ARC-STEERING markers
    Memory        string // memoryRegion: the ARC-MEMORY projection, for the folded read-only block
    State         string // steeringState: current | stale | absent
    Mtime         int64
    Carried       int    // len(carriedLines(Own, shared)) — what a fold would move
}

func ReadHarness(p Paths, runtime string) (HarnessDoc, error)
```

`memoryRegion` is everything from `<!-- ARC-MEMORY:BEGIN` to end of file, so content after
`ARC-MEMORY:END` stays inside `Memory`, which is read-only — nothing can be lost by the split.
`steeringState` is shared with `Status`, so a harness row and its open document cannot disagree.

`renderRegion` / `applyRegion` / `blockBefore` / `regionBody` all stay. They are the mechanism and
they are already tested; only their presentation changes.

### Writing a harness's own block

```go
func WriteHarnessOwn(p Paths, runtime, own string, baseMtime int64) (WriteResult, error)
```

Reconstructs the file as `own` + the existing managed tail, byte-for-byte:

```go
tail := strings.TrimPrefix(existing, blockBefore(existing))
next := strings.TrimRight(own, "\n") + "\n\n" + tail
```

The managed regions are never re-rendered on this path, so a harness-own edit cannot perturb the
steering or memory regions. Same mtime-conflict guard as `WriteSteering`.

### Folding a harness's rules into Shared

The seeding path, replacing the blocked adopt. `carriedLines(own, shared)` already computes exactly
the right set — lines the harness holds that Shared does not, compared as a trimmed line-set so
reordering never registers. It is demoted from a blocking check to the input of a gesture:

```go
func FoldIntoShared(p Paths, runtime string) (FoldResult, error)
```

Appends the harness's carried lines to the Shared doc, then clears that harness's own block. Returns
what moved. Nothing is auto-merged across harnesses and nothing is deleted without appearing in
Shared first; running it on each of the four harnesses in turn is the migration, and every step is
visible in the editor between steps.

### What is deleted

`ProjectionFor` and the `Projection` type; `CommandAgentSyncProjectionData` / `…RtnData`. The
harness pane now reads the whole file, not a region.

## Skills

### Canonical layout

```
~/.waveterm/vault/skills/<name>/
    SKILL.md              shared: frontmatter + body
    <shared sidecars>     e.g. .graphify_version
    .arc/
        codex.yaml        frontmatter keys merged into SKILL.md for codex only
        codex/            files copied only into codex
            agents/openai.yaml
        opencode.yaml
```

`.arc/` is the delta directory and is never itself copied to a harness. A skill with no `.arc/` is
byte-identical everywhere — the common case, five of six skills here.

### Distribution

Replaces the junction reconciler. For each present harness with a fixed skills dir, for each
canonical skill:

1. Render the target tree: shared files (excluding `.arc/`), then `SKILL.md` frontmatter merged with
   `.arc/<runtime>.yaml` if present, then `.arc/<runtime>/**` overlaid.
2. Compare against what is on disk; write only differing bytes, so mtimes stay meaningful.
3. Write `.arc-managed` into the skill dir, naming the canonical source.

Ownership is explicit rather than inferred: a skill directory is Arc's iff it contains `.arc-managed`.
A directory without one is the user's and is never written or removed — it is reported so it can be
adopted. This replaces "is a junction into `SkillsRoot()`" as the ownership test.

Removal: a directory carrying `.arc-managed` whose canonical skill no longer exists is deleted. It is
a plain directory tree, so this is an ordinary `RemoveAll` with none of the reparse-point hazard the
junction design had to guard against.

### Adoption

Moving a harness's hand-maintained skill into the vault stays a `os.Rename` into
`vault/skills/<name>/`. A name held by two harnesses is no longer a refusal: the first becomes the
shared tree, and each subsequent copy is diffed against it — differing frontmatter keys are written
to `.arc/<runtime>.yaml`, differing files to `.arc/<runtime>/`. A differing **body** is the one case
that still needs a human, and it is presented as a diff rather than an error.

For `1devtool-orchestrator` on the real tree that resolves to: shared body from either copy, one
`.arc/codex.yaml` with `tool: codex`, one `.arc/opencode.yaml` with `tool: opencode`, and one body
line to reconcile by hand.

### What is deleted

`createLink` / `removeLink` / `isLink` / `linkTarget` and the `link_windows.go` / `link_other.go`
split; the `create` / `retarget` / `remove` action kinds; `SkillsLinked` on `HarnessStatus`; the
`--prefer` flag and `SkillCollision` refusal.

Pi is unaffected. It has no fixed skills dir, points `settings.json` at `~/.claude/skills`, and reads
real files there exactly as it read junctions.

## RPC surface

| Command                                          | Change                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `AgentSyncStatusCommand`                         | `Steering` stays `current`/`stale`/`absent`; `SkillsLinked` → `SkillsManaged`; `SkillsConflict` now counts unmanaged directories |
| `AgentSyncSteeringReadCommand` / `…WriteCommand` | unchanged — the Shared doc                                                                                                       |
| `AgentSyncHarnessReadCommand`                    | **new** — one harness's zones (`Own`, `Shared`, `Memory`, `Path`, `Present`, `Mtime`)                                            |
| `AgentSyncHarnessWriteCommand`                   | **new** — write a harness's own block, mtime-guarded                                                                             |
| `AgentSyncFoldCommand`                           | **new** — fold one harness's carried lines into Shared                                                                           |
| `AgentSyncApplyCommand`                          | unchanged shape; action kinds become `steering-write` / `skill-write` / `skill-remove` / `skill-unmanaged`                       |
| `AgentSyncAdoptCommand`                          | keeps `Apply`; loses `Prefer` and `AcceptLoss`                                                                                   |
| `AgentSyncProjectionCommand`                     | **removed**                                                                                                                      |

`task generate` after the types land.

## UI

### Steering tab

```
[ Shared ]   [ Pi ]   [ Claude Code ]   [ Codex ]   [ OpenCode ]
```

- **Shared** — the editor that exists today, relabelled. Save writes the doc and syncs every present
  harness. No marker text anywhere on screen.
- **A harness tab** — the whole file, in three zones top to bottom: the harness's own text as a live
  editor; the shared block greyed and read-only with an _Edit in Shared_ jump; the memory region
  collapsed behind a one-line summary. A _Move my rules into Shared_ button on the own zone runs the
  fold.

### Skills tab

The matrix stays — it is the right shape — with cells reading `synced` / `differs` / `unmanaged` /
`—` instead of `linked` / `will link` / `conflict`. The rail's skill detail gains the delta: which
harnesses have an `.arc/` override and what key or file it changes.

### Collection line

`SyncStatus` must stop contradicting the button. When the Shared doc is empty it reads
`no shared doc yet` and the button opens the fold gesture rather than an empty dry run.

## Testing

Pure functions with a `_test.go` beside them, per repo convention:

- `zonesOf` — own-only file; own + steering; own + steering + memory; memory-only (opencode's shape,
  own is empty); content after `ARC-MEMORY:END`.
- `WriteHarnessOwn` — managed tail byte-identical after a write; mtime conflict refuses.
- `FoldIntoShared` — carried lines appended, own cleared, second run a no-op.
- Skill render — shared only; frontmatter merge; sidecar overlay; `.arc/` never copied; idempotent
  second render writes nothing.
- Ownership — a directory without `.arc-managed` is never written or removed.
- Adopt — two copies differing only in a frontmatter key produce two `.arc/<runtime>.yaml` files and
  one shared body; differing bodies surface as a diff, not a write.

Filesystem-touching tests confined to a temp dir.

Visual: extend the `surface-smoke` coverage with a `vault-steering` scenario — goto vault, select
steering, click each harness tab, assert the own zone renders non-empty for codex.

## Out of scope

Unchanged from the previous design: project-level `CLAUDE.md`/`AGENTS.md`, plugin-provided skills,
harvest-back, filesystem watchers, subagents and slash commands. Also out: per-project steering
variants, and any per-harness hold-back of a Shared save.
