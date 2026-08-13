// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build liveprobe

// Live probe for the semantic lane. Originally J2's two verify legs; now also J5's fitting harness
// for kSemPerCollection and semSeedFloor. Not part of the normal suite: it needs a real vault, a
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
	"math"
	"os"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisbackfill"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// probeCase is one paraphrase: a query that shares no >=4-char token with the target it should find.
// wantID is matched as a substring of the vault node id. A negative case has no target at all — the
// corpus genuinely cannot answer it, and the score floor must admit nothing.
type probeCase struct {
	name     string
	query    string
	wantID   string
	negative bool
}

// probeDeepK is the diagnostic depth: how far down the ranking to look for a target the window
// missed, to separate "ranked too deep" from "not retrieved at all".
const probeDeepK = 60

// Positives span all three collections, because the collection ratio is the thing under test and a
// probe drawn only from tasks/ cannot see it. Negatives are what make the floor fittable: without a
// case whose right answer is "nothing", any floor at or below the weakest positive scores 100%.
//
// "notes" is deliberately avoided in every query: each dossier body carries a literal "## Notes"
// heading, so that one token L2-matches all 14 dossiers and makes the case uninformative.
var probeCases = []probeCase{
	{name: "dossier/crash", query: "why did the program blow up right after opening the saved reminders pane", wantID: "the-app-crash-when-i-navigate-to-memory-tab"},
	{name: "dossier/pill", query: "make the badge hue different for those two assistants", wantID: "change-the-claude-code-and-codex-pill-color"},
	{name: "dossier/shim", query: "find leftover dead shim methods still referenced in the react layer", wantID: "grep-the-frontend-for-remaining-getapi-closetab"},
	{name: "dossier/naming", query: "the heading relabels itself incorrectly once a job finishes", wantID: "the-auto-tab-name-change-doesnt-work"},
	{name: "dossier/usage", query: "consumption figures are lifetime totals instead of the current period", wantID: "the-usage-tab-still-show-the-all-time-stat"},

	{name: "decision/validation", query: "was the trust perimeter for user-supplied payloads altered", wantID: "the-input-validation-security-boundary-was-modif"},
	{name: "decision/evidence", query: "which helpers collect underlying proof from a codebase", wantID: "the-functions-that-gather-raw-evidence-for-repo"},

	{name: "memory/popgap", query: "a removed list item leaves an empty space instead of the others sliding up", wantID: "poplayout-needs-motion-direct-child"},
	{name: "memory/theme", query: "can we add a bright daytime colour scheme", wantID: "cockpit-light-mode-wontfix"},
	{name: "memory/styling", query: "should new styling use nested preprocessor files or utility classes", wantID: "avoid-scss-prefer-tailwind"},

	// Axis 1 ask-routing coverage: status/history-shaped questions still resolve to corpus nodes,
	// and the extras here are the off-topic controls the batch judge must remove. wantIDs are the
	// corpus nodes the queries genuinely surface on the current profile (obsidian_vault); the
	// discovery run of TestLiveJudgeProbe's candidate log is the ground truth for them.
	{name: "status/blocked", query: "which task is sitting waiting for a review decision right now", wantID: "check-completion-summary-in-channel-run-why-does"},
	{name: "history/shipped", query: "when did we stop using the old http helper library", wantID: "project-mp-axios-removal-fetch-semantics"},
	{name: "bringup/decision", query: "did the async data loading change to use built-in primitives", wantID: "migrated-promises-are-native-from-react-query-mu"},
	{name: "negative/airline", query: "how do we rebook a missed connection on the airline partner api", negative: true},
	{name: "negative/finance", query: "what is the fx rate hedging policy for quarterly earnings", negative: true},

	{name: "negative/k8s", query: "how do we rotate the kubernetes cluster certificates before they expire", negative: true},
	{name: "negative/postgres", query: "what is the postgres connection pool size for the billing service", negative: true},
	{name: "negative/invoicing", query: "how do we reconcile currency rounding in the monthly invoice run", negative: true},
	{name: "negative/payroll", query: "how is payroll tax withholding calculated for overseas contractors", negative: true},
}

