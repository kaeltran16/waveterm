// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build liveprobe

// Corpus probe for the attribution engine (sub-project D). It measures the shape of the real edge
// corpus so the J5 tuning constants (docs/open-issues.md) can be
// re-checked cheaply instead of by another ad-hoc pass — which matters because timeBoxMs becomes
// measurable by waiting rather than by collecting more data.
//
// It costs NO provider spend by construction: every attribution layer is deterministic, so every
// figure is too.
//
//	CGO_ENABLED=1 \
//	WAVETERM_CONFIG_HOME=<copy>/config WAVETERM_DATA_HOME=<copy>/data \
//	go test -tags liveprobe,osusergo,sqlite_omit_load_extension -run TestLiveCorpusShape -v ./pkg/jarvisattrib/
//
// Point the homes at a COPY of a real profile: snapshot the wstore DB with `VACUUM INTO` (consistent
// against a live app, unlike a file copy) and delete the stale -wal/-shm sidecars before pointing at
// it — applying those to a different database corrupts it.
package jarvisattrib

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

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
	t.Logf("max edges on one dossier=%d", maxEdges)

	// Lifecycle windows. AttributedEdge carries no timestamp, so probation and the time box are
	// measured against the runs the edges point at — which is what lifecycle itself compares.
	_, runs, err := gatherLookups(ctx)
	if err != nil {
		t.Fatalf("gatherLookups: %v", err)
	}
	now := nowFn()
	var pastTimeBox, undated int
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
		if age > timeBoxMs {
			pastTimeBox++
		}
	}
	t.Logf("runs=%d undated=%d pastTimeBox(>%dd)=%d oldestRunAge=%.1fd",
		len(runs), undated, timeBoxMs/msPerDay,
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

// TestLiveEdgesForStages times each stage of one EdgesFor (the graph bloom's server half) for 5 records, cold
// (first call in the process) and warm (the same record again), so a slow bloom names the stage to fix.
//
//	CGO_ENABLED=1 \
//	WAVETERM_CONFIG_HOME=<copy>/config WAVETERM_DATA_HOME=<copy>/data \
//	go test -tags liveprobe,osusergo,sqlite_omit_load_extension -run TestLiveEdgesForStages -v ./pkg/jarvisattrib/
//
// <copy>/data holds the VACUUM INTO snapshot at db/waveterm.db and the profile's memory-vault-root.txt. The
// vault is opened at that root without OpenVault's legacy-memory migration, so the probe writes nothing to it.
func TestLiveEdgesForStages(t *testing.T) {
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("bootstrap: %v (set WAVETERM_CONFIG_HOME and WAVETERM_DATA_HOME)", err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("init wstore against the profile copy: %v", err)
	}
	ctx := context.Background()
	rootFile, err := os.ReadFile(filepath.Join(wavebase.GetWaveDataDir(), "memory-vault-root.txt"))
	if err != nil {
		t.Fatalf("vault root: %v", err)
	}
	v, err := wavevault.OpenVaultAt(ctx, strings.TrimSpace(string(rootFile)))
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	all, err := taskDossiers(v)
	if err != nil {
		t.Fatalf("taskDossiers: %v", err)
	}
	// the records with the most refs: the ones a bloom has the most to draw for
	sort.Slice(all, func(i, j int) bool { return len(all[i].Refs) > len(all[j].Refs) })
	if len(all) > 5 {
		all = all[:5]
	}
	if len(all) == 0 {
		t.Fatal("no task records: the vault path is wrong")
	}
	var before runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for _, pass := range []string{"cold", "warm"} {
		for _, d := range all {
			var st struct{ runs, dossiers, claims, assemble, total time.Duration }
			t0 := time.Now()
			lk, runs, err := gatherLookups(ctx)
			if err != nil {
				t.Fatalf("gatherLookups: %v", err)
			}
			st.runs = time.Since(t0)
			ov, err := readOverrides(v)
			if err != nil {
				t.Fatalf("readOverrides: %v", err)
			}
			t1 := time.Now()
			ds, err := taskDossiers(v)
			if err != nil {
				t.Fatalf("taskDossiers: %v", err)
			}
			st.dossiers = time.Since(t1)
			t2 := time.Now()
			claims := claimedRuns(ds, runs, ov)
			st.claims = time.Since(t2)
			t3 := time.Now()
			edges := edgesForDossier(ctx, d, runs, lk, ov, claims, nowFn())
			st.assemble = time.Since(t3)
			st.total = time.Since(t0)
			t4 := time.Now()
			if _, _, err := EdgesFor(ctx, v, d.ID); err != nil {
				t.Fatalf("EdgesFor %s: %v", d.ID, err)
			}
			t.Logf("%s %s runs=%d records=%d edges=%d | runs load %v, dossiers %v, claims %v, assemble+git %v | stages %v, EdgesFor %v",
				pass, d.ID, len(runs), len(ds), len(edges), st.runs.Round(time.Millisecond), st.dossiers.Round(time.Millisecond),
				st.claims.Round(time.Millisecond), st.assemble.Round(time.Millisecond), st.total.Round(time.Millisecond),
				time.Since(t4).Round(time.Millisecond))
		}
	}
	// the run reader keeps what it decodes, so the heap it holds is part of the price of a warm bloom
	var after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&after)
	t.Logf("heap held after the calls: %.1f MB (before %.1f MB)", float64(after.HeapAlloc)/1e6, float64(before.HeapAlloc)/1e6)
}
