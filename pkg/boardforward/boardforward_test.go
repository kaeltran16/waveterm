// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardforward

import (
	"strings"
	"testing"
)

func TestMarker(t *testing.T) {
	cases := []struct {
		name                   string
		board, on, turnId, ask string
		want                   string
	}{
		{
			name:  "with a selection",
			board: "Auth flow", on: "Login box, Token store", turnId: "t-1", ask: "why two stores?",
			want: "[From board \"Auth flow\" · on Login box, Token store · turn t-1]\nwhy two stores?",
		},
		{
			name:  "nothing selected leaves the on part out",
			board: "Auth flow", on: "", turnId: "t-2", ask: "what is this?",
			want: "[From board \"Auth flow\" · turn t-2]\nwhat is this?",
		},
		{
			name:  "multi-line name and labels collapse to one line each",
			board: "Auth\n flow\r\n", on: "Login\nbox,  Token\n\nstore", turnId: "t-3", ask: "line one\nline two",
			want: "[From board \"Auth flow\" · on Login box, Token store · turn t-3]\nline one\nline two",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Marker(tc.board, tc.on, tc.turnId, tc.ask)
			if got != tc.want {
				t.Errorf("Marker:\n got %q\nwant %q", got, tc.want)
			}
			if strings.HasPrefix(got, "/") {
				t.Errorf("the typed message must not start with a slash: %q", got)
			}
		})
	}
}

func TestMarkerNeverStartsWithSlash(t *testing.T) {
	got := Marker("/clear", "/etc", "t-4", "/compact")
	if strings.HasPrefix(got, "/") {
		t.Errorf("a board named like a command made a slash command: %q", got)
	}
}
