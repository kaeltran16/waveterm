// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const RunWorkerSpawnTimeout = 60 * time.Second

var destroyBlockController = blockcontroller.DestroyBlockController

func StopRunWorker(ctx context.Context, workerORef string) error {
	oref, err := waveobj.ParseORef(workerORef)
	if err != nil {
		return fmt.Errorf("bad worker oref %q: %w", workerORef, err)
	}
	if oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("bad worker oref %q: expected tab", workerORef)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, oref.OID)
	// a finished worker's tab can already be closed; with no tab there is nothing left running to stop
	if errors.Is(err, wstore.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("loading tab %q: %w", workerORef, err)
	}
	var errs []error
	for _, blockId := range tab.BlockIds {
		// clearing runonstart alone is not a durable stop: the block keeps its controller name, and any
		// ResyncController - the frontend issues one whenever the block renders - builds a fresh
		// controller that starts the command again, a forced resync ignoring runonstart entirely. With no
		// controller name resync destroys instead of creating, so a stopped worker cannot come back. Every
		// caller here is abandoning the worker for good (dispatch failure, retry, cancel, merged cleanup);
		// a retry spawns a new tab rather than restarting this block.
		meta := waveobj.MetaMapType{
			waveobj.MetaKey_Controller:    "",
			waveobj.MetaKey_CmdRunOnStart: false,
			waveobj.MetaKey_CmdRunOnce:    false,
		}
		if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), meta, false); err != nil {
			errs = append(errs, fmt.Errorf("disarming block %s: %w", blockId, err))
			continue
		}
		destroyBlockController(blockId)
	}
	return errors.Join(errs...)
}

func StopRunWorkers(ctx context.Context, run *waveobj.Run) error {
	var errs []error
	for i := range run.Phases {
		for _, workerORef := range run.Phases[i].WorkerOrefs {
			if err := StopRunWorker(ctx, workerORef); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", workerORef, err))
			}
		}
	}
	return errors.Join(errs...)
}
