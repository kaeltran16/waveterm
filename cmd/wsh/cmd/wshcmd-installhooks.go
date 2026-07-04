// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

// managedHook is one (event, matcher) hook Arc owns in the user's settings.json.
type managedHook struct {
	Event   string
	Matcher string // "" => no matcher key (matches all)
	Args    string // wsh subcommand + flags, e.g. "agent-hook", "ask", "ask --clear"
	Timeout int
}

// order is deterministic so re-runs produce stable output
var managedHooks = []managedHook{
	{"PreToolUse", "", "agent-hook", 10},
	{"PreToolUse", "AskUserQuestion", "ask", 3600},
	{"PostToolUse", "", "agent-hook", 10},
	{"PostToolUse", "AskUserQuestion", "ask --clear", 10},
	{"Notification", "", "agent-hook", 10},
	{"Stop", "", "agent-hook", 10},
	{"SubagentStop", "", "agent-hook", 10},
	{"UserPromptSubmit", "", "agent-hook", 10},
}

func managedEventOrder() []string {
	seen := map[string]bool{}
	var order []string
	for _, mh := range managedHooks {
		if !seen[mh.Event] {
			seen[mh.Event] = true
			order = append(order, mh.Event)
		}
	}
	return order
}

// isManagedCommand reports whether a hook command string is one Arc wrote: the first
// token's basename starts with "wsh" and the remaining args are exactly one of our
// subcommands. Path- and version-independent so app updates self-heal.
func isManagedCommand(command string) bool {
	exe, rest := splitFirstToken(command)
	if exe == "" {
		return false
	}
	base := strings.ToLower(filepath.Base(exe))
	if !strings.HasPrefix(base, "wsh") {
		return false
	}
	switch strings.TrimSpace(rest) {
	case "agent-hook", "ask", "ask --clear":
		return true
	}
	return false
}

// splitFirstToken splits a command string into its first token (respecting a leading
// double-quoted path) and the remainder.
func splitFirstToken(command string) (string, string) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", ""
	}
	if command[0] == '"' {
		if end := strings.IndexByte(command[1:], '"'); end >= 0 {
			return command[1 : 1+end], strings.TrimSpace(command[end+2:])
		}
		return command[1:], ""
	}
	if sp := strings.IndexByte(command, ' '); sp >= 0 {
		return command[:sp], strings.TrimSpace(command[sp+1:])
	}
	return command, ""
}

func quotePath(p string) string {
	return `"` + p + `"`
}

func buildManagedGroup(mh managedHook, wshExe string) map[string]any {
	group := map[string]any{
		"hooks": []any{
			map[string]any{
				"type":    "command",
				"command": quotePath(wshExe) + " " + mh.Args,
				"timeout": mh.Timeout,
			},
		},
	}
	if mh.Matcher != "" {
		group["matcher"] = mh.Matcher
	}
	return group
}

func groupIsManaged(group any) bool {
	gm, ok := group.(map[string]any)
	if !ok {
		return false
	}
	hs, ok := gm["hooks"].([]any)
	if !ok {
		return false
	}
	for _, h := range hs {
		hm, ok := h.(map[string]any)
		if !ok {
			continue
		}
		if c, ok := hm["command"].(string); ok && isManagedCommand(c) {
			return true
		}
	}
	return false
}

// mergeAgentHooks returns a copy of existing with Arc's managed hook entries added or
// refreshed, preserving every other key and every non-managed hook group.
func mergeAgentHooks(existing map[string]any, wshExe string) map[string]any {
	// deep copy via round-trip so the caller's map is never mutated
	out := map[string]any{}
	if b, err := json.Marshal(existing); err == nil {
		_ = json.Unmarshal(b, &out)
	}

	hooks, _ := out["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
		out["hooks"] = hooks
	}

	for _, event := range managedEventOrder() {
		var kept []any
		if groups, ok := hooks[event].([]any); ok {
			for _, g := range groups {
				if !groupIsManaged(g) {
					kept = append(kept, g)
				}
			}
		}
		for _, mh := range managedHooks {
			if mh.Event == event {
				kept = append(kept, buildManagedGroup(mh, wshExe))
			}
		}
		hooks[event] = kept
	}
	return out
}

// isManagedStatusLine reports whether a statusLine command is Arc's wrapper: first token's
// basename starts with "wsh" and the remainder begins with "statusline". Path/version-independent.
func isManagedStatusLine(command string) bool {
	exe, rest := splitFirstToken(command)
	if exe == "" {
		return false
	}
	if !strings.HasPrefix(strings.ToLower(filepath.Base(exe)), "wsh") {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(rest), "statusline")
}

func encodeInner(inner string) string {
	return base64.StdEncoding.EncodeToString([]byte(inner))
}

func decodeInner(b64 string) string {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ""
	}
	return string(data)
}

// recoverInner extracts the base64 --inner= value from a managed statusLine command, decoded
// back to the user's original command (empty string if none / unparseable).
func recoverInner(command string) string {
	_, rest := splitFirstToken(command)
	for _, f := range strings.Fields(strings.TrimSpace(rest)) {
		if strings.HasPrefix(f, "--inner=") {
			return decodeInner(strings.TrimPrefix(f, "--inner="))
		}
	}
	return ""
}

// mergeStatusLine returns a copy of existing with statusLine.command wrapped by Arc's
// "wsh statusline --inner=<b64>", carrying the user's original command so their terminal
// statusline display is unchanged. Idempotent: re-wrapping recovers the original instead of nesting.
func mergeStatusLine(existing map[string]any, wshExe string) map[string]any {
	out := map[string]any{}
	if b, err := json.Marshal(existing); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	sl, _ := out["statusLine"].(map[string]any)
	if sl == nil {
		sl = map[string]any{}
	}
	inner := ""
	if cur, _ := sl["command"].(string); cur != "" {
		if isManagedStatusLine(cur) {
			inner = recoverInner(cur)
		} else {
			inner = cur
		}
	}
	sl["type"] = "command"
	sl["command"] = quotePath(wshExe) + " statusline --inner=" + encodeInner(inner)
	out["statusLine"] = sl
	return out
}

var installAgentHooksCmd = &cobra.Command{
	Use:                   "install-agent-hooks",
	Short:                 "install Arc's Claude Code hooks into ~/.claude/settings.json (idempotent)",
	Args:                  cobra.NoArgs,
	RunE:                  installAgentHooksRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
}

func init() {
	rootCmd.AddCommand(installAgentHooksCmd)
}

func installAgentHooksRun(cmd *cobra.Command, args []string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolving home dir: %w", err)
	}
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	path := filepath.Join(dir, "settings.json")

	existing := map[string]any{}
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &existing); err != nil {
			return fmt.Errorf("parsing %s: %w", path, err)
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving wsh path: %w", err)
	}

	merged := mergeAgentHooks(existing, exe)
	merged = mergeStatusLine(merged, exe)
	out, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding settings: %w", err)
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(out, '\n'), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	fmt.Printf("installed Arc agent hooks into %s\n", path)
	return nil
}
