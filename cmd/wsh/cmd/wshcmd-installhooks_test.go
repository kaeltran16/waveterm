// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testWsh = `C:\a\bin\wsh-0.14.5-windows.x64.exe`

// count managed command entries across all events in a merged config
func countManaged(t *testing.T, cfg map[string]any) int {
	t.Helper()
	n := 0
	hooks, _ := cfg["hooks"].(map[string]any)
	for _, groups := range hooks {
		gs, _ := groups.([]any)
		for _, g := range gs {
			gm, _ := g.(map[string]any)
			hs, _ := gm["hooks"].([]any)
			for _, h := range hs {
				hm, _ := h.(map[string]any)
				if c, _ := hm["command"].(string); isManagedCommand(c) {
					n++
				}
			}
		}
	}
	return n
}

func TestIsManagedCommand(t *testing.T) {
	cases := map[string]bool{
		`"C:\a\bin\wsh-0.14.5-windows.x64.exe" agent-hook`: true,
		`"C:\a\bin\wsh.exe" ask`:                           true,
		`"/usr/local/bin/wsh" ask --clear`:                 true,
		`wsh agent-hook`:                                   true,
		`"C:\a\bin\wsh.exe" agent-memory-hook`:             true,
		`"C:\a\bin\wsh.exe" ask --other`:                   false,
		`node /x/ask-hook.js`:                              false,
		`mytool agent-hook`:                                false,
		``:                                                 false,
	}
	for cmd, want := range cases {
		if got := isManagedCommand(cmd); got != want {
			t.Fatalf("isManagedCommand(%q) = %v, want %v", cmd, got, want)
		}
	}
}

func TestMergeAgentHooksEmpty(t *testing.T) {
	got := mergeAgentHooks(map[string]any{}, testWsh)
	if n := countManaged(t, got); n != 9 {
		t.Fatalf("managed entries = %d, want 9", n)
	}
}

func TestMergeAgentHooksIdempotent(t *testing.T) {
	once := mergeAgentHooks(map[string]any{}, testWsh)
	twice := mergeAgentHooks(once, testWsh)
	if n := countManaged(t, twice); n != 9 {
		t.Fatalf("managed entries after 2x = %d, want 9", n)
	}
}

func TestMergeAgentHooksPreservesUnrelated(t *testing.T) {
	existing := map[string]any{
		"theme": "dark",
		"env":   map[string]any{"FOO": "1"},
		"hooks": map[string]any{
			"PreToolUse": []any{
				map[string]any{
					"matcher": "Bash",
					"hooks":   []any{map[string]any{"type": "command", "command": "node /my/own/hook.js"}},
				},
			},
		},
	}
	got := mergeAgentHooks(existing, testWsh)
	if got["theme"] != "dark" {
		t.Fatal("theme not preserved")
	}
	if _, ok := got["env"].(map[string]any); !ok {
		t.Fatal("env not preserved")
	}
	// user's Bash hook must survive
	hooks := got["hooks"].(map[string]any)
	pre := hooks["PreToolUse"].([]any)
	foundUser := false
	for _, g := range pre {
		gm := g.(map[string]any)
		hs := gm["hooks"].([]any)
		for _, h := range hs {
			if h.(map[string]any)["command"] == "node /my/own/hook.js" {
				foundUser = true
			}
		}
	}
	if !foundUser {
		t.Fatal("user hook was clobbered")
	}
	if n := countManaged(t, got); n != 9 {
		t.Fatalf("managed entries = %d, want 9", n)
	}
}

func TestMergeAgentHooksRefreshesStalePath(t *testing.T) {
	old := mergeAgentHooks(map[string]any{}, `C:\old\bin\wsh-0.14.4-windows.x64.exe`)
	refreshed := mergeAgentHooks(old, testWsh)
	if n := countManaged(t, refreshed); n != 9 {
		t.Fatalf("managed entries = %d, want 9 (stale not replaced)", n)
	}
	// no command should still reference the old path
	hooks := refreshed["hooks"].(map[string]any)
	for _, groups := range hooks {
		for _, g := range groups.([]any) {
			for _, h := range g.(map[string]any)["hooks"].([]any) {
				c := h.(map[string]any)["command"].(string)
				if strings_Contains(c, "0.14.4") {
					t.Fatalf("stale path still present: %q", c)
				}
			}
		}
	}
}

