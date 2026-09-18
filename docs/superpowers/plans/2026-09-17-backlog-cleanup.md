# Backlog cleanup — verified open items Implementation Plan

> **For agentic workers:** each task below is self-contained — it carries its own design, rules and tests. The
> spec and this plan are not committed, so your worktree cannot read them: do not look for them. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the 12 remaining code chunks of `effort:cce0be37-6972-4068-89da-2c3738e5f765` (orphan deletions,
two re-homes, route evidence, and three liveness fixes), after first fixing a Verify flake, then write every
backlog-doc update in one final task.

**Architecture:** Wave Terminal (Tauri shell + Go `wavesrv` + React/jotai frontend). Go is the source of truth
for wire types; `task generate` regenerates `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`
and `pkg/wshrpc/wshclient/wshclient.go`. Frontend logic is proven with vitest over pure modules.

**Tech Stack:** Go (CGO sqlite), TypeScript/React 19, jotai, vitest, Task.

**Spec:** `docs/superpowers/specs/2026-09-17-backlog-cleanup-design.md` (uncommitted; lane worktrees cannot read it
— everything a task needs is in the task).

**Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/...`
**Setup:** `task worktree:prepare`

## Global Constraints

These apply to every task. Each task repeats the ones it leans on hardest.

- **Effort id:** `cce0be37-6972-4068-89da-2c3738e5f765`. Close your chunk with
  `wsh effort chunk status cce0be37-6972-4068-89da-2c3738e5f765 "<exact chunk label>" done --note "<note>"` as
  the last step **before** `wsh jarvis complete --commit $(git rev-parse HEAD)`.
- **Chunk note contents:** the short commit sha; every path you deleted; the replacement text for the
  `docs/open-issues.md` row(s) and `docs/deferred.md` entry this chunk resolves (Task 13 copies it); and any
  recovery command in the form `git show <sha>^:<path>`.
- **Never edit `docs/`.** Task 13 writes all docs.
- **Locate code by symbol**, not by line number. Line numbers quoted anywhere are archaeology.
- **Orphan cascade (deletion tasks):** delete what the task names, then repeat to a fixed point — a module or
  export is deleted only when every remaining consumer is itself deleted or is its own test file. Nothing
  outside that cascade changes.
- **RPC deletion:** before deleting any wshrpc command, grep `scripts/` and `cmd/` for its lowercase command
  name (e.g. `renamechannel`) and its Go name; update or drop each caller in the same task.
- **Generated files:** never hand-edit `gotypes.d.ts`, `wshclientapi.ts`, `wshclient.go`. After changing any
  wshrpc / waveobj / baseds / blockcontroller wire type run `task generate`.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — never `npx tsc`
  (stack-overflows). TS is `strict: false`: a `{ok:true}|{ok:false}` union does not narrow on `.ok`.
- **Go tests (Git Bash):** `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/<pkg>/...`. A
  POSIX `-I/c/...` path fails with a misleading `sqlite3.h` error.
- **Frontend tests:** `npx vitest run <file>`. No jsdom/render tests. No CDP — this worktree cannot drive the dev
  app; anything that needs a live look is written in the chunk note as "live check owed after merge".
- **Colors:** Tailwind `@theme` tokens only (e.g. `text-warning`, `text-muted`), never raw hex/rgba.
- **Formatting:** HEAD is not gofmt/prettier clean. Format only the lines you changed; never run a formatter
  over a whole file or `--write` a `scripts/*.mjs`.
- **Comments:** only for "why", lower case, matching surrounding density.
- **Git:** commit on your task branch with a conventional message (`fix(...)`, `refactor(...)`, `feat(...)`).
  No `Co-Authored-By` or any attribution trailer. Never push.

---

### Task 1: Stop the mock-env test timing out under load

**Depends on:** none

**No effort chunk:** this task keeps the plan's own Verify reliable. On HEAD, one of three Verify runs failed:
`frontend/preview/mock/mockwaveenv.test.ts` › "uses the preview context menu by default" exceeded vitest's
5000 ms default timeout because it does `await import("./mockwaveenv")` **inside** the test, so a cold module
transform under machine load is billed to the test's budget. Merge-time Verify runs while several lane workers are
compiling and testing, which is exactly that load.

**Files:**
- Modify: `frontend/preview/mock/mockwaveenv.test.ts`

- [ ] **Step 1: Read the file** and confirm the module-level `vi.hoisted` / `vi.mock("../preview-contextmenu", ...)`
setup. Vitest hoists `vi.mock` and `vi.hoisted` above static imports, so a static import of `./mockwaveenv` still
receives the mocked `showPreviewContextMenu`.

- [ ] **Step 2: Hoist the import.** Add `import { makeMockWaveEnv } from "./mockwaveenv";` beside the file's other
imports, delete `const { makeMockWaveEnv } = await import("./mockwaveenv");` from the test, and drop that test's
`async` if nothing else in it awaits. Change nothing else — the assertion stays
`expect(showPreviewContextMenu).toHaveBeenCalledWith(menu, event)`.

- [ ] **Step 3: Verify** — `npx vitest run frontend/preview/mock/mockwaveenv.test.ts` passes, and still passes when
run together with the whole suite: `npx vitest run`. If the static import breaks the mock (the assertion fails),
revert to the dynamic import and instead give that one test an explicit timeout argument of `30_000`, with a
one-line comment saying why (cold transform under parallel load).

- [ ] **Step 4: Commit** — `git commit -m "test(preview): import the mock env statically so a cold transform cannot time the test out"`.

- [ ] **Step 5:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 2: Record the route a run actually ran on in its evidence (chunk 16)

**Depends on:** none

**Chunk label:** `Lead-authored task routing: finish Phase 3 run-evidence recording of (harness, model), then Phase 4 measurement gate`

**Why:** lead-authored routing Phase 3 wants every sealed run to say which harness and model did the work.
Child runs already store their resolved route (`run.Runtime`, `run.Model`, set at spawn), but `run.Model` is
`""` whenever the runtime default was used, and `waveobj.RunEvidence` carries no route at all. The transcript
knows the model (`agentsessions.SessionInfo.Model`, "last assistant model seen"). Phase 4 (measuring cost and
outcome per route) is **not built** — it is held until runs carry this evidence.

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`RunEvidence`)
- Modify: `pkg/jarvis/evidence.go` (`SealEvidence`, new `evidenceRoute`, new `observedModelFn`)
- Test: `pkg/jarvis/evidence_test.go`
- Regenerated: `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces: `RunEvidence.Harness string \`json:"harness,omitempty"\``, `RunEvidence.Model string \`json:"model,omitempty"\``.

- [ ] **Step 1: Write the failing test** in `pkg/jarvis/evidence_test.go`:

```go
func TestEvidenceRoute(t *testing.T) {
	cases := map[string]struct {
		run                    waveobj.Run
		observed               string
		wantHarness, wantModel string
	}{
		"transcript model wins over the pinned one": {waveobj.Run{Runtime: "claude", Model: "claude-sonnet-5"}, "claude-opus-5", "claude", "claude-opus-5"},
		"pinned model when the transcript names none": {waveobj.Run{Runtime: "pi", Model: "deepseek-v4-flash"}, "", "pi", "deepseek-v4-flash"},
		"empty runtime is the default runtime":        {waveobj.Run{}, "claude-opus-5", runroute.DefaultRuntime(""), "claude-opus-5"},
		"neither known leaves model empty":            {waveobj.Run{Runtime: "claude"}, "", "claude", ""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			h, m := evidenceRoute(&c.run, c.observed)
			if h != c.wantHarness || m != c.wantModel {
				t.Fatalf("evidenceRoute = (%q, %q), want (%q, %q)", h, m, c.wantHarness, c.wantModel)
			}
		})
	}
}
```

Add the `github.com/wavetermdev/waveterm/pkg/runroute` import to the test file if it is not there.

- [ ] **Step 2: Run it and see it fail** — `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvis/ -run TestEvidenceRoute` → FAIL, `undefined: evidenceRoute`.

- [ ] **Step 3: Add the fields and the pure function.** In `pkg/waveobj/wtype.go` `RunEvidence`, after `DurationMs`:

```go
	Harness    string             `json:"harness,omitempty"` // the runtime that ran the work
	Model      string             `json:"model,omitempty"`   // the model the transcript reports, else the route's pin; empty when neither is known
```

In `pkg/jarvis/evidence.go` (`pkg/jarvis` already imports `pkg/runroute` elsewhere, so there is no cycle):

```go
// evidenceRoute is the route a run actually ran on: its harness, and the model its transcript reports, else the
// model its route pinned. An empty model is honest: the runtime default ran and the transcript never named it.
func evidenceRoute(run *waveobj.Run, observedModel string) (harness, model string) {
	harness = runroute.DefaultRuntime(run.Runtime)
	model = observedModel
	if model == "" {
		model = run.Model
	}
	return harness, model
}
```

- [ ] **Step 4: Run the test** → PASS.

- [ ] **Step 5: Read the observed model and seal it.** Add a seam and its default in `evidence.go`:

```go
// observedModelFn reads the model a run's last worker transcript reports ("" when unreadable). A var so tests
// can seal evidence without a transcript on disk.
var observedModelFn = observedRunModel
```

Implement `observedRunModel(run *waveobj.Run) string`: pick the same last transcript `workerTranscripts` would
(for `run.SessionId != ""` use `SessionTranscriptPath(run)`; otherwise the last non-skipped phase's last
`tab:` worker via `TranscriptPathForTab`), call `agentsessions.ExtractSession(path, runroute.DefaultRuntime(run.Runtime))`,
and return `sess.Model`, or `""` on any error or empty path — a transcript I/O failure degrades the section, it
never fails the seal (the rule `SealEvidence`'s doc comment states). In `SealEvidence`, where `ev` is built and
**before** `ev.Hash = evidenceHash(ev)`:

```go
	ev.Harness, ev.Model = evidenceRoute(run, observedModelFn(run))
```

The hash covers the whole struct, so new seals hash the route too; already-sealed evidence is immutable and is
not touched.

- [ ] **Step 6: Test the seal wiring.** Add `TestSealEvidenceRecordsRoute` beside the existing seal tests in
`evidence_test.go`, following how they build a run in a temp git repo. Stub `observedModelFn` to return
`"claude-opus-5"` (restore with `t.Cleanup`), seal a run with `Runtime: "claude"`, and assert
`run.Evidence.Harness == "claude"` and `run.Evidence.Model == "claude-opus-5"`. If no existing seal test builds a
repo you can reuse, drive `SealEvidence` on a run whose `ProjectPath` is a `t.TempDir()` initialized with
`git init` and one commit, matching the `BaseCommit` to that commit.

- [ ] **Step 7: Regenerate and check** — `task generate`; confirm `frontend/types/gotypes.d.ts` `RunEvidence`
gained `harness?: string; model?: string;`. Run `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvis/ ./pkg/waveobj/`
and the typecheck. Both pass.

- [ ] **Step 8: Commit** — `git add pkg/waveobj/wtype.go pkg/jarvis/evidence.go pkg/jarvis/evidence_test.go frontend/types/gotypes.d.ts` (plus any other generated file `task generate` changed); `git commit -m "feat(evidence): record the harness and model a run actually ran on"`.

- [ ] **Step 9: Close the chunk.** Note must say: commit sha; Phase 3's evidence half done
(`RunEvidence.harness/model`, sealed by `evidence.go` `evidenceRoute`); the DAG-graph half already shipped in
`551f76ee`; **Phase 4 held** — deferred.md entry text: "revive when enough sealed DAG runs carry route evidence to
compare cost and outcome per (lead stamp, harness, model); evidence carries no cost today, so the gate also needs
a cost source"; roadmap status line text: "Phases 1–3 shipped; Phase 4 held on evidence".

- [ ] **Step 10:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 3: Delete the channel lifecycle stack the one-channel-per-project collapse orphaned (chunk 9)

**Depends on:** Task 2

**Chunk label:** `Brief B5: channel lifecycle (rename/delete/archive/notes) — load-bearing, still unreachable`

**Why:** since `4e257133`/`0923776e` there is one channel per project, minted by New run
(`frontend/app/view/jarvis/newruncontrol.tsx`). `channelProjectLabel` never shows `channel.name`, so rename
is meaningless; `channel:notes` is written by `SetChannelNotesCommand` and read nowhere; the archived flag is
read only by `partitionChannels` (autonomy chip). The four store functions have had no caller since B5.
**Keep `DeleteChannelCommand`**: CDP scenario teardown calls `deletechannel` (`scripts/cdp/scenarios.mjs`, five
sites; `scripts/cdp-e2e-runs-piece4.mjs`; `scripts/cdp-profile-verify.mjs`). Depends on Task 2 only because both
run `task generate`.

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts` — delete `renameChannel`, `archiveChannel`, `setChannelNotes`, `deleteChannel`
- Modify: `pkg/wshrpc/wshrpctypes_channels.go` — delete `RenameChannelCommand`, `ArchiveChannelCommand`, `SetChannelNotesCommand` and their `Command*Data` types
- Modify: `pkg/wshrpc/wshserver/wshserver_channels.go` — delete the three handlers
- Modify/delete tests for those handlers (search `pkg/wshrpc/wshserver/*_test.go` for the three names)
- Modify: `pkg/jarvis/resolve.go` — delete `MetaKey_ChannelNotes`
- Keep: `DeleteChannelCommand` + handler, `wstore.MetaKey_Archived` (conversations use it), `partitionChannels`
- Regenerated: `gotypes.d.ts`, `wshclientapi.ts`, `wshclient.go`

- [ ] **Step 1: Prove the callers.** Run and record:
`grep -rn "renamechannel\|archivechannel\|setchannelnotes\|RenameChannel\|ArchiveChannel\|SetChannelNotes\|ChannelNotes" scripts cmd pkg frontend --include=*.go --include=*.ts --include=*.tsx --include=*.mjs`.
Expected hits: only the definitions, handlers, handler tests, generated files and the four store functions. Any
other hit is a caller: update or drop it in this task and say so in the chunk note.

- [ ] **Step 2: Delete** the four store functions, the three RPC interface methods and data types, the three
handlers, their tests, and `MetaKey_ChannelNotes`. Apply the orphan cascade (e.g. an import only they used).

- [ ] **Step 3: Regenerate** — `task generate`. Confirm the three commands are gone from `wshclientapi.ts` and
`wshclient.go`, and `deletechannel` is still present.

- [ ] **Step 4: Verify** — rerun the Step 1 grep: zero hits outside git history. Then typecheck, `npx vitest run frontend/app/view/agents`, and
`CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/... ./pkg/jarvis/ ./pkg/wstore/` — all pass.

- [ ] **Step 5: Commit** — `git commit -m "refactor(channels): delete rename, archive and notes, orphaned since one channel per project"`.

- [ ] **Step 6: Close the chunk.** Note: sha; deleted symbols; kept `DeleteChannelCommand` (CDP teardown) and
`partitionChannels` (legacy flags); open-issues B5 row text: "closed — premise gone: one channel per project
(`4e257133`), name never shown, notes never read; rename/archive/notes deleted in <sha>, delete RPC kept for CDP
teardown"; recovery `git show <sha>^:pkg/wshrpc/wshserver/wshserver_channels.go` and
`git show <sha>^:frontend/app/view/agents/channelsstore.ts`.

- [ ] **Step 7:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 4: Delete thread archive/delete and per-answer cancel/retry (chunks 12 and 13)

**Depends on:** Task 3

**Chunk labels:** `Brief B5: thread lifecycle (archive/delete)` and `Brief B5: per-answer cancel and retry`

**Why:** threads (persisted `JarvisConversation`s) are listed by the command palette, but palette rows have no
actions, and `archiveJarvisConversation` / `deleteJarvisConversation` have no caller. `cancelJarvisQuery` /
`retryJarvisQuery` act on `submitJarvisQuery` streams, which only the pet reaches now; the Brief's own ask is a
different one-shot path (`askAcrossWork`) that already stays retryable. Both chunks edit `jarvisstore.ts`, so they
are one task. Depends on Task 3 only because both run `task generate`.

**Files:**
- Modify: `frontend/app/view/jarvis/jarvisstore.ts` — delete `archiveJarvisConversation`, `deleteJarvisConversation`, `cancelJarvisQuery`, `retryJarvisQuery`
- Modify: the wshrpc types file declaring `ArchiveJarvisConversationCommand` / `DeleteJarvisConversationCommand` (grep `pkg/wshrpc/wshrpctypes_*.go`) and their data types
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` — delete both handlers
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis_test.go` — delete `TestDeleteJarvisConversationCommandRemovesIt`, `TestDeleteJarvisConversationCommandRequiresAnId`, `TestArchiveJarvisConversationCommandRoundTrips`
- Modify: `pkg/wstore/wstore_jarvisconversation.go` (+ its test) — delete `DeleteJarvisConversation` if the handler was its only non-test caller
- May modify: `frontend/app/view/jarvis/jarvisturnderive.ts` (you own it) — only if deleting cancel leaves `terminalAfterStreamFailure`'s input dead
- Keep untouched: `submitJarvisQuery`'s live path, the `Terminal` type, `terminalBadge`, the persisted archived flag readers (`briefpalette.ts`, `summaryToRailConversation`)
- Regenerated: `gotypes.d.ts`, `wshclientapi.ts`, `wshclient.go`

- [ ] **Step 1: Prove the callers.** `grep -rn "archivejarvisconversation\|deletejarvisconversation\|ArchiveJarvisConversation\|DeleteJarvisConversation\|cancelJarvisQuery\|retryJarvisQuery" scripts cmd pkg frontend --include=*.go --include=*.ts --include=*.tsx --include=*.mjs`.
Expected: definitions, handlers, their tests, generated files, and `wstore.DeleteJarvisConversation` + its tests.
Any other caller: update or drop it here and name it in the note.

- [ ] **Step 2: Delete** the four FE functions, both RPCs with data types and handlers, the three handler tests,
and `wstore.DeleteJarvisConversation` with its test cases if now test-only. Apply the orphan cascade inside
`jarvisstore.ts` (e.g. the `cancelled` flag on live streams, if nothing else sets it). If `cancelled` is always
false afterwards, you may simplify `terminalAfterStreamFailure` and its test in `jarvisturnderive.ts`; do not
change `terminalBadge` or the `Terminal` union.

- [ ] **Step 3: Regenerate** — `task generate`.

- [ ] **Step 4: Verify** — Step 1 grep returns nothing live. Typecheck; `npx vitest run frontend/app/view/jarvis`;
`CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/... ./pkg/wstore/` — all pass.

- [ ] **Step 5: Commit** — `git commit -m "refactor(jarvis): delete unreachable thread archive/delete and answer cancel/retry"`.

- [ ] **Step 6: Close both chunks** (two `wsh effort chunk status ... done` calls). Chunk 12 note: sha; deleted
symbols and paths; deferred.md entry text: "Thread archive/delete deleted (<sha>): threads now accumulate with no
removal path. Revive when thread clutter in the palette becomes a real problem; recover with
`git show <sha>^:frontend/app/view/jarvis/jarvisstore.ts` and `git show <sha>^:pkg/wshrpc/wshserver/wshserver_jarvis.go`";
open-issues row text: "closed — deleted in <sha>, deferred entry holds the revive condition". Chunk 13 note: sha;
deleted functions; open-issues row text: "closed — deleted in <sha>; the Brief's failed ask stays retryable from
its composer and the pet's converse RPC is capped at 130 s".

- [ ] **Step 7:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 5: Fail a run whose worker exits without completing, but never on app quit (chunk 3, F26)

**Depends on:** none

**Chunk label:** `F26: force-killed agent leaves its run executing forever`

**Why:** run outcome is hook-driven; a killed worker fires no completion. Exits are already reconciled for an
orchestrator lead with no DAG (`orchestrate.HandleLeadExit` fails its phase) and for DAG children
(`orchestrate.HandleChildOutcome`). Quick and pipeline runs are not: nothing calls `jarvis.FailPhase`, so the run
reads `executing` forever. Separately, `blockcontroller.StopAllBlockControllersForShutdown` kills every worker on
app quit and the exit hook fires, so quitting already fails orchestrator leads — quitting is not a worker failure.

**Files:**
- Modify: `pkg/blockcontroller/blockcontroller.go` (`StopAllBlockControllersForShutdown`, new shutdown flag + `exitHook`)
- Modify: `pkg/blockcontroller/shellcontroller.go` (the shell wait loop that calls `AgentOutcomeHook`)
- Test: `pkg/blockcontroller/blockcontroller_test.go`
- Modify: `pkg/orchestrate/outcome.go` (`HandleLeadExit` → `HandleRunWorkerExit`)
- Test: `pkg/orchestrate/outcome_test.go` (`newLeadExitRun`, `TestLeadExitBeforeSubmitFailsTheRunWithAReason`, `TestLeadExitLeavesOtherRunsAlone`)
- Modify: `pkg/jarvis/onexit.go` (`LeadExitHook` → `RunWorkerExitHook`, call ordering in `OnWorkerExit`)
- Modify: `pkg/waveobj/runevent.go` (new `RunEventKindWorkerExited = "worker-exited"`)
- Modify: `frontend/app/view/agents/runtimeline.ts` + `runtimeline.test.ts` (kind list, title, tone)

**Interfaces:**
- Produces: `orchestrate.HandleRunWorkerExit(ctx context.Context, workerORef string) error`; `jarvis.RunWorkerExitHook func(context.Context, string) error`; `waveobj.RunEventKindWorkerExited`.

- [ ] **Step 1: Shutdown guard — failing test** in `pkg/blockcontroller/blockcontroller_test.go`:

```go
func TestExitHookIsSilentDuringShutdown(t *testing.T) {
	oldHook := AgentOutcomeHook
	AgentOutcomeHook = func(string, int) {}
	t.Cleanup(func() { AgentOutcomeHook = oldHook; shuttingDown.Store(false) })

	if exitHook() == nil {
		t.Fatal("a normal exit must reach the outcome hook")
	}
	shuttingDown.Store(true)
	if exitHook() != nil {
		t.Fatal("an exit caused by server shutdown is not a worker failure")
	}
}
```

Run `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/blockcontroller/ -run TestExitHookIsSilentDuringShutdown` → FAIL (undefined).

- [ ] **Step 2: Implement the guard** in `blockcontroller.go`:

```go
// shuttingDown is set once the server starts stopping every controller: a quit kills every worker, and that is
// not a worker failure for any exit reconciler to act on.
var shuttingDown atomic.Bool

// exitHook is the outcome hook an exited block should run, or nil while the server shuts down.
func exitHook() func(blockId string, exitCode int) {
	if shuttingDown.Load() {
		return nil
	}
	return AgentOutcomeHook
}
```

Set `shuttingDown.Store(true)` as the first line of `StopAllBlockControllersForShutdown`. In the
`shellcontroller.go` wait loop replace `if AgentOutcomeHook != nil { go AgentOutcomeHook(bc.BlockId, exitCode) }`
with `if hook := exitHook(); hook != nil { go hook(bc.BlockId, exitCode) }`. Import `sync/atomic`. Rerun → PASS.

- [ ] **Step 3: Reconciler — failing tests** in `pkg/orchestrate/outcome_test.go`. Rename the helper uses to
`HandleRunWorkerExit`. The existing `"pipeline"` case in `TestLeadExitLeavesOtherRunsAlone` asserts a pipeline run
is left alone — **remove it from that table** (it is now the reconciled case). Add:

```go
func TestWorkerExitFailsAQuickOrPipelineRun(t *testing.T) {
	for name, mode := range map[string]string{"quick": jarvis.RunMode_Quick, "pipeline": jarvis.RunMode_Pipeline} {
		t.Run(name, func(t *testing.T) {
			ctx, channelId, run, rows := newLeadExitRun(t, func(r *waveobj.Run) { r.Mode = mode })
			if err := HandleRunWorkerExit(ctx, "tab:lead-tab"); err != nil {
				t.Fatal(err)
			}
			got, err := wstore.GetRun(ctx, channelId, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Phases[0].State != jarvis.PhaseState_Failed {
				t.Fatalf("phase %q, want failed: a %s worker that exits without completing ends its phase", got.Phases[0].State, name)
			}
			if len(*rows) != 1 || (*rows)[0]["eventkind"] != waveobj.RunEventKindWorkerExited {
				t.Fatalf("want one worker-exited row, got %+v", *rows)
			}
		})
	}
}

func TestWorkerExitIgnoresAWorkerOutsideTheRunningPhase(t *testing.T) {
	ctx, channelId, run, rows := newLeadExitRun(t, func(r *waveobj.Run) {
		r.Mode = jarvis.RunMode_Pipeline
		r.Phases[0].WorkerOrefs = []string{"tab:next-phase-worker"}
	})
	// the exiting tab belonged to an earlier phase; its late exit must not fail the phase now running
	if err := HandleRunWorkerExit(ctx, "tab:lead-tab"); err != nil {
		t.Fatal(err)
	}
	got, _ := wstore.GetRun(ctx, channelId, run.ID)
	if got.Phases[0].State == jarvis.PhaseState_Failed || len(*rows) != 0 {
		t.Fatalf("a stale worker's exit failed the running phase: %q %+v", got.Phases[0].State, *rows)
	}
}
```

If `jarvis.NewRun` with `RunMode_Orchestrator`'s playbook gives a phase shape that `Quick`/`Pipeline` would not,
build the run with the matching playbook the codebase uses for those modes (grep `jarvis.NewRun(` in tests). Keep
the existing `"submitted"` (DagORef set) and `"finished"` cases: both must still be left alone. Run → FAIL.

- [ ] **Step 4: Implement** in `outcome.go`: rename `HandleLeadExit` → `HandleRunWorkerExit` and widen it:
  - Load the run; return nil if `run.DagORef != ""` (a DAG child, or a lead whose engine owns the DAG).
  - Under `wstore.UpdateRun`: re-check `DagORef == ""` and status executing/planning; `i := jarvis.RunningPhaseIndex(*cur)`;
    return unchanged unless `slices.Contains(cur.Phases[i].WorkerOrefs, workerORef)`; `jarvis.FailPhase`.
  - Event: `RunEventKindLeadExited` with `leadExitedNote` for `RunMode_Orchestrator`; otherwise
    `RunEventKindWorkerExited` with reason `"worker exited before completing its phase"` (a named const beside `leadExitedNote`).
  - Keep the two `wcore.SendWaveObjUpdate` calls. Update the doc comment to describe every run mode.
  Add `RunEventKindWorkerExited = "worker-exited"` beside `RunEventKindLeadExited` in `pkg/waveobj/runevent.go`.
  Rename `jarvis.LeadExitHook` → `RunWorkerExitHook` (and `notifyLeadExit`) in `onexit.go`, and the assignment in `outcome.go` `init`.

- [ ] **Step 5: Ordering in `onexit.go` `OnWorkerExit`.** Resolve the tab (`DBFindTabForBlockId`, `DBMustGet[*Tab]`)
and return early when `session:agent` is empty **before** the `reportableExit` gate; call the worker-exit hook
there; then apply the gate and continue to `exitOutcome` as today. A clean exit with no transcript therefore still
reconciles its run. Keep existing log lines.

- [ ] **Step 6: Run** `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/blockcontroller/ ./pkg/waveobj/` → PASS.

- [ ] **Step 7: Timeline copy.** In `frontend/app/view/agents/runtimeline.ts` add `"worker-exited"` wherever
`"lead-exited"` appears (the kind list, title `"Worker exited"`, tone `"text-warning"`). In `runtimeline.test.ts`
add the two assertions mirroring the `lead-exited` ones: `toneFor("worker-exited")` is `"text-warning"` and
`eventKindTitle("worker-exited")` is `"Worker exited"`. `npx vitest run frontend/app/view/agents/runtimeline.test.ts` → PASS; typecheck passes.

- [ ] **Step 8: Relaunch check (read-only).** Read how a run worker's block comes back after quit + relaunch:
`blockcontroller` `ResyncController`, the worker block meta set by `pkg/jarvis/runworker.go` / the spawn path
(`cmd:runonstart`, controller name), and when the frontend issues the resync. Decide: does a quick-run worker's
command restart after relaunch, or can the run sit `executing` with no process? Write the answer with file/symbol
evidence into the chunk note.

- [ ] **Step 9: Commit** — `git commit -m "fix(runs): fail a run whose worker exits without completing, never on app quit"`.

- [ ] **Step 10: Close the chunk.** Note: sha; the reconciler and shutdown guard; the Step 8 finding; open-issues
F26 row text: "fixed in <sha> for every non-DAG run (quick, pipeline, orchestrator lead); a quit is never a
failure" — plus, if Step 8 found a run can still sit executing after quit + relaunch, "remaining gap: <finding>".

- [ ] **Step 11:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 6: Retire a dead agent's ask and confirm session answers (chunk 4, F22/F23)

**Depends on:** Task 4

**Chunk label:** `F22/F23: plain-session ask has no aging/liveness gate and delivery is unconfirmed (DAG children already fixed)`

**Why:** (a) *Die half.* Agent blocks close on exit unless `cmd:keeponexit` (`shellcontroller.go`
`agentShouldCloseOnExit`), and `pkg/jarvis/attention.go` `livePendingAsks` — run on every attention poll — retires
the ask of a deleted block or of a job-backed block whose job manager stopped. Uncovered: a kept, non-job-backed
block whose process ended. Extend that single retirement path; do not add a second one. (b) *Hang half:* closed
without code — a live agent in its picker writes nothing to transcript or pty, so no signal separates hung from
waiting; the cockpit dismiss (`agentrow.tsx` → `AgentAskClearCommand`) is the human's escape and F24's
`displayAgeMs` shows the real age. (c) *F23.* `agentask.injectAnswer` waits for the agent's clear only when
`pending.Owner != ""` (DAG children); a session answer typed into a picker that was not listening vanishes and the
RPC still reports success. Depends on Task 4 only because both run `task generate`.

**Files:**
- Modify: `pkg/jarvis/attention.go` (`livePendingAsks`) + `pkg/jarvis/attention_askprune_test.go`
- Modify: `pkg/agentask/deliver.go` (`injectAnswer`) + `pkg/agentask/deliver_test.go`
- Modify: `pkg/orchestrate/queue.go` (`sweepAsks`) + `pkg/orchestrate/queue_test.go`
- Modify: `pkg/baseds/baseds.go` (`AgentAskData.Note`)
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (`AgentAsk`, `withAsk`) + `agentsviewmodel.test.ts`
- Modify: every component that renders `agent.ask` questions (grep `\.ask\b` / `ask.questions` under `frontend/app/view/agents`; at least `agentrow.tsx`)
- Regenerated: `gotypes.d.ts`

**Interfaces:**
- Produces: `baseds.AgentAskData.Note string \`json:"note,omitempty"\``; FE `AgentAsk.note?: string`.

- [ ] **Step 1: Die half — failing test** in `attention_askprune_test.go`, following its existing cases. Add a
controller-status seam in `attention.go`:

```go
// controllerStatusFn reads a block's live controller status (nil when no controller exists). A var for tests.
var controllerStatusFn = blockcontroller.GetBlockControllerRuntimeStatus
```

Cases: a pending ask on an existing block with `JobId == ""` whose stubbed status is `Status_Done` is pruned
(claimed, waiter cancelled, cleared event); the same block with status `Status_Running` is kept; with a `nil` status
(no controller yet — e.g. before the frontend re-mounts it after boot) is kept. Run
`CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvis/ -run AskPrune` (match the file's test names) → FAIL.

- [ ] **Step 2: Implement** in `livePendingAsks`, after the `DurableAgentGone` check leaves `gone == false` for an
existing block:

```go
			if !gone && block.JobId == "" {
				// a kept local block whose process ended has no clear coming: the agent that would send it is gone
				rs := controllerStatusFn(parsed.OID)
				gone = rs != nil && rs.ShellProcStatus == blockcontroller.Status_Done
			}
```

Update the function's doc comment from "Two ways to be gone" to three. Rerun → PASS.

- [ ] **Step 3: F23 — failing tests.** In `pkg/agentask/deliver_test.go`, following the existing DAG
await-clear test, add: a session ask (`Owner == ""`, no waiter) delivered by keystrokes is registered for a clear
(`GlobalRegistry.ExpireClears(now+AnswerClearTimeout, AnswerClearTimeout)` returns it with
`Note == AnswerUnconfirmedNote`); one confirmed with `ConfirmClear` before expiry is not returned. In
`pkg/orchestrate/queue_test.go`, following the tests that stub `expireClearsFn`, add: a restored ask with
`DagOID == ""` is republished through a new seam `publishSessionAskFn` carrying `Note`, and neither
`publishDagEvent` nor `forwardAskToUser`'s run-event path runs for it. Run both packages → FAIL.

- [ ] **Step 4: Implement.**
  - `baseds.AgentAskData`: add `Note string \`json:"note,omitempty"\`` with a comment ("why the ask is back in front of the human").
  - `deliver.go` `injectAnswer`: await the clear for every keystroke delivery — replace `if pending.Owner != "" { awaitClear }`
    with an unconditional `GlobalRegistry.awaitClear(oref, pending, time.Now().UnixMilli())` and update the comment
    (a session answer is not delivered until the agent clears the ask either). The waiter path returns earlier and is unchanged.
  - `queue.go`:

```go
// publishSessionAskFn puts a session ask whose typed answer never landed back in front of the human. It publishes
// the ask event directly: jarvis.PublishAgentAsk would hand the ask to the Gatekeeper a second time. A var for tests.
var publishSessionAskFn = func(oref string, p agentask.PendingAsk) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:   wps.Event_AgentAsk,
		Scopes:  []string{oref},
		Persist: 1,
		Data:    baseds.AgentAskData{ORef: oref, AskId: p.AskId, Questions: p.Questions, Ts: p.Ts, Prose: p.Prose, Note: p.Note},
	})
}
```

    In `sweepAsks`' loop over `expireClearsFn(now)`, first: `if p.DagOID == "" { publishSessionAskFn(oref, p); continue }`.
    DAG handling below it is unchanged.
  Rerun both packages → PASS. `task generate`.

- [ ] **Step 5: FE passthrough — failing test** in `agentsviewmodel.test.ts`:

```ts
it("carries why an ask came back onto the card", () => {
    const vm = withAsk(
        { id: "t1", name: "loom", task: "", state: "working" } as AgentVM,
        { oref: "block:b1", askid: "a1", questions: [], ts: 1_000, note: "answer was sent but never confirmed" } as AgentAskData,
        2_000
    );
    expect(vm.ask?.note).toBe("answer was sent but never confirmed");
});
```

Run `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` → FAIL. Add `note?: string` to `AgentAsk`
and `note: ask.note` in `withAsk`'s `ask` object → PASS.

- [ ] **Step 6: Render the note** in each component that renders an agent's ask questions: when `agent.ask.note`
is set, one line above the questions, e.g. `<div className="text-[11px] text-warning">{agent.ask.note}</div>`,
matching the surrounding card's sizing. Typecheck passes.

- [ ] **Step 7: Run** `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/agentask/ ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/...`
and `npx vitest run frontend/app/view/agents` → PASS.

- [ ] **Step 8: Commit** — `git commit -m "fix(asks): retire a dead local agent's ask and bring back a session answer that never landed"`.

- [ ] **Step 9: Close the chunk.** Note: sha; open-issues F22 row text: "die half fixed in <sha>
(`livePendingAsks` retires the ask of a kept local block whose process ended; closed/job-backed blocks were already
covered); hang half closed without code — no signal separates a hung agent from one waiting in its picker, the
cockpit dismiss and F24's real age are the human's tools"; F23 row text: "fixed for session asks in <sha>: a typed
answer the agent does not clear within 30 s comes back to the human with the note; the RPC still returns on the last
keystroke"; live check owed after merge: answer a session ask whose agent is frozen and see the card return with
the note.

- [ ] **Step 10:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 7: Show a claude agent that has gone silent while working as hung (chunk 2, F25)

**Depends on:** Task 5, Task 6

**Chunk label:** `F25: no agent state represents 'hung'`

**Why:** the roster has asking / working / idle, so a frozen agent reads "Working". Transcript mtime cannot tell
hung from working (claude writes nothing during a long tool call). Pty output can: measured 15–59 KB per 45 s while
claude works — its spinner and timer redraw every second, even inside a long tool call — and zero once work stops.
The signal only discriminates in the working state; asking, waiting and idle are silent by design. **Hook state
stays authoritative:** do not publish anything into `Event_AgentStatus` (hooks own it and
`orchestrate/wake.go` `latestAgentState` reads it). Hung is a frontend overlay. pi is excluded until its TUI output
is measured. Depends on Task 5 (both edit `blockcontroller`) and Task 6 (both edit `agentsviewmodel.ts` and the
agent row; both run `task generate`).

**Files:**
- Modify: `pkg/blockcontroller/blockcontroller.go` (`HandleAppendBlockFile`, `BlockControllerRuntimeStatus`) + `blockcontroller_test.go`
- Modify: `pkg/blockcontroller/shellcontroller.go` (runtime status getter; throttled publish)
- Create: `frontend/app/view/agents/agenthung.ts` + `agenthung.test.ts`
- Create or modify: a controller-status store for agent blocks (follow `frontend/app/view/agents/agentaskstore.ts`)
- Modify: the agent row status line (`frontend/app/view/agents/agentrow.tsx`, `StatusLine`, which already reads `nowAtom`)
- Regenerated: `gotypes.d.ts`

**Interfaces:**
- Produces: `BlockControllerRuntimeStatus.LastOutputTs int64 \`json:"lastoutputts,omitempty"\``; FE `hungSilenceMs(agent, lastOutputTs, now): number | null`, `HUNG_AFTER_MS`.

- [ ] **Step 1: Throttle — failing test** in `blockcontroller_test.go`:

```go
func TestOutputPublishDue(t *testing.T) {
	interval := outputPublishInterval.Milliseconds()
	if !outputPublishDue(0, 5_000) {
		t.Fatal("a block's first output is published")
	}
	if outputPublishDue(5_000, 5_000+interval-1) {
		t.Fatal("output inside the interval is not republished")
	}
	if !outputPublishDue(5_000, 5_000+interval) {
		t.Fatal("output after the interval is republished")
	}
}
```

Run → FAIL.

- [ ] **Step 2: Implement** in `blockcontroller.go`:

```go
// outputPublishInterval bounds how stale a working agent's published last-output time can be. It sits far under
// the frontend's hung threshold, so continuous output never reads as silence.
const outputPublishInterval = 30 * time.Second

// outputPublishDue reports whether a block's newest output is worth republishing: its first output, or the first
// after outputPublishInterval since the last publish.
func outputPublishDue(lastPublished, now int64) bool {
	return lastPublished == 0 || now-lastPublished >= outputPublishInterval.Milliseconds()
}
```

Rerun → PASS.

- [ ] **Step 3: Stamp and publish.** Add `LastOutputTs int64 \`json:"lastoutputts,omitempty"\`` to
`BlockControllerRuntimeStatus`. In `HandleAppendBlockFile`, for `blockFile == wavebase.BlockFile_Term` only, record
`now` as the block's last output time (a small mutex-guarded map keyed by blockId, or fields on the shell controller
— whichever the controller lookup there makes simplest) and, when `outputPublishDue(lastPublished, now)`, publish the
controller's runtime status on `wps.Event_ControllerStatus` with the same scopes `sendUpdate_nolock` uses, **without**
its `log.Printf` line. The runtime status getter fills `LastOutputTs`. Delete the entry when the controller is
destroyed so the map does not grow. `task generate`; confirm `lastoutputts?: number` in `gotypes.d.ts`.
`CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/blockcontroller/ ./pkg/wshrpc/...` → PASS.

- [ ] **Step 4: Overlay — failing test** `frontend/app/view/agents/agenthung.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HUNG_AFTER_MS, hungSilenceMs } from "./agenthung";

const claudeWorking = { agent: "claude", state: "working" as const };

describe("hungSilenceMs", () => {
    it("flags claude working with no output past the threshold", () => {
        expect(hungSilenceMs(claudeWorking, 1_000, 1_000 + HUNG_AFTER_MS)).toBe(HUNG_AFTER_MS);
    });
    it("flips to hung as the clock passes a stamp that never moves", () => {
        const stamp = 10_000;
        expect(hungSilenceMs(claudeWorking, stamp, stamp + HUNG_AFTER_MS - 1)).toBeNull();
        expect(hungSilenceMs(claudeWorking, stamp, stamp + HUNG_AFTER_MS + 60_000)).toBe(HUNG_AFTER_MS + 60_000);
    });
    it("leaves silent-by-design states alone", () => {
        for (const state of ["asking", "idle"] as const) {
            expect(hungSilenceMs({ agent: "claude", state }, 0, HUNG_AFTER_MS * 10)).toBeNull();
        }
    });
    it("does not judge a runtime whose output was never measured", () => {
        expect(hungSilenceMs({ agent: "pi", state: "working" }, 1_000, 1_000 + HUNG_AFTER_MS * 10)).toBeNull();
    });
    it("does not judge a block with no output stamp", () => {
        expect(hungSilenceMs(claudeWorking, undefined, HUNG_AFTER_MS * 10)).toBeNull();
    });
});
```

Run `npx vitest run frontend/app/view/agents/agenthung.test.ts` → FAIL.

- [ ] **Step 5: Implement** `frontend/app/view/agents/agenthung.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A claude agent redraws its spinner every second while it works, so a working agent with a silent terminal is hung,
// not busy. Derived here, never published: hook state stays the one source of an agent's state.

import type { AgentVM } from "./agentsviewmodel";

export const HUNG_AFTER_MS = 3 * 60_000;

// only runtimes whose working output was measured; pi joins once its TUI is
const PTY_HEARTBEAT_AGENTS = new Set(["claude"]);

/** Pure: how long a working agent's terminal has been silent once that silence means hung, else null. */
export function hungSilenceMs(
    agent: Pick<AgentVM, "agent" | "state">,
    lastOutputTs: number | undefined,
    now: number
): number | null {
    if (agent.state !== "working" || !PTY_HEARTBEAT_AGENTS.has(agent.agent ?? "") || !lastOutputTs) {
        return null;
    }
    const silent = now - lastOutputTs;
    return silent >= HUNG_AFTER_MS ? silent : null;
}
```

Rerun → PASS.

- [ ] **Step 6: Wire it.** Add a global `controllerstatus` subscription (the `agentaskstore.ts` pattern:
`waveEventSubscribeSingle` once, module-level jotai atom) that keeps `blockId → lastoutputts` from each event's
`BlockControllerRuntimeStatus`. In the agent row's status line — which re-renders on the view model's `nowAtom` —
read the agent's `blockId` stamp and `const silent = hungSilenceMs(agent, stamp, now)`; when non-null, render
`hung · no output ${Math.floor(silent / 60_000)}m` in `text-warning` in place of the working label. The overlay
must be evaluated against `nowAtom`, not only on events: a silent agent sends no further event. `AgentState` and
every state switch stay unchanged. Typecheck and `npx vitest run frontend/app/view/agents` → PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(agents): show a claude agent whose terminal went silent while working as hung"`.

