// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisstate

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// AttachRunToChunk records that a run is working a chunk (idempotent; refreshes the ref ts). Used by
// CreateRunCommand when the composer picked an effort chunk. Advisory only — nothing auto-ticks.
func AttachRunToChunk(ctx context.Context, effortOID, chunkRef, runORef string) error {
	if _, err := wstore.GetEffort(ctx, effortOID); err != nil {
		return err
	}
	return wstore.UpdateEffort(ctx, effortOID, func(e *waveobj.Effort) error {
		return ApplyEffortOps(e, []wshrpc.EffortOp{{
			Op: "attachWork", Chunk: chunkRef, Kind: "run", ORef: runORef,
		}}, "", time.Now().UnixMilli())
	})
}

// DetachRunFromChunk removes a run's workref from whichever chunk holds it (idempotent). Called at
// evidence seal so a finished run stops claiming a chunk.
func DetachRunFromChunk(ctx context.Context, effortOID, runORef string) error {
	if _, err := wstore.GetEffort(ctx, effortOID); err != nil {
		return err
	}
	return wstore.UpdateEffort(ctx, effortOID, func(e *waveobj.Effort) error {
		return ApplyEffortOps(e, []wshrpc.EffortOp{{
			Op: "detachWork", ORef: runORef,
		}}, "", time.Now().UnixMilli())
	})
}
