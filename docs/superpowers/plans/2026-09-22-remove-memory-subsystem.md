# Remove the Arc memory subsystem

Status: awaiting approval. Execute in a fresh session that reads this file from disk.

## Why

Measured across 416 Claude Code sessions and 458 Pi sessions:

- Note bodies are opened in 5.3% of sessions. The behaviour that memory demonstrably drives comes from
  the one-line `MEMORY.md` index entries, not the 867 note bodies behind them.
- Pi is write-only. Arc regenerates `~/.pi/agent/memory/projects/waveterm.md` (87,048 bytes) on every
  Pi session start and nothing reads it: pi-memory is not in `~/.pi/agent/settings.json` packages, qmd
  is not installed so `memory_search` cannot run, and `waveterm-memory.ts` has no injection hook. Zero
  real `memory_search` calls in 458 transcripts; `ARC-MEMORY` last referenced 2026-08-14.
- The projected store is 218 files, 131 of them empty 290-byte stubs named after ephemeral worktree ids.
- Recall telemetry has never worked: `slugify` renames `_`→`-` on harvest so every stamp misses, and
  `writeSourcedNote` never serializes `reference_count`.

Claude Code's own native memory works and is unaffected by this change. It is a separate system that
happens to share the hub directory.

## Scope

### Deleted — Go

| Path | Size |
|---|---|
| `pkg/memvault/` | 29 files, 4,856 lines |
| `pkg/memdistill/` | whole package |
| `pkg/memgarden/` | whole package |
| `pkg/wshrpc/wshserver/wshserver_memory.go` | 17 RPC handlers |
| `pkg/reporadar/collect_memory.go`, `collect_memory_test.go` | 2 files |
| `cmd/wsh/cmd/wshcmd-memory.go` | 1 file |
| `cmd/wsh/cmd/wshcmd-agent-memory-hook.go` | 1 file |
| `cmd/wsh/cmd/wshcmd-agent-memory-project.go`, `_test.go` | 2 files |
| `cmd/wsh/cmd/pi-memory-extension.ts`, `.test.ts` | 2 files |
| `pi/extensions/waveterm-memory.ts` | source of the above |

### Deleted — frontend

`frontend/app/view/agents/`: `memgraph.tsx`, `memstore.ts`, `memstore.test.ts`, `memtypes.ts`,
`memtypes.test.ts`, `newmemorymodal.tsx`, `vaultline.tsx`, `vaultmemory.tsx`, `vaultrail.tsx`,
`vaultreader.tsx`, `vaultskills.tsx`, `vaultsteering.tsx`, `vaultstore.ts`, `vaultsurface.tsx`,
`vaulttriage.ts`, `vaulttriage.test.ts` (16 files).

`frontend/app/view/jarvis/petdecaypoller.tsx` (polls memory decay; nothing else uses it).

### Kept — and why

These matched a `mem`/`vault` grep but are **not** part of this subsystem. Deleting them breaks
unrelated features.

- **`pkg/memroots/`** — path resolver. `pkg/wavevault` and `pkg/agentsync` both import it.
- **`pkg/wavevault/`** — the Wave Vault abstraction over all collections (`memory`, `tasks`,
  `decisions`, `attachments`, …). Imported by **45 files** across `jarvisattrib`, `jarvisembed`,
  `jarviscapture`, `jarviscontinuity`, `jarvisdossier`, `jarvisproactive`, `jarvisstate`,
  `jarvisvolunteer`, `jarvisbackfill` and the RPC server. Load-bearing for all of Jarvis.
- **`pkg/jarvisrecall/`** — owns `Ask`, `Converse`, the ask ledger and the judge, called from
  `wshserver_jarvis.go` at 13 sites. `ask.go`, `retrieve.go` and `judge.go` contain **zero** memvault
  references; only `cards.go` and `recall.go` touch it. Decouple, do not delete.
- **`pkg/agentsync/`** — projects personal preferences into `~/.claude/CLAUDE.md` and
  `~/.pi/agent/AGENTS.md`. This is the only memory-adjacent leg Pi actually receives and it works.
- **`frontend/app/view/agents/runtimemark.tsx`, `runtimemeta.ts`** — grep false positives
  (`runti-meta`). Used by `agentheader`, `statusline`, `sessionssurface`, `usagesurface`,
  `runworkercard`, `agentdetailsrail`, `channelsprimitives`.
- **`frontend/app/view/agents/memgraphlayout.ts`** — imported by `jarvisgraph.tsx`. Move it to
  `frontend/app/view/jarvis/` in step 6 rather than deleting it.

### Consequences accepted

- The **Vault surface is gone**, including its steering and skills browsers. Steering files and skills
  are still generated and still reach agents; you lose only the UI for reading them in Arc.