// tiny local helper so the test file needs no extra import
func strings_Contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func TestIsManagedStatusLine(t *testing.T) {
	cases := map[string]bool{
		`"C:\a\bin\wsh-0.14.5-windows.x64.exe" statusline --inner=YmFzaCB4`: true,
		`"/usr/local/bin/wsh" statusline --inner=`:                         true,
		`wsh statusline`:                                                   true,
		`bash /c/Users/x/statusline-command.sh`:                           false,
		`"C:\a\bin\wsh.exe" agent-hook`:                                    false,
		``:                                                                 false,
	}
	for cmd, want := range cases {
		if got := isManagedStatusLine(cmd); got != want {
			t.Fatalf("isManagedStatusLine(%q) = %v, want %v", cmd, got, want)
		}
	}
}

func TestMergeStatusLineWrapsUnmanaged(t *testing.T) {
	existing := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": `bash /c/Users/x/sl.sh`},
	}
	got := mergeStatusLine(existing, testWsh)
	sl := got["statusLine"].(map[string]any)
	cmd := sl["command"].(string)
	if !isManagedStatusLine(cmd) {
		t.Fatalf("command not managed after wrap: %q", cmd)
	}
	if inner := recoverInner(cmd); inner != `bash /c/Users/x/sl.sh` {
		t.Fatalf("inner not preserved: %q", inner)
	}
	if sl["type"] != "command" {
		t.Fatal("type not set to command")
	}
}

func TestMergeStatusLineEmpty(t *testing.T) {
	got := mergeStatusLine(map[string]any{}, testWsh)
	sl := got["statusLine"].(map[string]any)
	cmd := sl["command"].(string)
	if !isManagedStatusLine(cmd) {
		t.Fatalf("command not managed: %q", cmd)
	}
	if inner := recoverInner(cmd); inner != "" {
		t.Fatalf("expected empty inner, got %q", inner)
	}
}

func TestMergeStatusLineIdempotentNoNest(t *testing.T) {
	existing := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": `bash /c/Users/x/sl.sh`},
	}
	once := mergeStatusLine(existing, testWsh)
	twice := mergeStatusLine(once, testWsh)
	inner := recoverInner(twice["statusLine"].(map[string]any)["command"].(string))
	if inner != `bash /c/Users/x/sl.sh` {
		t.Fatalf("re-wrap nested or lost inner: %q", inner)
	}
}

func TestMergeStatusLineRefreshesPath(t *testing.T) {
	existing := map[string]any{
		"statusLine": map[string]any{"type": "command", "command": `bash /x/sl.sh`},
	}
	old := mergeStatusLine(existing, `C:\old\bin\wsh-0.14.4-windows.x64.exe`)
	refreshed := mergeStatusLine(old, testWsh)
	cmd := refreshed["statusLine"].(map[string]any)["command"].(string)
	if strings_Contains(cmd, "0.14.4") {
		t.Fatalf("stale path still present: %q", cmd)
	}
	if inner := recoverInner(cmd); inner != `bash /x/sl.sh` {
		t.Fatalf("inner lost on refresh: %q", inner)
	}
}

func TestMergeStatusLinePreservesOtherKeys(t *testing.T) {
	existing := map[string]any{"theme": "dark", "statusLine": map[string]any{"command": `bash /x.sh`}}
	got := mergeStatusLine(existing, testWsh)
	if got["theme"] != "dark" {
		t.Fatal("theme not preserved")
	}
}

func TestConfigIsHealthy(t *testing.T) {
	full := mergeStatusLine(mergeAgentHooks(map[string]any{}, testWsh), testWsh)

	// all managed present + exe exists -> healthy
	if !configIsHealthy(full, func(string) bool { return true }) {
		t.Fatal("full config with present exe should be healthy")
	}
	// exe missing on disk -> not healthy (must heal to repoint)
	if configIsHealthy(full, func(string) bool { return false }) {
		t.Fatal("full config with missing exe should NOT be healthy")
	}
	// empty config -> not healthy
	if configIsHealthy(map[string]any{}, func(string) bool { return true }) {
		t.Fatal("empty config should NOT be healthy")
	}
	// hooks present but statusLine absent -> not healthy
	hooksOnly := mergeAgentHooks(map[string]any{}, testWsh)
	if configIsHealthy(hooksOnly, func(string) bool { return true }) {
		t.Fatal("config missing managed statusLine should NOT be healthy")
	}
}

