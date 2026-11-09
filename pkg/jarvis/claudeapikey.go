// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/fileutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Claude Code reads an API key from the command in apiKeyHelper (user settings.json), which outranks the
// Claude.ai login underneath. Arc points that setting at `wsh claude-api-key`, which prints the saved key, so
// switching to the key and back only adds and removes that one setting.

const (
	// ClaudeApiKeySecretName must not start with claudeAccountSecretPrefix, or ListClaudeAccounts would
	// read the key as an account.
	ClaudeApiKeySecretName = "claudeapikey"
	// ClaudeApiKeyHelperCmd is the wsh subcommand Claude Code's apiKeyHelper runs to read the key.
	ClaudeApiKeyHelperCmd = "claude-api-key"

	claudeApiKeyHelperKey       = "apiKeyHelper"
	claudeApiKeyValidateTimeout = 10 * time.Second
	anthropicVersion            = "2023-06-01"
	// the API's error bodies are small JSON; this only bounds a misbehaving proxy
	maxAnthropicErrorBody = 64 * 1024
)

// Package vars so tests never touch the real wsh, config dir or network.
var (
	claudeHelperWsh       = func() string { return wavebase.StableWshPath(wavebase.GetHomeDir()) }
	claudeHelperConfigDir = wavebase.GetWaveConfigDir
	anthropicAPIBase      = "https://api.anthropic.com"
	validateClaudeApiKey  = defaultValidateClaudeApiKey
)

// defaultValidateClaudeApiKey makes the cheapest authenticated request: listing one model.
func defaultValidateClaudeApiKey(ctx context.Context, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, anthropicAPIBase+"/v1/models?limit=1", nil)
	if err != nil {
		return fmt.Errorf("building the Anthropic API request: %w", err)
	}
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", anthropicVersion)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach the Anthropic API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxAnthropicErrorBody))
	var apiErr struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	msg := strings.TrimSpace(string(body))
	if json.Unmarshal(body, &apiErr) == nil && apiErr.Error.Message != "" {
		msg = apiErr.Error.Message
	}
	return fmt.Errorf("the Anthropic API answered %s: %s", resp.Status, msg)
}

// SaveClaudeApiKey validates the key against the Anthropic API, then stores it and flushes the store, so
// a helper started right after reads it from disk.
func SaveClaudeApiKey(ctx context.Context, key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return errors.New("the API key is empty")
	}
	vctx, cancel := context.WithTimeout(ctx, claudeApiKeyValidateTimeout)
	defer cancel()
	if err := validateClaudeApiKey(vctx, key); err != nil {
		return err
	}
	claudeAccountMu.Lock()
	defer claudeAccountMu.Unlock()
	if err := claudeAccountSecrets.Set(ClaudeApiKeySecretName, key); err != nil {
		return fmt.Errorf("saving the API key: %w", err)
	}
	if err := claudeAccountSecrets.Flush(); err != nil {
		return fmt.Errorf("writing the API key to the secret store: %w", err)
	}
	return nil
}

// arcApiKeyHelperCommand is the apiKeyHelper this Arc instance writes. Claude Code runs it through cmd
// on Windows, so both paths are quoted.
func arcApiKeyHelperCommand(wsh string) string {
	return `"` + wsh + `" ` + ClaudeApiKeyHelperCmd + ` --config-dir "` + claudeHelperConfigDir() + `"`
}