// Rejected control, kept as a warning: "who owns the mobile push notification delivery pipeline"
// scored 0.3467 against `Wave agent-manager direction` and pulled in `project-managementpanel-mobile`.
// It is not a negative — memory:vaultpath federates an Obsidian work vault holding SIEM and
// project-management notes, so the corpus is much broader than this repo. Check a candidate
// negative's topic against the *federated* corpus, not against the repo you are sitting in.

// rankReport locates a query's target under both ranking regimes. collRank is what the
// per-collection window sees; globalRank is what one global window saw. The gap between them is the
// crowding this slice exists to remove.
type rankReport struct {
	found      bool
	collection string
	score      float32
	collRank   int
	globalRank int
	bestScore  float32        // top score anywhere for this query — the figure a negative control contributes
	bestNode   string         // which node scored bestScore
	windowMix  map[string]int // collection mix of a global window kSemPerCollection nodes deep
	collScores []float32      // distinct-node scores under the per-collection regime — what the floor filters
}

// floorSweep is the evidence behind the fitted floor: for each candidate value, how many positive
// targets survive and how much off-topic noise the negatives still admit.
var floorSweep = []float32{0.20, 0.25, 0.28, 0.30, 0.32, 0.325, 0.33, 0.34, 0.35, 0.40}

func deepRank(ctx context.Context, ix *jarvisembed.Index, v *wavevault.Vault, query, wantID string) (rankReport, error) {
	var rk rankReport
	rk.windowMix = map[string]int{}

	perColl, err := ix.QueryPerCollection(ctx, v, query, probeDeepK, wavevault.AllScope())
	if err != nil {
		return rk, err
	}
	seenIn := map[string]map[string]bool{}
	rankIn := map[string]int{}
	for _, c := range perColl {
		if seenIn[c.Collection] == nil {
			seenIn[c.Collection] = map[string]bool{}
		}
		if seenIn[c.Collection][c.NodeID] {
			continue
		}
		seenIn[c.Collection][c.NodeID] = true
		rankIn[c.Collection]++
		// only the first kSemPerCollection of each collection can reach production's window
		if rankIn[c.Collection] <= kSemPerCollection {
			rk.collScores = append(rk.collScores, c.Score)
		}
		if wantID != "" && !rk.found && strings.Contains(c.NodeID, wantID) {
			rk.found, rk.collection, rk.score, rk.collRank = true, c.Collection, c.Score, rankIn[c.Collection]
		}
	}

	global, err := ix.Query(ctx, v, query, probeDeepK, wavevault.AllScope())
	if err != nil {
		return rk, err
	}
	seen := map[string]bool{}
	n := 0
	for _, c := range global {
		if seen[c.NodeID] {
			continue
		}
		seen[c.NodeID] = true
		n++
		if n == 1 {
			rk.bestScore, rk.bestNode = c.Score, c.NodeID
		}
		if n <= kSemPerCollection {
			rk.windowMix[c.Collection]++
		}
		if wantID != "" && rk.globalRank == 0 && strings.Contains(c.NodeID, wantID) {
			rk.globalRank = n
		}
	}
	return rk, nil
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

	// Re-point wstore at the copied profile. TestMain initialised it against a throwaway temp dir, so
	// without this every [[run-]] reference resolves to an "unavailable" candidate with ts=0, which
	// sorts last and therefore never competes for a maxCandidates slot — making the end-to-end leg
	// below optimistic rather than real.
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("re-init wstore against the profile copy: %v", err)
	}

	ix, err := jarvisembed.OpenIndex(ctx)
	if err != nil || !ix.Available() {
		t.Fatalf("index unavailable (err=%v) — this probe measures the real semantic lane", err)
	}
	defer ix.Close()

	// The off-set is what recall sees with embeddings disabled: OpenIndex returns an unavailable
	// handle (index.go), so semanticSeeds yields nil and only L1+L2 contribute.
	offIndex := func(context.Context) (*jarvisembed.Index, error) {
		return jarvisembed.OpenIndexAtForTest(ctx, "", nil)
	}

	var positives, negatives int
	var seedHits, endToEndHits, offHits, negLeaks int
	minPositiveScore := float32(math.MaxFloat32)
	maxNegativeScore := float32(0)
	maxCollRank := 0
	var weakestPositive, loudestNegative string
	var positiveTargets []float32 // each positive's target score
	var negativeAdmits [][]float32

	for _, tc := range probeCases {
		if ov := overlap(tc.query, tc.wantID); len(ov) > 0 {
			t.Errorf("%s: query shares tokens %v with its target — not a paraphrase, result is uninformative", tc.name, ov)
			continue
		}
		rk, err := deepRank(ctx, ix, v, tc.query, tc.wantID)
		if err != nil {
			t.Errorf("%s: deepRank: %v", tc.name, err)
			continue
		}
		seedsOn, err := selectSeeds(ctx, v, r, tc.query)
		if err != nil {
			t.Errorf("%s: seeds(on): %v", tc.name, err)
			continue
		}

		restore := SetOpenIndexForTest(offIndex)
		seedsOff, errOff := selectSeeds(ctx, v, r, tc.query)
		SetOpenIndexForTest(restore)
		if errOff != nil {
			t.Errorf("%s: seeds(off): %v", tc.name, errOff)
			continue
		}

		if tc.negative {
			negatives++
			negativeAdmits = append(negativeAdmits, rk.collScores)
			if rk.bestScore > maxNegativeScore {
				maxNegativeScore, loudestNegative = rk.bestScore, tc.name+" -> "+rk.bestNode
			}
			// Only the L3 delta is this slice's business. L1/L2 keyword search leaks its own noise on
			// an off-topic query — common tokens like "cluster" or "before" match plenty — and folding
			// that into the count would credit the floor with junk it never saw.
			bySemantic := addedByL3(seedsOff, seedsOn)
			if len(bySemantic) > 0 {
				negLeaks++
			}
			t.Logf("\n%s [negative]\n  query        %q\n  best anywhere %.4f (%s)\n  L1+L2 alone  %d seeds\n  added by L3  %d %v",
				tc.name, tc.query, rk.bestScore, rk.bestNode, len(seedsOff), len(bySemantic), trimIDs(bySemantic))
			continue
		}

		positives++
		if containsID(seedsOff, tc.wantID) {
			offHits++
		}
		if containsID(seedsOn, tc.wantID) {
			seedHits++
		}

		// The leg that decides whether fixing the window changed anything a user can see: seeds are
		// expanded, recency-sorted and truncated at maxCandidates before the model ever sees them.
		cands, err := retrieve(ctx, ScopeArgs{Mode: "all"}, tc.query)
		if err != nil {
			t.Errorf("%s: retrieve: %v", tc.name, err)
			continue
		}
		inFinal := containsNav(cands, tc.wantID)
		if inFinal {
			endToEndHits++
		}

		if rk.found {
			positiveTargets = append(positiveTargets, rk.score)
			if rk.score < minPositiveScore {
				minPositiveScore, weakestPositive = rk.score, tc.name
			}
			if rk.collRank > maxCollRank {
				maxCollRank = rk.collRank
			}
		}
		t.Logf("\n%s\n  query        %q\n  target       %s (%s) cos %.4f\n  rank         #%d within its collection, #%d in one global window\n  global window mix %v\n  seeds        L1+L2 %s / L1+L2+L3 %s\n  end-to-end   %s (%d candidates)",
			tc.name, tc.query, tc.wantID, rk.collection, rk.score,
			rk.collRank, rk.globalRank, rk.windowMix,
			yesNo(containsID(seedsOff, tc.wantID)), yesNo(containsID(seedsOn, tc.wantID)),
			yesNo(inFinal), len(cands))
		if !rk.found {
			t.Logf("  NOT RETRIEVED at depth %d — a coverage bug, not a tuning one", probeDeepK)
		}
	}

	t.Logf("\n=== RESULT ===")
	t.Logf("positives: %d/%d reach the seed set (%d/%d with embeddings off), %d/%d survive to the final candidate list",
		seedHits, positives, offHits, positives, endToEndHits, positives)
	t.Logf("negatives: %d/%d admitted at least one SEMANTIC seed at semSeedFloor=%v (L1/L2 keyword noise excluded)", negLeaks, negatives, semSeedFloor)
	t.Logf("\n=== FITTING ===")
	t.Logf("weakest positive target: %.4f (%s)", minPositiveScore, weakestPositive)
	t.Logf("loudest negative:        %.4f (%s)", maxNegativeScore, loudestNegative)
	if maxNegativeScore < minPositiveScore {
		t.Logf("=> semSeedFloor is fittable in (%.4f, %.4f]; currently %v", maxNegativeScore, minPositiveScore, semSeedFloor)
	} else {
		t.Logf("=> NO SEPARATING VALUE: negatives reach %.4f but the weakest positive is only %.4f. "+
			"A score floor alone cannot separate these; report the overlap rather than picking a midpoint.",
			maxNegativeScore, minPositiveScore)
	}
	t.Logf("=> kSemPerCollection must be >= %d to admit every positive; currently %d", maxCollRank, kSemPerCollection)

	t.Logf("\n=== FLOOR SWEEP ===")
	t.Logf("%-8s %-18s %s", "floor", "positives kept", "off-topic seeds admitted across negatives")
	for _, f := range floorSweep {
		kept := 0
		for _, s := range positiveTargets {
			if s >= f {
				kept++
			}
		}
		noise, loud := 0, 0
		for _, scores := range negativeAdmits {
			n := 0
			for _, s := range scores {
				if s >= f {
					n++
				}
			}
			noise += n
			if n > 0 {
				loud++
			}
		}
		t.Logf("%-8.3f %-18s %d seeds across %d/%d negatives", f,
			fmt.Sprintf("%d/%d", kept, len(positiveTargets)), noise, loud, negatives)
	}
}

