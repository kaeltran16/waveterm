// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisbackfill

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// Result reports what an Apply actually did. Errors are collected per item rather than aborting: a
// single unwritable dossier should not cost the rest of the import, and a partial corpus is still a
// corpus as long as the gaps are visible.
type Result struct {
	DossiersCreated   int
	DossiersExisting  int
	DecisionsCreated  int
	DecisionsExisting int
	Errors            []string
}

// Apply writes a Plan into a vault and commits once.
//
// Idempotent by construction: dossier ids are a deterministic slug of the objective, so a re-run
// finds the existing file and skips it rather than duplicating. That matters because calibration is
// iterative — this gets run, inspected, reverted and run again.
func Apply(ctx context.Context, v *wavevault.Vault, p Plan) (Result, error) {
	var res Result

	ids := make([]string, len(p.Dossiers))
	for i, d := range p.Dossiers {
		id, created, err := applyDossier(v, d)
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("dossier %q: %v", d.Facts.Objective, err))
			continue
		}
		ids[i] = id
		if created {
			res.DossiersCreated++
		} else {
			res.DossiersExisting++
		}
	}

	for _, dec := range p.Decisions {
		idx, ok := p.DossierForRun(dec.OwnerRunOID)
		if !ok || ids[idx] == "" {
			res.Errors = append(res.Errors, fmt.Sprintf("decision for run %s: owning dossier was not written", dec.OwnerRunOID))
			continue
		}
		dec.Facts.TaskID = ids[idx]
		if _, err := jarvisdossier.AppendDecision(v, dec.Facts); err != nil {
			// a re-import finds its own decision files already present; that is a skip, not a failure
			if isExists(err) {
				res.DecisionsExisting++
				continue
			}
			res.Errors = append(res.Errors, fmt.Sprintf("decision %q: %v", dec.Facts.Summary, err))
			continue
		}
		res.DecisionsCreated++
	}

	if res.DossiersCreated == 0 && res.DecisionsCreated == 0 {
		return res, nil
	}
	if err := v.Commit(ctx, "jarvis backfill"); err != nil {
		return res, fmt.Errorf("commit vault: %w", err)
	}
	return res, nil
}

// applyDossier creates one dossier and writes the owner's canonical run ref. It reports whether it
// created the dossier; on the idempotent-skip path it still returns the id, so decisions belonging
// to an already-imported dossier resolve their TaskID instead of looking orphaned.
func applyDossier(v *wavevault.Vault, d PlannedDossier) (string, bool, error) {
	id, hash, err := jarvisdossier.CreateDossier(v, d.Facts)
	if err != nil {
		if isExists(err) {
			return jarvisdossier.DossierID(d.Facts), false, nil
		}
		return "", false, err
	}

	// Only the owner's ref is written. Siblings are deliberately left out so D infers them
	// structurally (layer 3, "informing") instead of every edge arriving pre-confirmed at 1.0.
	refs := []string{"run-" + d.OwnerRun}
	wr, err := jarvisdossier.SetRefs(v, id, refs, hash)
	if err != nil {
		return id, true, fmt.Errorf("set refs: %w", err)
	}
	hash = wr.Hash

	if d.Status != "active" {
		wr, err := jarvisdossier.SetStatus(v, id, d.Status, hash)
		if err != nil {
			return id, true, fmt.Errorf("set status: %w", err)
		}
		hash = wr.Hash
	}

	// Every setter stamps updated=now, so the historical window has to be restored last. Left as-is
	// the dossier would claim it was touched at import time, which is both untrue and the kind of
	// fabricated timestamp this import exists to avoid.
	if _, err := v.Write(id, jarvisdossier.DossierSpec(), []wavevault.RegionEdit{
		{Kind: wavevault.FrontmatterKey, Name: "updated", Value: strconv.FormatInt(d.Updated, 10)},
	}, hash); err != nil {
		return id, true, fmt.Errorf("restore updated: %w", err)
	}
	return id, true, nil
}

// isExists detects wavevault's create-collision error. Matched on message because wavevault exposes
// no sentinel; the collision is the idempotent-skip signal, so a miss would duplicate the corpus.
func isExists(err error) bool {
	return err != nil && strings.Contains(err.Error(), "already exists")
}
