# Open issues — actionable backlog

Extracted 2026-07-20 from a reconciliation of `docs/deferred.md`, the `docs/superpowers/briefs`, and
the memory index against the current tree. Everything the memory index still listed as "in-progress"
(Jarvis fan-out v1.1, new-agent-tab integration, cursor-row composer, dual-answer ask, usage backend
parts, wshserver splits, the two 2026-07-14 plans) was verified **shipped** — none of it is listed
here. `docs/deferred.md` remains the canonical running log; this file lifts out the currently
actionable items, with every citation re-verified against the tree.

Each open issue below is independently executable: problem, evidence (file + symbol), fix, effort, and
how to verify. Resolved issues keep only their summary-table row.

| #   | Issue                                                                                                      | Kind                             | Effort | Status                                                    |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------- | ------ | --------------------------------------------------------- |
| 1   | wshrpc generated-file merge strategy (`.gitattributes merge=union`)                                        | tech-debt / infra                | S      | ✅ Resolved 2026-07-20                                    |
| 2   | Split the `runbody.tsx` + `agentsviewmodel.ts` god-files (Theme 4 #4/#5)                                   | tech-debt (move-only)            | S–M    | ✅ Resolved 2026-07-20                                    |
| 3   | Transcript-stream residuals — per-card unmount watcher leak (+ optional incremental projection)            | reliability / perf               | M      | ✅ 3a resolved 2026-07-20 (3b = measure-first, not built) |
| 4   | Channel-attachment temp-file cleanup (unreaped `waveterm-*` temp dirs)                                     | reliability                      | S      | ✅ Resolved 2026-07-20                                    |
| 5   | Remote/WSL worker host operations (git surfaces + attachment paths)                                        | feature scope                    | M–L    | ⛔ Deferred — blocked on a prerequisite (see below)       |
| 6   | **Sealed Run-Evidence card** — 3 coupled fixes in `pkg/jarvis/evidence.go` + `runcompletionsurface.tsx`    | correctness + UX                 | M+S+S  | ✅ Resolved — all three parts                             |
| 6a  | ↳ Files-touched over-attributes under delegator fan-out (ProjectPath-anchored diff + last-worker `by`)     | correctness / evidence integrity | M      | ✅ Resolved 2026-07-21 (2f2f1980)                         |
| 6b  | ↳ "Files touched" row-click opens the OS editor instead of the in-app Diff tab                             | UX / consistency                 | S      | ✅ Resolved 2026-08-03                                    |
| 6c  | ↳ "Verification" detail shows a meaningless first-line (tail-piped output) + command label front-truncated | correctness / evidence integrity | S      | ✅ Resolved 2026-08-03                                    |
| 7   | Unhandled promise rejection on every Monaco model disposal (`monaco-yaml` schema reset)                    | reliability / noise              | S      | ✅ Resolved 2026-08-03                                    |

---

## Closed items

Issues 1–4 were all resolved on 2026-07-20. Their full problem/evidence/fix write-ups were removed in
the 2026-07-31 docs cleanup — the summary table above records each outcome, and the detail is in git.
One decision from issue 3 is worth keeping out of the archive; it is restated under "Not in scope".

**Nothing in this file is actionable today.** Issue 6 closed completely on 2026-08-03 (6b + 6c); issue 5
is blocked on work that does not exist yet; issue 7 was found and fixed the same day. The 6b/6c and 7
write-ups are kept for their rationale, not as pending work.

The repo-wide backlog that remains lives elsewhere: **Phase 3 (Contract) of the channel data-model
scaling workstream** — `docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md`, the
irreversible step that finally collapses the O(session) channel write + broadcast cost — plus the
OS/dock badge and the held redesigns listed in
`docs/superpowers/briefs/2026-07-21-open-ended-improvement-scan-brief.md`.

---

## 5 — Remote/WSL worker host operations

**Status:** ⛔ Deferred 2026-07-20 — **blocked on a prerequisite that does not exist yet.** The doc below
frames this as "route the host-bound commands to `wsh` on the worker's host, keyed off the agent's
connection." But the cockpit has **no remote-worker model** to key off or route to:

- Agent launch (`launch.ts`, `newagentmodal.tsx`) has no connection/SSH/WSL parameter — agents launch
  **locally only**.
- The `Run` / worktree / `AgentVM` model carries **no connection field** — there is no "this worktree is
  on a remote connection" state, so the "only switch to the remote route when remote" condition has
  nothing to test.
- The remote connection route serves `wshremote.MakeRemoteRpcServerImpl` (`wshcmd-connserver.go`), which
  does **not** register `GitChangesCommand` / `GitDiffCommand` / `WriteTempFileCommand` (those live on
  `wshserver.WshServer`). Routing them remotely would fail "command not supported."

So this is not the "M–L route the commands" change the estimate implies. The real prerequisite work,
in order:

1. **Remote agent launch** — connection selection in the new-agent flow, threaded through
   launch → run → worktree → `AgentVM` so an agent carries its connection.
2. **Register the host-bound commands on the remote impl** — add git + `WriteTempFile` (or equivalents)
   to `wshremote`, or expose the `wshserver` handlers over the connection route.
3. **Then** the routing described below (git surfaces + attachment path injection), keyed off the
   agent's connection, local as default.

Cannot be verified without a real SSH/WSL worker. Revisit once (1) lands; the routing design below stays
the reference for step (3).

**Effort:** M–L (routing only) · realistically L once the prerequisite launch work is counted · **Kind:**
feature scope (only matters when using SSH/WSL workers)

### Problem

Several v1 features are **local-scope only**: they run on the wavesrv (local) host and break when the
worker lives on a remote SSH/WSL worktree, which resolves paths and runs git against _its own_
filesystem. This is one coherent piece of work — route the relevant commands to `wsh` on the worker's
host — that recurs across surfaces:

- **git surfaces (Files / diffs):** `GitChanges` / `GitDiff` run on the local host, so an SSH/WSL
  agent worktree shows no changes / wrong diffs.
- **channel attachments:** the temp file (see issue 4) lands on the local host; a remote worker
  resolves the injected path against its own FS and won't find it.

### Evidence

- `docs/deferred.md` → "Files surface — deferred (v1)" → "Remote worktrees"; and "Channel composer
  attachments … 2. Remote / WSL workers can't see local temp paths".
- The same `wsh`-on-remote-host pattern already backs durable SSH/WSL connections
  (`pkg/remote/conncontroller` + `pkg/wsl`).

### Fix

Route the host-bound operations to `wsh` on the worker's host instead of running them locally:

- git: give `GitChangesCommand` / `GitDiffCommand` a remote route (same impl can live on `wsh`), keyed
  off the agent's connection.
- attachments: route `WriteTempFileCommand` to `wsh` on the worker's host (same command, remote
  route) and inject the remote-side path.

