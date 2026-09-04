// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestDagEscalateData(t *testing.T) {
	cmd := &cobra.Command{}
	cmd.Flags().String("channel", "", "")
	cmd.Flags().String("runid", "", "")
	cmd.Flags().String("tier", "", "")
	cmd.Flags().String("model", "", "")
	cmd.Flags().String("runtime", "", "")
	if err := cmd.Flags().Set("channel", "ch"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("runid", "run"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("tier", "capable"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("model", "opencode/claude-opus-4-8"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("runtime", "claude"); err != nil {
		t.Fatal(err)
	}
	got, err := dagEscalateData(cmd, []string{"t-1"})
	if err != nil {
		t.Fatal(err)
	}
	want := wshrpc.CommandDagActionData{
		ChannelId: "ch",
		RunId:     "run",
		TaskId:    "t-1",
		Action:    "escalate",
		Tier:      "capable",
		Model:     "opencode/claude-opus-4-8",
		Runtime:   "claude",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dagEscalateData = %+v, want %+v", got, want)
	}
	if dagEscalateCmd.PreRunE == nil {
		t.Fatal("escalate command must initialize the RPC client")
	}
}

func TestDagInitScaffoldsParseableStore(t *testing.T) {
	dir := t.TempDir()
	rootCmd.SetArgs([]string{"jarvis", "dag", "init", "--dir", dir})
	if err := rootCmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".pi", "tasks", "tasks.json")); err != nil {
		t.Fatalf("store file not written: %v", err)
	}
	tasks, err := pitasks.Read(dir)
	if err != nil {
		t.Fatalf("scaffolded store must parse: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("want 1 sample task, got %d", len(tasks))
	}
	if tasks[0].Status != "pending" || tasks[0].Subject == "" {
		t.Fatalf("sample task malformed: %+v", tasks[0])
	}
	// a second init must refuse to clobber an existing store
	rootCmd.SetArgs([]string{"jarvis", "dag", "init", "--dir", dir})
	if err := rootCmd.Execute(); err == nil {
		t.Fatal("second init must fail (store exists)")
	}
}

func TestDagStatusLinesUsesDigest(t *testing.T) {
	g := &waveobj.TaskGroup{
		ID: "dag-1", Status: "running", Failures: 2, Parallelism: 3,
		Tasks: []waveobj.TaskNode{
			{ID: "t-0", Label: "a", State: "running", LastActivity: 9000},
			{ID: "t-1", Label: "b", State: "stalled", LastActivity: 1000},
		},
	}
	rtn := &wshrpc.CommandDagStatusRtnData{
		Group: g,
		Digest: wshrpc.DagStatusDigest{
			DagVersion: 4,
			Counts:     wshrpc.DagStatusCounts{Total: 2, Done: 0},
			Tasks: []wshrpc.DagTaskDigest{
				{TaskId: "t-0", FreshnessTs: 9000, HumanActions: nil},
				{TaskId: "t-1", FreshnessTs: 1000, HumanActions: []string{"retry", "skip"}},
			},
		},
	}
	lines := dagStatusLines(rtn, 10_000)
	joined := strings.Join(lines, "\n")
	// header counts come from the digest
	if !strings.Contains(joined, "tasks=0/2  failures=2") {
		t.Fatalf("header must use digest counts, got:\n%s", joined)
	}
	// per-task actions come from the digest, never locally reconstructed
	if !strings.Contains(joined, "retry,skip") {
		t.Fatalf("stalled task must show digest actions, got:\n%s", joined)
	}
	if !strings.Contains(joined, "idle ") {
		t.Fatalf("running task must show idle signal, got:\n%s", joined)
	}
	// a needs-you digest surfaces the ask action for the asked task
	g.Tasks = append(g.Tasks, waveobj.TaskNode{ID: "t-2", Label: "c", State: "running"})
	rtn.Digest.Tasks = append(rtn.Digest.Tasks, wshrpc.DagTaskDigest{
		TaskId: "t-2", HumanActions: []string{"answer"}, AskSummary: "which approach?", AskTs: 500,
	})
	lines = dagStatusLines(rtn, 10_000)
	joined = strings.Join(lines, "\n")
	if !strings.Contains(joined, "answer") || !strings.Contains(joined, "ask: which approach?") {
		t.Fatalf("needs-you task must show the digest ask action, got:\n%s", joined)
	}
}

func TestCompactDur(t *testing.T) {
	cases := []struct {
		ms   int64
		want string
	}{
		{0, ""},
		{-5, ""},
		{45_000, "45s"},
		{2*60_000 + 3_000, "2m3s"},
		{2 * 60_000, "2m"},
		{60*60_000 + 2*60_000, "1h2m"},
		{60 * 60_000, "1h"},
		{25*24*3600_000 + 2*3600_000, "25d2h"},
	}
	for _, c := range cases {
		if got := compactDur(c.ms); got != c.want {
			t.Errorf("compactDur(%d) = %q, want %q", c.ms, got, c.want)
		}
	}
}

func TestCompactText(t *testing.T) {
	if got := compactText("short", 10); got != "short" {
		t.Errorf("short string must pass through, got %q", got)
	}
	got := compactText("questions about the merge strategy for chunk C", 12)
	r := []rune(got)
	if len(r) != 12 || r[len(r)-1] != '…' {
		t.Errorf("must truncate to 12 runes with trailing ellipsis, got %q", got)
	}
}

func TestDagMergeExposesContinueFlag(t *testing.T) {
	f := dagMergeCmd.Flags().Lookup("continue")
	if f == nil {
		t.Fatal("dag merge must expose --continue for finishing a blocked squash merge")
	}
}

func TestDagSubmitSource(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dag.json")
	if err := os.WriteFile(path, []byte(`{"title":"from file"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := dagSubmitSource(nil, path, strings.NewReader(""))
	if err != nil || string(got) != `{"title":"from file"}` {
		t.Fatalf("--file = %q, %v", got, err)
	}

	got, err = dagSubmitSource([]string{`{"title":"inline"}`}, "", strings.NewReader(""))
	if err != nil || string(got) != `{"title":"inline"}` {
		t.Fatalf("inline = %q, %v", got, err)
	}

	got, err = dagSubmitSource(nil, "-", strings.NewReader(`{"title":"stdin"}`))
	if err != nil || string(got) != `{"title":"stdin"}` {
		t.Fatalf("stdin = %q, %v", got, err)
	}

	// two sources is a mistake to surface, not a precedence rule to guess at
	if _, err := dagSubmitSource([]string{`{}`}, path, strings.NewReader("")); err == nil {
		t.Fatal("inline + --file must be rejected")
	}
	if _, err := dagSubmitSource(nil, "", strings.NewReader("")); err == nil {
		t.Fatal("no source must be rejected")
	}
	if _, err := dagSubmitSource(nil, filepath.Join(dir, "missing.json"), strings.NewReader("")); err == nil {
		t.Fatal("missing file must be rejected")
	}
}

func TestWaitDecision(t *testing.T) {
	cases := []struct {
		name       string
		digest     wshrpc.DagStatusDigest
		wantReturn bool
		wantReason string
	}{
		{
			name:       "quiet dag keeps blocking",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "parallelism-wait", BlockingTaskIds: []string{"t-2"}}},
			wantReturn: false,
		},
		{
			name:       "dependency wait keeps blocking",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "dependency-wait"}},
			wantReturn: false,
		},
		{
			name:       "cleanup wait keeps blocking",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "cleanup-wait", TaskIds: []string{"t-1"}}},
			wantReturn: false,
		},
		{
			name:       "merge gate needs the lead",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "merge-ready", Actions: []string{"resolve-merge"}}},
			wantReturn: true, wantReason: "action:merge-ready",
		},
		{
			name:       "child ask needs the lead",
			digest:     wshrpc.DagStatusDigest{Health: "needs-you", Next: wshrpc.DagNextStep{Kind: "human-action", Actions: []string{"answer"}}},
			wantReturn: true, wantReason: "action:human-action",
		},
		{
			name:       "terminal kind wins",
			digest:     wshrpc.DagStatusDigest{Health: "healthy", Next: wshrpc.DagNextStep{Kind: "terminal", TerminalStatus: "done"}},
			wantReturn: true, wantReason: "terminal:done",
		},
		{
			name:       "cancelled health is terminal even without a terminal next",
			digest:     wshrpc.DagStatusDigest{Health: "cancelled", Next: wshrpc.DagNextStep{Kind: "dispatch"}},
			wantReturn: true, wantReason: "terminal:cancelled",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, reason := waitDecision(c.digest)
			if got != c.wantReturn {
				t.Fatalf("returnNow = %v, want %v", got, c.wantReturn)
			}
			if c.wantReturn && reason != c.wantReason {
				t.Fatalf("reason = %q, want %q", reason, c.wantReason)
			}
		})
	}
}
