// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	cases := []string{
		"key = sk-ABCDEF0123456789ABCDEF0123456789",           // sk- token
		"AWS=AKIAIOSFODNN7EXAMPLE",                             // aws access key id
		"ghp_0123456789abcdef0123456789abcdef0123",            // github token
		"password: hunter2secretlongvalue0987654321XZ",        // high-entropy assignment
		"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def", // jwt-ish
	}
	for _, in := range cases {
		out := Redact(in)
		if strings.Contains(out, "sk-ABCDEF") || strings.Contains(out, "AKIAIOSFODNN7EXAMPLE") ||
			strings.Contains(out, "ghp_0123456789abcdef") || strings.Contains(out, "hunter2secretlongvalue") {
			t.Fatalf("secret leaked: %q -> %q", in, out)
		}
		if !strings.Contains(out, "[REDACTED]") {
			t.Fatalf("expected redaction marker in %q", out)
		}
	}
	// plain text is untouched
	if Redact("just a normal sentence about coupons") != "just a normal sentence about coupons" {
		t.Fatal("plain text must be untouched")
	}
}
