// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build liveprobe

// Live probe for J2's two open verify legs. Not part of the normal suite: it needs a real vault, a
// real embedding index and a real provider key, so it is behind the `liveprobe` build tag and reads
// its profile from the environment.
//
//	CGO_ENABLED=1 CGO_CFLAGS="-O2 -g -I<repo>/pkg/jarvisembed/csrc" \
//	WAVETERM_CONFIG_HOME=<copy>/config WAVETERM_DATA_HOME=<copy>/data \
//	go test -tags liveprobe,osusergo,sqlite_omit_load_extension -run TestLiveRecallProbe -v ./pkg/jarvisrecall/
//
// Point the homes at a COPY of a real profile — Query reconciles, which writes to the index.
package jarvisrecall

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisbackfill"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// probeCase is one paraphrase: a query that shares no >=4-char token with the target it should find.
// wantID is matched as a substring of the vault node id.
type probeCase struct {
	name   string
	query  string
	wantID string
}

// probeDeepK is the diagnostic depth: how far down the semantic ranking to look for a target that
// kSem missed, to separate "ranked too deep" from "not retrieved at all".
const probeDeepK = 60

var probeCases = []probeCase{
	// "notes" is deliberately avoided in every query: each dossier body carries a literal "## Notes"
	// heading, so that one token L2-matches all 14 and makes the case uninformative.
	{"dossier/crash", "why did the program blow up right after opening the saved reminders pane", "the-app-crash-when-i-navigate-to-memory-tab"},
	{"dossier/pill", "make the badge hue different for those two assistants", "change-the-claude-code-and-codex-pill-color"},
	{"dossier/shim", "find leftover dead shim methods still referenced in the react layer", "grep-the-frontend-for-remaining-getapi-closetab"},
	{"dossier/naming", "the heading relabels itself incorrectly once a job finishes", "the-auto-tab-name-change-doesnt-work"},
	{"decision/validation", "was the trust perimeter for user-supplied payloads altered", "the-input-validation-security-boundary-was-modif"},
}

func TestLiveRecallProbe(t *testing.T) {
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("bootstrap: %v (set WAVETERM_CONFIG_HOME and WAVETERM_DATA_HOME)", err)
	}
	wconfig.GetWatcher().Start()

	cfg := wconfig.GetWatcher().GetFullConfig().Settings
	available := jarvisembed.Available()
	t.Logf("profile: config=%s data=%s", wavebase.GetWaveConfigDir(), wavebase.GetWaveDataDir())
	t.Logf("embed:   enabled=%v model=%q baseurl=%q available=%v",
		cfg.JarvisEmbedEnabled, cfg.JarvisEmbedModel, cfg.JarvisEmbedBaseURL, available)

	ctx := context.Background()
	v, err := openVault(ctx)
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	r := v.Retriever(wavevault.AllScope())
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		t.Fatalf("load vault: %v", err)
	}
	byColl := map[string]int{}
	for _, n := range nodes {
		byColl[n.Collection]++
	}
	t.Logf("vault:   %d nodes %v", len(nodes), byColl)

	// The off-set is what recall sees with embeddings disabled: OpenIndex returns an unavailable
	// handle (index.go), so semanticSeeds yields nil and only L1+L2 contribute.
	offIndex := func(context.Context) (*jarvisembed.Index, error) {
		return jarvisembed.OpenIndexAtForTest(ctx, "", nil)
	}

	var onFound, offFound, total int
	for _, tc := range probeCases {
		total++
		restore := SetOpenIndexForTest(offIndex)
		seedsOff, errOff := selectSeeds(ctx, v, r, tc.query)
		SetOpenIndexForTest(restore)
		if errOff != nil {
			t.Errorf("%s: seeds(off): %v", tc.name, errOff)
			continue
		}
		seedsOn, errOn := selectSeeds(ctx, v, r, tc.query)
		if errOn != nil {
			t.Errorf("%s: seeds(on): %v", tc.name, errOn)
			continue
		}

		hitOff := containsID(seedsOff, tc.wantID)
		hitOn := containsID(seedsOn, tc.wantID)
		if hitOn {
			onFound++
		}
		if hitOff {
			offFound++
		}
		t.Logf("\n%s\n  query      %q\n  overlap    %v\n  L1+L2      %d seeds, target %s\n  L1+L2+L3   %d seeds, target %s\n  added by L3 %v\n  %s",
			tc.name, tc.query, overlap(tc.query, tc.wantID),
			len(seedsOff), yesNo(hitOff), len(seedsOn), yesNo(hitOn), added(seedsOff, seedsOn),
			diagnose(ctx, t, v, tc.wantID, tc.query))
	}
	t.Logf("\nRESULT  target found: %d/%d with embeddings on, %d/%d with embeddings off", onFound, total, offFound, total)
}

