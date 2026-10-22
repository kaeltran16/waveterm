// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package claudemod reads and writes the options of the Claude Code mods Arc installs (claude/arc-*-mod), where
// Claude Code keeps them: pluginConfigs[<plugin>].options in ~/.claude/settings.json, the same entry its /config
// rows write. The mod reads them from there too, so Arc's Settings and /config cannot disagree.
package claudemod

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// the boolean userConfig fields each mod declares in its .claude-plugin/plugin.json; nothing else is written
var modFields = map[string][]string{
	"arc-skim": {"highlight", "dim"},
}

// a --plugin-dir plugin's entry is keyed by its name, or by its name with this suffix
const inlineSuffix = "@inline"

func settingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home dir: %w", err)
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// Options is the plugin's stored options: only what was set, so an absent field stands at the mod's default.
func Options(plugin string) (map[string]any, error) {
	if _, ok := modFields[plugin]; !ok {
		return nil, fmt.Errorf("%q is not an Arc mod with options", plugin)
	}
	path, err := settingsPath()
	if err != nil {
		return nil, err
	}
	return optionsIn(path, plugin)
}

// SetOption writes one boolean field of the plugin's options, into every entry the settings key it by.
func SetOption(plugin, field string, value bool) error {
	fields, ok := modFields[plugin]
	if !ok {
		return fmt.Errorf("%q is not an Arc mod with options", plugin)
	}
	if !slices.Contains(fields, field) {
		return fmt.Errorf("%q declares no option %q", plugin, field)
	}
	path, err := settingsPath()
	if err != nil {
		return err
	}
	return setOptionIn(path, plugin, field, value)
}

func readSettings(path string) (map[string]any, error) {
	settings := map[string]any{}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return settings, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return settings, nil
	}
	if err := json.Unmarshal(b, &settings); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return settings, nil
}

// entryKeys are the pluginConfigs keys naming the plugin, its plain name first
func entryKeys(plugin string) []string {
	return []string{plugin, plugin + inlineSuffix}
}

func optionsIn(path, plugin string) (map[string]any, error) {
	settings, err := readSettings(path)
	if err != nil {
		return nil, err
	}
	configs, _ := settings["pluginConfigs"].(map[string]any)
	for _, key := range entryKeys(plugin) {
		entry, _ := configs[key].(map[string]any)
		if options, ok := entry["options"].(map[string]any); ok {
			return options, nil
		}
	}
	return map[string]any{}, nil
}

func setOptionIn(path, plugin, field string, value bool) error {
	settings, err := readSettings(path)
	if err != nil {
		return err
	}
	configs, _ := settings["pluginConfigs"].(map[string]any)
	if configs == nil {
		configs = map[string]any{}
	}
	var keys []string
	for _, key := range entryKeys(plugin) {
		if _, ok := configs[key]; ok {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		keys = []string{plugin}
	}
	for _, key := range keys {
		entry, _ := configs[key].(map[string]any)
		if entry == nil {
			entry = map[string]any{}
		}
		options, _ := entry["options"].(map[string]any)
		if options == nil {
			options = map[string]any{}
		}
		options[field] = value
		entry["options"] = options
		configs[key] = entry
	}
	settings["pluginConfigs"] = configs
	return writeSettings(path, settings)
}

// writeSettings replaces the file through a temp file and a rename, as `wsh install-agent-hooks` does, so a claude
// session watching it never reads half a file
func writeSettings(path string, settings map[string]any) error {
	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding settings: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(out, '\n'), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	return nil
}
