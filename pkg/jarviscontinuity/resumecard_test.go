// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarviscontinuity

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The boundary writes a struct into run.Meta and the object store hands it back as a decoded JSON map.
// Both shapes reach this reader, so a decode that only handles one of them loses the narrative at exactly
// the moment a launch read wants it.
func TestReadResumeCardHandlesBothMetaShapes(t *testing.T) {
	written := &waveobj.Run{Meta: waveobj.MetaMapType{
		MetaKeyResume: ResumeCard{TaskID: "task-1", Summary: "where it stands", Status: "paused", Updated: 42},
	}}
	roundTripped := &waveobj.Run{Meta: waveobj.MetaMapType{
		MetaKeyResume: map[string]any{"taskId": "task-1", "summary": "where it stands", "status": "paused", "updated": 42},
	}}
	for name, run := range map[string]*waveobj.Run{"as written": written, "after the store": roundTripped} {
		t.Run(name, func(t *testing.T) {
			card, ok := ReadResumeCard(run)
			if !ok {
				t.Fatal("narrative not read")
			}
			if card.TaskID != "task-1" || card.Summary != "where it stands" || card.Status != "paused" || card.Updated != 42 {
				t.Fatalf("card = %+v", card)
			}
		})
	}
}

func TestReadResumeCardRefusesDismissedAndEmpty(t *testing.T) {
	dismissed := &waveobj.Run{Meta: waveobj.MetaMapType{
		MetaKeyResume:          map[string]any{"summary": "still here"},
		MetaKeyResumeDismissed: true,
	}}
	if _, ok := ReadResumeCard(dismissed); ok {
		t.Fatal("a dismissed narrative must not be resurfaced")
	}
	// a boundary that produced no prose has nothing to resurface; the frontend reader agrees, and the two
	// disagreeing is how an empty card appears on one surface and not another.
	blank := &waveobj.Run{Meta: waveobj.MetaMapType{MetaKeyResume: map[string]any{"summary": "  \n "}}}
	if _, ok := ReadResumeCard(blank); ok {
		t.Fatal("a whitespace-only narrative must read as nothing")
	}
	for name, run := range map[string]*waveobj.Run{
		"nil run":    nil,
		"no meta":    {},
		"nil value":  {Meta: waveobj.MetaMapType{MetaKeyResume: nil}},
		"no summary": {Meta: waveobj.MetaMapType{MetaKeyResume: map[string]any{"taskId": "task-1"}}},
	} {
		t.Run(name, func(t *testing.T) {
			if card, ok := ReadResumeCard(run); ok {
				t.Fatalf("read a narrative that was never written: %+v", card)
			}
		})
	}
}