- The **Jarvis pet loses its memory behaviours**: decay polling, the prune badge in `petview.tsx`, the
  notes section of `petpeek.tsx`, and four pet acts in `petactrun.ts`.
- Jarvis recall no longer offers memory notes as grounding candidates. Runs, radar and the other
  sources are unaffected.
- `SURFACE_ORDER` drops from 9 to 8, so `Ctrl+1..9` becomes `Ctrl+1..8`.

## Steps

Each step ends buildable. Do them in order; the Go side must land before `task generate`.

### 1. Decouple `jarvisrecall` from `memvault`

`pkg/jarvisrecall/recall.go` — delete the `case "memory":` arm (lines 213–221):

```go
		case "radar":
```

…replacing the block that currently reads:

```go
		case "memory":
			if graph, err := memvault.ScanVault(memvault.VaultRoots()); err == nil && graph != nil {
				for _, note := range graph.Notes {
					if note.ID == parts[1] {
						out = append(out, memoryCandidate(note))
						break
					}
				}
			}
		case "radar":
```

Drop the now-unused `memvault` import from `recall.go`.

`pkg/jarvisrecall/cards.go` — delete `memoryCandidate` (line 148), `memoryFreshness` (line 162), the
`stampReferences` var (line 198), the `memNotePrefix` const, and the grounding-stamp call in
`groundingCards` that uses them. Drop the `memvault` import.

`pkg/jarvisrecall/cards_test.go` — delete the four `memvault.Note` fixtures and any test that asserts
on memory candidates or reference stamping.

Verify: `go build ./pkg/jarvisrecall/` and `go test ./pkg/jarvisrecall/`.

### 2. Cut `agentsync`'s last memvault reference

`pkg/agentsync/agentsync.go:92` — the comment references the type being deleted. `WriteResult` is
already declared locally; only the comment needs changing:

```go
// WriteResult is the outcome of a steering write: a conflict means the file changed under the editor
// and nothing was written.
type WriteResult struct {
	Mtime    int64
	Conflict bool
}
```

`memroots.SteeringDocPath` and `memroots.SkillsRoot` (lines 28–29) stay as they are.

### 3. Remove the server bootstrap

`cmd/server/main-server.go` — delete lines 639–655 in full:

```go
	memdistill.RegisterSweepHook(memgarden.Sweep)
	memdistill.RegisterSweepHook(jarvisvolunteer.SweepLooseEnds)
	memdistill.RegisterSweepHook(func() {
		memvault.EnsureRecallEpoch(time.Now())
		if n, err := memvault.RestoreDecayArchive(); err != nil {
			log.Printf("memory decay-archive restore: %v", err)
		} else if n > 0 {
			log.Printf("memory decay-archive restore: returned %d notes archived on an unfirable signal", n)
		}
		if _, _, err := memroots.MigrateVaultToConfiguredRoot(); err != nil {
			log.Printf("memory vault-path migration: %v", err)
		}
		if _, _, err := memvault.HarvestAll(); err != nil {
			log.Printf("memory harvest sweep: %v", err)
		}
	})
	memdistill.Start(context.Background())
```

`jarvisvolunteer.SweepLooseEnds` was registered only through `memdistill`. It still needs a ticker, so
replace the block with a direct one:

```go
	jarvisvolunteer.StartLooseEndSweep(context.Background())
```

…and add to `pkg/jarvisvolunteer/looseend.go`:

```go
// StartLooseEndSweep runs the loose-end sweep on its own ticker. It previously rode memdistill's
// sweep hook, which is gone.
func StartLooseEndSweep(ctx context.Context) {
	go func() {
		t := time.NewTicker(15 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				SweepLooseEnds()
			}
		}
	}()
}
```

Drop the `memdistill`, `memgarden`, `memvault`, `memroots` imports from `main-server.go` (confirm
`memroots` has no other use there first).

### 4. Delete the Go files and packages

Everything in the "Deleted — Go" table. Then remove the memory hook entries from
`cmd/wsh/cmd/wshcmd-installhooks.go`:

- line 42: `{"SessionEnd", "", "agent-memory-hook", 10},`
- line 45: `{"SessionStart", "startup|clear|compact", "agent-memory-project", 15},`
- lines 76–77: drop `"agent-memory-hook"`, `"agent-memory-project"` and
  `"agent-memory-project --inject"` from the `isManagedCommand` allowlist
- line 383: the `//go:embed pi-memory-extension.ts` directive and its var
- lines 539–562: `installPiMemoryExtension` and its call site

Leaving the allowlist entries in is what lets a stale hook survive a reinstall, so they must go in the
same change.

Verify: `go build ./...` then `task build:backend:quickdev:windows`.

### 5. Remove the RPC surface and regenerate