- [ ] **Step 8: Close the chunk.** Note: sha; mechanism (last-output stamp at `HandleAppendBlockFile`, 30 s
throttled `controllerstatus`, FE overlay after 3 min, claude only, hook state untouched); open-issues F25 row text:
"fixed in <sha> for claude: a working agent with no terminal output for 3 min reads `hung · no output Nm`; pi
excluded until its TUI output is measured"; live check owed after merge: freeze a claude agent mid-work
(e.g. suspend its process) and see the row flip after 3 min.

- [ ] **Step 9:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 8: Delete the unmounted composers, their @-vocabulary and composer attachments (chunk 10)

**Depends on:** none

**Chunk label:** `Brief B5: composer @quick/@run/@ask vocabulary — re-home or drop`

**Why:** `frontend/app/view/agents/channelcomposers.tsx` (`LaunchComposer`, `TalkComposer`) has no importer since B5.
The launcher's controls set the run mode and steering was re-homed. The composer-attachment modules were mounted
only by it, so attaching files to a run goal is already unreachable (pasting an image into an agent's own terminal
still works through `term/termutil.ts`). Decision: delete all of it; the lost attachments get a deferred entry (Task 13).

**Files:**
- Delete: `frontend/app/view/agents/channelcomposers.tsx`
- Delete: `frontend/app/view/agents/composercommand.ts` and `composercommand.test.ts` — after moving `export type RunShape = "orchestrator" | "quick";` into `frontend/app/view/agents/runconfig.ts`
- Modify: `RunShape` importers — `runconfig.ts`, `runconfigstore.ts`, `frontend/app/view/jarvis/newrun.ts` (grep `RunShape` for any other)
- Modify: `frontend/app/view/agents/channelderive.ts` — delete `activeMentionQuery`; delete its cases in `channelderive.test.ts`
- Modify: `frontend/app/view/agents/harnesspicker.tsx` — delete `harnessRuntimeIds` (and its comment about `@ask <runtime>`)
- Delete: `frontend/app/view/agents/attachmenttray.tsx`, `composerattachments.ts`, `composerattachments.test.ts`
- Modify: `frontend/app/view/agents/runlauncher.tsx` — remove the sentence telling users that typing `@quick`, `@run` or `@ask` in the goal overrides the shape (under the "how it should run" copy)
- Keep: `WriteTempFileCommand` (terminal paste), `ComposerShell` (`runbody.tsx`), `HarnessPicker`

