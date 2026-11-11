//go:build windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package usagestats

import (
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// lockExclusive opens path with no sharing, as an antivirus or backup scan can, until the returned func runs.
func lockExclusive(t *testing.T, path string) func() {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	return func() { windows.CloseHandle(h) }
}

// a read that fails once must not cache a finished transcript as "no usage": its mtime and size never
// change again, so its usage would stay missing until restart
func TestCachedParseRetriesAFileWhoseReadFailed(t *testing.T) {
	cases := map[string]scanKind{"claude": scanClaude, "codex": scanCodex, "pi": scanPi}
	bodies := map[string]string{
		"claude": claudeTurnLine("a", time.Now(), 5, "/repo"),
		"codex":  `{"type":"session_meta","timestamp":"2026-08-11T03:00:00Z","payload":{"cwd":"/repo"}}` + "\n",
		"pi":     piFixture + "\n",
	}
	for name, kind := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeScanFile(t, bodies[name], t.TempDir(), name+".jsonl")
			f := scanFile{path: path, kind: kind}
			unlock := lockExclusive(t, path)
			cachedParse(f)
			unlock()
			if p := cachedParse(f); p.cwd == "" {
				t.Errorf("parse after the lock = %+v, want the file read", p)
			}
		})
	}
}
