// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisstate

import (
	"context"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
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
		return jarvis.ApplyEffortOps(e, []wshrpc.EffortOp{{
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
		return jarvis.ApplyEffortOps(e, []wshrpc.EffortOp{{
			Op: "detachWork", ORef: runORef,
		}}, "", time.Now().UnixMilli())
	})
}

// RunFinishedPrefix opens the note a sealed run leaves on its chunk; NoteRunFinished keys idempotence on it.
const RunFinishedPrefix = "Run finished"

// RunFinishedText is the one line a sealed run's chunk note reads as: the report's title, else the first
// line of the sealed summary, else the goal. The full report renders under the note (Chunk sidebar).
func RunFinishedText(r *waveobj.Run) string {
	first := func(s string) string {
		for _, l := range strings.Split(s, "\n") {
			if t := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "# ")); t != "" {
				return t
			}
		}
		return ""
	}
	line := first(r.Report)
	if line == "" && r.Evidence != nil {
		line = first(r.Evidence.Summary)
	}
	if line == "" {
		line = r.Goal
	}
	return RunFinishedPrefix + ": " + line
}

// NoteRunFinished drops an agent note carrying the run's oref on the chunk the run executed. Idempotent
// per run, because the seal backfill can run more than once.
func NoteRunFinished(ctx context.Context, ref waveobj.RunEffortRef, runORef, text string) error {
	if _, err := wstore.GetEffort(ctx, ref.EffortOID); err != nil {
		return err
	}
	return wstore.UpdateEffort(ctx, ref.EffortOID, func(e *waveobj.Effort) error {
		idx, err := jarvis.ResolveChunkIndex(e, ref.ChunkLabel)
		if err != nil {
			return err
		}
		for _, n := range e.Chunks[idx].Notes {
			if n.Run == runORef && strings.HasPrefix(n.Text, RunFinishedPrefix) {
				return nil
			}
		}
		return jarvis.ApplyEffortOpsAs(e, []wshrpc.EffortOp{{Op: "appendNote", Chunk: ref.ChunkLabel, Note: text}},
			"", time.Now().UnixMilli(), jarvis.NoteAuthor{Who: "agent", Run: runORef})
	})
}
