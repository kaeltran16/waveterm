// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"testing"
)

func TestCollectStructureClassifies(t *testing.T) {
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q")
	writeFile(t, dir, "src/pay.ts", "export const pay = () => {}\n")
	writeFile(t, dir, "src/pay.test.ts", "test('pay', () => {})\n")
	writeFile(t, dir, "src/refund.ts", "export const refund = () => {}\n") // production source, no adjacent test
	writeFile(t, dir, "migrations/0001_init.sql", "create table t(id int);\n")
	writeFile(t, dir, "config/app.yaml", "flag: true\n")
	writeFile(t, dir, "node_modules/dep/index.js", "module.exports = {}\n") // must be ignored
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")

	sigs, err := collectStructure(context.Background(), collectInput{projectPath: dir})
	if err != nil {
		t.Fatalf("collectStructure: %v", err)
	}
	kinds := map[string]int{}
	flagged := map[string]bool{}
	for _, s := range sigs {
		if k, ok := s.Facts["classes"]; ok {
			for _, cl := range k.([]string) {
				kinds[cl]++
			}
		}
		for _, p := range s.Paths {
			flagged[p] = true
			if p == "node_modules/dep/index.js" {
				t.Fatal("dependencies must be ignored")
			}
		}
	}
	if kinds["source-without-test"] == 0 {
		t.Fatal("expected a source-without-adjacent-test observation")
	}
	if !flagged["src/refund.ts"] {
		t.Fatal("unpaired production source refund.ts should be flagged")
	}
	if flagged["src/pay.ts"] {
		t.Fatal("source with an adjacent test (pay.ts) must not be flagged")
	}
}
