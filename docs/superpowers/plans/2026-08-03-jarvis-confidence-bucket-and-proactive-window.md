# Jarvis confidence buckets + proactive window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two defects in the Jarvis attribution/proactive lane that no amount of extra corpus can fix — an unreachable confidence bucket and a starved semantic window — then make the corpus measurement repeatable and rewrite the tuning-constants tracker entry honestly.

**Architecture:** Three self-contained Go changes plus a documentation pass. (1) The attribution engine's display bucket stops being derived from a float threshold and is derived from the firing layer instead, removing a band no edge could occupy. (2) The proactive-resurfacing gate switches from one global nearest-neighbour window to the per-collection window the recall path already uses, and its shortlist emits round-robin across collections so the crowding cannot reappear downstream. (3) A new `liveprobe`-tagged corpus probe records the real edge distribution with zero provider spend.

**Tech Stack:** Go 1.23+ (`pkg/jarvisattrib`, `pkg/jarvisproactive`, `pkg/jarvisembed`, `pkg/wavevault`, `pkg/wshrpc/wshserver`), standard `testing`, sqlite-vec via CGO.

Spec: [`docs/superpowers/specs/2026-08-03-jarvis-confidence-bucket-and-proactive-window-design.md`](../specs/2026-08-03-jarvis-confidence-bucket-and-proactive-window-design.md).

## Global Constraints

- **Do not commit per task.** The repo owner's standing rule is: never commit or push without explicit approval, and batch into one commit at the end. Task 4 holds the single commit and it is gated on approval. This deliberately overrides the usual commit-per-task pattern.
- **Never hand-edit generated files.** No change here touches the wire protocol: `AmbientEdge.Bucket` and `GraphLink.Bucket` stay `string` with the same `weak | medium | strong` vocabulary, so **do not run `task generate`** and expect no diff in `frontend/types/gotypes.d.ts` or `frontend/app/store/wshclientapi.ts`.
- **No frontend change is required.** `frontend/app/view/jarvis/jarvisgraphderive.ts:65-66` already maps a `"medium"` bucket to opacity 0.6 / width 1.0; that branch was simply unreachable. Leave it alone. No `npx vitest` run is needed.
- **Go tests need a Windows-style CGO include path.** `pkg/jarvisattrib` imports `pkg/jarvisembed`, whose vendored sqlite-vec header needs an `-I` flag. A Git-Bash POSIX path (`/c/Users/...`) silently fails with an identical "sqlite3.h: No such file or directory" error. From PowerShell at the repo root:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
- **Windows shell:** never use PowerShell here-string syntax (`@'...'@`) inside the Bash tool. For the multi-line commit message in Task 4, use repeated `-m` flags.
- Comments explain "why", never "what", lower case, only where necessary.
- Do not add, re-fit, or re-tune any threshold constant. `cosThreshold` 0.40, `semThreshold` 0.65, `semSeedFloor` 0.325 and `kSemPerCollection` 6 are already fitted and are **out of scope**.

---

## File Structure

**Modified:**
- `pkg/jarvisattrib/edges.go` — attribution layer weights, the display-bucket mapping, provenance mapping. Gains `strongestLayer` + `BucketFor`; loses the `bucketWeakMax`/`bucketStrongMin` float cutoffs.
- `pkg/jarvisattrib/edges_test.go` — replaces the bucket-cutoff test with a total-mapping test and a reachability test.
- `pkg/jarvisattrib/semantic_test.go:19-29` — one call updated to the new bucket signature.
- `pkg/wshrpc/wshserver/wshserver_jarvis.go` — three bucket call sites (lines 590-593, 747, 865).
- `pkg/jarvisproactive/gate.go` — the gate tunables comment + constant rename, and `prefilter` gains round-robin shortlisting.
- `pkg/jarvisproactive/proactive.go:73` — global `Query` → `QueryPerCollection`.
- `pkg/jarvisproactive/gate_test.go` — adds the round-robin test.
- `pkg/jarvisproactive/proactive_test.go` — adds a graded embedder, a vault-dir helper and the end-to-end crowding test.
- `docs/jarvis-second-brain-open-issues.md` — the tuning-constants entry (J5) restructured; both defects recorded as resolved.
- `docs/deferred.md` — strike the retired bucket-cutoff line.

**Created:**
- `pkg/jarvisattrib/liveprobe_test.go` — the no-spend corpus probe.

---

## Task 1: Bucket derives from the firing layer, not a float threshold

