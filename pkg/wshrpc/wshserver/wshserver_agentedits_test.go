// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestGitAgentEditsAnswersNothingToShowWithAReason(t *testing.T) {
	ws := &WshServer{}
	rtn, err := ws.GitAgentEditsCommand(context.Background(), wshrpc.CommandGitAgentEditsData{
		Cwd:            t.TempDir(),
		TranscriptPath: "does-not-matter.jsonl",
	})
	if err != nil {
		t.Fatalf("GitAgentEditsCommand: %v", err)
	}
	if rtn.Base != "" {
		t.Errorf("base = %q, want empty", rtn.Base)
	}
	if rtn.Reason == "" {
		t.Error("reason is empty, want the caption for an empty answer")
	}
}
