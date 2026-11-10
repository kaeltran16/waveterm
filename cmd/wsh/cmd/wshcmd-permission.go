// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const toolKeyHexLen = 16

// the hook has 10s in all; the cockpit either takes the request at once or Claude shows its own dialog alone
const permissionRpcTimeoutMs = 5000

// permissionCmd is the PermissionRequest hook. It prints nothing and never exits 2 (which would deny the
// tool): any failure exits 1, a non-blocking error, so Claude always shows its own dialog.
var permissionCmd = &cobra.Command{
	Use:                   "permission",
	Short:                 "project a Claude Code permission prompt into the Arc cockpit (non-blocking)",
	Args:                  cobra.NoArgs,
	RunE:                  permissionRun,
	PreRunE:               preRunSetupRpcClient,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceUsage:          true,
}

func init() {
	rootCmd.AddCommand(permissionCmd)
}

func permissionRun(cmd *cobra.Command, args []string) error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}
	data, err := parsePermissionRequest(raw)
	if err != nil {
		return err
	}
	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %w", err)
	}
	data.ORef = oref.String()
	_, err = wshclient.AgentPermissionCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: permissionRpcTimeoutMs})
	return err
}

// parsePermissionRequest reads a PermissionRequest hook payload. ORef is left for the caller, which
// resolves the block.
func parsePermissionRequest(raw []byte) (wshrpc.CommandAgentPermissionData, error) {
	var ev struct {
		ToolName              string            `json:"tool_name"`
		ToolInput             json.RawMessage   `json:"tool_input"`
		PermissionSuggestions []json.RawMessage `json:"permission_suggestions"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return wshrpc.CommandAgentPermissionData{}, fmt.Errorf("parsing permission request: %w", err)
	}
	if ev.ToolName == "" {
		return wshrpc.CommandAgentPermissionData{}, fmt.Errorf("permission request has no tool_name")
	}
	return wshrpc.CommandAgentPermissionData{
		ToolName:       ev.ToolName,
		ToolInput:      string(ev.ToolInput),
		ToolKey:        toolKey(ev.ToolName, ev.ToolInput),
		HasSuggestions: len(ev.PermissionSuggestions) > 0,
	}, nil
}

// toolKey identifies a tool call by its name and input, independent of the input's key order, so the
// PermissionRequest and the PostToolUse of the same call agree. It is computed only here: the server
// compares keys and never recomputes one.
func toolKey(name string, input json.RawMessage) string {
	h := sha256.New()
	h.Write([]byte(name))
	h.Write([]byte{0})
	h.Write(canonicalJSON(input))
	return hex.EncodeToString(h.Sum(nil))[:toolKeyHexLen]
}

// canonicalJSON re-encodes input with object keys sorted (encoding/json orders map keys). Numbers stay
// exact through json.Number. Input that does not parse is used as it came.
func canonicalJSON(input json.RawMessage) []byte {
	if len(bytes.TrimSpace(input)) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(input))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return input
	}
	out, err := json.Marshal(v)
	if err != nil {
		return input
	}
	return out
}
