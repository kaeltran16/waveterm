# Jarvis S2 — Semantic Consumers (L3 + L4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up S1's embedding index in the two v1 engines — semantic recall (L3, `pkg/jarvisrecall`) and semantic attribution (L4, `pkg/jarvisattrib`) — as additive, gracefully-degrading extensions.

**Architecture:** L3 adds a semantic candidate source to recall's deterministic seed selection; it appends up to `kSem` index-query node ids to the seeds that feed `Expand`, degrading to L1/L2 when embeddings are off. L4 adds a low-confidence, probation-gated *semantic* edge producer that fires inside `EdgesFor` only for dossiers with zero deterministic (L1–3) edges: it window-pre-filters candidate runs, embeds their objectives (cached), and proposes an `informing` edge on cosine ≥ threshold — reusing D's accept/detach/backfill machinery unchanged. Both consume a small additive extension of `pkg/jarvisembed` (a public `Embed`, a keyed `EmbedCached` cache, and `Cosine`).

**Tech Stack:** Go; `mattn/go-sqlite3` + `asg017/sqlite-vec-go-bindings/cgo` (CGO, zig toolchain for the wavesrv build); `pkg/wavevault` (git-backed vault), `pkg/wstore` (waveobj/SQLite), `pkg/jarvisdossier`.

## Global Constraints

- **Copyright header** on every new `.go` file (first two lines):
  `// Copyright 2026, Command Line Inc.` / `// SPDX-License-Identifier: Apache-2.0`
- **No hand-editing generated files.** S2 touches no generated file (no `task generate`, no RPC/WaveObj/migration/frontend).
- **Graceful degradation is mandatory.** Flag off / no key / provider error → L3 seeds and L4 edges are byte-for-byte the v1 result; the embedder is never called. Never surface an embedding failure as a user-facing error.
- **The model never searches.** L3 only widens the deterministic seed set; synthesis is unchanged.
- **CGO build wiring (load-bearing).** Any build/test that compiles `pkg/jarvisembed` — after this plan that includes `pkg/jarvisrecall` and `pkg/jarvisattrib` — needs `CGO_CFLAGS="-O2 -g -I<repo-root>/pkg/jarvisembed/csrc"` (`-O2` preserved: without it zig's Debug default turns on UBSan for `sqlite-vec.c` and the link fails). **Standard test invocation used throughout this plan** (run from repo root in the Bash tool):
  ```bash
  CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test <pkg> <flags>
  ```
- **Git (STRICT, per project rule): do NOT commit without explicit user approval, and batch all S2 work into ONE commit at the end.** Each task below ends with running its package tests green (the deliverable gate), not a `git commit`. The single feature commit — folding this plan, the S2 spec, and the `docs/deferred.md` edits — is Task 7, gated on the user's go-ahead. Do not add a co-author.
- **PLACEHOLDER tunables** (`kSem`, `semCandidateN`, `semThreshold`, `weightLayer4`): fabricated defaults, recorded in `docs/deferred.md` (Task 7), to be calibrated against a populated, embedded vault.

**Dependencies:** Task 2 → Task 3 (jarvisembed primitives before caching). Tasks 4, 6, 7 depend on Tasks 2+3. Task 6 depends on Task 5. Execute in order (1→7).

---

### Task 1: Thread the sqlite-vec `CGO_CFLAGS` into the Taskfile

**Files:**
- Modify: `Taskfile.yml:213` (the `build:server:internal` `cmd`)

**Interfaces:**
- Consumes: nothing.
- Produces: a `wavesrv` build that links sqlite-vec, so Tasks 4/6 (which make `wavesrv` consumers import `jarvisembed`) build. No Go symbols.

**Why:** No `wavesrv` consumer imports `jarvisembed` today, so the Taskfile never set `CGO_CFLAGS`. Once L3/L4 land, `cmd/server` links `sqlite-vec.c`; without the vendored-header include on the global `CGO_CFLAGS`, the build fails to find `sqlite3.h`. All platforms funnel through `build:server:internal`, so one edit covers Linux/macOS/Windows.

- [ ] **Step 1: Add `CGO_CFLAGS` to the internal server build command**

In `Taskfile.yml`, the `build:server:internal` task's `cmd` currently begins:

```yaml
    build:server:internal:
        requires:
            vars:
                - ARCHS
        cmd:
            cmd: CGO_ENABLED=1 GOARCH={{.GOARCH}} {{.GO_ENV_VARS}} go build -tags "osusergo,sqlite_omit_load_extension" -ldflags "{{.GO_LDFLAGS}} -X main.BuildTime=$({{.DATE}} +'%Y%m%d%H%M') -X main.WaveVersion={{.VERSION}}" -o dist/bin/wavesrv.{{if eq .GOARCH "amd64"}}x64{{else}}{{.GOARCH}}{{end}}{{exeExt}} cmd/server/main-server.go
```

Insert `CGO_CFLAGS` immediately after `CGO_ENABLED=1` (Task provides `{{.ROOT_DIR}}` = the Taskfile's directory):

```yaml
    build:server:internal:
        requires:
            vars:
                - ARCHS
        cmd:
            cmd: CGO_ENABLED=1 CGO_CFLAGS="-O2 -g -I{{.ROOT_DIR}}/pkg/jarvisembed/csrc" GOARCH={{.GOARCH}} {{.GO_ENV_VARS}} go build -tags "osusergo,sqlite_omit_load_extension" -ldflags "{{.GO_LDFLAGS}} -X main.BuildTime=$({{.DATE}} +'%Y%m%d%H%M') -X main.WaveVersion={{.VERSION}}" -o dist/bin/wavesrv.{{if eq .GOARCH "amd64"}}x64{{else}}{{.GOARCH}}{{end}}{{exeExt}} cmd/server/main-server.go
```

- [ ] **Step 2: Verify the standard test env compiles `jarvisembed` today**

Run (repo root, Bash tool):

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go build -tags "osusergo,sqlite_omit_load_extension" ./pkg/jarvisembed/
```

Expected: exits 0, no output. (Proves the flag string + vendored header resolve on the local toolchain. `task build:backend` gets its full link verification in Task 7, once a consumer exists.)

- [ ] **Step 3: Confirm the existing jarvisembed tests pass under the env prefix**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisembed/
```

Expected: `ok  github.com/wavetermdev/waveterm/pkg/jarvisembed`.

---

### Task 2: jarvisembed — expose `Embed` + add `Cosine` and `decodeVec`

**Files:**
- Modify: `pkg/jarvisembed/index.go` (add `Embed` method)
- Modify: `pkg/jarvisembed/reconcile.go` (add `decodeVec` beside `encodeVec`; add `Cosine`)
- Test: `pkg/jarvisembed/embed_test.go` (extend — add the two tests below)

**Interfaces:**
- Consumes: `(*Index).Available()`, `ix.emb` (private `Embedder`), `ErrEmbeddingsDisabled`, `encodeVec` (all existing).
- Produces:
  - `func (ix *Index) Embed(ctx context.Context, texts []string) ([][]float32, error)`
  - `func Cosine(a, b []float32) float32`
  - `func decodeVec(b []byte) []float32` (package-private; inverse of `encodeVec`)

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvisembed/embed_test.go`:

```go
func TestEmbedPublicDegradesWhenUnavailable(t *testing.T) {
	ix := newTestIndex(t, nil) // nil embedder => unavailable
	if _, err := ix.Embed(context.Background(), []string{"x"}); !errors.Is(err, ErrEmbeddingsDisabled) {
		t.Fatalf("Embed err = %v, want ErrEmbeddingsDisabled", err)
	}
}

func TestEmbedPublicReturnsVectors(t *testing.T) {
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})
	vecs, err := ix.Embed(context.Background(), []string{"alpha thing"})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	if len(vecs) != 1 || len(vecs[0]) != 3 || vecs[0][0] != 1 {
		t.Fatalf("unexpected vectors: %+v", vecs)
	}
}