**Files:**
- Modify: `pkg/jarvisattrib/edges.go:16-34` (constants), `:88-117` (`provenanceFor`, `Bucket`)
- Modify: `pkg/jarvisattrib/edges_test.go:18-22`
- Modify: `pkg/jarvisattrib/semantic_test.go:23`
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go:588-593`, `:747`, `:865`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `jarvisattrib.BucketFor(layers []int) string` — returns `"strong"` for layer 1, `"medium"` for layer 2, `"weak"` for layers 3 and 4, and `""` for an empty or unknown layer list. Replaces the removed exported `jarvisattrib.Bucket(c float64) string`. Also produces unexported `strongestLayer(layers []int) int`, returning the lowest layer number present or 0 for none. Task 3 uses `BucketFor`.

- [ ] **Step 1: Demonstrate the defect with a throwaway test that passes on today's code**

Add to `pkg/jarvisattrib/edges_test.go`. This asserts the *bug*: no layer that can actually fire produces a `"medium"` bucket. It passes now and is deleted in Step 4.

```go
// THROWAWAY (deleted in step 4): documents the defect this task fixes. confidenceFor takes the MAX of
// four fixed layer weights and never blends them, so the reachable confidence set is {0.2, 0.3, 0.8,
// 1.0} while Bucket calls [0.4, 0.75) "medium". Nothing can land there.
func TestMediumBucketIsUnreachableFromAnyLayer(t *testing.T) {
	for _, l := range []int{1, 2, 3, 4} {
		if got := Bucket(confidenceFor([]int{l})); got == "medium" {
			t.Fatalf("layer %d reached medium, defect is already gone", l)
		}
	}
	t.Log("confirmed: no firing layer produces a medium bucket — the band is dead code")
}
```

- [ ] **Step 2: Run it and confirm the defect is real**

Run (PowerShell, repo root):
```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvisattrib/ -run TestMediumBucketIsUnreachableFromAnyLayer -v
```
Expected: **PASS**, with the log line `confirmed: no firing layer produces a medium bucket — the band is dead code`. A pass here is the evidence the defect exists.

- [ ] **Step 3: Write the failing tests for the new mapping**

Replace `TestBucketCutoffs` (`pkg/jarvisattrib/edges_test.go:18-22`) with these two. The second is the test that would have caught the original bug.

```go
func TestBucketForIsTotalOverFiringLayers(t *testing.T) {
	cases := []struct {
		layers []int
		want   string
	}{
		{[]int{1}, "strong"},    // canonical dispatch reference
		{[]int{2}, "medium"},    // identifier (ticket) match
		{[]int{3}, "weak"},      // structural correlation
		{[]int{4}, "weak"},      // semantic similarity
		{[]int{3, 2}, "medium"}, // strongest layer wins regardless of input order
		{[]int{2, 1}, "strong"},
		{[]int{4, 3}, "weak"},
		{nil, ""},      // no layers means no signal: absent, never a fabricated "weak"
		{[]int{}, ""},
		{[]int{9}, ""}, // unknown layer is not silently labelled
	}
	for _, c := range cases {
		if got := BucketFor(c.layers); got != c.want {
			t.Errorf("BucketFor(%v) = %q, want %q", c.layers, got, c.want)
		}
	}
}

// The guard against the defect returning: every bucket name the wire type advertises must be
// producible by some layer that can actually fire. Re-deriving the bucket from a float threshold
// fails this, because no layer weight falls inside the old [0.4, 0.75) medium band.
func TestEveryBucketIsReachableFromSomeFiringLayer(t *testing.T) {
	reachable := map[string]bool{}
	for _, l := range []int{1, 2, 3, 4} {
		reachable[BucketFor([]int{l})] = true
	}
	for _, want := range []string{"weak", "medium", "strong"} {
		if !reachable[want] {
			t.Errorf("bucket %q is unreachable from any firing layer; reachable set = %v", want, reachable)
		}
	}
}
```

- [ ] **Step 4: Delete the throwaway test from Step 1**

Remove `TestMediumBucketIsUnreachableFromAnyLayer` entirely. It asserted the defect; keeping it would fail once layer 2 reaches `medium`, and `TestEveryBucketIsReachableFromSomeFiringLayer` is its inverse.

- [ ] **Step 5: Run the new tests to verify they fail**

Run:
```powershell
go test ./pkg/jarvisattrib/ -run "TestBucketFor|TestEveryBucket" -v
```
Expected: **FAIL to compile** with `undefined: BucketFor`.

- [ ] **Step 6: Add `strongestLayer` and `BucketFor`, delete the float cutoffs**

In `pkg/jarvisattrib/edges.go`, delete this block entirely (currently lines 24-28):

```go
// Confidence display bucket cutoffs — PLACEHOLDER.
const (
	bucketWeakMax   = 0.4
	bucketStrongMin = 0.75
)
```

Fix the now-dangling reference in the layer-weight comment (line 21): `weightLayer4 = 0.2 // semantic similarity — below bucketWeakMax, always renders "weak"` becomes:

```go
	weightLayer4 = 0.2 // semantic similarity — always renders "weak" (see BucketFor)
```

Replace `Bucket` (currently lines 108-117) with:

```go
// strongestLayer returns the lowest layer number present — layer 1 is the strongest signal — or 0
// when there are none.
func strongestLayer(layers []int) int {
	best := 0
	for _, l := range layers {
		if best == 0 || l < best {
			best = l
		}
	}
	return best
}

// BucketFor maps an edge's firing layers to its display bucket. It reads the layers rather than the
// confidence float because confidenceFor takes the MAX of four fixed layer weights and never blends
// them: the reachable confidence set is {0.2, 0.3, 0.8, 1.0}, so a float-threshold bucket had a band
// no edge could occupy. One mapping over what actually fires cannot drift out of sync with itself the
// way two coupled constant sets did. No layers means no signal, so the bucket is absent rather than a
// fabricated "weak" — the contract wshrpctypes_jarvis.go documents for a detached edge.
func BucketFor(layers []int) string {
	switch strongestLayer(layers) {
	case 1:
		return "strong" // canonical dispatch reference
	case 2:
		return "medium" // identifier (ticket) match
	case 3, 4:
		return "weak" // structural correlation, semantic similarity
	default:
		return ""
	}
}
```