- [ ] **Step 1: Prove the orphans.** For each of `LaunchComposer TalkComposer LAUNCH_COMMANDS parseComposerCommand resolveComposerDispatch resolveRunCreationDecision composerFace activeMentionQuery harnessRuntimeIds AttachmentTray AttachButton useComposerAttachments appendAttachments`:
`grep -rlw <name> frontend scripts`. Expected consumers: only the files this task deletes, their tests, and the
defining file. Anything else is a live caller — stop and record it in the chunk note instead of deleting that symbol.

- [ ] **Step 2: Move `RunShape`** into `runconfig.ts` and repoint its importers. Typecheck passes.

- [ ] **Step 3: Delete** the files and symbols above, then run the orphan cascade (e.g. a helper only
`attachmenttray.tsx` imported). Remove the `@quick/@run/@ask` sentence from `runlauncher.tsx`.

- [ ] **Step 4: Verify** — `grep -rn "@quick\|@run \|@ask" frontend/app --include=*.tsx` shows no user-facing copy
promising the vocabulary; typecheck passes; `npx vitest run frontend/app/view/agents frontend/app/view/jarvis` passes.

- [ ] **Step 5: Commit** — `git commit -m "refactor(agents): delete the unmounted composers, their @-vocabulary and composer attachments"`.

