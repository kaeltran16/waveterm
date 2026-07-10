// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// memoryEvidenceTypes are the note types treated as correction / applied-learning evidence.
var memoryEvidenceTypes = map[string]bool{"feedback": true, "correction": true, "learning": true}

// memorySignals filters vault notes to project-scoped evidence: notes whose scope matches the
// project AND that were harvested from an agent (Source != "vault") OR carry a correction/learning
// type. Ordinary free-form notes are context, not proof, and are dropped.
func memorySignals(notes []memvault.Note, projectName, projectScope string) []waveobj.RadarSignal {
	var sigs []waveobj.RadarSignal
	for _, n := range notes {
		if n.Scope != projectScope && n.Scope != projectName {
			continue
		}
		isEvidence := memoryEvidenceTypes[n.Type] || (n.Source != "" && n.Source != "vault")
		if !isEvidence {
			continue
		}
		summary := fmt.Sprintf("project memory (%s/%s): %s", n.Source, n.Type, Redact(n.Description))
		facts := map[string]any{"noteid": n.ID, "source": n.Source, "type": n.Type, "reviewed": n.Reviewed}
		sigs = append(sigs, newSignal(CollectorMemory, "memory:"+n.ID, n.UpdatedTs, nil, summary, facts, ""))
	}
	return sigs
}

// collectMemory scans the vault and filters to project-scoped evidence notes. projectName is the
// registered name; memvault derives Scope from a note's project dir, so we match either.
func collectMemory(ctx context.Context, in collectInput, projectName string) ([]waveobj.RadarSignal, error) {
	graph, err := memvault.ScanVault(memvault.VaultRoots())
	if err != nil {
		return nil, fmt.Errorf("scanning vault: %w", err)
	}
	return memorySignals(graph.Notes, projectName, projectName), nil
}
