// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarviscapture is the thin dispatch->dossier writer for the Jarvis second brain.
// It creates a real dossier when a Run is dispatched so the vault holds a node for the work.
package jarviscapture

import (
	"context"
	"log"
	"regexp"

	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// ticketRe matches an uppercase ticket identifier like ABC-123 (project key + number).
var ticketRe = regexp.MustCompile(`[A-Z][A-Z0-9]+-\d+`)

// extractTicket returns the first ticket id in a run goal, or "" if none.
func extractTicket(goal string) string {
	return ticketRe.FindString(goal)
}

// runTicket is the initiative's ticket when the run executes one of its chunks, else the first
// ticket id in the goal. A missing initiative is logged, not fatal: capture must not block dispatch.
func runTicket(ctx context.Context, run *waveobj.Run) string {
	if run.EffortRef != nil {
		e, err := effortstore.Get(ctx, run.EffortRef.EffortOID)
		if err != nil {
			log.Printf("jarviscapture: initiative %s for run %s: %v", run.EffortRef.EffortOID, run.OID, err)
		} else if e.Ticket != "" {
			return e.Ticket
		}
	}
	return extractTicket(run.Goal)
}

// CaptureRunDispatch creates a dossier for a freshly dispatched run in the default vault. Non-fatal:
// the caller logs and continues on error (dispatch must not fail because capture did).
func CaptureRunDispatch(ctx context.Context, run *waveobj.Run) error {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return err
	}
	_, err = captureRunDossier(ctx, v, run)
	return err
}

// captureRunDossier creates the dossier, references the run, and commits. Returns the dossier id.
// Takes an explicit vault so tests exercise it against a fixture vault.
func captureRunDossier(ctx context.Context, v *wavevault.Vault, run *waveobj.Run) (string, error) {
	id, hash, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{
		Ticket:     runTicket(ctx, run),
		Objective:  run.Goal,
		Confidence: "med",
	})
	if err != nil {
		return "", err
	}
	if _, err := jarvisdossier.SetRefs(v, id, []string{"run-" + run.OID}, hash); err != nil {
		return id, err
	}
	if err := v.Commit(ctx, "jarvis: capture dossier for run "+run.OID); err != nil {
		return id, err
	}
	return id, nil
}