Keep the local path as the default; only switch to the remote route when the agent's worktree is on a
remote connection.

### Verify

- On a real SSH/WSL agent worktree: the Files surface shows the correct branch + per-file status and
  diffs; a composer attachment resolves to a path the remote worker can read.
- Local (non-remote) agents are unchanged.

### References

- `docs/deferred.md` → "Files surface — deferred (v1)" and "Channel composer attachments"

---

## 6 — Sealed Run-Evidence card (correctness + UX)

**Status:** ✅ Fully resolved · 6a 2026-07-21 (`2f2f1980`) · 6b + 6c 2026-08-03 · **Kind:** correctness /
evidence integrity + UX

Three coupled defects in the sealed Evidence card, all in the same two files —
`pkg/jarvis/evidence.go` and `frontend/app/view/agents/runcompletionsurface.tsx`. They were done in the
intended order: **6a first** (it changes how the run's change set is scoped, and 6b opens that diff, so
6b rode on 6a being correct), then the two cheaper surface fixes. Both 6b and 6c need a backend rebuild
(`task build:backend`) for the 6c half to take effect, since the summary-line extraction runs in wavesrv.

### 6a — Files-touched over-attributes under delegator fan-out

**Status.** ✅ Resolved 2026-07-21 (commit 2f2f1980, merge a3f37f2c). Decision: Wave records the commit
the worker reports (`Run.EndCommit`, set via `wsh jarvis complete --commit <sha>`; the Wave-built worker
prompts now instruct it) rather than owning per-run worktrees. `SealEvidence` diffs `BaseCommit..EndCommit`
via the new `gitinfo.GetRangeChanges` (falling back to today's working-tree diff when no commit is
reported or the SHA is unresolvable), so siblings merged onto the shared branch no longer leak in. The
misleading per-file `by` (last-worker) stamp was dropped and the inaccurate "derived from worker
transcripts" caption fixed. Needs a backend rebuild (`task build:backend`) to activate. Spec/plan:
`docs/superpowers/{specs,plans}/2026-07-21-run-commit-identity*`. Originally found while auditing the 4
sealed snapshots in prod `#cyber_assistant` (a G1–G4 delegator fan-out): each snapshot's "Files touched"
listed sibling groups' files, and every file was stamped with the same `(by <uuid>)`.

