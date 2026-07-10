package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestMemoryLearnRoutesCorrectionsVsPending(t *testing.T) {
	ws := &WshServer{}
	rtn, err := ws.MemoryLearnCommand(context.Background(), wshrpc.CommandMemoryLearnData{
		Cwd: "", // empty cwd -> default vault / pending dir; asserts routing counts only
		Candidates: []wshrpc.MemoryLearnCandidate{
			{Type: "feedback", Body: "correction one", IsCorrection: true},
			{Type: "project", Body: "fact one", IsCorrection: false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.Committed != 1 || rtn.Queued != 1 {
		t.Fatalf("committed=%d queued=%d, want 1/1", rtn.Committed, rtn.Queued)
	}
}
