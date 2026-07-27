# Jarvis S1 — Embedding Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the opt-in, BYOK embedding foundation (`pkg/jarvisembed`) — a provider seam, a sqlite-vec derived-layer index with hybrid (lazy + warm) reconciliation, section-level chunking, and a graceful-degradation contract — with no consumer wiring.

**Architecture:** A new backend Go package `pkg/jarvisembed`. An `Embedder` interface (one OpenAI-compatible HTTP impl) turns text into vectors; a dedicated sqlite-vec SQLite DB outside the vault stores section-level chunks keyed by node content-hash; `Reconcile` re-embeds only changed nodes (lazy at query, or warm at a commit boundary — same method); `Query` runs a scope-filtered cosine KNN. Off by default (v2 == v1); enabled only when the user sets config + a `secretstore` key.

**Tech Stack:** Go, `mattn/go-sqlite3` (CGO) + `github.com/asg017/sqlite-vec-go-bindings/cgo` (static-linked via `sqlite_vec.Auto()`), `pkg/wavevault` (A, built), `pkg/wconfig`, `pkg/secretstore`, `net/http` (no new HTTP dep). Go `testing` with a temp index DB + a fixture vault (`wavevault.OpenVaultAtForTest`) + a mock `Embedder`.

## Global Constraints

- **Opt-in, strictly additive.** Off by default. With the flag off, no network, no DB file work, no behavior change (v2 invariant 10). No consumer is wired in S1.
- **BYOK; Wave ships no credentials.** `base URL`/`model` in `wconfig`; API key in `secretstore` (`jarvis:embedapikey`), never in config (v2 invariant 12).
- **Graceful degradation is typed, not an error.** Disabled/misconfigured → `ErrEmbeddingsDisabled`; a provider failure surfaces an error the caller treats as degraded-this-call. Never panic/crash (v2 invariant 11).
- **Index is a rebuildable derived artifact.** Dedicated SQLite DB at `<WAVETERM_DATA_HOME>/jarvis/index.db`, **outside the vault**, never committed. Deleting it and re-reconciling reproduces it (v1 invariant 3).
- **Embed only at explicit boundaries.** Reconciliation runs only from a `Query` (lazy) or an explicit `Reconcile` (warm). No background poll/watcher (v1 invariant 1).
- **Scope boundary is physical.** A `WorkerScope` query can never return a `tasks/` chunk (v1 invariant 4).
- **Section-level chunks** (split by `##`), frontmatter carried as metadata (invariant 7 grounding precision).
- **CGO builds use zig** (`Taskfile.yml` `build:backend`); the sqlite-vec link is verified in Task 1 before anything else is built.
- **Never hand-edit generated files.** `pkg/wconfig/metaconsts.go` and TS settings types are generated — edit the `SettingsType` source struct then run `task generate`.
- **tsc gotcha:** typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Baseline is clean.
- **Git workflow (user override of per-task commits):** batch into ONE `feat(jarvis)` commit at the end (Task 8), pending explicit approval — matching the A–F sub-project precedent. Tasks 1–7 end at a green-test **checkpoint**, not a commit. Do not commit without approval.

---

## File Structure

- `pkg/jarvisembed/embed.go` — `Embedder` interface, `openAICompatEmbedder`, config/key resolution, `Available`, `SetEmbedderForTest`.
- `pkg/jarvisembed/chunk.go` — section splitting + frontmatter-as-metadata embed-text assembly.
- `pkg/jarvisembed/index.go` — `OpenIndex`/`OpenIndexAtForTest`, DB open + schema + `sqlite_vec.Auto()`, `ScoredChunk`, `ErrEmbeddingsDisabled`, `Query`, `Close`.
- `pkg/jarvisembed/reconcile.go` — `Reconcile`, `ReconcileStats`.
- `pkg/jarvisembed/{spike,embed,chunk,index,reconcile}_test.go`, `maintest_test.go` — tests.
- `pkg/wconfig/settingsconfig.go` — three additive `jarvis:embed*` fields (then `task generate`).
- `go.mod` / `go.sum` — add `github.com/asg017/sqlite-vec-go-bindings/cgo`.
- `docs/deferred.md` — S1 deferrals + PLACEHOLDER tuning.

---

## Task 1: sqlite-vec build spike (the gate)

Prove sqlite-vec compiles + statically links under Wave's CGO build and that a filtered KNN round-trips **before** building the package on it.

**Files:**
- Create: `pkg/jarvisembed/spike_test.go`
- Modify: `go.mod`, `go.sum`

**Interfaces:**
- Consumes: `github.com/asg017/sqlite-vec-go-bindings/cgo` (`sqlite_vec.Auto()`), `github.com/mattn/go-sqlite3` (driver), `database/sql`.
- Produces: nothing importable — this task's deliverable is proof the dependency links and the `MATCH … k … collection IN` query shape works. If it fails, STOP and switch to the cosine-scan fallback (see task-end note) before Task 5.

- [ ] **Step 1: Add the dependency**

Run:
```bash
go get github.com/asg017/sqlite-vec-go-bindings/cgo@latest
```
Expected: `go.mod`/`go.sum` gain the module.

- [ ] **Step 2: Write the spike test**

