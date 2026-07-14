// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func seedProfileMeta(t *testing.T, ctx context.Context, id string, meta any) {
	t.Helper()
	if err := wstore.DBUpdateFn(ctx, id, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[jarvis.MetaKey_JarvisProfile] = meta
	}); err != nil {
		t.Fatalf("seeding meta: %v", err)
	}
}

func channelHasProfileMeta(t *testing.T, ctx context.Context, id string) bool {
	t.Helper()
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, id)
	if err != nil {
		t.Fatalf("reloading channel: %v", err)
	}
	return ch.Meta.HasKey(jarvis.MetaKey_JarvisProfile)
}

// stale replacement/disabled IDs must resolve away and surface as diagnostics without mutating the global list.
func TestGetJarvisProfileReturnsDiagnostics(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "diag-chan", "/repo")
	if err != nil {
		t.Fatal(err)
	}
	seedProfileMeta(t, ctx, ch.OID, &waveobj.ProfileOverride{
		Principles: &waveobj.PrinciplePatch{
			Replacements: map[string]string{"ghost-replace": "x"},
			Disabled:     []string{"ghost-disable"},
		},
	})
	rtn, err := (&WshServer{}).GetJarvisProfileCommand(ctx, wshrpc.CommandGetJarvisProfileData{ChannelId: ch.OID})
	if err != nil {
		t.Fatal(err)
	}
	if len(rtn.Global.Principles) != len(jarvis.DefaultPrinciples) {
		t.Fatalf("global principles: got %d want %d", len(rtn.Global.Principles), len(jarvis.DefaultPrinciples))
	}
	if len(rtn.Resolved.Principles) != len(jarvis.DefaultPrinciples) {
		t.Fatalf("resolved should ignore stale entries: got %d", len(rtn.Resolved.Principles))
	}
	codes := map[string]string{}
	for _, d := range rtn.PrincipleDiagnostics {
		codes[d.PrincipleID] = d.Code
	}
	if codes["ghost-replace"] != jarvis.DiagnosticMissingReplacement {
		t.Errorf("expected missing-replacement diagnostic, got %+v", rtn.PrincipleDiagnostics)
	}
	if codes["ghost-disable"] != jarvis.DiagnosticMissingDisabled {
		t.Errorf("expected missing-disabled diagnostic, got %+v", rtn.PrincipleDiagnostics)
	}
}

// a legacy project string persisted by old builds is surfaced to the FE as a normalized structured patch
// (disable every global + a single legacy-project addition) while resolving to its exact text.
func TestGetJarvisProfileNormalizesLegacyOverride(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "legacy-chan", "/repo")
	if err != nil {
		t.Fatal(err)
	}
	seedProfileMeta(t, ctx, ch.OID, map[string]any{"principles": "legacy project text"})
	rtn, err := (&WshServer{}).GetJarvisProfileCommand(ctx, wshrpc.CommandGetJarvisProfileData{ChannelId: ch.OID})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.Override == nil || rtn.Override.Principles == nil {
		t.Fatal("expected a structured override view")
	}
	adds := rtn.Override.Principles.Additions
	if len(adds) != 1 || adds[0].ID != waveobj.LegacyProjectPrincipleID || adds[0].Text != "legacy project text" {
		t.Fatalf("legacy not normalized to a project addition: %+v", rtn.Override.Principles)
	}
	if len(rtn.Override.Principles.Disabled) != len(jarvis.DefaultPrinciples) {
		t.Fatalf("legacy should disable all globals: %+v", rtn.Override.Principles.Disabled)
	}
	if got := jarvis.RenderPrinciples(rtn.Resolved.Principles); got != "legacy project text" {
		t.Fatalf("resolved legacy text mismatch: %q", got)
	}
}

func TestSetChannelProfileRejectsBlankText(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "blank-chan", "/repo")
	if err != nil {
		t.Fatal(err)
	}
	err = (&WshServer{}).SetChannelProfileCommand(ctx, wshrpc.CommandSetChannelProfileData{
		ChannelId: ch.OID,
		Override:  &waveobj.ProfileOverride{Principles: &waveobj.PrinciplePatch{Additions: []waveobj.Principle{{ID: "p1", Text: "   "}}}},
	})
	if err == nil {
		t.Fatal("expected validation error for blank addition text")
	}
	if channelHasProfileMeta(t, ctx, ch.OID) {
		t.Fatal("must not write channel meta on validation failure")
	}
}

func TestSetChannelProfileRejectsCollision(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "collide-chan", "/repo")
	if err != nil {
		t.Fatal(err)
	}
	err = (&WshServer{}).SetChannelProfileCommand(ctx, wshrpc.CommandSetChannelProfileData{
		ChannelId: ch.OID,
		Override:  &waveobj.ProfileOverride{Principles: &waveobj.PrinciplePatch{Additions: []waveobj.Principle{{ID: jarvis.DefaultPrinciples[0].ID, Text: "dup"}}}},
	})
	if err == nil {
		t.Fatal("expected error for addition id colliding with a global principle")
	}
	if channelHasProfileMeta(t, ctx, ch.OID) {
		t.Fatal("must not write channel meta on collision")
	}
}

func TestSetChannelProfileStoresPatch(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "store-chan", "/repo")
	if err != nil {
		t.Fatal(err)
	}
	disableID := jarvis.DefaultPrinciples[2].ID
	if err := (&WshServer{}).SetChannelProfileCommand(ctx, wshrpc.CommandSetChannelProfileData{
		ChannelId: ch.OID,
		Override:  &waveobj.ProfileOverride{Principles: &waveobj.PrinciplePatch{Disabled: []string{disableID}}},
	}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := wstore.DBMustGet[*waveobj.Channel](ctx, ch.OID)
	if err != nil {
		t.Fatal(err)
	}
	ov := jarvis.OverrideFromMeta(reloaded)
	if ov == nil || ov.Principles == nil {
		t.Fatal("expected a stored principle patch")
	}
	if len(ov.Principles.Disabled) != 1 || ov.Principles.Disabled[0] != disableID {
		t.Fatalf("stored patch mismatch: %+v", ov.Principles)
	}
}

func TestSetChannelProfileOmitsEmptyPatchAndDeletes(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "empty-chan", "/repo")
	if err != nil {
		t.Fatal(err)
	}
	seedProfileMeta(t, ctx, ch.OID, &waveobj.ProfileOverride{Principles: &waveobj.PrinciplePatch{Disabled: []string{jarvis.DefaultPrinciples[0].ID}}})
	if err := (&WshServer{}).SetChannelProfileCommand(ctx, wshrpc.CommandSetChannelProfileData{
		ChannelId: ch.OID,
		Override:  &waveobj.ProfileOverride{Principles: &waveobj.PrinciplePatch{}},
	}); err != nil {
		t.Fatal(err)
	}
	if channelHasProfileMeta(t, ctx, ch.OID) {
		t.Fatal("an all-empty patch should be omitted and the empty override should delete the key")
	}
}
