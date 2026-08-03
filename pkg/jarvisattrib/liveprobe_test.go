// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build liveprobe

// Corpus probe for the attribution engine (sub-project D). It measures the shape of the real edge
// corpus so the tuning-constants entry (J5) in docs/jarvis-second-brain-open-issues.md can be
// re-checked cheaply instead of by another ad-hoc pass — which matters because timeBoxMs becomes
// measurable by waiting rather than by collecting more data.
//
// It costs NO provider spend by construction: every figure is deterministic, and the semantic layer
// (L4) is the only thing here that could embed anything. L4 runs only for a dossier with no
// deterministic edge at all, so the orphan count this probe reports is also the answer to "could this
// have spent anything" — zero orphans means zero embedding calls.
//
//	CGO_ENABLED=1 CGO_CFLAGS="-O2 -g -I<repo>/pkg/jarvisembed/csrc" \
//	WAVETERM_CONFIG_HOME=<copy>/config WAVETERM_DATA_HOME=<copy>/data \
//	go test -tags liveprobe,osusergo,sqlite_omit_load_extension -run TestLiveCorpusShape -v ./pkg/jarvisattrib/
//
// Point the homes at a COPY of a real profile: snapshot the wstore DB with `VACUUM INTO` (consistent
// against a live app, unlike a file copy) and delete the stale -wal/-shm sidecars before pointing at
// it — applying those to a different database corrupts it.
package jarvisattrib

import (
	"context"
	"sort"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const msPerDay = 24 * 60 * 60 * 1000

func TestLiveCorpusShape(t *testing.T) {
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("bootstrap: %v (set WAVETERM_CONFIG_HOME and WAVETERM_DATA_HOME)", err)
	}
	wconfig.GetWatcher().Start()
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("init wstore against the profile copy: %v", err)
	}
	ctx := context.Background()
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	t.Logf("profile: config=%s data=%s", wavebase.GetWaveConfigDir(), wavebase.GetWaveDataDir())
	t.Logf("embeddings available=%v (L4 fires only for a dossier with zero deterministic edges)",
		jarvisembed.Available())

	byDossier, err := AllEdges(ctx, v)
	if err != nil {
		t.Fatalf("AllEdges: %v", err)
	}

	perLayer := map[int]int{}
	confHist := map[float64]int{}
	bucketHist := map[string]int{}
	stateHist := map[string]int{}
	runORefs := map[string]bool{}
	var perDossier []int
	var total int
	for _, edges := range byDossier {
		perDossier = append(perDossier, len(edges))
		for _, e := range edges {
			total++
			runORefs[e.RunORef] = true
			for _, l := range e.Layers {
				perLayer[l]++
			}
			confHist[e.Confidence]++
			bucketHist[BucketFor(e.Layers)]++
			stateHist[string(e.State)]++
		}
	}
	sort.Ints(perDossier)

	t.Logf("dossiers=%d attributedRuns=%d totalEdges=%d", len(byDossier), len(runORefs), total)
	t.Logf("edges per dossier: %v", perDossier)
	t.Logf("by layer: %v", perLayer)
	t.Logf("confidence histogram: %v", confHist)
	t.Logf("bucket histogram: %v", bucketHist)
	t.Logf("state histogram: %v", stateHist)

	// The empty middle is the finding that blocks calibrating the bucket cutoffs and weightLayer2/4.
	// Log it as a first-class result so a future run can tell at a glance whether it has changed.
	if len(confHist) <= 2 {
		t.Logf("confidence space is still degenerate (%d distinct values): no discrimination pressure "+
			"on any weight or cutoff", len(confHist))
	}

	// The traversal caps: seedTopK 6 and expandFanout 8 were never observed binding. Report the real
	// maximum so "the cap never binds" stays a measurement rather than an assumption.
	maxEdges := 0
	if len(perDossier) > 0 {
		maxEdges = perDossier[len(perDossier)-1]
	}
	t.Logf("max edges on one dossier=%d (expandFanout=%d binds only above this)", maxEdges, expandFanoutRef())

	// Lifecycle windows. AttributedEdge carries no timestamp, so probation and the time box are
	// measured against the runs the edges point at — which is what lifecycle itself compares.
	_, runs, err := gatherLookups(ctx)
	if err != nil {
		t.Fatalf("gatherLookups: %v", err)
	}
	now := nowFn()
	var inProbation, pastTimeBox, undated int
	oldestAgeMs := int64(0)
	for _, r := range runs {
		ts := r.CompletedTs
		if ts == 0 {
			ts = r.CreatedTs
		}
		if ts == 0 {
			undated++
			continue
		}
		age := now - ts
		if age > oldestAgeMs {
			oldestAgeMs = age
		}
		if age < probationMs {
			inProbation++
		}
		if age > timeBoxMs {
			pastTimeBox++
		}
	}
	t.Logf("runs=%d undated=%d inProbation(<%dh)=%d pastTimeBox(>%dd)=%d oldestRunAge=%.1fd",
		len(runs), undated, probationMs/(60*60*1000), inProbation, timeBoxMs/msPerDay,
		pastTimeBox, float64(oldestAgeMs)/float64(msPerDay))
	if pastTimeBox == 0 {
		t.Logf("timeBoxMs is still unexercised: no run is older than %d days, so no layer-3 edge has "+
			"had the chance to decay", timeBoxMs/msPerDay)
	}

	if total == 0 {
		t.Fatal("no attributed edges: the profile copy is empty or the vault path is wrong, so every " +
			"figure above is vacuous")
	}
}

// expandFanoutRef reports jarvisrecall's traversal fan-out cap without importing that package (which
// would be an import cycle through the recall engine). Keep in sync with jarvisrecall.expandFanout.
func expandFanoutRef() int { return 8 }