func TestJsonStringEscapesBackslashes(t *testing.T) {
	got := jsonString(`C:\Users\u\bin\wsh.exe`)
	if !strings.Contains(got, `\\`) {
		t.Fatalf("expected escaped backslashes in %q", got)
	}
}

func TestInstallOpencodePlugin_writesSubstitutedPlugin(t *testing.T) {
	origLookPath := opencodeLookPath
	opencodeLookPath = func(string) (string, error) { return "opencode", nil }
	defer func() { opencodeLookPath = origLookPath }()

	home := t.TempDir()
	if err := installOpencodePlugin(home); err != nil {
		t.Fatalf("installOpencodePlugin error: %v", err)
	}
	path := filepath.Join(home, ".config", "opencode", "plugins", "waveterm-status.js")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading installed plugin: %v", err)
	}
	if strings.Contains(string(b), "__WSH_PATH__") {
		t.Fatalf("placeholder not substituted:\n%s", string(b))
	}
	if !strings.Contains(string(b), `"agent-hook"`) {
		t.Fatalf("installed plugin missing the agent-hook invocation:\n%s", string(b))
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolving test executable: %v", err)
	}
	wantDeclaration := "const WSH = " + jsonString(exe) + ";"
	if !strings.Contains(string(b), wantDeclaration) {
		t.Fatalf("installed plugin has invalid WSH declaration, want %q:\n%s", wantDeclaration, string(b))
	}
}

func TestInstallOpencodePlugin_skipsWhenOpencodeMissing(t *testing.T) {
	origLookPath := opencodeLookPath
	opencodeLookPath = func(string) (string, error) { return "", os.ErrNotExist }
	defer func() { opencodeLookPath = origLookPath }()

	home := t.TempDir()
	if err := installOpencodePlugin(home); err != nil {
		t.Fatalf("missing opencode must not error, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".config", "opencode", "plugins", "waveterm-status.js")); !os.IsNotExist(err) {
		t.Fatalf("plugin should not be written when opencode is absent")
	}
}

// fakeWshPath is the wsh executable path the pi extension installer embeds. It equals
// the running test binary, matching what installPiStatusExtension resolves via os.Executable().
func fakeWshPath(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolving test executable: %v", err)
	}
	return exe
}

func piExtensionPath(home string) string {
	return filepath.Join(home, ".pi", "agent", "extensions", "waveterm-status.ts")
}

func stubPiLookPath(t *testing.T) {
	t.Helper()
	orig := piLookPath
	piLookPath = func(string) (string, error) { return "pi", nil }
	t.Cleanup(func() { piLookPath = orig })
}

func TestInstallPiStatusExtension_writesSubstitutedExtension(t *testing.T) {
	stubPiLookPath(t)

	home := t.TempDir()
	if err := installPiStatusExtension(home); err != nil {
		t.Fatalf("installPiStatusExtension error: %v", err)
	}
	path := piExtensionPath(home)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading installed extension: %v", err)
	}
	if strings.Contains(string(body), `registerWavetermStatus(pi, "__WSH_PATH__")`) {
		t.Fatalf("placeholder not substituted in emitted call:\n%s", string(body))
	}
	if !strings.Contains(string(body), jsonString(fakeWshPath(t))) {
		t.Fatalf("installed extension missing the wsh path %s:\n%s", jsonString(fakeWshPath(t)), string(body))
	}
	if !strings.Contains(string(body), "registerWavetermStatus(pi, "+jsonString(fakeWshPath(t))+")") {
		t.Fatalf("installed extension has malformed registerWavetermStatus call:\n%s", string(body))
	}
}

