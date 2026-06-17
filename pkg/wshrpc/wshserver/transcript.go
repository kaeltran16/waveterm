// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"fmt"
	"os"
	"strings"
)

const defaultTranscriptTailLines = 200

// readTranscriptTail returns the last maxLines non-empty lines of the JSONL transcript at path.
// The whole file is read then tailed in memory; session transcripts are MB-scale at most, so this
// stays simple (KISS) — switch to a seek-from-end read only if a real file proves too large.
func readTranscriptTail(path string, maxLines int) ([]string, error) {
	if path == "" {
		return nil, fmt.Errorf("transcript path is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat transcript: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("transcript path is a directory: %s", path)
	}
	if maxLines <= 0 {
		maxLines = defaultTranscriptTailLines
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read transcript: %w", err)
	}
	var lines []string
	for _, ln := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		lines = append(lines, ln)
	}
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines, nil
}
