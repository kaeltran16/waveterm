// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisdossier

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func TestAppendDecisionLinksAndIsTraversable(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	taskID, _, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-9", Objective: "auth cleanup"})
	if err != nil {
		t.Fatal(err)
	}
	decID, err := AppendDecision(v, DecisionFacts{
		TaskID:     taskID,
		Actor:      "worker-3",
		Provenance: "worker-report",
		Links:      []string{"run-abc"},
		Rationale:  "dropped refresh tokens; mobile re-auths silently",
		Summary:    "drop refresh tokens",
	})
	if err != nil {
		t.Fatalf("AppendDecision: %v", err)
	}

	// the dossier's refs now link the decision
	d, err := LoadDossier(v.Retriever(wavevault.AllScope()), taskID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ref := range d.Refs {
		if ref == decID {
			found = true
		}
	}
	if !found {
		t.Fatalf("dossier refs %+v must contain decision id %q", d.Refs, decID)
	}

	// and the link is a REAL edge: Expand from the task reaches the decision node
	sg, err := v.Retriever(wavevault.AllScope()).Expand([]string{taskID}, wavevault.ExpandOpts{Depth: 1})
	if err != nil {
		t.Fatal(err)
	}
	reached := false
	for _, n := range sg.Nodes {
		if n.ID == decID {
			reached = true
		}
	}
	if !reached {
		t.Fatalf("Expand from %q did not reach decision %q — refs block is not a real edge", taskID, decID)
	}
}

func TestAppendDecisionCommitsAsJarvis(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	taskID, _, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-10", Objective: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AppendDecision(v, DecisionFacts{TaskID: taskID, Actor: "human", Provenance: "human-submit", Summary: "s"}); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "decision"); err != nil {
		t.Fatal(err)
	}
	out, err := wavevault.HeadAuthorForTest(context.Background(), v.Root)
	if err != nil {
		t.Fatal(err)
	}
	if out != "Jarvis" {
		t.Fatalf("decision commit author = %q, want Jarvis", out)
	}
}

func TestSupersedeDecisionPreservesRationale(t *testing.T) {
	fixedNow(t, 1753324800000)
	v := newVault(t)
	taskID, _, err := CreateDossier(v, DossierFacts{Ticket: "PROJ-11", Objective: "y"})
	if err != nil {
		t.Fatal(err)
	}
	decID, err := AppendDecision(v, DecisionFacts{
		TaskID: taskID, Actor: "worker-1", Provenance: "worker-report",
		Rationale: "chose approach A because it needs no migration", Summary: "approach a",
	})
	if err != nil {
		t.Fatal(err)
	}
	r := v.Retriever(wavevault.AllScope())
	before, err := LoadDecision(r, decID)
	if err != nil {
		t.Fatalf("LoadDecision: %v", err)
	}
	if before.Status != "active" {
		t.Fatalf("initial status = %q", before.Status)
	}
	res, err := SupersedeDecision(v, decID, "superseded", before.Hash)
	if err != nil {
		t.Fatalf("SupersedeDecision: %v", err)
	}
	if res.Conflict {
		t.Fatal("no concurrent edit — Conflict must be false")
	}
	after, err := LoadDecision(v.Retriever(wavevault.AllScope()), decID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != "superseded" {
		t.Fatalf("status = %q, want superseded", after.Status)
	}
	if after.Rationale != before.Rationale {
		t.Fatalf("rationale changed across a status mutation: %q -> %q", before.Rationale, after.Rationale)
	}
}

func TestLoadDecisionTolerantOfMissingProvenance(t *testing.T) {
	v := newVault(t)
	// an "old" decision missing provenance and the links block
	if _, err := v.Create("decisions", "old.md",
		"---\nid: dec-old\ncreated: 1753000000000\nactor: human\nstatus: active\n---\n\nlegacy rationale\n"); err != nil {
		t.Fatal(err)
	}
	d, err := LoadDecision(v.Retriever(wavevault.AllScope()), "dec-old")
	if err != nil {
		t.Fatalf("tolerant load must not error: %v", err)
	}
	if d.Provenance != "" || len(d.Links) != 0 {
		t.Fatalf("tolerant projection wrong: %+v", d)
	}
	if d.Rationale != "legacy rationale" {
		t.Fatalf("rationale = %q", d.Rationale)
	}
}
