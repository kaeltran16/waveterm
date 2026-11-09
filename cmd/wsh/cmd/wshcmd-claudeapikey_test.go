// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

func TestClaudeApiKeyPrintsKey(t *testing.T) {
	dir := t.TempDir()
	old := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = dir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	if err := secretstore.SetSecret(jarvis.ClaudeApiKeySecretName, "sk-ant-k"); err != nil {
		t.Fatal(err)
	}
	if err := secretstore.Flush(); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := claudeApiKeyRun(dir, &buf); err != nil {
		t.Fatal(err)
	}
	if buf.String() != "sk-ant-k" {
		t.Errorf("out = %q, want the key with no newline", buf.String())
	}
}

func TestClaudeApiKeyNoneSaved(t *testing.T) {
	dir := t.TempDir()
	var buf bytes.Buffer
	err := claudeApiKeyRun(dir, &buf)
	if err == nil || !strings.Contains(err.Error(), "no Claude API key is saved") || !strings.Contains(err.Error(), dir) {
		t.Errorf("err = %v, want the no-key message naming %s", err, dir)
	}
	if buf.Len() != 0 {
		t.Errorf("wrote %q on failure", buf.String())
	}
}

func TestClaudeApiKeyUnreadable(t *testing.T) {
	dir := t.TempDir()
	secretsPath := filepath.Join(dir, secretstore.SecretsFileName)
	if err := os.Mkdir(secretsPath, 0o700); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	err := claudeApiKeyRun(dir, &buf)
	if err == nil || !strings.Contains(err.Error(), secretsPath) {
		t.Fatalf("err = %v, want one naming %s", err, secretsPath)
	}
	if strings.Contains(err.Error(), "no Claude API key is saved") {
		t.Errorf("err = %v, an unreadable file must not read as no key", err)
	}
}

func TestClaudeApiKeyNeedsConfigDir(t *testing.T) {
	var buf bytes.Buffer
	err := claudeApiKeyRun("", &buf)
	if err == nil || !strings.Contains(err.Error(), "--config-dir") {
		t.Errorf("err = %v, want one naming --config-dir", err)
	}
}