- [ ] **Step 6: Close the chunk.** Note: sha; every deleted path; open-issues B5 row text: "closed — deleted in
<sha>; the launcher's controls set the mode"; deferred.md entry text: "Composer attachments (paste / attach /
drag-drop onto a run goal or steer, `875967bf`) were mounted only by the deleted `channelcomposers.tsx` and went with
it in <sha>. Image paste into an agent's own terminal still works. Revive when attaching a file to a goal or steer
is wanted; recover with `git show <sha>^:frontend/app/view/agents/composerattachments.ts` and
`git show <sha>^:frontend/app/view/agents/attachmenttray.tsx`. This also retires the attachment half of the
2026-07-16 'Channel composer attachments' entry and of the Remote/WSL blocked row."

- [ ] **Step 7:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 9: Delete the subject-grouping remnant (chunk 11)

**Depends on:** none

**Chunk label:** `Brief B5: subject browsing/grouping`

**Why:** `toggleSubjectGroup` and `collapsedSubjectGroupsAtom` (`frontend/app/view/jarvis/jarvissubjectstore.ts`)
only use each other; `subjects.ts` and `subjectFilterAtom` are already gone. Browsing and filtering records,
threads, initiatives and sessions — archived ones included — lives in the command palette's Brief index
(`frontend/app/view/jarvis/briefpalette.ts` `buildBriefIndex`).

