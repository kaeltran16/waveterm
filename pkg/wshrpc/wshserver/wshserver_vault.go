// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) VaultSyncCommand(ctx context.Context, data wshrpc.CommandVaultSyncData) error {
	return wavevault.RequestSync(ctx, data.Wait)
}

func (ws *WshServer) VaultStatusCommand(ctx context.Context) (*wshrpc.VaultStatusRtnData, error) {
	st := wavevault.CurrentSyncStatus(ctx)
	return &wshrpc.VaultStatusRtnData{
		Off:              st.Off,
		RemoteURL:        st.RemoteURL,
		LastSuccessTs:    st.LastSuccessTs,
		LastError:        st.LastError,
		Running:          st.Running,
		Conflicts:        st.Conflicts,
		MalformedEfforts: st.MalformedEfforts,
	}, nil
}

func (ws *WshServer) VaultSetRemoteCommand(ctx context.Context, data wshrpc.CommandVaultSetRemoteData) error {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return fmt.Errorf("open vault: %w", err)
	}
	return v.SetRemote(ctx, data.URL)
}