Create `pkg/jarvisembed/spike_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"database/sql"
	"testing"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	_ "github.com/mattn/go-sqlite3"
)

// TestSqliteVecSpike is the build/link gate: it fails to COMPILE if sqlite-vec
// cannot statically link under the CGO/zig build, and fails at RUNTIME if the
// vec0 MATCH + k + metadata-filter query shape is unsupported by the pinned
// version. Task 7's Query rests on exactly this shape.
func TestSqliteVecSpike(t *testing.T) {
	sqlite_vec.Auto()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`create virtual table v using vec0(embedding float[3], collection text)`); err != nil {
		t.Fatalf("create vec0: %v", err)
	}
	rows := []struct {
		id   int
		vec  string
		coll string
	}{
		{1, "[1,0,0]", "memory"},
		{2, "[0,1,0]", "tasks"},
		{3, "[0.9,0.1,0]", "memory"},
	}
	for _, r := range rows {
		if _, err := db.Exec(`insert into v(rowid, embedding, collection) values (?, ?, ?)`, r.id, r.vec, r.coll); err != nil {
			t.Fatalf("insert %d: %v", r.id, err)
		}
	}

	// KNN for [1,0,0] restricted to collection='memory' must return rowid 1 then 3, never 2.
	q := `select rowid from v where embedding match ? and k = 2 and collection in ('memory') order by distance`
	res, err := db.Query(q, "[1,0,0]")
	if err != nil {
		t.Fatalf("knn query: %v", err)
	}
	defer res.Close()
	var got []int
	for res.Next() {
		var id int
		if err := res.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, id)
	}
	if len(got) != 2 || got[0] != 1 || got[1] != 3 {
		t.Fatalf("expected [1 3], got %v (metadata-filtered KNN unsupported? use the cosine-scan fallback)", got)
	}
}
```

- [ ] **Step 3: Run the spike test**

Run: `go test ./pkg/jarvisembed/ -run TestSqliteVecSpike -v`
Expected: PASS. A compile error here = the link failed under CGO; a runtime failure on the KNN = the metadata-filter shape is unsupported.

- [ ] **Step 4: Verify it links through the real backend build**

Run: `task build:backend`
Expected: builds `wavesrv` + `wsh` with no link error (first build is slow — sqlite-vec C compiles once, then caches).

- [ ] **Step 5: Checkpoint**

Both the spike test and `task build:backend` are green. **Decision gate:** if either failed, do not proceed — record the failure and switch the index/query tasks to the fallback: store `embedding` as a BLOB column in a plain `chunks` table and rank with sqlite-vec's `vec_distance_cosine(embedding, ?)` in `ORDER BY … LIMIT k` with a `WHERE collection IN (…)` filter (a full scan; correct at v1 scale). All later task signatures stay identical.

---

## Task 2: wconfig keys + config resolution

**Files:**
- Modify: `pkg/wconfig/settingsconfig.go` (add to `SettingsType`, after the existing `jarvis:vaultpath` field)
- Create: `pkg/jarvisembed/embed.go` (config-resolution helpers only, in this task)
- Test: `pkg/jarvisembed/embed_test.go`

**Interfaces:**
- Consumes: `wconfig.GetWatcher().GetFullConfig().Settings`, `secretstore.GetSecret`.
- Produces: `func resolveConfig() (baseURL, model string, enabled bool)`, `func resolveKey() (string, bool)`, `func Available() bool`, const `secretKeyName = "jarvis:embedapikey"`.

- [ ] **Step 1: Add the settings fields**

In `pkg/wconfig/settingsconfig.go`, locate the `jarvis:vaultpath` field in `SettingsType` and add immediately after it:
```go
	JarvisEmbedEnabled bool   `json:"jarvis:embedenabled,omitempty"`
	JarvisEmbedBaseURL string `json:"jarvis:embedbaseurl,omitempty"`
	JarvisEmbedModel   string `json:"jarvis:embedmodel,omitempty"`
```

- [ ] **Step 2: Regenerate config bindings**

Run: `task generate`
Expected: `pkg/wconfig/metaconsts.go` gains `ConfigKey_JarvisEmbedEnabled = "jarvis:embedenabled"` (and the two others); TS settings types regenerate. Do not hand-edit the generated files.

- [ ] **Step 3: Verify generated + typecheck clean**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (baseline clean — the additive config keys must not break it).

- [ ] **Step 4: Write the failing test**

Create `pkg/jarvisembed/embed_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import "testing"

func TestSecretKeyNameStable(t *testing.T) {
	if secretKeyName != "jarvis:embedapikey" {
		t.Fatalf("secretKeyName = %q, want jarvis:embedapikey", secretKeyName)
	}
}
```

- [ ] **Step 5: Run test to verify it fails**

Run: `go test ./pkg/jarvisembed/ -run TestSecretKeyNameStable -v`
Expected: FAIL — `undefined: secretKeyName`.

- [ ] **Step 6: Write the config helpers**

