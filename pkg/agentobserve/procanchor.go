// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"strings"

	"github.com/shirou/gopsutil/v4/process"
)

const blockIDEnvVar = "WAVETERM_BLOCKID="

// helperCmdlineMarkers identify claude.exe processes that are NOT agent sessions and must be excluded
// from the anchor. `--chrome-native-host` is the claude-in-chrome bridge; observed running on this
// machine and would otherwise inflate the "live agent" count.
var helperCmdlineMarkers = []string{"--chrome-native-host"}

// ProcInfo is one anchored claude process: the OS ground truth for whether an agent is alive and,
// via its inherited env, which Wave block it belongs to. BlockID is the bare UUID Wave injected as
// WAVETERM_BLOCKID (empty when the agent runs outside a Wave block).
type ProcInfo struct {
	Pid      int32  `json:"pid"`
	BlockID  string `json:"blockid,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
	CreateMs int64  `json:"createms"`
	Cmdline  string `json:"cmdline,omitempty"`
}

// blockIDFromEnv extracts the bare WAVETERM_BLOCKID value from a process's environ (KEY=VALUE lines).
func blockIDFromEnv(environ []string) string {
	for _, kv := range environ {
		if strings.HasPrefix(kv, blockIDEnvVar) {
			return strings.TrimPrefix(kv, blockIDEnvVar)
		}
	}
	return ""
}

// isHelperCmdline reports whether a claude command line is a known non-agent helper.
func isHelperCmdline(cmdline string) bool {
	for _, m := range helperCmdlineMarkers {
		if strings.Contains(cmdline, m) {
			return true
		}
	}
	return false
}

// NormalizeBlockID reduces either a bare UUID (process env) or a `block:UUID` oref (hook log) to the
// bare UUID, so the two tracks correlate on one key.
func NormalizeBlockID(id string) string {
	return strings.TrimPrefix(id, "block:")
}

// isClaudeProc reports whether a process name denotes the Claude Code binary (claude / claude.exe).
func isClaudeProc(name string) bool {
	name = strings.ToLower(name)
	return name == "claude" || name == "claude.exe"
}

// claude sets CLAUDE_PID to its own pid for every process it starts, hooks and Bash commands alike, so a
// claude process carries it in its own environment only when another claude session started it
const claudePidEnvVar = "CLAUDE_PID="

// NestedClaude reports whether the claude process pid was started from inside another claude session (a
// headless `claude -p` run from an agent's Bash tool). Its own environment is read, not the caller's: claude
// rewrites CLAUDE_PID for each child. A process that cannot be read counts as not nested.
func NestedClaude(pid int32) bool {
	p, err := process.NewProcess(pid)
	if err != nil {
		return false
	}
	environ, err := p.Environ()
	if err != nil {
		return false
	}
	for _, kv := range environ {
		if strings.HasPrefix(kv, claudePidEnvVar) && len(kv) > len(claudePidEnvVar) {
			return true
		}
	}
	return false
}

// EnumerateAgents returns every live claude agent process (helpers excluded). Per-process introspection
// errors are skipped rather than failing the sweep — a process may exit mid-enumeration, and a pilot
// sweep must be resilient. Reading Environ/Cwd may fail for some processes on Windows; such a process
// still counts as a live agent (its liveness is the ground truth), just without block attribution.
func EnumerateAgents() ([]ProcInfo, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}
	var out []ProcInfo
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || !isClaudeProc(name) {
			continue
		}
		cmdline, _ := p.Cmdline()
		if isHelperCmdline(cmdline) {
			continue
		}
		environ, _ := p.Environ()
		cwd, _ := p.Cwd()
		createMs, _ := p.CreateTime()
		out = append(out, ProcInfo{
			Pid:      p.Pid,
			BlockID:  blockIDFromEnv(environ),
			Cwd:      cwd,
			CreateMs: createMs,
			Cmdline:  cmdline,
		})
	}
	return out, nil
}