Then rewrite `provenanceFor` (currently lines 88-106) to share the one definition of "strongest layer" instead of repeating the minimum-finding loop:

```go
// provenanceFor maps an edge to the provenance of its strongest (lowest-numbered) firing layer.
func provenanceFor(layers []int) string {
	switch strongestLayer(layers) {
	case 1:
		return provDispatch
	case 2:
		return provTicket
	case 3:
		return provStructural
	default:
		return provSemantic
	}
}
```

This preserves current behaviour for an empty layer list: today the local minimum stays at `1 << 30` and falls through to `default`, returning `provSemantic`; with `strongestLayer` returning 0 it still falls through to `default`, returning `provSemantic`.

- [ ] **Step 7: Update the other in-package caller**

In `pkg/jarvisattrib/semantic_test.go`, line 23 becomes:

```go
	if got := BucketFor([]int{4}); got != "weak" {
		t.Fatalf("BucketFor([4]) = %q, want weak", got)
	}
```

- [ ] **Step 8: Run the package tests**

Run:
```powershell
go test ./pkg/jarvisattrib/ -v
```
Expected: **PASS**, all tests including `TestBucketForIsTotalOverFiringLayers` and `TestEveryBucketIsReachableFromSomeFiringLayer`.

- [ ] **Step 9: Update the three wshserver call sites**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, replace lines 588-593 — the `if len(e.Layers) > 0` guard collapses into the function, which is now total over layers:

```go
		// BucketFor yields "" for an edge with no layers, which is the point here: Detach strips the
		// ref, so the signal behind a detached layer-1 edge is gone and any bucket would assert a
		// strength this row does not have.
		bucket := jarvisattrib.BucketFor(e.Layers)
```

At line 747 (inside `buildDossierGraph`):
```go
			Bucket:     jarvisattrib.BucketFor(e.Layers),
```

At line 865 (the ambient edge encoding):
```go
					Bucket:     jarvisattrib.BucketFor(e.Layers),
```

- [ ] **Step 10: Confirm no caller of the removed function remains**

Run:
```powershell
go build ./... ; grep -rn "jarvisattrib.Bucket(" --include=*.go .
```
Expected: build succeeds, grep returns **no matches**.

- [ ] **Step 11: Run the affected packages**

Run:
```powershell
go test ./pkg/jarvisattrib/ ./pkg/wshrpc/wshserver/ -v
```
Expected: **PASS**. `wshserver_ambient_test.go:70,73` and `wshserver_graph_test.go:96,99` assert `Bucket` values of `"strong"` and `"weak"` from layer-1 and layer-4 edges respectively — both unchanged by this mapping, so they must still pass. If either fails, the layer plumbing at the call site is wrong.

---

## Task 2: The proactive gate queries and shortlists per collection

**Files:**
- Modify: `pkg/jarvisproactive/gate.go:15-29` (tunables), `:52-82` (`prefilter`)
- Modify: `pkg/jarvisproactive/proactive.go:73`
- Modify: `pkg/jarvisproactive/gate_test.go`
- Modify: `pkg/jarvisproactive/proactive_test.go`

**Interfaces:**
- Consumes: `jarvisembed.Index.QueryPerCollection(ctx context.Context, v *wavevault.Vault, queryText string, kPerColl int, scope wavevault.Scope) ([]ScoredChunk, error)` — already exists at `pkg/jarvisembed/index.go:150`, merges per-collection windows score-descending. `jarvisembed.ScoredChunk{NodeID, Collection, SectionHeading, SectionIdx string/int, Snippet string, Score float32}`.
- Produces: renamed constant `queryKPerCollection = 8` replacing `queryK`. `prefilter(chunks []jarvisembed.ScoredChunk, excludeNodeID string) []candidate` keeps its signature and its return type; only its ordering changes.

- [ ] **Step 1: Write the failing round-robin test**

Add to `pkg/jarvisproactive/gate_test.go`. The existing `chunk(id, coll, heading, snippet, score)` helper at line 13 is reused. Six memory chunks outscore the one dossier and one decision, and all eight clear `cosThreshold` 0.40.

```go
// The memory collection outnumbers tasks and decisions by more than an order of magnitude on a real
// vault (measured 406 / 14 / 4), so taking candidates in raw score order lets memory's depth fill
// every shortlist slot and the model judge never sees a dossier or a decision. Emitting round-robin
// across collections is what makes the per-collection query in evaluate actually reach the judge.
func TestPrefilterRoundRobinsAcrossCollections(t *testing.T) {
	in := []jarvisembed.ScoredChunk{
		chunk("mem1", "memory", "Note 1", "cache note one", 0.99),
		chunk("mem2", "memory", "Note 2", "cache note two", 0.98),
		chunk("mem3", "memory", "Note 3", "cache note three", 0.97),
		chunk("mem4", "memory", "Note 4", "cache note four", 0.96),
		chunk("mem5", "memory", "Note 5", "cache note five", 0.95),
		chunk("mem6", "memory", "Note 6", "cache note six", 0.94),
		chunk("dos1", "tasks", "Cache dossier", "the prior cache task", 0.72),
		chunk("dec1", "decisions", "Cache decision", "the prior cache decision", 0.71),
	}
	got := prefilter(in, "")
	if len(got) != shortlistMax {
		t.Fatalf("want a full shortlist of %d, got %d: %+v", shortlistMax, len(got), got)
	}
	types := map[string]bool{}
	for _, c := range got {
		types[c.SourceType] = true
	}
	for _, want := range []string{"dossier", "decision"} {
		if !types[want] {
			t.Errorf("%q never reached the shortlist; got %v", want, shortlistFingerprint(got))
		}
	}
}

// shortlistFingerprint renders a shortlist compactly for failure messages.
func shortlistFingerprint(cands []candidate) []string {
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		out = append(out, c.SourceType+":"+c.NodeID)
	}
	return out
}
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvisproactive/ -run TestPrefilterRoundRobinsAcrossCollections -v
```
Expected: **FAIL** — `"dossier" never reached the shortlist; got [memory:mem1 memory:mem2 memory:mem3 memory:mem4 memory:mem5]`, and the same for `"decision"`.

