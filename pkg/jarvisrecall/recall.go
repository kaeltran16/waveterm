// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// synthTimeout caps the model run; kept below the FE's 130s RPC budget (mirror of consultTimeout).
const synthTimeout = 120 * time.Second

// Emit receives one streamed chunk. The caller (wshserver) forwards it onto the RPC channel.
type Emit func(wshrpc.JarvisConverseChunk)

func stepChunk(id, label, status string) wshrpc.JarvisConverseChunk {
	return wshrpc.JarvisConverseChunk{Kind: "step", Step: &wshrpc.JarvisWorkingStep{Id: id, Label: label, Status: status}}
}

// Converse is the recall pipeline: retrieve (deterministic, free) -> emit steps + grounding -> synthesize
// (one claude run) -> emit prose + terminal. notfound is decided without a model call. Grounding is built in
// Go; the model only writes prose and picks [n] to cite (spec invariants 1, 4, 7).
func Converse(ctx context.Context, data wshrpc.CommandJarvisConverseData, emit Emit) error {
	emit(stepChunk("retrieve", "Searching runs, radar, and memory", "active"))
	cands, err := retrieve(ctx, data)
	if err != nil {
		return err
	}
	emit(stepChunk("retrieve", "Searched runs, radar, and memory", "done"))

	cards := buildCards(cands, time.Now().UnixMilli())
	for i := range cards {
		c := cards[i]
		emit(wshrpc.JarvisConverseChunk{Kind: "grounding", Grounding: &c})
	}

	// not-found is free: no candidates => no model call.
	if len(cards) == 0 {
		emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: "Not found. No Wave source in scope references this."})
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "notfound"})
		return nil
	}

	spec, ok := consult.SpecFor("claude")
	if !ok {
		emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: "Recall requires the claude CLI, which is not available."})
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "weak"})
		return nil
	}

	emit(stepChunk("synthesize", "Synthesizing a grounded answer", "active"))
	prompt := buildPrompt(data.Prompt, cands)
	runCtx, cancel := context.WithTimeout(ctx, synthTimeout)
	defer cancel()
	var full strings.Builder
	_, runErr := consult.Run(runCtx, spec, synthCwd(data), prompt, func(chunk string) {
		full.WriteString(chunk)
		select {
		case <-runCtx.Done():
		default:
			emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: chunk})
		}
	})
	emit(stepChunk("synthesize", "Synthesized a grounded answer", "done"))
	if runErr != nil {
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "weak"})
		return runErr
	}
	terminal := selectTerminal(len(cards), countCitations(full.String(), len(cards)))
	emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: terminal})
	return nil
}

// synthCwd is the cwd for the claude run. Use the scoped project when known so claude discovers that repo's
// CLAUDE.md; otherwise the home dir (a valid dir is required).
func synthCwd(data wshrpc.CommandJarvisConverseData) string {
	if data.ProjectPath != "" {
		return data.ProjectPath
	}
	return wavebase.GetHomeDir()
}

// retrieve loads the in-scope slice of existing objects (runs, radar findings, memory notes), maps each to a
// candidate, and returns the recency-ordered top maxCandidates. Load-all-then-filter (the stores have no FTS).
func retrieve(ctx context.Context, data wshrpc.CommandJarvisConverseData) ([]candidate, error) {
	var cands []candidate

	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, err
	}
	for _, r := range runs {
		if inScope(data, "run", r.ProjectPath) {
			cands = append(cands, runCandidate(r))
		}
	}

	reports, err := wstore.GetRadarReports(ctx, scopeProject(data))
	if err != nil {
		return nil, err
	}
	for _, rep := range reports {
		for _, f := range rep.Findings {
			if f.Group == "nolonger" || f.Group == "dismissed" || f.Group == "suppressed" {
				continue
			}
			cands = append(cands, radarCandidate(rep, f))
		}
	}

	// memory is markdown, not SQLite; a scan failure must not fail recall.
	if graph, gerr := memvault.ScanVault(memvault.VaultRoots()); gerr == nil && graph != nil {
		for _, n := range graph.Notes {
			if inScope(data, "memory", n.Scope) {
				cands = append(cands, memoryCandidate(n))
			}
		}
	}

	sortByRecency(cands)
	if len(cands) > maxCandidates {
		cands = cands[:maxCandidates]
	}
	return cands, nil
}
