// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// durablePersistTimeout bounds one write-through. It is deliberately short: the hook runs under the
// registry lock, so a stalled store would hold up the attention poll's List() for exactly this long.
// The write is not made async because ordering is the whole point — a Set immediately followed by a
// Drop must not land as delete-then-insert and leave a row for an ask nobody is holding.
const durablePersistTimeout = 2 * time.Second

// InitDurablePendingAsks makes the pending-ask registry survive a wavesrv restart. It installs the
// write-through first and restores second, so an ask raised while the restore is running is still
// persisted — and a restored row never overwrites it (see below).
//
// Only job-backed asks come back, which is the honest limit of this feature rather than a shortcut:
// an in-process shell is a child of the wavesrv that spawned it, so a restart killed the agent and its
// question with it. Restoring that ask would put a row in the queue whose answer has nowhere to go.
func InitDurablePendingAsks(ctx context.Context) error {
	DurableHook = persistPendingAsk
	rows, err := wstore.GetPendingAsks(ctx)
	if err != nil {
		return fmt.Errorf("reading pending asks: %w", err)
	}
	restored, dropped := 0, 0
	for _, row := range rows {
		// a live entry always wins: the hook is already installed, so this oref may have been claimed
		// by a real ask raised microseconds ago. Answering the stored question instead would type
		// keystrokes for one picker into a different one.
		if _, live := GlobalRegistry.Get(row.ORef); live {
			continue
		}
		var questions []baseds.AgentAskQuestion
		if jerr := json.Unmarshal(row.Questions, &questions); jerr != nil || len(questions) == 0 {
			log.Printf("agentask: pending ask %s has unreadable questions, dropping: %v", row.ORef, jerr)
			forgetPendingAsk(ctx, row.ORef)
			dropped++
			continue
		}
		backed, running, serr := jobShell(ctx, row.BlockId)
		if serr != nil {
			// the row is left alone rather than dropped: a store read that failed once is not evidence
			// that the agent is gone, and the next boot gets another chance to decide.
			log.Printf("agentask: cannot judge pending ask %s, leaving stored: %v", row.ORef, serr)
			continue
		}
		if !backed || !running {
			forgetPendingAsk(ctx, row.ORef)
			dropped++
			continue
		}
		GlobalRegistry.Set(row.ORef, PendingAsk{
			AskId:     row.AskId,
			BlockId:   row.BlockId,
			Questions: questions,
			Ts:        row.Ts,
			Prose:     row.Prose,
		})
		restored++
	}
	log.Printf("agentask: restored %d pending ask(s), dropped %d", restored, dropped)
	return nil
}

// DurableAgentGone reports that the job manager behind a block has stopped, which retires any ask the
// block was holding. It is false for a block with no job — that is not a claim that its shell is
// alive, only that the store cannot speak to it: an in-process shell's liveness is not persisted, and
// the attention list's block-existence check is what covers those.
func DurableAgentGone(ctx context.Context, blockId string) (bool, error) {
	backed, running, err := jobShell(ctx, blockId)
	if err != nil {
		return false, err
	}
	return backed && !running, nil
}

// jobShell reports whether a block's shell is backed by a job manager and, if so, whether that manager
// is still running. Both facts come off persisted objects (Block.JobId, Job.JobManagerStatus) rather
// than off the live controller registry, which is what makes this answerable at boot: a durable block's
// controller only re-attaches once the frontend re-mounts it, long after the restore has to decide.
func jobShell(ctx context.Context, blockId string) (backed bool, running bool, err error) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return false, false, fmt.Errorf("getting block %s: %w", blockId, err)
	}
	if block == nil || block.JobId == "" {
		return false, false, nil
	}
	status, err := jobcontroller.GetJobManagerStatus(ctx, block.JobId)
	if err != nil {
		return false, false, fmt.Errorf("getting job status for block %s: %w", blockId, err)
	}
	return true, status == jobcontroller.JobManagerStatus_Running, nil
}

// persistPendingAsk is DurableHook's store-backed implementation. It builds its own context rather
// than taking one because the hook has none to take, and because one of its callers is the
// ctx.Done cleanup in AskCommand — whose context is already cancelled by the time it drops the ask.
func persistPendingAsk(oref string, pending *PendingAsk) {
	ctx, cancel := context.WithTimeout(context.Background(), durablePersistTimeout)
	defer cancel()
	// a --wait ask is not durable, and any row already under this oref has to go with it: oref is the
	// primary key, so leaving the previous ask's row behind would outlive the ask it described.
	if pending == nil || pending.Wait {
		forgetPendingAsk(ctx, oref)
		return
	}
	questions, err := json.Marshal(pending.Questions)
	if err != nil {
		log.Printf("agentask: cannot persist ask %s: %v", oref, err)
		return
	}
	row := wstore.PendingAskRow{
		ORef:      oref,
		AskId:     pending.AskId,
		BlockId:   pending.BlockId,
		Ts:        pending.Ts,
		Prose:     pending.Prose,
		Questions: questions,
	}
	if err := wstore.PutPendingAsk(ctx, row); err != nil {
		log.Printf("agentask: cannot persist ask %s: %v", oref, err)
	}
}

func forgetPendingAsk(ctx context.Context, oref string) {
	if err := wstore.DeletePendingAsk(ctx, oref); err != nil {
		log.Printf("agentask: cannot forget ask %s: %v", oref, err)
	}
}
