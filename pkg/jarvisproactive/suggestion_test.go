// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The evaluator writes a struct into run.Meta and the object store hands it back as a decoded JSON map.
// Both shapes reach this reader depending on whether the run has been through the DB yet, so a decode that
// only handles one of them fails at exactly the moment the refusal read matters.
func TestReadSuggestionHandlesBothMetaShapes(t *testing.T) {
	written := &waveobj.Run{Meta: waveobj.MetaMapType{
		MetaKeyProactive: ProactiveSuggestion{Status: StatusNone, Reason: ReasonEmbeddingsOff},
	}}
	roundTripped := &waveobj.Run{Meta: waveobj.MetaMapType{
		MetaKeyProactive: map[string]any{"status": StatusNone, "reason": ReasonEmbeddingsOff},
	}}
	for name, run := range map[string]*waveobj.Run{"as written": written, "after the store": roundTripped} {
		t.Run(name, func(t *testing.T) {
			sug, ok := ReadSuggestion(run)
			if !ok {
				t.Fatal("suggestion not read")
			}
			if sug.Status != StatusNone || sug.Reason != ReasonEmbeddingsOff {
				t.Fatalf("suggestion = %+v", sug)
			}
		})
	}
}

// "Never evaluated" and "evaluated and declined" are different answers — the pending sentinel exists
// precisely because they used to be indistinguishable, so a statusless record must not read as a verdict.
func TestReadSuggestionRejectsAbsentAndStatuslessRecords(t *testing.T) {
	cases := map[string]*waveobj.Run{
		"nil run":     nil,
		"no meta":     {},
		"empty meta":  {Meta: waveobj.MetaMapType{}},
		"nil value":   {Meta: waveobj.MetaMapType{MetaKeyProactive: nil}},
		"no status":   {Meta: waveobj.MetaMapType{MetaKeyProactive: map[string]any{"reason": ReasonQueryError}}},
		"wrong shape": {Meta: waveobj.MetaMapType{MetaKeyProactive: "not-an-object"}},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			if sug, ok := ReadSuggestion(run); ok {
				t.Fatalf("read a verdict that was never recorded: %+v", sug)
			}
		})
	}
}
