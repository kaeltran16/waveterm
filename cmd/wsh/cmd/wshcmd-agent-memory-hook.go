// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// SessionEnd distillation hook. Reads the finished session's transcript tail, distills durable
// learnings via a headless `claude -p` pass, and routes them into memory over wshrpc. Registered by
// install-agent-hooks; runs as `wsh agent-memory-hook`. Fail-safe: any problem returns nil so a
// failed distillation never breaks the agent's turn.

const (
	memoryTailBytes   = 400 * 1024 // ~150K tokens; at/above this, use the 1M-context model
	memoryHaikuModel  = "claude-haiku-4-5"
	memorySonnetModel = "claude-sonnet-5" // 1M-context fallback for oversized tails
	// distillGuardVar marks the headless sub-session we spawn so its own SessionEnd hook no-ops
	// instead of recursively distilling forever.
	distillGuardVar = "WAVETERM_MEMORY_DISTILL"
	distillTimeout  = 110 * time.Second // under the 120s hook timeout registered in installhooks
)

const distillPrompt = "You are distilling durable learnings from a finished coding session transcript. " +
	`Output ONLY a JSON object: {"candidates":[{"type","scope","body","iscorrection","supersedes"}],"references":[]}. ` +
	"type is one of: feedback | learning | project | reference. " +
	`Set iscorrection=true ONLY for an explicit correction the user gave ("no, do it this way"). ` +
	"supersedes: the slug of an existing memory this learning replaces, or omit. " +
	"references: slugs of existing memories the session clearly relied on. " +
	`Extract only durable, reusable learnings. If none, return {"candidates":[],"references":[]}.`

// sessionEndEvent is the subset of the SessionEnd hook stdin payload we use.
type sessionEndEvent struct {
	TranscriptPath string `json:"transcript_path"`
	Cwd            string `json:"cwd"`
}

var agentMemoryHookCmd = &cobra.Command{
	Use:                   "agent-memory-hook",
	Short:                 "Claude Code SessionEnd hook: distill durable learnings into memory",
	Args:                  cobra.NoArgs,
	RunE:                  agentMemoryHookRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceErrors:         true,
	SilenceUsage:          true,
}

func init() {
	rootCmd.AddCommand(agentMemoryHookCmd)
}

// agentMemoryHookRun always returns nil: a hook must never break the agent's turn.
func agentMemoryHookRun(cmd *cobra.Command, args []string) error {
	if os.Getenv(distillGuardVar) != "" {
		return nil // we are the headless distillation sub-session; don't recurse
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil
	}
	var ev sessionEndEvent
	if json.Unmarshal(raw, &ev) != nil || ev.TranscriptPath == "" {
		return nil
	}
	tail := readTranscriptTail(ev.TranscriptPath)
	if strings.TrimSpace(tail) == "" {
		return nil
	}

	data, ok := distill(tail)
	if !ok || (len(data.Candidates) == 0 && len(data.References) == 0) {
		return nil
	}
	data.Cwd = ev.Cwd

	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	_, _ = wshclient.MemoryLearnCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 10000})
	return nil
}

// readTranscriptTail returns the last memoryTailBytes of path (whole file when smaller). Any error
// yields "".
func readTranscriptTail(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	start := int64(0)
	if st.Size() > memoryTailBytes {
		start = st.Size() - memoryTailBytes
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	return string(b)
}

// distill runs the headless `claude -p` pass over the transcript tail and parses its JSON reply.
// ok is false on any spawn/parse failure.
func distill(tail string) (wshrpc.CommandMemoryLearnData, bool) {
	var out wshrpc.CommandMemoryLearnData
	model := memoryHaikuModel
	if len(tail) >= memoryTailBytes {
		model = memorySonnetModel
	}
	ctx, cancel := context.WithTimeout(context.Background(), distillTimeout)
	defer cancel()
	c := exec.CommandContext(ctx, "claude", "-p", "--model", model, distillPrompt)
	c.Stdin = strings.NewReader(tail)
	c.Env = append(os.Environ(), distillGuardVar+"=1")
	stdout, err := c.Output()
	if err != nil {
		return out, false
	}
	// tolerate prose around the JSON: take the first {...} block.
	s := string(stdout)
	i := strings.IndexByte(s, '{')
	j := strings.LastIndexByte(s, '}')
	if i < 0 || j <= i {
		return out, false
	}
	if json.Unmarshal([]byte(s[i:j+1]), &out) != nil {
		return out, false
	}
	return out, true
}
