// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"os"
	"strings"
	"time"
)

// TailResult bundles a transcript's tail lines with its mtime — the two file facts DeriveState needs.
type TailResult struct {
	Lines   []string
	ModTime time.Time
}

// ReadTail returns the last n non-empty lines of the JSONL transcript at path plus its mtime. The
// whole file is read (transcripts are MB-scale at most), matching pkg/wshrpc/wshserver. A read/stat
// error yields a zero TailResult and the error.
func ReadTail(path string, n int) (TailResult, error) {
	st, err := os.Stat(path)
	if err != nil {
		return TailResult{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return TailResult{}, err
	}
	var lines []string
	for _, ln := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(ln) != "" {
			lines = append(lines, ln)
		}
	}
	if n > 0 && len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return TailResult{Lines: lines, ModTime: st.ModTime()}, nil
}
