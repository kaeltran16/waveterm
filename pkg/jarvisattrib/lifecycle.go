// pkg/jarvisattrib/lifecycle.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"context"
	"fmt"
	"sort"
	"strings"

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

// DetachedEdges lists the human-suppressed edges for one dossier (dossierID != "") or one run
// (runORef != ""), so a detach has somewhere to be undone from. The override log is the source of truth
// rather than the assembled edges: Detach also strips a hardened canonical ref, so a detached layer-1
// edge is no longer derivable and assembling alone would drop the very row the user needs. Assembly is
// consulted only to enrich a row whose signal still exists — an edge with no derivable signal comes back
// with no Layers, no Provenance and zero Confidence, which the caller must render as absent rather than
// as weak.
func DetachedEdges(ctx context.Context, v *wavevault.Vault, dossierID, runORef string) ([]AttributedEdge, error) {
	ov, err := readOverrides(v)
	if err != nil {
		return nil, err
	}
	type pair struct{ dossier, run string }
	var pairs []pair
	for key, action := range ov {
		if action != "detach" {
			continue
		}
		parts := strings.SplitN(key, "|", 2)
		if len(parts) != 2 {
			continue
		}
		if dossierID != "" && parts[0] != dossierID {
			continue
		}
		if runORef != "" && parts[1] != runORef {
			continue
		}
		pairs = append(pairs, pair{dossier: parts[0], run: parts[1]})
	}
	if len(pairs) == 0 {
		return nil, nil
	}
	// map iteration is unordered; without this the rows reshuffle between reads
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].dossier != pairs[j].dossier {
			return pairs[i].dossier < pairs[j].dossier
		}
		return pairs[i].run < pairs[j].run
	})

	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return nil, err
	}
	lk = memoizeCommits(lk)
	now := nowFn()
	// one assembly per distinct dossier, reused across its pairs
	assembled := map[string][]AttributedEdge{}
	out := make([]AttributedEdge, 0, len(pairs))
	for _, p := range pairs {
		edges, ok := assembled[p.dossier]
		if !ok {
			if d, err := loadDossier(v, p.dossier); err == nil {
				edges = assembleEdges(d, runs, lk, now)
			}
			assembled[p.dossier] = edges
		}
		e := AttributedEdge{DossierID: p.dossier, RunORef: p.run, State: StateDetached}
		for _, cand := range edges {
			if cand.RunORef == p.run {
				e.Layers = cand.Layers
				e.Provenance = cand.Provenance
				e.Confidence = cand.Confidence
				break
			}
		}
		out = append(out, e)
	}
	return out, nil
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

// memoizeCommits wraps a lookups' commit resolver in a per-run cache. AllEdges runs the extractors over
// every dossier against the same run set, so uncached the git range-log for a run would re-run once per
// dossier.
func memoizeCommits(lk edgeLookups) edgeLookups {
	cache := map[string][]string{}
	inner := lk.commits
	lk.commits = func(r *waveobj.Run) []string {
		if cs, ok := cache[r.OID]; ok {
			return cs
		}
		cs := inner(r)
		cache[r.OID] = cs
		return cs
	}
	return lk
}

// edgesForDossier is the shared per-dossier core behind EdgesFor and AllEdges: the deterministic layers
// with the override log applied, falling back to the semantic (L4) proposal only when they are silent.
func edgesForDossier(ctx context.Context, d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, ov map[string]string, now int64) []AttributedEdge {
	raw := assembleEdges(d, runs, lk, now)
	det := applyOverrides(raw, ov)
	if !shouldProposeSemantic(raw, d.ID, ov) {
		return det
	}
	// Orphan dossier: propose semantic (L4) edges. Degrades to det (empty) when embeddings are off.
	// Re-apply overrides so a previously-detached semantic edge stays suppressed.
	return applyOverrides(proposeSemanticEdges(ctx, d, runs, lk, now), ov)
}

// shouldProposeSemantic reports whether the semantic (L4) proposal should run for a dossier. It is a
// fallback for a dossier nothing has attributed, so it must read the edges *before* the override log is
// applied: a dossier whose deterministic edges were assembled and then suppressed by a human has been
// corrected, not orphaned. Detach also strips the hardened canonical ref, so such a dossier can assemble
// to nothing at all — the override log is the only remaining evidence that it was ever attributed, and
// without this the proposal re-runs on every read to second-guess the correction.
func shouldProposeSemantic(raw []AttributedEdge, dossierID string, ov map[string]string) bool {
	if len(raw) > 0 {
		return false // L1-3 are not silent
	}
	prefix := dossierID + "|"
	for k, action := range ov {
		if action == "detach" && strings.HasPrefix(k, prefix) {
			return false
		}
	}
	return true
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
	return edgesForDossier(ctx, d, runs, lk, ov, nowFn()), nil
}

// AllEdges is EdgesFor over every dossier in the vault, sharing one run load, one override read and one
// commit cache. The ambient layer needs the whole run->dossier map at once; looping EdgesFor instead
// would reload every Run and re-shell the git range-log per dossier. Dossiers that fail to load are
// skipped (tolerant, mirroring the tasks-collection projection); dossiers with no edges are omitted.
func AllEdges(ctx context.Context, v *wavevault.Vault) (map[string][]AttributedEdge, error) {
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}})
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return nil, fmt.Errorf("jarvisattrib: querying tasks: %w", err)
	}
	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return nil, err
	}
	lk = memoizeCommits(lk)
	ov, err := readOverrides(v)
	if err != nil {
		return nil, err
	}
	now := nowFn()
	out := map[string][]AttributedEdge{}
	for _, n := range nodes {
		d, err := jarvisdossier.LoadDossier(r, n.ID)
		if err != nil {
			continue
		}
		if edges := edgesForDossier(ctx, d, runs, lk, ov, now); len(edges) > 0 {
			out[d.ID] = edges
		}
	}
	return out, nil
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
