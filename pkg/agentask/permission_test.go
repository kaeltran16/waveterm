// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"bytes"
	"errors"
	"slices"
	"testing"
)

func TestPermissionChoices(t *testing.T) {
	const no = "No, tell Claude what to do"
	cases := []struct {
		tool        string
		suggestions bool
		want        []string
	}{
		{"Edit", true, []string{"Yes", "Yes, allow edits this session", no}},
		{"Edit", false, []string{"Yes", no}},
		{"Write", true, []string{"Yes", "Yes, allow edits this session", no}},
		{"MultiEdit", true, []string{"Yes", "Yes, allow edits this session", no}},
		{"NotebookEdit", false, []string{"Yes", no}},
		{"Bash", true, []string{"Yes", "Yes, don't ask again for this command", no}},
		{"Bash", false, []string{"Yes", no}},
		{"WebFetch", true, []string{"Yes", "Yes, don't ask again this session", no}},
		{"WebFetch", false, []string{"Yes", no}},
		{"ExitPlanMode", false, []string{"Yes, and use auto mode", "Yes, manually approve edits", "No, keep planning"}},
		{"ExitPlanMode", true, []string{"Yes, and use auto mode", "Yes, manually approve edits", "No, keep planning"}},
	}
	for _, c := range cases {
		if got := PermissionChoices(c.tool, c.suggestions); !slices.Equal(got, c.want) {
			t.Errorf("PermissionChoices(%q, %v) = %q, want %q", c.tool, c.suggestions, got, c.want)
		}
	}
}

// capturePermKeys swaps the keystroke sink and a fresh registry in, returning what was typed.
func capturePermKeys(t *testing.T) *[]sentKey {
	t.Helper()
	GlobalPermissions = MakePermissionRegistry()
	sent := &[]sentKey{}
	restore := SetSendInputForTest(func(blockId string, data []byte) error {
		*sent = append(*sent, sentKey{blockId, append([]byte(nil), data...)})
		return nil
	})
	t.Cleanup(restore)
	return sent
}

type sentKey struct {
	blockId string
	data    []byte
}

func editPermission(permId string, ts int64) PendingPermission {
	return PendingPermission{
		PermId:   permId,
		BlockId:  "b1",
		ToolName: "Edit",
		ToolKey:  "key-" + permId,
		Choices:  PermissionChoices("Edit", true),
		Ts:       ts,
	}
}

func TestDeliverPermissionKeys(t *testing.T) {
	down := []byte{0x1b, '[', 'B'}
	cases := []struct {
		name   string
		choice int
		want   [][]byte
	}{
		{"yes is enter", 0, [][]byte{{'\r'}}},
		{"the middle option is down, enter", 1, [][]byte{down, {'\r'}}},
		// Claude 2.1.322's Bash prompt adds "Yes, and switch to auto mode" before No, which the hook payload
		// does not show: down, down, enter would pick it
		{"no is escape, at any option count", 2, [][]byte{{0x1b}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sent := capturePermKeys(t)
			GlobalPermissions.Raise("block:b1", editPermission("p1", 100))
			if err := DeliverPermission("block:b1", "p1", c.choice); err != nil {
				t.Fatalf("deliver: %v", err)
			}
			if len(*sent) != len(c.want) {
				t.Fatalf("want %d writes, got %d: %q", len(c.want), len(*sent), *sent)
			}
			for i, k := range *sent {
				if k.blockId != "b1" || !bytes.Equal(k.data, c.want[i]) {
					t.Fatalf("write %d = %q to %s, want %q to b1", i, k.data, k.blockId, c.want[i])
				}
			}
			if got := GlobalPermissions.List("block:b1"); len(got) != 0 {
				t.Fatalf("delivered request still queued: %v", got)
			}
		})
	}
}

func TestDeliverPermissionRefusesQueued(t *testing.T) {
	sent := capturePermKeys(t)
	GlobalPermissions.Raise("block:b1", editPermission("p1", 100))
	GlobalPermissions.Raise("block:b1", editPermission("p2", 101))
	if err := DeliverPermission("block:b1", "p1", 0); !errors.Is(err, ErrPermissionQueued) {
		t.Fatalf("want ErrPermissionQueued with two waiting, got %v", err)
	}
	if len(*sent) != 0 {
		t.Fatalf("a refused delivery typed %q", *sent)
	}
	if got := GlobalPermissions.List("block:b1"); len(got) != 2 {
		t.Fatalf("a refused delivery changed the queue: %v", got)
	}
}