func TestInstallPiStatusExtension_skipsWhenPiMissing(t *testing.T) {
	orig := piLookPath
	piLookPath = func(string) (string, error) { return "", os.ErrNotExist }
	defer func() { piLookPath = orig }()

	home := t.TempDir()
	if err := installPiStatusExtension(home); err != nil {
		t.Fatalf("missing pi must not error, got %v", err)
	}
	if _, err := os.Stat(piExtensionPath(home)); !os.IsNotExist(err) {
		t.Fatalf("extension should not be written when pi is absent")
	}
}

func TestInstallPiStatusExtension_equalBytesPreserveMtime(t *testing.T) {
	stubPiLookPath(t)

	home := t.TempDir()
	if err := installPiStatusExtension(home); err != nil {
		t.Fatalf("installPiStatusExtension error: %v", err)
	}
	path := piExtensionPath(home)
	info1, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat after first install: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if err := installPiStatusExtension(home); err != nil {
		t.Fatalf("installPiStatusExtension error: %v", err)
	}
	info2, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat after second install: %v", err)
	}
	if !info2.ModTime().Equal(info1.ModTime()) {
		t.Fatalf("mtime changed on no-op reinstall: %v -> %v", info1.ModTime(), info2.ModTime())
	}
}

func TestInstallPiStatusExtension_rewritesChangedPath(t *testing.T) {
	stubPiLookPath(t)

	home := t.TempDir()
	dir := filepath.Join(home, ".pi", "agent", "extensions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating extension dir: %v", err)
	}
	path := filepath.Join(dir, "waveterm-status.ts")
	stale := strings.ReplaceAll(piStatusExtensionTemplate, `"__WSH_PATH__"`, jsonString(`C:\old\bin\wsh-0.14.4-windows.x64.exe`))
	if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
		t.Fatalf("seeding stale extension: %v", err)
	}

	if err := installPiStatusExtension(home); err != nil {
		t.Fatalf("installPiStatusExtension error: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading rewritten extension: %v", err)
	}
	if strings.Contains(string(body), "0.14.4") {
		t.Fatalf("stale wsh path still present after reinstall:\n%s", string(body))
	}
	if !strings.Contains(string(body), jsonString(fakeWshPath(t))) {
		t.Fatalf("new wsh path not written:\n%s", string(body))
	}
}

func piMemoryExtensionPath(home string) string {
	return filepath.Join(home, ".pi", "agent", "extensions", "waveterm-memory.ts")
}

func TestInstallPiMemoryExtension_writesSubstitutedExtension(t *testing.T) {
	stubPiLookPath(t)

	home := t.TempDir()
	if err := installPiMemoryExtension(home); err != nil {
		t.Fatalf("installPiMemoryExtension error: %v", err)
	}
	path := piMemoryExtensionPath(home)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading installed extension: %v", err)
	}
	if strings.Contains(string(body), `registerWavetermMemory(pi, "__WSH_PATH__")`) {
		t.Fatalf("placeholder not substituted in emitted call:\n%s", string(body))
	}
	if !strings.Contains(string(body), "registerWavetermMemory(pi, "+jsonString(fakeWshPath(t))+")") {
		t.Fatalf("installed extension has malformed registerWavetermMemory call:\n%s", string(body))
	}
}

func TestInstallPiMemoryExtension_skipsWhenPiMissing(t *testing.T) {
	orig := piLookPath
	piLookPath = func(string) (string, error) { return "", os.ErrNotExist }
	defer func() { piLookPath = orig }()

	home := t.TempDir()
	if err := installPiMemoryExtension(home); err != nil {
		t.Fatalf("missing pi must not error, got %v", err)
	}
	if _, err := os.Stat(piMemoryExtensionPath(home)); !os.IsNotExist(err) {
		t.Fatalf("extension should not be written when pi is absent")
	}
}

