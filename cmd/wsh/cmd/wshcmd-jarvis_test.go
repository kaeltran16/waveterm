// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestJarvisRunSubcommandRegistered(t *testing.T) {
	var found bool
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "run" {
			found = true
		}
	}
	if !found {
		t.Fatal("`jarvis run` subcommand is not registered")
	}
}

func TestJarvisCtxSubcommandRegistered(t *testing.T) {
	var found bool
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "ctx" {
			found = true
		}
	}
	if !found {
		t.Fatal("`jarvis ctx` subcommand is not registered")
	}
}

func TestReadReportFile(t *testing.T) {
	dir := t.TempDir()

	path := filepath.Join(dir, "report.md")
	if err := os.WriteFile(path, []byte("  landed the fix\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	report, err := readReportFile(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if report != "landed the fix" {
		t.Errorf("report = %q, want %q", report, "landed the fix")
	}
}

func TestReadReportFileRefusesAMissingFile(t *testing.T) {
	if _, err := readReportFile(filepath.Join(t.TempDir(), "missing.md")); err == nil {
		t.Fatal("expected an error for a missing report file")
	}
}

func TestReadReportFileRefusesAnEmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.md")
	if err := os.WriteFile(path, []byte("   \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readReportFile(path); err == nil {
		t.Fatal("expected an error for an empty report file")
	}
}
