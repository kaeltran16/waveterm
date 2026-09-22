// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory utilization and injection cost in one report. These are one question: a note that is never
// recalled is pure session-start cost, and until now neither half was visible. See
// docs/superpowers/specs/2026-09-22-memory-utilization-design.md.
package memvault

import (
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

// IndexBudgetBytes caps one hub index. The budget is bytes because bytes are what session start
// pays: at ~185 bytes per line in the real index, a line budget does not constrain the real cost.
// ~12 KB is roughly 3,000 tokens. Advisory by construction — Claude's memory tool owns MEMORY.md and
// Arc never rewrites its entries, so the deliverable is that the number is visible and checkable.
const IndexBudgetBytes = 12000

// BytesPerToken is the estimate the report labels as an estimate; the real tokenizer is not ours.
const BytesPerToken = 4

// IndexFile is one hub index measured on disk.
type IndexFile struct {
	Label      string `json:"label"`
	Bytes      int    `json:"bytes"`
	Tokens     int    `json:"tokens"`
	OverBudget bool   `json:"overbudget"`
	OverBy     int    `json:"overby"`
}

// Stats is the whole report.
type Stats struct {
	VaultPath          string      `json:"vaultpath"`
	Total              int         `json:"total"`
	Machine            int         `json:"machine"`
	Human              int         `json:"human"`
	Referenced         int         `json:"referenced"`
	ReferencedRecently int         `json:"referencedrecently"`
	NeverReferenced    int         `json:"neverreferenced"`
	TotalReferences    int         `json:"totalreferences"`
	ArchiveEligible    int         `json:"archiveeligible"`
	Epoch              string      `json:"epoch"`
	EpochMatures       string      `json:"epochmatures"`
	Indexes            []IndexFile `json:"indexes"`
	TotalIndexBytes    int         `json:"totalindexbytes"`
	TotalIndexTokens   int         `json:"totalindextokens"`
	BudgetBytes        int         `json:"budgetbytes"`
}

// isMachineSource mirrors the gardener's provenance split. Duplicated deliberately as a one-line
// predicate rather than exported from memgarden, which imports this package.
func isMachineSource(source string) bool {
	switch source {
	case "agent", "codex", "claude", "pi":
		return true
	}
	return false
}

// ComputeStats is the pure core. epoch and staleDays are passed in so the report answers the same
// question the gardener does, with the same rule.
func ComputeStats(notes []Note, indexes []IndexFile, now time.Time, staleDays int, epoch time.Time) Stats {
	cutoff := now.AddDate(0, 0, -staleDays)
	signalMature := !epoch.IsZero() && epoch.Before(cutoff)
	s := Stats{Total: len(notes), BudgetBytes: IndexBudgetBytes}
	for _, n := range notes {
		machine := isMachineSource(n.Source)
		if machine {
			s.Machine++
		} else {
			s.Human++
		}
		s.TotalReferences += n.ReferenceCount
		stamped := n.LastReferenced != ""
		if !stamped {
			s.NeverReferenced++
		} else {
			s.Referenced++
			if !beforeCutoffTime(n.LastReferenced, cutoff) {
				s.ReferencedRecently++
			}
		}
		if !machine || n.SupersededBy != "" {
			continue
		}
		unused := (stamped && beforeCutoffTime(n.LastReferenced, cutoff)) || (!stamped && signalMature)
		if unused && noteAgeBefore(n, cutoff) {
			s.ArchiveEligible++
		}
	}
	for _, idx := range indexes {
		idx.Tokens = idx.Bytes / BytesPerToken
		if idx.Bytes > IndexBudgetBytes {
			idx.OverBudget = true
			idx.OverBy = idx.Bytes - IndexBudgetBytes
		}
		s.TotalIndexBytes += idx.Bytes
		s.TotalIndexTokens += idx.Tokens
		s.Indexes = append(s.Indexes, idx)
	}
	if !epoch.IsZero() {
		s.Epoch = epoch.UTC().Format(time.RFC3339)
		s.EpochMatures = epoch.AddDate(0, 0, staleDays).UTC().Format(time.RFC3339)
	}
	return s
}

// beforeCutoffTime reports whether an RFC3339 stamp parses and precedes cutoff.
func beforeCutoffTime(ts string, cutoff time.Time) bool {
	t, err := time.Parse(time.RFC3339, ts)
	return err == nil && t.Before(cutoff)
}

// noteAgeBefore mirrors the gardener's age basis: captured_at, else file mtime.
func noteAgeBefore(n Note, cutoff time.Time) bool {
	if n.CapturedAt != "" {
		return beforeCutoffTime(n.CapturedAt, cutoff)
	}
	if n.UpdatedTs > 0 {
		return time.UnixMilli(n.UpdatedTs).Before(cutoff)
	}
	return false
}

// MeasureIndexes sizes every hub index on disk, labelled by project.
func MeasureIndexes() []IndexFile {
	var out []IndexFile
	for _, hub := range ClaudeHubDirs() {
		info, err := os.Stat(filepath.Join(hub, memroots.IndexFile))
		if err != nil {
			continue
		}
		out = append(out, IndexFile{
			Label: memroots.ScopeForHubDir(filepath.Base(filepath.Dir(hub))),
			Bytes: int(info.Size()),
		})
	}
	return out
}

// GatherStats reads the live vault and hub indexes and computes the report.
func GatherStats(now time.Time, staleDays int) Stats {
	var plain []Note
	for _, nw := range VaultNotes() {
		plain = append(plain, nw.Note)
	}
	s := ComputeStats(plain, MeasureIndexes(), now, staleDays, RecallEpoch())
	s.VaultPath = DefaultVaultPath()
	return s
}
