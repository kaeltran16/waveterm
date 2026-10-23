// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package runroute

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// ModelEntry is one selectable model for a runtime, sourced from the harness itself: enumerated
// (pi), derived from the harness's own surface (claude --help aliases, codex config), or
// free-form (accepted everywhere, never listed here). Never a maintained static catalog.
type ModelEntry struct {
	Runtime     string
	Model       string // exact id handed to the harness; pi includes the provider prefix
	Provider    string // pi: provider column; else ""
	ContextHint string // pi: context column; else ""
	Default     bool   // the harness's own configured default (claude settings.json / codex config.toml)
}

// catalogCommand is the exec seam; tests replace it to feed fixtures and count calls.
var catalogCommand = func(ctx context.Context, bin string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	// pi is pi.cmd on Windows: the deadline kills the shim, its node child keeps the output pipe open, and the
	// listing waited on that pipe for as long as pi hung
	cmd.WaitDelay = catalogWaitDelay
	return cmd.CombinedOutput()
}

// each enumeration's own deadline, apart from whoever asked: a cold `pi --list-models` measured 4.5-6.7s under load
const catalogProbeTimeout = 15 * time.Second

// how long a listing past its deadline still waits for its output pipe to close
const catalogWaitDelay = 2 * time.Second

var (
	piContextRe      = regexp.MustCompile(`^[0-9][0-9.]*[KMB]?$`)
	claudeAliasOutRe = regexp.MustCompile(`'([a-zA-Z0-9]+)'`)
)

func enumerateCatalog(ctx context.Context, runtime string) ([]ModelEntry, error) {
	var entries []ModelEntry
	var err error
	switch runtime {
	case "pi":
		entries, err = enumeratePi(ctx)
	case "claude":
		entries, err = enumerateClaude(ctx)
	case "codex":
		entries, err = enumerateCodex(ctx)
	default:
		return nil, fmt.Errorf("no catalog source for runtime %q", runtime)
	}
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("%s exposed no parseable models", runtime)
	}
	return entries, nil
}

// enumeratePi parses `pi --list-models`. Unparseable output yields zero entries with a nil error:
// garbage degrades to free-form-only rather than failing the whole catalog.
func enumeratePi(ctx context.Context) ([]ModelEntry, error) {
	out, err := catalogCommand(ctx, "pi", "--list-models")
	if err != nil {
		return nil, err
	}
	var entries []ModelEntry
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] == "provider" {
			continue // header, blank, or noise
		}
		if !piContextRe.MatchString(fields[2]) {
			continue // the context column anchors the table shape; anything else is not a row
		}
		entries = append(entries, ModelEntry{Runtime: "pi", Provider: fields[0], Model: fields[0] + "/" + fields[1], ContextHint: fields[2]})
	}
	return entries, nil
}

// enumerateClaude derives the alias set from `claude --help` — aliases are stable by design so this
// never rots, and full dated ids ride the free-form path instead of a shipped list.
func enumerateClaude(ctx context.Context) ([]ModelEntry, error) {
	out, err := catalogCommand(ctx, "claude", "--help")
	if err != nil {
		return nil, err
	}
	var entries []ModelEntry
	lines := strings.Split(string(out), "\n")
	for i, line := range lines {
		if !strings.Contains(line, "--model") {
			continue
		}
		joined := strings.Join(lines[i:min(i+3, len(lines))], " ")
		seen := map[string]bool{}
		for _, m := range claudeAliasOutRe.FindAllStringSubmatch(joined, -1) {
			if !seen[m[1]] {
				seen[m[1]] = true
				entries = append(entries, ModelEntry{Runtime: "claude", Model: m[1]})
			}
		}
		break
	}
	if defaultModel := claudeSettingsDefault(); defaultModel != "" {
		entries = append([]ModelEntry{{Runtime: "claude", Model: defaultModel, Default: true}}, entries...)
	}
	return entries, nil
}

// claudeSettingsDefault reads the operator's own model choice from ~/.claude/settings.json, the
// same file claude reads — that is the "CLI default" picker row.
func claudeSettingsDefault() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return ""
	}
	return strings.TrimSpace(cfg.Model)
}

