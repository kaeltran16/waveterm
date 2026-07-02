// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var (
	inflightLock sync.Mutex
	inflight     = map[string]context.CancelFunc{} // askId -> cancel
)

// OnAgentAsk is the server-side Gatekeeper entry point, called from publishAgentAsk for every ask
// and clear. It never blocks the publish path: real work runs in a goroutine. A Cleared event
// cancels any in-flight classification for that AskId.
func OnAgentAsk(data baseds.AgentAskData) {
	if data.Cleared {
		cancelInflight(data.AskId)
		return
	}
	if data.AskId == "" || data.ORef == "" {
		return
	}
	inflightLock.Lock()
	if _, dup := inflight[data.AskId]; dup {
		inflightLock.Unlock()
		return // the persisted event re-delivered; already handling
	}
	ctx, cancel := context.WithCancel(context.Background())
	inflight[data.AskId] = cancel
	inflightLock.Unlock()
	go func() {
		defer func() { panichandler.PanicHandler("jarvis.OnAgentAsk", recover()) }()
		defer cancelInflight(data.AskId)
		handleAsk(ctx, data)
	}()
}

func cancelInflight(askId string) {
	inflightLock.Lock()
	defer inflightLock.Unlock()
	if cancel, ok := inflight[askId]; ok {
		cancel()
		delete(inflight, askId)
	}
}

// channelOwnerORef maps an asking oref to the oref a channel dispatch would reference for that
// worker. Asks fire from the worker's terminal block ("block:<id>"), but a channel dispatch records
// the worker's TAB oref ("tab:<id>"), so a block-scoped ask must be walked up to its tab before
// ownership resolution. Non-block orefs (or any lookup failure) pass through unchanged — fail-safe:
// a bad mapping just means no channel matches, never a wrong one.
func channelOwnerORef(ctx context.Context, askingORef string) string {
	oref, err := waveobj.ParseORef(askingORef)
	if err != nil || oref.OType != waveobj.OType_Block {
		return askingORef
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, oref.OID)
	if err != nil || tabId == "" {
		return askingORef
	}
	return waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
}

func handleAsk(ctx context.Context, data baseds.AgentAskData) {
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return
	}
	ownerORef := channelOwnerORef(ctx, data.ORef)
	ch := ResolveGatekeeperChannel(channels, ownerORef)
	if ch == nil {
		return // not owned by any gatekeeper-enabled channel
	}
	// deterministic pre-filter: only a single single-select question is auto-answerable.
	if len(data.Questions) != 1 || data.Questions[0].MultiSelect {
		postEscalation(ch.OID, data, "needs a human (multiple or multi-select questions)", ownerORef)
		return
	}
	q := data.Questions[0]
	decision := Classify(ctx, ch, q, workerTaskFor(ch, ownerORef))
	if ctx.Err() != nil {
		return // cleared / cancelled mid-classification
	}
	if decision.Action == "answer" && decision.OptionIndex != nil {
		idx := *decision.OptionIndex
		if idx >= 0 && idx < len(q.Options) {
			delivered, derr := agentask.DeliverAnswer(data.ORef, []baseds.AgentAnswerItem{{SelectedIndexes: []int{idx}}})
			if derr == nil && delivered {
				postAnswered(ch.OID, q, idx, decision.Reason, data.ORef, ownerORef)
			}
			return
		}
	}
	postEscalation(ch.OID, data, decision.Reason, ownerORef)
}

func postAnswered(channelId string, q baseds.AgentAskQuestion, choiceIdx int, reason, askORef, workerORef string) {
	text := fmt.Sprintf("Answered → %q", q.Options[choiceIdx].Label)
	if reason != "" {
		text += " — " + reason
	}
	data, _ := json.Marshal(BuildCardData(q, &choiceIdx, reason, askORef, workerORef))
	postJarvisData(channelId, "jarvis-answered", text, string(data))
}

func postEscalation(channelId string, data baseds.AgentAskData, reason, workerORef string) {
	var b strings.Builder
	b.WriteString("@you — your call")
	if reason != "" {
		b.WriteString(" (" + reason + ")")
	}
	b.WriteString("\n")
	var payload string
	if len(data.Questions) > 0 {
		q := data.Questions[0]
		b.WriteString(q.Question + "\n")
		for i, o := range q.Options {
			b.WriteString(fmt.Sprintf("  %d) %s\n", i, o.Label))
		}
		j, _ := json.Marshal(BuildCardData(q, nil, reason, data.ORef, workerORef))
		payload = string(j)
	}
	postJarvisData(channelId, "jarvis-escalation", strings.TrimRight(b.String(), "\n"), payload)
}

func postJarvis(channelId, kind, text string) {
	postJarvisData(channelId, kind, text, "")
}

func postJarvisData(channelId, kind, text, data string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage(kind, "jarvis", text, "", time.Now().UnixMilli())
	msg.Data = data
	if _, err := wstore.PostChannelMessage(ctx, channelId, msg); err != nil {
		log.Printf("jarvis: post %s failed: %v", kind, err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
}
