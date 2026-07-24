// pkg/jarvisattrib/lifecycle.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// loadDossier reads a dossier through an all-collections retriever (dossiers live in tasks/).
func loadDossier(v *wavevault.Vault, id string) (*jarvisdossier.Dossier, error) {
	return jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
}

// hardenEdge unions the run's canonical reference into the dossier refs block (idempotent), retrying
// once on a concurrent-write conflict with the re-read hash. This is how a confirmed edge becomes a
// durable, traversable reference that survives a cache rebuild.
func hardenEdge(v *wavevault.Vault, d *jarvisdossier.Dossier, runORef string) error {
	ref, ok := orefToRunRef(runORef)
	if !ok {
		return fmt.Errorf("jarvisattrib: not a run oref: %q", runORef)
	}
	for _, r := range d.Refs {
		if r == ref {
			return nil // already present
		}
	}
	refs := append(append([]string{}, d.Refs...), ref)
	res, err := jarvisdossier.SetRefs(v, d.ID, refs, d.Hash)
	if err != nil {
		return err
	}
	if res != nil && res.Conflict {
		d2, err := loadDossier(v, d.ID)
		if err != nil {
			return err
		}
		for _, r := range d2.Refs {
			if r == ref {
				return nil
			}
		}
		refs = append(append([]string{}, d2.Refs...), ref)
		_, err = jarvisdossier.SetRefs(v, d2.ID, refs, d2.Hash)
		return err
	}
	return nil
}

// applyOverrides replays the human override log over freshly-assembled edges: a detach suppresses the
// edge; an accept forces it confirmed. This is what makes a correction durable across a cache rebuild.
func applyOverrides(edges []AttributedEdge, overrides map[string]string) []AttributedEdge {
	out := make([]AttributedEdge, 0, len(edges))
	for _, e := range edges {
		switch overrides[e.DossierID+"|"+e.RunORef] {
		case "detach":
			continue
		case "accept":
			e.State = StateConfirmed
			out = append(out, e)
		default:
			out = append(out, e)
		}
	}
	return out
}

// Detach records a human rejection and removes any hardened ref so the edge fully disappears. The
// override keeps it suppressed even if the extractors would re-infer it.
func Detach(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) error {
	if err := appendOverride(v, overrideRecord{DossierID: dossierID, RunORef: runORef, Action: "detach", Actor: "human", Ts: nowFn()}); err != nil {
		return err
	}
	ref, ok := orefToRunRef(runORef)
	if !ok {
		return nil
	}
	// the override append above is the authoritative, durable suppression (applyOverrides drops the edge
	// regardless of refs). Stripping a previously-hardened canonical ref is best-effort cleanup — if the
	// dossier can't be loaded there is nothing hardened to strip, so the detach still stands.
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return nil
	}
	kept := make([]string, 0, len(d.Refs))
	removed := false
	for _, r := range d.Refs {
		if r == ref {
			removed = true
			continue
		}
		kept = append(kept, r)
	}
	if removed {
		if _, err := jarvisdossier.SetRefs(v, dossierID, kept, d.Hash); err != nil {
			return err
		}
	}
	return nil
}

// Accept records a human acceptance (provenance human-accept) and hardens the edge into canonical refs.
func Accept(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) error {
	if err := appendOverride(v, overrideRecord{DossierID: dossierID, RunORef: runORef, Action: "accept", Actor: "human", Ts: nowFn()}); err != nil {
		return err
	}
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return err
	}
	return hardenEdge(v, d, runORef)
}

// gatherLookups loads all Runs and builds the wstore/gitinfo-backed resolvers the pure core needs.
func gatherLookups(ctx context.Context) (edgeLookups, []*waveobj.Run, error) {
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return edgeLookups{}, nil, err
	}
	chNames := map[string]string{}
	lk := edgeLookups{
		channelName: func(oid string) string {
			if oid == "" {
				return ""
			}
			if n, ok := chNames[oid]; ok {
				return n
			}
			n := ""
			if ch, err := wstore.DBGet[*waveobj.Channel](ctx, oid); err == nil && ch != nil {
				n = ch.Name
			}
			chNames[oid] = n
			return n
		},
		commits: func(r *waveobj.Run) []string {
			if r.ProjectPath == "" || r.BaseCommit == "" || r.EndCommit == "" {
				return nil
			}
			cs, err := gitinfo.RangeLog(ctx, r.ProjectPath, r.BaseCommit, r.EndCommit)
			if err != nil {
				return nil
			}
			out := make([]string, len(cs))
			for i, c := range cs {
				out[i] = c.Subject
			}
			return out
		},
	}
	return lk, runs, nil
}

// EdgesFor is the D->C seam: the unified, confidence-descending dossier->Run edges (canonical layer-1
// refs + inferred layers 2-3), with the human override log applied and detached edges dropped.
// Read-only — it performs no writes (hardening is Harden/Accept).
func EdgesFor(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, error) {
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return nil, err
	}
	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return nil, err
	}
	ov, err := readOverrides(v)
	if err != nil {
		return nil, err
	}
	now := nowFn()
	det := applyOverrides(assembleEdges(d, runs, lk, now), ov)
	if len(det) > 0 {
		return det, nil // deterministic attribution present; L4 runs only when L1-3 are silent
	}
	// Orphan dossier: propose semantic (L4) edges. Degrades to det (empty) when embeddings are off.
	// Re-apply overrides so a previously-detached semantic edge stays suppressed.
	return applyOverrides(proposeSemanticEdges(ctx, d, runs, lk, now), ov), nil
}

// Backfill returns the still-informing (unconfirmed) subset of EdgesFor — the proposals a human would
// review and accept when attributing past work. The batched one-click-accept UI is deferred (G).
func Backfill(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, error) {
	all, err := EdgesFor(ctx, v, dossierID)
	if err != nil {
		return nil, err
	}
	var proposals []AttributedEdge
	for _, e := range all {
		if e.State == StateInforming {
			proposals = append(proposals, e)
		}
	}
	return proposals, nil
}

// Harden auto-promotes deterministic layer-2 edges that have passed probation into canonical refs
// (layer-3 weak edges require an explicit Accept). Idempotent; reloads the dossier before each write so
// the baseHash guard stays current.
func Harden(ctx context.Context, v *wavevault.Vault, dossierID string) error {
	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return err
	}
	byORef := map[string]*waveobj.Run{}
	for _, r := range runs {
		byORef["run:"+r.OID] = r
	}
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return err
	}
	now := nowFn()
	ov, err := readOverrides(v)
	if err != nil {
		return err
	}
	edges := applyOverrides(assembleEdges(d, runs, lk, now), ov)
	for _, e := range edges {
		if e.State == StateConfirmed || !containsLayer(e.Layers, 2) {
			continue // already canonical, or only a weak prior (needs human Accept)
		}
		r := byORef[e.RunORef]
		if r == nil || !pastProbation(r, now) {
			continue
		}
		d2, err := loadDossier(v, dossierID)
		if err != nil {
			return err
		}
		if err := hardenEdge(v, d2, e.RunORef); err != nil {
			return err
		}
	}
	return nil
}
