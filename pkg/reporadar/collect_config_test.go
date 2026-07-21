// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"
)

func TestCollectConfigUnpairedMigration(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "migrations/0007_session_ttl.up.sql", "alter table sessions add column ttl int;\n")
	// no paired .down.sql
	writeFile(t, dir, "migrations/0006_ok.up.sql", "create table a(id int);\n")
	writeFile(t, dir, "migrations/0006_ok.down.sql", "drop table a;\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "migrations")

	sigs, err := collectConfig(context.Background(), collectInput{projectPath: dir})
	if err != nil {
		t.Fatalf("collectConfig: %v", err)
	}
	var unpaired bool
	for _, s := range sigs {
		if s.SourceRef == "migration-unpaired:migrations/0007_session_ttl.up.sql" {
			unpaired = true
		}
		if s.SourceRef == "migration-unpaired:migrations/0006_ok.up.sql" {
			t.Fatal("paired migration must not be flagged")
		}
	}
	if !unpaired {
		t.Fatal("expected the unpaired 0007 migration to be flagged")
	}
}

func TestCollectConfigSecurityFacts(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "config/app.yaml", "cors:\n  origin: \"*\"\nauth_enabled: false\n")
	writeFile(t, dir, "config/safe.yaml", "feature_flag: true\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")

	sigs, err := collectConfig(context.Background(), collectInput{projectPath: dir})
	if err != nil {
		t.Fatalf("collectConfig: %v", err)
	}
	issues := map[string]bool{}
	for _, s := range sigs {
		if hasClass(s, ClassConfigSecurity) {
			issues[s.Facts["issue"].(string)] = true
			if s.Snippet != "" {
				t.Fatal("config-security signals must not carry a raw snippet (no secret exposure)")
			}
		}
	}
	if !issues["permissive-cors"] || !issues["disabled-auth"] {
		t.Fatalf("expected both config-security issues, got %v", issues)
	}
}