Create `pkg/jarvisembed/embed.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisembed is the opt-in, BYOK embedding foundation for Jarvis v2:
// a provider seam, a sqlite-vec derived-layer index with hybrid reconciliation,
// section-level chunking, and a graceful-degradation contract. It has no
// consumer in S1; S2 (semantic recall/attribution) is the first.
package jarvisembed

import (
	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const secretKeyName = "jarvis:embedapikey"

// resolveConfig reads the BYOK settings. enabled is false unless the flag is on
// and both base URL and model are set.
func resolveConfig() (baseURL, model string, enabled bool) {
	s := wconfig.GetWatcher().GetFullConfig().Settings
	baseURL, model = s.JarvisEmbedBaseURL, s.JarvisEmbedModel
	enabled = s.JarvisEmbedEnabled && baseURL != "" && model != ""
	return
}

func resolveKey() (string, bool) {
	v, ok, err := secretstore.GetSecret(secretKeyName)
	if err != nil || !ok || v == "" {
		return "", false
	}
	return v, true
}

// Available reports whether embeddings are fully configured (flag on, base URL +
// model set, key present). Callers degrade gracefully when false.
func Available() bool {
	_, _, enabled := resolveConfig()
	if !enabled {
		return false
	}
	_, ok := resolveKey()
	return ok
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `go test ./pkg/jarvisembed/ -run TestSecretKeyNameStable -v`
Expected: PASS.

- [ ] **Step 8: Checkpoint**

Run: `go build ./pkg/jarvisembed/ ./pkg/wconfig/` and `go test ./pkg/jarvisembed/ -v`
Expected: build clean, all package tests pass (spike + this one).

---

## Task 3: Embedder seam + OpenAI-compatible impl

**Files:**
- Modify: `pkg/jarvisembed/embed.go`
- Test: `pkg/jarvisembed/embed_test.go`

**Interfaces:**
- Consumes: `resolveConfig`, `resolveKey` (Task 2), `net/http`, `encoding/json`.
- Produces: `type Embedder interface { Embed(ctx context.Context, texts []string) ([][]float32, error); Model() string }`, `func newConfiguredEmbedder() (Embedder, bool)`, `func SetEmbedderForTest(e Embedder) (restore func())`, `func embedderForTest() Embedder`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvisembed/embed_test.go`:
```go
import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAICompatEmbed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("auth header = %q", got)
		}
		var body struct {
			Model string   `json:"model"`
			Input []string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "test-model" {
			t.Errorf("model = %q", body.Model)
		}
		resp := map[string]any{"data": []map[string]any{}}
		for range body.Input {
			resp["data"] = append(resp["data"].([]map[string]any), map[string]any{"embedding": []float32{0.1, 0.2, 0.3}})
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	e := &openAICompatEmbedder{baseURL: srv.URL, model: "test-model", key: "test-key", hc: http.DefaultClient}
	vecs, err := e.Embed(context.Background(), []string{"a", "b"})
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	if len(vecs) != 2 || len(vecs[0]) != 3 || vecs[0][0] != 0.1 {
		t.Fatalf("unexpected vectors: %v", vecs)
	}
	if e.Model() != "test-model" {
		t.Fatalf("Model() = %q", e.Model())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisembed/ -run TestOpenAICompatEmbed -v`
Expected: FAIL — `undefined: openAICompatEmbedder`.

- [ ] **Step 3: Implement the Embedder**

Add to `pkg/jarvisembed/embed.go` (add imports `context`, `bytes`, `encoding/json`, `fmt`, `net/http`, `time`, `sync`):
```go
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Model() string
}

type openAICompatEmbedder struct {
	baseURL, model, key string
	hc                  *http.Client
}

func (e *openAICompatEmbedder) Model() string { return e.model }

func (e *openAICompatEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	reqBody, _ := json.Marshal(map[string]any{"model": e.model, "input": texts})
	url := strings.TrimRight(e.baseURL, "/") + "/embeddings"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.key)
	resp, err := e.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jarvisembed: embed request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jarvisembed: embed status %d", resp.StatusCode)
	}
	var parsed struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("jarvisembed: decode embed response: %w", err)
	}
	out := make([][]float32, len(parsed.Data))
	for i, d := range parsed.Data {
		out[i] = d.Embedding
	}
	if len(out) != len(texts) {
		return nil, fmt.Errorf("jarvisembed: embedded %d of %d inputs", len(out), len(texts))
	}
	return out, nil
}

func newConfiguredEmbedder() (Embedder, bool) {
	baseURL, model, enabled := resolveConfig()
	if !enabled {
		return nil, false
	}
	key, ok := resolveKey()
	if !ok {
		return nil, false
	}
	return &openAICompatEmbedder{baseURL: baseURL, model: model, key: key, hc: &http.Client{Timeout: 60 * time.Second}}, true
}

var (
	testEmbedderMu sync.Mutex
	testEmbedder   Embedder
)

// SetEmbedderForTest injects a mock embedder used by OpenIndex when set (mirrors
// C's SetSynthesizeForTest). Returns a restore func.
func SetEmbedderForTest(e Embedder) (restore func()) {
	testEmbedderMu.Lock()
	prev := testEmbedder
	testEmbedder = e
	testEmbedderMu.Unlock()
	return func() {
		testEmbedderMu.Lock()
		testEmbedder = prev
		testEmbedderMu.Unlock()
	}
}

func embedderForTest() Embedder {
	testEmbedderMu.Lock()
	defer testEmbedderMu.Unlock()
	return testEmbedder
}
```
Add `"strings"` to the import block.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisembed/ -run TestOpenAICompatEmbed -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/jarvisembed/ -v`
Expected: all pass.

---

## Task 4: Section-level chunking

**Files:**
- Create: `pkg/jarvisembed/chunk.go`
- Test: `pkg/jarvisembed/chunk_test.go`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces: `type Section struct { Idx int; Heading string; Text string }`, `func splitSections(body string) []Section`, `func embedText(fm map[string]any, s Section) string`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisembed/chunk_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"strings"
	"testing"
)

func TestSplitSections(t *testing.T) {
	body := "intro line\n\n## First\nalpha\n\n## Second\nbeta\n"
	got := splitSections(body)
	if len(got) != 3 {
		t.Fatalf("want 3 sections, got %d: %+v", len(got), got)
	}
	if got[0].Heading != "" || !strings.Contains(got[0].Text, "intro line") {
		t.Errorf("section 0 = %+v", got[0])
	}
	if got[1].Heading != "First" || !strings.Contains(got[1].Text, "alpha") {
		t.Errorf("section 1 = %+v", got[1])
	}
	if got[2].Idx != 2 || got[2].Heading != "Second" {
		t.Errorf("section 2 = %+v", got[2])
	}
}

func TestSplitSectionsNoHeading(t *testing.T) {
	got := splitSections("just prose, no headings")
	if len(got) != 1 || got[0].Heading != "" {
		t.Fatalf("want 1 headingless section, got %+v", got)
	}
}

func TestEmbedTextIncludesFrontmatter(t *testing.T) {
	fm := map[string]any{"ticket": "ABC-1", "objective": "do the thing"}
	txt := embedText(fm, Section{Idx: 1, Heading: "Notes", Text: "body here"})
	if !strings.Contains(txt, "ABC-1") || !strings.Contains(txt, "Notes") || !strings.Contains(txt, "body here") {
		t.Fatalf("embedText missing parts: %q", txt)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisembed/ -run 'TestSplitSections|TestEmbedText' -v`
