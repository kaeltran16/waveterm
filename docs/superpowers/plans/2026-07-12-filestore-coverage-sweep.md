# Filestore Coverage Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unit tests that cover the reasonably-testable uncovered branches in `pkg/filestore/blockstore_cache.go`, `blockstore_dbops.go`, and `blockstore_dbsetup.go`, without chasing failure-injection or defensive-panic paths.

**Architecture:** All new tests go into a single new file `pkg/filestore/blockstore_coverage_test.go` (Go package `filestore`), reusing the existing helpers already defined in `blockstore_test.go` (`initDb`, `cleanupDb`, `checkFileDataAt`, `makeText`). Tests drive the public `FileStore` API where possible; a few white-box tests call unexported functions directly for branches unreachable through the public surface. Tasks are executed sequentially (each appends to the same new file), with a review gate between tasks.

**Tech Stack:** Go, `testing`, go-sqlite3 (CGO), the existing in-memory test DB harness.

## Global Constraints

- **Tests require CGO with the zig compiler.** The plain `go test` fails with `Binary was compiled with 'CGO_ENABLED=0', go-sqlite3 requires cgo to work`. Every test/coverage command in this plan MUST be run as:
  `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ ...`
- **Package is `filestore`** (white-box); new file reuses existing test helpers — do NOT redefine `initDb`/`cleanupDb`/`checkFileDataAt`/`makeText`.
- **`cleanupDb` asserts `flushErrorCount == 0` and `warningCount == 0`.** Any test that intentionally provokes a flush error MUST reset `flushErrorCount.Store(0)` via a `defer` registered *after* the `defer cleanupDb(t)` line (defers run LIFO, so the reset runs first).
- **Do not hand-edit generated files** and do not touch the three source files — this is a test-only change.
- Copyright header on the new file (match existing test file):
  ```go
  // Copyright 2025, Command Line Inc.
  // SPDX-License-Identifier: Apache-2.0
  ```

## Intentionally-skipped branches (documented, not failures)

These uncovered blocks are deliberately out of scope (failure-injection, defensive, or integration-only). Do not add tests for them:
- `blockstore_cache.go` `dump()` (44-51) — debug-only helper.
- `blockstore_cache.go` DB-error paths in `loadFileForRead` (119-121), `readAt` load error (236-238), `loadDataPartsIntoCache` (280-282), `loadDataPartsForRead` DB error (298-300) — require injecting a DB failure; not worth a mock/fault harness.
- `blockstore_cache.go` `readAt` sparse-hole `partDataEntry == nil` (248-250) — not reachable via the public API (WriteAt forbids gaps; AppendData is contiguous).
- `blockstore_dbops.go` `dbWriteCacheEntry` panic on `partIdx` mismatch (110-111) — defensive panic on impossible internal state.
- `blockstore_dbsetup.go` `InitFilestore` error/flusher branches (38-47), `MakeDB` real-file/open-error (64-71) — failure injection / integration / goroutine.

---

## Task 1: Read-path coverage

Covers `blockstore_cache.go` `readAt` branches (negative offset, non-existent file, past-EOF clamp, circular read-before-window) and `loadDataPartsForRead` empty-part early return. Creates the new test file.

**Files:**
- Create: `pkg/filestore/blockstore_coverage_test.go`

**Interfaces:**
- Consumes (from existing `blockstore_test.go`, same package): `initDb(t *testing.T)`, `cleanupDb(t *testing.T)`, `checkFileDataAt(t, ctx, zoneId, name, offset, data)`, `makeText(n int) string`.
- Consumes (from source): `WFS.MakeFile`, `WFS.WriteFile`, `WFS.ReadAt`, `WFS.ReadFile` (all in `blockstore.go`).
- Produces: test functions `TestReadNegativeOffset`, `TestReadNonExistentFile`, `TestReadPastEOF`, `TestReadZeroBytes`, `TestCircularReadBeforeData`.

- [ ] **Step 1: Write the new file with the read-path tests**

Create `pkg/filestore/blockstore_coverage_test.go`:

```go
// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package filestore

import (
	"context"
	"errors"
	"io/fs"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestReadNegativeOffset(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneId, "f", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("make file: %v", err)
	}
	if _, _, err := WFS.ReadAt(ctx, zoneId, "f", -1, 5); err == nil {
		t.Fatalf("expected error for negative offset")
	}
}

func TestReadNonExistentFile(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	_, _, err := WFS.ReadFile(ctx, zoneId, "nope")
	if err == nil || !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected ErrNotExist, got %v", err)
	}
}

func TestReadPastEOF(t *testing.T) {
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneId, "f", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("make file: %v", err)
	}
	if err := WFS.WriteFile(ctx, zoneId, "f", []byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	off, data, err := WFS.ReadAt(ctx, zoneId, "f", 0, 100)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if off != 0 || string(data) != "hello" {
		t.Fatalf("expected clamped read \"hello\" at 0, got %q at %d", string(data), off)
	}
}

func TestReadZeroBytes(t *testing.T) {
	// covers loadDataPartsForRead early-return on an empty part list
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneId, "f", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("make file: %v", err)
	}
	if err := WFS.WriteFile(ctx, zoneId, "f", []byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, data, err := WFS.ReadAt(ctx, zoneId, "f", 0, 0)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(data) != 0 {
		t.Fatalf("expected empty read, got %q", string(data))
	}
}

func TestCircularReadBeforeData(t *testing.T) {
	// covers readAt's circular branch where the requested range is entirely
	// before the surviving window (size <= 0 after truncation)
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneId, "c", nil, wshrpc.FileOpts{Circular: true, MaxSize: 50}); err != nil {
		t.Fatalf("make file: %v", err)
	}
	// 55 bytes into a 50-byte circular window: DataStartIdx == 5
	if err := WFS.WriteFile(ctx, zoneId, "c", []byte(makeText(55))); err != nil {
		t.Fatalf("write: %v", err)
	}
	off, data, err := WFS.ReadAt(ctx, zoneId, "c", 0, 3)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if off != 5 || len(data) != 0 {
		t.Fatalf("expected empty read at adjusted offset 5, got %q at %d", string(data), off)
	}
}
```

- [ ] **Step 2: Run the read-path tests and confirm they pass**

Run:
```bash
CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ -count=1 \
  -run 'TestReadNegativeOffset|TestReadNonExistentFile|TestReadPastEOF|TestReadZeroBytes|TestCircularReadBeforeData' -v
```
Expected: all 5 tests PASS, `ok  github.com/wavetermdev/waveterm/pkg/filestore`.

- [ ] **Step 3: Confirm coverage of the target `readAt` / `loadDataPartsForRead` blocks rose**

Run:
```bash
CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ -count=1 \
  -covermode=set -coverprofile=cover.out >/dev/null 2>&1 && \
  go tool cover -func=cover.out | grep -E 'readAt|loadDataPartsForRead'
```
Expected: `readAt` rises from 84.6% toward ~92%+, `loadDataPartsForRead` from 88.9% toward ~92%+. (The two remaining `readAt` gaps — the DB load error at 236-238 and the sparse-hole at 248-250 — stay uncovered by design.)

- [ ] **Step 4: Commit**

Do NOT commit. Per project workflow, all changes are batched into a single commit at the end pending explicit approval. Leave the file staged-ready; the orchestrator handles commit approval after the final task.

---

## Task 2: Write / flush coverage

Covers `blockstore_cache.go` `writeAt` circular front-truncation, `flushToDB` (error accumulation + clear-after-3, transient ctx, nil-file no-op), and `unpinEntryAndTryDelete` nil-entry guard. The flush-error test also covers `blockstore_dbops.go` `dbWriteCacheEntry`'s not-exist guard (97-100).

**Files:**
- Modify: `pkg/filestore/blockstore_coverage_test.go` (append functions; no import changes needed — all identifiers used are already imported or are package-level: `flushErrorCount`, `WFS`, `dbDeleteFile`).

