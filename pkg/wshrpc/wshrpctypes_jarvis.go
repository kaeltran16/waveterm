// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type JarvisCommands interface {
	ConsultCommand(ctx context.Context, data CommandConsultData) chan RespOrErrorUnion[ConsultChunk]                        // one-shot headless CLI consult; streams reply chunks, posts a consult-reply on completion
	JarvisCommand(ctx context.Context, data CommandJarvisData) chan RespOrErrorUnion[JarvisChunk]                           // Jarvis (observe-only manager): headless claude summary of a channel's fleet; streams chunks, posts a jarvis-reply on completion
	JarvisDecomposeCommand(ctx context.Context, data CommandJarvisDecomposeData) (*CommandJarvisDecomposeRtnData, error)    // decompose a goal into independent parallel subtasks (Delegator fan-out); fails safe to [goal]
	GetJarvisProfileCommand(ctx context.Context, data CommandGetJarvisProfileData) (*CommandGetJarvisProfileRtnData, error) // read a channel's Jarvis profile (global + per-project override + resolved)
	GetGlobalProfileCommand(ctx context.Context) (*waveobj.JarvisProfile, error)                                            // read the global Jarvis profile (builtins if unset)
	SetGlobalProfileCommand(ctx context.Context, data CommandSetGlobalProfileData) error                                    // write the global Jarvis profile to jarvis-profile.json
	ListConsultRuntimesCommand(ctx context.Context) (*CommandListConsultRuntimesRtnData, error)
}

type CommandJarvisDecomposeData struct {
	ChannelId string `json:"channelid"`
	Goal      string `json:"goal"`
}

type CommandJarvisDecomposeRtnData struct {
	Subtasks []string `json:"subtasks"`
}

type CommandGetJarvisProfileData struct {
	ChannelId string `json:"channelid"`
}

type CommandGetJarvisProfileRtnData struct {
	Global               waveobj.JarvisProfile         `json:"global"`
	Override             *waveobj.ProfileOverride      `json:"override"`
	Resolved             waveobj.JarvisProfile         `json:"resolved"`
	PrincipleDiagnostics []waveobj.PrincipleDiagnostic `json:"principlediagnostics,omitempty"`
}

type CommandSetGlobalProfileData struct {
	Profile waveobj.JarvisProfile `json:"profile"`
}

type CommandConsultData struct {
	ChannelId string `json:"channelid"`
	Runtime   string `json:"runtime"`
	Prompt    string `json:"prompt"`
	ConsultId string `json:"consultid"`
}

type ConsultChunk struct {
	Text string `json:"text"`
}

type CommandJarvisData struct {
	ChannelId string `json:"channelid"`
	Prompt    string `json:"prompt"`
	RequestId string `json:"requestid"`
}

type JarvisChunk struct {
	Text string `json:"text"`
}

type CommandListConsultRuntimesRtnData struct {
	Runtimes []ConsultRuntimeInfo `json:"runtimes"`
}