- [ ] **Step 3: Rewrite `prefilter` to bucket by collection and emit round-robin**

Replace `prefilter` and its doc comment (`pkg/jarvisproactive/gate.go:52-82`) with:

```go
// prefilter keeps chunks scoring >= cosThreshold, drops the dispatching run's own node
// (excludeNodeID), dedupes by node id (a node may chunk into several sections), and caps at
// shortlistMax. Deterministic, no model, no I/O.
//
// Candidates are emitted round-robin across collections, best-first within each. Taking them in raw
// score order would re-impose the global ranking that QueryPerCollection removes one stage earlier:
// memory outnumbers tasks and decisions by more than an order of magnitude on a real vault, so its
// depth would fill every slot handed to the judge. Input order within a collection is already
// score-descending (QueryPerCollection merges that way), so preserving it keeps each collection's
// best hit first. Collections are visited in order of their single best hit, so the most on-topic
// one leads.
func prefilter(chunks []jarvisembed.ScoredChunk, excludeNodeID string) []candidate {
	seen := map[string]bool{}
	byColl := map[string][]candidate{}
	var collOrder []string
	for _, c := range chunks {
		if c.Score < cosThreshold {
			continue
		}
		if c.NodeID == excludeNodeID || seen[c.NodeID] {
			continue
		}
		seen[c.NodeID] = true
		title := strings.TrimSpace(c.SectionHeading)
		if title == "" {
			title = c.NodeID
		}
		if _, ok := byColl[c.Collection]; !ok {
			collOrder = append(collOrder, c.Collection)
		}
		byColl[c.Collection] = append(byColl[c.Collection], candidate{
			NodeID:     c.NodeID,
			SourceType: sourceTypeFor(c.Collection),
			Title:      title,
			Snippet:    strings.TrimSpace(c.Snippet),
			Score:      c.Score,
		})
	}
	var out []candidate
	for i := 0; ; i++ {
		before := len(out)
		for _, coll := range collOrder {
			if i >= len(byColl[coll]) {
				continue
			}
			out = append(out, byColl[coll][i])
			if len(out) >= shortlistMax {
				return out
			}
		}
		if len(out) == before {
			return out
		}
	}
}
```

- [ ] **Step 4: Run the gate tests to verify they pass**

Run:
```powershell
go test ./pkg/jarvisproactive/ -run TestPrefilter -v
```
Expected: **PASS** for all three — the new `TestPrefilterRoundRobinsAcrossCollections` plus the two existing ones. `TestPrefilterThresholdAndCap` must still pass unchanged: its input is one decisions chunk then one tasks chunk, so `collOrder` is `[decisions, tasks]` and round-robin still yields `a` then `b`. `TestPrefilterSelfExclusion` excludes the tasks node before it is bucketed, leaving only `decisions`.

- [ ] **Step 5: Write the failing end-to-end crowding test**

Add to `pkg/jarvisproactive/proactive_test.go`. This proves the *query* is per-collection: with a single global top-8, ten higher-scoring memory notes mean the dossier is never retrieved at all, so no amount of downstream reordering can surface it.

