// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestEnsureWshOnPath(t *testing.T) {
	sep := string(os.PathListSeparator)
	bin := "/wave/bin"

	getPath := func(env []string) string {
		for _, kv := range env {
			if name, val, ok := strings.Cut(kv, "="); ok && strings.EqualFold(name, "PATH") {
				return val
			}
		}
		return ""
	}

	t.Run("prepends when missing", func(t *testing.T) {
		ecmd := &exec.Cmd{Env: []string{"WAVETERM_WSHBINDIR=" + bin, "PATH=/usr/bin" + sep + "/bin"}}
		ensureWshOnPath(ecmd)
		want := bin + sep + "/usr/bin" + sep + "/bin"
		if got := getPath(ecmd.Env); got != want {
			t.Fatalf("PATH = %q, want %q", got, want)
		}
	})

	t.Run("idempotent when already present", func(t *testing.T) {
		ecmd := &exec.Cmd{Env: []string{"WAVETERM_WSHBINDIR=" + bin, "PATH=" + bin + sep + "/usr/bin"}}
		ensureWshOnPath(ecmd)
		want := bin + sep + "/usr/bin"
		if got := getPath(ecmd.Env); got != want {
			t.Fatalf("PATH = %q, want %q (should not duplicate)", got, want)
		}
	})

	t.Run("no-op without bin dir", func(t *testing.T) {
		ecmd := &exec.Cmd{Env: []string{"PATH=/usr/bin"}}
		ensureWshOnPath(ecmd)
		if got := getPath(ecmd.Env); got != "/usr/bin" {
			t.Fatalf("PATH = %q, want unchanged", got)
		}
	})

	t.Run("adds PATH when absent", func(t *testing.T) {
		ecmd := &exec.Cmd{Env: []string{"WAVETERM_WSHBINDIR=" + bin}}
		ensureWshOnPath(ecmd)
		if got := getPath(ecmd.Env); got != bin {
			t.Fatalf("PATH = %q, want %q", got, bin)
		}
	})
}