**Files:**
- Modify: `frontend/app/view/jarvis/jarvissubjectstore.ts` (and its test, if it references either symbol)

- [ ] **Step 1:** `grep -rn "toggleSubjectGroup\|collapsedSubjectGroupsAtom" frontend scripts` — expect only the defining file (and possibly its test).
- [ ] **Step 2:** Delete both symbols and their comment block; remove any test cases for them.
- [ ] **Step 3:** Typecheck; `npx vitest run frontend/app/view/jarvis` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "refactor(jarvis): delete the subject-grouping remnant the palette index superseded"`.
- [ ] **Step 5: Close the chunk.** Note: sha; open-issues B5 row text: "closed — superseded: the palette's Brief
index (`briefpalette.ts` `buildBriefIndex`) browses and filters records, threads, initiatives and sessions,
archived included; grouping remnant deleted in <sha>".
- [ ] **Step 6:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 10: Delete the fleet dismiss writer (chunk 14)

**Depends on:** none

**Chunk label:** `Brief B5: rail fleet dismiss (dismissWorker) — roster itself (FleetRoster/runRailSection) needs rebuilding, not re-homing`

**Why:** `FleetRoster` and `runRailSection` are deleted; there is no per-worker list to dismiss from. The Brief
header's derived line (`frontend/app/view/jarvis/brieffleet.ts`) already ages idle workers out.
`dismissWorker` (`frontend/app/view/agents/channelactions.ts`) has no caller. **Keep** the `"dismiss"` branch in
`frontend/app/view/agents/jarvisderive.ts` `buildFleetSnapshot`, so dismiss messages already stored keep hiding
their workers.

**Files:**
- Modify: `frontend/app/view/agents/channelactions.ts`

- [ ] **Step 1:** `grep -rn "dismissWorker" frontend scripts` — expect only the definition.
- [ ] **Step 2:** Delete `dismissWorker` and its comment; run the orphan cascade inside `channelactions.ts` only (e.g. a helper only it used — `post` is shared, keep it if anything else calls it).
- [ ] **Step 3:** Typecheck; `npx vitest run frontend/app/view/agents` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "refactor(agents): delete the fleet dismiss writer left without a roster"`.
- [ ] **Step 5: Close the chunk.** Note: sha; open-issues B5 row text: "closed — `dismissWorker` deleted in <sha>;
no roster exists and the header's fleet line ages idle workers out; the stored-dismiss reader stays".
- [ ] **Step 6:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 11: Re-home the turn renderer's two remainders into the Brief and delete it (chunk 15)

