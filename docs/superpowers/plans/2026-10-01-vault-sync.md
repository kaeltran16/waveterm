# Vault sync across machines — implementation plan

> **For agentic workers:** each task carries its design decisions, the files it owns, the interfaces other
> tasks rely on, and its acceptance tests. Write the implementation yourself; follow TDD (failing test
> first). Steps use checkbox (`- [ ]`) syntax.

**Goal:** the Wave Vault, initiatives (efforts), the Jarvis profile and the portable settings stay the same
on two machines, synced through a private git remote, with nothing to remember on a switch.

**Architecture:** a sync engine in `pkg/wavevault` (fetch, merge, conflict resolution, push under a
package-level vault lock), driven by a debounced/ticking loop in wavesrv and exposed over three wshrpc
commands. Efforts move from SQLite to `<vault>/efforts/<oid>.json` behind a drop-in `pkg/effortstore`;
a field-aware `MergeEffort` resolves their conflicts. Settings gain a vault layer
(`<vault>/config/settings.json`) between defaults and the local file; the Jarvis profile moves to
`<vault>/config/jarvis-profile.json`.

**Tech Stack:** Go (wavesrv, wsh, wshrpc, real `git` via `os/exec`), React 19 + jotai (Settings surface),
vitest, Go `testing`.

**Spec:** `docs/superpowers/specs/2026-10-01-vault-sync-design.md`

**Verify:** `node scripts/verify.mjs ./pkg/wavevault/... ./pkg/effortstore/... ./pkg/wstore/... ./pkg/wconfig/... ./pkg/memroots/... ./pkg/jarvis/... ./pkg/jarvisstate/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./cmd/wsh/... ./cmd/server/...`
**Check:** `go build ./cmd/server/... ./cmd/wsh/... && go vet ./pkg/wavevault/... ./pkg/wconfig/... ./pkg/memroots/... ./pkg/jarvis/... ./pkg/wshrpc/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`

## Global Constraints

- The git remote is the only switch: sync is on iff the vault has an `origin` remote. No setting holds the
  URL or an on/off flag. Pausing is `git remote rename origin origin-paused`.
