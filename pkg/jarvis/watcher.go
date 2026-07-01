// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
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

func handleAsk(ctx context.Context, data baseds.AgentAskData) {
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return
	}
	ch := ResolveGatekeeperChannel(channels, data.ORef)
	if ch == nil {
		return // not owned by any gatekeeper-enabled channel
	}
	// deterministic pre-filter: only a single single-select question is auto-answerable.
	if len(data.Questions) != 1 || data.Questions[0].MultiSelect {
		postEscalation(ch.OID, data, "needs a human (multiple or multi-select questions)")
		return
	}
	q := data.Questions[0]
	decision := Classify(ctx, ch, q, workerTaskFor(ch, data.ORef))
	if ctx.Err() != nil {
		return // cleared / cancelled mid-classification
	}
	if decision.Action == "answer" && decision.OptionIndex != nil {
		idx := *decision.OptionIndex
		if idx >= 0 && idx < len(q.Options) {
			delivered, derr := agentask.DeliverAnswer(data.ORef, []baseds.AgentAnswerItem{{SelectedIndexes: []int{idx}}})
			if derr == nil && delivered {
				postAnswered(ch.OID, q.Options[idx].Label, decision.Reason)
			}
			return
		}
	}
	postEscalation(ch.OID, data, decision.Reason)
}

func postAnswered(channelId, optionLabel, reason string) {
	text := fmt.Sprintf("Answered → %q", optionLabel)
	if reason != "" {
		text += " — " + reason
	}
	postJarvis(channelId, "jarvis-answered", text)
}

func postEscalation(channelId string, data baseds.AgentAskData, reason string) {
	var b strings.Builder
	b.WriteString("@you — your call")
	if reason != "" {
		b.WriteString(" (" + reason + ")")
	}
	b.WriteString("\n")
	if len(data.Questions) > 0 {
		q := data.Questions[0]
		b.WriteString(q.Question + "\n")
		for i, o := range q.Options {
			b.WriteString(fmt.Sprintf("  %d) %s\n", i, o.Label))
		}
	}
	postJarvis(channelId, "jarvis-escalation", strings.TrimRight(b.String(), "\n"))
}

func postJarvis(channelId, kind, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage(kind, "jarvis", text, "", time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, channelId, msg); err != nil {
		log.Printf("jarvis: post %s failed: %v", kind, err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
}