func TestInstallPiMemoryExtension_rewritesChangedPath(t *testing.T) {
	stubPiLookPath(t)

	home := t.TempDir()
	dir := filepath.Join(home, ".pi", "agent", "extensions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating extension dir: %v", err)
	}
	path := filepath.Join(dir, "waveterm-memory.ts")
	stale := strings.ReplaceAll(piMemoryExtensionTemplate, `"__WSH_PATH__"`, jsonString(`C:\old\bin\wsh-0.14.4-windows.x64.exe`))
	if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
		t.Fatalf("seeding stale extension: %v", err)
	}

	if err := installPiMemoryExtension(home); err != nil {
		t.Fatalf("installPiMemoryExtension error: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading rewritten extension: %v", err)
	}
	if strings.Contains(string(body), "0.14.4") {
		t.Fatalf("stale wsh path still present after reinstall:\n%s", string(body))
	}
	if !strings.Contains(string(body), "registerWavetermMemory(pi, "+jsonString(fakeWshPath(t))+")") {
		t.Fatalf("new wsh path not written:\n%s", string(body))
	}
}

func TestInstallPiSimplifyGateExtension_writesBothFiles(t *testing.T) {
	stubPiLookPath(t)

	home := t.TempDir()
	if err := installPiSimplifyGateExtension(home); err != nil {
		t.Fatalf("installPiSimplifyGateExtension error: %v", err)
	}
	dir := filepath.Join(home, ".pi", "agent", "extensions")
	for name, want := range map[string]string{
		"waveterm-simplify-gate.ts":      piSimplifyGateExtensionTemplate,
		"waveterm-simplify-gate-core.ts": piSimplifyGateCoreExtensionTemplate,
	} {
		path := filepath.Join(dir, name)
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading installed %s: %v", name, err)
		}
		if string(body) != want {
			t.Fatalf("%s content differs from the authored template", name)
		}
	}
}

// pi auto-loads every file in ~/.pi/agent/extensions/ and requires each to export a factory
// function. A dependency module (a *-core.ts) that omits the no-op default export loads fine as
// TS but crashes the whole extensions dir at pi boot. Guard every template that lands there.
func TestPiExtensionTemplatesExportAFactory(t *testing.T) {
	templates := map[string]string{
		"waveterm-status.ts":              piStatusExtensionTemplate,
		"waveterm-tools.ts":               piToolsExtensionTemplate,
		"waveterm-tools-core.ts":          piToolsCoreExtensionTemplate,
		"waveterm-ask.ts":                 piAskExtensionTemplate,
		"waveterm-ask-core.ts":            piAskCoreExtensionTemplate,
		"waveterm-prose-core.ts":          piProseCoreExtensionTemplate,
		"waveterm-simplify-gate.ts":       piSimplifyGateExtensionTemplate,
		"waveterm-simplify-gate-core.ts":  piSimplifyGateCoreExtensionTemplate,
		"waveterm-memory.ts":              piMemoryExtensionTemplate,
	}
	for name, src := range templates {
		if !strings.Contains(src, "export default") {
			t.Errorf("%s: pi extensions must export a default factory function (add a no-op for -core dependency modules)", name)
		}
	}
}

func TestInstallPiSimplifyGateExtension_skipsWhenPiMissing(t *testing.T) {
	orig := piLookPath
	piLookPath = func(string) (string, error) { return "", os.ErrNotExist }
	defer func() { piLookPath = orig }()

	home := t.TempDir()
	if err := installPiSimplifyGateExtension(home); err != nil {
		t.Fatalf("missing pi must not error, got %v", err)
	}
	dir := filepath.Join(home, ".pi", "agent", "extensions")
	if _, err := os.Stat(filepath.Join(dir, "waveterm-simplify-gate.ts")); !os.IsNotExist(err) {
		t.Fatalf("extension should not be written when pi is absent")
	}
}

func TestInstallPiSimplifyGateExtension_equalBytesPreserveMtime(t *testing.T) {
	stubPiLookPath(t)

	home := t.TempDir()
	if err := installPiSimplifyGateExtension(home); err != nil {
		t.Fatalf("installPiSimplifyGateExtension error: %v", err)
	}
	path := filepath.Join(home, ".pi", "agent", "extensions", "waveterm-simplify-gate.ts")
	info1, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat after first install: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if err := installPiSimplifyGateExtension(home); err != nil {
		t.Fatalf("installPiSimplifyGateExtension error: %v", err)
	}
	info2, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat after second install: %v", err)
	}
	if !info2.ModTime().Equal(info1.ModTime()) {
		t.Fatalf("mtime changed on no-op reinstall: %v -> %v", info1.ModTime(), info2.ModTime())
	}
}

