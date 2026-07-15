// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestClassifyVerif(t *testing.T) {
	cases := []struct {
		cmd       string
		isError   bool
		wantMatch bool
		wantRes   string
	}{
		{"pnpm test coupons", false, true, "pass"},
		{"pnpm typecheck", true, true, "fail"},
		{"npm run lint", false, true, "pass"},
		{"go test ./...", true, true, "fail"},
		{"ls -la", false, false, ""}, // not a verification command
		{"echo hi && pnpm test", false, true, "pass"},
	}
	for _, c := range cases {
		_, res, ok := classifyVerif(c.cmd, "x", c.isError)
		if ok != c.wantMatch {
			t.Errorf("classifyVerif(%q) match=%v, want %v", c.cmd, ok, c.wantMatch)
		}
		if ok && res != c.wantRes {
			t.Errorf("classifyVerif(%q) result=%q, want %q", c.cmd, res, c.wantRes)
		}
	}
}

func TestParseNumstatStatus(t *testing.T) {
	numstat := "96\t0\tcomponents/CouponInput.tsx\n41\t12\tlib/cart/totals.ts\n"
	statusZ := "A  components/CouponInput.tsx\x00 M lib/cart/totals.ts\x00"
	files := parseNumstatStatus(numstat, statusZ)
	if len(files) != 2 {
		t.Fatalf("got %d files, want 2", len(files))
	}
	if files[0].Stat != "A" || files[0].Add != 96 || files[0].Del != 0 {
		t.Errorf("file0 = %+v", files[0])
	}
	if files[1].Stat != "M" || files[1].Add != 41 || files[1].Del != 12 {
		t.Errorf("file1 = %+v", files[1])
	}
}

func TestArtifactKind(t *testing.T) {
	for path, want := range map[string]string{
		"docs/coupon-design.md":    "doc",
		"coverage/coupons.html":    "report",
		"screenshots/checkout.png": "image",
		"build/out.bin":            "file",
	} {
		if got := artifactKind(path); got != want {
			t.Errorf("artifactKind(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestFinalAssistantText(t *testing.T) {
	lines := []string{
		`{"type":"user","message":{"content":"go"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"t1"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"all done, shipped it"}]}}`,
	}
	if got := finalAssistantText(lines); got != "all done, shipped it" {
		t.Errorf("finalAssistantText = %q", got)
	}
}

func TestVerificationCommandsDedupesAndClassifies(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"b1","input":{"command":"pnpm typecheck"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b1","is_error":false,"content":"0 errors"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"b2","input":{"command":"pnpm test"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b2","is_error":true,"content":"1 failing"}]}}`,
	}
	v := verificationCommands(lines)
	if len(v) != 2 {
		t.Fatalf("got %d verifs, want 2", len(v))
	}
	if v[0].Result != "pass" || v[1].Result != "fail" {
		t.Errorf("results = %q,%q", v[0].Result, v[1].Result)
	}
}

func TestEvidenceHashStable(t *testing.T) {
	ev := waveobj.RunEvidence{Summary: "x", AddTotal: 3}
	if evidenceHash(ev) != evidenceHash(ev) {
		t.Error("hash not stable for identical input")
	}
}

func TestSealEvidenceIdempotent(t *testing.T) {
	run := &waveobj.Run{
		ID: "r1", Status: RunStatus_Done, ProjectPath: t.TempDir(), CreatedTs: 1000,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000}},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if run.Evidence == nil {
		t.Fatal("evidence not sealed")
	}
	if run.CompletedTs != 5000 {
		t.Fatalf("CompletedTs = %d, want 5000 (last phase DoneTs)", run.CompletedTs)
	}
	first := run.Evidence
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if run.Evidence != first {
		t.Error("second seal recomputed evidence; must be immutable no-op")
	}
}
