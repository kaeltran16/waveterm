// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentctl

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// how a held message left the mod's queue, as its report names it
const (
	LeftJoined    = "joined"    // read at a tool result
	LeftSent      = "sent"      // sent as a prompt at the turn's end
	LeftTakenBack = "takenback" // handed back to the box by a take-back
)

// TakeBackWait bounds a take-back's wait for the mod's answer; it stays under wshrpc's 5s default so the
// caller hears this error rather than a bare timeout.
const TakeBackWait = 4 * time.Second

// Left is a held message that left the mod's queue, and how.
type Left struct {
	Id  string
	How string
}

// blockQueue is what a block's mod last reported holding, and the take-backs waiting on its answer.
type blockQueue struct {
	held  []baseds.QueuedPrompt
	waits map[string]chan []baseds.QueuedPrompt
}

var (
	// taken after lock when both are held: a stream's close settles its queue under lock
	queueLock sync.Mutex
	queues    = make(map[string]*blockQueue)
)

func queueOf(blockId string) *blockQueue {
	q := queues[blockId]
	if q == nil {
		q = &blockQueue{waits: make(map[string]chan []baseds.QueuedPrompt)}
		queues[blockId] = q
	}
	return q
}

// Report takes the mod's whole held list for blockId and the ids that left since its last report. A held
// item missing with no left entry is lost. takeBack names the take-back request the report answers; one no
// longer awaited is refused whole, so the mod keeps those items held and reports them again.
func Report(blockId string, held []baseds.QueuedPrompt, left []Left, takeBack string) error {
	leftHow := make(map[string]string, len(left))
	for _, l := range left {
		if l.How != LeftJoined && l.How != LeftSent && l.How != LeftTakenBack {
			return fmt.Errorf("queue report for block %s: message %s left by %q, want %s, %s or %s", blockId, l.Id, l.How, LeftJoined, LeftSent, LeftTakenBack)
		}
		leftHow[l.Id] = l.How
	}
	queueLock.Lock()
	defer queueLock.Unlock()
	q := queueOf(blockId)
	var wait chan []baseds.QueuedPrompt
	if takeBack != "" {
		wait = q.waits[takeBack]
		if wait == nil {
			return fmt.Errorf("queue report for block %s answers take-back %s, which is no longer awaited: keep the messages held", blockId, takeBack)
		}
		delete(q.waits, takeBack)
	}
	var lost, takenBack []baseds.QueuedPrompt
	for _, p := range q.held {
		if slices.ContainsFunc(held, func(h baseds.QueuedPrompt) bool { return h.Id == p.Id }) {
			continue
		}
		switch how, ok := leftHow[p.Id]; {
		case !ok:
			lost = append(lost, p)
		case how == LeftTakenBack:
			takenBack = append(takenBack, p)
		}
	}
	q.held = slices.Clone(held)
	publishQueue(blockId, q.held, lost)
	if wait != nil {
		wait <- takenBack
	}
	return nil
}

// endQueue loses everything blockId's mod held: its stream ended and no newer one took its place.
func endQueue(blockId string) {
	queueLock.Lock()
	defer queueLock.Unlock()
	q := queues[blockId]
	if q == nil {
		return
	}
	held := q.held
	q.held = nil
	if len(q.waits) == 0 {
		delete(queues, blockId)
	}
	if len(held) > 0 {
		publishQueue(blockId, nil, held)
	}
}

func publishQueue(blockId string, held, lost []baseds.QueuedPrompt) {
	if held == nil {
		held = []baseds.QueuedPrompt{}
	}
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
	wps.Broker.Publish(wps.WaveEvent{
		Event:   wps.Event_AgentQueue,
		Scopes:  []string{oref},
		Persist: 1,
		Data:    baseds.AgentQueueData{ORef: oref, Held: held, Lost: lost},
	})
}

// TakeBack asks blockId's mod for every message it holds for the person and returns them in the order they
// were sent. It waits for the report naming the request until ctx ends or TakeBackWait passes, whichever is
// first; past that the held list stays as it is.
func TakeBack(ctx context.Context, blockId string) ([]baseds.QueuedPrompt, error) {
	if !Has(blockId) {
		return nil, fmt.Errorf("block %s has no mod stream to take queued messages back from", blockId)
	}
	reqId := uuid.NewString()
	wait := make(chan []baseds.QueuedPrompt, 1)
	queueLock.Lock()
	queueOf(blockId).waits[reqId] = wait
	queueLock.Unlock()
	if !Send(blockId, Msg{TakeBack: reqId}) {
		dropWait(blockId, reqId)
		return nil, fmt.Errorf("block %s's mod stream did not take the take-back request", blockId)
	}
	ctx, cancel := context.WithTimeout(ctx, TakeBackWait)
	defer cancel()
	select {
	case items := <-wait:
		return items, nil
	case <-ctx.Done():
	}
	if !dropWait(blockId, reqId) {
		// the answer landed as the wait ended: Report has already sent it
		return <-wait, nil
	}
	reason := ctx.Err()
	if errors.Is(reason, context.DeadlineExceeded) {
		reason = errors.New("no answer in time")
	}
	return nil, fmt.Errorf("block %s's mod did not hand back its queued messages: %w", blockId, reason)
}

// dropWait stops awaiting reqId and reports whether it was still awaited.
func dropWait(blockId, reqId string) bool {
	queueLock.Lock()
	defer queueLock.Unlock()
	q := queues[blockId]
	if q == nil || q.waits[reqId] == nil {
		return false
	}
	delete(q.waits, reqId)
	return true
}