```go
// gradedEmbedder leans a text onto the query axis in proportion to how often it says "cache", so
// several nodes clear cosThreshold while still ranking in a controlled order. Cosine against a
// 3-mention query: 3 mentions ~1.00, 2 ~0.99, 1 ~0.89, 0 ~0.32 (below the 0.40 gate). mockEmbedder is
// binary and cannot express "retrieved but outranked", which is the state under test here.
type gradedEmbedder struct{}

func (gradedEmbedder) Model() string { return "graded-1" }
func (gradedEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		out[i] = []float32{float32(strings.Count(strings.ToLower(t), "cache")), 1, 0}
	}
	return out, nil
}

func newTestVaultAt(t *testing.T) (*wavevault.Vault, string) {
	t.Helper()
	dir := t.TempDir()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), dir)
	if err != nil {
		t.Fatalf("open test vault: %v", err)
	}
	return v, dir
}

func writeMemoryNote(t *testing.T, dir, id, body string) {
	t.Helper()
	path := filepath.Join(dir, "memory", id+".md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir memory: %v", err)
	}
	content := fmt.Sprintf("---\nid: %s\n---\n\n## Note\n\n%s\n", id, body)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// A global top-k window cannot see past a collection that outnumbers the others. Ten memory notes
// each mention "cache" three times and so score ~1.00; the dossier mentions it once and scores ~0.89.
// With one global window of 8 the dossier is never retrieved at all, so no amount of downstream
// reordering could surface it — which is why this asserts on what the judge was actually offered
// rather than on the final suggestion.
func TestEvaluateReachesDossierBehindCrowdedMemory(t *testing.T) {
	ctx := context.Background()
	v, dir := newTestVaultAt(t)
	for i := 0; i < 10; i++ {
		writeMemoryNote(t, dir, fmt.Sprintf("m%d", i), "cache cache cache eviction trivia")
	}
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Objective: "fix the cache invalidation bug",
	}); err != nil {
		t.Fatalf("seed dossier: %v", err)
	}
	if err := v.Commit(ctx, "seed"); err != nil {
		t.Fatalf("commit: %v", err)
	}

	var judgePrompt string
	restore := SetJudgeForTest(func(_ context.Context, _, prompt string) (string, error) {
		judgePrompt = prompt
		return "none", nil
	})
	defer restore()

	run := &waveobj.Run{OID: "run-crowd", Goal: "cache cache cache invalidation", ProjectPath: t.TempDir()}
	sug, err := evaluate(ctx, newTestIndex(t, gradedEmbedder{}), v, run)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if sug == nil {
		t.Fatal("evaluate must always return a record")
	}
	if sug.Reason == ReasonNoCandidates {
		t.Fatal("nothing reached the judge: the semantic window was filled entirely by memory notes")
	}
	if !strings.Contains(judgePrompt, "[dossier]") {
		t.Fatalf("the dossier never reached the judge's shortlist; prompt was:\n%s", judgePrompt)
	}
}
```

`buildJudgePrompt` renders each candidate as `N. [<sourceType>] <title> — <snippet>`, and
`sourceTypeFor` maps the `tasks` collection to `dossier`, so `[dossier]` appearing in the prompt is
the assertion that a dossier chunk survived retrieval, the score floor and the shortlist truncation.

Add `"fmt"` and `"os"` to the import block of `proactive_test.go`; `path/filepath` and `strings` are
already imported at lines 8-9.

- [ ] **Step 6: Run it to verify it fails**

Run:
```powershell
go test ./pkg/jarvisproactive/ -run TestEvaluateReachesDossierBehindCrowdedMemory -v
```
Expected: **FAIL** with `the dossier never reached the judge's shortlist` (or `nothing reached the judge` if all ten memory notes are what survived). Either failure proves the global window starves the tasks collection.

- [ ] **Step 7: Switch the query to per-collection and rename the constant**

In `pkg/jarvisproactive/gate.go`, replace the tunables block (lines 15-29). Keep the whole `cosThreshold` calibration history — it is measured evidence — and correct only the trailing sentence about what remains uncalibrated:

```go
// Gate tunables. cosThreshold was calibrated 2026-07-27 against the real vault (647 chunks,
// text-embedding-3-small via OpenRouter): across five probe queries the best on-topic hit was 0.4579
// and an off-topic control topped out at 0.2342, so the whole usable range sits near 0.23–0.46. The
// previous 0.82 was set as if comparing a query to a near-paraphrase (which does score ~0.85), but
// retrieval compares a short query against a long chunk and those cosines run about half that — at
// 0.82 the gate admitted nothing at all and the proactive card could never fire.
//
// 0.40 keeps the "deliberately high bar" intent (it fired on 2 of the 5 probe queries) while being
// reachable. It is model-specific: switching jarvis:embedmodel shifts the distribution and this needs
// re-measuring.
//
// queryKPerCollection is per collection, not global: one global window of this size is filled by the
// memory collection alone on a real vault (406 memory / 14 tasks / 4 decisions), which starved
// dossiers and decisions out of the judge's shortlist entirely. It is unfitted, and with the score
// floor and prefilter's round-robin now bounding what reaches the judge, k is not what constrains
// admission. shortlistMax is likewise unfitted.
const (
	queryKPerCollection = 8    // semantic candidates requested from the index, per collection
	cosThreshold        = 0.40 // minimum cosine to survive the pre-filter
	shortlistMax        = 5    // max candidates handed to the model judge
)
```

In `pkg/jarvisproactive/proactive.go`, line 73 becomes:

```go
	chunks, err := ix.QueryPerCollection(ctx, v, run.Goal, queryKPerCollection, wavevault.AllScope())
```

- [ ] **Step 8: Run the full package to verify everything passes**

Run:
```powershell
go test ./pkg/jarvisproactive/ -v
```
Expected: **PASS** for every test, including the new `TestEvaluateReachesDossierBehindCrowdedMemory` and all five pre-existing `TestEvaluate*` tests, which use the binary `mockEmbedder` and a single-node vault and are unaffected by per-collection fan-out.

- [ ] **Step 9: Prove the test pins both halves, not just the query**

Temporarily revert **only** `prefilter`'s round-robin (restore raw score order by appending directly to `out` instead of bucketing) while leaving `QueryPerCollection` in place, then run:
```powershell
go test ./pkg/jarvisproactive/ -run "TestPrefilterRoundRobins|TestEvaluateReachesDossier" -v
```
Expected: **both FAIL**. This is the check that matters — the spec's claim is that fixing the query alone is insufficient, and this demonstrates it. Restore the round-robin implementation and re-run to confirm both pass again.

