// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestListHarnessesReturnsCatalogWithoutOpenRouter(t *testing.T) {
	old := probeHarnesses
	t.Cleanup(func() { probeHarnesses = old })
	probeHarnesses = func(ctx context.Context) []harness.ProbeResult {
		results := []harness.ProbeResult{}
		for i, spec := range harness.List() {
			results = append(results, harness.ProbeResult{Spec: spec, Installed: i%2 == 0, Version: "1.2.3"})
		}
		return results
	}

	rtn, err := (&WshServer{}).ListHarnessesCommand(context.Background())
	if err != nil {
		t.Fatalf("ListHarnessesCommand: %v", err)
	}
	if len(rtn.Harnesses) != 5 {
		t.Fatalf("len = %d, want 5", len(rtn.Harnesses))
	}
	for _, info := range rtn.Harnesses {
		if info.Runtime == "openrouter" {
			t.Fatal("OpenRouter must not be listed as a harness")
		}
		if info.Label == "" || !info.ConsultCapable || !info.RunWorkerCapable {
			t.Errorf("info %+v missing label/capabilities", info)
		}
	}
}

func TestConsultRejectsUnknownRuntimeBeforeDispatch(t *testing.T) {
	old := validateHarness
	t.Cleanup(func() { validateHarness = old })
	validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
		return harness.Spec{}, errors.New("unknown harness \"mystery\"")
	}

	ch := (&WshServer{}).ConsultCommand(context.Background(), wshrpc.CommandConsultData{
		ChannelId: "ch:1",
		Runtime:   "mystery",
		Prompt:    "hi",
	})
	var gotErr error
	for resp := range ch {
		if resp.Error != nil {
			gotErr = resp.Error
		}
	}
	if gotErr == nil || !strings.Contains(gotErr.Error(), "mystery") {
		t.Fatalf("error = %v, want validator error naming the runtime", gotErr)
	}
}
