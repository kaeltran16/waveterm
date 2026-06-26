# Usage Backend Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frontend's capped/unreliable transcript scan with a backend command that aggregates usage from every in-window transcript file and returns small per-(provider, model, day) buckets the frontend prices and presents.

**Architecture:** New pure Go package `pkg/usagestats` (walk → modtime-prune → parse → dedup → drop `<synthetic>` → bucket), exposed via a new `GetUsageStatsCommand` wshrpc command. The frontend's `usagestore.ts` calls it instead of scanning files, aggregates buckets into the existing `UsageStats` shape (so the surface is unchanged), and keeps the last-good value on RPC failure. Pricing stays in `usagepricing.ts` (frontend, single source).

**Tech Stack:** Go (stdlib `encoding/json`, `path/filepath`, `time`), wshrpc codegen (`task generate`), React/jotai frontend, vitest + Go table tests.

> **Commit policy (overrides the skill's per-task commits):** Per the repo owner's CLAUDE.md, do NOT commit per task and NEVER commit without explicit approval. Each task ends with a **green checkpoint** (tests/typecheck pass), not a commit. Task 8 prepares ONE feature commit (code + this plan + the spec) and waits for approval.

---

## File Structure

| File | Responsibility |
|---|---|
| `pkg/usagestats/usagestats.go` (create) | Pure scan/parse/dedup/bucket + `ScanUsage(windowDays)` |
| `pkg/usagestats/usagestats_test.go` (create) | Table tests ported from `usagestats.test.ts` + prune/bucket |
| `pkg/wshrpc/wshrpctypes.go` (modify) | RPC interface method + `UsageBucket`/`CommandGetUsageStats*` structs |
| `pkg/wshrpc/wshserver/wshserver.go` (modify) | `GetUsageStatsCommand` impl (thin wrapper + map to wire type) |
| generated: `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts` | Produced by `task generate` — never hand-edit |
| `frontend/app/view/agents/usagestats.ts` (modify) | Drop extractors; add `aggregateBuckets(buckets, now)` |
| `frontend/app/view/agents/usagestats.test.ts` (modify) | Drop ported tests; add `aggregateBuckets` tests |
| `frontend/app/view/agents/usagestore.ts` (modify) | Call RPC; keep-last-good on error; `usageErrorAtom` |
| `frontend/app/view/agents/usagesurface.tsx` (modify) | Subtle "couldn't refresh" indicator |

`usagepricing.ts`, `usagepricing.test.ts`, `activitydiscovery.ts`, `activitystore.ts` are **untouched** (Activity still uses `discoverSessions`; pricing unchanged).

---

## Task 1: Go package — Claude parse + dedupe

**Files:**
- Create: `pkg/usagestats/usagestats.go`
- Test: `pkg/usagestats/usagestats_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// pkg/usagestats/usagestats_test.go
package usagestats

import (
	"testing"
	"time"
)

func TestExtractClaude(t *testing.T) {
	line := `{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"cache_creation":{"ephemeral_1h_input_tokens":150}}}}`
	got := extractClaude([]string{line})
	if len(got) != 1 {
		t.Fatalf("want 1 record, got %d", len(got))
	}
	r := got[0]
	if r.Provider != "claude" || r.Model != "claude-opus-4-8" {
		t.Errorf("provider/model = %q/%q", r.Provider, r.Model)
	}
	if r.Input != 100 || r.Output != 50 || r.CacheRead != 1000 || r.CacheCreate != 200 || r.CacheCreate1h != 150 {
		t.Errorf("tokens = %+v", r)
	}
	if r.ID != "msg_1:req_1" {
		t.Errorf("id = %q", r.ID)
	}
	if !r.TS.Equal(time.Date(2026, 6, 26, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("ts = %v", r.TS)
	}
}

func TestExtractClaudeSkips(t *testing.T) {
	cases := []string{
		`{"type":"user","message":{}}`,                                   // non-assistant
		`{not json`,                                                      // malformed
		`{"type":"assistant","message":{"model":"claude-opus-4"}}`,       // no usage/timestamp
	}
	if got := extractClaude(cases); len(got) != 0 {
		t.Fatalf("want 0, got %d", len(got))
	}
}

func TestExtractClaudeNoDedupKeyWhenMissing(t *testing.T) {
	line := `{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","message":{"id":"msg_1","model":"claude-opus-4","usage":{"output_tokens":5}}}`
	got := extractClaude([]string{line})
	if got[0].ID != "" {
		t.Errorf("want empty id, got %q", got[0].ID)
	}
}

func TestDedupe(t *testing.T) {
	mk := func(id string, out int) Record {
		return Record{ID: id, Provider: "claude", Model: "claude-opus-4", Input: 100, Output: out}
	}
	// same key -> keep max output
	got := dedupe([]Record{mk("k", 10), mk("k", 50), mk("k", 30)})
	if len(got) != 1 || got[0].Output != 50 {
		t.Fatalf("want 1 record out=50, got %+v", got)
	}
	// keyless records are all kept; distinct keys kept separate
	got = dedupe([]Record{mk("", 1), mk("", 2), mk("a", 1), mk("b", 1)})
	if len(got) != 4 {
		t.Fatalf("want 4, got %d", len(got))
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/usagestats/`
Expected: FAIL — `undefined: extractClaude`, `undefined: dedupe`, `undefined: Record`.

- [ ] **Step 3: Write the minimal implementation**

```go
// pkg/usagestats/usagestats.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package usagestats scans agent transcript JSONL on disk and aggregates per-message token
// usage into per-(provider, model, day) buckets for the Usage cockpit surface. Pure
// token-counting only — no pricing (the frontend prices via usagepricing.ts) and no
// presentation. Sibling to pkg/gitinfo.
package usagestats

import (
	"encoding/json"
	"time"
)

// Record is one parsed usage event. Token fields mirror the four Claude classes; Codex maps
// its cumulative totals onto the same shape (CacheCreate stays 0).
type Record struct {
	ID            string // "message.id:requestId" dedup key; empty when either is absent
	TS            time.Time
	Provider      string // "claude" | "codex"
	Model         string
	Input         int
	Output        int
	CacheRead     int
	CacheCreate   int
	CacheCreate1h int // subset of CacheCreate billed at the 1h extended-cache rate
}

// extractClaude parses Claude Code transcript lines: one record per type:"assistant" line that
// carries message.usage + message.model + a parseable timestamp. Malformed/incomplete lines are
// skipped. Mirrors extractUsage in usagestats.ts.
func extractClaude(lines []string) []Record {
	var out []Record
	for _, line := range lines {
		var rec struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
			RequestID string `json:"requestId"`
			Message   struct {
				ID    string `json:"id"`
				Model string `json:"model"`
				Usage *struct {
					InputTokens              int `json:"input_tokens"`
					OutputTokens             int `json:"output_tokens"`
					CacheReadInputTokens     int `json:"cache_read_input_tokens"`
					CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
					CacheCreation            *struct {
						Ephemeral1h int `json:"ephemeral_1h_input_tokens"`
					} `json:"cache_creation"`
				} `json:"usage"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		if rec.Type != "assistant" || rec.Message.Usage == nil || rec.Message.Model == "" {
			continue
		}
		ts, err := time.Parse(time.RFC3339, rec.Timestamp)
		if err != nil {
			continue
		}
		id := ""
		if rec.Message.ID != "" && rec.RequestID != "" {
			id = rec.Message.ID + ":" + rec.RequestID
		}
		c1h := 0
		if rec.Message.Usage.CacheCreation != nil {
			c1h = rec.Message.Usage.CacheCreation.Ephemeral1h
		}
		out = append(out, Record{
			ID: id, TS: ts, Provider: "claude", Model: rec.Message.Model,
			Input: rec.Message.Usage.InputTokens, Output: rec.Message.Usage.OutputTokens,
			CacheRead: rec.Message.Usage.CacheReadInputTokens, CacheCreate: rec.Message.Usage.CacheCreationInputTokens,
			CacheCreate1h: c1h,
		})
	}
	return out
}

// dedupe collapses records sharing an ID to the one with the largest Output (the final
// streaming snapshot; input/cache are constant across snapshots). Keyless records pass through.
// Mirrors dedupeUsage in usagestats.ts.
func dedupe(records []Record) []Record {
	byKey := map[string]Record{}
	var out []Record
	for _, r := range records {
		if r.ID == "" {
			out = append(out, r)
			continue
		}
		if cur, ok := byKey[r.ID]; !ok || r.Output > cur.Output {
			byKey[r.ID] = r
		}
	}
	for _, r := range byKey {
		out = append(out, r)
	}
	return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/usagestats/`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint** — `go vet ./pkg/usagestats/` clean; tests green. (No commit — see commit policy.)

---

## Task 2: Go package — Codex parse

**Files:**
- Modify: `pkg/usagestats/usagestats.go`
- Test: `pkg/usagestats/usagestats_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// append to usagestats_test.go
func TestExtractCodex(t *testing.T) {
	turn := `{"timestamp":"2026-06-26T03:07:50.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}`
	count := `{"timestamp":"2026-06-26T03:08:00.663Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9458,"cached_input_tokens":7040,"output_tokens":89,"total_tokens":9547}}}}`
	got := extractCodex([]string{turn, count})
	if len(got) != 1 {
		t.Fatalf("want 1, got %d", len(got))
	}
	r := got[0]
	if r.Provider != "codex" || r.Model != "gpt-5.5" {
		t.Errorf("provider/model = %q/%q", r.Provider, r.Model)
	}
	if r.Input != 9458-7040 || r.CacheRead != 7040 || r.Output != 89 || r.CacheCreate != 0 {
		t.Errorf("tokens = %+v", r)
	}
	if total := r.Input + r.Output + r.CacheRead + r.CacheCreate; total != 9547 {
		t.Errorf("tokensOf = %d, want 9547", total)
	}
}

func TestExtractCodexMaxCumulative(t *testing.T) {
	turn := `{"type":"turn_context","payload":{"model":"gpt-5.5"}}`
	small := `{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}`
	big := `{"timestamp":"2026-06-26T03:20:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":1000,"output_tokens":500,"total_tokens":5500}}}}`
	got := extractCodex([]string{turn, small, big})
	if len(got) != 1 {
		t.Fatalf("want 1, got %d", len(got))
	}
	if total := got[0].Input + got[0].Output + got[0].CacheRead; total != 5500 {
		t.Errorf("want total 5500, got %d", total)
	}
}

func TestExtractCodexFallbackModelAndJunk(t *testing.T) {
	count := `{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}}`
	if got := extractCodex([]string{count}); got[0].Model != "codex" {
		t.Errorf("want fallback model codex, got %q", got[0].Model)
	}
	junk := []string{`{not json`, `{"type":"event_msg","payload":{"type":"token_count","info":null}}`, `{"type":"response_item","payload":{}}`}
	if got := extractCodex(junk); len(got) != 0 {
		t.Fatalf("want 0 from junk, got %d", len(got))
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/usagestats/ -run Codex`
Expected: FAIL — `undefined: extractCodex`.

- [ ] **Step 3: Write the minimal implementation**

```go
// append to usagestats.go (add no new imports)

// extractCodex parses a Codex rollout file. Token usage is in event_msg/token_count lines as a
// CUMULATIVE total_token_usage; the model is on a preceding turn_context line. We take the MAX
// cumulative (Codex's own session total), and cached_input_tokens is a subset of input_tokens
// (so Input = input - cached). One record per file. Mirrors extractCodexUsage in usagestats.ts.
func extractCodex(lines []string) []Record {
	model := "codex"
	var best *Record
	bestTotal := 0
	for _, line := range lines {
		var rec struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
			Payload   struct {
				Type  string `json:"type"`
				Model string `json:"model"`
				Info  struct {
					TotalTokenUsage *struct {
						InputTokens       int `json:"input_tokens"`
						CachedInputTokens int `json:"cached_input_tokens"`
						OutputTokens      int `json:"output_tokens"`
						TotalTokens       int `json:"total_tokens"`
					} `json:"total_token_usage"`
				} `json:"info"`
			} `json:"payload"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		if rec.Type == "turn_context" {
			if rec.Payload.Model != "" {
				model = rec.Payload.Model
			}
			continue
		}
		if rec.Type != "event_msg" || rec.Payload.Type != "token_count" {
			continue
		}
		tu := rec.Payload.Info.TotalTokenUsage
		if tu == nil {
			continue
		}
		ts, err := time.Parse(time.RFC3339, rec.Timestamp)
		if err != nil {
			continue
		}
		total := tu.TotalTokens
		if total == 0 {
			total = tu.InputTokens + tu.OutputTokens
		}
		if best == nil || total > bestTotal {
			input := tu.InputTokens - tu.CachedInputTokens
			if input < 0 {
				input = 0
			}
			best = &Record{TS: ts, Provider: "codex", Model: model, Input: input, Output: tu.OutputTokens, CacheRead: tu.CachedInputTokens}
			bestTotal = total
		}
	}
	if best == nil {
		return nil
	}
	return []Record{*best}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/usagestats/`
Expected: PASS (7 tests).

- [ ] **Step 5: Checkpoint** — tests green, `go vet ./pkg/usagestats/` clean.

---

## Task 3: Go package — bucket + ScanUsage (prune by modtime)

**Files:**
- Modify: `pkg/usagestats/usagestats.go`
- Test: `pkg/usagestats/usagestats_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// append to usagestats_test.go
import (  // extend the existing import block
	"os"
	"path/filepath"
)

func TestBucketDropsSyntheticAndGroups(t *testing.T) {
	day := time.Date(2026, 6, 26, 10, 0, 0, 0, time.Local)
	recs := []Record{
		{Provider: "claude", Model: "claude-opus-4-8", TS: day, Input: 100, Output: 50},
		{Provider: "claude", Model: "claude-opus-4-8", TS: day, CacheRead: 10},
		{Provider: "claude", Model: "<synthetic>", TS: day, Output: 999},
	}
	got := bucket(recs)
	if len(got) != 1 {
		t.Fatalf("want 1 bucket (synthetic dropped, opus merged), got %d", len(got))
	}
	b := got[0]
	if b.Model != "claude-opus-4-8" || b.Input != 100 || b.Output != 50 || b.CacheRead != 10 || b.Msgs != 2 {
		t.Errorf("bucket = %+v", b)
	}
	if b.Day != day.Format("2006-01-02") {
		t.Errorf("day = %q", b.Day)
	}
}

func TestScanRootsPrunesByModtime(t *testing.T) {
	dir := t.TempDir()
	claude := filepath.Join(dir, "claude")
	proj := filepath.Join(claude, "proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","message":{"id":"m","model":"claude-haiku-4-5","usage":{"input_tokens":7}}}`
	fresh := filepath.Join(proj, "fresh.jsonl")
	stale := filepath.Join(proj, "stale.jsonl")
	for _, p := range []string{fresh, stale} {
		if err := os.WriteFile(p, []byte(line+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().AddDate(0, 0, -30)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	// window 7d (+1d margin) => stale (30d old) pruned, fresh kept
	got := scanRoots(claude, filepath.Join(dir, "codex-missing"), 7)
	if len(got) != 1 || got[0].Model != "claude-haiku-4-5" {
		t.Fatalf("want 1 haiku bucket from fresh file only, got %+v", got)
	}
	// windowDays 0 => no prune => both files counted (2 msgs, same model/day bucket)
	all := scanRoots(claude, filepath.Join(dir, "codex-missing"), 0)
	if len(all) != 1 || all[0].Msgs != 2 {
		t.Fatalf("want 1 bucket msgs=2 with no prune, got %+v", all)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/usagestats/ -run "Bucket|ScanRoots"`
Expected: FAIL — `undefined: bucket`, `undefined: scanRoots`.

- [ ] **Step 3: Write the minimal implementation**

```go
// append to usagestats.go; extend imports:
//   "io/fs"
//   "os"
//   "path/filepath"
//   "strings"
//   "github.com/wavetermdev/waveterm/pkg/wavebase"

// bucket groups deduped records by (provider, model, local day), summing token classes and a
// message count. Records with model "<synthetic>" (Claude's non-billable internal turns) are
// dropped here so they never reach the wire.
func bucket(records []Record) []Bucket {
	type key struct{ provider, model, day string }
	m := map[key]*Bucket{}
	for _, r := range records {
		if r.Model == "<synthetic>" {
			continue
		}
		day := r.TS.Local().Format("2006-01-02")
		k := key{r.Provider, r.Model, day}
		b := m[k]
		if b == nil {
			b = &Bucket{Provider: r.Provider, Model: r.Model, Day: day}
			m[k] = b
		}
		b.Input += r.Input
		b.Output += r.Output
		b.CacheRead += r.CacheRead
		b.CacheCreate += r.CacheCreate
		b.CacheCreate1h += r.CacheCreate1h
		b.Msgs++
	}
	out := make([]Bucket, 0, len(m))
	for _, b := range m {
		out = append(out, *b)
	}
	return out
}

func readLines(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var lines []string
	for _, ln := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(ln) != "" {
			lines = append(lines, ln)
		}
	}
	return lines
}

// inWindow reports whether the file at path was modified at/after cutoff. A zero cutoff
// (windowDays <= 0) means all-time — always true. Unstatable files are excluded.
func inWindow(path string, cutoff time.Time) bool {
	if cutoff.IsZero() {
		return true
	}
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.ModTime().Before(cutoff)
}

// scanRoots walks the Claude and Codex transcript roots, prunes files by modtime to the window
// (with a 1-day margin), parses + dedups them, and returns buckets. Missing roots yield nothing.
func scanRoots(claudeRoot, codexRoot string, windowDays int) []Bucket {
	var cutoff time.Time
	if windowDays > 0 {
		cutoff = time.Now().AddDate(0, 0, -windowDays-1)
	}
	var records []Record
	_ = filepath.WalkDir(claudeRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		if inWindow(path, cutoff) {
			records = append(records, extractClaude(readLines(path))...)
		}
		return nil
	})
	_ = filepath.WalkDir(codexRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			return nil
		}
		if inWindow(path, cutoff) {
			records = append(records, extractCodex(readLines(path))...)
		}
		return nil
	})
	return bucket(dedupe(records))
}

// ScanUsage aggregates usage from the user's Claude + Codex transcripts within the last
// windowDays (0 = all-time). It is the only exported entry point.
func ScanUsage(windowDays int) ([]Bucket, error) {
	home := wavebase.GetHomeDir()
	return scanRoots(filepath.Join(home, ".claude", "projects"), filepath.Join(home, ".codex", "sessions"), windowDays), nil
}
```

Also add the `Bucket` type near `Record` (top of file, after `Record`):

```go
// Bucket is one (provider, model, local-day) aggregate. The frontend prices and rolls these up.
type Bucket struct {
	Provider      string
	Model         string
	Day           string // "YYYY-MM-DD", server-local timezone
	Input         int
	Output        int
	CacheRead     int
	CacheCreate   int
	CacheCreate1h int
	Msgs          int
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/usagestats/`
Expected: PASS (9 tests).

- [ ] **Step 5: Checkpoint** — full package green: `go test ./pkg/usagestats/` and `go vet ./pkg/usagestats/`.

---

## Task 4: RPC command + server impl + codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface method ~line 97 after `GitDiffCommand`; structs near the git command structs)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (after `GitDiffCommand`, ~line 1460; add import)
- Generated (do not hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add the interface method**

In `pkg/wshrpc/wshrpctypes.go`, add after the `GitDiffCommand` line (97):

```go
	GetUsageStatsCommand(ctx context.Context, data CommandGetUsageStatsData) (*CommandGetUsageStatsRtnData, error)
```

- [ ] **Step 2: Add the wire structs**

In `pkg/wshrpc/wshrpctypes.go`, after the `CommandGitDiffRtnData` struct block, add:

```go
type UsageBucket struct {
	Provider      string `json:"provider"`
	Model         string `json:"model"`
	Day           string `json:"day"`
	Input         int    `json:"input"`
	Output        int    `json:"output"`
	CacheRead     int    `json:"cacheread"`
	CacheCreate   int    `json:"cachecreate"`
	CacheCreate1h int    `json:"cachecreate1h"`
	Msgs          int    `json:"msgs"`
}

type CommandGetUsageStatsData struct {
	WindowDays int `json:"windowdays,omitempty"`
}

type CommandGetUsageStatsRtnData struct {
	Buckets []UsageBucket `json:"buckets"`
}
```

- [ ] **Step 3: Implement the server method**

In `pkg/wshrpc/wshserver/wshserver.go`, add the import `"github.com/wavetermdev/waveterm/pkg/usagestats"` to the import block, then add after `GitDiffCommand`:

```go
func (ws *WshServer) GetUsageStatsCommand(ctx context.Context, data wshrpc.CommandGetUsageStatsData) (*wshrpc.CommandGetUsageStatsRtnData, error) {
	buckets, err := usagestats.ScanUsage(data.WindowDays)
	if err != nil {
		return nil, fmt.Errorf("scanning usage: %w", err)
	}
	out := make([]wshrpc.UsageBucket, len(buckets))
	for i, b := range buckets {
		out[i] = wshrpc.UsageBucket{
			Provider: b.Provider, Model: b.Model, Day: b.Day,
			Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheCreate: b.CacheCreate, CacheCreate1h: b.CacheCreate1h, Msgs: b.Msgs,
		}
	}
	return &wshrpc.CommandGetUsageStatsRtnData{Buckets: out}, nil
}
```

- [ ] **Step 4: Verify Go compiles**

Run: `go build ./pkg/...`
Expected: builds clean (no missing-method error on the `WshServer` interface assertion).

- [ ] **Step 5: Regenerate bindings**

Run: `task generate`
Expected: completes; git diff shows `RpcApi.GetUsageStatsCommand` added in `frontend/app/store/wshclientapi.ts`, `GetUsageStatsCommand` in `pkg/wshrpc/wshclient/wshclient.go`, and `UsageBucket` / `CommandGetUsageStatsData` / `CommandGetUsageStatsRtnData` in `frontend/types/gotypes.d.ts`.

- [ ] **Step 6: Verify the generated TS type exists**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('frontend/types/gotypes.d.ts','utf8');console.log(['UsageBucket','CommandGetUsageStatsData','CommandGetUsageStatsRtnData'].map(t=>t+': '+s.includes('type '+t+' =')))"`
Expected: all three print `true`.

- [ ] **Step 7: Checkpoint** — `go build ./pkg/...` clean, generated files present.

---

## Task 5: Frontend — `aggregateBuckets`

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts`
- Test: `frontend/app/view/agents/usagestats.test.ts`

> `UsageBucket` is an ambient global type (from `gotypes.d.ts`) — reference it without an import.

- [ ] **Step 1: Write the failing tests** (append; keep existing tests for now)

```ts
// append to usagestats.test.ts
import { aggregateBuckets } from "./usagestats";

function bkt(over: Partial<UsageBucket>): UsageBucket {
    return { provider: "claude", model: "claude-opus-4-8", day: "2026-06-26",
        input: 0, output: 0, cacheread: 0, cachecreate: 0, cachecreate1h: 0, msgs: 1, ...over };
}

describe("aggregateBuckets", () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");
    const today = "2026-06-26";

    it("splits today vs rolling week and excludes older buckets", () => {
        const stats = aggregateBuckets(
            [
                bkt({ day: today, input: 100 }),                 // today + week
                bkt({ day: "2026-06-22", input: 50 }),           // week only (4 days ago)
                bkt({ day: "2026-06-01", input: 999 }),          // older than 7d -> excluded
            ],
            now
        );
        expect(stats.totals.tokensToday).toBe(100);
        expect(stats.totals.tokensWeek).toBe(150);
    });

    it("computes per-model pct within a provider, desc by tokens", () => {
        const stats = aggregateBuckets(
            [bkt({ model: "claude-opus-4-8", input: 75 }), bkt({ model: "claude-sonnet-4-6", input: 25 })],
            now
        );
        const p = stats.providers[0];
        expect(p.models[0].model).toBe("claude-opus-4-8");
        expect(p.models[0].pct).toBeCloseTo(75, 5);
        expect(p.models[1].pct).toBeCloseTo(25, 5);
    });

    it("prices buckets via usagepricing (opus input $15/M)", () => {
        const stats = aggregateBuckets([bkt({ day: today, model: "claude-opus-4-8", input: 1_000_000 })], now);
        expect(stats.totals.spendTodayUsd).toBeCloseTo(15, 5);
    });

    it("returns zeros for no buckets", () => {
        expect(aggregateBuckets([], now)).toEqual({
            totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
            providers: [],
        });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts -t aggregateBuckets`
Expected: FAIL — `aggregateBuckets is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `frontend/app/view/agents/usagestats.ts` (keep `UsageStats`/`ProviderUsage`/`ModelUsage`/`UsageRecord`/`PROVIDER_RANK` and the `spendOf` import):

```ts
const DAY_MS = 24 * 60 * 60 * 1000;

function localDayKey(ms: number): string {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}

// Reuse the pricing path by shaping a bucket as a UsageRecord (pricing reads model + token fields).
function bucketAsRecord(b: UsageBucket): UsageRecord {
    return {
        ts: 0, provider: b.provider, model: b.model,
        inputTokens: b.input, outputTokens: b.output, cacheReadTokens: b.cacheread,
        cacheCreateTokens: b.cachecreate, cacheCreate1hTokens: b.cachecreate1h,
    };
}

function bucketTokens(b: UsageBucket): number {
    return b.input + b.output + b.cacheread + b.cachecreate;
}

// Fold backend buckets into the surface's UsageStats. today = buckets on the local current day;
// week = rolling 7 days (independent of the scan window). The per-model breakdown is over the week.
export function aggregateBuckets(buckets: UsageBucket[], now: number): UsageStats {
    const today = localDayKey(now);
    const weekStart = localDayKey(now - 6 * DAY_MS);
    let tokensToday = 0, tokensWeek = 0, spendTodayUsd = 0, spendWeekUsd = 0;
    const byProvider = new Map<string, Map<string, { tokens: number; spend: number }>>();
    for (const b of buckets) {
        if (b.day < weekStart) {
            continue;
        }
        const tk = bucketTokens(b);
        const sp = spendOf(bucketAsRecord(b));
        tokensWeek += tk;
        spendWeekUsd += sp;
        if (b.day === today) {
            tokensToday += tk;
            spendTodayUsd += sp;
        }
        let models = byProvider.get(b.provider);
        if (!models) {
            models = new Map();
            byProvider.set(b.provider, models);
        }
        const cur = models.get(b.model) ?? { tokens: 0, spend: 0 };
        cur.tokens += tk;
        cur.spend += sp;
        models.set(b.model, cur);
    }
    const providers: ProviderUsage[] = [...byProvider.entries()]
        .map(([provider, models]) => {
            const tokensWeekP = [...models.values()].reduce((s, m) => s + m.tokens, 0);
            const modelUsages: ModelUsage[] = [...models.entries()]
                .map(([model, v]) => ({
                    model,
                    tokens: v.tokens,
                    spendUsd: v.spend,
                    pct: tokensWeekP > 0 ? (v.tokens / tokensWeekP) * 100 : 0,
                }))
                .sort((a, b) => b.tokens - a.tokens);
            return { provider, tokensWeek: tokensWeekP, models: modelUsages };
        })
        .sort((a, b) => (PROVIDER_RANK[a.provider] ?? 99) - (PROVIDER_RANK[b.provider] ?? 99));
    return { totals: { tokensToday, tokensWeek, spendTodayUsd, spendWeekUsd }, providers };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts -t aggregateBuckets`
Expected: PASS (4 new tests).

- [ ] **Step 5: Checkpoint** — new tests green (old extractor tests still pass; cleanup in Task 7).

---

## Task 6: Frontend — `loadUsage` over RPC + keep-last-good

**Files:**
- Modify: `frontend/app/view/agents/usagestore.ts`
- Test: `frontend/app/view/agents/usagestore.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// frontend/app/view/agents/usagestore.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";

const getStats = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetUsageStatsCommand: (...a: any[]) => getStats(...a) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { loadUsage, usageStatsAtom, usageErrorAtom } from "./usagestore";

afterEach(() => {
    getStats.mockReset();
    globalStore.set(usageStatsAtom, { totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 }, providers: [] });
    globalStore.set(usageErrorAtom, false);
});

describe("loadUsage", () => {
    it("aggregates returned buckets into the stats atom and clears the error flag", async () => {
        const sentinel = { totals: { tokensToday: -1, tokensWeek: -1, spendTodayUsd: 0, spendWeekUsd: 0 }, providers: [] };
        globalStore.set(usageStatsAtom, sentinel);
        globalStore.set(usageErrorAtom, true);
        getStats.mockResolvedValue({ buckets: [] }); // empty is a valid success -> atom replaced with zeros
        await loadUsage(7);
        expect(globalStore.get(usageStatsAtom)).not.toBe(sentinel); // success replaced the atom
        expect(globalStore.get(usageStatsAtom).totals.tokensToday).toBe(0);
        expect(globalStore.get(usageErrorAtom)).toBe(false);
    });

    it("keeps the last-good stats and flags error when the RPC throws", async () => {
        const good = { totals: { tokensToday: 5, tokensWeek: 5, spendTodayUsd: 0, spendWeekUsd: 0 }, providers: [] };
        globalStore.set(usageStatsAtom, good);
        getStats.mockRejectedValue(new Error("network error"));
        await loadUsage(7);
        expect(globalStore.get(usageStatsAtom)).toEqual(good); // NOT clobbered with empty
        expect(globalStore.get(usageErrorAtom)).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/usagestore.test.ts`
Expected: FAIL — `usageErrorAtom` is not exported / current `loadUsage` calls `discoverSessions`.

- [ ] **Step 3: Rewrite `usagestore.ts`**

Replace the entire file contents with:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface store: the aggregated UsageStats atom + the impure loader. The scan now runs in
// the Go backend (GetUsageStatsCommand walks every in-window transcript, no file cap); this just
// asks for buckets and folds them into the view model. On RPC failure the last-good stats are
// kept (a transient websocket drop must not blank the surface) and usageErrorAtom is set.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { aggregateBuckets, type UsageStats } from "./usagestats";

const DEFAULT_WINDOW_DAYS = 7;

const EMPTY: UsageStats = {
    totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
    providers: [],
};

export const usageStatsAtom = atom<UsageStats>(EMPTY) as PrimitiveAtom<UsageStats>;
export const usageErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;

let loading = false;

export async function loadUsage(windowDays = DEFAULT_WINDOW_DAYS): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.GetUsageStatsCommand(TabRpcClient, { windowdays: windowDays });
        globalStore.set(usageStatsAtom, aggregateBuckets(rtn.buckets ?? [], Date.now()));
        globalStore.set(usageErrorAtom, false);
    } catch {
        // keep the last-good stats; surface a subtle "couldn't refresh" instead of blanking
        globalStore.set(usageErrorAtom, true);
    } finally {
        loading = false;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/usagestore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint** — `usagestore.test.ts` green.

---

## Task 7: Frontend cleanup + stale indicator

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts` (remove moved logic)
- Modify: `frontend/app/view/agents/usagestats.test.ts` (remove moved tests)
- Modify: `frontend/app/view/agents/usagesurface.tsx` (stale indicator)

- [ ] **Step 1: Remove the logic now living in Go**

In `usagestats.ts`, delete `tokensOf`, `extractUsage`, `extractCodexUsage`, `dedupeUsage`, `aggregateUsage`, `USAGE_WINDOW_DAYS`, and `startOfLocalDay`. Keep: `UsageRecord`, `ModelUsage`, `ProviderUsage`, `UsageStats`, `PROVIDER_RANK`, the `spendOf` import, and everything added in Task 5.

- [ ] **Step 2: Remove the corresponding tests**

In `usagestats.test.ts`, delete the `tokensOf`, `extractUsage`, `extractUsage dedup key`, `dedupeUsage`, `extractCodexUsage`, and `aggregateUsage` describe blocks and their helpers (`rec`, `ASSISTANT_LINE`, `arec`, `codexTurnContext`, `codexTokenCount`, `CODEX_USAGE`). Keep only the `aggregateBuckets` block + its `bkt` helper and imports.

- [ ] **Step 3: Add the stale indicator to the surface**

In `usagesurface.tsx`, add to the imports from `./usagestore`:

```ts
import { loadUsage, usageErrorAtom, usageStatsAtom } from "./usagestore";
```

Read it in the component (next to the other `useAtomValue` calls):

```ts
    const loadError = useAtomValue(usageErrorAtom);
```

And render a subtle line under the subtitle `<p>` (inside the `mb-6` header div), shown only when a refresh failed but we still have data:

```tsx
                    {loadError ? (
                        <p className="mt-1 text-[12px] text-warning">Couldn’t refresh — showing the last loaded usage.</p>
                    ) : null}
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` errors (baseline). No new errors in `usage*.ts(x)`.

- [ ] **Step 5: Run the full agents test suite**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS — including `usagestats.test.ts`, `usagestore.test.ts`, `usagepricing.test.ts`.

- [ ] **Step 6: Checkpoint** — typecheck baseline-clean, all agents tests green, `go test ./pkg/...` green.

---

## Task 8: Live verification + single commit (await approval)

**Files:** none (verification + commit)

- [ ] **Step 1: Confirm the dev app is rebuilt**

`task dev` watches Go + Rust + frontend; confirm the dev app picked up the new backend (the `cargo tauri dev` rebuild restarts `wavesrv`). If running headless, restart `task dev`.

- [ ] **Step 2: CDP-verify the Usage surface**

Navigate to the Usage surface and read the by-model section (see `scripts/cdp-shot.mjs` / the `cdp-eval` pattern). Expected on real data:
- Claude shows **multiple models** (e.g. `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`), not opus-only.
- **No `<synthetic>` row.**
- "Tokens today"/"Spend today" populated and stable across a manual nav-away/return (no "No usage yet" flash on a healthy WS).

- [ ] **Step 3: Verify the reliability fix**

With data showing, there should be no transition to "No usage yet" on the 60s refresh. (Optional: confirm `usageErrorAtom` path by observing the surface keeps numbers if a refresh fails.)

- [ ] **Step 4: Self-review the diff**

Run: `git status` and `git --no-pager diff --stat`
Confirm: `pkg/usagestats/*` added; `wshrpctypes.go`, `wshserver.go`, generated files, and `usage*.ts(x)` modified; no stray debug code; `activitydiscovery.ts`/`activitystore.ts`/`usagepricing.ts` untouched.

- [ ] **Step 5: Present the commit for approval**

Per CLAUDE.md, show the file list (M/A) + a `type(scope): description` message and ask "Awaiting approval. Proceed? (yes/no)". The spec (`docs/superpowers/specs/2026-06-26-usage-backend-scan-design.md`) and this plan fold into this same feature commit. Proposed message:

```
feat(cockpit): backend usage scan — full coverage, reliable, per-model

Replace the FE 150-file/7-day transcript scan with a GetUsageStatsCommand
backend aggregate (pkg/usagestats): walks every in-window file, drops
<synthetic>, returns per-(provider,model,day) buckets the FE prices. Fixes
the empty-clobber that blanked the surface on a transient WS drop.
```

Do NOT commit until the owner replies yes.

---

## Self-Review Notes

- **Spec coverage:** lift 150 cap (Task 3 modtime prune, no count cap ✓); parameterize window (Tasks 4/6 `windowDays`/`windowdays` ✓); drop `<synthetic>` (Task 3 `bucket` ✓); keep-last-good reliability (Task 6 ✓); read full files (Task 3 `readLines`, no tail ✓); backend counts / FE prices (Tasks 3–6 ✓); pricing stays FE (Task 5 reuses `spendOf` ✓).
- **Deferred per YAGNI:** the daily-series transform (spec §6.2) is not built here — the backend already returns per-day buckets, so the redesign derives the series from the same payload when it needs it. Noted so it isn't mistaken for a gap.
- **Type consistency:** wire JSON tags (`cacheread`, `cachecreate1h`, `windowdays`) are lower-case to match the codebase's generated-type convention; the TS bucket fields in Tasks 5/6 use the same lower-case names (`b.cacheread`, `{ windowdays }`). `aggregateBuckets`/`usageErrorAtom`/`usageStatsAtom`/`loadUsage` names are identical across Tasks 5, 6, 7.
- **Commit policy:** per-task "Commit" steps from the skill are intentionally replaced with green checkpoints; one approval-gated commit in Task 8 (owner's CLAUDE.md overrides).
```
