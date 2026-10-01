// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// VaultCommands is the vault sync surface: trigger a sync, read its status, set the git remote.
type VaultCommands interface {
	VaultSyncCommand(ctx context.Context, data CommandVaultSyncData) error
	VaultStatusCommand(ctx context.Context) (*VaultStatusRtnData, error)
	VaultSetRemoteCommand(ctx context.Context, data CommandVaultSetRemoteData) error
}

// CommandVaultSyncData: Wait blocks until the triggered sync finishes and returns its error; the
// caller then needs an RPC timeout longer than a sync.
type CommandVaultSyncData struct {
	Wait bool `json:"wait,omitempty"`
}

type CommandVaultSetRemoteData struct {
	URL string `json:"url"` // "" removes origin, turning sync off
}

// VaultStatusRtnData: Off is "" when sync is on, else "no-git" or "no-remote". LastSuccessTs is unix ms.
type VaultStatusRtnData struct {
	Off              string   `json:"off,omitempty"`
	RemoteURL        string   `json:"remoteurl,omitempty"`
	LastSuccessTs    int64    `json:"lastsuccessts,omitempty"`
	LastError        string   `json:"lasterror,omitempty"`
	Running          bool     `json:"running,omitempty"`
	Conflicts        []string `json:"conflicts,omitempty"`
	MalformedEfforts []string `json:"malformedefforts,omitempty"`
}