Expected: FAIL — `undefined: splitSections`.

- [ ] **Step 3: Implement chunking**

Create `pkg/jarvisembed/chunk.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"fmt"
	"sort"
	"strings"
)

// Section is one embeddable unit of a node body: the text under a `##` heading
// (or the leading headingless body as section 0).
type Section struct {
	Idx     int
	Heading string
	Text    string
}

// splitSections segments a node body at `##` headings. Content before the first
// heading becomes section 0 with an empty Heading. Empty sections are dropped;
// a body with no `##` yields one section.
func splitSections(body string) []Section {
	lines := strings.Split(body, "\n")
	var sections []Section
	cur := Section{Idx: 0, Heading: ""}
	var buf []string
	flush := func() {
		txt := strings.TrimSpace(strings.Join(buf, "\n"))
		if txt != "" || cur.Heading != "" {
			cur.Text = txt
			cur.Idx = len(sections)
			sections = append(sections, cur)
		}
		buf = nil
	}
	for _, ln := range lines {
		if h := strings.TrimSpace(ln); strings.HasPrefix(h, "## ") {
			flush()
			cur = Section{Heading: strings.TrimSpace(strings.TrimPrefix(h, "## "))}
			continue
		}
		buf = append(buf, ln)
	}
	flush()
	if len(sections) == 0 {
		sections = append(sections, Section{Idx: 0, Text: strings.TrimSpace(body)})
	}
	return sections
}

// embedText builds the string sent to the embedder: frontmatter as metadata
// (sorted for determinism) + the section heading + the section text.
func embedText(fm map[string]any, s Section) string {
	var b strings.Builder
	keys := make([]string, 0, len(fm))
	for k := range fm {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "%s: %v\n", k, fm[k])
	}
	if s.Heading != "" {
		fmt.Fprintf(&b, "## %s\n", s.Heading)
	}
	b.WriteString(s.Text)
	return b.String()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisembed/ -run 'TestSplitSections|TestEmbedText' -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/jarvisembed/ -v`
Expected: all pass.

---

## Task 5: Index open, schema, and the unavailable contract

**Files:**
- Create: `pkg/jarvisembed/index.go`, `pkg/jarvisembed/maintest_test.go`
- Test: `pkg/jarvisembed/index_test.go`

**Interfaces:**
- Consumes: `newConfiguredEmbedder`, `embedderForTest` (Task 3), `sqlite_vec.Auto`, `database/sql`, `wavebase` (data dir).
- Produces: `type Index struct{…}`, `type ScoredChunk struct { NodeID, Collection, SectionHeading string; SectionIdx int; Snippet string; Score float32 }`, `var ErrEmbeddingsDisabled`, `func OpenIndex(ctx context.Context) (*Index, error)`, `func OpenIndexAtForTest(ctx context.Context, dbPath string, emb Embedder) (*Index, error)`, `func (ix *Index) Available() bool`, `func (ix *Index) Close() error`. (Internal: `ensureBaseSchema`, `ensureVecTable(dims int)`.)

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisembed/maintest_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"path/filepath"
	"testing"
)

// newTestIndex opens an index at a temp DB with the given embedder (nil => unavailable).
func newTestIndex(t *testing.T, emb Embedder) *Index {
	t.Helper()
	ix, err := OpenIndexAtForTest(context.Background(), filepath.Join(t.TempDir(), "index.db"), emb)
	if err != nil {
		t.Fatalf("OpenIndexAtForTest: %v", err)
	}
	t.Cleanup(func() { ix.Close() })
	return ix
}
```

Create `pkg/jarvisembed/index_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"errors"
	"testing"
)

func TestOpenIndexDisabledIsUnavailable(t *testing.T) {
	ix := newTestIndex(t, nil) // nil embedder => unavailable
	if ix.Available() {
		t.Fatal("expected unavailable index")
	}
	_, err := ix.Query(context.Background(), nil, "anything", 5, allScopeForTest())
	if !errors.Is(err, ErrEmbeddingsDisabled) {
		t.Fatalf("Query err = %v, want ErrEmbeddingsDisabled", err)
	}
}

func TestOpenIndexEnabledCreatesSchema(t *testing.T) {
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})
	if !ix.Available() {
		t.Fatal("expected available index")
	}
	var n int
	if err := ix.db.QueryRow(`select count(*) from sqlite_master where name in ('chunks','meta')`).Scan(&n); err != nil {
		t.Fatalf("schema query: %v", err)
	}
	if n != 2 {
		t.Fatalf("expected chunks+meta tables, got %d", n)
	}
}
```

