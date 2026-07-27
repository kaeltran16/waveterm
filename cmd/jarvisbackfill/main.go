// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Command jarvisbackfill imports recorded wstore history into the Wave Vault as a real dossier and
// decision corpus, so the second brain's tuning constants (J5) can be calibrated against something
// other than fabricated data.
//
// One-shot and idempotent. It never writes to the database it reads. Run --dry-run first, and point
// --vault at a throwaway copy before the real one.
//
//	go run ./cmd/jarvisbackfill --db <waveterm.db> --dry-run
//	go run ./cmd/jarvisbackfill --db <waveterm.db> --vault /tmp/probe-vault
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvisbackfill"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func main() {
	dbPath := flag.String("db", "", "path to waveterm.db (required)")
	vaultPath := flag.String("vault", "", "vault root to write (default: the configured vault)")
	dryRun := flag.Bool("dry-run", false, "print the plan without writing anything")
	flag.Parse()

	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "--db is required")
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*dbPath, *vaultPath, *dryRun); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(dbPath, vaultPath string, dryRun bool) error {
	runs, reports, err := jarvisbackfill.ReadHistory(dbPath)
	if err != nil {
		return err
	}
	plan := jarvisbackfill.BuildPlan(runs, reports, nowMillis())
	printPlan(runs, reports, plan)

	if dryRun {
		fmt.Println("\ndry run — nothing written")
		return nil
	}

	ctx := context.Background()
	var v *wavevault.Vault
	if vaultPath != "" {
		abs, err := filepath.Abs(vaultPath)
		if err != nil {
			return err
		}
		v, err = wavevault.OpenVaultAt(ctx, abs)
		if err != nil {
			return err
		}
		fmt.Printf("\nwriting to %s\n", abs)
	} else {
		v, err = wavevault.OpenVault(ctx)
		if err != nil {
			return err
		}
		fmt.Printf("\nwriting to the configured vault (%s)\n", wavevault.DefaultVaultRoot())
	}

	res, err := jarvisbackfill.Apply(ctx, v, plan)
	fmt.Printf("dossiers created: %d (existing: %d)  decisions created: %d (existing: %d)\n",
		res.DossiersCreated, res.DossiersExisting, res.DecisionsCreated, res.DecisionsExisting)
	for _, e := range res.Errors {
		fmt.Println("  error:", e)
	}
	return err
}

func printPlan(runs []*waveobj.Run, reports []*waveobj.RadarReport, p jarvisbackfill.Plan) {
	fmt.Printf("read %d runs, %d radar reports\n", len(runs), len(reports))
	fmt.Printf("plan: %d dossiers, %d decisions, %d skipped\n\n", len(p.Dossiers), len(p.Decisions), len(p.Skipped))

	multi := 0
	for _, d := range p.Dossiers {
		if len(d.RunOIDs) > 1 {
			multi++
		}
		fmt.Printf("  [%-9s] %d run(s)  %s\n", d.Status, len(d.RunOIDs), truncate(d.Facts.Objective, 62))
	}
	fmt.Printf("\nmulti-run dossiers (the ones that exercise D's mixed edges): %d\n", multi)

	if len(p.Skipped) > 0 {
		fmt.Printf("\nskipped:\n")
		for _, s := range p.Skipped {
			fmt.Printf("  %-22s %s\n", s.What, s.Why)
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func nowMillis() int64 { return time.Now().UnixMilli() }