**Interfaces:**
- Consumes: `WFS.MakeFile`, `WFS.WriteFile`, `WFS.WriteAt`, `WFS.AppendData`, `WFS.FlushCache`, `WFS.getEntryAndPin`, `WFS.unpinEntryAndTryDelete`, `WFS.getCacheSize` (test helper), `(*CacheEntry).flushToDB`, `dbDeleteFile`, package var `flushErrorCount`, `checkFileDataAt`, `makeText`.
- Produces: test functions `TestCircularWriteAtFrontTruncate`, `TestFlushToDeletedFile`, `TestFlushTransientContextError`, `TestFlushNilFileNoOp`, `TestUnpinMissingEntry`.

- [ ] **Step 1: Append the write/flush tests**

Append to `pkg/filestore/blockstore_coverage_test.go`:

```go
func TestCircularWriteAtFrontTruncate(t *testing.T) {
	// covers writeAt's circular branch: a write straddling the start of the
	// surviving window keeps only its tail (front truncated, offset advanced)
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneId, "c", nil, wshrpc.FileOpts{Circular: true, MaxSize: 50}); err != nil {
		t.Fatalf("make file: %v", err)
	}
	if err := WFS.WriteFile(ctx, zoneId, "c", []byte(makeText(55))); err != nil {
		t.Fatalf("write: %v", err)
	}
	// window starts at offset 5; writing "ABCDEF" at offset 2 truncates the
	// first 3 bytes, leaving "DEF" written at offsets 5..8
	if err := WFS.WriteAt(ctx, zoneId, "c", 2, []byte("ABCDEF")); err != nil {
		t.Fatalf("writeat: %v", err)
	}
	checkFileDataAt(t, ctx, zoneId, "c", 5, "DEF")
}

func TestFlushToDeletedFile(t *testing.T) {
	// covers dbWriteCacheEntry's not-exist guard and flushToDB's error
	// accumulation + clear-after-3 behavior
	initDb(t)
	defer cleanupDb(t)
	// this test intentionally provokes flush errors; reset the counter first
	// (LIFO: this defer runs before cleanupDb's flushErrorCount assertion)
	defer flushErrorCount.Store(0)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneId, "f", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("make file: %v", err)
	}
	// dirty the cache without flushing, then delete the DB row out from under it
	if err := WFS.AppendData(ctx, zoneId, "f", []byte("hello")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := dbDeleteFile(ctx, zoneId, "f"); err != nil {
		t.Fatalf("db delete: %v", err)
	}
	// first three flushes fail but keep the entry cached
	for i := 1; i <= 3; i++ {
		if _, err := WFS.FlushCache(ctx); err == nil {
			t.Fatalf("flush %d: expected error", i)
		}
		if WFS.getCacheSize() != 1 {
			t.Fatalf("flush %d: expected entry to remain cached, size %d", i, WFS.getCacheSize())
		}
	}
	// fourth flush trips the >3 threshold and clears the entry
	if _, err := WFS.FlushCache(ctx); err == nil {
		t.Fatalf("flush 4: expected error")
	}
	if WFS.getCacheSize() != 0 {
		t.Fatalf("flush 4: expected entry cleared, size %d", WFS.getCacheSize())
	}
}

func TestFlushTransientContextError(t *testing.T) {
	// covers flushToDB's transient-error path (ctx already cancelled at flush)
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneId, "f", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("make file: %v", err)
	}
	if err := WFS.AppendData(ctx, zoneId, "f", []byte("hello")); err != nil {
		t.Fatalf("append: %v", err)
	}
	cctx, ccancel := context.WithCancel(context.Background())
	ccancel() // cancel before flushing
	if _, err := WFS.FlushCache(cctx); err == nil {
		t.Fatalf("expected context error")
	}
}

func TestFlushNilFileNoOp(t *testing.T) {
	// covers flushToDB's early-return when the entry holds no dirty file
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	entry := WFS.getEntryAndPin("z", "f")
	defer WFS.unpinEntryAndTryDelete("z", "f")
	if err := entry.flushToDB(ctx, false); err != nil {
		t.Fatalf("expected nil for empty entry, got %v", err)
	}
}

func TestUnpinMissingEntry(t *testing.T) {
	// covers unpinEntryAndTryDelete's nil-entry guard
	initDb(t)
	defer cleanupDb(t)
	WFS.unpinEntryAndTryDelete("z", "missing")
	if WFS.getCacheSize() != 0 {
		t.Fatalf("expected empty cache, size %d", WFS.getCacheSize())
	}
}
```