Add the shared test helpers to `pkg/jarvisembed/index_test.go` (used across Tasks 5–7):
```go
import "github.com/wavetermdev/waveterm/pkg/wavevault"

func allScopeForTest() wavevault.Scope { return wavevault.AllScope() }

// fakeEmbedder returns deterministic vectors: a keyword→basis-vector map so KNN
// ordering is assertable. Unknown text embeds to a small uniform vector.
type fakeEmbedder struct {
	dims  int
	calls int
}

func (f *fakeEmbedder) Model() string { return "fake-model" }
func (f *fakeEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	f.calls += len(texts)
	out := make([][]float32, len(texts))
	for i, tx := range texts {
		v := make([]float32, f.dims)
		switch {
		case containsFold(tx, "alpha"):
			v[0] = 1
		case containsFold(tx, "beta"):
			v[1] = 1
		default:
			for j := range v {
				v[j] = 0.01
			}
		}
		out[i] = v
	}
	return out, nil
}

func containsFold(s, sub string) bool {
	return len(s) >= len(sub) && stringsContainsFold(s, sub)
}
```
(Provide `stringsContainsFold` via `strings.Contains(strings.ToLower(s), sub)` — add `import "strings"` and a one-line helper, or inline `strings.Contains(strings.ToLower(s), sub)` directly in `Embed`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisembed/ -run TestOpenIndex -v`
Expected: FAIL — `undefined: OpenIndexAtForTest` / `ErrEmbeddingsDisabled`.

- [ ] **Step 3: Implement the index**

Create `pkg/jarvisembed/index.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	_ "github.com/mattn/go-sqlite3"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// ErrEmbeddingsDisabled is the typed graceful-degradation signal: returned when
// embeddings are off/misconfigured. Consumers fall back to L1/L2 (invariant 11).
var ErrEmbeddingsDisabled = errors.New("jarvisembed: embeddings disabled")

func init() { sqlite_vec.Auto() }

// ScoredChunk is one KNN hit: the source node/section plus a grounding snippet
// and a cosine similarity score (higher = closer).
type ScoredChunk struct {
	NodeID         string
	Collection     string
	SectionHeading string
	SectionIdx     int
	Snippet        string
	Score          float32
}

type Index struct {
	db        *sql.DB
	emb       Embedder
	available bool
	dims      int // 0 until learned from the first embedding
}

func indexDBPath() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "jarvis", "index.db")
}

// OpenIndex opens (or creates) the derived-layer index. If embeddings are not
// fully configured it returns an unavailable handle that does no DB or network
// work; Query on it yields ErrEmbeddingsDisabled.
func OpenIndex(ctx context.Context) (*Index, error) {
	emb := embedderForTest()
	if emb == nil {
		var ok bool
		emb, ok = newConfiguredEmbedder()
		if !ok {
			return &Index{available: false}, nil
		}
	}
	return openIndexAt(ctx, indexDBPath(), emb)
}

// OpenIndexAtForTest opens an index at an explicit path with an explicit
// embedder. A nil embedder yields an unavailable index.
func OpenIndexAtForTest(ctx context.Context, dbPath string, emb Embedder) (*Index, error) {
	if emb == nil {
		return &Index{available: false}, nil
	}
	return openIndexAt(ctx, dbPath, emb)
}

func openIndexAt(ctx context.Context, dbPath string, emb Embedder) (*Index, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, err
	}
	ix := &Index{db: db, emb: emb, available: true}
	if err := ix.ensureBaseSchema(ctx); err != nil {
		db.Close()
		return nil, err
	}
	if err := ix.db.QueryRow(`select dims from meta limit 1`).Scan(&ix.dims); err != nil && !errors.Is(err, sql.ErrNoRows) {
		db.Close()
		return nil, err
	}
	return ix, nil
}

func (ix *Index) Available() bool { return ix != nil && ix.available }

func (ix *Index) Close() error {
	if ix == nil || ix.db == nil {
		return nil
	}
	return ix.db.Close()
}

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
`)
	return err
}

// ensureVecTable creates the vec0 virtual table at the given dims once dims are
// known (from the first embedding). No-op if already present.
func (ix *Index) ensureVecTable(ctx context.Context, dims int) error {
	_, err := ix.db.ExecContext(ctx, fmt.Sprintf(
		`create virtual table if not exists vec_chunks using vec0(embedding float[%d], collection text)`, dims))
	return err
}
```

> If the Task 1 spike selected the fallback, replace `ensureVecTable`'s `vec0(...)` with a BLOB column on `chunks` (`embedding blob`) and skip the virtual table; Task 7 uses `vec_distance_cosine` over that column.

Verify `wavebase.GetWaveDataDir()` is the correct accessor (grep `pkg/wavebase`); if the accessor differs, use the one A/E use to locate the data home.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisembed/ -run TestOpenIndex -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/jarvisembed/ -v`
Expected: all pass.

---

## Task 6: Reconcile (content-hash diff, embed changed only, prune, rebuild)

**Files:**
- Create: `pkg/jarvisembed/reconcile.go`
- Test: `pkg/jarvisembed/reconcile_test.go`

**Interfaces:**
- Consumes: `Index` + `ensureVecTable` (Task 5), `splitSections`/`embedText` (Task 4), `Embedder` (Task 3), `wavevault` (`OpenVaultAtForTest`, `AllScope`, `Retriever.Query`/`Read`, `Filter`, `Node.ContentHash`/`Collection`, `NodeWithBody`).
- Produces: `type ReconcileStats struct { Embedded, Pruned int; Rebuilt bool }`, `func (ix *Index) Reconcile(ctx context.Context, v *wavevault.Vault) (ReconcileStats, error)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisembed/reconcile_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func seedVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	writeNode(t, v, "memory/one.md", "---\nid: one\n---\n## A\nalpha content\n")
	writeNode(t, v, "tasks/active/two.md", "---\nid: two\nticket: ABC-1\n---\n## B\nbeta content\n")
	return v
}

func writeNode(t *testing.T, v *wavevault.Vault, rel, content string) {
	t.Helper()
	p := filepath.Join(v.Root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReconcileEmbedsOnlyChanged(t *testing.T) {
	v := seedVault(t)
	fe := &fakeEmbedder{dims: 3}
	ix := newTestIndex(t, fe)

	st, err := ix.Reconcile(context.Background(), v)
	if err != nil {
		t.Fatalf("reconcile 1: %v", err)
	}
	if st.Embedded == 0 {
		t.Fatal("first reconcile embedded nothing")
	}
	firstCalls := fe.calls

	// Unchanged reconcile embeds nothing.
	if _, err := ix.Reconcile(context.Background(), v); err != nil {
		t.Fatalf("reconcile 2: %v", err)
	}
	if fe.calls != firstCalls {
		t.Fatalf("unchanged reconcile embedded %d extra sections", fe.calls-firstCalls)
	}

	// Edit one node -> only its sections re-embed.
	writeNode(t, v, "memory/one.md", "---\nid: one\n---\n## A\nalpha content changed\n")
	before := fe.calls
	if _, err := ix.Reconcile(context.Background(), v); err != nil {
		t.Fatalf("reconcile 3: %v", err)
	}
	if fe.calls != before+1 {
		t.Fatalf("edit re-embedded %d sections, want 1", fe.calls-before)
	}
}

func TestReconcilePrunesRemoved(t *testing.T) {
	v := seedVault(t)
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})
	if _, err := ix.Reconcile(context.Background(), v); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(v.Root, "memory/one.md")); err != nil {
		t.Fatal(err)
	}
	st, err := ix.Reconcile(context.Background(), v)
	if err != nil {
		t.Fatal(err)
	}
	if st.Pruned == 0 {
		t.Fatal("expected pruned chunks for removed node")
	}
	var n int
	ix.db.QueryRow(`select count(*) from chunks where node_id = 'one'`).Scan(&n)
	if n != 0 {
		t.Fatalf("node 'one' still has %d chunks", n)
	}
}