**Depends on:** none

**Chunk label:** `Brief B5: Stage turn renderers (JarvisAnswer/JarvisWorkingSteps) — largely superseded, confirm and delete or re-home the remainder`

**Why:** `frontend/app/view/jarvis/jarvisturn.tsx` has no importer. Against the Brief's `TurnView`
(`frontend/app/view/jarvis/briefsurface.tsx`) two things are really lost: (1) `turnProse` keeps only `text`
segments, but a restored thread's turn is parsed into `{ citationRef: n }` segments (`recallderive.ts`
`parseCitations`), so its prose loses its `[n]` markers while the chip legend under it says "the prose carries the
model's own [n] markers"; (2) no verdict — "Weak grounding" / "Not found" are shown nowhere on the Brief. The Brief
already renders "Ask failed — try again" for a failed ask, so `error` and `cancelled` get no badge. Working steps and
inline `[n]` buttons are fully superseded. `jarvisturnderive.ts` is read, never edited, by this task.

**Files:**
- Create: `frontend/app/view/jarvis/briefturn.ts` + `briefturn.test.ts`
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (delete local `turnProse`, import it; `TurnView` shows the verdict)
- Delete: `frontend/app/view/jarvis/jarvisturn.tsx`
- Modify: `frontend/app/view/jarvis/recallderive.ts` + `recallderive.test.ts` — delete `groundingByN` and its cases if the cascade leaves it orphaned

