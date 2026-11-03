// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

type Config struct {
	Site  string
	Email string
	Token string
}

// a seam for tests: the watcher singleton watches real config dirs
var readSettings = func() wconfig.SettingsType {
	return wconfig.GetWatcher().GetFullConfig().Settings
}

// LoadConfig reads jira:site, jira:email and the JIRA_API_TOKEN secret, and returns a
// *NotConfiguredError naming whatever is missing.
func LoadConfig() (Config, error) {
	settings := readSettings()
	var missing []string
	site := strings.TrimSpace(settings.JiraSite)
	if site == "" {
		missing = append(missing, "site")
	}
	email := strings.TrimSpace(settings.JiraEmail)
	if email == "" {
		missing = append(missing, "email")
	}
	token, ok, err := secretstore.GetSecret(SecretName)
	if err != nil {
		return Config{}, fmt.Errorf("reading the Jira API token: %w", err)
	}
	if !ok || token == "" {
		missing = append(missing, "token")
	}
	if len(missing) > 0 {
		return Config{}, &NotConfiguredError{Missing: missing}
	}
	site, err = NormalizeSite(site)
	if err != nil {
		return Config{}, err
	}
	return Config{Site: site, Email: email, Token: token}, nil
}

var cloudHostRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*\.atlassian\.net$`)

// loopback sites are for the CDP fixtures' fake Jira: the token never leaves the machine
var loopbackHosts = map[string]bool{"127.0.0.1": true, "localhost": true}

// NormalizeSite accepts https://<name>.atlassian.net, or an http(s) loopback site with any port, and
// returns scheme://host with any path dropped.
func NormalizeSite(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" || u.User != nil {
		return "", fmt.Errorf("Jira site %q is not a URL like https://<name>.atlassian.net", trimmed)
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	switch {
	case loopbackHosts[host] && (scheme == "http" || scheme == "https"):
		return scheme + "://" + strings.ToLower(u.Host), nil
	case scheme == "https" && u.Port() == "" && cloudHostRe.MatchString(host):
		return scheme + "://" + host, nil
	}
	return "", fmt.Errorf("Jira site %q is not a URL like https://<name>.atlassian.net", trimmed)
}
