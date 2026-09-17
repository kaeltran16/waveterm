// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestAddressByCollection(t *testing.T) {
	parent := func(id string) string {
		if id == "d-owned" {
			return "t-1"
		}
		return ""
	}
	cases := []struct {
		name, collection, id, wantAddress, wantAnchor string
	}{
		{"a record addresses itself", CollTasks, "t-1", "task:t-1", ""},
		{"a memory node is a memory note", CollMemory, "m-1", "memnote:m-1", ""},
		{"a decision lands on its record, anchored", CollDecisions, "d-owned", "task:t-1", "d-owned"},
		{"a decision with no record has no address", CollDecisions, "d-orphan", "", ""},
		{"an attachment has no surface", CollAttachments, "a-1", "", ""},
	}
	for _, tc := range cases {
		gotAddress, gotAnchor := Address(tc.collection, tc.id, parent)
		if gotAddress != tc.wantAddress || gotAnchor != tc.wantAnchor {
			t.Errorf("%s: Address(%q, %q) = (%q, %q), want (%q, %q)",
				tc.name, tc.collection, tc.id, gotAddress, gotAnchor, tc.wantAddress, tc.wantAnchor)
		}
	}
}

func TestAddressWithNoParentLookupDropsADecision(t *testing.T) {
	if address, anchor := Address(CollDecisions, "d-1", nil); address != "" || anchor != "" {
		t.Fatalf("Address with a nil parent = (%q, %q), want no address", address, anchor)
	}
}

// a memory note can link a decision too; only a record owns one
func TestParentRecordIsTheRecordLinkingTheDecision(t *testing.T) {
	v, err := openVaultAt(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	write := func(rel, content string) {
		if err := os.WriteFile(filepath.Join(v.Root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("memory/m-1.md", "---\nid: m-1\n---\n\nMentions [[d-1]] as well.\n")
	write("tasks/active/t-1.md", "---\nid: t-1\nstatus: active\n---\n\nRefs: [[d-1]]\n")
	write("decisions/d-1.md", "---\nid: d-1\n---\n\nWe chose it.\n")

	r := v.Retriever(AllScope())
	if got := r.ParentRecord("d-1"); got != "t-1" {
		t.Fatalf("ParentRecord(d-1) = %q, want t-1", got)
	}
	if got := r.ParentRecord("d-unlinked"); got != "" {
		t.Fatalf("ParentRecord(d-unlinked) = %q, want none", got)
	}
}
