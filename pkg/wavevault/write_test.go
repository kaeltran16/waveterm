// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func writeVaultWithDossier(t *testing.T) (*Vault, string) {
	t.Helper()
	v, err := openVaultAt(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	content := "---\nid: t-1\nstatus: draft\ntitle: Keep This\n---\n\n" +
		"Human prose.\n\n<!-- jarvis:begin state -->\nold\n<!-- jarvis:end state -->\n"
	p := filepath.Join(v.Root, "tasks/active/t-1.md")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return v, p
}

var wspec = RegionSpec{MachineKeys: []string{"status"}, Blocks: []string{"state"}}

func TestWriteSplicesMachineRegionsOnly(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	res, err := v.Write("t-1", wspec, []RegionEdit{
		{Kind: FrontmatterKey, Name: "status", Value: "active"},
		{Kind: Block, Name: "state", Value: "new state"},
	}, base)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if res.Conflict {
		t.Fatal("no concurrent edit — Conflict must be false")
	}
	got := string(mustRead(t, p))
	if !contains(got, "status: active") || !contains(got, "new state") {
		t.Fatalf("machine regions not written:\n%s", got)
	}
	if !contains(got, "title: Keep This") || !contains(got, "Human prose.") {
		t.Fatalf("human regions altered:\n%s", got)
	}
	if res.Hash != ContentHash([]byte(got)) {
		t.Fatal("WriteResult.Hash must equal the new content hash")
	}
}

func TestWriteRejectsNonMachineEdit(t *testing.T) {
	v, _ := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, filepath.Join(v.Root, "tasks/active/t-1.md")))
	_, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "title", Value: "hijack"}}, base)
	if err == nil {
		t.Fatal("editing a human-owned key must be rejected")
	}
}

func TestWriteConflictWhenChangedUnderneath(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	staleBase := "deadbeef" // not the real hash -> simulates an edit since the caller last read
	res, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, staleBase)
	if err != nil {
		t.Fatalf("conflict is not an error: %v", err)
	}
	if !res.Conflict {
		t.Fatal("a baseHash mismatch must report Conflict=true")
	}
	// nothing written — the file is untouched, human wins
	if contains(string(mustRead(t, p)), "status: active") {
		t.Fatal("a conflicting write must NOT modify the file")
	}
	if len(res.ConflictRegions) == 0 {
		t.Fatal("ConflictRegions should name the targeted machine regions")
	}
}

func TestWriteTracksMachineHash(t *testing.T) {
	v, p := writeVaultWithDossier(t)
	base := ContentHash(mustRead(t, p))
	res, err := v.Write("t-1", wspec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}}, base)
	if err != nil {
		t.Fatal(err)
	}
	v.mu.Lock()
	got, ok := v.machineFiles[p]
	v.mu.Unlock()
	if !ok || got != res.Hash {
		t.Fatalf("machineFiles[%s] = %q,%v; want %q", p, got, ok, res.Hash)
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool { return indexOf(s, sub) >= 0 })()
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
