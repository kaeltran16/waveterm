// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const synthTimeout = 120 * time.Second

const notFoundProse = "Not found. No Wave source in scope references this."

var errNoClaude = fmt.Errorf("recall requires the claude CLI, which is not available")

// Emit receives one streamed chunk. The caller forwards it onto the RPC channel.
type Emit func(wshrpc.JarvisConverseChunk)

func stepChunk(id, label, status string) wshrpc.JarvisConverseChunk {
	return wshrpc.JarvisConverseChunk{Kind: "step", Step: &wshrpc.JarvisWorkingStep{Id: id, Label: label, Status: status}}
}

var synthesize = func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return "", errNoClaude
	}
	return consult.Run(ctx, spec, cwd, prompt, onChunk)
}

func SetSynthesizeForTest(fn func(context.Context, string, string, func(string)) (string, error)) func(context.Context, string, string, func(string)) (string, error) {
	old := synthesize
	synthesize = fn
	return old
}

// Converse retrieves grounded sources, streams one answer, and returns the durable Jarvis turn.
func Converse(ctx context.Context, scope ScopeArgs, priorTurns []waveobj.JarvisConvoTurn, prompt string, emit Emit) (waveobj.JarvisConvoTurn, error) {
	emit(stepChunk("retrieve", "Searching runs, radar, and memory", "active"))
	cands, err := retrieve(ctx, scope, prompt)
	if err != nil {
		return waveobj.JarvisConvoTurn{}, err
	}
	emit(stepChunk("retrieve", "Searched runs, radar, and memory", "done"))

	cards := buildCards(cands, time.Now().UnixMilli())
	for i := range cards {
		card := cards[i]
		emit(wshrpc.JarvisConverseChunk{Kind: "grounding", Grounding: &card})
	}
	if len(cards) == 0 {
		emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: notFoundProse})
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "notfound"})
		return waveobj.JarvisConvoTurn{Role: "jarvis", Prose: notFoundProse, Terminal: "notfound"}, nil
	}

	emit(stepChunk("synthesize", "Synthesizing a grounded answer", "active"))
	fullPrompt := priorContext(priorTurns, maxContextTurns) + buildPrompt(prompt, cands)
	runCtx, cancel := context.WithTimeout(ctx, synthTimeout)
	defer cancel()
	var full strings.Builder
	_, runErr := synthesize(runCtx, scopeCwd(scope), fullPrompt, func(chunk string) {
		full.WriteString(chunk)
		select {
		case <-runCtx.Done():
		default:
			emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: chunk})
		}
	})
	emit(stepChunk("synthesize", "Synthesized a grounded answer", "done"))
	prose := full.String()
	if runErr != nil {
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "weak"})
		return waveobj.JarvisConvoTurn{Role: "jarvis", Prose: prose, Grounding: cards, Terminal: "weak"}, runErr
	}
	terminal := selectTerminal(len(cards), countCitations(prose, len(cards)))
	emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: terminal})
	return waveobj.JarvisConvoTurn{Role: "jarvis", Prose: prose, Grounding: cards, Terminal: terminal}, nil
}

// openVault is a seam so tests point recall at a fixture vault.
var openVault = wavevault.OpenVault

// SetOpenVaultForTest swaps the vault opener; returns the previous value for restore.
func SetOpenVaultForTest(fn func(context.Context) (*wavevault.Vault, error)) func(context.Context) (*wavevault.Vault, error) {
	old := openVault
	openVault = fn
	return old
}

// scopeToVault maps a caller scope to a vault collection scope. Interactive callers (F) see
// everything; the worker path (WorkerScope) is exposed by A but has no wired consumer in v1.
func scopeToVault(scope ScopeArgs) wavevault.Scope {
	return wavevault.AllScope()
}

// retrieve assembles the grounded slice: attached objects pinned live, plus a vault traversal
// (deterministic seeds -> Expand) with referenced Runs resolved live from wstore.
func retrieve(ctx context.Context, scope ScopeArgs, query string) ([]candidate, error) {
	pinned := resolveAttached(ctx, scope.AttachedORefs)
	v, err := openVault(ctx)
	if err != nil {
		return nil, err
	}
	r := v.Retriever(scopeToVault(scope))
	slice, err := assembleSlice(ctx, v, r, scope, query)
	if err != nil {
		return nil, err
	}
	sortByRecency(slice)
	return assembleCandidates(pinned, slice, maxCandidates), nil
}

// assembleSlice walks the vault from ranked seeds and turns the neighborhood into candidates,
// resolving each [[run-<oid>]] reference live from wstore (or surfacing it as unavailable).
func assembleSlice(ctx context.Context, v *wavevault.Vault, r *wavevault.Retriever, scope ScopeArgs, query string) ([]candidate, error) {
	seeds, err := selectSeeds(ctx, v, r, query)
	if err != nil {
		return nil, err
	}
	sg, err := r.Expand(seeds, wavevault.ExpandOpts{Depth: expandDepth, Fanout: expandFanout})
	if err != nil {
		return nil, err
	}
	var cands []candidate
	seenRun := map[string]bool{}
	var runRefs []string
	for _, n := range sg.Nodes {
		body := ""
		if nb, rerr := r.Read(n.ID); rerr == nil {
			body = nb.Body
		}
		cands = append(cands, nodeCandidate(n, body))
		for _, l := range n.Links {
			if strings.HasPrefix(l, "run-") && !seenRun[l] {
				seenRun[l] = true
				runRefs = append(runRefs, l)
			}
		}
	}
	for _, ref := range runRefs {
		cands = append(cands, resolveRunRef(ctx, ref, scope)...)
	}
	return cands, nil
}

// resolveRunRef resolves a "run-<oid>" reference to a live candidate. A missing run is surfaced as
// unavailable (invariant 7 — surfaced, not hidden). Project scope drops out-of-project runs.
func resolveRunRef(ctx context.Context, ref string, scope ScopeArgs) []candidate {
	oid := strings.TrimPrefix(ref, "run-")
	run, err := wstore.DBMustGet[*waveobj.Run](ctx, oid)
	if err != nil {
		return []candidate{unavailableRunCandidate(oid)}
	}
	if !inScope(scope, "run", run.ProjectPath) {
		return nil
	}
	return []candidate{runCandidate(run)}
}

func unavailableRunCandidate(oid string) candidate {
	return candidate{
		sourceType: "run",
		title:      "Run " + oid + " (unavailable)",
		freshness:  "unavailable",
		navTarget:  "run:" + oid,
	}
}

// resolveAttached skips stale references so one deleted attachment cannot sink the turn.
func resolveAttached(ctx context.Context, orefs []string) []candidate {
	var out []candidate
	for _, ref := range orefs {
		parts := strings.SplitN(ref, ":", 2)
		if len(parts) != 2 || parts[1] == "" {
			continue
		}
		switch parts[0] {
		case "run":
			if run, err := wstore.DBMustGet[*waveobj.Run](ctx, parts[1]); err == nil {
				out = append(out, runCandidate(run))
			}
		case "memory":
			if graph, err := memvault.ScanVault(memvault.VaultRoots()); err == nil && graph != nil {
				for _, note := range graph.Notes {
					if note.ID == parts[1] {
						out = append(out, memoryCandidate(note))
						break
					}
				}
			}
		case "radar":
			if reports, err := wstore.GetRadarReports(ctx, ""); err == nil {
				for _, report := range reports {
					for _, finding := range report.Findings {
						if finding.ID == parts[1] {
							out = append(out, radarCandidate(report, finding))
						}
					}
				}
			}
		}
	}
	return out
}
