// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package tsgen

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// committed TS artifact generated from the Go wave-event contract by cmd/generatets/main-generatets.go
const waveEventTypesFile = "../../frontend/types/waveevent.d.ts"

func TestGenerateWaveEventTypes(t *testing.T) {
	tsTypesMap := make(map[reflect.Type]string)
	waveEventTypeDecl := GenerateWaveEventTypes(tsTypesMap)

	if !strings.Contains(waveEventTypeDecl, "type WaveEventName =\n    | \"blockclose\"") {
		t.Fatalf("expected multi-line WaveEventName union, got:\n%s", waveEventTypeDecl)
	}
	if !strings.Contains(waveEventTypeDecl, `{ event: "block:jobstatus"; data?: BlockJobStatusData; }`) {
		t.Fatalf("expected typed block:jobstatus event, got:\n%s", waveEventTypeDecl)
	}
	if !strings.Contains(waveEventTypeDecl, `{ event: "route:up"; data?: null; }`) {
		t.Fatalf("expected null for known no-data event, got:\n%s", waveEventTypeDecl)
	}
	if got := getWaveEventDataTSType("unmapped:event", tsTypesMap); got != "any" {
		t.Fatalf("expected any for unmapped event fallback, got: %q", got)
	}
	if _, found := tsTypesMap[reflect.TypeOf(wps.WaveEvent{})]; !found {
		t.Fatalf("expected WaveEvent type to be seeded in tsTypesMap")
	}
	if _, found := tsTypesMap[reflect.TypeOf(wshrpc.BlockJobStatusData{})]; !found {
		t.Fatalf("expected mapped data types to be generated into tsTypesMap")
	}
}

// TestWaveEventDataTypesCoverage guards the wps.AllEvents <-> WaveEventDataTypes
// contract (the checklist in pkg/wps/wpstypes.go): every event must carry an
// explicit data-type mapping (nil for no-data events) so a newly-added event
// cannot silently fall back to `any`, and no mapping may reference a dropped event.
func TestWaveEventDataTypesCoverage(t *testing.T) {
	for _, eventName := range wps.AllEvents {
		if _, found := WaveEventDataTypes[eventName]; !found {
			t.Errorf("wps.AllEvents entry %q has no WaveEventDataTypes mapping in tsgenevent.go (add one; use nil for no-data events)", eventName)
		}
	}
	known := make(map[string]bool, len(wps.AllEvents))
	for _, eventName := range wps.AllEvents {
		known[eventName] = true
	}
	for eventName := range WaveEventDataTypes {
		if !known[eventName] {
			t.Errorf("WaveEventDataTypes maps %q which is not in wps.AllEvents (orphan mapping)", eventName)
		}
	}
}

// TestWaveEventTypesInSync fails when the committed frontend TS artifact has drifted
// from what the Go contract generates -- i.e. a wave-event or its data type changed
// without running `task generate`. The static file header/footer is boilerplate, so
// only the generated body (the union + discriminated payload types) is compared.
func TestWaveEventTypesInSync(t *testing.T) {
	committed, err := os.ReadFile(waveEventTypesFile)
	if err != nil {
		t.Fatalf("read %s: %v", waveEventTypesFile, err)
	}
	generatedBody := utilfn.IndentString("    ", GenerateWaveEventTypes(make(map[reflect.Type]string)))
	if !strings.Contains(normalizeEOL(string(committed)), normalizeEOL(generatedBody)) {
		t.Fatalf("%s is out of sync with the Go wave-event contract; run `task generate`.\n--- expected to contain ---\n%s", waveEventTypesFile, generatedBody)
	}
}

func normalizeEOL(s string) string {
	return strings.ReplaceAll(s, "\r\n", "\n")
}
