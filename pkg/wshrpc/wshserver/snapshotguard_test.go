// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/memhygiene"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const snapshotRefusal = "snapshot store:"

// useSnapshotBase points the data dir at <tmp>/arc-snap/data, sets ARC_SNAPSHOT as asked and returns the
// arc-snap base. The package store stays open where TestMain put it: only the path rules move.
func useSnapshotBase(t *testing.T, snapshot bool) string {
	t.Helper()
	base := filepath.Join(t.TempDir(), "arc-snap")
	if err := os.MkdirAll(filepath.Join(base, "scratch"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = filepath.Join(base, "data")
	t.Cleanup(func() { wavebase.DataHome_VarCache = old })
	if snapshot {
		t.Setenv(wavebase.ArcSnapshotVarName, "1")
	} else {
		t.Setenv(wavebase.ArcSnapshotVarName, "")
	}
	return base
}

// fileRpcClient is a client wired to a WshServer over in-memory channels, so a file RPC carries the request
// context wshfs resolves a bare path's host from, as the frontend's does.
func fileRpcClient(t *testing.T) *wshutil.WshRpc {
	t.Helper()
	server := wshutil.MakeWshRpc(wshrpc.RpcContext{}, &WshServer{}, "snapguard-server")
	client := wshutil.MakeWshRpc(wshrpc.RpcContext{}, nil, "snapguard-client")
	pump := func(from, to *wshutil.WshRpc) {
		for msg := range from.OutputCh {
			to.InputCh <- baseds.RpcInputChType{MsgBytes: msg}
		}
	}
	go pump(client, server)
	go pump(server, client)
	t.Cleanup(func() {
		close(client.InputCh)
		close(server.InputCh)
	})
	return client
}

// wantRefusal wants a snapshot refusal naming path, bare or %q-quoted.
func wantRefusal(t *testing.T, what string, err error, path string) {
	t.Helper()
	named := err != nil && (strings.Contains(err.Error(), path) || strings.Contains(err.Error(), fmt.Sprintf("%q", path)))
	if !named || !strings.Contains(err.Error(), snapshotRefusal) {
		t.Errorf("%s: err = %v, want a %q refusal naming %s", what, err, snapshotRefusal, path)
	}
}

// the guard let it through. wshfs has no transport in tests, so a passed call still errors past the guard.
func wantNoRefusal(t *testing.T, what string, err error) {
	t.Helper()
	if err != nil && strings.Contains(err.Error(), snapshotRefusal) {
		t.Errorf("%s: refused: %v", what, err)
	}
}

func fileData(path string) wshrpc.FileData {
	return wshrpc.FileData{Info: &wshrpc.FileInfo{Path: path}, Data64: "aGk="}
}

func insertCwdBlock(t *testing.T, cwd string) string {
	t.Helper()
	blockId := uuid.NewString()
	block := &waveobj.Block{OID: blockId, ParentORef: "tab:" + uuid.NewString(), Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: cwd}}
	if err := wstore.DBInsert(context.Background(), block); err != nil {
		t.Fatal(err)
	}
	return blockId
}

func TestSnapshotRefusesReviewWrite(t *testing.T) {
	useSnapshotBase(t, true)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(home, ".arc", "review")
	_, err = (&WshServer{}).CodeReviewWriteCommand(context.Background(), wshrpc.CommandCodeReviewWriteData{Project: "snapproj", Markdown: "# review"})
	wantRefusal(t, "review write", err, root)
	if _, statErr := os.Stat(filepath.Join(root, "snapproj")); !os.IsNotExist(statErr) {
		t.Errorf("a refused review wrote %s (stat: %v)", filepath.Join(root, "snapproj"), statErr)
	}
}

func TestSnapshotRefusesFileDeleteOutsideBase(t *testing.T) {
	useSnapshotBase(t, true)
	client := fileRpcClient(t)
	outside := filepath.Join(t.TempDir(), "real-repo")
	err := wshclient.FileDeleteCommand(client, wshrpc.CommandDeleteFileData{Path: outside, Recursive: true}, nil)
	wantRefusal(t, "delete", err, outside)
}

func TestSnapshotRefusesFileWritesOutsideBase(t *testing.T) {
	base := useSnapshotBase(t, true)
	client := fileRpcClient(t)
	inside := filepath.Join(base, "vault", "a.md")
	outside := filepath.Join(t.TempDir(), "real-repo", "a.md")
	wantRefusal(t, "write", wshclient.FileWriteCommand(client, fileData(outside), nil), outside)
	wantRefusal(t, "create", wshclient.FileCreateCommand(client, fileData(outside), nil), outside)
	wantRefusal(t, "mkdir", wshclient.FileMkdirCommand(client, fileData(outside), nil), outside)
	wantRefusal(t, "move out", wshclient.FileMoveCommand(client, wshrpc.CommandFileCopyData{SrcUri: inside, DestUri: outside}, nil), outside)
	wantRefusal(t, "move in", wshclient.FileMoveCommand(client, wshrpc.CommandFileCopyData{SrcUri: outside, DestUri: inside}, nil), outside)
}

func TestSnapshotAllowsFileWriteInsideBase(t *testing.T) {
	base := useSnapshotBase(t, true)
	client := fileRpcClient(t)
	inside := filepath.Join(base, "vault", "a.md")
	wantNoRefusal(t, "bare path", wshclient.FileWriteCommand(client, fileData(inside), nil))
	wantNoRefusal(t, "local uri", wshclient.FileWriteCommand(client, fileData("wsh://local/"+filepath.ToSlash(inside)), nil))
	remote := "wsh://otherhost/" + filepath.ToSlash(inside)
	wantRefusal(t, "remote uri", wshclient.FileWriteCommand(client, fileData(remote), nil), "otherhost")
}

func TestSnapshotRefusesAgentPromptOutsideScratch(t *testing.T) {
	base := useSnapshotBase(t, true)
	sent := scriptAgents(t, threeAgents())
	ws := &WshServer{}
	outside := filepath.Join(t.TempDir(), "real-repo")
	realBlock := insertCwdBlock(t, outside)
	err := ws.AgentPromptCommand(context.Background(), wshrpc.CommandAgentPromptData{BlockId: realBlock, Text: "approve"})
	wantRefusal(t, "prompt to a copied agent", err, outside)
	if len(*sent) != 0 {
		t.Fatalf("a refused prompt delivered %+v", *sent)
	}
	scratchBlock := insertCwdBlock(t, filepath.Join(base, "scratch", "proj"))
	if err := ws.AgentPromptCommand(context.Background(), wshrpc.CommandAgentPromptData{BlockId: scratchBlock, Text: "go on"}); err != nil {
		t.Fatalf("prompt to a scratch agent: %v", err)
	}
	if len(*sent) != 1 || (*sent)[0].blockId != scratchBlock {
		t.Errorf("delivered %+v, want one prompt to the scratch agent", *sent)
	}
}

func TestSnapshotRefusesBlockCwdOutsideScratch(t *testing.T) {
	base := useSnapshotBase(t, true)
	ctx := context.Background()
	ws := &WshServer{}
	outside := filepath.Join(t.TempDir(), "real-repo")

	_, err := ws.CreateBlockCommand(ctx, wshrpc.CommandCreateBlockData{
		TabId:    uuid.NewString(),
		BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_CmdCwd: outside}},
	})
	wantRefusal(t, "create block", err, outside)

	scratchCwd := filepath.Join(base, "scratch", "proj")
	blockId := insertCwdBlock(t, scratchCwd)
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
	err = ws.SetMetaCommand(ctx, wshrpc.CommandSetMetaData{ORef: oref, Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: outside}})
	wantRefusal(t, "set meta", err, outside)
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		t.Fatal(err)
	}
	if got := block.Meta.GetString(waveobj.MetaKey_CmdCwd, ""); got != scratchCwd {
		t.Errorf("a refused set meta changed cmd:cwd to %q", got)
	}
	inside := filepath.Join(scratchCwd, "sub")
	if err := ws.SetMetaCommand(ctx, wshrpc.CommandSetMetaData{ORef: oref, Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: inside}}); err != nil {
		t.Errorf("set meta to a scratch cwd: %v", err)
	}
}