- [ ] **Step 1: Failing test** `frontend/app/view/jarvis/briefturn.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { JarvisTurn } from "./jarviscontract";
import { turnProse, turnVerdict } from "./briefturn";

function answer(segments: any[], terminal = "answered"): JarvisTurn {
    return { role: "jarvis", workingSteps: [], segments, grounding: [], terminal } as JarvisTurn;
}

describe("turnProse", () => {
    it("keeps a restored turn's citation markers where the model put them", () => {
        expect(turnProse(answer([{ text: "Fixed in " }, { citationRef: 2 }, { text: "." }]))).toBe("Fixed in [2].");
    });
    it("reads a user turn's text", () => {
        expect(turnProse({ role: "user", text: "what broke?", attachments: [] } as JarvisTurn)).toBe("what broke?");
    });
});

describe("turnVerdict", () => {
    it("badges the verdicts the Brief does not already say", () => {
        expect(turnVerdict("weak")).toEqual({ label: "Weak grounding", tone: "warning" });
        expect(turnVerdict("notfound")).toEqual({ label: "Not found", tone: "muted" });
    });
    it("leaves a failed or cancelled ask to the Brief's own failed-ask note", () => {
        expect(turnVerdict("error")).toBeNull();
        expect(turnVerdict("cancelled")).toBeNull();
    });
    it("gives a normal answer no badge", () => {
        expect(turnVerdict("answered")).toBeNull();
    });
});
```

Run `npx vitest run frontend/app/view/jarvis/briefturn.test.ts` → FAIL.

- [ ] **Step 2: Implement** `frontend/app/view/jarvis/briefturn.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// How the Brief reads one turn. Pure so the thread's two rules are tested: a restored turn's citations stay in its
// prose, and a verdict is badged only when the Brief has not already said it.

import type { JarvisTurn, Terminal } from "./jarviscontract";
import { terminalBadge, type TerminalBadge } from "./jarvisturnderive";

export function turnProse(turn: JarvisTurn): string {
    if (turn.role === "user") {
        return turn.text;
    }
    return turn.segments.map((s) => ("text" in s ? s.text : `[${s.citationRef}]`)).join("");
}

// a failed ask already reads "Ask failed — try again" under the composer, so a badge would say it twice
const BADGED_VERDICTS = new Set<Terminal>(["weak", "notfound"]);

export function turnVerdict(terminal: Terminal): TerminalBadge | null {
    return BADGED_VERDICTS.has(terminal) ? terminalBadge(terminal) : null;
}
```

Rerun → PASS.

- [ ] **Step 3: Use it.** In `briefsurface.tsx` delete the local `turnProse` and import `turnProse, turnVerdict`
from `./briefturn`. In `TurnView`, for an answer turn with `const verdict = isAnswerTurn(turn) ? turnVerdict(turn.terminal) : null;`,
render the verdict beside the turn's age when non-null, e.g.
`<span className={cn("flex-none font-mono text-[9.5px] font-semibold", verdict.tone === "warning" ? "text-warning" : "text-muted")}>{verdict.label}</span>`.

- [ ] **Step 4: Delete** `jarvisturn.tsx`; run the orphan cascade (`grep -rlw groundingByN frontend` — if only
`recallderive.ts` and its test remain, delete it and its test cases). Do not touch `terminalBadge` or
`jarvisturnderive.ts`.

- [ ] **Step 5: Verify** — typecheck; `npx vitest run frontend/app/view/jarvis` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "fix(brief): keep a restored thread's citations and show its grounding verdict; delete the Stage turn renderer"`.

- [ ] **Step 7: Close the chunk.** Note: sha; deleted paths; open-issues B5 row text: "closed — the two remainders
re-homed into the Brief's `TurnView` in <sha> (restored threads keep `[n]` markers; weak/notfound verdict badge),
`jarvisturn.tsx` deleted"; live check owed after merge: restore a stored thread with citations and see `[n]` in the prose.

- [ ] **Step 8:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 12: Unwind the record peek's yield-while-stacked workaround (chunk 8)

**Depends on:** none

**Chunk label:** `Record-peek stacked-modal workaround (briefpeekview.tsx:185) — unwind now that ModalShell's isTopModal fixes the underlying bug`