Delete the 17 `Memory*Command` declarations from `pkg/wshrpc/wshrpctypes.go` and their `Command*Data`
/ `Command*RtnData` structs, then:

```
task generate
```

This rewrites `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` and
`pkg/wshrpc/wshclient/wshclient.go`. Never hand-edit them.

### 6. Frontend

`frontend/app/view/agents/agents.tsx` — remove `| "vault"` from the union (line 42) and `"vault"` from
`SURFACE_ORDER` (line 56). Update the comment above `SURFACE_ORDER` from "All 9 entries" to 8.

`frontend/app/view/agents/navrail.tsx` — remove the Vault item so the rail matches `SURFACE_ORDER`.

`frontend/app/store/keybindings/bindings.ts` — remove the `vaultstore` / `vaulttriage` imports
(lines 31–38), the `{ letter: "v", surface: "vault", … }` entry (line 106), `"vault"` from
`ESC_HOME_SURFACES` (line 126), the `vaultReaderAtom` guards (lines 335, 342), the stale comment at
line 516, and `buildVaultBindings()` (line 1237 to the end of the function) plus its activation site.

`frontend/app/cockpit/cockpit-actions.ts` — delete the `opts.runtime === "codex"` block (lines 86–99)
that calls `MemoryHarvestCommand` and `MemoryProjectCommand`, and the comment above it describing the
harvest-then-project chain. The steering/skills sync below it stays.

`frontend/app/view/jarvis/openref.ts` — remove the `"memory-note"` variant from `OpenTarget`, its two
`case` arms (lines 57, 130) and the resolver at lines 217–238. Update `openref.test.ts` to match.

`frontend/app/view/jarvis/` pet files:
- `petview.tsx` — drop the `memPruneAtom` / `memPruneLoadedAtom` import and the prune badge.
- `petpeek.tsx` — drop `memLoadedAtom` / `memNotesAtom` / `memPruneAtom` and the notes section.
- `petactrun.ts` — drop the `memstore` and `vaultstore` imports and the acts that use
  `confirmPruneAllSuperseded`, `memViewAtom`, `pendingMemoryFocusAtom`, `vaultTabAtom`.
- `petacts.ts` — remove the corresponding `PetAct` / `PetOp` variants.
- Delete `petdecaypoller.tsx` and its mount.

`git mv frontend/app/view/agents/memgraphlayout.ts frontend/app/view/jarvis/` (plus its test), and
update the two importers: `jarvisgraph.tsx` and `memgraphlayout.test.ts`.

Delete the 16 files listed under "Deleted — frontend".

Verify: `task check:ts` (~2 min, needs a longer timeout; baseline is clean so any error is ours) and
`npx vitest run`.

### 7. Docs

- `docs/reference/architecture.md` — remove the Vault surface and memory pipeline sections.
- `docs/open-issues.md` — drop memory entries.
- `AGENTS.md` — the surface list names `vault` as the surface that replaced Memory; update it and the
  `Ctrl+1..9` reference.
- `docs/deferred.md` — record the removal with the `git show <commit>:<path>` recovery command, per
  the deferral convention.

Archived plan/brief docs under `docs/superpowers/` describe shipped history and stay as they are.

## Verification

```
go build ./...
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/...
task check:ts
npx vitest run
task build:backend:quickdev:windows
```

Then launch `task dev` and confirm: 8 surfaces in the nav rail, `Ctrl+1..8` aligned, the Jarvis surface
answers a question (exercises `jarvisrecall.Ask`), and the pet renders without the prune badge.

`task verify:ui -- surface-smoke` covers the render check.

## Data cleanup — separate commit, do last

Only after the code change is verified and committed.

1. `~/.pi/agent/memory/projects/` — delete the directory (218 files). Nothing reads it.
2. `~/.claude/projects/*/shared/` — 75 files, Arc's eviction destination. **`~/.claude` is not a git
   repo; these are unrecoverable.** Copy them into the vault repo first if any are worth keeping.
3. The `ARC-SHARED` region in each hub `MEMORY.md` — strip it, since the `../shared/` links it carries
   will be dead. Leave the rest of `MEMORY.md` alone: it is Claude Code's own index and it works.
4. `~/IdeaProjects/obsidian_vault/memory/` — 868 notes. Git-tracked, so recoverable via
   `git revert`. **Delete `memory/` only** — `tasks/`, `decisions/` and `attachments/` are Jarvis's
   corpus and `pkg/wavevault` still reads them.

Do not touch the hub `memory/*.md` files under `~/.claude/projects/`. That is Claude Code's native
memory, it is unrecoverable, and it is the part that demonstrably works.

## Rollback

Code: `git revert` the removal commit. Vault notes: `git revert` in the obsidian_vault repo. The
`~/.pi` and `~/.claude/shared` deletions are not recoverable, which is why they come last and after
the copy-out in step 2.
