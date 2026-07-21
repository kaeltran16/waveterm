// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// buildFixtureRepo creates a temp repo with: two production sources missing tests (a coupons
// subsystem with >=2 signals so a citing finding survives validation), an unpaired migration, and a
// planted secret in a tracked file.
func buildFixtureRepo(t *testing.T) string {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "src/coupons/validate.ts", "export const validate = () => true\n") // no test
	writeFile(t, dir, "src/coupons/apply.ts", "export const apply = () => true\n")       // no test
	writeFile(t, dir, "migrations/0007_ttl.up.sql", "alter table sessions add ttl int;\n")
	writeFile(t, dir, "config/app.yaml", "stripe_key: sk-ABCDEF0123456789ABCDEF0123456789\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "seed")
	return dir
}

// withFakeSynthFn overrides the model runner with an arbitrary fn for the test's duration.
func withFakeSynthFn(t *testing.T, fn streamFn) {
	prev := synthStreamFn
	synthStreamFn = fn
	t.Cleanup(func() { synthStreamFn = prev })
}

// clusterFirstMultiSignalGroup is a fake synth: it cites the first payload subsystem group that has
// >=2 signals (moderate evidence => survives validation), using that group's real signal IDs +
// files so validation passes. It records the payload it saw for the secret-leak assertion.
func clusterFirstMultiSignalGroup(seen *string) streamFn {
	return func(ctx context.Context, prompt string) ([]string, error) {
		*seen = prompt
		ids, files := firstMultiSignalGroup(prompt)
		inner := SynthResponse{Findings: []SynthFinding{{
			RiskKind: RiskTestCoverageGap, BoundaryLabel: "coupons", Risk: "coupons uncovered",
			Why: "branches unexercised", Severity: "high", SignalIDs: ids, Files: files, Mission: "add tests",
		}}}
		innerBytes, _ := json.Marshal(inner)
		return []string{
			`{"type":"system","subtype":"init","model":"claude-sonnet-x"}`,
			`{"type":"result","subtype":"success","result":` + jsonString(string(innerBytes)) + `,"usage":{"input_tokens":100,"output_tokens":20}}`,
		}, nil
	}
}

func TestAcceptanceFullScan(t *testing.T) {
	ctx := context.Background()
	dir := buildFixtureRepo(t)

	var seenPayload string
	withFakeSynthFn(t, clusterFirstMultiSignalGroup(&seenPayload))

	rpt, _ := wstore.CreateRadarReport(ctx, "pay", dir)
	runScan(ctx, rpt.OID)
	got, _ := wstore.GetRadarReport(ctx, rpt.OID)

	// (1) no repository writes: HEAD unchanged, tree clean
	if got.StartHead == "" || got.StartHead != got.EndHead {
		t.Fatalf("scan must not change HEAD (start=%q end=%q)", got.StartHead, got.EndHead)
	}
	if got.EndDirty != "" {
		t.Fatalf("scan must not dirty the working tree, got %q", got.EndDirty)
	}
	// (2) no planted secret reaches the payload
	if strings.Contains(seenPayload, "sk-ABCDEF0123456789") {
		t.Fatal("planted secret leaked into the model payload")
	}
	// (3) the pipeline produced a finding, and every evidence reference resolves to a retained signal
	if len(got.Findings) < 1 {
		t.Fatalf("expected at least one finding, got %d", len(got.Findings))
	}
	for _, f := range got.Findings {
		for _, id := range f.SignalIDs {
			if !hasSignal(got.Signals, id) {
				t.Fatalf("finding references signal %s not retained", id)
			}
		}
	}
	// (4) cap respected
	if len(got.Findings) > MaxFindings {
		t.Fatal("cap breached")
	}
	if got.Status != StatusCompleted && got.Status != StatusPartial {
		t.Fatalf("unexpected status %q (%s)", got.Status, got.FatalError)
	}
	// (5) resolved model recorded from the stream
	if got.ResolvedModel != "claude-sonnet-x" {
		t.Fatalf("resolved model not recorded: %q", got.ResolvedModel)
	}
	if got.ConfiguredModel != ConfiguredRadarModel {
		t.Fatalf("configured model not recorded: %q", got.ConfiguredModel)
	}
}

