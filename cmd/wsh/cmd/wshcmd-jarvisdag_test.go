// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/pitasks"
)

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
