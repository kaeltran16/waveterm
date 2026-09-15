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
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func newDagEscalateTestCmd(t *testing.T, flags map[string]string) *cobra.Command {
	t.Helper()
	cmd := &cobra.Command{}
	for _, name := range []string{"channel", "runid", "model", "runtime"} {
		cmd.Flags().String(name, "", "")
	}
	for name, value := range flags {
		if err := cmd.Flags().Set(name, value); err != nil {
			t.Fatal(err)
		}
	}
	return cmd
}

func TestDagEscalateData(t *testing.T) {
	cmd := newDagEscalateTestCmd(t, map[string]string{"channel": "ch", "runid": "run", "model": "sonnet", "runtime": "claude"})
	got, err := dagEscalateData(cmd, []string{"t-1"})
	if err != nil {
		t.Fatal(err)
	}
	want := wshrpc.CommandDagActionData{
		ChannelId: "ch",
		RunId:     "run",
		TaskId:    "t-1",
		Action:    "escalate",
		Model:     "sonnet",
		Runtime:   "claude",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dagEscalateData = %+v, want %+v", got, want)
	}
	if dagEscalateCmd.PreRunE == nil {
		t.Fatal("escalate command must initialize the RPC client")
	}
	if dagEscalateCmd.Flags().Lookup("tier") != nil {
		t.Fatal("escalate must not offer a tier flag")
	}
}

func TestDagEscalateDataRequiresModel(t *testing.T) {
	cmd := newDagEscalateTestCmd(t, map[string]string{"channel": "ch", "runid": "run", "runtime": "claude"})
	if _, err := dagEscalateData(cmd, []string{"t-1"}); err == nil || !strings.Contains(err.Error(), "--model is required") {
		t.Fatalf("missing model error = %v", err)
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

func TestDagAskLinesShowsEveryQuestion(t *testing.T) {
	asks := []wshrpc.DagAskItem{
		{TaskId: "t-3", Owner: agentask.AskOwner_Lead, Ts: 9_000, Deadline: 609_000, Questions: []baseds.AgentAskQuestion{{Question: "later?"}}},
		{TaskId: "t-2", Owner: agentask.AskOwner_Lead, Ts: 1_000, Deadline: 601_000, Note: agentask.AnswerUnconfirmedNote, Questions: []baseds.AgentAskQuestion{
			{Header: "Cache", Question: "which ttl?", Options: []baseds.AgentAskOption{{Label: "24h", Description: "matches prod"}, {Label: "7d"}}},
			{Question: "which regions?", MultiSelect: true, Options: []baseds.AgentAskOption{{Label: "eu"}, {Label: "us"}}},
		}},
		{TaskId: "t-4", Owner: agentask.AskOwner_User, Ts: 500, Questions: []baseds.AgentAskQuestion{{Question: "the human's call?"}}},
	}
	joined := strings.Join(dagAskLines(asks, 61_000), "\n")
	for _, want := range []string{
		"t-2  asked 1m ago  deadline in 9m",
		"note: " + agentask.AnswerUnconfirmedNote,
		"[Cache] which ttl?",
		"0) 24h - matches prod",
		"1) 7d",
		"which regions? (multi-select)",
		"wsh jarvis dag answer",
		"wsh jarvis dag forward",
		"1 held by the human in the run cockpit",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "the human's call?") {
		t.Fatalf("a question the human holds is not the lead's to answer:\n%s", joined)
	}
	if strings.Index(joined, "t-2") > strings.Index(joined, "t-3") {
		t.Fatalf("the oldest question comes first:\n%s", joined)
	}
}

func TestDagAskLinesWithNothingForTheLead(t *testing.T) {
	if got := dagAskLines(nil, 1_000); !reflect.DeepEqual(got, []string{"no questions waiting"}) {
		t.Fatalf("empty queue = %q", got)
	}
	held := []wshrpc.DagAskItem{{TaskId: "t-1", Owner: agentask.AskOwner_User, Ts: 1, Questions: []baseds.AgentAskQuestion{{Question: "q?"}}}}
	want := []string{"no questions waiting", "1 held by the human in the run cockpit"}
	if got := dagAskLines(held, 1_000); !reflect.DeepEqual(got, want) {
		t.Fatalf("human-held queue = %q, want %q", got, want)
	}
}

func TestDagForwardData(t *testing.T) {
	cmd := newDagEscalateTestCmd(t, map[string]string{"channel": "ch", "runid": "run"})
	got, err := dagForwardData(cmd, []string{"t-1", "scope call: B drops the export"})
	if err != nil {
		t.Fatal(err)
	}
	want := wshrpc.CommandDagActionData{ChannelId: "ch", RunId: "run", TaskId: "t-1", Action: "forward", Notes: "scope call: B drops the export"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("forward data = %+v, want %+v", got, want)
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

func TestDagSubmitExposesPlanFlag(t *testing.T) {
	if dagSubmitCmd.Flags().Lookup("plan") == nil {
		t.Fatal("dag submit must expose --plan for submitting a plan file")
	}
}

func TestDagPlanPath(t *testing.T) {
	if got, err := dagPlanPath(nil, "", ""); err != nil || got != "" {
		t.Fatalf("no --plan = %q, %v", got, err)
	}
	// wavesrv does not share the lead's cwd, so a relative --plan has to be resolved here
	got, err := dagPlanPath(nil, "", filepath.Join("docs", "plan.md"))
	if err != nil || !filepath.IsAbs(got) || !strings.HasSuffix(got, filepath.Join("docs", "plan.md")) {
		t.Fatalf("relative --plan = %q, %v", got, err)
	}
	if _, err := dagPlanPath([]string{`{}`}, "", "plan.md"); err == nil {
		t.Fatal("--plan + inline JSON must be rejected")
	}
	if _, err := dagPlanPath(nil, "dag.json", "plan.md"); err == nil {
		t.Fatal("--plan + --file must be rejected")
	}
}