func TestNoSnapshotLeavesHandlersOpen(t *testing.T) {
	useSnapshotBase(t, false)
	ctx := context.Background()
	ws := &WshServer{}
	client := fileRpcClient(t)
	outside := filepath.Join(t.TempDir(), "real-repo")

	wantNoRefusal(t, "file write", wshclient.FileWriteCommand(client, fileData(filepath.Join(outside, "a.md")), nil))
	wantNoRefusal(t, "file delete", wshclient.FileDeleteCommand(client, wshrpc.CommandDeleteFileData{Path: outside}, nil))

	rtn, err := ws.CodeReviewWriteCommand(ctx, wshrpc.CommandCodeReviewWriteData{Project: "nosnapproj", Markdown: "# review"})
	if err != nil {
		t.Fatalf("review write: %v", err)
	}
	if _, err := os.Stat(rtn.Path); err != nil {
		t.Errorf("review not written: %v", err)
	}

	blockId := insertCwdBlock(t, outside)
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
	if err := ws.SetMetaCommand(ctx, wshrpc.CommandSetMetaData{ORef: oref, Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: filepath.Join(outside, "sub")}}); err != nil {
		t.Errorf("set meta: %v", err)
	}
	sent := scriptAgents(t, threeAgents())
	if err := ws.AgentPromptCommand(ctx, wshrpc.CommandAgentPromptData{BlockId: blockId, Text: "hi"}); err != nil || len(*sent) != 1 {
		t.Errorf("prompt: err %v, delivered %+v", err, *sent)
	}
}