// TestLiveKeywordReachesDossier is J9a's verify against the real corpus. A dossier's only prose is its
// frontmatter `objective`; its body is marker comments and an empty `## Notes`. So a keyword drawn from
// a dossier's own objective is the weakest possible lexical query, and before wavevault.searchableText
// it retrieved nothing for *every* dossier — meaning the semantic lane was the only seed path into
// tasks/, which is not the graceful degradation invariant 11 describes.
func TestLiveKeywordReachesDossier(t *testing.T) {
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	wconfig.GetWatcher().Start()
	ctx := context.Background()
	v, err := openVault(ctx)
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	r := v.Retriever(wavevault.AllScope())
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		t.Fatalf("load vault: %v", err)
	}

	var checked, reached int
	for _, n := range nodes {
		if n.Collection != wavevault.CollTasks {
			continue
		}
		obj, _ := n.Frontmatter["objective"].(string)
		if strings.TrimSpace(obj) == "" {
			continue
		}
		// the longest token is the most distinctive one the objective offers
		_, toks := analyzeQuery(obj)
		kw := ""
		for _, tk := range toks {
			if len(tk) > len(kw) {
				kw = tk
			}
		}
		if kw == "" {
			continue
		}
		checked++
		hits, err := v.Retriever(wavevault.AllScope()).Search(kw)
		if err != nil {
			t.Fatalf("search %q: %v", kw, err)
		}
		if containsHit(hits, n.ID) {
			reached++
		} else {
			t.Errorf("dossier %s unreachable by %q, its own objective's most distinctive keyword", n.ID, kw)
		}
	}
	if checked == 0 {
		t.Skip("no dossiers with an objective in this vault")
	}
	t.Logf("RESULT  %d/%d dossiers reachable by a keyword from their own objective", reached, checked)
}

func containsHit(hits []wavevault.Hit, id string) bool {
	for _, h := range hits {
		if h.Node.ID == id {
			return true
		}
	}
	return false
}

// TestLiveAmbientPremise answers whether a given profile's wstore can produce ambient tags at all:
// the vault is shared across profiles but Runs are per-profile, so a dossier ref that resolves to no
// Run yields no edge and no tag. Pass DBs as PROBE_DBS=<path>[,<path>...].
func TestLiveAmbientPremise(t *testing.T) {
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	wconfig.GetWatcher().Start()
	dbs := strings.Split(os.Getenv("PROBE_DBS"), ",")
	if len(dbs) == 0 || dbs[0] == "" {
		t.Skip("set PROBE_DBS")
	}

	ctx := context.Background()
	v, err := openVault(ctx)
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	r := v.Retriever(wavevault.AllScope())
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		t.Fatalf("load vault: %v", err)
	}
	wanted := map[string]bool{}
	dossiers := 0
	for _, n := range nodes {
		if n.Collection != wavevault.CollTasks {
			continue
		}
		dossiers++
		for _, l := range n.Links {
			if strings.HasPrefix(l, "run-") {
				wanted[strings.TrimPrefix(l, "run-")] = true
			}
		}
	}
	t.Logf("vault: %d dossiers referencing %d distinct runs", dossiers, len(wanted))

	for _, db := range dbs {
		runs, reports, err := jarvisbackfill.ReadHistory(strings.TrimSpace(db))
		if err != nil {
			t.Errorf("%s: %v", db, err)
			continue
		}
		have := map[string]bool{}
		for _, run := range runs {
			have[run.OID] = true
		}
		resolved := 0
		for oid := range wanted {
			if have[oid] {
				resolved++
			}
		}
		t.Logf("%s\n  runs=%d radar=%d  dossier refs resolved: %d/%d", db, len(runs), len(reports), resolved, len(wanted))
	}
}

// diagnose ranks the query against probeDeepK chunks and reports where the target actually lands,
// plus how much of the kSem window the memory collection consumes. A target that ranks past kSem is a
// tuning finding; a target absent from probeDeepK entirely is a retrieval failure.
func diagnose(ctx context.Context, t *testing.T, v *wavevault.Vault, wantID, query string) string {
	ix, err := jarvisembed.OpenIndex(ctx)
	if err != nil || !ix.Available() {
		return "deep rank: index unavailable"
	}
	defer ix.Close()
	chunks, err := ix.Query(ctx, v, query, probeDeepK, wavevault.AllScope())
	if err != nil {
		return "deep rank: " + err.Error()
	}
	// rank by distinct node, which is what semanticSeeds dedupes down to
	var nodeRank int
	seen := map[string]bool{}
	targetRank, targetScore := -1, float32(0)
	windowColls := map[string]int{}
	for _, c := range chunks {
		if seen[c.NodeID] {
			continue
		}
		seen[c.NodeID] = true
		nodeRank++
		if nodeRank <= kSem {
			windowColls[c.Collection]++
		}
		if targetRank < 0 && strings.Contains(c.NodeID, wantID) {
			targetRank, targetScore = nodeRank, c.Score
		}
	}
	if targetRank < 0 {
		return fmt.Sprintf("deep rank: target NOT in top %d nodes; kSem=%d window is %v", nodeRank, kSem, windowColls)
	}
	return fmt.Sprintf("deep rank: target is node #%d of %d (cos %.4f), kSem=%d; kSem window is %v",
		targetRank, nodeRank, targetScore, kSem, windowColls)
}

// overlap reports >=4-char tokens the query shares with the target id — a non-empty result means the
// case is not a true paraphrase and any L2 hit is uninformative.
func overlap(query, wantID string) []string {
	_, kws := analyzeQuery(query)
	idToks := map[string]bool{}
	for _, tok := range strings.Split(wantID, "-") {
		if len(tok) >= 4 {
			idToks[tok] = true
		}
	}
	var out []string
	for _, kw := range kws {
		if idToks[kw] {
			out = append(out, kw)
		}
	}
	return out
}

func containsID(seeds []string, want string) bool {
	for _, s := range seeds {
		if strings.Contains(s, want) {
			return true
		}
	}
	return false
}

func added(off, on []string) []string {
	have := map[string]bool{}
	for _, s := range off {
		have[s] = true
	}
	var out []string
	for _, s := range on {
		if !have[s] {
			out = append(out, truncate(s, 60))
		}
	}
	sort.Strings(out)
	return out
}

func yesNo(b bool) string {
	if b {
		return "FOUND"
	}
	return "missing"
}
