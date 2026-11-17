// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Command gomutate scores how well a tree's tests catch changes to the Go lines it added since a base
// commit. It mutates only non-test, non-generated lines of git diff base..HEAD, tests each mutant through
// go test -overlay so the tree is never edited, and prints the bench's shared mutation JSON on stdout.
// Per-mutant progress goes to stderr.
//
//	go run ./cmd/gomutate --dir <tree> --base <sha> [--max 200] [--seed 1] [--timeout 120s]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	dir := flag.String("dir", "", "git tree to score, at its HEAD (required)")
	base := flag.String("base", "", "commit the diff starts from (required)")
	limit := flag.Int("max", 200, "above this many mutants, test a seeded random sample of this size")
	seed := flag.Uint64("seed", 1, "seed for the sample")
	timeout := flag.Duration("timeout", 120*time.Second, "test run time after which a mutant counts as timedOut")
	flag.Parse()

	if *dir == "" || *base == "" {
		fmt.Fprintln(os.Stderr, "--dir and --base are required")
		flag.Usage()
		os.Exit(2)
	}
	rep, err := Run(Config{Dir: *dir, Base: *base, Max: *limit, Seed: *seed, Timeout: *timeout, Progress: os.Stderr})
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(rep); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
