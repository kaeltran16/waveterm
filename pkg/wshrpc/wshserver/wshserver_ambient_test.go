// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestBuildAmbientProjectsTagsAndDecisions(t *testing.T) {
	dossiers := []wshrpc.SpaceSummary{
		{Id: "task-1", Ticket: "PROJ-142", Objective: "oauth pkce", Status: "active"},
		{Id: "task-2", Objective: "drop the electron shell", Status: "paused"},
		{Id: "task-3", Objective: "unattributed", Status: "active"},
	}
	// Layers is what the display bucket is read off, and mergeInto derives Confidence/Provenance from
	// it, so an edge without Layers is one the engine cannot produce. Set all three consistently.
	byDossier := map[string][]jarvisattrib.AttributedEdge{
		"task-1": {
			{DossierID: "task-1", RunORef: "run:r1", Layers: []int{1}, Provenance: "dispatch", Confidence: 1.0, State: jarvisattrib.StateConfirmed},
			{DossierID: "task-1", RunORef: "run:r2", Layers: []int{3}, Provenance: "structural", Confidence: 0.3, State: jarvisattrib.StateInforming},
		},
		"task-2": {
			{DossierID: "task-2", RunORef: "run:r2", Layers: []int{2}, Provenance: "ticket-match", Confidence: 0.8, State: jarvisattrib.StateConfirmed},
		},
	}
	decisions := []wshrpc.DecisionCard{
		{Id: "dec-a", Created: 100, Links: []string{"task-1"}, Rationale: "## drop-oldest on overflow\n\nbecause backpressure"},
		{Id: "dec-b", Created: 300, Links: []string{"task-2", "task-1"}, Rationale: "shared working tree"},
		{Id: "dec-orphan", Created: 200, Links: []string{"task-gone"}, Rationale: "links a dossier that no longer exists"},
	}

	got := buildAmbient(dossiers, byDossier, decisions)

	// every dossier is a tag target (a wikilink may reach an unattributed one); ticket wins over objective.
	if len(got.Tasks) != 3 {
		t.Fatalf("tasks = %d, want 3: %+v", len(got.Tasks), got.Tasks)
	}
	label := map[string]string{}
	for _, task := range got.Tasks {
		label[task.Id] = task.Label
	}
	if label["task-1"] != "PROJ-142" {
		t.Fatalf("task-1 label = %q, want the ticket PROJ-142", label["task-1"])
	}
	if label["task-2"] != "drop the electron shell" {
		t.Fatalf("task-2 label = %q, want the objective (no ticket)", label["task-2"])
	}

	// edges carry the U3 confidence encoding; an unattributed dossier contributes none.
	if len(got.Edges) != 3 {
		t.Fatalf("edges = %d, want 3: %+v", len(got.Edges), got.Edges)
	}
	for _, e := range got.Edges {
		if e.DossierId == "task-3" {
			t.Fatalf("unattributed task-3 must not produce an edge: %+v", e)
		}
	}
	var r2 []wshrpc.AmbientEdge
	for _, e := range got.Edges {
		if e.ORef == "run:r2" {
			r2 = append(r2, e)
		}
	}
	if len(r2) != 2 {
		t.Fatalf("run:r2 edges = %d, want 2 (a run may be attributed to two tasks): %+v", len(r2), r2)
	}
	if got.Edges[0].ORef != "run:r1" || got.Edges[0].Bucket != "strong" || got.Edges[0].State != "confirmed" {
		t.Fatalf("edge[0] = %+v, want run:r1 strong/confirmed", got.Edges[0])
	}
	if got.Edges[1].Bucket != "weak" || got.Edges[1].State != "informing" || got.Edges[1].Provenance != "structural" {
		t.Fatalf("edge[1] = %+v, want weak/informing/structural", got.Edges[1])
	}

	// decisions: one row per known link, newest-first; an unresolvable link is dropped.
	if len(got.Decisions) != 3 {
		t.Fatalf("decisions = %d, want 3 (dec-b twice, dec-a once, orphan dropped): %+v", len(got.Decisions), got.Decisions)
	}
	for _, d := range got.Decisions {
		if d.Id == "dec-orphan" {
			t.Fatalf("decision linking an unknown dossier must be dropped: %+v", d)
		}
	}
	if got.Decisions[0].Created != 300 || got.Decisions[len(got.Decisions)-1].Id != "dec-a" {
		t.Fatalf("decisions not newest-first: %+v", got.Decisions)
	}
	if got.Decisions[len(got.Decisions)-1].Title != "drop-oldest on overflow" {
		t.Fatalf("title = %q, want the rationale's first line stripped of markdown", got.Decisions[len(got.Decisions)-1].Title)
	}
}

func TestBuildAmbientEmptyVaultProducesNoTags(t *testing.T) {
	got := buildAmbient(nil, nil, nil)
	if len(got.Tasks) != 0 || len(got.Edges) != 0 || len(got.Decisions) != 0 {
		t.Fatalf("empty vault must produce nothing, got %+v", got)
	}
}

func TestAmbientLabelAndTitleAreBounded(t *testing.T) {
	long := strings.Repeat("ünïcödé ", 40)
	label := ambientLabel(wshrpc.SpaceSummary{Id: "t", Objective: long})
	if n := len([]rune(label)); n > ambientLabelMax+1 { // +1 allows the ellipsis
		t.Fatalf("label runes = %d, want <= %d + ellipsis", n, ambientLabelMax)
	}
	if !strings.HasSuffix(label, "…") {
		t.Fatalf("bounded label should be elided: %q", label)
	}
	// truncation must land on a rune boundary, never mid-character
	if strings.Contains(label, "�") {
		t.Fatalf("label split a multi-byte rune: %q", label)
	}
	if title := decisionTitle("\n\n   \n> - the actual line\nsecond"); title != "the actual line" {
		t.Fatalf("title = %q, want the first non-empty line without its markdown lead-in", title)
	}
	if title := decisionTitle(""); title != "" {
		t.Fatalf("empty rationale should yield an empty title, got %q", title)
	}
}