**Problem.** Sealed run-evidence attributes files that the run did not produce, and mislabels who
produced them, whenever multiple runs share one branch (the delegator fan-out case). The evidence
"Files touched" count, add/del totals, and per-file authorship are all wrong under fan-out — the one
surface whose entire purpose is a trustworthy record of what a run changed.

Two coupled root causes:

1. **The diff is anchored to `ch.ProjectPath`, not the run's own worktree/commit range.**
   `CreateRunCommand` freezes `run.BaseCommit = gitinfo.HeadCommit(ch.ProjectPath)` at creation; at
   seal, `SealEvidence` does `gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit)` against the
   _shared_ ProjectPath tree. Workers run in isolated worktrees (`.claude/worktrees/g*`) but FF/squash-
   merge onto the branch ProjectPath tracks. So `diff BaseCommit..ProjectPath` at seal time returns the
   **union of every sibling group merged since BaseCommit**, not just this run's changes. Confirmed:
   run G2's snapshot listed G1/G3/G4's plan files (its own summary even narrates the sibling FF-merges).
2. **`By` is stamped with the _last_ worker, not per-file authorship.**
   `SealEvidence` sets `files[i].By = worker` for every file, where `worker` is `lastWorkerTranscript`'s
   single tab id. So the `(by <uuid>)` shown in the UI is just the last transcript's owner — misleading
   for any run, and actively wrong under fan-out.

**Evidence.**

- `pkg/wshrpc/wshserver/wshserver_runs.go:141` — `run.BaseCommit = gitinfo.HeadCommit(ch.ProjectPath)`.
- `pkg/jarvis/evidence.go:270` — `gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit)` (worktree
  never consulted for files — it's torn down, ProjectPath is the durable source).
- `pkg/jarvis/evidence.go:272-277` — `files[i].By = worker` (single last-worker id for all files).
- `frontend/app/view/agents/runcompletionsurface.tsx:133` — the section caption reads
  "derived from worker transcripts", but files-touched is **git-derived**, not transcript-derived
  (the caption is inaccurate; fold the fix in here).

**Fix.** Scope the diff to the run's own change set instead of ProjectPath-vs-BaseCommit. Options:

1. **Per-run end commit.** Record the run's own resulting commit(s) (the worktree HEAD / squash-merge
   commit for this run) and diff `BaseCommit..<thisRunCommit>` restricted to that range, so siblings
   merged in parallel don't leak in.
2. **Snapshot files at completion, pre-merge.** Capture the worktree diff at the moment the run
   completes (before/independent of the shared-branch merge), while the worktree still exists.

For `By`: derive real per-file authorship (e.g. `git log --diff-filter` / per-worker worktree diffs) or
drop the field rather than stamp the last worker on everything. Fix the FE caption alongside.

