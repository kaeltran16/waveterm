// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package objectservice

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "objectservice-test-*")
	if err != nil {
		panic(err)
	}
	wavebase.DataHome_VarCache = dir
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		panic(err)
	}
	if err := wstore.InitWStore(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// an engine tick loads the dag under its lock and writes that snapshot back whole: a write sent while the tick holds
// the lock lands after the tick's, not under it
func TestUpdateObjectOfADagWaitsForTheDagLock(t *testing.T) {
	ctx := context.Background()
	const dagID = "objectservice-dag"
	if err := wstore.DBInsert(ctx, &waveobj.TaskGroup{OID: dagID, ID: dagID, Title: "before"}); err != nil {
		t.Fatal(err)
	}
	loaded := make(chan struct{})
	release := make(chan struct{})
	tick := make(chan error, 1)
	go func() {
		tick <- orchestrate.WithDagMutation(dagID, func() error {
			snapshot, err := wstore.GetDag(ctx, dagID)
			if err != nil {
				return err
			}
			close(loaded)
			<-release
			return wstore.DBUpdate(ctx, snapshot)
		})
	}()
	<-loaded

	seed, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		t.Fatal(err)
	}
	seed.Title = "seeded"
	written := make(chan error, 1)
	go func() {
		_, err := (&ObjectService{}).UpdateObject(waveobj.UIContext{}, seed, false)
		written <- err
	}()
	select {
	case err := <-written:
		t.Fatalf("the write landed while the tick held the dag (err %v)", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-tick; err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	stored, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Title != "seeded" {
		t.Errorf("stored title %q, want the write's %q over the tick's snapshot", stored.Title, "seeded")
	}
}