func TestReconcileModelChangeRebuilds(t *testing.T) {
	v := seedVault(t)
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})
	if _, err := ix.Reconcile(context.Background(), v); err != nil {
		t.Fatal(err)
	}
	// Swap to a different model tag -> full rebuild.
	ix.emb = &renamedFakeEmbedder{fakeEmbedder{dims: 3}}
	st, err := ix.Reconcile(context.Background(), v)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Rebuilt {
		t.Fatal("expected Rebuilt on model change")
	}
}

type renamedFakeEmbedder struct{ fakeEmbedder }

func (r *renamedFakeEmbedder) Model() string { return "other-model" }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisembed/ -run TestReconcile -v`
Expected: FAIL — `undefined: (*Index).Reconcile`.

- [ ] **Step 3: Implement Reconcile**

Create `pkg/jarvisembed/reconcile.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// ReconcileStats summarizes a reconcile pass.
type ReconcileStats struct {
	Embedded int  // sections (re)embedded
	Pruned   int  // chunks deleted for removed/changed nodes
	Rebuilt  bool // full rebuild (model change)
}

// Reconcile brings the index up to date with the whole vault (always AllScope,
// so scope-narrow queries never prune out-of-scope chunks). Only nodes whose
// ContentHash changed since indexed hit the embedder. This one method is both
// the lazy path (called by Query) and the warm path (called at a commit
// boundary). No-op and no network on an unchanged vault.
func (ix *Index) Reconcile(ctx context.Context, v *wavevault.Vault) (ReconcileStats, error) {
	var st ReconcileStats
	if !ix.available {
		return st, ErrEmbeddingsDisabled
	}

	// Model-change rebuild.
	var storedModel string
	err := ix.db.QueryRowContext(ctx, `select model from meta limit 1`).Scan(&storedModel)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := ix.db.ExecContext(ctx, `insert into meta(model, dims) values (?, 0)`, ix.emb.Model()); err != nil {
			return st, err
		}
	case err != nil:
		return st, err
	case storedModel != ix.emb.Model():
		if err := ix.wipe(ctx); err != nil {
			return st, err
		}
		if _, err := ix.db.ExecContext(ctx, `insert into meta(model, dims) values (?, 0)`, ix.emb.Model()); err != nil {
			return st, err
		}
		ix.dims = 0
		st.Rebuilt = true
	}

	r := v.Retriever(wavevault.AllScope())
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return st, err
	}

	live := map[string]bool{}
	for _, n := range nodes {
		live[n.ID] = true
		var have string
		row := ix.db.QueryRowContext(ctx, `select content_hash from chunks where node_id = ? limit 1`, n.ID)
		if err := row.Scan(&have); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return st, err
		}
		if have == n.ContentHash {
			continue // unchanged
		}
		nwb, err := r.Read(n.ID)
		if err != nil {
			return st, err
		}
		emb, err := ix.embedNode(ctx, n, nwb.Body)
		if err != nil {
			return st, err
		}
		st.Embedded += emb
	}

	// Prune nodes no longer present.
	pruned, err := ix.pruneMissing(ctx, live)
	if err != nil {
		return st, err
	}
	st.Pruned += pruned
	return st, nil
}

// embedNode re-embeds all sections of one node: delete its old rows, split,
// embed, insert. Returns the number of sections embedded.
func (ix *Index) embedNode(ctx context.Context, n wavevault.Node, body string) (int, error) {
	sections := splitSections(body)
	texts := make([]string, len(sections))
	for i, s := range sections {
		texts[i] = embedText(n.Frontmatter, s)
	}
	vecs, err := ix.emb.Embed(ctx, texts)
	if err != nil {
		return 0, err
	}
	if len(vecs) == 0 {
		return 0, nil
	}
	if ix.dims == 0 {
		ix.dims = len(vecs[0])
		if _, err := ix.db.ExecContext(ctx, `update meta set dims = ?`, ix.dims); err != nil {
			return 0, err
		}
	}
	if err := ix.ensureVecTable(ctx, ix.dims); err != nil {
		return 0, err
	}

	tx, err := ix.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `delete from vec_chunks where rowid in (select rowid from chunks where node_id = ?)`, n.ID); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `delete from chunks where node_id = ?`, n.ID); err != nil {
		return 0, err
	}
	for i, s := range sections {
		res, err := tx.ExecContext(ctx,
			`insert into chunks(node_id, collection, section_idx, section_heading, section_text, content_hash) values (?,?,?,?,?,?)`,
			n.ID, n.Collection, s.Idx, s.Heading, s.Text, n.ContentHash)
		if err != nil {
			return 0, err
		}
		rowid, _ := res.LastInsertId()
		if _, err := tx.ExecContext(ctx, `insert into vec_chunks(rowid, embedding, collection) values (?,?,?)`,
			rowid, encodeVec(vecs[i]), n.Collection); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(sections), nil
}

