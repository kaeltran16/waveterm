// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// seedRunOID is the run a seeded dossier references. Tests insert a matching wstore Run when they
// need it resolved.
const seedRunOID = "dddddddd-0000-0000-0000-000000000001"

// seedVault builds a fixture vault: a dossier (ticket ABC-123) that references seedRunOID and a
// decision whose rationale body mentions "widget". Returns the vault and the dossier id.
func seedVault(t *testing.T) (*wavevault.Vault, string) {
	t.Helper()
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Ticket: "ABC-123", Objective: "ship the thing", Confidence: "med",
	})
	if err != nil {
		t.Fatalf("create dossier: %v", err)
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-" + seedRunOID}, hash); err != nil {
		t.Fatalf("set refs: %v", err)
	}
	if _, err := jarvisdossier.AppendDecision(v, jarvisdossier.DecisionFacts{
		TaskID: id, Actor: "jarvis", Provenance: "test",
		Summary: "widget approach", Rationale: "we chose the widget approach because it is simplest",
	}); err != nil {
		t.Fatalf("append decision: %v", err)
	}
	return v, id
}

func TestAnalyzeQuery(t *testing.T) {
	tickets, keywords := analyzeQuery("Why the WIDGET approach for ABC-123?")
	if len(tickets) != 1 || tickets[0] != "ABC-123" {
		t.Fatalf("tickets=%v want [ABC-123]", tickets)
	}
	has := func(w string) bool {
		for _, k := range keywords {
			if k == w {
				return true
			}
		}
		return false
	}
	if !has("widget") || !has("approach") {
		t.Fatalf("keywords=%v want widget+approach", keywords)
	}
	if has("the") || has("for") {
		t.Fatalf("short stopwords not dropped: %v", keywords)
	}
}

func TestSelectSeedsRanksStructuredFirst(t *testing.T) {
	v, dossierID := seedVault(t)
	r := v.Retriever(wavevault.AllScope())
	seeds, err := selectSeeds(r, "why the widget approach for ABC-123")
	if err != nil {
		t.Fatalf("selectSeeds: %v", err)
	}
	if len(seeds) < 2 {
		t.Fatalf("expected dossier + decision seeds, got %v", seeds)
	}
	if seeds[0] != dossierID {
		t.Fatalf("structured (ticket) hit should rank first, got %v", seeds)
	}
}
