// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"errors"
	"testing"
)

func TestErrorNotConfigured(t *testing.T) {
	cases := []struct {
		missing []string
		want    string
	}{
		{[]string{"site", "email", "token"}, "EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your site, account email and API token in Settings > Jira."},
		{[]string{"token"}, "EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your API token in Settings > Jira."},
		{[]string{"site", "token"}, "EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your site and API token in Settings > Jira."},
	}
	for _, c := range cases {
		if got := (&NotConfiguredError{Missing: c.missing}).Error(); got != c.want {
			t.Errorf("missing %v:\n got %q\nwant %q", c.missing, got, c.want)
		}
	}
}

func TestErrorHTTP(t *testing.T) {
	got := (&HTTPError{Status: 401, Message: "Client must be authenticated"}).Error()
	if want := "EC-JIRA-HTTP 401: Client must be authenticated"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestErrorUnreachable(t *testing.T) {
	cause := errors.New("dial tcp: no such host")
	err := Unreachable(cause)
	if want := "EC-JIRA-UNREACHABLE: dial tcp: no such host"; err.Error() != want {
		t.Errorf("got %q want %q", err.Error(), want)
	}
	if !errors.Is(err, cause) {
		t.Error("Unreachable should wrap its cause")
	}
}

func TestNormalizeKey(t *testing.T) {
	cases := map[string]string{
		" pay-318 ": "PAY-318",
		"PAY-318 ":  "PAY-318",
		"ops-77":    "OPS-77",
		"A2-1":      "A2-1",
		"pay":       "",
		"":          "",
		"PAY-":      "",
		"-318":      "",
		"P-318":     "",
		"2PAY-318":  "",
		"PAY-31a":   "",
		"PAY 318":   "",
	}
	for in, want := range cases {
		if got := NormalizeKey(in); got != want {
			t.Errorf("NormalizeKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestProjectKey(t *testing.T) {
	cases := map[string]string{
		"PAY-318": "PAY",
		"GROW-12": "GROW",
		"pay":     "",
		"":        "",
	}
	for in, want := range cases {
		if got := ProjectKey(in); got != want {
			t.Errorf("ProjectKey(%q) = %q, want %q", in, got, want)
		}
	}
}