- [ ] **Step 2: Run the write/flush tests and confirm they pass**

Run:
```bash
CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ -count=1 \
  -run 'TestCircularWriteAtFrontTruncate|TestFlushToDeletedFile|TestFlushTransientContextError|TestFlushNilFileNoOp|TestUnpinMissingEntry' -v
```
Expected: all 5 tests PASS. In particular `TestFlushToDeletedFile` must PASS *and not* leave `cleanupDb` reporting `flush error count` — if you see `flush error count: N`, the `defer flushErrorCount.Store(0)` is missing or ordered before `defer cleanupDb`.

- [ ] **Step 3: Confirm coverage of `flushToDB` / `writeAt` / `dbWriteCacheEntry` / `unpinEntryAndTryDelete` rose**

Run:
```bash
CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ -count=1 \
  -covermode=set -coverprofile=cover.out >/dev/null 2>&1 && \
  go tool cover -func=cover.out | grep -E 'flushToDB|writeAt|dbWriteCacheEntry|unpinEntryAndTryDelete'
```
Expected: `flushToDB` rises from 42.9% to 100.0%; `writeAt` from 90.3% toward ~97%+; `dbWriteCacheEntry` from 86.7% toward ~93% (the panic at 110-111 stays uncovered by design); `unpinEntryAndTryDelete` from 87.5% to 100.0%.

- [ ] **Step 4: Commit**

Do NOT commit (batched at end pending approval).

---

## Task 3: DB-ops and dbsetup coverage

Covers `blockstore_dbops.go` `dbInsertFile` duplicate-insert guard and `dbGetFileParts` empty-part guard, plus `blockstore_dbsetup.go` `GetDBName`.

**Files:**
- Modify: `pkg/filestore/blockstore_coverage_test.go` (append functions; add `"path/filepath"` to the import block for the `GetDBName` test).

**Interfaces:**
- Consumes: `WFS.MakeFile`, `dbGetFileParts`, `GetDBName`, const `FilestoreDBName`, `errors`, `io/fs`, `path/filepath`.
- Produces: test functions `TestDuplicateCreate`, `TestGetFilePartsEmpty`, `TestGetDBName`.

- [ ] **Step 1: Add the `path/filepath` import**

Edit the import block at the top of `pkg/filestore/blockstore_coverage_test.go` to add `"path/filepath"`. Final import block:

```go
import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)
```

- [ ] **Step 2: Append the db-ops / dbsetup tests**

Append to `pkg/filestore/blockstore_coverage_test.go`:

```go
func TestDuplicateCreate(t *testing.T) {
	// covers dbInsertFile's ErrExist guard: with no intervening read the cache
	// entry is empty, so the second MakeFile reaches dbInsertFile and it reports
	// the existing row
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	zoneId := uuid.NewString()
	if err := WFS.MakeFile(ctx, zoneId, "f", nil, wshrpc.FileOpts{}); err != nil {
		t.Fatalf("make file: %v", err)
	}
	err := WFS.MakeFile(ctx, zoneId, "f", nil, wshrpc.FileOpts{})
	if err == nil || !errors.Is(err, fs.ErrExist) {
		t.Fatalf("expected ErrExist, got %v", err)
	}
}

func TestGetFilePartsEmpty(t *testing.T) {
	// covers dbGetFileParts' empty-part-list guard
	initDb(t)
	defer cleanupDb(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	parts, err := dbGetFileParts(ctx, "z", "f", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if parts != nil {
		t.Fatalf("expected nil map, got %v", parts)
	}
}

func TestGetDBName(t *testing.T) {
	// smoke: GetDBName builds a path ending in the filestore db filename
	name := GetDBName()
	if name == "" {
		t.Fatalf("expected non-empty db name")
	}
	if filepath.Base(name) != FilestoreDBName {
		t.Fatalf("expected base %q, got %q", FilestoreDBName, filepath.Base(name))
	}
}
```