// TestLiveJudgeProbe measures the batch judge's effect on the real profile: for each probe case it
// retrieves, runs the judge, and reports kept vs removed. It asserts only the sanity bounds (kept
// <= candidates, and off-topic controls lose at least as many as they keep) — the numbers are the
// measurement, not the gate; the gate is that a human reads them against the next fitting pass.
func TestLiveJudgeProbe(t *testing.T) {
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("bootstrap: %v (set WAVETERM_CONFIG_HOME and WAVETERM_DATA_HOME)", err)
	}
	wconfig.GetWatcher().Start()
	ctx := context.Background()
	scope := ScopeArgs{Mode: "all"}
	for _, pc := range probeCases {
		cands, err := retrieve(ctx, scope, pc.query)
		if err != nil {
			t.Fatalf("retrieve(%q): %v", pc.query, err)
		}
		before := len(cands)
		var top []string
		for i, c := range cands {
			if i >= 5 {
				break
			}
			top = append(top, c.navTarget)
		}
		kept := judgeCandidates(ctx, scopeCwd(scope), pc.query, cands)
		if len(kept) > before {
			t.Fatalf("judge grew the shortlist for %q: %d -> %d", pc.query, before, len(kept))
		}
		t.Logf("judge %-24s %d -> %d kept (removed %d)  top5=%v", pc.name, before, len(kept), before-len(kept), top)
		if pc.negative && before-len(kept) < len(kept) {
			t.Logf("note: negative case %q kept %d/%d — review against the federated corpus", pc.name, len(kept), before)
		}
	}
}

func containsNav(cands []candidate, wantID string) bool {
	for _, c := range cands {
		if strings.Contains(c.navTarget, wantID) {
			return true
		}
	}
	return false
}

// addedByL3 is the seed set the semantic layer contributed on top of L1+L2.
func addedByL3(off, on []string) []string {
	have := make(map[string]bool, len(off))
	for _, s := range off {
		have[s] = true
	}
	var out []string
	for _, s := range on {
		if !have[s] {
			out = append(out, s)
		}
	}
	return out
}

func trimIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, truncate(id, 40))
	}
	return out
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

func yesNo(b bool) string {
	if b {
		return "FOUND"
	}
	return "missing"
}
