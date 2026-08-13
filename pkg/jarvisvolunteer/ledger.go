// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisstate"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// shippedWindowMs is how far back a completed run still counts as "shipped". Same 7-day window the
// landing briefing uses for its Shipped section.
const shippedWindowMs int64 = 7 * 24 * 60 * 60 * 1000

// snippetMax bounds an evidence summary before it reaches the judge prompt: the judge only needs the gist.
const snippetMax = 140

// LedgerProducer volunteers the state of the operator's work: runs shipped in the last 7 days and
// attention items waiting on the human. Tier-gated on the trigger channel (concierge stays silent),
// reading only the two ledger legs it needs and reusing jarvisstate.Shipped as the single source of
// truth for "what counts as shipped".
type LedgerProducer struct {
	loadChannel     func(ctx context.Context, channelID string) (*waveobj.Channel, error)
	getRuns         func(ctx context.Context, channelID string) ([]*waveobj.Run, error)
	gatherAttention func(ctx context.Context) ([]wshrpc.AttentionItem, error)
	now             func() int64
}

func NewLedgerProducer() *LedgerProducer {
	return &LedgerProducer{
		loadChannel:     liveChannel,
		getRuns:         wstore.GetChannelRuns,
		gatherAttention: jarvis.GatherAttention,
		now:             func() int64 { return time.Now().UnixMilli() },
	}
}

// liveChannel finds one channel by id. There is no GetChannel-by-id; the scan mirrors
// jarvisstate/fetch.go's fetchSeams.getChannels pattern.
func liveChannel(ctx context.Context, channelID string) (*waveobj.Channel, error) {
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: listing channels: %w", err)
	}
	for _, ch := range chans {
		if ch.OID == channelID {
			return ch, nil
		}
	}
	return nil, nil
}

func (p *LedgerProducer) Name() string { return ClassLedger }

func (p *LedgerProducer) Candidates(ctx context.Context, t *Trigger) ([]Candidate, error) {
	if t == nil || t.ChannelID == "" {
		return nil, nil // run-scoped: only run-created/run-rest triggers carry a channel
	}
	ch, err := p.loadChannel(ctx, t.ChannelID)
	if err != nil {
		return nil, err
	}
	if ch == nil ||
		(!ch.Meta.GetBool(jarvis.MetaKey_GatekeeperEnabled, false) &&
			!ch.Meta.GetBool(jarvis.MetaKey_DelegatorEnabled, false)) {
		return nil, nil // the ladder's volume knob: concierge channels stay quiet about ledger facts
	}
	runs, err := p.getRuns(ctx, t.ChannelID)
	if err != nil {
		return nil, err
	}
	now := p.now()
	var out []Candidate
	for _, s := range jarvisstate.Shipped(runs, now-shippedWindowMs) {
		if s.CompletedTs == 0 {
			continue // undatable: the watermark could never order it
		}
		out = append(out, Candidate{
			Class:      ClassLedger,
			ID:         "shipped:" + s.RunOID,
			At:         s.CompletedTs,
			Title:      "shipped: " + s.Goal,
			Snippet:    utilfn.EllipsisStr(s.Summary, snippetMax),
			SourceType: "run",
			SourceRef:  "run:" + s.RunOID,
		})
	}
	attention, err := p.gatherAttention(ctx)
	if err != nil {
		return nil, err
	}
	runByID := make(map[string]bool, len(runs))
	for _, r := range runs {
		runByID[r.OID] = true
	}
	for _, a := range attention {
		if !runByID[a.RunId] || a.WaitingSince == 0 {
			continue // not this channel's business, or undatable
		}
		out = append(out, Candidate{
			Class:      ClassLedger,
			ID:         "attention:" + a.RunId,
			At:         a.WaitingSince,
			Title:      "needs-you: " + a.Source,
			Snippet:    a.Action + ": " + a.Text,
			SourceType: "run",
			SourceRef:  "run:" + a.RunId,
		})
	}
	// freshest first: prefilter keeps the first 5 unique ids across producers, so recency here decides
	// which ledger facts even compete
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out, nil
}
