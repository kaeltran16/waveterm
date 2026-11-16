// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package claudemod reads Claude Code's user settings (~/.claude/settings.json), where Arc installs its hooks and mods.
package claudemod

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// ReadSettings reads a settings.json for a read-modify-write: a missing or blank file is no settings,
// any other read error is returned so the caller never writes over settings it could not see.
func ReadSettings(path string) (map[string]any, error) {
	settings := map[string]any{}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return settings, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	// Windows PowerShell 5 writes UTF-8 with a BOM, which json.Unmarshal refuses
	b = bytes.TrimPrefix(b, []byte("\xEF\xBB\xBF"))
	if len(strings.TrimSpace(string(b))) == 0 {
		return settings, nil
	}
	if err := json.Unmarshal(b, &settings); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return settings, nil
}
