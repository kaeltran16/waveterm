// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Two concurrent spawnRunWorkers calls for one run must spawn its running phase exactly once.
// Before the per-run lock both callers read empty WorkerOrefs and both spawn (this fails);
// with the lock the second caller sees the attached oref and skips.
func TestSpawnRunWorkers_ConcurrentSpawnsOnce(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "spawn-race", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("do X", "ws-id", "/repo", nil, jarvis.RunMode_Pipeline, jarvis.DefaultPlaybook(), 1)
	run.Runtime = "opencode"
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var calls int32
	var spawnedWith runroute.Capability
	origSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, cap runroute.Capability, _, _, _, _ string) (string, error) {
		spawnedWith = cap
		atomic.AddInt32(&calls, 1)
		time.Sleep(30 * time.Millisecond) // widen the read->spawn->attach window so a truly-concurrent second caller overlaps
		return waveobj.MakeORef(waveobj.OType_Tab, "faketab").String(), nil
	}
	defer func() { jarvis.SpawnRunWorker = origSpawn }()

	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			if err := spawnRunWorkers(ctx, ch.OID, run.ID, ch.Name); err != nil {
				t.Errorf("spawnRunWorkers: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("SpawnRunWorker calls = %d, want exactly 1", got)
	}
	if spawnedWith.Runtime != "opencode" || spawnedWith.Tier != "capable" {
		t.Fatalf("worker spawned with capability %+v, want opencode/capable", spawnedWith)
	}
	out, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if n := len(out.Phases[0].WorkerOrefs); n != 1 {
		t.Fatalf("phase 0 WorkerOrefs = %d, want 1", n)
	}
}
