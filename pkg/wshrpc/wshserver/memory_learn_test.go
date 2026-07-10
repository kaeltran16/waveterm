package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestMemoryLearnRoutesCorrectionsVsPending(t *testing.T) {
	// redirect the home dir into a temp vault/pending store so the handler doesn't write into
	// the real user's memory. without this the correction dedups against a note left by a prior
	// run (committed=0) and the test is neither idempotent nor side-effect free.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home) // os.UserHomeDir reads %USERPROFILE% on Windows

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
