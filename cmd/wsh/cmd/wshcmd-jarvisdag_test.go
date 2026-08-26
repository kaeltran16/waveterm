// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"reflect"
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
	if err := cmd.Flags().Set("channel", "ch"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("runid", "run"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("tier", "capable"); err != nil {
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

func TestDagTaskActions(t *testing.T) {
	cases := []struct {
		name string
		node waveobj.TaskNode
		want []string
	}{
		{"done gate", waveobj.TaskNode{State: "done", Gate: true}, []string{"approve", "sendback"}},
		{"done ready to merge", waveobj.TaskNode{State: "done"}, []string{"merge"}},
		{"done released", waveobj.TaskNode{State: "done", Released: true}, nil},
		{"failed", waveobj.TaskNode{State: "failed"}, []string{"retry", "skip"}},
		{"stalled", waveobj.TaskNode{State: "stalled"}, []string{"retry", "skip"}},
		{"blocked-merge", waveobj.TaskNode{State: "blocked-merge"}, []string{"resolve"}},
		{"running", waveobj.TaskNode{State: "running"}, nil},
		{"pending", waveobj.TaskNode{State: "pending"}, nil},
	}
	for _, c := range cases {
		if got := dagTaskActions(c.node); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: dagTaskActions = %v, want %v", c.name, got, c.want)
		}
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
