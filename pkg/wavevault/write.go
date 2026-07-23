// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// WriteResult reports the outcome of a Write. On a baseHash mismatch Conflict is true, nothing is
// written (the human's on-disk version wins), and ConflictRegions names the machine regions the
// caller was trying to write — the caller re-reads (Hash is the current on-disk hash) and retries.
type WriteResult struct {
	Hash            string
	Conflict        bool
	ConflictRegions []string
}

// Write splices the machine-region edits into the node identified by id, rejecting any change to a
// human-owned region and guarding against a concurrent external edit via baseHash. It writes to the
// working tree (staged on disk, not committed — see Commit) and records the machine hash for
// ownership-staged commits. baseHash == "" skips the concurrency check (a first write).
func (v *Vault) Write(id string, spec RegionSpec, edits []RegionEdit, baseHash string) (*WriteResult, error) {
	if err := editsInSpec(spec, edits); err != nil {
		return nil, err
	}
	path, err := v.resolvePath(id)
	if err != nil {
		return nil, err
	}
	cur, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	curHash := ContentHash(cur)
	if baseHash != "" && curHash != baseHash {
		return &WriteResult{Hash: curHash, Conflict: true, ConflictRegions: regionNames(edits)}, nil
	}
	newContent, err := spliceRegions(string(cur), edits)
	if err != nil {
		return nil, err
	}
	if err := validateMachineOnly(string(cur), newContent, spec); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(newContent), 0o644); err != nil {
		return nil, err
	}
	newHash := ContentHash([]byte(newContent))
	v.mu.Lock()
	v.machineFiles[path] = newHash
	v.mu.Unlock()
	return &WriteResult{Hash: newHash}, nil
}

func regionNames(edits []RegionEdit) []string {
	out := make([]string, 0, len(edits))
	for _, e := range edits {
		out = append(out, e.Name)
	}
	return out
}

// resolvePath finds the file backing a node id by scanning the node collections (writes are coarse
// and rare, so a scan is acceptable; attachments are binaries and are not searched).
func (v *Vault) resolvePath(id string) (string, error) {
	var found string
	for _, coll := range []string{CollTasks, CollDecisions, CollMemory} {
		_ = filepath.WalkDir(filepath.Join(v.Root, coll), func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			data, readErr := os.ReadFile(p)
			if readErr != nil {
				return nil
			}
			n, _ := parseNode(p, data)
			if n.ID == id {
				found = p
				return filepath.SkipAll
			}
			return nil
		})
		if found != "" {
			break
		}
	}
	if found == "" {
		return "", fmt.Errorf("wavevault: node %q not found", id)
	}
	return found, nil
}
