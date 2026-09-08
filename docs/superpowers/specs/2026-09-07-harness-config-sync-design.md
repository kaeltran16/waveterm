# Harness config sync — design

> **Superseded 2026-09-08** by `2026-09-08-harness-steering-skills-rework-design.md`.
> Two premises here proved wrong in use: the steering UI showed only the generated region
> (so an unsynced harness read as empty), and directory junctions cannot express a
> per-harness variant, which blocked the one real skill collision on the tree. Kept for the
> drift measurements and the marker mechanics, both of which the rework reuses.

Date: 2026-09-07
Status: design (approved in brainstorming; pending spec review)
Builds on: `2026-07-01-memory-sync-engine-design.md` (the delimited-region projection precedent),
`pkg/harness` (the installed-harness catalog)

## Summary

Steering files and skills are duplicated by hand across four harnesses and have already diverged.
This spec makes the Wave Vault the single source of truth for both and projects them outward:
a delimited `ARC-STEERING` region written into each harness's home-level steering file, and one
directory junction per skill into each harness's skills directory.

One direction only. Nothing is harvested back, no file is watched, and no harness's own
enable/disable state is ever written by Arc.

## Problem: the drift is measured, not hypothetical

Steering files, home-level, as of 2026-09-07:

| File | Lines | Preferences block | Memory region |
| --- | --- | --- | --- |
| `~/.claude/CLAUDE.md` | 52 | 10 sections | — |
| `~/.codex/AGENTS.md` | 488 | 9 sections (no Browser & Web-UI Verification) | lines 49-488 |
| `~/.pi/agent/AGENTS.md` | 189 | 10 sections **plus 4 rules no other copy has** | lines 57-189 |
| `~/.config/opencode/AGENTS.md` | 440 | none | lines 1-440 |

Pi's block is not a stale copy — it uniquely carries the solution ladder, "Reuse before write", the
longer "Stay minimal" clause, and a pre-commit simplify-review rule. Any migration that assumes one
file is the superset destroys authored content. See Adoption.

Of those four, the first three fold into the canonical doc. The pre-commit simplify-review rule is
**deliberately dropped** (decided 2026-09-07) and is the one known intentional loss this migration
carries.

Skills, home-level, user-authored (plugin-provided skills excluded):

| Harness | Discovery | Holds |
| --- | --- | --- |
| claude | scans `~/.claude/skills/<name>/SKILL.md` | effort-tracking, graphify |
| codex | scans `~/.codex/skills/<name>/SKILL.md`, with `[[skills.config]]` per-path enable/disable overrides in `config.toml` | 1devtool-orchestrator, code-simplifier, review-plan, review-spec |
| opencode | scans `~/.config/opencode/skills/<name>/SKILL.md` | 1devtool-orchestrator |
| pi | reads every path in `settings.json` `skills: [...]`; no fixed directory | currently `["~/.claude/skills", "!~/.claude/skills/simplify"]`, so it sees 2 of 6 |

Six distinct skills, each visible to one or two of four harnesses. `1devtool-orchestrator/SKILL.md`
exists under codex and opencode at 104 lines each with different md5s
(`22eaa47d…` vs `ef5cfe2e…`) — hand-copied, then diverged.

## Topology

```
   vault/steering/AGENTS.md ──▶ ARC-STEERING region in  ~/.claude/CLAUDE.md
   (canonical)                                          ~/.codex/AGENTS.md
                                                        ~/.config/opencode/AGENTS.md
                                                        ~/.pi/agent/AGENTS.md

   vault/skills/<name>/ ──────▶ junction  ~/.claude/skills/<name>
                                junction  ~/.codex/skills/<name>
                                junction  ~/.config/opencode/skills/<name>
                                (pi: no action — its pointer at ~/.claude/skills
                                 traverses the junctions transitively)
```

## Decisions (locked in brainstorming)