---

## Task 3: A repeatable corpus probe that costs no provider spend

**Files:**
- Create: `pkg/jarvisattrib/liveprobe_test.go`

**Interfaces:**
- Consumes: `BucketFor(layers []int) string` from Task 1. `AllEdges(ctx context.Context, v *wavevault.Vault) (map[string][]AttributedEdge, error)` at `pkg/jarvisattrib/lifecycle.go:308`, keyed by dossier id. `AttributedEdge{DossierID, RunORef, Provenance string, Layers []int, Confidence float64, State EdgeState}`. Unexported `gatherLookups(ctx) (edgeLookups, []*waveobj.Run, error)` at `pkg/jarvisattrib/lifecycle.go:293` — callable because the probe is in-package. `waveobj.Run{OID, Goal string, CreatedTs, CompletedTs int64}`. `nowFn() int64` at `pkg/jarvisattrib/edges.go:45`. `probationMs`, `timeBoxMs` from `edges.go:31-34`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Create the probe file**

Create `pkg/jarvisattrib/liveprobe_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build liveprobe

// Corpus probe for the attribution engine (sub-project D). It measures the shape of the real edge
// corpus so the tuning-constants entry (J5) in docs/jarvis-second-brain-open-issues.md can be
// re-checked cheaply instead of by another ad-hoc pass — which matters because timeBoxMs becomes
// measurable by waiting rather than by collecting more data.
//
// It costs NO provider spend by construction: every figure is deterministic, and the semantic layer
// (L4) is the only thing here that could embed anything. L4 runs only for a dossier with no
// deterministic edge at all, so the orphan count this probe reports is also the answer to "could this
// have spent anything" — zero orphans means zero embedding calls.
//
//	CGO_ENABLED=1 CGO_CFLAGS="-O2 -g -I<repo>/pkg/jarvisembed/csrc" \
//	WAVETERM_CONFIG_HOME=<copy>/config WAVETERM_DATA_HOME=<copy>/data \
//	go test -tags liveprobe,osusergo,sqlite_omit_load_extension -run TestLiveCorpusShape -v ./pkg/jarvisattrib/
//
// Point the homes at a COPY of a real profile: snapshot the wstore DB with `VACUUM INTO` (consistent
// against a live app, unlike a file copy) and delete the stale -wal/-shm sidecars before pointing at
// it — applying those to a different database corrupts it.
package jarvisattrib

import (
	"context"
	"sort"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const msPerDay = 24 * 60 * 60 * 1000

func TestLiveCorpusShape(t *testing.T) {
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("bootstrap: %v (set WAVETERM_CONFIG_HOME and WAVETERM_DATA_HOME)", err)
	}
	wconfig.GetWatcher().Start()
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("init wstore against the profile copy: %v", err)
	}
	ctx := context.Background()
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	t.Logf("profile: config=%s data=%s", wavebase.GetWaveConfigDir(), wavebase.GetWaveDataDir())
	t.Logf("embeddings available=%v (L4 fires only for a dossier with zero deterministic edges)",
		jarvisembed.Available())

	byDossier, err := AllEdges(ctx, v)
	if err != nil {
		t.Fatalf("AllEdges: %v", err)
	}

	perLayer := map[int]int{}
	confHist := map[float64]int{}
	bucketHist := map[string]int{}
	stateHist := map[string]int{}
	runORefs := map[string]bool{}
	var perDossier []int
	var total int
	for _, edges := range byDossier {
		perDossier = append(perDossier, len(edges))
		for _, e := range edges {
			total++
			runORefs[e.RunORef] = true
			for _, l := range e.Layers {
				perLayer[l]++
			}
			confHist[e.Confidence]++
			bucketHist[BucketFor(e.Layers)]++
			stateHist[string(e.State)]++
		}
	}
	sort.Ints(perDossier)

	t.Logf("dossiers=%d attributedRuns=%d totalEdges=%d", len(byDossier), len(runORefs), total)
	t.Logf("edges per dossier: %v", perDossier)
	t.Logf("by layer: %v", perLayer)
	t.Logf("confidence histogram: %v", confHist)
	t.Logf("bucket histogram: %v", bucketHist)
	t.Logf("state histogram: %v", stateHist)

	// The empty middle is the finding that blocks calibrating the bucket cutoffs and weightLayer2/4.
	// Log it as a first-class result so a future run can tell at a glance whether it has changed.
	if len(confHist) <= 2 {
		t.Logf("confidence space is still degenerate (%d distinct values): no discrimination pressure "+
			"on any weight or cutoff", len(confHist))
	}

	// The traversal caps: seedTopK 6 and expandFanout 8 were never observed binding. Report the real
	// maximum so "the cap never binds" stays a measurement rather than an assumption.
	maxEdges := 0
	if len(perDossier) > 0 {
		maxEdges = perDossier[len(perDossier)-1]
	}
	t.Logf("max edges on one dossier=%d (expandFanout=%d binds only above this)", maxEdges, expandFanoutRef())

	// Lifecycle windows. AttributedEdge carries no timestamp, so probation and the time box are
	// measured against the runs the edges point at — which is what lifecycle itself compares.
	_, runs, err := gatherLookups(ctx)
	if err != nil {
		t.Fatalf("gatherLookups: %v", err)
	}
	now := nowFn()
	var inProbation, pastTimeBox, undated int
	oldestAgeMs := int64(0)
	for _, r := range runs {
		ts := r.CompletedTs
		if ts == 0 {
			ts = r.CreatedTs
		}
		if ts == 0 {
			undated++
			continue
		}
		age := now - ts
		if age > oldestAgeMs {
			oldestAgeMs = age
		}
		if age < probationMs {
			inProbation++
		}
		if age > timeBoxMs {
			pastTimeBox++
		}
	}
	t.Logf("runs=%d undated=%d inProbation(<%dh)=%d pastTimeBox(>%dd)=%d oldestRunAge=%.1fd",
		len(runs), undated, probationMs/(60*60*1000), inProbation, timeBoxMs/msPerDay,
		pastTimeBox, float64(oldestAgeMs)/float64(msPerDay))
	if pastTimeBox == 0 {
		t.Logf("timeBoxMs is still unexercised: no run is older than %d days, so no layer-3 edge has "+
			"had the chance to decay", timeBoxMs/msPerDay)
	}

	if total == 0 {
		t.Fatal("no attributed edges: the profile copy is empty or the vault path is wrong, so every " +
			"figure above is vacuous")
	}
}

// expandFanoutRef reports jarvisrecall's traversal fan-out cap without importing that package (which
// would be an import cycle through the recall engine). Keep in sync with jarvisrecall.expandFanout.
func expandFanoutRef() int { return 8 }
```