- [ ] **Step 3: Run the db-ops / dbsetup tests and confirm they pass**

Run:
```bash
CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ -count=1 \
  -run 'TestDuplicateCreate|TestGetFilePartsEmpty|TestGetDBName' -v
```
Expected: all 3 tests PASS.

- [ ] **Step 4: Confirm coverage of `dbInsertFile` / `dbGetFileParts` / `GetDBName` rose**

Run:
```bash
CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ -count=1 \
  -covermode=set -coverprofile=cover.out >/dev/null 2>&1 && \
  go tool cover -func=cover.out | grep -E 'dbInsertFile|dbGetFileParts|GetDBName'
```
Expected: `dbInsertFile` from 85.7% to 100.0%; `dbGetFileParts` from 92.9% to 100.0%; `GetDBName` from 0.0% to 100.0%.

- [ ] **Step 5: Commit**

Do NOT commit (batched at end pending approval).

---

## Task 4: Whole-suite verification

Confirm the full filestore suite passes and the three target files' coverage improved, with no regressions.

**Files:** none (verification only).

- [ ] **Step 1: Run the entire filestore suite**

Run:
```bash
CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ -count=1 -v 2>&1 | tail -40
```
Expected: `PASS` / `ok  github.com/wavetermdev/waveterm/pkg/filestore`, every test (pre-existing + 13 new) passing, no `warning count` / `flush error count` failures.

- [ ] **Step 2: Print per-function coverage for the three target files**

Run:
```bash
CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/filestore/ -count=1 \
  -covermode=set -coverprofile=cover.out >/dev/null 2>&1 && \
  go tool cover -func=cover.out | grep -E 'blockstore_cache.go|blockstore_dbops.go|blockstore_dbsetup.go'
```
Expected improvements vs. baseline:
- `flushToDB` 42.9% -> 100.0%
- `unpinEntryAndTryDelete` 87.5% -> 100.0%
- `dbInsertFile` 85.7% -> 100.0%
- `dbGetFileParts` 92.9% -> 100.0%
- `GetDBName` 0.0% -> 100.0%
- `writeAt` 90.3% -> ~97%+
- `readAt` 84.6% -> ~92%+
- `dbWriteCacheEntry` 86.7% -> ~93% (panic line intentionally uncovered)
- `loadDataPartsForRead` 88.9% -> ~92%+
Remaining uncovered lines match only the documented "Intentionally-skipped branches" list.

- [ ] **Step 3: Clean up the coverage artifact**

Run:
```bash
rm -f cover.out
```
(`cover.out` is a scratch file and must not be committed.)

- [ ] **Step 4: Report readiness for commit**

Report the final test count and coverage deltas to the orchestrator. Do NOT commit; the orchestrator presents the diff for approval per the strict git workflow, then makes a single commit such as:
`test(filestore): cover blockstore cache/dbops/dbsetup edge branches`

---

## Self-Review

**Spec coverage** — every listed uncovered block maps to a task:
- readAt neg-offset/non-exist/past-EOF/circular-before-window, loadDataPartsForRead empty -> Task 1.
- writeAt circular front-truncation, flushToDB (error-accum/transient/nil), unpin nil, dbWriteCacheEntry not-exist -> Task 2.
- dbInsertFile duplicate, dbGetFileParts empty, GetDBName -> Task 3.
- Skipped branches explicitly enumerated and justified.

**Placeholder scan** — no TBD/TODO; every code step contains complete, runnable test code and exact commands with expected output.

**Type consistency** — helper names (`initDb`, `cleanupDb`, `checkFileDataAt`, `makeText`, `getCacheSize`) and source symbols (`flushToDB`, `dbDeleteFile`, `dbGetFileParts`, `dbInsertFile`, `GetDBName`, `FilestoreDBName`, `flushErrorCount`) verified against the actual source. Import block is additive across tasks (`path/filepath` added in Task 3) so each task compiles standalone.