// isArcApiKeyHelper reports whether cmd runs a wsh's claude-api-key, whichever Arc instance wrote it.
func isArcApiKeyHelper(cmd string) bool {
	exe, rest := splitCommandExe(strings.TrimSpace(cmd))
	base := strings.ToLower(exe[strings.LastIndexAny(exe, `/\`)+1:])
	fields := strings.Fields(rest)
	return strings.HasPrefix(base, "wsh") && len(fields) > 0 && fields[0] == ClaudeApiKeyHelperCmd
}

// splitCommandExe splits a command into its executable, which may be double-quoted, and the rest.
func splitCommandExe(cmd string) (string, string) {
	if strings.HasPrefix(cmd, `"`) {
		if end := strings.IndexByte(cmd[1:], '"'); end >= 0 {
			return cmd[1 : 1+end], cmd[end+2:]
		}
		return cmd[1:], ""
	}
	if sp := strings.IndexByte(cmd, ' '); sp >= 0 {
		return cmd[:sp], cmd[sp+1:]
	}
	return cmd, ""
}

// claudeSettings is Claude Code's user settings.json as read, kept whole so a write changes one key.
type claudeSettings struct {
	path    string
	orig    []byte
	existed bool
	perm    fs.FileMode
	obj     map[string]json.RawMessage
}

// readClaudeSettings reads settings.json; a missing or empty file is an empty object.
func readClaudeSettings() (*claudeSettings, error) {
	path, err := claudeSettingsPath()
	if err != nil {
		return nil, err
	}
	s := &claudeSettings{path: path, perm: 0o600, obj: map[string]json.RawMessage{}}
	if st, err := os.Stat(path); err == nil {
		s.perm = st.Mode().Perm()
	}
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	s.orig, s.existed = data, err == nil
	if err := unmarshalObject(data, &s.obj); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return s, nil
}

// apiKeyHelper returns the apiKeyHelper command, "" when absent or null. A non-string value is an error
// naming it.
func (s *claudeSettings) apiKeyHelper() (string, error) {
	raw, ok := s.obj[claudeApiKeyHelperKey]
	if !ok || isJSONAbsent(raw) {
		return "", nil
	}
	var cmd string
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return "", fmt.Errorf("%s in %s is %s, not a command", claudeApiKeyHelperKey, s.path, raw)
	}
	return cmd, nil
}

func (s *claudeSettings) hasArcHelper() bool {
	cmd, err := s.apiKeyHelper()
	return err == nil && isArcApiKeyHelper(cmd)
}

// write writes the object back atomically, with the 2-space indent Claude Code uses.
func (s *claudeSettings) write() error {
	out, err := json.MarshalIndent(s.obj, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding %s: %w", s.path, err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("creating dir for %s: %w", s.path, err)
	}
	if err := fileutil.AtomicWriteFile(s.path, out, s.perm); err != nil {
		return fmt.Errorf("writing %s: %w", s.path, err)
	}
	return nil
}

// restore puts the file back as it was read.
func (s *claudeSettings) restore() error {
	var err error
	if s.existed {
		err = fileutil.AtomicWriteFile(s.path, s.orig, s.perm)
	} else {
		err = os.Remove(s.path)
	}
	if err != nil {
		return fmt.Errorf("restoring %s: %w", s.path, err)
	}
	return nil
}

// claudeApiKeyActive reports whether settings.json holds Arc's helper. An unreadable or invalid file
// counts as not active: Claude Code cannot use a helper from it either. Caller holds claudeAccountMu.
func claudeApiKeyActive() bool {
	s, err := readClaudeSettings()
	if err != nil {
		log.Printf("claudeapikey: %v\n", err)
		return false
	}
	return s.hasArcHelper()
}

// claudeApiKeyInfo fills the saved and active state of the API key. Caller holds claudeAccountMu.
func claudeApiKeyInfo(settingsPath string) (*wshrpc.ClaudeApiKeyInfo, error) {
	key, ok, err := claudeAccountSecrets.Get(ClaudeApiKeySecretName)
	if err != nil {
		return nil, fmt.Errorf("reading the saved API key: %w", err)
	}
	info := &wshrpc.ClaudeApiKeyInfo{SettingsPath: settingsPath, Active: claudeApiKeyActive()}
	if ok && key != "" {
		info.Saved = true
		info.Last4 = key[max(0, len(key)-4):]
	}
	return info, nil
}

// SwitchToClaudeApiKey points Claude Code's apiKeyHelper at this Arc's wsh, keeping every other setting.
// A helper another Arc instance wrote is replaced; any other helper is refused.
func SwitchToClaudeApiKey() error {
	claudeAccountMu.Lock()
	defer claudeAccountMu.Unlock()
	key, ok, err := claudeAccountSecrets.Get(ClaudeApiKeySecretName)
	if err != nil {
		return fmt.Errorf("reading the saved API key: %w", err)
	}
	if !ok || key == "" {
		return errors.New("no API key is saved; save one first")
	}
	wsh := claudeHelperWsh()
	if _, err := os.Stat(wsh); err != nil {
		return fmt.Errorf("the wsh Claude Code would run is missing (%s); restart Arc to reinstall it: %w", wsh, err)
	}
	s, err := readClaudeSettings()
	if err != nil {
		return err
	}
	current, err := s.apiKeyHelper()
	if err != nil {
		return fmt.Errorf("%w; remove it to use the API key", err)
	}
	if current != "" && !isArcApiKeyHelper(current) {
		return fmt.Errorf("%s already sets %s to \"%s\"; remove it to use the API key", s.path, claudeApiKeyHelperKey, current)
	}
	want := arcApiKeyHelperCommand(wsh)
	if current == want {
		return nil
	}
	raw, err := json.Marshal(want)
	if err != nil {
		return fmt.Errorf("encoding %s: %w", claudeApiKeyHelperKey, err)
	}
	s.obj[claudeApiKeyHelperKey] = raw
	return s.write()
}

// removeArcApiKeyHelper removes Arc's apiKeyHelper from settings.json and returns a func that puts it
// back; a no-op when Arc's helper is not there. Caller holds claudeAccountMu.
func removeArcApiKeyHelper() (func() error, error) {
	noop := func() error { return nil }
	s, err := readClaudeSettings()
	if err != nil {
		// Claude Code cannot read a helper from this file either, so the account switch goes ahead
		log.Printf("claudeapikey: %v\n", err)
		return noop, nil
	}
	if !s.hasArcHelper() {
		return noop, nil
	}
	delete(s.obj, claudeApiKeyHelperKey)
	if err := s.write(); err != nil {
		return nil, err
	}
	return s.restore, nil
}

// joinRestore runs restore after a failed step, keeping the step's error first.
func joinRestore(err error, restore func() error) error {
	if rerr := restore(); rerr != nil {
		return fmt.Errorf("%w; %v", err, rerr)
	}
	return err
}

// RemoveClaudeApiKey deletes the saved key. The active key cannot be removed.
func RemoveClaudeApiKey() error {
	claudeAccountMu.Lock()
	defer claudeAccountMu.Unlock()
	if claudeApiKeyActive() {
		return errors.New("the API key is active; switch to a Claude account before removing it")
	}
	if err := claudeAccountSecrets.Delete(ClaudeApiKeySecretName); err != nil {
		return fmt.Errorf("removing the API key: %w", err)
	}
	return nil
}
