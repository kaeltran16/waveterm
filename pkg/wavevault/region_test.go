// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"strings"
	"testing"
)

const seeded = "---\nid: t-1\nstatus: draft\ntitle: My Task\n---\n\n" +
	"Human prose that must never change.\n\n" +
	"<!-- jarvis:begin state -->\nold summary\n<!-- jarvis:end state -->\n\nMore human prose.\n"

var spec = RegionSpec{MachineKeys: []string{"status"}, Blocks: []string{"state"}}

func TestSpliceFrontmatterKey(t *testing.T) {
	out, err := spliceRegions(seeded, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active"}})
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(out, "status: active") || strings.Contains(out, "status: draft") {
		t.Fatalf("status not updated:\n%s", out)
	}
	if !strings.Contains(out, "title: My Task") || !strings.Contains(out, "Human prose that must never change.") {
		t.Fatalf("human regions altered:\n%s", out)
	}
}

func TestSpliceBlockReplacesBetweenMarkers(t *testing.T) {
	out, err := spliceRegions(seeded, []RegionEdit{{Kind: Block, Name: "state", Value: "new summary"}})
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(out, "new summary") || strings.Contains(out, "old summary") {
		t.Fatalf("block not replaced:\n%s", out)
	}
	if !strings.Contains(out, "<!-- jarvis:begin state -->") || !strings.Contains(out, "<!-- jarvis:end state -->") {
		t.Fatalf("markers lost:\n%s", out)
	}
	if !strings.Contains(out, "More human prose.") {
		t.Fatalf("human prose after the block lost:\n%s", out)
	}
}

func TestSpliceAddsNewMachineFrontmatterKey(t *testing.T) {
	out, err := spliceRegions(seeded, []RegionEdit{{Kind: FrontmatterKey, Name: "confidence", Value: "high"}})
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(out, "confidence: high") {
		t.Fatalf("new key not added:\n%s", out)
	}
	if err := validateMachineOnly(seeded, out, RegionSpec{MachineKeys: []string{"status", "confidence"}, Blocks: []string{"state"}}); err != nil {
		t.Fatalf("adding a machine key must pass validation: %v", err)
	}
}

func TestSpliceBlockAbsentErrors(t *testing.T) {
	_, err := spliceRegions("---\nid: x\n---\n\nno block here\n", []RegionEdit{{Kind: Block, Name: "state", Value: "v"}})
	if err == nil {
		t.Fatal("writing an absent block must error (B scaffolds blocks)")
	}
}

func TestEditsInSpecRejectsUnownedRegion(t *testing.T) {
	if err := editsInSpec(spec, []RegionEdit{{Kind: FrontmatterKey, Name: "title", Value: "hijack"}}); err == nil {
		t.Fatal("editing a non-machine key must be rejected")
	}
	if err := editsInSpec(spec, []RegionEdit{{Kind: Block, Name: "notmine", Value: "x"}}); err == nil {
		t.Fatal("editing a non-machine block must be rejected")
	}
	if err := editsInSpec(spec, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "ok"}}); err != nil {
		t.Fatalf("editing a machine key must be allowed: %v", err)
	}
}

func TestValidateRejectsHumanRegionInjection(t *testing.T) {
	// a value that tries to inject a second frontmatter key must be caught by the diff-validator
	out, _ := spliceRegions(seeded, []RegionEdit{{Kind: FrontmatterKey, Name: "status", Value: "active\ntitle: HIJACKED"}})
	if err := validateMachineOnly(seeded, out, spec); err == nil {
		t.Fatal("an injected human key must fail validation")
	}
}
