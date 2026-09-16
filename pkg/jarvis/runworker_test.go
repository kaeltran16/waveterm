package jarvis

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestStopRunWorkerDisablesRunOnStart(t *testing.T) {
	ctx := context.Background()
	tabId := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	blockId := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	tab := &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	block := &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId, Meta: waveobj.MetaMapType{waveobj.MetaKey_CmdRunOnStart: true}}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}
	oref := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	if err := StopRunWorker(ctx, oref); err != nil {
		t.Fatalf("StopRunWorker: %v", err)
	}
	got, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		t.Fatal(err)
	}
	if got.Meta[waveobj.MetaKey_CmdRunOnStart] != false {
		t.Fatalf("cmd:runonstart = %#v, want false", got.Meta[waveobj.MetaKey_CmdRunOnStart])
	}
}

func TestStopRunWorkerReturnsRunOnStartPersistenceFailure(t *testing.T) {
	ctx := context.Background()
	oldDestroy := destroyBlockController
	destroyed := false
	destroyBlockController = func(string) { destroyed = true }
	t.Cleanup(func() { destroyBlockController = oldDestroy })
	tabID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	missingBlockID := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabID, BlockIds: []string{missingBlockID}}); err != nil {
		t.Fatal(err)
	}

	err := StopRunWorker(ctx, waveobj.MakeORef(waveobj.OType_Tab, tabID).String())
	if err == nil || !strings.Contains(err.Error(), missingBlockID) {
		t.Fatalf("stop error = %v, want missing block persistence failure", err)
	}
	if destroyed {
		t.Fatal("controller destroyed before durable runonstart marker persisted")
	}
}

func TestStopRunWorkerErrors(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		oref string
	}{
		{name: "malformed", oref: "not-an-oref"},
		{name: "non-tab", oref: waveobj.MakeORef(waveobj.OType_Block, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").String()},
		{name: "missing-tab", oref: waveobj.MakeORef(waveobj.OType_Tab, "cccccccc-cccc-4ccc-8ccc-cccccccccccc").String()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := StopRunWorker(ctx, tc.oref); err == nil {
				t.Fatalf("want error for %s", tc.name)
			}
		})
	}
}

func TestStopRunWorkersJoinsErrors(t *testing.T) {
	ctx := context.Background()
	run := NewRun("g", "ws-1", "/tmp", nil, RunMode_Quick, QuickPlaybook(), 1)
	run.Phases[0].WorkerOrefs = []string{
		"bad-oref-1",
		"bad-oref-2",
	}
	err := StopRunWorkers(ctx, &run)
	if err == nil {
		t.Fatal("want joined error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "bad-oref-1") || !strings.Contains(msg, "bad-oref-2") {
		t.Fatalf("joined error %q missing orefs", msg)
	}
}

// A stop that only clears runonstart is not durable: the block keeps its controller name, so the next
// ResyncController builds a fresh controller and runs the command again (a forced resync does not even
// consult runonstart). Clearing the controller makes resync destroy instead of create.
func TestStopRunWorkerDisarmsTheBlockForResync(t *testing.T) {
	ctx := context.Background()
	tabId := "1a2b3c4d-0001-4000-8000-000000000001"
	blockId := "1a2b3c4d-0002-4000-8000-000000000002"
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}}); err != nil {
		t.Fatal(err)
	}
	block := &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId, Meta: waveobj.MetaMapType{
		waveobj.MetaKey_Controller:    "cmd",
		waveobj.MetaKey_CmdRunOnStart: true,
		waveobj.MetaKey_CmdRunOnce:    true,
		waveobj.MetaKey_Cmd:           "claude",
	}}
	if err := wstore.DBInsert(ctx, block); err != nil {
		t.Fatal(err)
	}
	if err := StopRunWorker(ctx, waveobj.MakeORef(waveobj.OType_Tab, tabId).String()); err != nil {
		t.Fatalf("StopRunWorker: %v", err)
	}
	got, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		t.Fatal(err)
	}
	// ResyncController reads this with GetString(MetaKey_Controller, "") and returns early on empty
	if name := got.Meta.GetString(waveobj.MetaKey_Controller, ""); name != "" {
		t.Fatalf("controller = %q, want empty so a resync cannot restart the worker", name)
	}
	for _, key := range []string{waveobj.MetaKey_CmdRunOnStart, waveobj.MetaKey_CmdRunOnce} {
		if got.Meta[key] != false {
			t.Fatalf("%s = %#v, want false", key, got.Meta[key])
		}
	}
	// the scrollback the evidence snapshot reads must survive the stop
	if got.Meta.GetString(waveobj.MetaKey_Cmd, "") != "claude" {
		t.Fatalf("stopping a worker must not erase the block's command, got %#v", got.Meta[waveobj.MetaKey_Cmd])
	}
}
