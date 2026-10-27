// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// RemoteCommands is remote mode: the phone page behind a Cloudflare tunnel (pkg/remotemode).
type RemoteCommands interface {
	RemoteStatusCommand(ctx context.Context) (*RemoteStatusData, error)
	RemoteSetupCommand(ctx context.Context, data CommandRemoteSetupData) (*RemoteStatusData, error)
	RemoteOnCommand(ctx context.Context) (*RemoteStatusData, error)
	RemoteOffCommand(ctx context.Context) (*RemoteStatusData, error)
}

// CommandRemoteSetupData: Port 0 means the default port. A re-setup replaces every field it carries.
type CommandRemoteSetupData struct {
	TunnelToken string `json:"tunneltoken"`
	Team        string `json:"team"`
	Aud         string `json:"aud"`
	Email       string `json:"email"`
	Hostname    string `json:"hostname"`
	Port        int    `json:"port,omitempty"`
}

// RemoteStatusData never carries the tunnel token. Missing lists the setup fields not stored yet;
// Tunnel is "off", "starting", "up" or "down".
type RemoteStatusData struct {
	On                 bool     `json:"on"`
	Missing            []string `json:"missing,omitempty"`
	Hostname           string   `json:"hostname,omitempty"`
	Port               int      `json:"port,omitempty"`
	Tunnel             string   `json:"tunnel"`
	TunnelError        string   `json:"tunnelerror,omitempty"`
	Subscriptions      int      `json:"subscriptions"`
	CloudflaredMissing bool     `json:"cloudflaredmissing,omitempty"`
}
