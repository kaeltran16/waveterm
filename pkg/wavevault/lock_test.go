// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// lockWait is how long a contended LockRoot is given to (wrongly) succeed.
const lockWait = 100 * time.Millisecond

// acquiresWithin reports whether LockRoot(root) is acquired within d; the lock it takes is released.
func acquiresWithin(root string, d time.Duration) bool {
	got := make(chan func(), 1)
	go func() { got <- LockRoot(root) }()
	select {
	case unlock := <-got:
		unlock()
		return true
	case <-time.After(d):
		go func() { (<-got)() }() // release it once the holder lets go
		return false
	}
}

func TestLockRootSerializesSameRoot(t *testing.T) {
	root := t.TempDir()
	unlock := LockRoot(root)

	variants := []string{root + string(filepath.Separator), filepath.Join(root, "sub", "..")}
	if runtime.GOOS == "windows" {
		variants = append(variants, strings.ToUpper(root), strings.ToLower(root))
	}
	for _, v := range variants {
		if acquiresWithin(v, lockWait) {
			t.Fatalf("LockRoot(%q) acquired while %q is held", v, root)
		}
	}
	if !acquiresWithin(t.TempDir(), lockWait) {
		t.Fatal("a distinct root must not block")
	}

	released := make(chan func(), 1)
	go func() { released <- LockRoot(root) }()
	unlock()
	select {
	case u := <-released:
		u()
	case <-time.After(5 * time.Second):
		t.Fatal("LockRoot not acquired after unlock")
	}
}

func TestPokeIsNonBlockingAndDrainable(t *testing.T) {
	PokedForTest()
	Poke()
	Poke()
	if !PokedForTest() {
		t.Fatal("PokedForTest = false after Poke")
	}
	if PokedForTest() {
		t.Fatal("two pokes must coalesce into one pending poke")
	}
}

func TestCommitPokes(t *testing.T) {
	v, err := openVaultAt(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	PokedForTest()
	if err := v.Commit(context.Background(), "nothing"); err != nil {
		t.Fatal(err)
	}
	if PokedForTest() {
		t.Fatal("a Commit that commits nothing must not poke")
	}
	if err := os.WriteFile(filepath.Join(v.Root, "memory", "n.md"), []byte("note\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "note"); err != nil {
		t.Fatal(err)
	}
	if !PokedForTest() {
		t.Fatal("a Commit that committed must poke")
	}
}
