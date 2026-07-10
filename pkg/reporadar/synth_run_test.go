// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"
)

func TestRunSonnetUsesInjectedStream(t *testing.T) {
	fake := func(ctx context.Context, prompt string) ([]string, error) {
		return []string{
			`{"type":"system","subtype":"init","model":"claude-sonnet-x"}`,
			`{"type":"result","subtype":"success","result":"{\"findings\":[]}","usage":{"input_tokens":10,"output_tokens":5}}`,
		}, nil
	}
	out, err := runSonnetWith(context.Background(), "payload", fake)
	if err != nil {
		t.Fatalf("runSonnetWith: %v", err)
	}
	if out.modelID != "claude-sonnet-x" || out.totalTokens != 15 {
		t.Fatalf("unexpected: %+v", out)
	}
}