| Decision | Choice |
| --- | --- |
| Source of truth | **Arc-owned**, in the Wave Vault. Every harness including Claude receives a generated artifact. |
| Scope | Steering files and skills. Not subagents, not slash commands/prompts. |
| File scope | **Home-level only.** Never a git-tracked file, matching the memory engine's rule. |
| Skills delivery | **Directory junctions** into each harness's fixed skills dir. |
| Pi's skills leg | **No config edit.** Its existing pointer at `~/.claude/skills` sees the whole farm and its `!` exclusion keeps working. |
| Trigger | **Agent launch + manual button**, reusing the hook `MemoryProjectCommand` already fires on. No watcher. |
| Migration | **Seed canonical from `~/.claude/CLAUDE.md`, replace the copies** — guarded so no authored line can be dropped silently. |
| Override ownership | Arc distributes *availability*. Codex's `[[skills.config]]` and pi's `!` exclusions stay the user's. |
| Packaging | New leaf package `pkg/agentsync`; per-harness paths move into `pkg/harness`. |

## Canonical store

Two new collections beside the vault's existing `memory` collection, registered in `pkg/memroots`
(whose charter is already the vault root and its collections; its package doc widens from
"durable-knowledge locations" to "vault locations"):

```
~/.waveterm/vault/steering/AGENTS.md    canonical steering doc
~/.waveterm/vault/skills/<name>/        canonical skill trees
```

```go
func SteeringDocPath() string  // VaultRoot()/steering/AGENTS.md
func SkillsRoot() string       // VaultRoot()/skills
```

One steering file rather than a collection of notes: the content is a single preferences block, and
nothing yet asks for per-harness or per-project variants. A skill is a tree, not a file — codex's
`code-simplifier/` carries an `agents/` subdirectory — so the canonical unit is the directory.

## Harness catalog extension

`harness.Spec` grows the per-harness config-surface paths, as path segments resolved by pure methods
so they are table-testable with no filesystem:

```go
type Spec struct {
    // ...existing fields
    SteeringRel []string // {".codex", "AGENTS.md"}
    SkillsRel   []string // {".codex", "skills"}; nil when the harness has no fixed dir
}

func (s Spec) SteeringPath(home string) string
func (s Spec) SkillsPath(home string) string // "" when SkillsRel is nil
```

| Runtime | SteeringRel | SkillsRel |
| --- | --- | --- |
| claude | `.claude/CLAUDE.md` | `.claude/skills` |
| codex | `.codex/AGENTS.md` | `.codex/skills` |
| opencode | `.config/opencode/AGENTS.md` | `.config/opencode/skills` |
| pi | `.pi/agent/AGENTS.md` | nil |

`memvault.steeringTargets()` then derives its codex and opencode paths from the catalog instead of
hardcoding them. Behavior is unchanged — same two runtimes, same paths — but one fewer place knows
where codex lives. `pkg/harness` imports only stdlib, so there is no cycle.

## Steering projection

The region, matching the `ARC-MEMORY` pattern already in these files:

```
<!-- ARC-STEERING:BEGIN (generated — do not edit; managed by Arc) -->
<!-- ARC-STEERING:END -->
```

Placement, in order:

1. Region already present → replace in place.
2. No region, but an `<!-- ARC-MEMORY:BEGIN` marker exists → insert immediately **before** it.
3. Otherwise → append.

Rule 2 exists because codex's memory region is 438 lines; appending would bury the preferences at the
bottom of the file where they read last.

Output is byte-identical when the canonical doc has not changed, and an unchanged render is not
written — so mtimes stay stable and status can distinguish current from stale. Content is projected
verbatim; there is no per-harness templating.

