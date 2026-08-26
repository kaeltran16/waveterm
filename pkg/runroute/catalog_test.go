// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package runroute

import (
	"context"
	"fmt"
	"testing"
	"time"
)

const piListModelsFixture = `provider      model                            context  max-out  thinking  images
openai-codex  gpt-5.3-codex-spark              128K     128K     yes       no
openai-codex  gpt-5.6-sol                      272K     128K     yes       yes
opencode      claude-opus-4-8                  1M       128K     yes       yes
opencode      deepseek-v4-pro                  1M       384K     yes       no
`

const opencodeModelsFixture = `opencode/big-pickle
opencode/deepseek-v4-flash
opencode/deepseek-v4-pro
openai/gpt-5.4
openai/gpt-5.4-fast
`

const claudeHelpFixture = `Usage: claude [options]

Options:
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
`

const codexConfigFixture = `model = "gpt-5.6-sol"
model_reasoning_effort = "medium"

[profiles.fast]
model = "gpt-5.4-mini"

[profiles.coding]
model = "gpt-5.3-codex"
`

func TestParsePiTable(t *testing.T) {
	orig := catalogCommand
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(piListModelsFixture), nil
	}
	defer func() { catalogCommand = orig }()

	entries, err := enumeratePi(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("want 4 entries, got %d: %+v", len(entries), entries)
	}
	if entries[0].Model != "openai-codex/gpt-5.3-codex-spark" || entries[0].Provider != "openai-codex" {
		t.Fatalf("pi provider/model wrong: %+v", entries[0])
	}
	if entries[2].ContextHint != "1M" {
		t.Fatalf("context hint wrong: %+v", entries[2])
	}
}

func TestParseOpenCodeModels(t *testing.T) {
	orig := catalogCommand
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	defer func() { catalogCommand = orig }()

	entries, err := enumerateOpenCode(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 5 || entries[3].Model != "openai/gpt-5.4" || entries[3].Provider != "openai" {
		t.Fatalf("opencode entries wrong: %+v", entries)
	}
}

func TestParseClaudeHelpAliases(t *testing.T) {
	orig := catalogCommand
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(claudeHelpFixture), nil
	}
	defer func() { catalogCommand = orig }()

	entries, err := enumerateClaude(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	models := map[string]bool{}
	for _, e := range entries {
		models[e.Model] = true
	}
	for _, alias := range []string{"fable", "opus", "sonnet"} {
		if !models[alias] {
			t.Fatalf("missing claude alias %q: %+v", alias, entries)
		}
	}
}

func TestParseCodexConfig(t *testing.T) {
	entries, err := parseCodexConfig(codexConfigFixture)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("want 3 codex models, got %+v", entries)
	}
	if !entries[0].Default || entries[0].Model != "gpt-5.6-sol" {
		t.Fatalf("top-level codex model should be default: %+v", entries[0])
	}
	if entries[1].Default || entries[1].Model != "gpt-5.4-mini" {
		t.Fatalf("profile model must not be default: %+v", entries[1])
	}
}

func TestEnumerateDegradesOnGarbage(t *testing.T) {
	orig := catalogCommand
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("this is not a model table\n"), nil
	}
	defer func() { catalogCommand = orig }()

	entries, err := enumeratePi(context.Background())
	if err != nil {
		t.Fatalf("garbage should degrade with an error, not panic: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("garbage must yield zero entries (free-form-only): %+v", entries)
	}
	if _, err := enumerateCatalog(context.Background(), "pi"); err == nil {
		t.Fatal("empty-catalog enumerator must report the failure")
	}
}

func TestEnumerateUnknownRuntime(t *testing.T) {
	if _, err := enumerateCatalog(context.Background(), "nope"); err == nil {
		t.Fatal("unknown runtime must error")
	}
}

func TestCatalogCacheWithinTTL(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	calls := 0
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		calls++
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatalf("first fetch: want 5 entries, got %d", len(got))
	}
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatalf("second fetch must hit cache")
	}
	if calls != 1 {
		t.Fatalf("enumerated %d times, want 1 (cache hit)", calls)
	}
}

func TestCatalogCacheExpires(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	RefreshRouteCatalog() // isolated from earlier tests' cache entries
	defer RefreshRouteCatalog()
	calls := 0
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		calls++
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	ModelsForRuntime(context.Background(), "opencode")
	nowFn = func() time.Time { return time.Unix(1000+24*60*60+1, 0) }
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatal("expired cache must re-enumerate")
	}
	if calls != 2 {
		t.Fatalf("enumerated %d times after expiry, want 2", calls)
	}
}

func TestRefreshRouteCatalogClears(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	ModelsForRuntime(context.Background(), "opencode")
	RefreshRouteCatalog()
	calls := 0
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		calls++
		return []byte(opencodeModelsFixture), nil
	}
	ModelsForRuntime(context.Background(), "opencode")
	if calls != 1 {
		t.Fatalf("refresh must force a re-enumeration, got %d calls", calls)
	}
}

func TestCatalogKeepsStaleOnProbeFailure(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	ModelsForRuntime(context.Background(), "opencode")
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return nil, fmt.Errorf("cli vanished")
	}
	nowFn = func() time.Time { return time.Unix(1000+25*60*60, 0) }
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatalf("stale cache must survive a probe failure, got %d", len(got))
	}
	nowFn = func() time.Time { return time.Unix(1000+26*60*60, 0) }
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatalf("repeated failures must keep serving stale, got %d", len(got))
	}
	// manual refresh drops the stale entry; garbage with no usable cache is free-form-only
	RefreshRouteCatalog()
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("garbage\n"), nil
	}
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 0 {
		t.Fatalf("garbage with no usable stale cache must yield free-form-only, got %d", len(got))
	}
}

func TestCatalogHasModel(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	if !CatalogHasModel(context.Background(), "opencode", "openai/gpt-5.4") {
		t.Fatal("listed model must be present")
	}
	if CatalogHasModel(context.Background(), "opencode", "does/not-exist") {
		t.Fatal("unlisted model must be absent")
	}
}
