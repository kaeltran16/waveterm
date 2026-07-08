// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const transcriptTailBytes = 64 * 1024
const bashDetailMax = 60
const titleMax = 72 // fallback head-text length cap (rune-safe)

// ccHookEvent is the subset of the Claude Code lifecycle-hook stdin payload we use.
type ccHookEvent struct {
	HookEventName  string          `json:"hook_event_name"`
	ToolName       string          `json:"tool_name"`
	ToolUseID      string          `json:"tool_use_id"`
	TranscriptPath string          `json:"transcript_path"`
	ToolInput      json.RawMessage `json:"tool_input"`
}

// agentEmission describes what to publish for one hook event. State=="" means no
// parent-state event; Subagent==nil means no subagent delta. Both may be set (a Task
// PreToolUse both keeps the parent "working" and starts a subagent).
type agentEmission struct {
	State            string
	Detail           string
	AttachModelTitle bool
	Subagent         *baseds.AgentSubagentDelta
}

func planEmission(ev ccHookEvent) agentEmission {
	switch ev.HookEventName {
	case "UserPromptSubmit":
		return agentEmission{State: baseds.AgentState_Working, AttachModelTitle: true}
	case "Stop":
		return agentEmission{State: baseds.AgentState_Idle, AttachModelTitle: true}
	case "Notification":
		return agentEmission{State: baseds.AgentState_Waiting}
	case "PostToolUse":
		return agentEmission{State: baseds.AgentState_Working, AttachModelTitle: true}
	case "SubagentStop":
		if ev.ToolUseID != "" {
			return agentEmission{Subagent: &baseds.AgentSubagentDelta{Action: baseds.SubagentAction_Stop, Id: ev.ToolUseID}}
		}
		return agentEmission{}
	case "PreToolUse":
		switch ev.ToolName {
		case "Task":
			em := agentEmission{State: baseds.AgentState_Working, AttachModelTitle: true}
			if ev.ToolUseID != "" {
				em.Subagent = &baseds.AgentSubagentDelta{
					Action: baseds.SubagentAction_Start,
					Id:     ev.ToolUseID,
					Type:   stringField(ev.ToolInput, "subagent_type"),
				}
			}
			return em
		case "AskUserQuestion":
			return agentEmission{State: baseds.AgentState_Asking}
		default:
			return agentEmission{State: baseds.AgentState_Working, Detail: detailForTool(ev.ToolName, ev.ToolInput), AttachModelTitle: true}
		}
	}
	return agentEmission{}
}

func detailForTool(name string, input json.RawMessage) string {
	switch name {
	case "Edit", "Write", "MultiEdit":
		if fp := stringField(input, "file_path"); fp != "" {
			return "editing " + filepath.Base(fp)
		}
	case "Read":
		if fp := stringField(input, "file_path"); fp != "" {
			return "reading " + filepath.Base(fp)
		}
	case "Bash":
		if cmd := stringField(input, "command"); cmd != "" {
			return "running " + truncate(cmd, bashDetailMax)
		}
	}
	return name
}

func stringField(raw json.RawMessage, field string) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	if s, ok := m[field].(string); ok {
		return s
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// tailLines returns the lines in the last transcriptTailBytes of path, dropping the
// partial leading line that a mid-file read produces. Any error yields nil.
func tailLines(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil
	}
	start := int64(0)
	if st.Size() > transcriptTailBytes {
		start = st.Size() - transcriptTailBytes
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	if start > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	return lines
}

func readLastModel(path string) string {
	model := ""
	for _, ln := range tailLines(path) {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var rec struct {
			Message struct {
				Model string `json:"model"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(ln), &rec) == nil && rec.Message.Model != "" {
			model = rec.Message.Model
		}
	}
	return model
}

func readLastTitle(path string) string {
	title := ""
	for _, ln := range tailLines(path) {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			AiTitle string `json:"aiTitle"`
		}
		if json.Unmarshal([]byte(ln), &rec) == nil && rec.Type == "ai-title" && rec.AiTitle != "" {
			title = rec.AiTitle
		}
	}
	return title
}

// userText extracts the human prose from a transcript user record's `content`, which is either a bare
// string or an array of content blocks. Only `text` blocks count; tool_result blocks are skipped, so a
// tool_result-only user turn yields "" (it isn't something the human typed).
func userText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		parts := make([]string, 0, len(blocks))
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				parts = append(parts, strings.TrimSpace(b.Text))
			}
		}
		return strings.TrimSpace(strings.Join(parts, " "))
	}
	return ""
}

// lastUserPrompt returns the text of the most recent user turn that carries human prose. Drives the
// head-text fallback when a turn (e.g. a skill/slash-command dispatch) produced no ai-title record.
func lastUserPrompt(lines []string) string {
	prompt := ""
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(ln), &rec) != nil || rec.Type != "user" {
			continue
		}
		if txt := userText(rec.Message.Content); txt != "" {
			prompt = txt
		}
	}
	return prompt
}

func readLastUserPrompt(path string) string {
	return lastUserPrompt(tailLines(path))
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// titleFromPrompt turns a user prompt into a head-text title: the first non-empty line, rune-truncated.
// A slash-command prompt (e.g. "/commit stage the diff") already carries the skill name plus the ask,
// so no special parsing is needed. Empty prompt -> "".
func titleFromPrompt(prompt string) string {
	for _, line := range strings.Split(prompt, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		return truncateRunes(line, titleMax)
	}
	return ""
}

var agentHookCmd = &cobra.Command{
	Use:                   "agent-hook",
	Short:                 "Claude Code lifecycle hook: report agent status to the Arc cockpit",
	Args:                  cobra.NoArgs,
	RunE:                  agentHookRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceErrors:         true,
	SilenceUsage:          true,
}

func init() {
	rootCmd.AddCommand(agentHookCmd)
}

// agentHookRun always returns nil: a hook must never break the agent's turn.
func agentHookRun(cmd *cobra.Command, args []string) error {
	if os.Getenv("WAVETERM_BLOCKID") == "" {
		return nil // not inside an Arc block; near-instant no-op
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil
	}
	var ev ccHookEvent
	if json.Unmarshal(raw, &ev) != nil {
		return nil
	}
	em := planEmission(ev)
	if em.State == "" && em.Subagent == nil {
		return nil
	}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	oref, err := resolveBlockArg()
	if err != nil {
		return nil
	}
	if em.State != "" {
		data := baseds.AgentStatusData{
			ORef:           oref.String(),
			State:          em.State,
			Detail:         em.Detail,
			Agent:          "claude",
			TranscriptPath: ev.TranscriptPath,
			Ts:             time.Now().UnixMilli(),
		}
		if em.AttachModelTitle && ev.TranscriptPath != "" {
			data.Model = readLastModel(ev.TranscriptPath)
			data.Title = readLastTitle(ev.TranscriptPath)
			// no ai-title yet (e.g. a skill/slash-command turn) -> fall back to the user's prompt so
			// the row still gets a head-text summary instead of the bare agent name
			if data.Title == "" {
				data.Title = titleFromPrompt(readLastUserPrompt(ev.TranscriptPath))
			}
		}
		_ = publishAgentStatusData(oref, data, 1)
	}
	if em.Subagent != nil {
		data := baseds.AgentStatusData{
			ORef:     oref.String(),
			Agent:    "claude",
			Ts:       time.Now().UnixMilli(),
			Subagent: em.Subagent,
		}
		_ = publishAgentStatusData(oref, data, 0)
	}
	return nil
}
