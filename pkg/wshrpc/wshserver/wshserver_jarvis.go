// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisrecall"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func (ws *WshServer) GetJarvisProfileCommand(ctx context.Context, data wshrpc.CommandGetJarvisProfileData) (*wshrpc.CommandGetJarvisProfileRtnData, error) {
	if data.ChannelId == "" {
		return nil, fmt.Errorf("channelid is required")
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return nil, fmt.Errorf("loading channel: %w", err)
	}
	global := jarvis.LoadGlobalProfile()
	override := jarvis.OverrideFromMeta(ch)
	resolved, diagnostics := jarvis.ResolveProfileWithDiagnostics(global, override)
	// surface the override as a structured patch view (a legacy string becomes disable-all + one
	// legacy-project addition) so the FE never has to reason about the legacy marker.
	if override != nil && override.Principles != nil {
		normalized := *override
		normalized.Principles = jarvis.NormalizePrinciplePatch(global.Principles, override.Principles)
		override = &normalized
	}
	return &wshrpc.CommandGetJarvisProfileRtnData{
		Global:               global,
		Override:             override,
		Resolved:             resolved,
		PrincipleDiagnostics: diagnostics,
	}, nil
}

func (ws *WshServer) GetGlobalProfileCommand(ctx context.Context) (*waveobj.JarvisProfile, error) {
	profile := jarvis.LoadGlobalProfile()
	return &profile, nil
}

func (ws *WshServer) SetGlobalProfileCommand(ctx context.Context, data wshrpc.CommandSetGlobalProfileData) error {
	return jarvis.SaveGlobalProfile(data.Profile)
}

func (ws *WshServer) JarvisDecomposeCommand(ctx context.Context, data wshrpc.CommandJarvisDecomposeData) (*wshrpc.CommandJarvisDecomposeRtnData, error) {
	if strings.TrimSpace(data.Goal) == "" {
		return nil, fmt.Errorf("goal is required")
	}
	var channel *waveobj.Channel
	projectPath := ""
	if data.ChannelId != "" {
		if ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId); err == nil {
			channel = ch
			projectPath = ch.ProjectPath
		}
	}
	subtasks := jarvis.Decompose(ctx, projectPath, data.Goal, channel)
	return &wshrpc.CommandJarvisDecomposeRtnData{Subtasks: subtasks}, nil
}

const consultTimeout = 120 * time.Second

// postConsultReply persists a consult-reply message and live-updates the pinned channel atom. Mirrors
// PostChannelMessageCommand's post+update pattern for the fire-and-forget consult goroutine. It runs on
// a fresh context, not the RPC request ctx: the request ctx is routinely already cancelled/expired by
// the time a slow consult finishes, and the persisted reply is exactly what lets the FE card resolve,
// so the write must not be tied to the request lifecycle.
func postConsultReply(data wshrpc.CommandConsultData, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("consult-reply", data.Runtime, text, "consult:"+data.ConsultId, time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg); err != nil {
		log.Printf("consult: failed to post reply: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
}

func (ws *WshServer) ConsultCommand(ctx context.Context, data wshrpc.CommandConsultData) chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("ConsultCommand", recover())
		}()
		defer close(rtn)
		ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Error: fmt.Errorf("channel not found: %w", err)}
			return
		}
		spec, ok := consult.SpecFor(data.Runtime)
		if !ok {
			postConsultReply(data, "consult is not supported for @"+data.Runtime)
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Error: fmt.Errorf("unsupported runtime: %s", data.Runtime)}
			return
		}
		// claude discovers ~/.claude/CLAUDE.md itself (it runs with cwd = project path); other runtimes
		// don't, so inject the operator's global principles for them. a read failure must not fail the
		// consult — log and continue with none.
		var principles string
		if data.Runtime != "claude" {
			p, perr := consult.OperatorPrinciples()
			if perr != nil {
				log.Printf("consult: reading operator principles: %v", perr)
			}
			principles = p
		}
		prompt := consult.BuildPrompt(ch.Messages, data.Prompt, principles)
		runCtx, cancel := context.WithTimeout(ctx, consultTimeout)
		defer cancel()
		full, runErr := consult.Run(runCtx, spec, ch.ProjectPath, prompt, func(chunk string) {
			// live streaming is best-effort: never let a stalled/absent stream consumer wedge Run
			// (the persisted consult-reply below is the reliable path the FE resolves on).
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Response: wshrpc.ConsultChunk{Text: chunk}}:
			case <-runCtx.Done():
			}
		})
		reply := strings.TrimSpace(full)
		if runErr != nil {
			if reply != "" {
				reply += "\n\n"
			}
			reply += "consult failed: " + runErr.Error()
		}
		postConsultReply(data, reply)
	}()
	return rtn
}

// postJarvisReply persists the jarvis-reply message and live-updates the pinned channel atom. Mirrors
// postConsultReply (fresh context, not the RPC request ctx, since a slow summary routinely outlives it).
func postJarvisReply(data wshrpc.CommandJarvisData, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("jarvis-reply", "jarvis", text, "jarvis:"+data.RequestId, time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg); err != nil {
		log.Printf("jarvis: failed to post reply: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
}

func (ws *WshServer) JarvisCommand(ctx context.Context, data wshrpc.CommandJarvisData) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("JarvisCommand", recover())
		}()
		defer close(rtn)
		ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Error: fmt.Errorf("channel not found: %w", err)}
			return
		}
		spec, ok := consult.SpecFor("claude")
		if !ok {
			postJarvisReply(data, "jarvis requires the claude CLI, which is not available")
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Error: fmt.Errorf("claude runtime unavailable")}
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, consultTimeout)
		defer cancel()
		full, runErr := consult.Run(runCtx, spec, ch.ProjectPath, data.Prompt, func(chunk string) {
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Response: wshrpc.JarvisChunk{Text: chunk}}:
			case <-runCtx.Done():
			}
		})
		reply := strings.TrimSpace(full)
		if runErr != nil {
			if reply != "" {
				reply += "\n\n"
			}
			reply += "jarvis failed: " + runErr.Error()
		}
		postJarvisReply(data, reply)
	}()
	return rtn
}

func (ws *WshServer) JarvisConverseCommand(ctx context.Context, data wshrpc.CommandJarvisConverseData) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("JarvisConverseCommand", recover())
		}()
		defer close(rtn)
		emit := func(chunk wshrpc.JarvisConverseChunk) {
			// live streaming is best-effort: never let a stalled consumer wedge the pipeline.
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Response: chunk}:
			case <-ctx.Done():
			}
		}
		if err := jarvisrecall.Converse(ctx, data, emit); err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Error: err}
		}
	}()
	return rtn
}

func (ws *WshServer) ListConsultRuntimesCommand(ctx context.Context) (*wshrpc.CommandListConsultRuntimesRtnData, error) {
	var infos []wshrpc.ConsultRuntimeInfo
	for _, rt := range consult.SupportedRuntimes() {
		installed, version := consult.ProbeInstalled(ctx, rt)
		infos = append(infos, wshrpc.ConsultRuntimeInfo{Runtime: rt, Installed: installed, Version: version})
	}
	return &wshrpc.CommandListConsultRuntimesRtnData{Runtimes: infos}, nil
}
