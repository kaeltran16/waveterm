// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func TestLoadConfigMissing(t *testing.T) {
	// not restored: the store's debounced write lands up to a second later, and a restored empty dir would
	// make it write secrets.enc into the working directory
	wavebase.ConfigHome_VarCache = t.TempDir()
	if err := secretstore.DeleteSecret(SecretName); err != nil {
		t.Fatalf("clear token: %v", err)
	}
	prev := readSettings
	readSettings = func() wconfig.SettingsType { return wconfig.SettingsType{} }
	t.Cleanup(func() { readSettings = prev })

	_, err := LoadConfig()
	nc, ok := err.(*NotConfiguredError)
	if !ok {
		t.Fatalf("want *NotConfiguredError, got %T %v", err, err)
	}
	if want := []string{"site", "email", "token"}; !reflect.DeepEqual(nc.Missing, want) {
		t.Errorf("Missing = %v, want %v", nc.Missing, want)
	}
}

func TestLoadConfigComplete(t *testing.T) {
	wavebase.ConfigHome_VarCache = t.TempDir()
	if err := secretstore.SetSecret(SecretName, "tok"); err != nil {
		t.Fatalf("set token: %v", err)
	}
	t.Cleanup(func() { secretstore.DeleteSecret(SecretName) })
	prev := readSettings
	readSettings = func() wconfig.SettingsType {
		return wconfig.SettingsType{JiraSite: "https://acme.atlassian.net/", JiraEmail: " me@acme.com "}
	}
	t.Cleanup(func() { readSettings = prev })

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if want := (Config{Site: "https://acme.atlassian.net", Email: "me@acme.com", Token: "tok"}); cfg != want {
		t.Errorf("got %+v, want %+v", cfg, want)
	}
}

func TestNormalizeSite(t *testing.T) {
	ok := map[string]string{
		"https://acme.atlassian.net/":         "https://acme.atlassian.net",
		" https://Acme.atlassian.net/jira/x ": "https://acme.atlassian.net",
		"http://127.0.0.1:5555":               "http://127.0.0.1:5555",
		"http://localhost:8080/":              "http://localhost:8080",
		"https://localhost":                   "https://localhost",
	}
	for in, want := range ok {
		got, err := NormalizeSite(in)
		if err != nil || got != want {
			t.Errorf("NormalizeSite(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{
		"http://acme.atlassian.net",
		"https://example.com",
		"https://acme.atlassian.net.evil.com",
		"https://atlassian.net",
		"https://acme.atlassian.net:8443",
		"https://user@acme.atlassian.net",
		"acme.atlassian.net",
		"ftp://127.0.0.1",
		"",
	} {
		if got, err := NormalizeSite(in); err == nil {
			t.Errorf("NormalizeSite(%q) = %q, want an error", in, got)
		}
	}
}
