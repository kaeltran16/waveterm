// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRunRadarOriginRoundTrips(t *testing.T) {
	in := Run{
		ID:   "r1",
		Goal: "investigate",
		RadarOrigin: &RunRadarOrigin{
			ReportID:    "report-1",
			FindingID:   "finding-1",
			Fingerprint: "fp-9",
		},
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out Run
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.RadarOrigin == nil {
		t.Fatalf("radar origin lost on round-trip")
	}
	if out.RadarOrigin.ReportID != "report-1" || out.RadarOrigin.FindingID != "finding-1" || out.RadarOrigin.Fingerprint != "fp-9" {
		t.Errorf("origin ids not preserved: %+v", out.RadarOrigin)
	}
}

func TestRunOmitsRadarOriginWhenNil(t *testing.T) {
	b, err := json.Marshal(Run{ID: "r1", Goal: "g"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "radarorigin") {
		t.Errorf("nil origin must be omitted, got %s", b)
	}
	// an old run (no origin key) must deserialize with a nil origin
	var out Run
	if err := json.Unmarshal([]byte(`{"id":"r1","goal":"g","workspaceid":"w","projectpath":"/p","status":"done","phases":[],"createdts":1}`), &out); err != nil {
		t.Fatalf("legacy unmarshal: %v", err)
	}
	if out.RadarOrigin != nil {
		t.Errorf("legacy run must have nil origin, got %+v", out.RadarOrigin)
	}
}
