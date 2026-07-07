// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package usagestats scans agent transcript JSONL on disk and aggregates per-message token
// usage into per-(provider, model, day) buckets for the Usage cockpit surface. Pure
// token-counting only — no pricing (the frontend prices via usagepricing.ts) and no
// presentation. Sibling to pkg/gitinfo.
package usagestats

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
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

// sumRecords totals the four token classes across deduped records.
func sumRecords(records []Record) int {
	total := 0
	for _, r := range dedupe(records) {
		total += r.Input + r.Output + r.CacheRead + r.CacheCreate
	}
	return total
}

// SumTranscript reads one transcript file and returns its deduped cumulative token
// total (Input+Output+CacheRead+CacheCreate), matching the Usage surface's accounting.
// Runs the Claude parser first and falls back to the Codex parser only when the Claude
// parse yields no records (a rollout produces no Claude records and vice versa, so this
// is unambiguous). Empty/unreadable/unknown-shape files return 0.
func SumTranscript(path string) (int, error) {
	lines := readLines(path)
	if len(lines) == 0 {
		return 0, nil
	}
	recs := extractClaude(lines)
	if len(recs) == 0 {
		recs = extractCodex(lines)
	}
	return sumRecords(recs), nil
}

// CacheWrite is the most recent prompt-cache-writing message in a transcript.
type CacheWrite struct {
	TS      time.Time
	OneHour bool // true if this write used the extended 1h TTL bucket (else the default 5m bucket)
}

// LastCacheWrite finds the most recent assistant record with cache-write activity in the
// transcript at path, and reports which TTL bucket it used. Only Claude transcripts carry this
// concept (extractClaude yields nothing for a Codex-shaped file, so this returns nil for those).
// Returns nil (no error) when the transcript has no cache-write activity, is empty, or is missing.
func LastCacheWrite(path string) (*CacheWrite, error) {
	lines := readLines(path)
	if len(lines) == 0 {
		return nil, nil
	}
	var last *Record
	for _, r := range extractClaude(lines) {
		if r.CacheCreate <= 0 {
			continue
		}
		if last == nil || r.TS.After(last.TS) {
			rc := r
			last = &rc
		}
	}
	if last == nil {
		return nil, nil
	}
	return &CacheWrite{TS: last.TS, OneHour: last.CacheCreate1h > 0}, nil
}

// sumRecordsSinceCutoffs returns, per cutoff (positionally), the summed token total of
// records at/after that cutoff. A zero cutoff means all-time (every record counts).
func sumRecordsSinceCutoffs(records []Record, cutoffs []time.Time) []int {
	out := make([]int, len(cutoffs))
	for _, r := range records {
		tokens := r.Input + r.Output + r.CacheRead + r.CacheCreate
		for i, c := range cutoffs {
			if c.IsZero() || !r.TS.Before(c) {
				out[i] += tokens
			}
		}
	}
	return out
}

// WindowTokens sums Claude-only deduped token totals for records at/after each cutoff,
// across the Claude transcript root. Codex is excluded — rate-limit windows are
// Claude.ai-specific. Returns one total per cutoff, positionally.
func WindowTokens(cutoffs []time.Time) ([]int, error) {
	home := wavebase.GetHomeDir()
	claudeRoot := filepath.Join(home, ".claude", "projects")

	var earliest time.Time
	for _, c := range cutoffs {
		if !c.IsZero() && (earliest.IsZero() || c.Before(earliest)) {
			earliest = c
		}
	}
	// prune files by modtime against the earliest cutoff (with the existing 1-day margin)
	var prune time.Time
	if !earliest.IsZero() {
		prune = earliest.AddDate(0, 0, -1)
	}

	var records []Record
	_ = filepath.WalkDir(claudeRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		if !inWindow(path, prune) {
			return nil
		}
		records = append(records, extractClaude(readLines(path))...)
		return nil
	})
	return sumRecordsSinceCutoffs(dedupe(records), cutoffs), nil
}