**Verify.**

- A delegator fan-out of N groups onto one branch: each run's snapshot lists **only its own** files;
  add/del totals match that run's changes; `by` reflects the actual author (or is absent).
- A single-run-at-a-time channel is unchanged (already exact today).

**References.**

- Memory: `evidence-diff-projectpath-overattribution`, `prod-wstore-db-location-and-blob`.
- `docs/superpowers/` Jarvis delegator fan-out design (the fan-out this surfaces under).

### 6b — Files-touched row-click should open the in-app Diff tab, not the OS editor

**Status.** ✅ Resolved 2026-08-03 · **Effort:** S · **Kind:** UX / consistency.

**Fix as built.** A new pure `runFileNavIntent(run, path?)` in `frontend/app/view/agents/runcompletion.ts`
returns where an evidence click lands (`surface: "files"`, the run source `{runId, cwd, baseCommit}`, and
the file to select or null), unit-tested in `runcompletion.test.ts`. `runcompletionsurface.tsx` gained one
`openRunDiff(model, run, path?)` helper that requests the selection, sets `filesRunAtom`, then switches
`surfaceAtom` — and **both** the file rows and the "Open repository diff" button now go through it, so the
inline atom-setting the button used to do is gone and the two cannot drift apart. Selection is requested
via a new `requestRunFileSelection(runId, path)` in `filesstore.ts`, the `run:`-scoped sibling of
`requestAgentFileSelection`; both now build their token from shared `agentToken`/`runToken` helpers so a
request can't silently name a token no load will match. Artifact chips still call `openPath` (external),
which is correct for a rendered doc/image. Deleted files now show their deletion diff rather than
no-opping, because the Diff surface asks git rather than the filesystem.

**Problem.** Clicking a changed-file row in the sealed Evidence card opens the _current_ file in the OS
default editor — it shows file **content**, not the **change**, which is the entire point of an
evidence "Files touched" list. It also breaks on deleted files (`stat: "D"` → the path no longer
exists, so the external open no-ops). Meanwhile the "Open repository diff" button directly below
already routes into the in-app Diff surface, so the per-file rows are inconsistent with their own card.

Root cause: the file rows reuse the same `openPath()` helper as the **artifact** chips. External-open
is correct for artifacts (view a rendered `.md`/`.html`/`.png`) but wrong for changed files.

**Evidence.**

- `frontend/app/view/agents/runcompletionsurface.tsx:143` — file row `onClick={() => openPath(run.projectpath, f.path)}`
  (same helper the artifact chip uses at `:191`). Header comment: "file/artifact clicks open in the OS editor".
- The in-app Diff surface already supports exactly this: `filesRunAtom` → `loadFilesForRun`
  (`filesstore.ts:127`); per-file diff via `selectFile(cwd, path)` → `GitDiffCommand({cwd, path, ref})`
  (`filesstore.ts:138`); and a reseed-surviving deep-link mechanism `requestAgentFileSelection`/
  `requestedSelection` (`filesstore.ts:133`) — currently wired only for the `agent:` scope.

**Fix.** On file-row click: set `model.filesRunAtom = {runId, cwd: projectpath, baseCommit}`, request
selection of that `path` (add a `run:`-scoped variant of `requestAgentFileSelection`, or generalize it
to take the load token), then `model.surfaceAtom = "files"`. Leave the **artifact** chips opening
externally. ~a dozen lines. Note: the per-file diff loads vs `baseCommit`, so it inherits 6a's
over-attribution under fan-out — no worse than today, and the real fix is 6a.

**Verify.**

- Clicking a file row opens the Diff tab (read-only, run-scoped) with that file's diff preselected.
- A deleted file shows its deletion diff instead of failing to open.
- Artifact chips still open externally.

### 6c — Verification detail is a meaningless first-line; command label front-truncated

**Status.** ✅ Resolved 2026-08-03 · **Effort:** S · **Kind:** correctness / evidence integrity.

