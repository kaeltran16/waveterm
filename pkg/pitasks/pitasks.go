// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package pitasks is a read-only scanner for the @tintinweb/pi-tasks file store
// (<cwd>/.pi/tasks/*.json). It mirrors pkg/bgagents / pkg/agentsessions conventions:
// tolerant parsing — malformed records are skipped, a malformed file is skipped by the
// caller, a missing dir is a silent empty result. It never writes; pi-tasks lock-protects
// its own files.
package pitasks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// statusRank orders pi-tasks' persisted statuses for display: in-flight first, done last.
// "deleted" is a tool-input status that removes the record from the store file; it never
// appears on disk (pi-tasks/src/index.ts:1200), so it is not part of the persisted set.
var statusRank = map[string]int{
	"in_progress": 0,
	"pending":     1,
	"completed":   2,
}

// Task is the persisted subset of a pi-tasks record (src/types.ts Task). Unknown fields
// are ignored; no write-back support.
type Task struct {
	ID          string
	Subject     string
	Description string
	Status      string
	Owner       string
	Blocks      []string
	BlockedBy   []string
	CreatedAt   int64 // UnixMilli
	UpdatedAt   int64 // UnixMilli
}

// Parse reads one pi-tasks store file ({ "nextId": n, "tasks": [...] }). Malformed records
// (no id, empty or unknown status) are skipped; a file that is not valid JSON at all
// returns an error so Read can skip the whole file.
func Parse(data []byte) ([]Task, error) {
	var f struct {
		Tasks []struct {
			ID          string   `json:"id"`
			Subject     string   `json:"subject"`
			Description string   `json:"description"`
			Status      string   `json:"status"`
			Owner       string   `json:"owner"`
			Blocks      []string `json:"blocks"`
			BlockedBy   []string `json:"blockedBy"`
			CreatedAt   int64    `json:"createdAt"`
			UpdatedAt   int64    `json:"updatedAt"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parsing pi-tasks store: %w", err)
	}
	out := make([]Task, 0, len(f.Tasks))
	for _, r := range f.Tasks {
		if r.ID == "" || r.Status == "" {
			continue
		}
		if _, ok := statusRank[r.Status]; !ok {
			continue // unknown status → not a record we can render
		}
		out = append(out, Task{
			ID:          r.ID,
			Subject:     r.Subject,
			Description: r.Description,
			Status:      r.Status,
			Owner:       r.Owner,
			Blocks:      r.Blocks,
			BlockedBy:   r.BlockedBy,
			CreatedAt:   r.CreatedAt,
			UpdatedAt:   r.UpdatedAt,
		})
	}
	return out, nil
}

// Read aggregates every *.json in <cwd>/.pi/tasks (session-scope tasks-<sessionId>.json
// files and the project-scope tasks.json). A missing dir or empty cwd yields (nil, nil) —
// the machine simply has no pi-tasks files, which must not error on every rail poll. Ids
// can collide across store files (each file has its own nextId sequence); the record with
// the highest UpdatedAt wins. Result is sorted by status order then UpdatedAt descending.
func Read(cwd string) ([]Task, error) {
	if cwd == "" {
		return nil, nil
	}
	dir := filepath.Join(cwd, ".pi", "tasks")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading pi-tasks dir %s: %w", dir, err)
	}
	byID := make(map[string]Task)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue // unreadable → skip the file, keep the rest
		}
		tasks, err := Parse(data)
		if err != nil {
			continue // malformed file → skip it, keep the rest
		}
		for _, t := range tasks {
			if prev, ok := byID[t.ID]; ok && prev.UpdatedAt > t.UpdatedAt {
				continue // existing record is newer
			}
			byID[t.ID] = t
		}
	}
	out := make([]Task, 0, len(byID))
	for _, t := range byID {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		ri, rj := statusRank[out[i].Status], statusRank[out[j].Status]
		if ri != rj {
			return ri < rj
		}
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out, nil
}
