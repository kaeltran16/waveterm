// pkg/jarvisattrib/lifecycle.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"context"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"

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

// gatherLookups loads all Runs and builds the wstore/gitinfo-backed resolvers the pure core needs. The runs are
// shared (decoded once per version) and read only: a full decode was ~0.7 s of every call on a 3,200-run profile.
func gatherLookups(ctx context.Context) (edgeLookups, []*waveobj.Run, error) {
	runs, err := wstore.GetAllRunsShared(ctx)
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
			return rangeSubjects(ctx, r.ProjectPath, r.BaseCommit, r.EndCommit)
		},
	}
	return lk, runs, nil
}

// subjectsCache holds each commit range's subjects for the life of the process. base and end are SHAs, so a range
// never changes, and without it every EdgesFor re-shelled a git log per stored run: 5-10 s on a real profile, past
// the 5 s RPC budget, which left the record peek saying no session was ever attributed.
var subjectsCache = struct {
	sync.Mutex
	m map[string][]string
}{m: map[string][]string{}}

func rangeSubjects(ctx context.Context, path, base, end string) []string {
	key := path + "\x00" + base + "\x00" + end
	subjectsCache.Lock()
	cs, ok := subjectsCache.m[key]
	subjectsCache.Unlock()
	if ok {
		return cs
	}
	// most stored runs worked in a temp dir that is gone by now, and a git spawn per one of those was most of the cost
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	commits, err := gitinfo.RangeLog(ctx, path, base, end)
	if err != nil {
		// not cached: the repo may be busy or gone for now, and a later call should try again
		return nil
	}
	cs = make([]string, len(commits))
	for i, c := range commits {
		cs[i] = c.Subject
	}
	subjectsCache.Lock()
	subjectsCache.m[key] = cs
	subjectsCache.Unlock()
	return cs
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
// with the override log applied, less any guess of a run another dossier claims (claimedRuns). A confirmed
// edge is never dropped, so a run accepted onto two dossiers stays on both.
func edgesForDossier(ctx context.Context, d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, ov map[string]string, claims map[string]map[string]bool, now int64) []AttributedEdge {
	edges := applyOverrides(assembleEdges(d, runs, lk, now), ov)
	out := edges[:0]
	for _, e := range edges {
		if e.State != StateConfirmed && claimedByOther(claims[e.RunORef], d.ID) {
			continue
		}
		out = append(out, e)
	}
	return out
}

func claimedByOther(claimants map[string]bool, dossierID string) bool {
	for id := range claimants {
		if id != dossierID {
			return true
		}
	}
	return false
}

// loadDossierFn is a seam so a test can make one record fail: against a real vault the load cannot, since
// the node was listed from the same graph it is read from.
var loadDossierFn = jarvisdossier.LoadDossier

// taskDossiers loads every dossier in the tasks collection, skipping any that fails to load (tolerant,
// mirroring the tasks-collection projection) and logging the skip. It reads the vault only: no git.
func taskDossiers(v *wavevault.Vault) ([]*jarvisdossier.Dossier, error) {
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}})
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return nil, fmt.Errorf("jarvisattrib: querying tasks: %w", err)
	}
	out := make([]*jarvisdossier.Dossier, 0, len(nodes))
	for _, n := range nodes {
		d, err := loadDossierFn(r, n.ID)
		if err != nil {
			log.Printf("jarvisattrib: skipping record %s (%s): %v", n.ID, n.Path, err)
			continue
		}
		out = append(out, d)
	}
	return out, nil
}

// EdgesFor is the D->C seam: the unified, confidence-descending dossier->Run edges (canonical layer-1
// refs + inferred layers 2-3), with the human override log applied and detached edges dropped.
// Read-only — it performs no writes (hardening is Harden/Accept). It also returns every Run it loaded, so a
// caller that needs the edges' runs indexes these instead of reading the whole run table a second time. The
// runs are shared with other readers: never modify one.
func EdgesFor(ctx context.Context, v *wavevault.Vault, dossierID string) ([]AttributedEdge, []*waveobj.Run, error) {
	d, err := loadDossier(v, dossierID)
	if err != nil {
		return nil, nil, err
	}
	lk, runs, err := gatherLookups(ctx)
	if err != nil {
		return nil, nil, err
	}
	ov, err := readOverrides(v)
	if err != nil {
		return nil, nil, err
	}
	// every record's refs, so a run another record claims is no guess of this one
	all, err := taskDossiers(v)
	if err != nil {
		return nil, nil, err
	}
	return edgesForDossier(ctx, d, runs, lk, ov, claimedRuns(all, runs, ov), nowFn()), runs, nil
}

// AllEdges is EdgesFor over every dossier in the vault, sharing one run load, one override read and one
// commit cache. The ambient layer needs the whole run->dossier map at once; looping EdgesFor instead
// would reload every Run and re-shell the git range-log per dossier. Dossiers that fail to load are
// skipped (tolerant, mirroring the tasks-collection projection); dossiers with no edges are omitted.
func AllEdges(ctx context.Context, v *wavevault.Vault) (map[string][]AttributedEdge, error) {
	dossiers, err := taskDossiers(v)
	if err != nil {
		return nil, err
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
	claims := claimedRuns(dossiers, runs, ov)
	out := map[string][]AttributedEdge{}
	for _, d := range dossiers {
		if edges := edgesForDossier(ctx, d, runs, lk, ov, claims, now); len(edges) > 0 {
			out[d.ID] = edges
		}
	}
	return out, nil
}