A harness is acted on only when its **config root** already exists — the directory holding its
steering file and skills dir (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.pi/agent`). Arc never
creates a config root for a harness that has never run; such a harness reports `not present`. The same
gate applies to the skills reconciler below.

## Skills reconciler

For each harness with a non-nil `SkillsRel` whose config root exists, reconcile the desired set
(one junction per canonical skill) against what is on disk. The skills directory itself is created if
absent — that is Arc's own target, not the harness's config root:

| Observed at `<harness>/skills/<name>` | Action |
| --- | --- |
| nothing | create junction → `vault/skills/<name>` |
| junction to the correct target | no-op |
| junction to a different target | remove link, recreate |
| **a real directory** | **never touched**; reported as a conflict for Adoption to resolve |
| junction into the vault whose canonical skill no longer exists | remove the link |

Two safety invariants, each with a unit test:

- Never `RemoveAll` a path whose `Lstat` reports a reparse point — remove the link itself. This is the
  exact hazard documented in `scripts/worktree-junctions.mjs`: a recursive delete that follows a
  junction destroys the target's contents.
- Never touch an entry in a harness's skills directory that is not a junction into `SkillsRoot()`.
  Anything else is the user's, including a real directory that shares a canonical skill's name.

Link mechanics split by platform:

- Windows (`link_windows.go`): `cmd /c mklink /J <link> <target>`. Junctions need no privilege,
  whereas `os.Symlink` requires Developer Mode or `SeCreateSymbolicLinkPrivilege`.
- Elsewhere (`link_other.go`): `os.Symlink`.

Pi requires no filesystem action. Status reports its skills as reached through `~/.claude/skills` and
warns — never edits — if pi's `skills` array no longer contains a path that resolves into the farm.

## Adoption

A one-time migration. Dry-run by default; `--apply` commits; every rewritten file gets a `.bak` first.

**Steering.** Canonical is seeded from `~/.claude/CLAUDE.md`. Each target's pre-region block is then
replaced by the projected region. Because pi's block provably contains four rules no other copy has,
the seed cannot be trusted as a superset, so:

> Apply **refuses** while any harness's existing block contains a *carried line* absent from the
> canonical doc. The dry-run report is the per-harness diff. The user folds the missing lines into the
> canonical doc (via the editor or directly) and re-runs. `--accept-loss` is the explicit override.

A **carried line** is a line that, after trimming leading and trailing whitespace, is non-empty and
does not appear verbatim (under the same trimming) anywhere in the canonical doc. Blank lines and
pure-whitespace differences never block. Comparison is line-set, not positional: reordering a rule
between harnesses is not a loss.

This makes silent loss mechanically impossible rather than dependent on someone reading a diff.

For this migration the expected end state is: three of pi's four unique rules folded in, and
`--accept-loss` used once to accept the deliberate drop of the pre-commit simplify-review rule. A
finer-grained per-line decline list is not built — one known drop in a one-time migration does not
earn the machinery.

**Skills.** Each real directory in a harness's skills dir is moved into `vault/skills/<name>`, then
junctioned back. Name collisions across harnesses are **refused, never merged**: adopt reports every
path holding that name with its content hash and requires a choice
(`--prefer codex:1devtool-orchestrator`, or resolution by hand). This is the only step where bytes can
be lost, so it is the only step with no default.

## RPC surface

New domain `pkg/wshrpc/wshrpctypes_agentsync.go`, implemented in
`pkg/wshrpc/wshserver/wshserver_agentsync.go`:

| Command | Purpose |
| --- | --- |
| `AgentSyncStatusCommand` | Per harness: present, steering state (`current` / `stale` / `absent`), skills linked and conflicting counts |
| `AgentSyncApplyCommand{DryRun}` | The plan, or the applied actions |
| `AgentSyncAdoptCommand{Apply, Prefer}` | Migration plan or application, including the refusal reasons above |
| `AgentSyncSteeringReadCommand` / `…WriteCommand` | Canonical doc, with the same mtime-conflict guard `memvault.WriteNote` uses |

Regenerate bindings with `task generate` after the types land.

## Trigger

`AgentSyncApplyCommand` fires wherever `MemoryProjectCommand` already does at launch —
`frontend/app/cockpit/cockpit-actions.ts:94` — plus the manual button. No watcher, no new lifecycle,
and no harness can start against a stale region.

## UI

A tenth section in `frontend/app/view/agents/settingssurface.tsx`, placed after `MemorySection` (both
are vault-backed), reusing that file's `SectionLabel` / `Row` / button primitives and taking a
deep-link id in the manner of `SETTINGS_SECTION_EMBEDDINGS`. The file already carries a
`FLAG_RUNTIMES` list of exactly these four harnesses for the row set to match.

```
HARNESS SYNC

Canonical steering                        ~/.waveterm/vault/steering/AGENTS.md
Projected into every harness's steering file.                      [ Edit ]

  # Personal Preferences
  Context: Senior software architect. Prefer simple, direct...
  ...                                                      52 lines

  Claude Code     steering current       skills  6 linked
  Codex           steering stale         skills  4 linked · 1 conflict
  OpenCode        steering not present   skills  6 linked
  Pi              steering current       skills  via ~/.claude/skills

                            [ Review adoption… ]   [ Sync now ]
```

Edit opens a modal with a plain textarea and an mtime-guarded save, not an inline or cross-surface
editor: this file changes a few times a month. "Review adoption…" opens the dry-run plan, including
any refusal that needs a decision. Status chips use the `success` / `warning` / `muted` theme tokens —
no raw colors.

`SyncStrip` (the Memory surface's projection strip) stays as it is; it is memory-specific and its
runtime list is memory's, not this feature's.

## CLI

`wsh agent-sync status | sync [--dry-run] | adopt [--apply] [--prefer <runtime>:<skill>] [--accept-loss]`,
following the existing `wsh agent-memory-project` shape.

The CLI carries the whole feature without any frontend, which sets the build order: Go and `wsh`
first, verifiable end to end, then the Settings section as a thinner second step.

## Testing

Pure functions, per repo convention (`foo.ts`/`foo.go` + `foo_test` beside it):

- `Spec.SteeringPath` / `SkillsPath` resolution — table test, all four runtimes plus the nil case.
- Region placement — appended when absent; replaced in place when present; **inserted before an
  existing `ARC-MEMORY` region**; second application byte-identical; content outside the markers
  untouched.
- Reconcile plan from (canonical set, observed directory entries) → actions, covering every row of the
  reconcile table, especially real-directory conflict and orphan-junction removal.
- Adoption plan — seed extraction, the missing-line refusal, and collision detection by name and hash.

Filesystem-touching tests are confined to link create/read/remove against a temp dir.

Visual: a `harness-sync` scenario in `scripts/cdp/scenarios.mjs` — goto settings, scroll the section
into view, assert four rows with statuses, screenshot. Run via `task verify:ui -- harness-sync`.
No jsdom render test, per the declined-surface-render-tests decision.

## Out of scope

- Project-level `CLAUDE.md` / `AGENTS.md` pairs. Arc writes no git-tracked file.
- Plugin-provided skills. Three separate plugin managers own those (claude's plugin cache, codex's
  marketplaces, pi's `packages`).
- Harvest back from any harness. Projection is one-way.
- A filesystem watcher on the canonical store.
- Per-harness templating of the steering body.
- Writing any harness's enable/disable state.
- Subagents (`~/.claude/agents`) and slash commands/prompts. Deliberately deferred; the same catalog
  and junction machinery would extend to them if wanted later.

## Risks to verify during implementation

- `os.Readlink` returns a `\\?\`-prefixed target for a Windows junction; target comparison must
  normalize it before deciding a link is correct.
- Confirm `os.Lstat` reports `ModeSymlink` for a junction on the Go version in use, since the whole
  safety layer keys off that check.
- Smoke-check that each harness's skill scanner actually traverses a junction. Expected — junctions are
  transparent to the filesystem API — but it is the assumption the entire skills half rests on, so it
  is worth one manual confirmation before building the reconciler.
