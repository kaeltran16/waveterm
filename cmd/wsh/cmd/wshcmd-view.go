// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var viewCmd = &cobra.Command{
	Use:     "view {file|directory}",
	Aliases: []string{"preview", "open"},
	Short:   "preview/edit a file or directory in the cockpit code surface",
	RunE:    viewRun,
	PreRunE: preRunSetupRpcClient,
}

var editCmd = &cobra.Command{
	Use:     "edit {file}",
	Short:   "edit a file",
	RunE:    viewRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	rootCmd.AddCommand(viewCmd)
	rootCmd.AddCommand(editCmd)
}

// viewRun routes the path to the running cockpit via an openfile event; there is no
// block-layout renderer in this build, so creating preview blocks would be a silent no-op.
func viewRun(cmd *cobra.Command, args []string) (rtnErr error) {
	cmdName := cmd.Name()
	defer func() {
		sendActivity(cmdName, rtnErr == nil)
	}()
	if len(args) == 0 {
		OutputHelpMessage(cmd)
		return fmt.Errorf("no arguments.  wsh %s requires a file or directory as an argument", cmdName)
	}
	if len(args) > 1 {
		OutputHelpMessage(cmd)
		return fmt.Errorf("too many arguments.  wsh %s requires exactly one argument", cmdName)
	}
	fileArg := args[0]
	if strings.HasPrefix(fileArg, "http://") || strings.HasPrefix(fileArg, "https://") {
		return fmt.Errorf("URLs are not supported by wsh %s in this build: %q", cmdName, fileArg)
	}
	absFile, err := filepath.Abs(fileArg)
	if err != nil {
		return fmt.Errorf("getting absolute path: %w", err)
	}
	absParent, err := filepath.Abs(filepath.Dir(fileArg))
	if err != nil {
		return fmt.Errorf("getting absolute path of parent dir: %w", err)
	}
	_, err = os.Stat(absParent)
	if err == fs.ErrNotExist {
		return fmt.Errorf("parent directory does not exist: %q", absParent)
	}
	if err != nil {
		return fmt.Errorf("getting file info: %w", err)
	}
	eventData := wshrpc.OpenFileData{Path: absFile}
	if cmdName == "edit" {
		eventData.Edit = true
	}
	err = wshclient.EventPublishCommand(RpcClient, wps.WaveEvent{
		Event: wps.Event_OpenFile,
		Data:  eventData,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("running view command: %w", err)
	}
	return nil
}
