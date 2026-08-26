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