func TestInstallPiTheme(t *testing.T) {
	stubPiLookPath(t)

	home := t.TempDir()
	if err := installPiTheme(home); err != nil {
		t.Fatalf("install: %v", err)
	}
	path := filepath.Join(home, ".pi", "agent", "themes", "arc.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("theme not written: %v", err)
	}
	var theme map[string]any
	if err := json.Unmarshal(b, &theme); err != nil {
		t.Fatalf("theme not valid json: %v", err)
	}
	if theme["name"] != "arc" {
		t.Fatalf("theme name = %v, want arc", theme["name"])
	}
	// idempotent: second run rewrites nothing and reports no error
	if err := installPiTheme(home); err != nil {
		t.Fatalf("reinstall: %v", err)
	}
}

func TestMergePiSettingsDefaults(t *testing.T) {
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".pi", "agent", "settings.json")
	os.MkdirAll(filepath.Dir(settingsPath), 0o755)
	// pre-existing user config: theme already set, packages carry a user entry but not arc's,
	// defaultProvider preserved.
	os.WriteFile(settingsPath, []byte(`{"theme": "cc-dark", "packages": ["npm:pi-tasks"], "defaultProvider": "opencode-go"}`), 0o644)

	installed, skipped, err := mergePiSettingsDefaults(home)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if len(skipped) != 1 || skipped[0] != "theme" {
		t.Fatalf("skipped = %v, want [theme] (packages gets the arc entry appended)", skipped)
	}
	if len(installed) != 1 || installed[0] != "packages" {
		t.Fatalf("installed = %v, want [packages]", installed)
	}
	got, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	var s struct {
		Theme           string   `json:"theme"`
		DefaultProvider string   `json:"defaultProvider"`
		Packages        []string `json:"packages"`
	}
	if err := json.Unmarshal(got, &s); err != nil {
		t.Fatalf("parse settings: %v", err)
	}
	if s.Theme != "cc-dark" {
		t.Fatalf("theme clobbered: %v", s.Theme)
	}
	if s.DefaultProvider != "opencode-go" {
		t.Fatalf("defaultProvider clobbered: %v", s.DefaultProvider)
	}
	// user entry preserved; arc entry appended once
	if len(s.Packages) != 2 || s.Packages[0] != "npm:pi-tasks" || s.Packages[1] != arcPackageEntry {
		t.Fatalf("packages = %v, want [npm:pi-tasks %s]", s.Packages, arcPackageEntry)
	}

	// second run is a full no-op: theme and packages are now both present
	installed2, skipped2, err := mergePiSettingsDefaults(home)
	if err != nil {
		t.Fatalf("re-merge: %v", err)
	}
	if len(installed2) != 0 {
		t.Fatalf("second run installed %v, want nothing", installed2)
	}
	if len(skipped2) != 2 {
		t.Fatalf("second run skipped = %v, want [theme packages]", skipped2)
	}
}

func TestInstallPiKeybindingsOnlyWhenAbsent(t *testing.T) {
	home := t.TempDir()
	installed, err := installPiKeybindings(home)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !installed {
		t.Fatal("expected keybindings installed on empty home")
	}
	path := filepath.Join(home, ".pi", "agent", "keybindings.json")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("keybindings not written: %v", err)
	}
	if !strings.Contains(string(got), "tui.altScreen.top") {
		t.Fatalf("keybindings missing alt-screen entry: %s", got)
	}
	// existing user file is never overwritten
	userFile := `{"tui.editor.historyPrevious": "ctrl+up"}`
	os.WriteFile(path, []byte(userFile), 0o644)
	installed, err = installPiKeybindings(home)
	if err != nil {
		t.Fatalf("second install: %v", err)
	}
	if installed {
		t.Fatal("keybindings rewritten over existing user file")
	}
	got, _ = os.ReadFile(path)
	if string(got) != userFile {
		t.Fatalf("user keybindings clobbered: %s", got)
	}
}
