// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestParseSimpleId(t *testing.T) {
	const u = "11111111-1111-1111-1111-111111111111"
	tests := []struct {
		in       string
		wantDisc string
		wantVal  string
		wantErr  bool
	}{
		{"this", "this", "this", false},
		{"block", "this", "block", false},
		{"tab", "this", "tab", false},
		{"ws", "this", "ws", false},
		{"workspace", "this", "workspace", false},
		{"client", "this", "client", false},
		{"global", "this", "global", false},
		{"temp", "this", "temp", false},
		{"oref@block:" + u, "oref", "block:" + u, false}, // explicit @ discriminator, first field wins
		{"block:" + u, "oref", "block:" + u, false},      // implicit oref (valid type + uuid)
		{"tab:2", "tabnum", "tab:2", false},              // not an oref: "2" is not a uuid
		{"ai", "view", "ai", false},
		{"ai:2", "view", "ai:2", false},
		{"7", "blocknum", "7", false},
		{u, "uuid", u, false},
		{"abcd1234", "uuid8", "abcd1234", false},
		{"", "", "", true},
		{"!!!", "", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			disc, val, err := parseSimpleId(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got (%q,%q)", tt.in, disc, val)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", tt.in, err)
			}
			if disc != tt.wantDisc || val != tt.wantVal {
				t.Fatalf("parseSimpleId(%q) = (%q,%q), want (%q,%q)", tt.in, disc, val, tt.wantDisc, tt.wantVal)
			}
		})
	}
}

func TestResolveSimpleIdRouting(t *testing.T) {
	wstore.SetClientId("test-client") // make the client/global branch deterministic (avoids dev-mode panic)
	const u = "11111111-1111-1111-1111-111111111111"
	blk := func(id string) *waveobj.ORef { return &waveobj.ORef{OType: waveobj.OType_Block, OID: id} }
	client := &waveobj.ORef{OType: waveobj.OType_Client, OID: "test-client"}

	tests := []struct {
		name      string
		id        string
		blockId   string
		want      *waveobj.ORef // expected oref when wantErr is false
		wantErr   bool
		errSubstr string // asserted (when set) as a substring of err.Error()
	}{
		// DB-free success: routing resolves without touching the store
		{name: "this resolves to current block", id: "this", blockId: "blk-1", want: blk("blk-1")},
		{name: "block resolves to current block", id: "block", blockId: "blk-1", want: blk("blk-1")},
		{name: "client resolves to client oref", id: "client", blockId: "blk-1", want: client},
		{name: "global resolves to client oref", id: "global", blockId: "blk-1", want: client},
		{name: "explicit oref parses", id: "block:" + u, blockId: "blk-1", want: blk(u)},
		// DB-free error paths
		{name: "explicit oref with bad body errors", id: "oref@notanoref", blockId: "blk-1", wantErr: true, errSubstr: "error parsing oref"},
		{name: "this without blockid errors", id: "this", blockId: "", wantErr: true, errSubstr: "no blockid in request"},
		{name: "view instance zero errors", id: "ai:0", blockId: "blk-1", wantErr: true, errSubstr: "invalid view instance number"},
		{name: "unknown discriminator errors", id: "x@y", blockId: "blk-1", wantErr: true, errSubstr: "unknown discriminator"},
		// routing to DB-backed resolvers: empty store yields resolver-specific wrapper
		{name: "tabnum routes to resolveTabNum", id: "tab:2", blockId: "nope", wantErr: true, errSubstr: "error finding tab for block"},
		{name: "blocknum routes to resolveBlock", id: "7", blockId: "nope", wantErr: true, errSubstr: "error finding tab for blockid"},
		{name: "temp routes to resolveThis temp", id: "temp", blockId: "nope", wantErr: true, errSubstr: "error getting client"},
		{name: "uuid routes to resolveUUID", id: u, blockId: "nope", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := wshrpc.CommandResolveIdsData{BlockId: tt.blockId}
			got, err := resolveSimpleId(context.Background(), data, tt.id)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got oref %+v", got)
				}
				if tt.errSubstr != "" && !strings.Contains(err.Error(), tt.errSubstr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.errSubstr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got == nil || *got != *tt.want {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestResolveIdsCommand(t *testing.T) {
	ws := &WshServer{}
	ctx := context.Background()
	blockRef := waveobj.ORef{OType: waveobj.OType_Block, OID: "blk-1"}

	// empty ids -> empty map, no error
	rtn, err := ws.ResolveIdsCommand(ctx, wshrpc.CommandResolveIdsData{BlockId: "blk-1"})
	if err != nil {
		t.Fatalf("empty: unexpected error: %v", err)
	}
	if len(rtn.ResolvedIds) != 0 {
		t.Fatalf("empty: want 0 resolved, got %d", len(rtn.ResolvedIds))
	}

	// single valid id -> resolved, no error
	rtn, err = ws.ResolveIdsCommand(ctx, wshrpc.CommandResolveIdsData{BlockId: "blk-1", Ids: []string{"this"}})
	if err != nil {
		t.Fatalf("single valid: unexpected error: %v", err)
	}
	if rtn.ResolvedIds["this"] != blockRef {
		t.Fatalf("single valid: got %+v, want %+v", rtn.ResolvedIds["this"], blockRef)
	}

	// single invalid id -> first error surfaced (len(Ids)==1 rule)
	if _, err := ws.ResolveIdsCommand(ctx, wshrpc.CommandResolveIdsData{BlockId: "blk-1", Ids: []string{"!!!"}}); err == nil {
		t.Fatal("single invalid: expected error")
	}

	// multiple ids, one invalid -> error suppressed, valid ids still resolved
	rtn, err = ws.ResolveIdsCommand(ctx, wshrpc.CommandResolveIdsData{BlockId: "blk-1", Ids: []string{"this", "!!!"}})
	if err != nil {
		t.Fatalf("mixed: error must be suppressed for multi-id, got %v", err)
	}
	if rtn.ResolvedIds["this"] != blockRef {
		t.Fatalf("mixed: valid id not resolved: %+v", rtn.ResolvedIds)
	}
	if _, ok := rtn.ResolvedIds["!!!"]; ok {
		t.Fatal("mixed: invalid id must not be in resolved map")
	}
}