func TestSnapshotRefusesMemoryCheck(t *testing.T) {
	useSnapshotBase(t, true)
	err := (&WshServer{}).CheckMemoryHygieneCommand(context.Background(), wshrpc.CommandCheckMemoryHygieneData{Project: "snapmem"})
	if err == nil || !strings.HasPrefix(err.Error(), snapshotRefusal) || !strings.Contains(err.Error(), "model") {
		t.Errorf("memory check: err = %v, want a %q refusal saying it calls a model", err, snapshotRefusal)
	}
	if _, statErr := os.Stat(memhygiene.StateDir()); !os.IsNotExist(statErr) {
		t.Errorf("a refused check touched the state dir (stat: %v)", statErr)
	}
}

func TestSnapshotRefusesMemoryApplyUndo(t *testing.T) {
	useSnapshotBase(t, true)
	ws := &WshServer{}
	for _, verdict := range []string{wshrpc.MemVerdict_Apply, wshrpc.MemVerdict_Undo} {
		_, err := ws.DecideMemoryChangeCommand(context.Background(), wshrpc.CommandDecideMemoryChangeData{Project: "snapmem", ChangeId: "c1", Verdict: verdict})
		if err == nil || !strings.HasPrefix(err.Error(), snapshotRefusal) {
			t.Errorf("memory %s: err = %v, want a %q refusal", verdict, err, snapshotRefusal)
		}
	}
	if _, statErr := os.Stat(memhygiene.StateDir()); !os.IsNotExist(statErr) {
		t.Errorf("a refused apply or undo touched the state dir (stat: %v)", statErr)
	}
}

func TestSnapshotAllowsMemoryKeepReopen(t *testing.T) {
	useSnapshotBase(t, true)
	if _, err := memhygiene.Update("snapmem", func(st *memhygiene.State) error {
		st.Changes = []wshrpc.MemChange{{Id: "c1", Title: "Drop a.md", Status: "open"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	ws := &WshServer{}
	for _, verdict := range []string{wshrpc.MemVerdict_Keep, wshrpc.MemVerdict_Reopen} {
		if _, err := ws.DecideMemoryChangeCommand(context.Background(), wshrpc.CommandDecideMemoryChangeData{Project: "snapmem", ChangeId: "c1", Verdict: verdict}); err != nil {
			t.Errorf("memory %s under a snapshot: %v", verdict, err)
		}
	}
}