func TestCosine(t *testing.T) {
	same := Cosine([]float32{1, 0, 0}, []float32{1, 0, 0})
	if same < 0.999 {
		t.Fatalf("identical vectors cosine = %v, want ~1", same)
	}
	orth := Cosine([]float32{1, 0, 0}, []float32{0, 1, 0})
	if orth > 0.001 {
		t.Fatalf("orthogonal vectors cosine = %v, want ~0", orth)
	}
	if Cosine([]float32{1, 0}, []float32{1, 0, 0}) != 0 {
		t.Fatal("mismatched lengths should be 0")
	}
}
```

(`errors` and `context` are already imported in `embed_test.go` via the existing `index_test.go`/package tests; if `embed_test.go` lacks them, add `"context"` and `"errors"` to its import block.)

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisembed/ -run 'TestEmbedPublic|TestCosine' -v
```

Expected: FAIL — `ix.Embed` undefined and `Cosine` undefined (compile error).

- [ ] **Step 3: Add the `Embed` method**

In `pkg/jarvisembed/index.go`, after the `Query` method (or near `Available`), add:

```go
// Embed exposes the configured embedder for consumers (S2) that need raw
// vectors outside the vault chunk index. Unavailable => ErrEmbeddingsDisabled.
func (ix *Index) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if !ix.Available() {
		return nil, ErrEmbeddingsDisabled
	}
	return ix.emb.Embed(ctx, texts)
}
```

- [ ] **Step 4: Add `decodeVec` and `Cosine`**

In `pkg/jarvisembed/reconcile.go`, below `encodeVec`, add:

```go
// decodeVec is the inverse of encodeVec: little-endian float32 bytes -> vector.
func decodeVec(b []byte) []float32 {
	out := make([]float32, len(b)/4)
	for i := range out {
		bits := uint32(b[i*4]) | uint32(b[i*4+1])<<8 | uint32(b[i*4+2])<<16 | uint32(b[i*4+3])<<24
		out[i] = math.Float32frombits(bits)
	}
	return out
}

// Cosine is the cosine similarity of two equal-length vectors (0 on length
// mismatch or a zero vector). Higher = more similar.
func Cosine(a, b []float32) float32 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return float32(dot / (math.Sqrt(na) * math.Sqrt(nb)))
}
```

(`math` is already imported in `reconcile.go`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisembed/ -run 'TestEmbedPublic|TestCosine' -v
```

Expected: PASS (all three).

- [ ] **Step 6: Run the full package tests (deliverable gate)**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisembed/
```

Expected: `ok  github.com/wavetermdev/waveterm/pkg/jarvisembed`.

---

### Task 3: jarvisembed — keyed embedding cache (`attrib_vectors` + `EmbedCached`)

**Files:**
- Modify: `pkg/jarvisembed/index.go` (add `attrib_vectors` to `ensureBaseSchema`; add `EmbedCached`)
- Modify: `pkg/jarvisembed/reconcile.go` (add `delete from attrib_vectors` to `wipe`)
- Test: `pkg/jarvisembed/cache_test.go` (new)

**Interfaces:**
- Consumes: `ix.db`, `ix.emb`, `ix.Available()`, `encodeVec`, `decodeVec`, `ErrEmbeddingsDisabled` (from Task 2).
- Produces:
  - `func (ix *Index) EmbedCached(ctx context.Context, key, contentHash, text string) ([]float32, error)` — returns the cached vector when a row for `key` matches `contentHash` **and** the current model; otherwise embeds `text`, stores, returns. Unavailable => `ErrEmbeddingsDisabled`.
  - table `attrib_vectors(key TEXT PRIMARY KEY, content_hash TEXT, model TEXT, vec BLOB)`.

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvisembed/cache_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"errors"
	"testing"
)

func TestEmbedCachedHitAndMiss(t *testing.T) {
	fe := &fakeEmbedder{dims: 3}
	ix := newTestIndex(t, fe)
	ctx := context.Background()

	v1, err := ix.EmbedCached(ctx, "run:r1", "hash-a", "alpha work")
	if err != nil {
		t.Fatalf("first EmbedCached: %v", err)
	}
	if len(v1) != 3 || v1[0] != 1 {
		t.Fatalf("unexpected vector: %+v", v1)
	}
	after := fe.calls

	// Same key + same content hash => cache hit, no new embed call.
	v2, err := ix.EmbedCached(ctx, "run:r1", "hash-a", "alpha work")
	if err != nil {
		t.Fatalf("second EmbedCached: %v", err)
	}
	if fe.calls != after {
		t.Fatalf("cache miss on identical call: calls went %d -> %d", after, fe.calls)
	}
	if v2[0] != v1[0] {
		t.Fatalf("cached vector differs: %+v vs %+v", v2, v1)
	}

	// Changed content hash => re-embed.
	if _, err := ix.EmbedCached(ctx, "run:r1", "hash-b", "beta work"); err != nil {
		t.Fatalf("third EmbedCached: %v", err)
	}
	if fe.calls != after+1 {
		t.Fatalf("changed content hash did not re-embed: calls=%d", fe.calls)
	}
}