func TestDeliverPermissionNoPending(t *testing.T) {
	sent := capturePermKeys(t)
	if err := DeliverPermission("block:b1", "p1", 0); !errors.Is(err, ErrNoPendingPermission) {
		t.Fatalf("empty queue: want ErrNoPendingPermission, got %v", err)
	}
	GlobalPermissions.Raise("block:b1", editPermission("p1", 100))
	if err := DeliverPermission("block:b1", "stale", 0); !errors.Is(err, ErrNoPendingPermission) {
		t.Fatalf("stale permid: want ErrNoPendingPermission, got %v", err)
	}
	if len(*sent) != 0 {
		t.Fatalf("a refused delivery typed %q", *sent)
	}
	if got := GlobalPermissions.List("block:b1"); len(got) != 1 {
		t.Fatalf("a stale permid changed the queue: %v", got)
	}
}

func TestDeliverPermissionChoiceOutOfRange(t *testing.T) {
	sent := capturePermKeys(t)
	GlobalPermissions.Raise("block:b1", editPermission("p1", 100))
	for _, choice := range []int{-1, 3} {
		err := DeliverPermission("block:b1", "p1", choice)
		if err == nil || errors.Is(err, ErrNoPendingPermission) || errors.Is(err, ErrPermissionQueued) {
			t.Fatalf("choice %d: want a range error, got %v", choice, err)
		}
	}
	if len(*sent) != 0 {
		t.Fatalf("an out-of-range choice typed %q", *sent)
	}
	if got := GlobalPermissions.List("block:b1"); len(got) != 1 {
		t.Fatalf("an out-of-range choice changed the queue: %v", got)
	}
}

func TestDeliverPermissionDropsOnInjectError(t *testing.T) {
	capturePermKeys(t)
	restore := SetSendInputForTest(func(string, []byte) error { return errors.New("pty gone") })
	defer restore()
	GlobalPermissions.Raise("block:b1", editPermission("p1", 100))
	if err := DeliverPermission("block:b1", "p1", 1); err == nil {
		t.Fatal("want the send error")
	}
	if got := GlobalPermissions.List("block:b1"); len(got) != 0 {
		t.Fatalf("a mid-inject failure must drop the request (a retry would double-type): %v", got)
	}
}

func TestRetirePermissionByToolKey(t *testing.T) {
	GlobalPermissions = MakePermissionRegistry()
	GlobalPermissions.Raise("block:b1", editPermission("p1", 100))
	GlobalPermissions.Raise("block:b1", editPermission("p2", 100))
	GlobalPermissions.Raise("block:b2", editPermission("p1", 100))
	retired := GlobalPermissions.RetireKey("block:b1", "key-p1", 100)
	if len(retired) != 1 || retired[0].PermId != "p1" {
		t.Fatalf("retired %v, want only p1", retired)
	}
	if got := GlobalPermissions.List("block:b1"); len(got) != 1 || got[0].PermId != "p2" {
		t.Fatalf("queue after retire = %v, want only p2", got)
	}
	if got := GlobalPermissions.List("block:b2"); len(got) != 1 {
		t.Fatalf("another block's request was retired: %v", got)
	}
}

func TestRetirePermissionIgnoresEarlierStatus(t *testing.T) {
	GlobalPermissions = MakePermissionRegistry()
	GlobalPermissions.Raise("block:b1", editPermission("p1", 100))
	if retired := GlobalPermissions.RetireKey("block:b1", "key-p1", 99); len(retired) != 0 {
		t.Fatalf("a status older than the request retired it: %v", retired)
	}
	if retired := GlobalPermissions.RetireUpTo("block:b1", 99); len(retired) != 0 {
		t.Fatalf("a status older than the request retired it: %v", retired)
	}
	GlobalPermissions.Raise("block:b1", editPermission("p2", 200))
	retired := GlobalPermissions.RetireUpTo("block:b1", 150)
	if len(retired) != 1 || retired[0].PermId != "p1" {
		t.Fatalf("RetireUpTo(150) retired %v, want only p1", retired)
	}
	if got := GlobalPermissions.List("block:b1"); len(got) != 1 || got[0].PermId != "p2" {
		t.Fatalf("queue = %v, want only p2", got)
	}
}
