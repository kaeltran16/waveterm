// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/genconn"
	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wsl"
	"github.com/wavetermdev/waveterm/pkg/wslconn"
)

var InvalidWslDistroNames = []string{"docker-desktop", "docker-desktop-data"}

func (ws *WshServer) ConnStatusCommand(ctx context.Context) ([]wshrpc.ConnStatus, error) {
	rtn := conncontroller.GetAllConnStatus()
	return rtn, nil
}

func (ws *WshServer) WslStatusCommand(ctx context.Context) ([]wshrpc.ConnStatus, error) {
	rtn := wslconn.GetAllConnStatus()
	return rtn, nil
}

func (ws *WshServer) ConnEnsureCommand(ctx context.Context, data wshrpc.ConnExtData) error {
	ctx = genconn.ContextWithConnData(ctx, data.LogBlockId)
	ctx = termCtxWithLogBlockId(ctx, data.LogBlockId)
	if strings.HasPrefix(data.ConnName, "wsl://") {
		distroName := strings.TrimPrefix(data.ConnName, "wsl://")
		return wslconn.EnsureConnection(ctx, distroName)
	}
	return conncontroller.EnsureConnection(ctx, data.ConnName)
}

func (ws *WshServer) ConnDisconnectCommand(ctx context.Context, connName string) error {
	if conncontroller.IsLocalConnName(connName) {
		return nil
	}
	if strings.HasPrefix(connName, "wsl://") {
		distroName := strings.TrimPrefix(connName, "wsl://")
		conn := wslconn.GetWslConn(distroName)
		if conn == nil {
			return fmt.Errorf("distro not found: %s", connName)
		}
		return conn.Close()
	}
	connOpts, err := remote.ParseOpts(connName)
	if err != nil {
		return fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.MaybeGetConn(connOpts)
	if conn == nil {
		return fmt.Errorf("connection not found: %s", connName)
	}
	return conn.Close()
}

func (ws *WshServer) ConnConnectCommand(ctx context.Context, connRequest wshrpc.ConnRequest) error {
	if conncontroller.IsLocalConnName(connRequest.Host) {
		return nil
	}
	ctx = genconn.ContextWithConnData(ctx, connRequest.LogBlockId)
	ctx = termCtxWithLogBlockId(ctx, connRequest.LogBlockId)
	connName := connRequest.Host
	if strings.HasPrefix(connName, "wsl://") {
		distroName := strings.TrimPrefix(connName, "wsl://")
		conn := wslconn.GetWslConn(distroName)
		if conn == nil {
			return fmt.Errorf("connection not found: %s", connName)
		}
		return conn.Connect(ctx)
	}
	connOpts, err := remote.ParseOpts(connName)
	if err != nil {
		return fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.GetConn(connOpts)
	if conn == nil {
		return fmt.Errorf("connection not found: %s", connName)
	}
	return conn.Connect(ctx, &connRequest.Keywords)
}

func (ws *WshServer) ConnReinstallWshCommand(ctx context.Context, data wshrpc.ConnExtData) error {
	if conncontroller.IsLocalConnName(data.ConnName) {
		return nil
	}
	ctx = genconn.ContextWithConnData(ctx, data.LogBlockId)
	ctx = termCtxWithLogBlockId(ctx, data.LogBlockId)
	connName := data.ConnName
	if strings.HasPrefix(connName, "wsl://") {
		distroName := strings.TrimPrefix(connName, "wsl://")
		conn := wslconn.GetWslConn(distroName)
		if conn == nil {
			return fmt.Errorf("connection not found: %s", connName)
		}
		return conn.InstallWsh(ctx, "")
	}
	connOpts, err := remote.ParseOpts(connName)
	if err != nil {
		return fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.GetConn(connOpts)
	if conn == nil {
		return fmt.Errorf("connection not found: %s", connName)
	}
	return conn.InstallWsh(ctx, "")
}

func (ws *WshServer) ConnUpdateWshCommand(ctx context.Context, remoteInfo wshrpc.RemoteInfo) (bool, error) {
	handler := wshutil.GetRpcResponseHandlerFromContext(ctx)
	if handler == nil {
		return false, fmt.Errorf("could not determine handler from context")
	}
	connName := handler.GetRpcContext().Conn
	if connName == "" {
		return false, fmt.Errorf("invalid remote info: missing connection name")
	}

	log.Printf("checking wsh version for connection %s (current: %s)", connName, remoteInfo.ClientVersion)
	upToDate, _, _, err := conncontroller.IsWshVersionUpToDate(ctx, remoteInfo.ClientVersion)
	if err != nil {
		return false, fmt.Errorf("unable to compare wsh version: %w", err)
	}
	if upToDate {
		// no need to update
		log.Printf("wsh is already up to date for connection %s", connName)
		return false, nil
	}

	// todo: need to add user input code here for validation

	if strings.HasPrefix(connName, "wsl://") {
		return false, fmt.Errorf("connupdatewshcommand is not supported for wsl connections")
	}
	connOpts, err := remote.ParseOpts(connName)
	if err != nil {
		return false, fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.GetConn(connOpts)
	if conn == nil {
		return false, fmt.Errorf("connection not found: %s", connName)
	}
	err = conn.UpdateWsh(ctx, connName, &remoteInfo)
	if err != nil {
		return false, fmt.Errorf("wsh update failed for connection %s: %w", connName, err)
	}

	// todo: need to add code for modifying configs?
	return true, nil
}

func (ws *WshServer) ConnListCommand(ctx context.Context) ([]string, error) {
	return conncontroller.GetConnectionsList()
}

func (ws *WshServer) WslListCommand(ctx context.Context) ([]string, error) {
	distros, err := wsl.RegisteredDistros(ctx)
	if err != nil {
		return nil, err
	}
	var distroNames []string
	for _, distro := range distros {
		distroName := distro.Name()
		if utilfn.ContainsStr(InvalidWslDistroNames, distroName) {
			continue
		}
		distroNames = append(distroNames, distroName)
	}
	return distroNames, nil
}

func (ws *WshServer) WslDefaultDistroCommand(ctx context.Context) (string, error) {
	distro, ok, err := wsl.DefaultDistro(ctx)
	if err != nil {
		return "", fmt.Errorf("unable to determine default distro: %w", err)
	}
	if !ok {
		return "", fmt.Errorf("unable to determine default distro")
	}
	return distro.Name(), nil
}

func (ws *WshServer) FindGitBashCommand(ctx context.Context, rescan bool) (string, error) {
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	return shellutil.FindGitBash(&fullConfig, rescan), nil
}
