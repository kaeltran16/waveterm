// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import "testing"

func TestResolveRegisteredProject(t *testing.T) {
	projects := map[string]string{"payments-api": "/repos/payments-api"}
	name, err := resolveProjectName("/repos/payments-api", projects)
	if err != nil || name != "payments-api" {
		t.Fatalf("want payments-api, got %q err=%v", name, err)
	}
	if _, err := resolveProjectName("/repos/unknown", projects); err == nil {
		t.Fatal("unregistered path must be rejected")
	}
	if _, err := resolveProjectName("", projects); err == nil {
		t.Fatal("empty path must be rejected")
	}
}
