// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The process-running half of pkg/consult: stream a headless CLI's stdout to a callback while
// capturing the full reply, and probe whether a runtime's binary is installed.

package consult

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Run executes the runtime in one-shot mode with the given prompt and cwd, calling emit for each
// stdout chunk as it arrives, and returns the complete captured stdout. On a non-zero exit it
// returns the captured stdout so far plus an error built from stderr.
func Run(ctx context.Context, spec RuntimeSpec, cwd, prompt string, emit func(string)) (string, error) {
	args := append([]string{}, spec.BaseArgs...)
	if !spec.PromptViaStdin {
		args = append(args, prompt)
	}
	cmd := exec.CommandContext(ctx, spec.Bin, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	if spec.PromptViaStdin {
		cmd.Stdin = strings.NewReader(prompt)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("starting %s: %w", spec.Bin, err)
	}
	var full strings.Builder
	buf := make([]byte, 4096)
	for {
		n, rerr := stdout.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])
			full.WriteString(chunk)
			emit(chunk)
		}
		if rerr != nil {
			break
		}
	}
	if werr := cmd.Wait(); werr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = werr.Error()
		}
		return full.String(), fmt.Errorf("%s", msg)
	}
	return full.String(), nil
}

// probe reports whether bin resolves on PATH and its best-effort --version output.
func probe(ctx context.Context, bin string) (bool, string) {
	if _, err := exec.LookPath(bin); err != nil {
		return false, ""
	}
	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(vctx, bin, "--version").CombinedOutput()
	return true, strings.TrimSpace(string(out))
}

// ProbeInstalled reports install state + version for a known runtime identifier.
func ProbeInstalled(ctx context.Context, runtime string) (bool, string) {
	spec, ok := runtimeSpecs[runtime]
	if !ok {
		return false, ""
	}
	return probe(ctx, spec.Bin)
}
