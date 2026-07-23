// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisrecall is the Plan-2 recall SHIM behind the Jarvis conversation backend (sub-project F).
// It retrieves a bounded slice of EXISTING Wave objects (runs, radar findings, memory notes), builds
// grounding deterministically, and runs one claude synthesis over it. The real recall engine (sub-project
// C: vault, wikilink traversal, learning store) replaces this behind the same JarvisConverseChunk protocol.
// This file holds the pure, process-free, DB-free helpers so they are unit-testable in isolation.
package jarvisrecall

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// maxCandidates caps the assembled slice fed to the model (recency-ordered). Bounds prompt size + cost.
const maxCandidates = 12

// candidate is one retrieved source before it is numbered into a grounding card. snippet feeds the prompt
// only (it is not sent to the FE as part of the card).
type candidate struct {
	sourceType string
	title      string
	project    string
	ts         int64
	freshness  string
	navTarget  string
	snippet    string
}

func runCandidate(r *waveobj.Run) candidate {
	ts := r.CreatedTs
	if r.CompletedTs > 0 {
		ts = r.CompletedTs
	}
	snippet := "status: " + r.Status
	if r.Evidence != nil && r.Evidence.Summary != "" {
		snippet = r.Evidence.Summary
	}
	return candidate{
		sourceType: "run",
		title:      r.Goal,
		project:    projectLabel(r.ProjectPath),
		ts:         ts,
		freshness:  "fresh",
		navTarget:  waveobj.MakeORef(waveobj.OType_Run, r.OID).String(),
		snippet:    snippet,
	}
}

func radarCandidate(rep *waveobj.RadarReport, f waveobj.RadarFinding) candidate {
	ts := rep.StartedTs
	if rep.CompletedTs > 0 {
		ts = rep.CompletedTs
	}
	return candidate{
		sourceType: "radar",
		title:      "Finding: " + f.Risk,
		project:    rep.ProjectName,
		ts:         ts,
		freshness:  "fresh",
		navTarget:  waveobj.MakeORef(waveobj.OType_RadarReport, rep.OID).String(),
		snippet:    f.Why,
	}
}

func memoryCandidate(n memvault.Note) candidate {
	return candidate{
		sourceType: "memory",
		title:      n.Title,
		project:    n.Scope,
		ts:         n.UpdatedTs,
		freshness:  memoryFreshness(n),
		navTarget:  "memory:" + n.ID, // NOT a parseable ORef; real nav is Plan 4
		snippet:    n.Description,
	}
}

// memoryFreshness is the shim's one real freshness signal: the gardener marks stale/drift/duplicate notes
// and superseded notes, deterministically (pkg/memgarden). Everything else the shim retrieves is fresh.
func memoryFreshness(n memvault.Note) string {
	if n.GardenerFlag != "" || n.SupersededBy != "" {
		return "stale"
	}
	return "fresh"
}

// projectLabel is the basename of a project path, separator-normalized (Run.ProjectPath is raw/backslashed
// on Windows). Empty in, empty out.
func projectLabel(p string) string {
	if p == "" {
		return ""
	}
	p = strings.ReplaceAll(p, "\\", "/")
	return path.Base(strings.TrimRight(p, "/"))
}

func buildCards(cands []candidate, nowMs int64) []wshrpc.JarvisGroundingCard {
	cards := make([]wshrpc.JarvisGroundingCard, 0, len(cands))
	for i, c := range cands {
		cards = append(cards, wshrpc.JarvisGroundingCard{
			N:          i + 1,
			SourceType: c.sourceType,
			Title:      c.title,
			Project:    c.project,
			AgeMs:      nowMs - c.ts,
			Freshness:  c.freshness,
			NavTarget:  c.navTarget,
		})
	}
	return cards
}

// buildPrompt assembles the numbered-source synthesis prompt. Source [n] aligns with card N == n. The model
// is instructed to cite [n] and never invent — grounding is deterministic; the model only writes prose.
func buildPrompt(question string, cands []candidate) string {
	var b strings.Builder
	b.WriteString("You are Jarvis, Wave's recall assistant. Answer the question using ONLY the numbered sources below.\n")
	b.WriteString("Cite every claim inline with [n] matching a source number. If the sources do not contain the answer, ")
	b.WriteString("say so plainly and cite nothing — never invent a fact or a citation.\n\n")
	b.WriteString("Question: " + question + "\n\nSources:\n")
	for i, c := range cands {
		b.WriteString(fmt.Sprintf("[%d] (%s · %s) %s\n", i+1, c.sourceType, c.project, c.title))
		if c.snippet != "" {
			b.WriteString("    " + strings.TrimSpace(c.snippet) + "\n")
		}
	}
	b.WriteString("\nAnswer concisely in prose with inline [n] citations.")
	return b.String()
}

// selectTerminal is the shim's grounding-quality verdict (spec invariant 7: weak/notfound are rewarded, not
// confabulated). Zero candidates => notfound (decided upstream without a model call). Candidates but the
// model cited none => weak. At least one in-range citation => answered.
func selectTerminal(cardCount, citationCount int) string {
	if cardCount == 0 {
		return "notfound"
	}
	if citationCount == 0 {
		return "weak"
	}
	return "answered"
}

var citationRe = regexp.MustCompile(`\[(\d+)\]`)

// countCitations counts DISTINCT in-range [n] references in the model's prose.
func countCitations(text string, cardCount int) int {
	seen := map[int]bool{}
	for _, m := range citationRe.FindAllStringSubmatch(text, -1) {
		n, err := strconv.Atoi(m[1])
		if err == nil && n >= 1 && n <= cardCount {
			seen[n] = true
		}
	}
	return len(seen)
}

// scopeProject returns the project filter for project-scope, else "" (no filter). GetRadarReports treats ""
// as "all reports".
func scopeProject(data wshrpc.CommandJarvisConverseData) string {
	if data.ScopeMode == "project" {
		return data.ProjectPath
	}
	return ""
}

// inScope decides whether a retrieved object passes the scope filter. object/attached scoping is applied at
// retrieval time (by ORef), so here they behave like "all"; project scope matches separator-normalized paths.
func inScope(data wshrpc.CommandJarvisConverseData, sourceType, project string) bool {
	if data.ScopeMode != "project" {
		return true
	}
	return normPath(project) == normPath(data.ProjectPath)
}

func normPath(p string) string {
	return strings.TrimRight(strings.ReplaceAll(p, "\\", "/"), "/")
}

// sortByRecency orders candidates newest-first (ties keep input order for determinism).
func sortByRecency(cands []candidate) {
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].ts > cands[j].ts })
}
