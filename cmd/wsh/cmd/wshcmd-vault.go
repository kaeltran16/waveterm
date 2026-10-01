// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const (
	vaultRpcTimeoutMs = 5000
	// a waited sync runs a fetch and a push, each allowed 2 minutes server-side
	vaultSyncRpcTimeoutMs = 3 * 60 * 1000
	vaultTimeLayout       = "2006-01-02 15:04:05"
)

var vaultRemoteRemove bool

var vaultCmd = &cobra.Command{
	Use:   "vault",
	Short: "sync the Wave Vault through a private git remote",
}

var vaultRemoteCmd = &cobra.Command{
	Use:     "remote [url]",
	Short:   "print the vault's git remote, or set it (and sync); --remove turns sync off",
	Args:    cobra.MaximumNArgs(1),
	RunE:    vaultRemoteRun,
	PreRunE: preRunSetupRpcClient,
}

var vaultSyncCmd = &cobra.Command{
	Use:     "sync",
	Short:   "sync the vault with its git remote now",
	Args:    cobra.NoArgs,
	RunE:    vaultSyncRun,
	PreRunE: preRunSetupRpcClient,
}

var vaultStatusCmd = &cobra.Command{
	Use:     "status",
	Short:   "print the vault's remote, last sync, conflict copies and malformed efforts",
	Args:    cobra.NoArgs,
	RunE:    vaultStatusRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	vaultRemoteCmd.Flags().BoolVar(&vaultRemoteRemove, "remove", false, "remove the remote, turning sync off")
	vaultCmd.AddCommand(vaultRemoteCmd, vaultSyncCmd, vaultStatusCmd)
	rootCmd.AddCommand(vaultCmd)
}

func vaultRemoteRun(cmd *cobra.Command, args []string) error {
	if vaultRemoteRemove {
		if len(args) > 0 {
			return fmt.Errorf("--remove takes no url")
		}
		if err := setVaultRemote(""); err != nil {
			return err
		}
		WriteStdout("remote removed — sync is off\n")
		return nil
	}
	if len(args) == 0 {
		st, err := wshclient.VaultStatusCommand(RpcClient, &wshrpc.RpcOpts{Timeout: vaultRpcTimeoutMs})
		if err != nil {
			return fmt.Errorf("reading vault status: %w", err)
		}
		if st.RemoteURL == "" {
			WriteStdout("no remote — sync is off\n")
		} else {
			WriteStdout("%s\n", st.RemoteURL)
		}
		return nil
	}
	if err := setVaultRemote(args[0]); err != nil {
		return err
	}
	WriteStdout("remote set to %s\n", args[0])
	return vaultSyncRun(cmd, nil)
}

func setVaultRemote(url string) error {
	err := wshclient.VaultSetRemoteCommand(RpcClient, wshrpc.CommandVaultSetRemoteData{URL: url}, &wshrpc.RpcOpts{Timeout: vaultRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("setting vault remote: %w", err)
	}
	return nil
}

func vaultSyncRun(cmd *cobra.Command, args []string) error {
	err := wshclient.VaultSyncCommand(RpcClient, wshrpc.CommandVaultSyncData{Wait: true}, &wshrpc.RpcOpts{Timeout: vaultSyncRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("vault sync: %w", err)
	}
	WriteStdout("synced\n")
	return nil
}

func vaultStatusRun(cmd *cobra.Command, args []string) error {
	st, err := wshclient.VaultStatusCommand(RpcClient, &wshrpc.RpcOpts{Timeout: vaultRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("reading vault status: %w", err)
	}
	WriteStdout("%s", formatVaultStatus(st, time.Local))
	return nil
}

func formatVaultStatus(st *wshrpc.VaultStatusRtnData, loc *time.Location) string {
	var b strings.Builder
	switch st.Off {
	case wavevault.SyncOffNoGit:
		b.WriteString("sync is off: git is not on PATH\n")
	case wavevault.SyncOffNoRemote:
		b.WriteString("sync is off: no remote (set one with `wsh vault remote <url>`)\n")
	default:
		fmt.Fprintf(&b, "remote:       %s\n", st.RemoteURL)
	}
	if st.Running {
		b.WriteString("sync running\n")
	}
	if st.LastSuccessTs > 0 {
		fmt.Fprintf(&b, "last success: %s\n", time.UnixMilli(st.LastSuccessTs).In(loc).Format(vaultTimeLayout))
	} else if st.Off == "" {
		b.WriteString("last success: none since wavesrv started\n")
	}
	if st.LastError != "" {
		fmt.Fprintf(&b, "last error:   %s\n", st.LastError)
	}
	writeVaultPathList(&b, "conflict copies", st.Conflicts)
	writeVaultPathList(&b, "malformed efforts", st.MalformedEfforts)
	return b.String()
}

func writeVaultPathList(b *strings.Builder, label string, paths []string) {
	if len(paths) == 0 {
		return
	}
	fmt.Fprintf(b, "%s:\n", label)
	for _, p := range paths {
		fmt.Fprintf(b, "  %s\n", p)
	}
}