func TestEmbedCachedModelChangeReembeds(t *testing.T) {
	fe := &fakeEmbedder{dims: 3}
	ix := newTestIndex(t, fe)
	ctx := context.Background()
	if _, err := ix.EmbedCached(ctx, "run:r1", "hash-a", "alpha"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = fe.calls
	// Swap the model tag: same key+hash, but the stored vector is now stale-space. The re-embed runs
	// on the NEW embedder (renamedFakeEmbedder), so we assert via the row's updated model tag rather
	// than fe.calls (a separate instance).
	ix.emb = &renamedFakeEmbedder{fakeEmbedder{dims: 3}}
	if _, err := ix.EmbedCached(ctx, "run:r1", "hash-a", "alpha"); err != nil {
		t.Fatalf("post-model-change: %v", err)
	}
	var model string
	if err := ix.db.QueryRow(`select model from attrib_vectors where key='run:r1'`).Scan(&model); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if model != "other-model" {
		t.Fatalf("model tag not updated after re-embed: %q", model)
	}
}

func TestEmbedCachedDisabled(t *testing.T) {
	ix := newTestIndex(t, nil)
	if _, err := ix.EmbedCached(context.Background(), "k", "h", "t"); !errors.Is(err, ErrEmbeddingsDisabled) {
		t.Fatalf("EmbedCached err = %v, want ErrEmbeddingsDisabled", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisembed/ -run TestEmbedCached -v
```

Expected: FAIL — `EmbedCached` undefined (compile error).

- [ ] **Step 3: Add the `attrib_vectors` table to the schema**

In `pkg/jarvisembed/index.go`, in `ensureBaseSchema`, extend the SQL block to also create the cache table:

```go
func (ix *Index) ensureBaseSchema(ctx context.Context) error {
	_, err := ix.db.ExecContext(ctx, `
create table if not exists meta (model text, dims integer);
create table if not exists chunks (
	rowid integer primary key,
	node_id text not null,
	collection text not null,
	section_idx integer not null,
	section_heading text,
	section_text text,
	content_hash text not null
);
create index if not exists chunks_node on chunks(node_id);
create table if not exists attrib_vectors (
	key text primary key,
	content_hash text not null,
	model text not null,
	vec blob not null
);
`)
	return err
}
```

- [ ] **Step 4: Add `EmbedCached`**

In `pkg/jarvisembed/index.go`, add (needs `database/sql` and `errors`, already imported):

```go
// EmbedCached returns the vector for text, cached by key. A stored row is reused
// only when its content_hash and model both match the current embedder; otherwise
// the text is (re-)embedded and the row replaced. This lets S2 embed a run/dossier
// fingerprint once, not per read. Unavailable => ErrEmbeddingsDisabled.
func (ix *Index) EmbedCached(ctx context.Context, key, contentHash, text string) ([]float32, error) {
	if !ix.Available() {
		return nil, ErrEmbeddingsDisabled
	}
	var blob []byte
	var storedHash, storedModel string
	err := ix.db.QueryRowContext(ctx, `select vec, content_hash, model from attrib_vectors where key = ?`, key).
		Scan(&blob, &storedHash, &storedModel)
	switch {
	case err == nil && storedHash == contentHash && storedModel == ix.emb.Model():
		return decodeVec(blob), nil
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return nil, err
	}
	vecs, err := ix.emb.Embed(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 {
		return nil, nil
	}
	if _, err := ix.db.ExecContext(ctx,
		`insert or replace into attrib_vectors(key, content_hash, model, vec) values (?,?,?,?)`,
		key, contentHash, ix.emb.Model(), encodeVec(vecs[0])); err != nil {
		return nil, err
	}
	return vecs[0], nil
}
```

- [ ] **Step 5: Clear the cache on a model-change rebuild**

In `pkg/jarvisembed/reconcile.go`, in `wipe`, add `delete from attrib_vectors` to the statement list so a model change rebuilds the whole derived layer, not just the chunk index:

```go
func (ix *Index) wipe(ctx context.Context) error {
	for _, stmt := range []string{`drop table if exists vec_chunks`, `delete from chunks`, `delete from meta`, `delete from attrib_vectors`} {
		if _, err := ix.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}
```

(Correctness does not depend on this — `EmbedCached`'s per-row model check already re-embeds after a model change — but it prevents stale-model rows accumulating across model switches.)

- [ ] **Step 6: Run the tests to verify they pass**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisembed/ -run TestEmbedCached -v
```

Expected: PASS (all three).

- [ ] **Step 7: Run the full package tests (deliverable gate)**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisembed/
```

Expected: `ok  github.com/wavetermdev/waveterm/pkg/jarvisembed`.

---

### Task 4: L3 — semantic recall in `selectSeeds`

**Files:**
- Modify: `pkg/jarvisrecall/retrieve.go` (widen `selectSeeds`; add `openIndex` seam + `SetOpenIndexForTest` + `semanticSeeds` + `kSem`; append L3 seeds)
- Modify: `pkg/jarvisrecall/recall.go` (thread `v` into `assembleSlice`)
- Test: `pkg/jarvisrecall/retrieve_semantic_test.go` (new)

**Interfaces:**
- Consumes: `jarvisembed.OpenIndex` / `(*Index).Query` / `(*Index).Available` / `(*Index).Close` (Tasks 2–3 present but `Query` is S1); `wavevault.AllScope`, `wavevault.Vault`, `wavevault.Retriever`.
- Produces:
  - `selectSeeds(ctx context.Context, v *wavevault.Vault, r *wavevault.Retriever, q string) ([]string, error)` (widened signature).
  - `var openIndex = jarvisembed.OpenIndex` + `func SetOpenIndexForTest(fn func(context.Context) (*jarvisembed.Index, error)) func(context.Context) (*jarvisembed.Index, error)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisrecall/retrieve_semantic_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// semFake maps text containing "solar" or "renewable" to one basis vector, and
// "budget" to another, so a paraphrase with no keyword overlap still matches.
type semFake struct{ dims int }

func (f *semFake) Model() string { return "sem-fake" }
func (f *semFake) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, tx := range texts {
		v := make([]float32, f.dims)
		low := strings.ToLower(tx)
		switch {
		case strings.Contains(low, "solar") || strings.Contains(low, "renewable"):
			v[0] = 1
		case strings.Contains(low, "budget"):
			v[1] = 1
		default:
			v[2] = 1
		}
		out[i] = v
	}
	return out, nil
}

func semVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	write := func(rel, content string) {
		p := filepath.Join(v.Root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("memory/solar.md", "---\nid: solar\n---\n## S\nsolar panel deployment\n")
	write("memory/budget.md", "---\nid: budget\n---\n## B\nquarterly budget review\n")
	return v
}

func injectIndex(t *testing.T, emb jarvisembed.Embedder) {
	t.Helper()
	restore := SetOpenIndexForTest(func(ctx context.Context) (*jarvisembed.Index, error) {
		return jarvisembed.OpenIndexAtForTest(ctx, filepath.Join(t.TempDir(), "index.db"), emb)
	})
	t.Cleanup(restore)
}

func TestSelectSeedsSemanticSurfacesParaphrase(t *testing.T) {
	v := semVault(t)
	injectIndex(t, &semFake{dims: 3})
	r := v.Retriever(wavevault.AllScope())

	// Query shares no >=4-char keyword with "solar panel deployment", so L1/L2 find nothing;
	// only the semantic layer (both map to basis vec 0) can surface node "solar".
	seeds, err := selectSeeds(context.Background(), v, r, "renewable grid")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if !containsStr(seeds, "solar") {
		t.Fatalf("semantic seed 'solar' missing: %v", seeds)
	}
}

func TestSelectSeedsDegradesWhenDisabled(t *testing.T) {
	v := semVault(t)
	// Unavailable index (nil embedder): L3 contributes nothing.
	injectIndex(t, nil)
	r := v.Retriever(wavevault.AllScope())
	seeds, err := selectSeeds(context.Background(), v, r, "renewable grid")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if containsStr(seeds, "solar") {
		t.Fatalf("semantic seed leaked with embeddings off: %v", seeds)
	}
}

func containsStr(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisrecall/ -run TestSelectSeeds -v
```

Expected: FAIL — `SetOpenIndexForTest` undefined and `selectSeeds` arity mismatch (compile error).

- [ ] **Step 3: Add the `openIndex` seam, `semanticSeeds`, and `kSem`**

In `pkg/jarvisrecall/retrieve.go`, add `"context"` and `"github.com/wavetermdev/waveterm/pkg/jarvisembed"` to the import block, and add near the top (after the existing const block):

```go
// kSem bounds how many semantic candidates L3 contributes (PLACEHOLDER — tune
// against a populated vault; see docs/deferred.md).
const kSem = 6

// openIndex is a seam so tests inject a temp index + mock embedder.
var openIndex = jarvisembed.OpenIndex

// SetOpenIndexForTest swaps the index opener; returns the previous value for restore.
func SetOpenIndexForTest(fn func(context.Context) (*jarvisembed.Index, error)) func(context.Context) (*jarvisembed.Index, error) {
	old := openIndex
	openIndex = fn
	return old
}

// semanticSeeds returns up to kSem node ids from the embedding index (layer 3), or
// nil when embeddings are unavailable or error — L3 degrades to L1/L2. The model
// never searches; this only widens the deterministic seed set. Recall's interactive
// scope is AllScope today (see scopeToVault); the physical collection boundary is
// enforced inside Query.
func semanticSeeds(ctx context.Context, v *wavevault.Vault, q string) []string {
	ix, err := openIndex(ctx)
	if err != nil || !ix.Available() {
		return nil
	}
	defer ix.Close()
	chunks, err := ix.Query(ctx, v, q, kSem, wavevault.AllScope())
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var ids []string
	for _, c := range chunks {
		if seen[c.NodeID] {
			continue
		}
		seen[c.NodeID] = true
		ids = append(ids, c.NodeID)
	}
	return ids
}
```

- [ ] **Step 4: Widen `selectSeeds` and append the L3 seeds**

In `pkg/jarvisrecall/retrieve.go`, change the `selectSeeds` signature and append semantic seeds after the deterministic top-k is computed. Replace the final `ids` assembly at the end of `selectSeeds`:

Current tail:
```go
	ids := make([]string, len(hits))
	for i, h := range hits {
		ids[i] = h.id
	}
	return ids, nil
}
```

Change the function signature line from:
```go
func selectSeeds(r *wavevault.Retriever, q string) ([]string, error) {
```
to:
```go
func selectSeeds(ctx context.Context, v *wavevault.Vault, r *wavevault.Retriever, q string) ([]string, error) {
```

and replace the tail with:
```go
	ids := make([]string, 0, len(hits)+kSem)
	have := map[string]bool{}
	for _, h := range hits {
		ids = append(ids, h.id)
		have[h.id] = true
	}
	// layer 3: append semantic seeds (deduped), bounding the widen at kSem. Because
	// ScoredChunk carries no timestamp, semantic hits are appended after the recency-
	// ranked deterministic top-k rather than interleaved by recency.
	for _, id := range semanticSeeds(ctx, v, q) {
		if have[id] {
			continue
		}
		have[id] = true
		ids = append(ids, id)
	}
	return ids, nil
}
```

- [ ] **Step 5: Thread `v` through the caller**

In `pkg/jarvisrecall/recall.go`, `assembleSlice` currently calls `selectSeeds(r, query)` and is called by `retrieve`. Update both:

In `assembleSlice`, change its signature from:
```go
func assembleSlice(ctx context.Context, r *wavevault.Retriever, scope ScopeArgs, query string) ([]candidate, error) {
```
to:
```go
func assembleSlice(ctx context.Context, v *wavevault.Vault, r *wavevault.Retriever, scope ScopeArgs, query string) ([]candidate, error) {
```
and change its `selectSeeds` call from:
```go
	seeds, err := selectSeeds(r, query)
```
to:
```go
	seeds, err := selectSeeds(ctx, v, r, query)
```

In `retrieve`, change the `assembleSlice` call from:
```go
	slice, err := assembleSlice(ctx, r, scope, query)
```
to:
```go
	slice, err := assembleSlice(ctx, v, r, scope, query)
```

- [ ] **Step 6: Run the test to verify it passes**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisrecall/ -run TestSelectSeeds -v
```

Expected: PASS (both).

- [ ] **Step 7: Run the full package tests (deliverable gate)**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisrecall/
```

Expected: `ok  github.com/wavetermdev/waveterm/pkg/jarvisrecall`.

---

### Task 5: L4 groundwork — layer-4 constants + shared ticket-contradiction helper

**Files:**
- Modify: `pkg/jarvisattrib/edges.go` (add `weightLayer4`, `provSemantic`; layer-4 case in `confidenceFor` and `provenanceFor`)
- Modify: `pkg/jarvisattrib/extract.go` (extract `contradictsTicket`; refactor `extractLayer3` to use it)
- Test: `pkg/jarvisattrib/semantic_test.go` (new — the layer-4 constant/helper units; the full producer is Task 6, same file)

**Interfaces:**
- Consumes: `ticketRe` (existing, `extract.go`), `weightLayer1..3`, `bucketWeakMax`, `Bucket`, `confidenceFor`, `provenanceFor`, `provStructural` (existing, `edges.go`).
- Produces:
  - `const weightLayer4 = 0.2`, `const provSemantic = "semantic"`.
  - `func contradictsTicket(dossierTicket string, commitSubjects []string) bool`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisattrib/semantic_test.go`:

```go
// pkg/jarvisattrib/semantic_test.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import "testing"

func TestLayer4ConfidenceAndBucket(t *testing.T) {
	if got := confidenceFor([]int{4}); got != weightLayer4 {
		t.Fatalf("confidenceFor([4]) = %v, want %v", got, weightLayer4)
	}
	if got := Bucket(weightLayer4); got != "weak" {
		t.Fatalf("Bucket(weightLayer4) = %q, want weak", got)
	}
	if got := provenanceFor([]int{4}); got != provSemantic {
		t.Fatalf("provenanceFor([4]) = %q, want %q", got, provSemantic)
	}
}

func TestContradictsTicket(t *testing.T) {
	if !contradictsTicket("PROJ-1", []string{"fix PROJ-2 crash"}) {
		t.Fatal("a different concrete ticket should contradict")
	}
	if contradictsTicket("PROJ-1", []string{"work on PROJ-1", "more PROJ-1"}) {
		t.Fatal("the same ticket should not contradict")
	}
	if contradictsTicket("PROJ-1", []string{"no ticket here"}) {
		t.Fatal("no ticket token should not contradict")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ -run 'TestLayer4|TestContradictsTicket' -v
```

Expected: FAIL — `weightLayer4`, `provSemantic`, `contradictsTicket` undefined (compile error).

- [ ] **Step 3: Add the layer-4 constants and switch cases**

In `pkg/jarvisattrib/edges.go`, add to the layer-weight const block:

```go
	weightLayer4 = 0.2 // semantic similarity — below bucketWeakMax, always renders "weak"
```

and to the provenance const block:

```go
	provSemantic = "semantic"
```

In `confidenceFor`, add a case to the switch:

```go
		case 4:
			w = weightLayer4
```

In `provenanceFor`, make layer 3 explicit and route layer 4 to semantic — change:

```go
	switch min {
	case 1:
		return provDispatch
	case 2:
		return provTicket
	default:
		return provStructural
	}
```
to:
```go
	switch min {
	case 1:
		return provDispatch
	case 2:
		return provTicket
	case 3:
		return provStructural
	default:
		return provSemantic
	}
```

- [ ] **Step 4: Extract `contradictsTicket` and refactor `extractLayer3`**

In `pkg/jarvisattrib/extract.go`, add the helper (near `ticketRe`):

```go
// contradictsTicket reports whether any ticket-shaped token in the commit subjects is a concrete
// ticket other than the dossier's — a signal the work belongs elsewhere. Shared by layer-3 structural
// self-correction and layer-4 semantic proposal.
func contradictsTicket(dossierTicket string, commitSubjects []string) bool {
	for _, s := range commitSubjects {
		for _, m := range ticketRe.FindAllString(s, -1) {
			if !strings.EqualFold(m, dossierTicket) {
				return true
			}
		}
	}
	return false
}
```

Then in `extractLayer3`, replace the inline self-correction loop:

```go
	// self-correction: any ticket-shaped token in the commits that is not this dossier's ticket contradicts.
	for _, s := range commitSubjects {
		for _, m := range ticketRe.FindAllString(s, -1) {
			if !strings.EqualFold(m, d.Ticket) {
				return AttributedEdge{}, false
			}
		}
	}
```
with:
```go
	// self-correction: a concrete different ticket in the commits contradicts.
	if contradictsTicket(d.Ticket, commitSubjects) {
		return AttributedEdge{}, false
	}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ -run 'TestLayer4|TestContradictsTicket' -v
```

Expected: PASS (both).

- [ ] **Step 6: Run the full package tests (deliverable gate — confirms the extractLayer3 refactor is behavior-preserving)**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/
```

Expected: `ok  github.com/wavetermdev/waveterm/pkg/jarvisattrib` (all existing layer-3 tests still pass).

---

### Task 6: L4 — the semantic edge producer (`proposeSemanticEdges`)

**Files:**
- Modify: `pkg/jarvisattrib/semantic.go` (new — created in Task 5 as the test file's sibling; add production code here)
- Test: `pkg/jarvisattrib/semantic_test.go` (extend with the producer unit tests)

**Interfaces:**
- Consumes: `jarvisembed.OpenIndex`, `(*Index).Available`, `(*Index).EmbedCached` (Task 3), `(*Index).Close`, `jarvisembed.Cosine` (Task 2); `windowsOverlap`, `contradictsTicket` (Task 5), `edgeLookups`, `AttributedEdge`, `StateInforming`, `weightLayer4`, `provSemantic`; `jarvisdossier.Dossier{ID,Objective,Acceptance,Ticket,Hash}`; `waveobj.Run{OID,Goal,CreatedTs}`.
- Produces:
  - `func proposeSemanticEdges(ctx context.Context, d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, now int64) []AttributedEdge`
  - `var openIndex = jarvisembed.OpenIndex` + `SetOpenIndexForTest` (jarvisattrib's own seam — distinct package from jarvisrecall's).
  - helpers: `dossierFingerprint`, `runFingerprint`, `candidateRuns`, `hashText`, and consts `semCandidateN`, `semThreshold`.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvisattrib/semantic_test.go` (add imports `context`, `github.com/wavetermdev/waveterm/pkg/jarvisdossier`, `github.com/wavetermdev/waveterm/pkg/jarvisembed`, `github.com/wavetermdev/waveterm/pkg/waveobj`, `path/filepath`, `strings`):

```go
// attribFake maps text containing "oauth" to one basis vector, "billing" to another.
type attribFake struct{ dims, calls int }

func (f *attribFake) Model() string { return "attrib-fake" }
func (f *attribFake) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	f.calls += len(texts)
	out := make([][]float32, len(texts))
	for i, tx := range texts {
		v := make([]float32, f.dims)
		low := strings.ToLower(tx)
		switch {
		case strings.Contains(low, "oauth"):
			v[0] = 1
		case strings.Contains(low, "billing"):
			v[1] = 1
		default:
			v[2] = 1
		}
		out[i] = v
	}
	return out, nil
}

func injectAttribIndex(t *testing.T, emb jarvisembed.Embedder) {
	t.Helper()
	restore := SetOpenIndexForTest(func(ctx context.Context) (*jarvisembed.Index, error) {
		return jarvisembed.OpenIndexAtForTest(ctx, filepath.Join(t.TempDir(), "index.db"), emb)
	})
	t.Cleanup(restore)
}

func noCommits() edgeLookups {
	return edgeLookups{channelName: func(string) string { return "" }, commits: func(*waveobj.Run) []string { return nil }}
}

func TestProposeSemanticEdgesMatch(t *testing.T) {
	const now = int64(1_000_000_000_000)
	injectAttribIndex(t, &attribFake{dims: 3})
	d := &jarvisdossier.Dossier{ID: "task-1", Objective: "oauth pkce flow", Status: "active", Created: now - 9000, Hash: "h1"}
	runs := []*waveobj.Run{
		{OID: "r1", Goal: "implement oauth login", CreatedTs: now - 5000},   // matches
		{OID: "r2", Goal: "billing dashboard", CreatedTs: now - 5000},       // distractor
	}
	edges := proposeSemanticEdges(context.Background(), d, runs, noCommits(), now)
	if len(edges) != 1 || edges[0].RunORef != "run:r1" {
		t.Fatalf("want one semantic edge to run:r1, got %+v", edges)
	}
	e := edges[0]
	if e.State != StateInforming || e.Provenance != provSemantic || e.Confidence != weightLayer4 || !containsLayer(e.Layers, 4) {
		t.Fatalf("unexpected edge shape: %+v", e)
	}
}

func TestProposeSemanticEdgesContradictingTicketSkips(t *testing.T) {
	const now = int64(1_000_000_000_000)
	injectAttribIndex(t, &attribFake{dims: 3})
	d := &jarvisdossier.Dossier{ID: "task-1", Ticket: "PROJ-1", Objective: "oauth pkce", Status: "active", Created: now - 9000, Hash: "h1"}
	runs := []*waveobj.Run{{OID: "r1", Goal: "oauth login", CreatedTs: now - 5000}}
	lk := edgeLookups{channelName: func(string) string { return "" }, commits: func(*waveobj.Run) []string { return []string{"fix PROJ-2 bug"} }}
	if edges := proposeSemanticEdges(context.Background(), d, runs, lk, now); len(edges) != 0 {
		t.Fatalf("contradicting ticket should suppress, got %+v", edges)
	}
}

func TestProposeSemanticEdgesDisabled(t *testing.T) {
	const now = int64(1_000_000_000_000)
	injectAttribIndex(t, nil) // unavailable index
	d := &jarvisdossier.Dossier{ID: "task-1", Objective: "oauth", Status: "active", Created: now - 9000, Hash: "h1"}
	runs := []*waveobj.Run{{OID: "r1", Goal: "oauth login", CreatedTs: now - 5000}}
	if edges := proposeSemanticEdges(context.Background(), d, runs, noCommits(), now); edges != nil {
		t.Fatalf("disabled embeddings should yield nil, got %+v", edges)
	}
}

func TestCandidateRunsWindowAndCap(t *testing.T) {
	const now = int64(1_000_000_000_000)
	d := &jarvisdossier.Dossier{ID: "task-1", Status: "active", Created: now - 10_000}
	runs := []*waveobj.Run{
		{OID: "in", Goal: "x", CreatedTs: now - 5000},                 // overlaps
		{OID: "old", Goal: "y", CreatedTs: now - 100, CompletedTs: d_before(now)}, // outside window
	}
	got := candidateRuns(d, runs, now, 10)
	if len(got) != 1 || got[0].OID != "in" {
		t.Fatalf("want only the overlapping run, got %+v", got)
	}
}

// d_before returns a completion timestamp before the dossier's created window so the run cannot overlap.
func d_before(now int64) int64 { return now - 20_000 }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ -run 'TestPropose|TestCandidateRuns' -v
```

Expected: FAIL — `proposeSemanticEdges`, `candidateRuns`, `SetOpenIndexForTest` undefined (compile error).

- [ ] **Step 3: Create `pkg/jarvisattrib/semantic.go`**

```go
// pkg/jarvisattrib/semantic.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Semantic-layer (L4) tuning — PLACEHOLDER, calibrate against a populated vault (see docs/deferred.md).
const (
	semCandidateN = 20   // most-recent window-overlapping runs considered per orphan dossier
	semThreshold  = 0.75 // cosine floor to propose a semantic edge
)

// openIndex is a seam so tests inject a temp index + mock embedder.
var openIndex = jarvisembed.OpenIndex

// SetOpenIndexForTest swaps the index opener; returns the previous value for restore.
func SetOpenIndexForTest(fn func(context.Context) (*jarvisembed.Index, error)) func(context.Context) (*jarvisembed.Index, error) {
	old := openIndex
	openIndex = fn
	return old
}

// proposeSemanticEdges is L4: for an under-attributed dossier it embeds the dossier fingerprint and each
// window-overlapping candidate run's fingerprint (cached), and proposes a low-confidence informing edge
// wherever cosine >= semThreshold. It reuses layer-3's ticket self-correction. Returns nil (never an error)
// when embeddings are unavailable — the caller degrades to the deterministic edge set.
func proposeSemanticEdges(ctx context.Context, d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, now int64) []AttributedEdge {
	ix, err := openIndex(ctx)
	if err != nil || !ix.Available() {
		return nil
	}
	defer ix.Close()

	dossierVec, err := ix.EmbedCached(ctx, "dossier:"+d.ID, d.Hash, dossierFingerprint(d))
	if err != nil || len(dossierVec) == 0 {
		return nil
	}

	var out []AttributedEdge
	for _, r := range candidateRuns(d, runs, now, semCandidateN) {
		subs := lk.commits(r)
		if contradictsTicket(d.Ticket, subs) {
			continue
		}
		text := runFingerprint(r, subs)
		runVec, err := ix.EmbedCached(ctx, "run:"+r.OID, hashText(text), text)
		if err != nil || len(runVec) == 0 {
			continue
		}
		if jarvisembed.Cosine(dossierVec, runVec) < semThreshold {
			continue
		}
		out = append(out, AttributedEdge{
			DossierID:  d.ID,
			RunORef:    "run:" + r.OID,
			Layers:     []int{4},
			Provenance: provSemantic,
			Confidence: weightLayer4,
			State:      StateInforming,
		})
	}
	return out
}

// dossierFingerprint is the semantic text for a dossier: objective + acceptance criteria.
func dossierFingerprint(d *jarvisdossier.Dossier) string {
	parts := append([]string{d.Objective}, d.Acceptance...)
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// runFingerprint is the semantic text for a run: its goal + commit subjects.
func runFingerprint(r *waveobj.Run, commitSubjects []string) string {
	return strings.TrimSpace(r.Goal + "\n" + strings.Join(commitSubjects, "\n"))
}

// hashText is the cache invalidation key for a fingerprint (a Run has no vault ContentHash).
func hashText(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// candidateRuns keeps window-overlapping runs, most-recent first, capped at n. This is the deterministic
// "never compares against every run" pre-filter, before any embedding.
func candidateRuns(d *jarvisdossier.Dossier, runs []*waveobj.Run, now int64, n int) []*waveobj.Run {
	var cands []*waveobj.Run
	for _, r := range runs {
		if windowsOverlap(d, r, now) {
			cands = append(cands, r)
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].CreatedTs > cands[j].CreatedTs })
	if len(cands) > n {
		cands = cands[:n]
	}
	return cands
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ -run 'TestPropose|TestCandidateRuns' -v
```

Expected: PASS (all four).

- [ ] **Step 5: Run the full package tests (deliverable gate)**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/
```

Expected: `ok  github.com/wavetermdev/waveterm/pkg/jarvisattrib`.

---

### Task 7: L4 wiring into `EdgesFor` + docs + integration + final verification + commit

**Files:**
- Modify: `pkg/jarvisattrib/lifecycle.go` (orphan-gated semantic pass in `EdgesFor`)
- Modify: `docs/deferred.md` (S2 entry + PLACEHOLDER tunables)
- Test: `pkg/jarvisattrib/semantic_test.go` (extend with the `EdgesFor` integration tests)

**Interfaces:**
- Consumes: `proposeSemanticEdges` (Task 6), `assembleEdges`, `applyOverrides`, `readOverrides`, `gatherLookups`, `loadDossier`, `nowFn` (existing).
- Produces: `EdgesFor` now returns semantic edges when (and only when) a dossier has zero deterministic edges and embeddings are on. Read contract shape unchanged.

- [ ] **Step 1: Write the failing integration tests**

Append to `pkg/jarvisattrib/semantic_test.go` (uses `wstore` + `jarvisdossier` + `testVault`, matching `edgesfor_test.go`; add imports `github.com/wavetermdev/waveterm/pkg/wstore` if not present):

```go
func TestEdgesForSemanticOnOrphan(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)
	fe := &attribFake{dims: 3}
	injectAttribIndex(t, fe)

	runID := "cccccccc-0000-0000-0000-000000000001"
	// No ticket, no channel match, not in an anchor repo of any ref -> L1-3 all silent (orphan dossier).
	run := &waveobj.Run{OID: runID, ID: runID, Goal: "implement oauth login", ProjectPath: "/repo/x",
		Status: "done", CreatedTs: nowFn() - 5000, CompletedTs: nowFn() - 1000, Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() { _ = wstore.DBDelete(ctx, waveobj.OType_Run, runID) })

	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Objective: "oauth pkce flow"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}

	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	got := findEdge(edges, "run:"+runID)
	if got == nil || got.State != StateInforming || got.Provenance != provSemantic {
		t.Fatalf("expected an informing semantic edge, got %+v (all=%+v)", got, edges)
	}

	// Cache: a second EdgesFor re-embeds zero runs (dossier + run fingerprints already cached).
	before := fe.calls
	if _, err := EdgesFor(ctx, v, id); err != nil {
		t.Fatalf("EdgesFor 2: %v", err)
	}
	if fe.calls != before {
		t.Fatalf("second EdgesFor re-embedded %d texts, want 0 (cache)", fe.calls-before)
	}

	// Detach suppresses the semantic edge durably.
	if err := Detach(ctx, v, id, "run:"+runID); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	edges, _ = EdgesFor(ctx, v, id)
	if findEdge(edges, "run:"+runID) != nil {
		t.Fatalf("detached semantic edge still present: %+v", edges)
	}
}

func TestEdgesForNoSemanticWhenAttributed(t *testing.T) {
	ctx := context.Background()
	v := testVault(t)
	fe := &attribFake{dims: 3}
	injectAttribIndex(t, fe)

	runID := "dddddddd-0000-0000-0000-000000000001"
	run := &waveobj.Run{OID: runID, ID: runID, Goal: "PROJ-9 oauth", ProjectPath: "/repo/x",
		Status: "done", CreatedTs: nowFn() - 5000, CompletedTs: nowFn() - 1000, Meta: make(waveobj.MetaMapType)}
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() { _ = wstore.DBDelete(ctx, waveobj.OType_Run, runID) })

	// Ticket in dossier + Goal -> a deterministic layer-2 edge exists, so semantic must not run.
	id, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Ticket: "PROJ-9", Objective: "oauth"})
	if err != nil {
		t.Fatalf("CreateDossier: %v", err)
	}
	before := fe.calls
	edges, err := EdgesFor(ctx, v, id)
	if err != nil {
		t.Fatalf("EdgesFor: %v", err)
	}
	if fe.calls != before {
		t.Fatalf("semantic pass ran on an attributed dossier (embedded %d texts)", fe.calls-before)
	}
	got := findEdge(edges, "run:"+runID)
	if got == nil || got.Provenance == provSemantic {
		t.Fatalf("expected a deterministic (non-semantic) edge, got %+v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ -run TestEdgesForSemantic -v
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ -run TestEdgesForNoSemantic -v
```

Expected: FAIL — `EdgesFor` does not yet call the semantic pass (orphan produces no edge; the attributed-dossier test may pass vacuously but the orphan test fails).

- [ ] **Step 3: Wire the orphan-gated semantic pass into `EdgesFor`**

In `pkg/jarvisattrib/lifecycle.go`, replace the `EdgesFor` body's final `return`:

Current:
```go
func EdgesFor(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, error) {
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return nil, err
	}
	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return nil, err
	}
	ov, err := readOverrides(v)
	if err != nil {
		return nil, err
	}
	return applyOverrides(assembleEdges(d, runs, lk, nowFn()), ov), nil
}
```

New:
```go
func EdgesFor(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, error) {
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return nil, err
	}
	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return nil, err
	}
	ov, err := readOverrides(v)
	if err != nil {
		return nil, err
	}
	now := nowFn()
	det := applyOverrides(assembleEdges(d, runs, lk, now), ov)
	if len(det) > 0 {
		return det, nil // deterministic attribution present; L4 runs only when L1-3 are silent
	}
	// Orphan dossier: propose semantic (L4) edges. Degrades to det (empty) when embeddings are off.
	// Re-apply overrides so a previously-detached semantic edge stays suppressed.
	return applyOverrides(proposeSemanticEdges(ctx, d, runs, lk, now), ov), nil
}
```

- [ ] **Step 4: Run the integration tests to verify they pass**

Run:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ -run TestEdgesFor -v
```

Expected: PASS — `TestEdgesForSemanticOnOrphan`, `TestEdgesForNoSemanticWhenAttributed`, and the pre-existing `TestEdgesForEndToEnd`.

- [ ] **Step 5: Record the S2 deferrals + PLACEHOLDER tunables**

At the **top** of `docs/deferred.md` (new entries go at the top), insert:

```markdown
## Jarvis S2 — semantic consumers L3 + L4 (2026-07-24)

Shipped L3 (semantic recall in `pkg/jarvisrecall`) and L4 (semantic attribution in `pkg/jarvisattrib`) over
S1's index, plus a keyed embedding cache in `pkg/jarvisembed` (`attrib_vectors` + `EmbedCached` + `Cosine` +
public `Embed`). Both degrade to the v1 result when embeddings are off.

Deferred:
- Semantic seed recency-ranking: L3 appends semantic seeds after the deterministic top-k (ScoredChunk has no
  timestamp to interleave by). A reserved semantic sub-budget / recency-aware merge is deferred pending
  evidence that the append order matters.
- L4 gating loosening: semantic fires only when a dossier has zero deterministic (L1-3) edges. Per-run silence
  (propose for individual unattributed runs on an otherwise-attributed dossier) is deferred pending evidence.
- Reranking / hybrid score-fusion, proactive resurfacing (S3), auto-hardening a semantic edge — out of S2.

PLACEHOLDER tuning (calibrate against a populated, embedded vault):
- `kSem = 6` (semantic seed candidates, `pkg/jarvisrecall/retrieve.go`).
- `semCandidateN = 20` (window-overlapping runs considered per orphan dossier, `pkg/jarvisattrib/semantic.go`).
- `semThreshold = 0.75` (cosine floor to propose a semantic edge).
- `weightLayer4 = 0.2` (semantic edge confidence; below `bucketWeakMax` so it renders "weak").
```

- [ ] **Step 6: Full S2 test sweep + backend build verification**

Run the three packages together, then confirm the wavesrv backend links sqlite-vec now that consumers import it:

```bash
CGO_CFLAGS="-O2 -g -I$PWD/pkg/jarvisembed/csrc" go test ./pkg/jarvisembed/ ./pkg/jarvisrecall/ ./pkg/jarvisattrib/
```

Expected: `ok` for all three.

```bash
task build:backend
```

Expected: builds `dist/bin/wavesrv.*` + `wsh` with exit 0 (this is the real end-to-end proof the Task 1 Taskfile `CGO_CFLAGS` wiring links sqlite-vec into `wavesrv` via the new `jarvisrecall`/`jarvisattrib` importers). First build is slow (C compile), then cached.

- [ ] **Step 7: Typecheck is unaffected (no FE/generated changes) — sanity only**

S2 touches no TypeScript or generated file. No `task generate`, no `task check:ts` needed. Confirm `git status` shows only the intended Go files, `Taskfile.yml`, `docs/deferred.md`, the S2 spec, and this plan.

- [ ] **Step 8: Commit (GATED — get the user's explicit go-ahead first)**

Per the project git rule, ask the user to approve the commit, then batch all S2 work into one feature commit (spec + plan fold in; no separate docs commit; no co-author). Stage only S2 files:

```bash
git add \
  pkg/jarvisembed/index.go pkg/jarvisembed/reconcile.go pkg/jarvisembed/embed_test.go pkg/jarvisembed/cache_test.go \
  pkg/jarvisrecall/retrieve.go pkg/jarvisrecall/recall.go pkg/jarvisrecall/retrieve_semantic_test.go \
  pkg/jarvisattrib/edges.go pkg/jarvisattrib/extract.go pkg/jarvisattrib/lifecycle.go pkg/jarvisattrib/semantic.go pkg/jarvisattrib/semantic_test.go \
  Taskfile.yml docs/deferred.md \
  docs/superpowers/specs/2026-07-24-jarvis-s2-semantic-consumers-design.md \
  docs/superpowers/plans/2026-07-24-jarvis-s2-semantic-consumers.md
git commit -m "feat(jarvis): S2 semantic consumers — L3 recall + L4 attribution (v2)"
```

Also at commit time, update the v2 meta-spec tracking table (`docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md`) S2 row with the spec/plan links + a Built summary, and `git add` it into the same commit (the A–F/S1 precedent: the shared meta-spec file is edited only at feature-commit time).

---

## Self-Review

**1. Spec coverage** (checked each S2 spec section against a task):
- §1 L3 recall (semantic pass in `selectSeeds`, degrade, signature thread) → Task 4. ✓
- §2 L4 attribution (orphan gate, window pre-filter, fingerprints, cosine, self-correction, reuse of accept/detach/backfill/harden) → Tasks 5 (consts + `contradictsTicket`), 6 (producer), 7 (`EdgesFor` gate + override re-apply, Detach test). ✓
- §3 jarvisembed additions (`Embed`, `EmbedCached` + `attrib_vectors`, `Cosine`) → Tasks 2, 3. ✓
- §4 degradation contract → Task 4 (`TestSelectSeedsDegradesWhenDisabled`), Task 6 (`TestProposeSemanticEdgesDisabled`), Task 7 (attributed-dossier no-embed). ✓
- Build wiring (S1 tracking note / `docs/deferred.md`) → Task 1 + the standard env prefix. ✓
- Testing section (L3 paraphrase/degrade/merge; L4 orphan/gate/self-correction/pre-filter/cache/degrade/override; jarvisembed hit-miss/model-change/cosine) → Tasks 2–7 map every listed case. ✓
- Docs (`docs/deferred.md` tunables; meta-spec table at commit time) → Task 7. ✓

**2. Placeholder scan:** No "TBD/TODO/implement later"; every code step shows complete code; every test step shows the assertions. PLACEHOLDER appears only as the deliberate tunable marker recorded in `docs/deferred.md`. ✓

**3. Type consistency:** `EmbedCached(ctx, key, contentHash, text)` defined in Task 3, consumed identically in Task 6. `Cosine(a, b)` (Task 2) consumed in Task 6. `proposeSemanticEdges(ctx, d, runs, lk, now)` (Task 6) consumed in Task 7. `selectSeeds(ctx, v, r, q)` (Task 4) consumed by `assembleSlice` (Task 4). `contradictsTicket(dossierTicket, commitSubjects)` (Task 5) consumed in Task 6 and `extractLayer3` (Task 5). `weightLayer4`/`provSemantic` (Task 5) consumed in Task 6. Two distinct `openIndex` seams — one per package (`jarvisrecall`, `jarvisattrib`) — no cross-package name clash. ✓
