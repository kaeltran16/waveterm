// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
package shellutil

import "testing"

func TestQuote(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantHard string
		wantSoft string
	}{
		{
			name:     "simple strings",
			input:    "simple",
			wantHard: "simple",
			wantSoft: "simple",
		},
		{
			name:     "safe path",
			input:    "path/to/file.txt",
			wantHard: "path/to/file.txt",
			wantSoft: "path/to/file.txt",
		},
		{
			name:     "empty string",
			input:    "",
			wantHard: `""`,
			wantSoft: `""`,
		},
		{
			name:     "tilde alone",
			input:    "~",
			wantHard: `"~"`,
			wantSoft: "~",
		},
		{
			name:     "tilde with safe path",
			input:    "~/foo",
			wantHard: `"~/foo"`,
			wantSoft: "~/foo",
		},
		{
			name:     "tilde with spaces",
			input:    "~/foo bar",
			wantHard: `"~/foo bar"`,
			wantSoft: `~"/foo bar"`,
		},
		{
			name:     "tilde with variable",
			input:    "~/foo$bar",
			wantHard: `"~/foo\$bar"`,
			wantSoft: `~"/foo$bar"`,
		},
		{
			name:     "invalid tilde path",
			input:    "~foo",
			wantHard: `"~foo"`,
			wantSoft: `"~foo"`,
		},
		{
			name:     "variable at start",
			input:    "$HOME/.config",
			wantHard: `"\$HOME/.config"`,
			wantSoft: `"$HOME/.config"`,
		},
		{
			name:     "variable in middle",
			input:    "prefix$HOME",
			wantHard: `"prefix\$HOME"`,
			wantSoft: `"prefix$HOME"`,
		},
		{
			name:     "double quotes",
			input:    `has "quotes"`,
			wantHard: `"has \"quotes\""`,
			wantSoft: `"has \"quotes\""`,
		},
		{
			name:     "backslash",
			input:    `back\slash`,
			wantHard: `"back\\slash"`,
			wantSoft: `"back\\slash"`,
		},
		{
			name:     "backtick",
			input:    "`cmd`",
			wantHard: "\"\\`cmd\\`\"",
			wantSoft: "\"\\`cmd\\`\"",
		},
		{
			name:     "spaces",
			input:    "spaces here",
			wantHard: `"spaces here"`,
			wantSoft: `"spaces here"`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := HardQuote(tt.input); got != tt.wantHard {
				t.Errorf("HardQuote(%q) = %q, want %q", tt.input, got, tt.wantHard)
			}
			if got := SoftQuote(tt.input); got != tt.wantSoft {
				t.Errorf("SoftQuote(%q) = %q, want %q", tt.input, got, tt.wantSoft)
			}
		})
	}
}

func TestHardQuotePowerShell(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		// an apostrophe is literal inside a PowerShell double-quoted string — it must pass
		// through untouched (the POSIX quoter split the arg here, breaking run-worker prompts).
		{name: "apostrophe passthrough", input: "the phase's deliverable", want: `"the phase's deliverable"`},
		// newline -> `n exactly once (regression: the raw newline used to also be appended).
		{name: "newline to backtick-n", input: "a\nb", want: "\"a`nb\""},
		{name: "dollar escaped", input: "$HOME", want: "\"`$HOME\""},
		{name: "double quote escaped", input: `say "hi"`, want: "\"say `\"hi`\"\""},
		{name: "backtick escaped", input: "a`b", want: "\"a``b\""},
		{name: "empty", input: "", want: `""`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := HardQuotePowerShell(tt.input); got != tt.want {
				t.Errorf("HardQuotePowerShell(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