- [ ] **Step 2: Verify the probe compiles under its build tag**

Run:
```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go vet -tags liveprobe,osusergo,sqlite_omit_load_extension ./pkg/jarvisattrib/
```
Expected: **no output** (success). If `gatherLookups` or `edgeLookups` has a different arity than the interfaces block above states, fix the call — the probe is in-package, so the compiler is the authority.

- [ ] **Step 3: Verify the normal test suite is unaffected**

Run:
```powershell
go test ./pkg/jarvisattrib/ -v
```
Expected: **PASS**, and the probe does **not** appear in the output — the `liveprobe` build tag excludes it.

- [ ] **Step 4: Snapshot the installed profile**

The dev profile's runs are unrelated to the vault's dossiers, so probing it renders a vacuous zero. Snapshot the installed profile instead. In PowerShell, with `<snap>` a fresh empty directory under the scratch area:

```powershell
$src  = "$env:LOCALAPPDATA\dev.arc.app\data"
$snap = "$env:TEMP\jarvis-corpus-probe"
New-Item -ItemType Directory -Force "$snap\data" | Out-Null
Copy-Item "$env:LOCALAPPDATA\dev.arc.app\config" "$snap\config" -Recurse -Force
sqlite3 "$src\waveterm.db" "VACUUM INTO '$snap\data\waveterm.db'"
Get-ChildItem "$snap\data" -Filter "waveterm.db-*" | Remove-Item -Force
```

`VACUUM INTO` is required rather than a file copy because the installed app may be running; copying a live database with its write-ahead log detached yields an inconsistent snapshot. Deleting the `-wal`/`-shm` sidecars is required for the same reason — applying another database's log corrupts this one.

- [ ] **Step 5: Run the probe and record its output**

Run:
```powershell
$env:WAVETERM_CONFIG_HOME = "$env:TEMP\jarvis-corpus-probe\config"
$env:WAVETERM_DATA_HOME   = "$env:TEMP\jarvis-corpus-probe\data"
go test -tags liveprobe,osusergo,sqlite_omit_load_extension -run TestLiveCorpusShape -v ./pkg/jarvisattrib/
```
Expected: **PASS**, with the histograms logged. Capture the full log output — Task 4 records these numbers in the tracker. If it fails with `no attributed edges`, the config/data homes are pointing at the wrong profile; do not record vacuous numbers as a result.

Note the reported `embeddings available` line. If it says `true` **and** any dossier has zero deterministic edges, the semantic layer may have made embedding calls; say so when reporting rather than claiming the run was free.

---

## Task 4: Rewrite the tuning-constants tracker entry, then one commit

**Files:**
- Modify: `docs/jarvis-second-brain-open-issues.md` (the summary table and the J5 entry)
- Modify: `docs/deferred.md` (the retired bucket-cutoff line)

**Interfaces:**
- Consumes: the probe output from Task 3 Step 5. Every number written here must come from that run, not from the 2026-07-27 figures already in the file.

- [ ] **Step 1: Record both defects in the summary table**

In `docs/jarvis-second-brain-open-issues.md`, the row for the tuning-constants item (J5) currently reads `🔲 Open — semantic window fitted 2026-07-27 (10/10 end-to-end); rest of the inventory stands`. Update its status to name what closed on 2026-08-03: the layer-derived confidence bucket and the per-collection proactive window. Keep it **Open** — the remaining constants are unchanged.

Add two rows for the defects so they are not re-discovered as calibration work:

| # | Issue | Kind | Effort | Blocked by | Status |
|---|---|---|---|---|---|
| J10 | Display bucket re-derived from a float that only ever holds four values — the "medium" band was unreachable | correctness | S | — | ✅ Resolved 2026-08-03 |
| J11 | Proactive-resurfacing gate queried one global semantic window, so memory starved dossiers and decisions out of the judge's shortlist | correctness / reachability | S | — | ✅ Resolved 2026-08-03 |

