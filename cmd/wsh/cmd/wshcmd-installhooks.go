// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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
	{"SessionEnd", "", "agent-memory-hook", 10},
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
	case "agent-hook", "ask", "ask --clear", "agent-memory-hook":
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

// configIsHealthy reports whether existing already carries Arc's full managed hook set and managed
// statusLine, all referencing a wsh binary that exists on disk (per exeExists). When true the install
// can skip its rewrite, so a coexisting install does not clobber a working config every launch.
// When any managed hook is missing or its exe is gone, it returns false and the caller heals (rewrites).
func configIsHealthy(existing map[string]any, exeExists func(string) bool) bool {
	hooks, _ := existing["hooks"].(map[string]any)
	if hooks == nil {
		return false
	}
	count := 0
	for _, event := range managedEventOrder() {
		groups, _ := hooks[event].([]any)
		for _, g := range groups {
			gm, ok := g.(map[string]any)
			if !ok {
				continue
			}
			hs, _ := gm["hooks"].([]any)
			for _, h := range hs {
				hm, ok := h.(map[string]any)
				if !ok {
					continue
				}
				c, _ := hm["command"].(string)
				if !isManagedCommand(c) {
					continue
				}
				exe, _ := splitFirstToken(c)
				if !exeExists(exe) {
					return false
				}
				count++
			}
		}
	}
	if count != len(managedHooks) {
		return false
	}
	sl, _ := existing["statusLine"].(map[string]any)
	if sl == nil {
		return false
	}
	slc, _ := sl["command"].(string)
	if !isManagedStatusLine(slc) {
		return false
	}
	exe, _ := splitFirstToken(slc)
	return exeExists(exe)
}

//go:embed opencode-plugin.js
var opencodePluginTemplate string

// opencodeLookPath is a var so tests can simulate a machine with or without opencode installed.
var opencodeLookPath = exec.LookPath

//go:embed pi-memory-extension.ts
var piMemoryExtensionTemplate string

// piLookPath is a var so tests can simulate a machine with or without pi installed.
var piLookPath = exec.LookPath

// jsonString marshals s as a JSON string literal (escapes backslashes/quotes) for substitution
// into the plugin's WSH constant.
func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// installOpencodePlugin writes the Wave status plugin into opencode's global plugin directory
// (~/.config/opencode/plugins/), where opencode auto-loads every file. No-op when opencode is not
// installed. Idempotent: rewrites only when the installed copy differs (the wsh path changes when
// the app install moves), so re-running on every launch self-heals without churn.
func installOpencodePlugin(home string) error {
	if _, err := opencodeLookPath("opencode"); err != nil {
		return nil // opencode not installed; nothing to hook
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving wsh path: %w", err)
	}
	want := strings.ReplaceAll(opencodePluginTemplate, "__WSH_PATH__", jsonString(exe))
	dir := filepath.Join(home, ".config", "opencode", "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	path := filepath.Join(dir, "waveterm-status.js")
	if cur, err := os.ReadFile(path); err == nil && string(cur) == want {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(want), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	fmt.Printf("installed opencode status plugin into %s\n", path)
	return nil
}

// installPiMemoryExtension writes the Wave memory extension into pi's global extension directory
// (~/.pi/agent/extensions/), where pi auto-loads every file. Same contract as installPiStatusExtension:
// no-op when pi is not installed, idempotent rewrite, self-heals when the wsh path changes.
func installPiMemoryExtension(home string) error {
	if _, err := piLookPath("pi"); err != nil {
		return nil // pi not installed; nothing to hook
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving wsh path: %w", err)
	}
	want := strings.ReplaceAll(piMemoryExtensionTemplate, `"__WSH_PATH__"`, jsonString(exe))
	dir := filepath.Join(home, ".pi", "agent", "extensions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	path := filepath.Join(dir, "waveterm-memory.ts")
	if cur, err := os.ReadFile(path); err == nil && string(cur) == want {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(want), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	fmt.Printf("installed pi memory extension into %s\n", path)
	return nil
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

	if configIsHealthy(existing, func(p string) bool {
		_, err := os.Stat(p)
		return err == nil
	}) {
		fmt.Printf("Arc agent hooks already installed in %s (skipping)\n", path)
	} else {
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
	}
	if err := installOpencodePlugin(home); err != nil {
		return err
	}
	if err := installPiMemoryExtension(home); err != nil {
		return err
	}
	return nil
}
