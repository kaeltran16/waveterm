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
	cands, err := retrieve(ctx, scope)
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

func retrieve(ctx context.Context, scope ScopeArgs) ([]candidate, error) {
	pinned := resolveAttached(ctx, scope.AttachedORefs)
	scoped, err := retrieveScoped(ctx, scope)
	if err != nil {
		return nil, err
	}
	sortByRecency(scoped)
	return assembleCandidates(pinned, scoped, maxCandidates), nil
}

func retrieveScoped(ctx context.Context, scope ScopeArgs) ([]candidate, error) {
	var cands []candidate
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, err
	}
	for _, run := range runs {
		if inScope(scope, "run", run.ProjectPath) {
			cands = append(cands, runCandidate(run))
		}
	}
	reports, err := wstore.GetRadarReports(ctx, scopeProject(scope))
	if err != nil {
		return nil, err
	}
	for _, report := range reports {
		for _, finding := range report.Findings {
			if finding.Group == "nolonger" || finding.Group == "dismissed" || finding.Group == "suppressed" {
				continue
			}
			cands = append(cands, radarCandidate(report, finding))
		}
	}
	if graph, scanErr := memvault.ScanVault(memvault.VaultRoots()); scanErr == nil && graph != nil {
		for _, note := range graph.Notes {
			if inScope(scope, "memory", note.Scope) {
				cands = append(cands, memoryCandidate(note))
			}
		}
	}
	return cands, nil
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
