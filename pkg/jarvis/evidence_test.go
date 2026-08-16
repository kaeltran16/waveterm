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

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestClassifyVerif(t *testing.T) {
	cases := []struct {
		cmd       string
		isError   bool
		wantMatch bool
		wantRes   string
	}{
		// real invocations: runner token + action verb -> classify, pass/fail preserved
		{"pnpm test coupons", false, true, "pass"},
		{"pnpm typecheck", true, true, "fail"},
		{"npm run lint", false, true, "pass"},
		{"go test ./...", true, true, "fail"},
		{"npm test", false, true, "pass"},
		{"vitest run", false, true, "pass"},
		{"pytest -q", false, true, "pass"},
		{"npx tsc --noEmit", false, true, "pass"},
		{"pnpm build", false, true, "pass"},
		{"echo hi && pnpm test", false, true, "pass"}, // compound commands still classify
		// prose that merely mentions a test/build word must NOT classify
		{"ls -la", false, false, ""},
		{"git commit -m \"test: add auth\"", false, false, ""},
		{"echo build it", false, false, ""},
		{"git diff --stat", false, false, ""},
		{"git commit -m \"build: bump deps\"", true, false, ""},
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

func TestClassifyVerifUnknownOnEmptyResult(t *testing.T) {
	// ran but produced no captured output -> unknown, not pass (existing behavior preserved)
	_, res, ok := classifyVerif("npm test", "", false)
	if !ok || res != "unknown" {
		t.Errorf("empty result: ok=%v res=%q, want ok=true res=unknown", ok, res)
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

func TestVerificationCommandsRejectsProseCommands(t *testing.T) {
	// commands that merely mention a test/build word (commit messages, echoes) must not appear in the
	// snapshot at all — not even as "unknown" when they have no tool_result (the pending-map tail).
	lines := []string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"b1","input":{"command":"git commit -m \"test: add auth\""}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b1","is_error":false,"content":"[main abc1234] test: add auth"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"b2","input":{"command":"echo build it"}}]}}`,
	}
	v := verificationCommands(lines)
	if len(v) != 0 {
		t.Fatalf("got %d verifs, want 0 (prose commands must not be reported): %+v", len(v), v)
	}
}

func TestVerificationDetailStripsANSI(t *testing.T) {
	// vitest/tsc emit colorized output when a TTY is attached; the detail must be plain text.
	// json.Marshal encodes the ESC bytes as a captured transcript stores them (escaped), so the
	// fixture stays valid JSON while carrying real escapes for StripANSI to remove. The escapes sit on
	// the summary line because that is the line verifSummaryLine reports.
	ansi, _ := json.Marshal("\x1b[36m RUN \x1b[39m checkout\n\x1b[1m\x1b[32mTests  \x1b[36mv3.2.4\x1b[39m 12 passed\x1b[39m\x1b[22m")
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
	if !strings.Contains(v[0].Detail, "Tests") || !strings.Contains(v[0].Detail, "v3.2.4") {
		t.Errorf("detail lost its content after stripping: %q", v[0].Detail)
	}
}

func TestVerifSummaryLine(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"pytest band", "rootdir: C:\\p\nplugins: anyio\ntests/t.py ....\n\n===== 12 passed in 3.42s =====\n", "===== 12 passed in 3.42s ====="},
		{"pytest failures", "tests/t.py F..\n\n2 failed, 10 passed in 1.1s", "2 failed, 10 passed in 1.1s"},
		{"go test ok", "=== RUN   TestFoo\n--- PASS: TestFoo (0.00s)\nok  \tpkg/jarvis\t0.412s", "ok  \tpkg/jarvis\t0.412s"},
		{"go test fail below trailing noise", "--- FAIL: TestBar (0.01s)\nFAIL\tpkg/jarvis\t0.4s\nFAIL", "FAIL\tpkg/jarvis\t0.4s"},
		{"tsc error count", "src/a.ts(3,1): error TS2304: Cannot find name 'x'.\n\nFound 1 error in src/a.ts\n", "Found 1 error in src/a.ts"},
		{"no summary falls back to the last non-empty line", "building...\nwrote dist/app.js\n\n", "wrote dist/app.js"},
		{"empty stays empty", "\n  \n", ""},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if got := verifSummaryLine(tt.in); got != tt.want {
				t.Errorf("verifSummaryLine() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestVerificationDetailPrefersTheSummaryOverTheFirstLine(t *testing.T) {
	// workers commonly pipe verification through `| tail -N`, so the captured stdout already starts
	// mid-run: its first line is an arbitrary fragment while the result summary is on the last line.
	out, _ := json.Marshal("rootdir: C:\\Users\\me\\proj\nplugins: anyio-4.4.0\ntests/test_state.py ....\n\n===== 12 passed in 3.42s =====\n")
	lines := []string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"b1","input":{"command":"pytest tests/ | tail -20"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b1","is_error":false,"content":` + string(out) + `}]}}`,
	}
	v := verificationCommands(lines)
	if len(v) != 1 {
		t.Fatalf("got %d verifs, want 1", len(v))
	}
	if !strings.Contains(v[0].Detail, "12 passed") {
		t.Errorf("detail = %q, want the pytest result summary", v[0].Detail)
	}
}

// verifToolUseLine / verifResultLine / textLine build transcript JSONL records for one Bash
// verification call (the shapes verificationCommands scans).
func verifToolUseLine(id, command string) string {
	b, _ := json.Marshal(map[string]any{
		"type": "assistant",
		"message": map[string]any{"content": []any{
			map[string]any{"type": "tool_use", "name": "Bash", "id": id, "input": map[string]any{"command": command}},
		}},
	})
	return string(b)
}

func verifResultLine(id string, isError bool, out string) string {
	b, _ := json.Marshal(map[string]any{
		"type": "user",
		"message": map[string]any{"content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": id, "is_error": isError, "content": out},
		}},
	})
	return string(b)
}

func textLine(text string) string {
	b, _ := json.Marshal(map[string]any{
		"type": "assistant",
		"message": map[string]any{"content": []any{
			map[string]any{"type": "text", "text": text},
		}},
	})
	return string(b)
}

// seedWorkerTranscript creates a worker tab+block (cwd = projDir) and a transcript JSONL for it in
// the real Claude projects dir. The projects-dir entry is the slug of the unique projDir, so no user
// project dir is touched; the created entry is removed on cleanup. Returns the tab oref.
func seedWorkerTranscript(t *testing.T, projDir string, lines []string) string {
	t.Helper()
	ctx := context.Background()
	tabOID := uuid.NewString()
	blockOID := uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabOID, Name: "worker", BlockIds: []string{blockOID}, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockOID, Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: projDir}}); err != nil {
		t.Fatalf("seed worker block: %v", err)
	}
	projRoot := filepath.Join(wavebase.GetHomeDir(), ".claude", "projects", agentobserve.SlugifyCwd(projDir))
	if err := os.MkdirAll(projRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(projRoot) })
	var b strings.Builder
	cwdJSON, _ := json.Marshal(projDir)
	b.WriteString(`{"type":"user","cwd":` + string(cwdJSON) + "}\n") // discovery re-validates the slug via the in-record cwd
	for _, line := range lines {
		b.WriteString(line)
		b.WriteString("\n")
	}
	if err := os.WriteFile(filepath.Join(projRoot, "transcript.jsonl"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return waveobj.MakeORef(waveobj.OType_Tab, tabOID).String()
}

// TestSealEvidenceAggregatesVerifsAcrossWorkers proves the sealed snapshot carries the verification
// commands of EVERY non-skipped phase worker, not just the last phase's first worker: phase 1's and
// phase 2's workers each ran a distinct verification, and a skipped phase 3's worker must not leak
// in. First-appearance order is phase order; the summary stays the last worker's.
func TestSealEvidenceAggregatesVerifsAcrossWorkers(t *testing.T) {
	proj := t.TempDir()
	phase1Worker := seedWorkerTranscript(t, t.TempDir(), []string{
		verifToolUseLine("b1", "pnpm typecheck"),
		verifResultLine("b1", false, "0 errors"),
		textLine("phase one summary"),
	})
	phase2Worker := seedWorkerTranscript(t, t.TempDir(), []string{
		verifToolUseLine("b2", "go test ./..."),
		verifResultLine("b2", false, "ok\tpkg/jarvis\t0.4s"),
		textLine("phase two summary"),
	})
	skippedWorker := seedWorkerTranscript(t, t.TempDir(), []string{
		verifToolUseLine("b3", "pnpm lint"),
		verifResultLine("b3", false, "no problems"),
	})

	run := &waveobj.Run{
		ID: "r1", Status: RunStatus_Done, ProjectPath: proj, CreatedTs: 1000,
		Phases: []waveobj.RunPhase{
			{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 3000, WorkerOrefs: []string{phase1Worker}},
			{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000, WorkerOrefs: []string{phase2Worker}},
			{Kind: PhaseKind_Execute, State: PhaseState_Skipped, DoneTs: 6000, WorkerOrefs: []string{skippedWorker}},
		},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if run.Evidence == nil {
		t.Fatal("evidence not sealed")
	}
	if len(run.Evidence.Verifs) != 2 {
		t.Fatalf("got %d verifs, want 2 (both non-skipped workers, skipped phase excluded): %+v", len(run.Evidence.Verifs), run.Evidence.Verifs)
	}
	if run.Evidence.Verifs[0].Cmd != "pnpm typecheck" || run.Evidence.Verifs[0].Result != "pass" {
		t.Errorf("verif[0] = %+v, want pnpm typecheck/pass (first-appearance order)", run.Evidence.Verifs[0])
	}
	if run.Evidence.Verifs[1].Cmd != "go test ./..." || run.Evidence.Verifs[1].Result != "pass" {
		t.Errorf("verif[1] = %+v, want go test ./.../pass", run.Evidence.Verifs[1])
	}
	if run.Evidence.Summary != "phase two summary" {
		t.Errorf("Summary = %q, want the last worker's text only", run.Evidence.Summary)
	}
}

// TestSealEvidenceVerifDedupeAcrossWorkers guards the cross-transcript dedupe: the same command run
// by two workers collapses to one entry, keeping its first-appearance position, and the last result
// wins (the per-transcript semantic extended across transcripts).
func TestSealEvidenceVerifDedupeAcrossWorkers(t *testing.T) {
	w1 := seedWorkerTranscript(t, t.TempDir(), []string{
		verifToolUseLine("b1", "pnpm test"),
		verifResultLine("b1", true, "1 failing"),
	})
	w2 := seedWorkerTranscript(t, t.TempDir(), []string{
		verifToolUseLine("b2", "pnpm test"),
		verifResultLine("b2", false, "12 passed"),
	})
	run := &waveobj.Run{
		ID: "r1", Status: RunStatus_Done, ProjectPath: t.TempDir(), CreatedTs: 1000,
		Phases: []waveobj.RunPhase{
			{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 3000, WorkerOrefs: []string{w1}},
			{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000, WorkerOrefs: []string{w2}},
		},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	v := run.Evidence.Verifs
	if len(v) != 1 {
		t.Fatalf("got %d verifs, want 1 (deduped across workers): %+v", len(v), v)
	}
	if v[0].Cmd != "pnpm test" || v[0].Result != "pass" {
		t.Errorf("verif = %+v, want pnpm test/pass (last result wins across workers)", v[0])
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

// TestSealEvidenceScopesToEndCommit is the fan-out over-attribution guard: with EndCommit set, evidence
// must reflect only the run's own commit (mine.txt), never a sibling that merged into the shared tree
// afterward (sibling.txt) — which a working-tree-vs-baseline diff (today's behavior) would wrongly list.
func TestSealEvidenceScopesToEndCommit(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	base, err := gitinfo.HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	// this run's own commit
	if err := os.WriteFile(filepath.Join(dir, "mine.txt"), []byte("x\ny\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "mine")
	mine, err := gitinfo.HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	// a sibling's work merged onto the shared tree AFTER this run's commit (would leak into a base diff)
	if err := os.WriteFile(filepath.Join(dir, "sibling.txt"), []byte("s\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "sibling")

	run := &waveobj.Run{
		ID: "r1", Status: RunStatus_Done, ProjectPath: dir, BaseCommit: base, EndCommit: mine, CreatedTs: 1000,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000}},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if run.Evidence == nil {
		t.Fatal("expected sealed evidence")
	}
	paths := map[string]bool{}
	for _, f := range run.Evidence.Files {
		paths[f.Path] = true
	}
	if !paths["mine.txt"] {
		t.Errorf("expected mine.txt, got files %+v", run.Evidence.Files)
	}
	if paths["sibling.txt"] {
		t.Errorf("sibling.txt (merged after EndCommit) leaked into evidence: %+v", run.Evidence.Files)
	}
}

// TestSealEvidenceFallsBackWithoutEndCommit guards the common single-run case: no reported commit falls
// back to the working-tree-vs-baseline diff, so uncommitted work the worker left is still captured.
func TestSealEvidenceFallsBackWithoutEndCommit(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	base, err := gitinfo.HeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	// uncommitted working-tree change (EndCommit stays empty)
	if err := os.WriteFile(filepath.Join(dir, "wt.txt"), []byte("w\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	run := &waveobj.Run{
		ID: "r2", Status: RunStatus_Done, ProjectPath: dir, BaseCommit: base, CreatedTs: 1000, // EndCommit empty
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000}},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range run.Evidence.Files {
		if f.Path == "wt.txt" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected working-tree file wt.txt in fallback, got %+v", run.Evidence.Files)
	}
}
