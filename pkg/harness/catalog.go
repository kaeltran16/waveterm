// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Package harness is the catalog of installed coding-agent harnesses (Pi, Claude Code, Codex, OpenCode).
// It owns identity, capabilities, executable lookup, and installation probing so that
// consult (pkg/consult) and Run workers (pkg/jarvis) share one source of truth and never silently
// fall back to another harness. OpenRouter is an API-backed utility runtime and intentionally lives
// outside this catalog.

package harness

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
)

type Operation string

const (
	OperationConsult   Operation = "consult"
	OperationRunWorker Operation = "run-worker"
)

type Spec struct {
	Runtime          string
	Bin              string
	Label            string
	ConsultCapable   bool
	RunWorkerCapable bool
}

var specs = []Spec{
	{Runtime: "pi", Bin: "pi", Label: "Pi", ConsultCapable: true, RunWorkerCapable: true},
	{Runtime: "claude", Bin: "claude", Label: "Claude Code", ConsultCapable: true, RunWorkerCapable: true},
	{Runtime: "codex", Bin: "codex", Label: "Codex", ConsultCapable: true, RunWorkerCapable: true},
	{Runtime: "opencode", Bin: "opencode", Label: "OpenCode", ConsultCapable: true, RunWorkerCapable: true},
}

func List() []Spec {
	return append([]Spec(nil), specs...)
}

func Lookup(runtime string) (Spec, bool) {
	for _, spec := range specs {
		if spec.Runtime == runtime {
			return spec, true
		}
	}
	return Spec{}, false
}

type ProbeResult struct {
	Spec      Spec
	Installed bool
	Version   string
}

// lookPath is a seam for tests; production behavior is exec.LookPath.
var lookPath = exec.LookPath

// versionCommand is a seam for tests; production behavior is `<bin> --version` under the caller ctx.
var versionCommand = func(ctx context.Context, bin string) ([]byte, error) {
	return exec.CommandContext(ctx, bin, "--version").CombinedOutput()
}

func ValidateInstalled(runtime string, operation Operation) (Spec, error) {
	spec, ok := Lookup(runtime)
	if !ok {
		return Spec{}, fmt.Errorf("unknown harness %q", runtime)
	}
	if operation == OperationConsult && !spec.ConsultCapable {
		return Spec{}, fmt.Errorf("harness %q does not support consults", runtime)
	}
	if operation == OperationRunWorker && !spec.RunWorkerCapable {
		return Spec{}, fmt.Errorf("harness %q does not support run workers", runtime)
	}
	if _, err := lookPath(spec.Bin); err != nil {
		return Spec{}, fmt.Errorf("harness %q is not installed", runtime)
	}
	return spec, nil
}

func probe(ctx context.Context, spec Spec) ProbeResult {
	if _, err := lookPath(spec.Bin); err != nil {
		return ProbeResult{Spec: spec}
	}
	out, _ := versionCommand(ctx, spec.Bin)
	return ProbeResult{Spec: spec, Installed: true, Version: strings.TrimSpace(string(out))}
}

func ProbeAll(ctx context.Context) []ProbeResult {
	results := make([]ProbeResult, len(specs))
	var wg sync.WaitGroup
	for i, spec := range specs {
		wg.Add(1)
		go func(i int, spec Spec) {
			defer wg.Done()
			results[i] = probe(ctx, spec)
		}(i, spec)
	}
	wg.Wait()
	return results
}