- Remote branch is `main`; push is `git push origin HEAD:main`. Merge, never rebase.
- Every sync git command runs with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`.
- Timings: pull every 15 minutes; push 5s after the last vault write (debounced); focus-triggered sync at most
  once a minute (frontend throttle); `wsh vault sync` unthrottled. Named constants, no inline numbers.
- Paths in the vault: efforts `efforts/<oid>.json`; conflict copies `conflicts/<original path>`; vault config
  `config/settings.json`, `config/jarvis-profile.json`. None of `efforts/`, `conflicts/`, `config/` is a
  scanned collection (`wavevault.AllScope()` stays memory/tasks/decisions).
- Effort JSON is `json.MarshalIndent(e, "", "  ")` plus a trailing newline — one marshal function, used by
  the store and by sync.
- Machine-local settings keys (never written to, and ignored in, the vault layer): `memory:vaultpath`,
  `jarvis:vaultpath`, `term:gitbashpath`, `term:localshellpath`, `term:localshellopts`.
- Sync failures never block local work. Every failure is logged (`log.Printf`, reaches `waveapp.log`) with the
  git command and its stderr.
- Never hand-edit generated files: after changing `pkg/wshrpc` types run `task generate`.
- Colors only from `@theme` tokens; no new design tokens.
- No attribution trailers in commit messages.

## Decisions this plan makes beyond the spec

- **Modify/delete conflicts** (a stage `:2` or `:3` missing): the side that still has the file wins and stays
  in place, for effort files and every other file alike — an edit outlives a concurrent delete, matching the
  chunk rule. No conflict copy is written (nothing is lost).
- **First push to an empty remote:** when `origin/main` does not exist after fetch, skip the merge and push.
- **`--allow-unrelated-histories`** is always passed to the merge; it is a no-op for related histories, so no
  branch is needed to detect the first join.
- **The sync loop lives in `pkg/wavevault`** (`syncloop.go`), so `Commit` can call the unexported poke
  channel without an import cycle; notices are delivered through a `notify` func injected at start (wavevault
  does not import `wps`).
- **`VaultSyncCommand` takes `wait`:** the frontend focus trigger sends `wait:false` (returns at once — a sync
  can outlive the 5s RPC budget); `wsh vault sync` sends `wait:true` with a long RPC timeout and prints the
  result.
- **Settings written to the vault layer poke the sync loop** through a `wconfig.OnVaultLayerWrite` hook (wconfig
  cannot import wavevault), so a settings change pushes like any other vault write.
- **Profile migration leaves a local file alone when the vault already has one** (never deletes user data;
  logs once).

## Review Focus

1. **Joining with an empty, freshly created remote** (first machine, `origin/main` absent) — sync must push,
   not fail on the missing ref. Test: `TestSyncFirstPushToEmptyRemote` (Task 2).
2. **A fresh vault with no commits joining a populated remote** (unborn `HEAD`) — the merge must fast-forward
   and the remote files appear locally. Test: `TestSyncUnbornVaultJoinsRemote` (Task 2).
3. **Binary or CRLF file in conflict** — conflict stages must be written byte-exact (the existing `runGit`
   trims output; it must not be used to read blobs). Test: `TestSyncConflictCopyIsByteExact` with a file whose
   content ends in `\r\n` and contains a NUL byte (Task 2).
4. **Fetch/push slower than the 10s `gitTimeout`** — network commands get their own longer timeout
   (`syncGitTimeout`, 2 minutes); local commands keep 10s. Covered by code review; no network in tests.
5. **A caller mutating an effort returned by `Get`/`GetAll`** must not corrupt the cache. Test:
   `TestGetReturnsIndependentCopy` (Task 5).

---

### Task 1: Effort codec, `MergeEffort` and `MergeSettings`
**Depends on:** none

The pure half of sync: one effort codec and two three-way merges, used by sync (Task 2) and the store
(Task 5).

**Files:**
- Create: `pkg/wavevault/effortmerge.go`, `pkg/wavevault/settingsmerge.go`
- Test: `pkg/wavevault/effortmerge_test.go`, `pkg/wavevault/settingsmerge_test.go`

**Interfaces — Produces:**
- `const EffortsDir = "efforts"`
- `func ParseEffort(b []byte) (*waveobj.Effort, error)` — strict JSON decode; an empty `OID` is an error.
- `func MarshalEffort(e *waveobj.Effort) ([]byte, error)` — `json.MarshalIndent(e, "", "  ")` + `"\n"`.
- `func MergeEffort(base, ours, theirs *waveobj.Effort) *waveobj.Effort` — `base` may be nil (file new on
  both sides); never mutates its inputs.
- `const SettingsSyncPath = "config/settings.json"` — the repo-relative (slash) path sync merges by key.
- `func MergeSettings(base, ours, theirs []byte) ([]byte, error)` — each a JSON object (`base` may be nil:
  no common ancestor); any malformed input is an error (sync then falls back to the general rule). Output
  is `json.MarshalIndent` of the merged object (keys sorted) + `"\n"`.

**`MergeSettings` rules (spec, Sync step 5):** per key, compared against base by compacted JSON value:
changed on one side → that side (a deletion counts as a change); changed on both → ours; unchanged → base.
No base → union, ours winning a clash.

**`MergeEffort` rules (from the spec, exact):**
- Scalars `Title`, `Project`, `Ticket`, `Status`, `ParentOID`, `Meta`: from the side with the newer
  `UpdatedTs` (tie → ours).
- Chunks keyed by `Label`: one side only and absent from base → keep. In base, missing on one side and
  unchanged on the other → removed. Missing on one side and changed on the other → keep the changed one. On
  both sides → the chunk with the newer `UpdatedTs`, with `Notes` and `WorkRefs` unioned.
- `Notes`, `Events`, chunk `Notes`, `WorkRefs`: union, de-duplicated by full value, sorted by `Ts` (stable).
- Chunk order: the newer side's order; chunks only on the other side appended in their order.
- `Version` = max + 1; `UpdatedTs` = max; `CreatedTs` = min of the non-zero values; `OID` from ours.
- "Changed" for a chunk = not deep-equal to its base version.

- [ ] **Step 1:** Write table tests in `effortmerge_test.go`: `TestMergeEffort` with cases — chunk added
  ours / added theirs; removed ours (unchanged theirs) → gone; removed ours, edited theirs → kept (edited);
  both edited → newer chunk wins, notes and workrefs unioned; note union de-dups identical notes and sorts by
  `Ts`; events union; scalar from newer side (and tie → ours); order = newer side's order plus the other
  side's extras appended; `Version` max+1, `UpdatedTs` max; nil base (both sides add same label → newer wins).
  Plus `TestMergeEffortDoesNotMutateInputs` and `TestParseEffortRejectsMalformed` (bad JSON, missing oid) and
  `TestMarshalEffortRoundTrip`. In `settingsmerge_test.go`, `TestMergeSettings` table: key changed ours only →
  ours; theirs only → theirs; both → ours; deleted theirs, unchanged ours → deleted; deleted ours, changed
  theirs → theirs; nil base → union with ours winning a clash; nested object values compared by value, not by
  formatting; malformed input → error.
- [ ] **Step 2:** Run `go test ./pkg/wavevault -run 'TestMergeEffort|TestParseEffort|TestMarshalEffort|TestMergeSettings'` —
  expect FAIL (undefined).
- [ ] **Step 3:** Implement `effortmerge.go` and `settingsmerge.go`.
- [ ] **Step 4:** Rerun the same command — PASS.
- [ ] **Step 5:** Commit `feat(vault): three-way merges for effort files and vault settings` — include
  `docs/superpowers/specs/2026-10-01-vault-sync-design.md` in this commit if it is not already on the branch.

### Task 2: Vault lock and the `Sync` engine
**Depends on:** Task 1

**Files:**
- Create: `pkg/wavevault/lock.go`, `pkg/wavevault/sync.go`
- Modify: `pkg/wavevault/commit.go` (lock + `commitLocked` + poke), `pkg/wavevault/git.go` (raw-output and
  env-carrying helpers, `syncGitTimeout`)
- Test: `pkg/wavevault/sync_test.go`, `pkg/wavevault/lock_test.go`

**Interfaces — Consumes:** `ParseEffort`, `MarshalEffort`, `MergeEffort`, `EffortsDir`, `MergeSettings`,
`SettingsSyncPath` (Task 1).

**Interfaces — Produces:**
- `func LockRoot(root string) (unlock func())` — package-level mutex per `filepath.Clean`ed (and on Windows
  case-folded) root; not reentrant.
- `func Poke()` — non-blocking send on an unexported buffered(1) channel `pokeCh`; safe with no loop running.
  Task 3's loop drains `pokeCh`.
- `func PokedForTest() bool` — non-blocking drain of `pokeCh`; reports whether a poke was pending. The seam
  sibling-package tests (Task 5, Task 8) use to observe that a write poked sync.
- `const ConflictsDir = "conflicts"`
- `type SyncResult struct { Off string; Pushed bool; NewConflicts []string }` — `Off` is `""` when sync ran,
  `"no-git"` when `git` is not on PATH, `"no-remote"` when there is no `origin`. `NewConflicts` lists
  vault-relative conflict-copy paths written by this run.
- `func (v *Vault) Sync(ctx context.Context) (SyncResult, error)`
- `func (v *Vault) RemoteURL(ctx context.Context) (string, error)` — `""` with nil error when no origin.
- `func (v *Vault) SetRemote(ctx context.Context, url string) error` — `add` or `set-url`; `""` removes
  `origin`.
- `func (v *Vault) ConflictCopies() ([]string, error)` — vault-relative paths under `conflicts/`, sorted.
- `func (v *Vault) MalformedEfforts() ([]string, error)` — vault-relative `efforts/*.json` that fail
  `ParseEffort`, sorted.

**Behavior:**
- `Commit` takes `LockRoot(v.Root)` and delegates to unexported `commitLocked`; after it commits anything it
  calls `Poke()`. `Sync` step 2 calls `commitLocked` directly (already under the lock).
- `Sync` follows spec steps 1–7 exactly, under `LockRoot`. Merge with
  `git merge --no-edit --allow-unrelated-histories origin/main`. If `origin/main` does not exist after fetch,
  skip to push. Conflicted paths from `git diff --name-only --diff-filter=U`; stages read byte-exact (a raw
  helper — `runGit` trims). Effort conflict: parse all present stages, `MergeEffort`, `MarshalEffort`, write,
  `git add`; any parse failure → general rule. `SettingsSyncPath` conflict: `MergeSettings` over the
  present stages (nil base when `:1` is absent), write, `git add`; an error → general rule. General rule: keep `:2` in place, write `:3` to
  `conflicts/<path>`, `git add` both. Modify/delete (stage `:2` or `:3` missing) → write the present side's blob
  in place and `git add` it; no conflict copy (see Decisions).
- Non-fast-forward push rejection (stderr contains `[rejected]`, `non-fast-forward` or `fetch first`):
  repeat fetch→merge→resolve→push once; a second rejection returns an error. An unexported
  `beforePush func()` package var is the test seam for the race.
- Network commands (`fetch`, `push`) use `syncGitTimeout = 2 * time.Minute`; all sync git commands carry
  `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. Errors name the git command and its stderr.

- [ ] **Step 1:** Write `sync_test.go` using real git: two vaults (`OpenVaultAtForTest` on `t.TempDir()`) and a
  bare repo (`git init --bare -b main`). A helper sets `origin` via `SetRemote`. Tests:
  `TestSyncNoRemoteIsNoop` (`Off == "no-remote"`, no error), `TestSyncFirstPushToEmptyRemote`,
  `TestSyncEachSideCommitsAndSyncs` (A writes memory note, syncs; B syncs and sees it; B writes, syncs; A sees
  it), `TestSyncUnbornVaultJoinsRemote`, `TestSyncJoinsUnrelatedHistories` (both vaults seeded with an
  identical `skills/x/SKILL.md` and a differing `steering/AGENTS.md` → identical merges clean, differing keeps
  local and writes `conflicts/steering/AGENTS.md`), `TestSyncBothEditSameNote` (local kept, remote under
  `conflicts/`, `NewConflicts` names it), `TestSyncBothEditSameEffort` (field-aware result in place, no
  conflict copy), `TestSyncFirstJoinMergesSettingsKeys` (both vaults create `config/settings.json` with
  different keys and one shared key before their first sync → union in place, local wins the shared key, no
  conflict copy), `TestSyncMalformedEffortConflictFallsBack` (general rule), `TestSyncModifyDeleteKeepsEdit`,
  `TestSyncConflictCopyIsByteExact` (CRLF + NUL content), `TestSyncPushRaceRetries` (`beforePush` makes B push
  first once → A's sync still succeeds), `TestSyncRecoversInterruptedMerge` (leave a conflicted merge with
  `MERGE_HEAD` present → next `Sync` aborts it and succeeds), `TestSetRemoteAddSetRemove`,
  `TestConflictCopiesAndMalformedEfforts`. `lock_test.go`: `TestLockRootSerializesSameRoot` (cleaned and
  case-variant roots share a lock; distinct roots don't block), `TestPokeIsNonBlockingAndDrainable` (two
  `Poke()` calls with no reader don't block; `PokedForTest()` is true once, then false),
  `TestCommitPokes` (a `Commit` that commits something leaves `PokedForTest()` true).
- [ ] **Step 2:** Run `go test ./pkg/wavevault -run 'TestSync|TestSetRemote|TestConflictCopies|TestLockRoot|TestPoke|TestCommitPokes'`
  — expect FAIL.
- [ ] **Step 3:** Implement `lock.go`, `sync.go`, the `commit.go` split, and the `git.go` helpers.
- [ ] **Step 4:** Rerun the same command, then `go test ./pkg/wavevault -run 'TestCommit'` (existing commit
  tests still pass under the lock) — PASS.
- [ ] **Step 5:** Commit `feat(vault): git sync engine with conflict copies and effort merge`.

### Task 3: Sync loop, RPCs and `wsh vault`
**Depends on:** Task 2

**Files:**
- Create: `pkg/wavevault/syncloop.go`, `pkg/wavevault/syncloop_test.go`, `pkg/wshrpc/wshrpctypes_vault.go`,
  `pkg/wshrpc/wshserver/wshserver_vault.go`, `cmd/wsh/cmd/wshcmd-vault.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` (embed `VaultCommands`), `cmd/server/main-server.go` (start the loop),
  generated files via `task generate`

**Interfaces — Consumes:** `Poke`/`pokeCh`, `(*Vault).Sync`, `RemoteURL`, `SetRemote`, `ConflictCopies`,
`MalformedEfforts`, `SyncResult` (Task 2).

**Interfaces — Produces:**
- `func StartSyncLoop(ctx context.Context, notify func(title, message, level string))` — idempotent.
- `func RequestSync(ctx context.Context, wait bool) error` — triggers a run; with `wait`, blocks until the
  run that covers this request finishes and returns its error.
- `func CurrentSyncStatus(ctx context.Context) SyncStatus` with
  `type SyncStatus struct { Off string; RemoteURL string; LastSuccessTs int64; LastError string; Running bool; Conflicts []string; MalformedEfforts []string }`.
- wshrpc (`wshrpctypes_vault.go`):
  ```go
  type VaultCommands interface {
      VaultSyncCommand(ctx context.Context, data CommandVaultSyncData) error
      VaultStatusCommand(ctx context.Context) (*VaultStatusRtnData, error)
      VaultSetRemoteCommand(ctx context.Context, data CommandVaultSetRemoteData) error
  }
  type CommandVaultSyncData struct { Wait bool `json:"wait,omitempty"` }
  type CommandVaultSetRemoteData struct { URL string `json:"url"` } // "" removes origin
  type VaultStatusRtnData struct {
      Off string `json:"off,omitempty"`; RemoteURL string `json:"remoteurl,omitempty"`
      LastSuccessTs int64 `json:"lastsuccessts,omitempty"`; LastError string `json:"lasterror,omitempty"`
      Running bool `json:"running,omitempty"`; Conflicts []string `json:"conflicts,omitempty"`
      MalformedEfforts []string `json:"malformedefforts,omitempty"`
  }
  ```
  Generated TS: `RpcApi.VaultSyncCommand`, `RpcApi.VaultStatusCommand`, `RpcApi.VaultSetRemoteCommand`,
  type `VaultStatusRtnData` (Task 4 relies on these names).

**Behavior:**
- Triggers: `syncInterval = 15 * time.Minute` ticker; `pokeCh` debounced `pokeDebounce = 5 * time.Second`
  (a burst → one run); `RequestSync`. Single-flight: a trigger during a running sync sets a "run again" flag;
  exactly one follow-up run.
- Each run opens the vault fresh (`OpenVault`) so a changed vault path takes effect.
- Notices via `notify`: a failure raises one `error` notice on the first failure of a streak (title
  "Vault sync failed", message = the error); a success resets the streak. Each conflict copy not seen before
  raises one `warn` notice naming the path. `Off` is not a failure.
- `wsh vault remote [url]`: no arg prints the URL (or "no remote — sync is off"); with a URL calls
  `VaultSetRemoteCommand` then `VaultSyncCommand{Wait:true}`; `--remove` clears it. `wsh vault sync` →
  `VaultSyncCommand{Wait:true}` with a 3-minute RPC timeout, prints "synced" or the error (exit 1).
  `wsh vault status` prints remote, last success (local time), last error, conflict copies, malformed efforts,
  or which `Off` reason applies. Follow the layout and flag conventions of `cmd/wsh/cmd/wshcmd-notify.go`.
- `main-server.go`: after `wcore.InitMainServer`, `wavevault.StartSyncLoop` with a `notify` that publishes
  `wps.Event_Notify` with a `wshrpc.NotifyCommandData` (same path as `NotifyCommand`).

- [ ] **Step 1:** Write `syncloop_test.go` with the loop's sync func, clock durations and notify injected
  through unexported fields: `TestLoopDebouncesPokeBurst` (10 pokes → 1 run), `TestLoopRunAgainOnce`
  (3 triggers during a run → exactly 1 more), `TestLoopFailureStreakNoticesOnce` (3 failures → 1 notice;
  success then failure → second notice), `TestLoopNewConflictNoticesOnce`, `TestRequestSyncWaitReturnsError`.
  Add `TestVaultStatusCommandOff` in `pkg/wshrpc/wshserver` (no remote → `Off == "no-remote"`).
- [ ] **Step 2:** Run `go test ./pkg/wavevault -run 'TestLoop|TestRequestSync'` and
  `go test ./pkg/wshrpc/wshserver -run 'TestVaultStatusCommand'` — FAIL.
- [ ] **Step 3:** Implement the loop, the RPC types, `task generate`, the server handlers, `wshcmd-vault.go`,
  and the `main-server.go` wiring.
- [ ] **Step 4:** Rerun both commands — PASS. `go build ./cmd/wsh/... ./cmd/server/...` succeeds.
- [ ] **Step 5:** Commit `feat(vault): sync loop, vault RPCs and wsh vault remote|sync|status`.

### Task 4: Focus trigger and Settings > Memory sync view
**Depends on:** Task 3

**Files:**
- Create: `frontend/app/store/vaultsync.ts`, `frontend/app/store/vaultsync.test.ts`
- Modify: `frontend/app/view/agents/settingsmodel.ts` (+ `settingsmodel.test.ts`),
  `frontend/app/view/agents/settingssurface.tsx` (`MemorySection`), the always-mounted shell entry that owns
  window-level listeners (find where `TabRpcClient` is ready at startup — `frontend/tauri/main.tsx` or the
  shell it mounts)

**Interfaces — Consumes:** `RpcApi.VaultSyncCommand`, `RpcApi.VaultStatusCommand`,
`RpcApi.VaultSetRemoteCommand`, `VaultStatusRtnData` (Task 3).

**Behavior:**
- `vaultsync.ts`: `export const FOCUS_SYNC_MIN_INTERVAL_MS = 60_000;`
  `export function shouldSyncOnFocus(lastMs: number | null, nowMs: number): boolean`. The shell's window
  `focus` listener calls `VaultSyncCommand({ wait: false })` when it returns true, fire-and-forget.
- Settings > Memory gains a "Sync remote" row (`id: "memory.remote"`, no `key`, not `config`): a URL field that
  calls `VaultSetRemoteCommand` on commit (empty removes), and a status line under it from
  `VaultStatusCommand`, loaded on section mount and after a set. The row stores no setting.
- Pure `export function vaultStatusLine(s: VaultStatusRtnData | null): string` in `settingsmodel.ts`:
  `"Sync off — no remote"`, `"Sync off — git not found"`, `"Syncing…"`, `"Last synced <relative time>"`,
  `"Sync failed: <error>"`, with `", N conflict copies"` / `", N malformed efforts"` appended when non-zero.
- The `memory.vaultpath` row's `scope` becomes `"local"` (it is machine-local after Task 7).
- Styling from existing tokens and the surrounding rows' classes only.

- [ ] **Step 1:** Tests: `vaultsync.test.ts` — `shouldSyncOnFocus` true when `lastMs` null, false inside 60s,
  true at exactly 60s. `settingsmodel.test.ts` — `vaultStatusLine` for each state, the conflict/malformed
  suffixes, and that `memory.vaultpath` has scope `"local"`.
- [ ] **Step 2:** `npx vitest run frontend/app/store/vaultsync.test.ts frontend/app/view/agents/settingsmodel.test.ts` — FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Rerun — PASS. Run Check.
- [ ] **Step 5:** Commit `feat(settings): vault sync remote and status in Settings > Memory; sync on focus`.

### Task 5: `pkg/effortstore` — efforts as vault files
**Depends on:** Task 2

**Files:**
- Create: `pkg/effortstore/effortstore.go`, `pkg/effortstore/migrate.go`,
  `pkg/effortstore/effortstore_test.go`, `pkg/effortstore/migrate_test.go`

**Interfaces — Consumes:** `wavevault.ParseEffort`, `MarshalEffort`, `EffortsDir` (Task 1); `wavevault.LockRoot`,
`wavevault.Poke` (Task 2); `memroots.VaultRoot()`; `wstore.DBGetAllObjsByType`, `wstore.DBDelete`.

**Interfaces — Produces (Task 6 swaps callers onto these):**
```go
func Create(ctx context.Context, e *waveobj.Effort) error
func Get(ctx context.Context, oid string) (*waveobj.Effort, error)
func GetAll(ctx context.Context) ([]*waveobj.Effort, error)
func Update(ctx context.Context, oid string, fn func(*waveobj.Effort) error) error
func Delete(ctx context.Context, oid string) error
func MigrateFromDB(ctx context.Context) (int, error)
func UseRootForTest(root string) (restore func()) // sibling-package tests point the store at a temp vault
```

**Behavior:**
- Semantics identical to `pkg/wstore/wstore_effort.go`: `Create` assigns a UUID when `OID` is empty, default
  status `active`, `Version = 1`, `CreatedTs = UpdatedTs = now`. `Update` applies `fn`, then `Version++`,
  `UpdatedTs = now`. `GetAll` sorted by `UpdatedTs` desc (stable). `Get` of a missing OID returns an error
  callers can treat as not-found the way they treat `wstore.DBMustGet`'s today — check the callers' error
  handling before choosing the message.
- Atomic writes: per-OID mutex; read, apply `fn`, write a temp file in `efforts/`, rename over. `fn` error →
  file untouched. The write+rename (and `Delete`'s remove) also holds `wavevault.LockRoot(root)`. Writes don't
  commit; each successful write calls `wavevault.Poke()`.
- Reads: `GetAll` lists `efforts/*.json`; a per-path cache keyed by mtime + size re-parses only changed
  files and drops removed ones. Callers always get an independent copy. A malformed file is skipped and logged
  in `GetAll`; `Get` returns an error naming the file.
- `MigrateFromDB`: for each `db_effort` row, write `efforts/<oid>.json` unless it exists, then `DBDelete` the
  row; returns the count migrated. Idempotent.

- [ ] **Step 1:** Tests: `TestCreateGetRoundTrip`, `TestCreateDefaults`, `TestUpdateBumpsVersionAndTs`,
  `TestUpdateFnErrorLeavesFileUntouched` (bytes on disk identical), `TestGetAllSortedByUpdatedDesc`,
  `TestGetAllRereadsChangedFile` (rewrite a file by hand with a different mtime → new value),
  `TestGetAllSkipsMalformed` (and `Get` on it errors naming the file), `TestGetReturnsIndependentCopy`,
  `TestDeleteRemovesFile`, `TestConcurrentUpdatesSameOID` (N goroutines each append a note → all N present),
  `TestWritesPokeSync` (drain with `wavevault.PokedForTest()` first; after a `Create`, `Update` and `Delete`
  each, `PokedForTest()` is true). `migrate_test.go`: `TestMigrateFromDB` (rows → files, rows deleted, existing file not
  overwritten, second run migrates 0) — use the wstore test DB setup the existing `wstore_effort_test.go` uses.
- [ ] **Step 2:** `go test ./pkg/effortstore -run 'Test'` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun — PASS.
- [ ] **Step 5:** Commit `feat(effortstore): efforts as JSON files in the vault`.

### Task 6: Move every effort caller onto `effortstore`
**Depends on:** Task 3, Task 5

**Files:**
- Modify: `pkg/jarvis/effortops.go`, `pkg/jarvisstate/effortlink.go`, `pkg/jarvisstate/fetch.go`,
  `pkg/jarvisstate/jarvisstate.go` (if it touches the store), `pkg/orchestrate/verify.go`,
  `pkg/wshrpc/wshserver/wshserver_effort.go` (including the `wstore.DBDelete` → `effortstore.Delete`),
  `pkg/wshrpc/wshserver/wshserver_dag.go`, `pkg/wshrpc/wshserver/wshserver_runs.go`,
  `cmd/server/main-server.go` (call `effortstore.MigrateFromDB` after `wstore.InitWStore`; log the count and
  any error, non-fatal)
- Delete: `pkg/wstore/wstore_effort.go`, `pkg/wstore/wstore_effort_test.go` (its cases are covered by Task 5)
- Modify tests that seed efforts through `wstore` (`grep -rn "wstore\.\(CreateEffort\|GetEffort\|GetAllEfforts\|UpdateEffort\)" pkg cmd`): change their setup only — `effortstore.UseRootForTest(t.TempDir())` plus the
  `effortstore` calls. Assertions stay unchanged.

**Interfaces — Consumes:** the Task 5 API. The RPC surface, generated bindings and frontend are unchanged.
The `effort` otype stays registered in `pkg/waveobj` and its table stays; no SQL migration.

- [ ] **Step 1:** Swap imports/calls; `grep -rn "wstore\.\(CreateEffort\|GetEffort\|GetAllEfforts\|UpdateEffort\)\|OType_Effort" pkg cmd --include=*.go`
  must show no store use outside `pkg/effortstore` and `pkg/waveobj`.
- [ ] **Step 2:** Run the existing suites against the new store:
  `go test ./pkg/wshrpc/wshserver -run 'Effort|TestDagSubmitFromPlanPath|TestDagSubmitRoundExtendsTheDag|TestDagPlanPreview'`
  (`wshserver_dagplan_test.go` seeds an effort through `wstore`), `go test ./pkg/jarvis -run 'Effort'`,
  `go test ./pkg/jarvisstate -run 'Effort|Fetch'`, `go test ./pkg/orchestrate -run 'Verify'`,
  `go test ./cmd/wsh/cmd -run 'Effort'` — PASS with assertions unchanged.
- [ ] **Step 3:** `go build ./cmd/server/... ./cmd/wsh/...` succeeds.
- [ ] **Step 4:** Commit `refactor(efforts): every reader and writer goes through effortstore; migrate db_effort at startup`.

### Task 7: Settings vault layer in `wconfig`
**Depends on:** none

**Files:**
- Create: `pkg/wconfig/vaultlayer.go`, `pkg/wconfig/vaultlayer_test.go`
- Modify: `pkg/wconfig/settingsconfig.go` (read order, `SetBaseConfigValue` routing, any other writer of
  `settings.json`), `pkg/wconfig/filewatcher.go` (watch `<vault>/config/`, re-target on vault-path change),
  `pkg/memroots/memroots.go` (`VaultRoot` delegates). Not `cmd/server/main-server.go`: Task 8 wires the
  migration call, so parallel tasks never share that file.

**Interfaces — Produces:**
- `func IsMachineLocalKey(key string) bool` over the one named set in Global Constraints.
- `func VaultRoot() string` — resolved from defaults + local `settings.json` only (`memory:vaultpath`, else
  `jarvis:vaultpath`, else `~/.waveterm/vault`, with `~` expanded). One unexported resolver used both here and
  inside `ReadFullConfig` before the vault layer is read. `memroots.VaultRoot()` returns `wconfig.VaultRoot()`;
  the default-path constant moves to wconfig.
- `const VaultConfigDir = "config"` and `func VaultSettingsPath() string` (`<vault>/config/settings.json`).
- `var OnVaultLayerWrite func()` — called (if non-nil) after every successful vault-layer write. Task 8 sets it.
- `func MigrateSettingsToVault() error` — once: local keys that are not machine-local move into the vault
  layer; when both define a key the vault-layer value wins; moved keys are removed from the local file.

**Behavior:**
- Settings read order: defaults → vault layer (machine-local keys stripped) → local `settings.json` (wins).
  Only the `settings` config part gains the layer; other parts are unchanged.
- `SetBaseConfigValue`: per key, a machine-local key or a key the local file already defines → local file;
  otherwise → vault layer. `nil` deletes the key from whichever file holds it. Both files written atomically
  under `configWriteLock`; the vault `config/` dir is created on first write.
- Watcher: also watches `<vault>/config/` (created if missing); a reload whose resolved vault root changed
  removes the old watch and adds the new one. A change there reloads exactly as a local edit does.

- [ ] **Step 1:** Tests (temp config dir + temp vault via the existing wconfig test seams):
  `TestSettingsLayerOrder` (default < vault < local), `TestVaultLayerIgnoresMachineLocalKeys`,
  `TestSetBaseConfigValueRoutesMachineLocalToLocal`, `TestSetBaseConfigValueRoutesLocallyDefinedKeyToLocal`,
  `TestSetBaseConfigValueRoutesOtherKeysToVault` (and calls `OnVaultLayerWrite`),
  `TestSetBaseConfigValueDeleteFromEitherFile`, `TestMigrateSettingsToVault` (moves portable keys, keeps
  machine-local, vault wins on clash, second run is a no-op), `TestVaultRootIgnoresVaultLayer` (a
  `memory:vaultpath` in the vault layer has no effect), `TestWatcherRetargetsOnVaultPathChange`. In
  `pkg/memroots`: `TestVaultRootDelegatesToWconfig`.
- [ ] **Step 2:** `go test ./pkg/wconfig -run 'TestSettingsLayer|TestVaultLayer|TestSetBaseConfigValue|TestMigrateSettings|TestVaultRoot|TestWatcherRetargets'` and `go test ./pkg/memroots -run 'TestVaultRoot'` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun — PASS; `go test ./pkg/wconfig -run 'TestSettingsKeysInSync|TestNewWatcherReturnsConstructionError'`
  still passes.
- [ ] **Step 5:** Commit `feat(config): settings vault layer with machine-local keys`.

### Task 8: Jarvis profile in the vault; startup wiring for the settings layer
**Depends on:** Task 6, Task 7

**Files:**
- Modify: `pkg/jarvis/profile.go`, `cmd/server/main-server.go`, `pkg/wavevault/settingsmerge.go` (constant
  only)
- Test: `pkg/jarvis/profile_test.go` (append; don't overwrite existing cases)

**Interfaces — Consumes:** `memroots.VaultRoot()`, `wconfig.VaultConfigDir`, `wconfig.SettingsFile`,
`wconfig.OnVaultLayerWrite`, `wconfig.MigrateSettingsToVault` (Task 7); `wavevault.Poke`,
`wavevault.PokedForTest`, `wavevault.SettingsSyncPath` (Tasks 1–2).

**Behavior:**
- `LoadGlobalProfile` / `SaveGlobalProfile` change their path only, to
  `<vault>/config/jarvis-profile.json` (creating `config/` on save). `SaveGlobalProfile` calls
  `wavevault.Poke()` after a successful write.
- `func MigrateGlobalProfile() error`: if the config-dir `jarvis-profile.json` exists and the vault has none,
  move it into the vault; if both exist, leave both and log once.
- `main-server.go`: call `wconfig.MigrateSettingsToVault()` before the config watcher's first read
  (`InitWatcher`), and `jarvis.MigrateGlobalProfile()` at startup (both non-fatal, logged); set
  `wconfig.OnVaultLayerWrite = wavevault.Poke`.
- Single source for the vault settings path: `wavevault.SettingsSyncPath` becomes
  `path.Join(wconfig.VaultConfigDir, wconfig.SettingsFile)` (wavevault already reaches wconfig through
  memroots, so no cycle).
- Update the `SetGlobalProfileCommand` comment in `pkg/wshrpc/wshrpctypes_jarvis.go` if it names the old
  location, then `task generate`.

- [ ] **Step 1:** Tests: `TestProfileLivesInVault` (save then load round-trips via the vault path; nothing
  written to the config dir), `TestSaveGlobalProfilePokesSync` (`wavevault.PokedForTest()` true after a
  save), `TestMigrateGlobalProfileMovesLocal`, `TestMigrateGlobalProfileKeepsBoth`,
  `TestMigrateGlobalProfileNoop`.
- [ ] **Step 2:** `go test ./pkg/jarvis -run 'TestProfileLivesInVault|TestSaveGlobalProfilePokesSync|TestMigrateGlobalProfile'` — FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Rerun — PASS; `go test ./pkg/jarvis -run 'Profile'` (existing profile tests) and
  `go test ./pkg/wavevault -run 'TestMergeSettings|TestSyncFirstJoinMergesSettingsKeys'` PASS;
  `go build ./cmd/server/...` succeeds.
- [ ] **Step 5:** Commit `feat(jarvis): global profile lives in the vault and syncs`.
