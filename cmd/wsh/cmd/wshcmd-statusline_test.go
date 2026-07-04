// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
)

func TestParseStatusLineUsageFull(t *testing.T) {
	raw := []byte(`{"context_window":{"used_percentage":42.5,"context_window_size":1000000},
		"rate_limits":{"five_hour":{"used_percentage":63,"resets_at":1750700000},
		"seven_day":{"used_percentage":18,"resets_at":1751200000}},
		"cost":{"total_cost_usd":1.23}}`)
	u := parseStatusLineUsage(raw)
	if u == nil {
		t.Fatal("expected usage, got nil")
	}
	if u.ContextPct != 42.5 || u.ContextMax != 1000000 || u.CostUSD != 1.23 {
		t.Fatalf("scalar fields wrong: %+v", u)
	}
	if u.FiveHourPct == nil || *u.FiveHourPct != 63 || u.FiveHourReset == nil || *u.FiveHourReset != 1750700000 {
		t.Fatalf("five_hour wrong: %+v", u)
	}
	if u.WeekPct == nil || *u.WeekPct != 18 || u.WeekReset == nil || *u.WeekReset != 1751200000 {
		t.Fatalf("seven_day wrong: %+v", u)
	}
}

func TestParseStatusLineUsageNoRateLimits(t *testing.T) {
	raw := []byte(`{"context_window":{"used_percentage":10,"context_window_size":200000}}`)
	u := parseStatusLineUsage(raw)
	if u == nil {
		t.Fatal("expected usage, got nil")
	}
	if u.FiveHourPct != nil || u.WeekPct != nil {
		t.Fatalf("rate limits should be nil for API-key session: %+v", u)
	}
}

func TestParseStatusLineUsageNoContextIsNil(t *testing.T) {
	if u := parseStatusLineUsage([]byte(`{"cost":{"total_cost_usd":1}}`)); u != nil {
		t.Fatalf("expected nil when no context pct, got %+v", u)
	}
	if u := parseStatusLineUsage([]byte(`not json`)); u != nil {
		t.Fatalf("expected nil on bad json, got %+v", u)
	}
}

func TestRunInnerPassesThrough(t *testing.T) {
	out := string(runInner("echo hello-arc", nil))
	if !strings.Contains(out, "hello-arc") {
		t.Fatalf("inner stdout not passed through: %q", out)
	}
}

func TestRunInnerEmptyIsNoop(t *testing.T) {
	if out := runInner("", []byte("x")); len(out) != 0 {
		t.Fatalf("empty inner should produce no output, got %q", out)
	}
}