**Why:** `frontend/app/view/jarvis/briefpeekview.tsx` passes `open={recordId != null && pendingStatus == null}` so
the peek unmounts while its confirm dialog is up — a workaround for every mounted `ModalShell` claiming Escape and
focus at once. `frontend/app/modals/modalstack.ts` + the `isTopModal` guard in `modalshell.tsx` fixed Escape. The
yield now costs the peek its scroll position and in-flight state. **Focus is not stack-gated today:**
`modalshell.tsx` calls `takeModalFocus` (`frontend/app/modals/modalfocus.ts`) in an effect gated only on `open`, and
the returned cleanup restores the previously focused element unconditionally. Make both take and restore respect
the stack before removing the workaround.

**Files:**
- Modify: `frontend/app/modals/modalstack.ts` (pure focus rule) + `frontend/app/modals/modalstack.test.ts`
- Modify: `frontend/app/modals/modalshell.tsx` (focus effect)
- Modify: `frontend/app/view/jarvis/briefpeekview.tsx`

- [ ] **Step 1: Read and confirm** in `modalshell.tsx`: the keydown listener returns early unless
`isTopModal(shellId)` (Escape is gated); the focus effect is not. Record both facts for the chunk note.

- [ ] **Step 2: Failing tests** in `modalstack.test.ts`:

```ts
it("hands the keyboard back to a peek once the confirm stacked over it closes", () => {
    const closePeek = registerModal("peek");
    const closeConfirm = registerModal("confirm");
    expect(isTopModal("confirm")).toBe(true);
    expect(isTopModal("peek")).toBe(false);
    closeConfirm();
    expect(isTopModal("peek")).toBe(true);
    closePeek();
});

it("lets only the topmost shell move focus", () => {
    expect(ownsFocus(["peek", "confirm"], "confirm")).toBe(true);
    // a shell under another must neither take focus on open nor restore it on close: either would pull focus out
    // of the dialog the user is looking at
    expect(ownsFocus(["peek", "confirm"], "peek")).toBe(false);
    expect(ownsFocus([], "peek")).toBe(false);
});
```

Run `npx vitest run frontend/app/modals/modalstack.test.ts` → FAIL (`ownsFocus` undefined).

- [ ] **Step 3: Implement** in `modalstack.ts`:

```ts
/** Pure: whether a shell may take focus on open or restore it on close — only the topmost may. */
export function ownsFocus(stack: string[], id: string): boolean {
    return topId(stack) === id;
}
```

and have `isTopModal` read `ownsFocus(openStack, id)` so the two rules cannot drift. In `modalshell.tsx`, take
focus only when `isTopModal(shellId)` at open, and restore on close only if the shell was top when it closed —
capture that **before** the registration effect's cleanup pops it (e.g. read `isTopModal(shellId)` at the start of
the focus effect's cleanup, and make sure the registration cleanup runs after it — reorder the two effects if needed
and say so in a comment). Rerun → PASS. `npx vitest run frontend/app/modals` → PASS.

- [ ] **Step 4: Unwind** in `briefpeekview.tsx`: `open={recordId != null}` and delete the yield comment block above
the `ModalShell`. Leave the confirm dialog's rendering as it is.

- [ ] **Step 5: Verify** — typecheck; `npx vitest run frontend/app/modals frontend/app/view/jarvis` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "fix(modals): stack-gate modal focus and stop the record peek yielding to its confirm"`.

- [ ] **Step 7: Close the chunk.** Note: sha; Escape was already stack-gated, focus was not and now is; open-issues
row text: "fixed in <sha> — focus take/restore stack-gated beside Escape, peek stays mounted under its confirm";
**live check still owed over CDP after merge**: confirm over peek, Escape closes only the confirm, focus returns
to the peek, peek scroll position survives.

- [ ] **Step 8:** `wsh jarvis complete --commit $(git rev-parse HEAD)`

---

### Task 13: Write every backlog-doc update from the chunk notes

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9, Task 10, Task 11, Task 12

**Why:** code tasks were forbidden from editing docs so they could run in parallel (the rows are adjacent lines in
one file). This task writes all of it, citing each commit.

**Files:**
- Modify: `docs/open-issues.md`
- Modify: `docs/deferred.md`
- Modify: `docs/lead-authored-task-routing-roadmap.md`

- [ ] **Step 1: Read the notes.** `wsh effort show cce0be37-6972-4068-89da-2c3738e5f765`. Every chunk except chunk 7
(Diff surface Spec B, deferred — do not touch its rows) carries a note with a commit and row text. Record each
chunk's commit sha; check each with `git show --stat <sha>` so no row cites a commit that is not on this branch.

- [ ] **Step 2: `docs/open-issues.md`** — update, not delete, each row (strike through closed rows the way the file
already does, e.g. `~~...~~ **closed 2026-09-17**`, with the note's text and sha):
  - §1 "2026-08-26 orchestrator gaps scan — closed except G6": G6 is closed — `2ce4161b` (2026-09-14) replaced
    the control-file notify with typed wakes confirmed by the lead's `working` status; retry once, then
    `lead-wake-failed` and questions to the human (`pkg/orchestrate/wake.go` `WakeConfirmTimeout`,
    `TestWakeRetriesOnceThenLeadIsDead`). Retitle the heading so it no longer says "except G6".
  - §1 "Lead-authored task routing": Phase 3 done (DAG graph `551f76ee`, evidence from Task 2's sha); Phase 4 held.
  - §1 "Diff surface JetBrains parity": the revert orphans are kept for Spec B by owner call 2026-09-17; only
    Spec B decides them.
  - §1 "Jarvis Brief B5" table: the channel lifecycle, composer vocabulary, subject browsing, thread lifecycle,
    per-answer cancel/retry, fleet dismiss and Stage turn renderer rows from their notes. Leave the consult,
    resume/proactive and initiative rows as they are.
  - §2 table: "Diff-surface orphans" row (kept for Spec B, owner call 2026-09-17 — no longer an S cleanup);
    F22, F23, F25, F26 rows from their notes (F26 includes any remaining-gap finding); Gatekeeper row:
    "skipped 2026-09-17 — held on evidence: DAG child asks now go to the lead (`watcher.go` `handleAsk` returns
    early for `isDagChildRun`), so the Gatekeeper judges only non-DAG and concierge workers"; the record-peek row
    from Task 12's note, keeping the owed live check.

- [ ] **Step 3: `docs/deferred.md`**:
  - 2026-09-14 Gatekeeper entry: append a dated 2026-09-17 update — held on evidence, reason as above, revive when
    gatekeeper-enabled channels show multi-question escalations the human answers routinely; the fix shape stays valid.
  - 2026-09-10 Brief B5 entry: append a dated 2026-09-17 update listing each item's outcome and sha (deleted /
    re-homed / closed as superseded), and that channel lifecycle is no longer load-bearing (one channel per project).
  - New entries at the top (newest first, matching the file's heading style `## <title> (2026-09-17)`), each with
    what was deferred, why, what exists, and the exact recovery command from the notes: composer attachments
    (Task 8), thread archive/delete (Task 4, revive on thread clutter in the palette), lead-authored routing
    Phase 4 (Task 2). In the 2026-07-16 "Channel composer attachments" entry add one line pointing at the new
    attachments entry.
  - Leave the 2026-09-04 and 2026-07-31 revert entries unchanged — they already say why the revert code is kept.

- [ ] **Step 4: `docs/lead-authored-task-routing-roadmap.md`** — the status line: Phases 1–3 shipped (Phase 3 via
`551f76ee` and Task 2's sha), Phase 4 held on evidence; date "status corrected 2026-09-17".

- [ ] **Step 5: Check** — `git diff --stat` touches only the three docs files; every sha cited exists
(`git cat-file -t <sha>` prints `commit`); no row for chunk 7 changed.

- [ ] **Step 6: Commit** — `git commit -m "docs: record the 2026-09-17 backlog cleanup outcomes"`.

- [ ] **Step 7:** `wsh jarvis complete --commit $(git rev-parse HEAD)`