- [ ] **Step 2: Restructure the J5 entry into three categories**

Replace the scattered "still uncalibrated" lists with one section per category. Every constant currently named anywhere in the entry must appear in exactly one of them:

1. **Fitted** — `semSeedFloor` 0.325, `kSemPerCollection` 6, `cosThreshold` 0.40, `semThreshold` 0.65. Each keeps its existing evidence paragraph and its model-specificity caveat.
2. **Unmeasurable by construction** — `weightLayer2` (needs a ticket id; no run in the recorded history carries one), `weightLayer4` (needs the layer-1–3 gate to fall silent, which dogfooding does not produce — the counterfactual measurement already in the file stands). State plainly that more data does not help either, so neither is waiting on anything.
3. **Awaiting a named trigger** — `timeBoxMs` (roughly 2026-08-19, per the probe's `oldestRunAge`), `weightLayer3` (a human ground-truth labeling pass), `seedTopK` / `expandDepth` / `expandFanout` / `maxCandidates` / `semCandidateN` / `queryKPerCollection` / `shortlistMax` (a measured latency or relevance complaint; the probe's `max edges on one dossier` figure shows whether the traversal caps bind at all).

Retire the bucket-cutoff line from the constant inventory table (`bucketWeakMax` 0.4, `bucketStrongMin` 0.75) rather than moving it to a category — those constants no longer exist. Replace the table cell with a note that the cutoffs were **deleted, not calibrated**, and why.

Insert the Task 3 probe output verbatim as a dated measurement block, and name the probe file so the next run is a command rather than a re-derivation.

- [ ] **Step 3: Update `docs/deferred.md`**

Find the section recording the bucket-cutoff deferral (under sub-project D) and mark it retired on 2026-08-03, naming the reason: the cutoffs were removed because the bucket is now derived from the firing layer, so there is nothing left to calibrate. Do the same for the proactive gate's `queryK` line, which is now per-collection.

- [ ] **Step 4: Run the full backend suite**

Run:
```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/...
```
Expected: **PASS** across all packages. This is the gate before proposing a commit; do not skip it because the individual packages passed earlier.

- [ ] **Step 5: Self-review the diff**

Run:
```bash
git diff
git status --short
```
Check: no commented-out code, no debug logging, no leftover throwaway test from Task 1 Step 1, no stray `jarvisattrib.Bucket(` reference, and no changes to generated files (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`) or to any frontend file.

- [ ] **Step 6: Ask for commit approval, then commit once**

**Do not commit before asking.** Present the diff summary and the probe numbers, and ask whether to commit. Only on explicit approval, run — noting that the design spec folds into this same commit rather than a separate docs-only one, per the repo owner's rule:

```bash
git add pkg/jarvisattrib/ pkg/jarvisproactive/ pkg/wshrpc/wshserver/wshserver_jarvis.go docs/jarvis-second-brain-open-issues.md docs/deferred.md docs/superpowers/specs/2026-08-03-jarvis-confidence-bucket-and-proactive-window-design.md docs/superpowers/plans/2026-08-03-jarvis-confidence-bucket-and-proactive-window.md
git commit -m "fix(jarvis): a confidence bucket is which signal fired, so it stops being read off a float that never lands in the middle" -m "The display bucket was derived from a confidence float that confidenceFor can only ever set to one of four fixed layer weights, so the medium band [0.4, 0.75) was unreachable and the graph's middle styling case was dead. BucketFor now maps the firing layer directly, and the float cutoffs are gone rather than calibrated." -m "The proactive gate asked for one global semantic window, which memory fills on a real vault (406 memory / 14 tasks / 4 decisions), so dossiers and decisions never reached the model judge. It now uses the per-collection window the recall path already had, and shortlists round-robin across collections so the crowding cannot reappear at the truncation step."
```

Do **not** add a `Co-Authored-By` trailer — the repo owner's rule is not to add one.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the layer-derived bucket → Task 1; the per-collection proactive query *and* the round-robin shortlist → Task 2 (Steps 3 and 7 respectively, with Step 9 proving both are needed); the no-cost corpus probe → Task 3; the three-category tracker rewrite → Task 4 Step 2. The spec's "paid semantic re-measure is a separate checkpoint" is honoured by omission — no task embeds or queries the index against a real provider, and Task 3's header states why the probe is free.

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code. The one number not yet known is the probe output, which Task 4 Step 2 consumes from Task 3 Step 5 rather than inventing.

**Type consistency.** `BucketFor(layers []int) string` is defined in Task 1 Step 6 and used in Task 1 Steps 7/9 and Task 3 Step 1 with the same signature. `strongestLayer(layers []int) int` is defined once and used by both `BucketFor` and `provenanceFor`. `queryKPerCollection` is introduced in Task 2 Step 7 and used at the single call site in the same step. `prefilter`'s signature is unchanged, so the two pre-existing gate tests keep compiling. `shortlistFingerprint(cands []candidate) []string` is defined alongside its only caller in Task 2 Step 1.

**Known soft spot.** Task 3 Step 1 calls unexported `gatherLookups(ctx)` with the arity read from `pkg/jarvisattrib/lifecycle.go:293-296`; Step 2 exists specifically to catch a mismatch at compile time rather than at probe-run time.
