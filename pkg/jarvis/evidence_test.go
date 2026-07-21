// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/gitinfo"
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

func TestVerificationDetailStripsANSI(t *testing.T) {
	// vitest/tsc emit colorized output when a TTY is attached; the detail must be plain text.
	// json.Marshal encodes the ESC bytes as a captured transcript stores them (escaped), so the
	// fixture stays valid JSON while carrying real escapes for StripANSI to remove.
	ansi, _ := json.Marshal("\x1b[1m\x1b[46m RUN \x1b[49m\x1b[22m \x1b[36mv3.2.4\x1b[39m checkout\nmore")
	lines := []string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"b1","input":{"command":"npx vitest run"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b1","is_error":false,"content":` + string(ansi) + `}]}}`,
	}
	v := verificationCommands(lines)
	if len(v) != 1 {
		t.Fatalf("got %d verifs, want 1", len(v))
	}
	if strings.ContainsRune(v[0].Detail, '\x1b') {
		t.Errorf("detail still carries ANSI escapes: %q", v[0].Detail)
	}
	if !strings.Contains(v[0].Detail, "RUN") || !strings.Contains(v[0].Detail, "v3.2.4") {
		t.Errorf("detail lost its content after stripping: %q", v[0].Detail)
	}
}

func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestSealEvidenceBaseAnchored(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "init")
	base, err := gitinfo.HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	// the run's work: modify + commit on top of the base
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-am", "work")

	run := &waveobj.Run{
		ID: "r1", Status: RunStatus_Done, ProjectPath: dir, BaseCommit: base, CreatedTs: 1000,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000}},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if run.Evidence == nil || len(run.Evidence.Files) == 0 {
		t.Fatalf("expected committed files in evidence, got %+v", run.Evidence)
	}
	if run.Evidence.AddTotal == 0 {
		t.Fatalf("expected AddTotal > 0, got %d", run.Evidence.AddTotal)
	}
}

func TestSealEvidenceGitFailureLeavesUnsealed(t *testing.T) {
	// a canceled context fails the git-changes computation; evidence must be left unsealed (nil) with an
	// error so the backfill can retry, not frozen into an empty (and immutable) file list.
	run := &waveobj.Run{
		ID: "r1", Status: RunStatus_Done, ProjectPath: t.TempDir(), CreatedTs: 1000,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := SealEvidence(ctx, run); err == nil {
		t.Fatal("expected an error when the git-changes computation is canceled")
	}
	if run.Evidence != nil {
		t.Fatal("evidence must be left unsealed on a git failure/timeout")
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
