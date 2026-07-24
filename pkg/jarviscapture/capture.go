// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarviscapture is the thin dispatch->dossier writer for the Jarvis second brain.
// It creates a real dossier when a Run is dispatched so recall (sub-project C) has vault nodes
// to traverse. Deliberately separate from pkg/jarvisrecall, which stays a pure reader.
package jarviscapture

import (
	"context"
	"regexp"

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
		Ticket:     extractTicket(run.Goal),
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