func TestAcceptanceSecondScanReclassifies(t *testing.T) {
	ctx := context.Background()
	dir := buildFixtureRepo(t)
	var seen string
	withFakeSynthFn(t, clusterFirstMultiSignalGroup(&seen))

	r1, _ := wstore.CreateRadarReport(ctx, "pay", dir)
	runScan(ctx, r1.OID)
	got1, _ := wstore.GetRadarReport(ctx, r1.OID)
	if len(got1.Findings) < 1 || got1.Findings[0].Group != GroupNew {
		t.Fatalf("first scan must produce a new finding, got %+v", got1.Findings)
	}

	// second scan over the unchanged fixture: the coupons fingerprint recurs.
	r2, _ := wstore.CreateRadarReport(ctx, "pay", dir)
	wstore.UpdateRadarReport(ctx, r2.OID, func(r *waveobj.RadarReport) { r.PrevReportId = r1.OID })
	runScan(ctx, r2.OID)
	got2, _ := wstore.GetRadarReport(ctx, r2.OID)
	if len(got2.Findings) < 1 || got2.Findings[0].Group != GroupRecurring {
		t.Fatalf("second scan must reclassify the finding as recurring, got %+v", got2.Findings)
	}
	if got2.Findings[0].Fingerprint != got1.Findings[0].Fingerprint {
		t.Fatalf("recurring finding must keep its fingerprint: %q vs %q", got1.Findings[0].Fingerprint, got2.Findings[0].Fingerprint)
	}
}

func TestAcceptanceSecurityLensRuns(t *testing.T) {
	ctx := context.Background()
	dir := buildFixtureRepo(t)
	var seen string
	withFakeSynthFn(t, clusterFirstMultiSignalGroup(&seen))

	rpt, _ := wstore.CreateRadarReport(ctx, "pay", dir)
	runScan(ctx, rpt.OID)
	got, _ := wstore.GetRadarReport(ctx, rpt.OID)

	// both lenses ran and completed (the fake returns a correctness kind, so the security lens completes
	// with zero admitted findings — but it ran, which is the point).
	modes := map[string]string{}
	for _, r := range got.ModeRuns {
		modes[r.Mode] = r.Status
	}
	if modes[ModeCorrectness] != ModeRunCompleted || modes[ModeSecurity] != ModeRunCompleted {
		t.Fatalf("expected both lenses completed, got %+v", got.ModeRuns)
	}
	// the correctness finding is intact and stamped correctness (empty back-compat default still holds).
	if len(got.Findings) < 1 || got.Findings[0].Mode != ModeCorrectness {
		t.Fatalf("correctness finding must survive unchanged, got %+v", got.Findings)
	}
	// the planted secret still never reaches the payload, through either lens.
	if strings.Contains(seen, "sk-ABCDEF0123456789") {
		t.Fatal("planted secret leaked into the model payload")
	}
}

// firstMultiSignalGroup returns the signal IDs and their files for the first subsystem group in the
// payload that has >=2 signals (strong enough that a citing finding survives validation).
func firstMultiSignalGroup(payload string) ([]string, []string) {
	type grp struct {
		ids   []string
		files []string
	}
	var groups []grp
	curIdx := -1
	for _, ln := range strings.Split(payload, "\n") {
		if strings.HasPrefix(ln, "## subsystem:") {
			groups = append(groups, grp{})
			curIdx = len(groups) - 1
			continue
		}
		if curIdx < 0 {
			continue
		}
		if id, files := parseSignalLine(ln); id != "" {
			groups[curIdx].ids = append(groups[curIdx].ids, id)
			groups[curIdx].files = append(groups[curIdx].files, files...)
		}
	}
	for _, g := range groups {
		if len(g.ids) >= 2 {
			return g.ids, dedupStrings(g.files)
		}
	}
	return nil, nil
}

// parseSignalLine extracts the id and files from a payload signal line:
//
//	- [collector] id=<id> files=<f1,f2> :: <summary>
func parseSignalLine(ln string) (string, []string) {
	i := strings.Index(ln, "id=")
	if i < 0 {
		return "", nil
	}
	rest := ln[i+3:]
	j := strings.IndexByte(rest, ' ')
	if j < 0 {
		return "", nil
	}
	id := rest[:j]
	var files []string
	if fi := strings.Index(ln, "files="); fi >= 0 {
		fr := ln[fi+6:]
		if k := strings.Index(fr, " ::"); k >= 0 {
			fr = fr[:k]
		}
		for _, f := range strings.Split(fr, ",") {
			if f = strings.TrimSpace(f); f != "" {
				files = append(files, f)
			}
		}
	}
	return id, files
}

func dedupStrings(xs []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func hasSignal(sigs []waveobj.RadarSignal, id string) bool {
	for _, s := range sigs {
		if s.ID == id {
			return true
		}
	}
	return false
}
