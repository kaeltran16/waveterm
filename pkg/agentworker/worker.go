// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentworker runs workers an agent starts with `wsh agents start`: ordinary agent tabs nested under their
// parent's tab, which stop after a turn and resume on a message.
package agentworker

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// A worker's state lives in meta, so no waveobj type is added. The frontend reads MetaParentTab as a literal.
const (
	// MetaParentTab is tab meta: the parent's tab id. Only a worker's tab has it.
	MetaParentTab = "agent:parenttab"
	// MetaSessionId is block meta: the session its launch named, which a resume names again.
	MetaSessionId = "agent:sessionid"
	// MetaNoticeOwed is block meta: the running or last turn was the parent's and is not yet noticed.
	MetaNoticeOwed = "agent:noticeowed"
	// MetaNoticeHeld is block meta: the notice is due but the parent had no process to receive it.
	MetaNoticeHeld = "agent:noticeheld"
)

const (
	metaTabHarness = "session:agent"
	// dbTimeout bounds one store read or write made outside a caller's context.
	dbTimeout = 10 * time.Second
)

// ParentOf is the tab id of tab's parent, "" for a tab that is not a worker.
func ParentOf(tab *waveobj.Tab) string {
	if tab == nil {
		return ""
	}
	return tab.Meta.GetString(MetaParentTab, "")
}

// SetNoticeOwed records whether the block's latest turn is the parent's and still unnoticed.
func SetNoticeOwed(ctx context.Context, blockId string, owed bool) error {
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
	_, err := wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{MetaNoticeOwed: owed}, false)
	return err
}

// Admit asks the memory gate for a worker started in cwd, without waiting: a refusal is an error that says how much
// memory is free, what the worker needs and who holds the rest, and leaves no claim. A worker is sized on the same
// learned peaks as a run's worker in the same project, and the loop may pause it.
func Admit(cwd, tabId string) (*memgate.Claim, error) {
	claim, why := memgate.TryAdmitOrWhy(memgate.Request{
		Key: memgate.Key{Project: orchestrate.MemProjectKey(cwd), Role: memgate.RoleWorker},
		Tag: memgate.Tag{Role: memgate.RoleWorker, TabId: tabId},
	})
	if why != nil {
		return nil, shortError(why)
	}
	return claim, nil
}

func shortError(s *memgate.Shortfall) error {
	var b strings.Builder
	fmt.Fprintf(&b, "memory is short: %s free, the worker needs %s", gigabytes(s.Free), gigabytes(s.Need))
	if len(s.Holders) == 0 {
		return fmt.Errorf("%s", b.String())
	}
	holders := make([]string, len(s.Holders))
	for i, h := range s.Holders {
		holders[i] = fmt.Sprintf("%s (%s)", holderName(h.Tag), gigabytes(h.Use))
	}
	fmt.Fprintf(&b, "; held by %s", strings.Join(holders, ", "))
	return fmt.Errorf("%s", b.String())
}

func holderName(t memgate.Tag) string {
	if t.RunId != "" {
		return fmt.Sprintf("run %s task %s", t.RunId, t.TaskId)
	}
	if t.TabId != "" {
		return fmt.Sprintf("%s %s", t.Role, t.TabId)
	}
	return t.Role
}

// gigabytes words n for a refusal. free reads as unlimited when the gate cannot read memory, which never refuses.
func gigabytes(n uint64) string {
	return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
}

// Bind ties the claim to the block's job, so the loop follows its use and releases it at the job's close. The claim
// learns when the worker's prompt cache expires, so a pause ends before then.
func Bind(c *memgate.Claim, blockId string) {
	if c == nil || blockId == "" {
		return
	}
	c.SetCacheExpiry(func() (time.Time, bool) { return blockCacheExpiry(blockId) })
	c.Bind(jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: blockId})
}

// blockCacheExpiry is the block's last transcript write plus the prompt cache's lifetime. False while the block has
// reported no transcript or none is written, so the gate does not pause a worker whose cache it cannot place.
func blockCacheExpiry(blockId string) (time.Time, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		return time.Time{}, false
	}
	written, ok := lastTranscriptWrite(block)
	if !ok {
		return time.Time{}, false
	}
	return written.Add(orchestrate.WorkerCacheTTL), true
}

// lastTranscriptWrite is when the block's agent last wrote its transcript. False while the block has reported no
// transcript or none is written.
func lastTranscriptWrite(block *waveobj.Block) (time.Time, bool) {
	path := block.Meta.GetString(waveobj.MetaKey_AgentTranscriptPath, "")
	if path == "" {
		return time.Time{}, false
	}
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}, false
	}
	return info.ModTime(), true
}

// PublishStatus publishes the retained agent:status the roster keys off, as of at, with the block's harness (its tab's
// session:agent), cwd and transcript path as stored. A stopped worker publishes idle so the roster still lists it.
func PublishStatus(ctx context.Context, blockId, state string, at time.Time) error {
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return fmt.Errorf("loading worker block %s: %w", blockId, err)
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return fmt.Errorf("finding the tab of block %s: %w", blockId, err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return fmt.Errorf("loading worker tab %s: %w", tabId, err)
	}
	ev := blockcontroller.AgentStatusEvent(blockId, state, tab.Meta.GetString(metaTabHarness, ""), at.UnixMilli())
	data := ev.Data.(baseds.AgentStatusData)
	data.Cwd = block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	data.TranscriptPath = block.Meta.GetString(waveobj.MetaKey_AgentTranscriptPath, "")
	ev.Data = data
	wps.Broker.Publish(ev)
	return nil
}
