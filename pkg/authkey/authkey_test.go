// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"net/http/httptest"
	"testing"
)

func TestValidateIncomingRequest(t *testing.T) {
	authkey = "test-key" // set the package-level var directly (white-box test)

	cases := []struct {
		name    string
		url     string
		header  string
		wantErr bool
	}{
		{"valid header", "/ws", "test-key", false},
		{"valid query param, no header", "/ws?authkey=test-key", "", false},
		{"header wins over bad query", "/ws?authkey=bad", "test-key", false},
		{"no header, no query", "/ws", "", true},
		{"wrong query param", "/ws?authkey=bad", "", true},
		{"wrong header", "/ws", "bad", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tc.url, nil)
			if tc.header != "" {
				req.Header.Set(AuthKeyHeader, tc.header)
			}
			err := ValidateIncomingRequest(req)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected nil, got %v", err)
			}
		})
	}
}
