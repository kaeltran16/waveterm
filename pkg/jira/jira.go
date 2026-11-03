// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jira is the only thing in Arc that talks to Jira Cloud (REST v3, basic auth with the
// JIRA_API_TOKEN secret). Its errors carry EC- codes that wsh prints as is and the cockpit parses.
package jira

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	SecretName        = "JIRA_API_TOKEN"
	CodeNotConfigured = "EC-JIRA-NOTCONFIGURED"
	CodeHTTP          = "EC-JIRA-HTTP"
	CodeUnreachable   = "EC-JIRA-UNREACHABLE"
)

// what each missing piece of setup is called in the not-configured message
var missingNames = map[string]string{
	"site":  "site",
	"email": "account email",
	"token": "API token",
}

type NotConfiguredError struct {
	Missing []string // site | email | token
}

func (e *NotConfiguredError) Error() string {
	names := make([]string, 0, len(e.Missing))
	for _, m := range e.Missing {
		if name, ok := missingNames[m]; ok {
			names = append(names, name)
		} else {
			names = append(names, m)
		}
	}
	return fmt.Sprintf("%s: Jira isn't set up: add your %s in Settings > Jira.", CodeNotConfigured, joinAnd(names))
}

// joinAnd reads "a", "a and b", "a, b and c".
func joinAnd(items []string) string {
	if len(items) <= 1 {
		return strings.Join(items, "")
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
}

// HTTPError is Jira answering with a non-2xx status; Message is Jira's own message.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("%s %d: %s", CodeHTTP, e.Status, e.Message)
}

type unreachableError struct {
	cause error
}

func (e *unreachableError) Error() string { return CodeUnreachable + ": " + e.cause.Error() }
func (e *unreachableError) Unwrap() error { return e.cause }

// Unreachable wraps a transport failure: Jira was never heard from.
func Unreachable(err error) error {
	return &unreachableError{cause: err}
}

var keyRe = regexp.MustCompile(`^[A-Z][A-Z0-9]+-\d+$`)

// NormalizeKey trims and uppercases a typed issue key, or returns "" when it is not key-shaped, so
// nothing that is not a key is ever sent to Jira.
func NormalizeKey(s string) string {
	key := strings.ToUpper(strings.TrimSpace(s))
	if !keyRe.MatchString(key) {
		return ""
	}
	return key
}

// ProjectKey is the project part of an issue key ("PAY-318" -> "PAY"), or "" for a non-key.
func ProjectKey(issueKey string) string {
	key := NormalizeKey(issueKey)
	if key == "" {
		return ""
	}
	return key[:strings.LastIndex(key, "-")]
}
