// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import "testing"

func TestParseDecompose(t *testing.T) {
	goal := "add coupon codes"
	t.Run("valid array", func(t *testing.T) {
		got := ParseDecompose(`sure: ["add input","wire totals","write tests"] done`, goal)
		if len(got) != 3 || got[0] != "add input" || got[2] != "write tests" {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("no array falls back to goal", func(t *testing.T) {
		got := ParseDecompose("I cannot split this", goal)
		if len(got) != 1 || got[0] != goal {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("malformed json falls back to goal", func(t *testing.T) {
		got := ParseDecompose(`[not valid`, goal)
		if len(got) != 1 || got[0] != goal {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("empty array falls back to goal", func(t *testing.T) {
		got := ParseDecompose(`[]`, goal)
		if len(got) != 1 || got[0] != goal {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("blanks dropped and capped at 5", func(t *testing.T) {
		got := ParseDecompose(`["a","","b","c","d","e","f"]`, goal)
		if len(got) != 5 || got[0] != "a" || got[4] != "e" {
			t.Fatalf("got %#v", got)
		}
	})
}
