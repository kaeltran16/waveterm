// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"
)

func TestCollectDependencyFloatingPins(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "package.json", `{
	  "dependencies": {
	    "jsonwebtoken": "^9.0.0",
	    "lodash": "^4.17.0",
	    "bcrypt": "5.1.0"
	  },
	  "devDependencies": {
	    "helmet": "~7.0.0"
	  }
	}`)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")

	sigs, err := collectDependency(context.Background(), collectInput{projectPath: dir})
	if err != nil {
		t.Fatalf("collectDependency: %v", err)
	}
	got := map[string]bool{}
	for _, s := range sigs {
		if !hasClass(s, ClassDependencyPin) {
			t.Fatalf("dependency signal missing dependency-pin class: %+v", s.Facts)
		}
		got[s.Facts["package"].(string)] = true
	}
	if !got["jsonwebtoken"] {
		t.Fatal("floating security-relevant dep jsonwebtoken must be flagged")
	}
	if !got["helmet"] {
		t.Fatal("floating security-relevant devDependency helmet must be flagged")
	}
	if got["lodash"] {
		t.Fatal("lodash is not security-relevant — must not be flagged")
	}
	if got["bcrypt"] {
		t.Fatal("bcrypt is pinned (5.1.0) — must not be flagged")
	}
}
