// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

type ConnCommands interface {
	// connection functions
	ConnStatusCommand(ctx context.Context) ([]ConnStatus, error)
	WslStatusCommand(ctx context.Context) ([]ConnStatus, error)
	ConnEnsureCommand(ctx context.Context, data ConnExtData) error
	ConnReinstallWshCommand(ctx context.Context, data ConnExtData) error
	ConnConnectCommand(ctx context.Context, connRequest ConnRequest) error
	ConnDisconnectCommand(ctx context.Context, connName string) error
	ConnListCommand(ctx context.Context) ([]string, error)
	WslListCommand(ctx context.Context) ([]string, error)
	WslDefaultDistroCommand(ctx context.Context) (string, error)
	ConnUpdateWshCommand(ctx context.Context, remoteInfo RemoteInfo) (bool, error)
	FindGitBashCommand(ctx context.Context, rescan bool) (string, error)
	ConnServerInitCommand(ctx context.Context, data CommandConnServerInitData) error
}

type ConnRequest struct {
	Host       string               `json:"host"`
	Keywords   wconfig.ConnKeywords `json:"keywords,omitempty"`
	LogBlockId string               `json:"logblockid,omitempty"`
}

type RemoteInfo struct {
	ClientArch    string `json:"clientarch"`
	ClientOs      string `json:"clientos"`
	ClientVersion string `json:"clientversion"`
	Shell         string `json:"shell"`
	HomeDir       string `json:"homedir"`
}

type ConnStatus struct {
	Status                        string `json:"status"`
	ConnHealthStatus              string `json:"connhealthstatus,omitempty"`
	WshEnabled                    bool   `json:"wshenabled"`
	Connection                    string `json:"connection"`
	Connected                     bool   `json:"connected"`
	HasConnected                  bool   `json:"hasconnected"` // true if it has *ever* connected successfully
	ActiveConnNum                 int    `json:"activeconnnum"`
	Error                         string `json:"error,omitempty"`
	WshError                      string `json:"wsherror,omitempty"`
	NoWshReason                   string `json:"nowshreason,omitempty"`
	WshVersion                    string `json:"wshversion,omitempty"`
	LastActivityBeforeStalledTime int64  `json:"lastactivitybeforestalledtime,omitempty"`
	KeepAliveSentTime             int64  `json:"keepalivesenttime,omitempty"`
}

type ConnExtData struct {
	ConnName   string `json:"connname"`
	LogBlockId string `json:"logblockid,omitempty"`
}

type CommandConnServerInitData struct {
	ClientId string `json:"clientid"`
}