func enumerateCodex(ctx context.Context) ([]ModelEntry, error) {
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = home
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".codex", "config.toml"))
	if err != nil {
		return nil, err
	}
	return parseCodexConfig(string(raw))
}

// parseCodexConfig line-scans the operator's config for `model = "…"` values — top-level is the
// active default, [profiles.*] entries are named alternates. A hand parser is enough; adding a TOML
// dependency for one key would be over-engineering.
func parseCodexConfig(raw string) ([]ModelEntry, error) {
	modelRe := regexp.MustCompile(`^\s*model\s*=\s*["']([^"']+)["']\s*$`)
	var entries []ModelEntry
	inSection := false
	topLevelSeen := false
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			inSection = true
			continue
		}
		m := modelRe.FindStringSubmatch(trimmed)
		if m == nil {
			continue
		}
		def := !inSection && !topLevelSeen
		if !inSection {
			topLevelSeen = true
		}
		entries = append(entries, ModelEntry{Runtime: "codex", Model: m[1], Default: def})
	}
	return entries, nil
}

// In-process catalog cache: model lists rotate slowly, probe spawns are not free, and repeated
// ListHarnesses calls (every picker open / launch compose) must not re-run three CLIs per open.
// Manual refresh busts it; there is deliberately no on-disk persistence — re-deriving at boot is
// cheap and a file cache would only add staleness.
//
// An enumeration runs once per runtime at a time, on its own deadline rather than its caller's. It used to run
// on the caller's, one runtime after another under one lock: a slow `pi --list-models` spent a picker's whole
// budget, claude was then enumerated on an expired context, nothing was cached, and the next open paid it all
// again from cold. A caller now stops waiting at its deadline while the enumeration finishes for the next one.

type catalogEntry struct {
	models  []ModelEntry
	fetched time.Time
}

var (
	catalogMu    sync.Mutex
	catalogCache = map[string]catalogEntry{}
	// closed when the runtime's in-flight enumeration has written its result
	catalogLoads = map[string]chan struct{}{}
	nowFn        = time.Now // clock seam for tests
)

const catalogTTL = 24 * time.Hour

func ModelsForRuntime(ctx context.Context, runtime string) []ModelEntry {
	catalogMu.Lock()
	if entry, ok := catalogCache[runtime]; ok && nowFn().Sub(entry.fetched) < catalogTTL {
		catalogMu.Unlock()
		return append([]ModelEntry(nil), entry.models...)
	}
	done, loading := catalogLoads[runtime]
	if !loading {
		done = make(chan struct{})
		catalogLoads[runtime] = done
		go loadCatalog(runtime, done)
	}
	catalogMu.Unlock()
	select {
	case <-done:
	case <-ctx.Done():
	}
	catalogMu.Lock()
	defer catalogMu.Unlock()
	if entry, ok := catalogCache[runtime]; ok {
		return append([]ModelEntry(nil), entry.models...) // fresh, or stale over none
	}
	return nil // free-form-only
}

func loadCatalog(runtime string, done chan struct{}) {
	defer func() {
		panichandler.PanicHandler("route catalog "+runtime, recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), catalogProbeTimeout)
	defer cancel()
	start := time.Now()
	models, err := enumerateCatalog(ctx, runtime)
	elapsed := time.Since(start).Round(time.Millisecond)
	catalogMu.Lock()
	defer catalogMu.Unlock()
	delete(catalogLoads, runtime)
	defer close(done)
	if err != nil {
		// the picker only ever shows the absence, so the reason has to land in the log
		log.Printf("route catalog: listing %s models failed after %v: %v", runtime, elapsed, err)
		return
	}
	log.Printf("route catalog: %s listed %d models in %v", runtime, len(models), elapsed)
	catalogCache[runtime] = catalogEntry{models: models, fetched: nowFn()}
}

func RefreshRouteCatalog() {
	catalogMu.Lock()
	defer catalogMu.Unlock()
	catalogCache = map[string]catalogEntry{}
}

// SetCatalogCommandForTest replaces the exec seam so wshserver tests feed deterministic
// catalog fixtures without spawning real CLIs. Returns a restore func.
func SetCatalogCommandForTest(fn func(ctx context.Context, bin string, args ...string) ([]byte, error)) func() {
	orig := catalogCommand
	catalogCommand = fn
	return func() { catalogCommand = orig }
}
