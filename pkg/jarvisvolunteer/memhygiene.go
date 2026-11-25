// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memhygiene"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// hygieneRowNames reads each waiting row kind in the snippet.
var hygieneRowNames = map[string]string{
	wshrpc.MemRow_Split:   "split",
	wshrpc.MemRow_Cleanup: "cleanup",
	wshrpc.MemRow_Doc:     "doc move",
	memhygiene.RowFailed:  "failed check",
}

// MemoryHygieneProducer reports a project whose memory waits for the user: Arc applies the routine
// changes itself, so only what the Memory tab lists as waiting counts. The function field is the seam
// for tests.
type MemoryHygieneProducer struct {
	listProjects func() ([]wshrpc.MemHygieneProject, error)
}

func NewMemoryHygieneProducer() *MemoryHygieneProducer {
	return &MemoryHygieneProducer{listProjects: memhygiene.ListProjects}
}

func (p *MemoryHygieneProducer) Name() string { return ClassMemoryHygiene }

func (p *MemoryHygieneProducer) Candidates(_ context.Context, _ *Trigger) ([]Candidate, error) {
	projects, err := p.listProjects()
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: listing memory hygiene projects: %w", err)
	}
	var out []Candidate
	for _, proj := range projects {
		rows := memhygiene.WaitingRows(proj)
		// a CheckedAt of 0 has no fact to stamp from; the gate's prefilter would drop it anyway
		if len(rows) == 0 || proj.CheckedAt == 0 {
			continue
		}
		out = append(out, Candidate{
			Class: ClassMemoryHygiene,
			// stamped from the check, so an unchanged result re-emits the same pair and dies at the watermark
			ID:         fmt.Sprintf("memory-hygiene:%s:%d", proj.Project, proj.CheckedAt),
			At:         proj.CheckedAt,
			Title:      fmt.Sprintf("%s's memory has %d waiting for you", proj.Project, len(rows)),
			Snippet:    hygieneSnippet(proj, rows),
			SourceType: "memhygiene",
			SourceRef:  "memhygiene:" + proj.Project,
		})
	}
	return out, nil
}

// hygieneSnippet gives the judge what the title can't: what waits, and how close the index is to the
// lines Claude Code loads. "1 split, 2 doc moves · MEMORY.md at 6 of 200 lines"
func hygieneSnippet(proj wshrpc.MemHygieneProject, rows []string) string {
	var kinds []string
	count := map[string]int{}
	for _, r := range rows {
		if count[r] == 0 {
			kinds = append(kinds, r)
		}
		count[r]++
	}
	parts := make([]string, len(kinds))
	for i, k := range kinds {
		name := hygieneRowNames[k]
		if count[k] > 1 {
			name += "s"
		}
		parts[i] = fmt.Sprintf("%d %s", count[k], name)
	}
	return fmt.Sprintf("%s · MEMORY.md at %d of %d lines", strings.Join(parts, ", "), proj.Index.Lines, memhygiene.LimitLines)
}
