// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestMergeSettings(t *testing.T) {
	cases := []struct {
		name               string
		base, ours, theirs string // "" base = no common ancestor
		want               string
	}{
		{"changed ours only", `{"a":1,"b":1}`, `{"a":2,"b":1}`, `{"a":1,"b":1}`, `{"a":2,"b":1}`},
		{"changed theirs only", `{"a":1,"b":1}`, `{"a":1,"b":1}`, `{"a":1,"b":3}`, `{"a":1,"b":3}`},
		{"changed both: ours", `{"a":1}`, `{"a":2}`, `{"a":3}`, `{"a":2}`},
		{"deleted theirs, unchanged ours: deleted", `{"a":1,"b":1}`, `{"a":1,"b":1}`, `{"a":1}`, `{"a":1}`},
		{"deleted ours, changed theirs: theirs", `{"a":1,"b":1}`, `{"a":1}`, `{"a":1,"b":2}`, `{"a":1,"b":2}`},
		{"added on each side", `{}`, `{"a":1}`, `{"b":2}`, `{"a":1,"b":2}`},
		{"no base: union, ours wins a clash", "", `{"a":1,"c":1}`, `{"b":2,"c":2}`, `{"a":1,"b":2,"c":1}`},
		{
			"nested values compared by value, not formatting",
			`{"n":{"x":1,"y":2},"m":1}`,
			"{\n  \"n\": { \"y\": 2,  \"x\": 1 },\n  \"m\": 1\n}",
			`{"n":{"x":1,"y":2},"m":5}`,
			`{"n":{"x":1,"y":2},"m":5}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var base []byte
			if tc.base != "" {
				base = []byte(tc.base)
			}
			got, err := MergeSettings(base, []byte(tc.ours), []byte(tc.theirs))
			if err != nil {
				t.Fatalf("MergeSettings: %v", err)
			}
			if !strings.HasSuffix(string(got), "}\n") {
				t.Fatalf("output lacks a trailing newline: %q", got)
			}
			var gotV, wantV map[string]any
			if err := json.Unmarshal(got, &gotV); err != nil {
				t.Fatalf("output is not JSON: %v\n%s", err, got)
			}
			if err := json.Unmarshal([]byte(tc.want), &wantV); err != nil {
				t.Fatalf("bad want: %v", err)
			}
			if !reflect.DeepEqual(gotV, wantV) {
				t.Fatalf("merged = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestMergeSettingsOutputIsIndentedAndSorted(t *testing.T) {
	got, err := MergeSettings(nil, []byte(`{"b":{"y":1},"a":true}`), []byte(`{}`))
	if err != nil {
		t.Fatalf("MergeSettings: %v", err)
	}
	want := "{\n  \"a\": true,\n  \"b\": {\n    \"y\": 1\n  }\n}\n"
	if string(got) != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

func TestMergeSettingsRejectsMalformed(t *testing.T) {
	good := []byte(`{"a":1}`)
	for name, in := range map[string][3][]byte{
		"bad base":            {[]byte(`{"a":`), good, good},
		"bad ours":            {good, []byte(`not json`), good},
		"bad theirs":          {good, good, []byte(`{"a":1`)},
		"array, not object":   {good, []byte(`[1]`), good},
		"null, not an object": {good, good, []byte(`null`)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := MergeSettings(in[0], in[1], in[2]); err == nil {
				t.Fatalf("MergeSettings = nil error, want an error")
			}
		})
	}
}