**Fix as built.** Backend: `firstLine` is replaced by `verifSummaryLine` in `pkg/jarvis/evidence.go`, which
scans the captured output **backward** for a recognized result summary — a counted outcome
(`\d+ (passed|failed|error|errors|skipped)`, covering pytest/vitest/tsc) or a go-test verdict line — and
falls back to the last non-empty line when nothing matches. The verdict alternative requires trailing
content (`^(ok|pass|fail)\b.*\S`) so go test's bare final `FAIL` does not win over the informative
`FAIL\tpkg\t0.4s` line above it. `firstLine` had no other caller in `pkg/jarvis` and was deleted (the
same-named helpers in `memvault`/`memgarden`/`wshserver` are separate copies and untouched). Covered by a
seven-case table test plus an end-to-end test through `verificationCommands` using a `pytest … | tail -20`
fixture; `TestVerificationDetailStripsANSI` kept its ANSI-stripping intent but moved its escape codes onto
the summary line, since it had been asserting on first-line content incidentally.

Frontend: a pure `verifCmdLabel` in `runcompletion.ts` drops leading `cd …` / `VAR=…` / `export VAR=…`
segments joined by `&&`, so the command cell shows the test invocation instead of the worktree path; it
returns the command unchanged when every segment is setup, so nothing is ever blanked. The cell also
carries `title={v.cmd}` for the full original. Pass/fail/unknown counts are untouched.

**Problem.** In the sealed Evidence "Verification" section, the pass/fail **counts are correct**, but
the two text columns show the least-informative slice of each command:

1. **Detail is a random fragment.** `detail` is computed as `firstLine(StripANSI(output))`. Workers
   commonly pipe verification commands through `| tail -N`, so the captured stdout is already the last
   N lines and `firstLine()` returns an arbitrary middle-of-run line (a test-fn signature, pytest's
   `metadata:`/`rootdir:` header, a captured log line, or an `echo` marker) — never the result summary,
   which pytest/go-test print on the **last** line (`===== 12 passed in 3.4s =====`).
2. **Command label front-truncated.** The command cell uses CSS `truncate` (trailing ellipsis), so a
   `cd "<long worktree path>" && … pytest <target>` shows only the useless `cd "C:/…"` prefix and hides
   the part identifying what was tested.

**Evidence.**

- `pkg/jarvis/evidence.go:148` — `detail := firstLine(utilfn.StripANSI(txt))` (first line of captured output).
- `pkg/jarvis/evidence.go:168-174` — `firstLine` returns the first `\n`-delimited line.
- `frontend/app/view/agents/runcompletionsurface.tsx:173` — `<span className="… truncate …">{v.cmd}</span>`
  (ellipsis at end → front of the command shown).
- Observed in prod `#cyber_assistant` snapshots (details like `def test_initial_state_…`, `metadata: {…}`,
  `rootdir: C:\Users\…`, `=== branch ===`).

**Fix.**

- **Detail:** extract the **result summary** instead of the first line — prefer the last non-empty line,
  or regex the recognized summary (`\d+ (passed|failed)`, `PASSED`/`FAILED`, `ok`/`FAIL` for go test,
  the `===== … =====` band). Fall back to last line when nothing matches.
- **Command label:** show the meaningful part — strip a leading `cd … &&` / `WT=… &&` prefix and/or
  middle-truncate so the `pytest <target>` survives; keep the full command in a title/tooltip.

**Verify.**

- A `pytest … | tail -20` verification shows `12 passed …` (or the real summary), not a stray line.
- The command cell shows the test invocation, not the `cd` prefix.
- Counts (`pass`/`fail`/`unknown`) are unchanged.

---

## 7 — Unhandled promise rejection on every Monaco model disposal

**Status:** ✅ Resolved 2026-08-03 — `monaco-yaml` removed entirely (see "Fix" below for exactly what was
deleted). **Kind:** reliability / console noise (no user-visible symptom). Kept out of the archive
because the rationale answers a question a future reader will ask: _why does this editor have no YAML
language server?_