func (ix *Index) pruneMissing(ctx context.Context, live map[string]bool) (int, error) {
	rows, err := ix.db.QueryContext(ctx, `select distinct node_id from chunks`)
	if err != nil {
		return 0, err
	}
	var dead []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		if !live[id] {
			dead = append(dead, id)
		}
	}
	rows.Close()
	pruned := 0
	for _, id := range dead {
		res, err := ix.db.ExecContext(ctx, `delete from vec_chunks where rowid in (select rowid from chunks where node_id = ?)`, id)
		if err != nil {
			return pruned, err
		}
		if _, err := ix.db.ExecContext(ctx, `delete from chunks where node_id = ?`, id); err != nil {
			return pruned, err
		}
		if aff, _ := res.RowsAffected(); aff > 0 {
			pruned += int(aff)
		} else {
			pruned++
		}
	}
	return pruned, nil
}

func (ix *Index) wipe(ctx context.Context) error {
	for _, stmt := range []string{`drop table if exists vec_chunks`, `delete from chunks`, `delete from meta`} {
		if _, err := ix.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// encodeVec serializes a float32 vector to the little-endian byte form sqlite-vec accepts.
func encodeVec(v []float32) []byte {
	b := make([]byte, 0, len(v)*4)
	for _, f := range v {
		bits := mathFloat32bits(f)
		b = append(b, byte(bits), byte(bits>>8), byte(bits>>16), byte(bits>>24))
	}
	return b
}
```

Add a small helper file line for `mathFloat32bits` — use `math.Float32bits` directly (add `import "math"` and replace `mathFloat32bits(f)` with `math.Float32bits(f)`). (sqlite-vec accepts either a JSON `[...]` string or a raw little-endian float32 BLOB for `float[N]` columns; the BLOB form avoids per-insert string formatting.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisembed/ -run TestReconcile -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/jarvisembed/ -v`
Expected: all pass.

---

## Task 7: Scope-filtered KNN Query

**Files:**
- Modify: `pkg/jarvisembed/index.go` (add `Query`)
- Test: `pkg/jarvisembed/index_test.go`

**Interfaces:**
- Consumes: `Reconcile` (Task 6), `Embedder.Embed`, `encodeVec` (Task 6), `wavevault.Scope`/`WorkerScope`/`AllScope`.
- Produces: `func (ix *Index) Query(ctx context.Context, v *wavevault.Vault, queryText string, k int, scope wavevault.Scope) ([]ScoredChunk, error)`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvisembed/index_test.go`:
```go
func TestQueryKNNAndScope(t *testing.T) {
	v := seedVault(t) // memory/one.md ("alpha"), tasks/active/two.md ("beta")
	ix := newTestIndex(t, &fakeEmbedder{dims: 3})

	// AllScope: "alpha" nearest is node one.
	got, err := ix.Query(context.Background(), v, "alpha please", 5, wavevault.AllScope())
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(got) == 0 || got[0].NodeID != "one" {
		t.Fatalf("want top hit 'one', got %+v", got)
	}

	// WorkerScope excludes tasks/: a "beta" query must not return node two.
	got, err = ix.Query(context.Background(), v, "beta please", 5, wavevault.WorkerScope())
	if err != nil {
		t.Fatalf("query worker: %v", err)
	}
	for _, c := range got {
		if c.Collection == wavevault.CollTasks || c.NodeID == "two" {
			t.Fatalf("worker scope leaked a tasks/ chunk: %+v", c)
		}
	}
}

func TestQueryDisabledNoNetwork(t *testing.T) {
	fe := &fakeEmbedder{dims: 3}
	restore := SetEmbedderForTest(nil)
	defer restore()
	ix := newTestIndex(t, nil)
	_, err := ix.Query(context.Background(), nil, "x", 3, wavevault.AllScope())
	if err == nil {
		t.Fatal("want ErrEmbeddingsDisabled")
	}
	if fe.calls != 0 {
		t.Fatal("disabled path should not embed")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvisembed/ -run TestQuery -v`
Expected: FAIL — `(*Index).Query` signature mismatch / not implemented for the KNN path (Task 5 stubbed only the disabled branch; if not, `undefined`).

- [ ] **Step 3: Implement Query**

Add to `pkg/jarvisembed/index.go` (add imports `strings`; `wavevault`):
```go
// Query embeds queryText and returns the top-k nearest section chunks whose
// collection is within scope (the physical boundary — a WorkerScope query can
// never return a tasks/ chunk). It reconciles lazily first (invariant 1).
func (ix *Index) Query(ctx context.Context, v *wavevault.Vault, queryText string, k int, scope wavevault.Scope) ([]ScoredChunk, error) {
	if !ix.Available() {
		return nil, ErrEmbeddingsDisabled
	}
	if _, err := ix.Reconcile(ctx, v); err != nil {
		return nil, err
	}
	vecs, err := ix.emb.Embed(ctx, []string{queryText})
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 || ix.dims == 0 {
		return nil, nil // nothing indexed yet
	}
	colls := scope.Collections
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(colls)), ",")
	args := []any{encodeVec(vecs[0]), k}
	for _, c := range colls {
		args = append(args, c)
	}
	sqlStr := fmt.Sprintf(`
select c.node_id, c.collection, c.section_heading, c.section_idx, c.section_text, vc.distance
from vec_chunks vc
join chunks c on c.rowid = vc.rowid
where vc.embedding match ? and vc.k = ? and c.collection in (%s)
order by vc.distance`, placeholders)
	rows, err := ix.db.QueryContext(ctx, sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ScoredChunk
	for rows.Next() {
		var sc ScoredChunk
		var dist float64
		var text string
		if err := rows.Scan(&sc.NodeID, &sc.Collection, &sc.SectionHeading, &sc.SectionIdx, &text, &dist); err != nil {
			return nil, err
		}
		sc.Snippet = truncate(text, 240)
		sc.Score = float32(1 - dist) // cosine distance -> similarity
		out = append(out, sc)
	}
	return out, rows.Err()
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
```

> Fallback variant (if Task 1 chose it): replace the `vec_chunks match` query with
> `select … , vec_distance_cosine(c.embedding, ?) as dist from chunks c where c.collection in (…) order by dist limit ?`
> — same columns, same `ScoredChunk` output.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvisembed/ -run TestQuery -v`
Expected: PASS.

- [ ] **Step 5: Full package suite + build checkpoint**

Run: `go test ./pkg/jarvisembed/ -v && go vet ./pkg/jarvisembed/ && task build:backend`
Expected: all tests pass, vet clean, backend builds.

---

## Task 8: Docs, deferrals, meta-spec reconciliation, and the feature commit

**Files:**
- Modify: `docs/deferred.md`
- Modify: `docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md` (S1 tracking row + wording fix)
- Commit: everything (spec, plan, package, config, deferred, meta-spec edits)

**Interfaces:** none (documentation + commit).

- [ ] **Step 1: Record deferrals + placeholders**

Append to `docs/deferred.md` an S1 section:
```markdown
## Jarvis S1 — embedding foundation (2026-07-24)

Deferred:
- Warm-at-commit wiring: `Reconcile` is exposed but only called lazily from `Query` in S1. Wire it into a commit boundary only if first-query latency after edits proves painful.
- Settings UI for embed config/key: S1 reads `jarvis:embed*` from config and the key from `secretstore`; a settings-surface control is deferred (S2 / a small settings add). Dev sets config via settings file + `secretstore.SetSecret`.
- Multimodal/image embeddings, query-side reranking, bundled local embedding model — v3.

PLACEHOLDER tuning (calibrate against a populated, embedded vault):
- Query `k` (caller-supplied; no default fixed here).
- Embed batch size (all sections of a node in one call today).
- Section-split rule (`##` only; deeper heading levels not split).
- HTTP timeout (60s).
```

- [ ] **Step 2: Reconcile the meta spec**

In `docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md`:
- Fix invariant 13's wording: replace "It lives in the derived layer alongside v1's learning-store cache" with "It is Wave's first persisted derived-layer artifact" (there is no learning-store cache — S1 introduces the derived layer).
- In the tracking table, set the S1 row's Spec/Plan/Built cells:
  `| S1 | Embedding foundation | [spec](2026-07-24-jarvis-s1-embedding-foundation-design.md) | [plan](../plans/2026-07-24-jarvis-s1-embedding-foundation.md) | Built — opt-in BYOK embedding foundation (pkg/jarvisembed): OpenAI-compatible Embedder seam + dedicated sqlite-vec derived-layer index (static-linked, outside the vault) + hybrid lazy/warm Reconcile (content-hash diff, only-changed re-embed, prune, model-change rebuild) + section-level chunks + scope-filtered KNN + typed ErrEmbeddingsDisabled degradation. No consumer wired (S2 is first); adds jarvis:embed* config + secretstore key. |`

- [ ] **Step 3: Self-verify the whole cycle is green**

Run: `go test ./pkg/jarvisembed/ ./pkg/wconfig/ -v && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && task build:backend`
Expected: tests pass, tsc exit 0, backend builds.

- [ ] **Step 4: Request commit approval, then commit (do not commit without approval)**

On approval, stage and commit as one feature commit (folds the spec + plan + implementation + config + docs, per the user's batch-commit workflow and the A–F precedent; no co-author line):
```bash
git add pkg/jarvisembed pkg/wconfig go.mod go.sum \
  docs/superpowers/specs/2026-07-24-jarvis-s1-embedding-foundation-design.md \
  docs/superpowers/plans/2026-07-24-jarvis-s1-embedding-foundation.md \
  docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md \
  docs/superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md \
  docs/deferred.md
git commit -m "feat(jarvis): opt-in BYOK embedding foundation (v2 sub-project S1)"
```
Expected: one commit on `main` (or the S1 worktree branch), no co-author trailer.

---

## Self-Review

**1. Spec coverage** — every S1 spec section maps to a task:
- Embedder seam (spec §1) → Task 3. Index + schema + unavailable (spec §2, §5) → Task 5. Reconcile/hybrid (spec §3) → Task 6. Scope-filtered Query (spec §4) → Task 7. Config & secrets (spec §6) → Task 2. Testing (spec §7) → Tasks 1,3–7. Build spike / open risks → Task 1. Docs/deferred + meta-spec fix (spec file-touch map) → Task 8.
- Graceful-degradation contract (spec §5) → `ErrEmbeddingsDisabled` in Task 5, asserted in Tasks 5 & 7.

**2. Placeholder scan** — the only "PLACEHOLDER" text is the deliberate tuning list routed to `docs/deferred.md` (Task 8), per house convention; every code step has complete code. Two explicit "verify the accessor" notes (`wavebase.GetWaveDataDir`, sqlite-vec metadata syntax) are gated by real checks (Task 5 grep; Task 1 spike), not left as vague TODOs.

**3. Type consistency** — signatures are stable across tasks: `Embedder{Embed,Model}` (Task 3) used by Tasks 5–7; `Index`/`ScoredChunk`/`ErrEmbeddingsDisabled` (Task 5) used by 6–7; `ReconcileStats`/`Reconcile(ctx, *wavevault.Vault)` (Task 6) called by `Query` (Task 7); `encodeVec` defined in Task 6, used in Task 7; `fakeEmbedder`/`newTestIndex`/`seedVault` test helpers defined once and reused. `Reconcile` takes `*wavevault.Vault` (not a `*Retriever` as the spec sketched) — a deliberate refinement so reconciliation is always AllScope and scope-narrow queries never prune out-of-scope chunks; noted here as the one plan-vs-spec signature change.
