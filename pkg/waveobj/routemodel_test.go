// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import (
	"encoding/json"
	"testing"
)

func TestRoutePinModelJSONRoundTrip(t *testing.T) {
	pin := RoutePin{Runtime: "pi", Tier: "", Model: "opencode/deepseek-v4-pro"}
	raw, err := json.Marshal(pin)
	if err != nil {
		t.Fatal(err)
	}
	var got RoutePin
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Model != pin.Model || got.Runtime != pin.Runtime {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestRoutePinModelOmitEmpty(t *testing.T) {
	raw, _ := json.Marshal(RoutePin{Runtime: "claude", Tier: "capable"})
	if string(raw) != `{"runtime":"claude","tier":"capable"}` {
		t.Fatalf("empty model must be omitted, got %s", raw)
	}
}

func TestRunModelOmitEmpty(t *testing.T) {
	r := Run{Runtime: "pi", Model: "opencode/deepseek-v4-flash", Status: "executing"}
	raw, _ := json.Marshal(r)
	if !json.Valid(raw) {
		t.Fatalf("run must marshal with model set: %s", raw)
	}
	var got Run
	if json.Unmarshal(raw, &got) != nil || got.Model != r.Model {
		t.Fatalf("run model round trip failed: %+v", got)
	}
}