### Problem

Every time a Monaco text model is disposed, the page emits an unhandled promise rejection:

```
Error: Missing requestHandler or method: resetSchema
    at _EditorWorker.$fmr        (monaco-editor dep chunk)
    at Proxy.<anonymous>         (monaco-editor dep chunk)
    at Object.doReset            (monaco-yaml)
```

The rejection is **language-independent** — it fires for Go, TypeScript, JSON, anything — because it is
the YAML integration's schema-reset running against models it does not own.

Nothing breaks: the editor mounts, highlights, and switches files correctly, and the counts line up
exactly (opening N files in a row produces N−1 … N rejections, one per disposed model). The cost is that
the browser console is permanently dirty, so a _real_ rejection during editor work is easy to miss.

This is **pre-existing and unrelated to any recent feature** — `frontend/app/monaco/monaco-env.ts` was
last touched 2026-01-05 by the upstream Monaco upgrade (`b46d92ef`). What changed is **reachability**:
until the Code surface shipped (`5c12d267`), the only Monaco consumers were the orphaned `aifilediff`
block (Wave AI chat, itself a documented removal candidate) and the standalone `task preview` server, so
nothing in the shipping cockpit routinely created and disposed Monaco models. The Code surface disposes
one model per file switch — `codeviewer.tsx` renders `<CodeEditor key={file.path} …>`, so switching files
remounts the editor by design — which turns a latent bug into a per-interaction one.

### Evidence

Root cause is a missing language guard in a third-party package, triggered by our own configuration
call. Three links in the chain:

1. `frontend/app/monaco/monaco-env.ts:67` — `configureMonacoYaml(monaco, { validate: true, schemas: [] })`,
   inside `loadMonaco()`. This is the app's own call and the thing that installs the faulty listener.
   Note the argument: **`schemas: []`** — the YAML integration is configured with zero schemas, so it
   performs generic YAML syntax validation and nothing more. (The six real schemas in
   `frontend/app/monaco/schemaendpoints.ts` are **JSON** schemas, handed to
   `monaco.json.jsonDefaults.setDiagnosticsOptions` on the line below — none of them reach monaco-yaml.)
2. `node_modules/monaco-yaml/src/index.ts:245` (`monaco-yaml@5.4.0`) — `configureMonacoYaml` registers a
   marker-data provider for the `yaml` language whose `doReset(model)` calls
   `workerManager.getWorker(model.uri)` then `worker.resetSchema(String(model.uri))`.
3. `node_modules/monaco-marker-data-provider/dist/monaco-marker-data-provider.js:60-63` — **the actual
   bug.** Its `onWillDisposeModel` handler runs

   ```js
   const onWillDisposeModel = monaco.editor.onWillDisposeModel((model) => {
     onModelRemoved(model);
     provider.doReset?.(model); // <- no matchesLanguage(model) guard
   });
   ```

   `onModelAdd` (line 33) _does_ guard with `matchesLanguage(model)`; the disposal path and the
   `onDidChangeModelLanguage` path (line 64-68) do not. So the YAML provider's `doReset` is invoked for
   every disposed model regardless of language, the yaml worker proxy is asked to `resetSchema` a
   non-YAML resource, the request lands on a worker with no such method, and the returned promise is
   `await`ed by nobody.

Reproduced against the live dev app over the Chrome DevTools Protocol on 2026-08-03: hook
`window.addEventListener("unhandledrejection", …)`, open the Code surface, open two files in sequence —
two identical rejections, both with the `Object.doReset` frame above.

### Fix (applied 2026-08-03)

**The YAML integration was deleted rather than patched.** It was configured with zero schemas, so it
bought only generic YAML syntax validation in a read-only viewer, while costing an unhandled rejection
per model disposal plus a bundled YAML worker. Suppressing the rejection would have left the pointless
call in place; removing the caller removes the whole class of noise. What was deleted:

- `frontend/app/monaco/monaco-env.ts` — the `configureMonacoYaml(...)` call, its `monaco-yaml` import,
  the `./yamlworker?worker` import, and the `yaml`/`yml` branch of `MonacoEnvironment.getWorker`
  (dead once nothing requests a worker under that label). A short comment marks why it is absent.
- `frontend/app/monaco/yamlworker.js` — deleted; it was a one-line re-export of
  `monaco-yaml/yaml.worker.js` and had no other consumer.
- `package.json` — the `monaco-yaml` dependency. `npm uninstall` dropped exactly seven lockfile
  entries, all of them monaco-yaml's own subtree (`monaco-yaml`, `monaco-marker-data-provider`,
  `monaco-worker-manager`, `monaco-languageserver-types`, `monaco-types`, `jsonc-parser`,
  `path-browserify`) with no other package churn. None of the seven is imported anywhere in the repo.

The obvious worry — "does dropping it break YAML?" — is already retired. Monaco's own bundled grammar set
registers the language identically and supplies the tokenizer:
`node_modules/monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js` registers
`id: "yaml"`, `extensions: [".yaml", ".yml"]`, the same aliases and mimetypes, and a `loader` for the
tokenizer — and `editor.main.js` imports every basic-languages contribution, which the app gets via the
plain `import * as monaco from "monaco-editor"` at the top of `monaco-env.ts`. monaco-yaml's own
`monaco.languages.register({ id: 'yaml', … })` is therefore a duplicate of what is already there.
Removing it costs the language-server features only (YAML completion, hover, format, folding, links),
none of which a read-only viewer uses.

**If YAML schema validation is ever actually wanted** (nobody has asked for it — decide before doing the
work): re-add `configureMonacoYaml` _with real schemas_, and pin or patch `monaco-marker-data-provider`
to a version whose disposal path applies the same `matchesLanguage` guard as `onModelAdd`. The guard
omission is plainly a bug and is worth filing upstream regardless.

**Do not** solve this with a global `unhandledrejection` swallow — that hides the symptom, leaves the
pointless call in place, and would mask genuine rejections, which is the exact failure mode this issue
was about.

### Verify

- With the dev app running, hook `unhandledrejection`, open the Code surface, and switch between several
  files of different languages (`.go`, `.ts`, `.json`, `.yml`): **zero** rejections.
- A `.yml` file (e.g. `Taskfile.yml`) still opens and still shows YAML syntax coloring — coloring comes
  from Monaco's bundled basic-languages grammar, not from `monaco-yaml`, so removing the integration must
  not change it.
- `task verify:ui -- surface-smoke` still passes all rows.

### References

- Found during the live Chrome DevTools Protocol verification of the Code surface (`5c12d267`),
  2026-08-03. Every other check in that pass was clean.
- `frontend/app/view/code/codeviewer.tsx` — the per-file `key` that makes disposal frequent.
- CLAUDE.md → "Visual verification (dev)" for the CDP attach pattern used to reproduce this.

---

## Not in scope (permanent limitations / declined — do not "fix")

Rate-limit token _cap_ + plan-tier badge (no honest source from Anthropic), Codex/OpenAI 5h-window
bars (Codex has no such window), Codex subagents + deep subagent nesting (no source files), cockpit
light/Paper theme (owner: permanently won't-fix), Gatekeeper v1.1, and the Arc Environment capability
(both declined). See `docs/deferred.md` for the reasoning behind each.

**Incremental stateful transcript projection (issue 3b) — measure-first, deliberately not built.** The
Theme 2 streaming slice already caps per-chunk work with a `MAX_RETAINED_LINES` window, re-projected in
full per chunk — O(window), not O(session). A stateful projector would make per-chunk cost O(chunk),
but that is only worth building if the bounded re-project actually profiles hot. **How to decide:**
populate via `node scripts/inject-live-agents.mjs`, run a CDP / React-DevTools profiler pass against
the live dev app, and build it only if `project(lines)` / `extractTasks` shows up hot at the capped
window size.
