# Pi Package, Theme, And Provisioning Plan (Meta Parts C+D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the arc repo work natively with Pi: a repo-root `pi/` package (extension source of truth, arc theme, skill, prompt), a repo-root `AGENTS.md`, and `wsh install-agent-hooks` growing from "install the status extension" to "install the Pi experience" — idempotently, never clobbering user config.

**Architecture:** The authored artifacts live under `pi/` and `.pi/` at the repo root. Two of them (the status extension and the arc theme) must also be embedded into `wsh` for provisioning, so a Taskfile sync step copies them into `cmd/wsh/cmd/` (the existing `go:embed` source locations) before every backend build, and a drift test fails the build if they diverge. Provisioning reads `~/.pi/agent/settings.json` / `keybindings.json` and merges only absent keys.

**Tech Stack:** Go (wsh provisioning, go:embed), Taskfile, Node (theme validator), JSON (pi package manifest, theme), Markdown (AGENTS.md, skill, prompt).

**Spec:** [`docs/superpowers/specs/2026-08-11-pi-main-harness-meta-design.md`](../specs/2026-08-11-pi-main-harness-meta-design.md) Parts C and D. Read it before starting.

## Global Constraints

- Target Pi `0.84.1`. Theme schema is the published one (validated: exactly 51 required `colors` tokens, optional `scrollbarThumb` / `searchMatchBg` / `searchMatchText` / `thinkingMax` / `export`).
- Source of truth lives in the repo: `pi/extensions/waveterm-status.ts`, `pi/themes/arc.json`, `pi/skills/`, `pi/prompts/`, `AGENTS.md`. The `cmd/wsh/cmd/` copies are **generated** (by Taskfile) and must never be hand-edited.
- Provisioning is idempotent: running again changes nothing; report what was installed vs skipped.
- **No-clobber:** settings values and keybindings are written only when the key/file is absent. A user's `theme`, `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `packages`, and `keybindings.json` always win.
- **Deviation from the meta's settings list (documented):** the meta lists `defaultProvider` / `defaultModel` / `defaultThinkingLevel` among keys to write when absent. This plan does **not** write them: arc has no canonical values for these (the cockpit's own agent settings do not define a default provider/model today), and inventing provider names would violate the no-magic rule. Pi's own built-in defaults apply on fresh installs. Only `theme: "arc"` and the `packages` entry are written when absent.
- **Deviation from the meta's keybindings list (documented):** the meta lists a "model picker" binding among the arc-aligned defaults. Pi's binding id for the model picker is not confirmed from the installed `0.84.1` sample; writing an invented id is worse than none. Only the four known-good bindings (editor history, alt-screen navigation) are provisioned, and only when `keybindings.json` does not exist.
- Never hand-edit generated files. The `pi/` package manifest is hand-authored; `cmd/wsh/cmd/{pi-status-extension.ts,arc-theme.json}` are sync targets.
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- Go tests in `cmd/wsh/cmd` need no CGO. `gofmt -l` must be zero.
- Git: no commits without explicit user approval. One batched commit at the end.
- Colors in the theme reference the cockpit's midnight palette hex values verbatim (this is a TUI theme file, not a component — raw hex is required by the schema, unlike the frontend token rule).

---

## File Map

**New files**

- `pi/package.json` — pi-package manifest (extensions, skills, prompts, themes).
- `pi/extensions/waveterm-status.ts` — moved from `cmd/wsh/cmd/pi-status-extension.ts` (authoritative).
- `pi/themes/arc.json` — arc theme, 51 required tokens from the midnight palette.
- `pi/skills/arc-dev/SKILL.md` — arc dev workflow skill.
- `pi/prompts/arc-review.md` — staged-change review prompt template.
- `AGENTS.md` — repo root, Pi-readable conventions mirror.
- `scripts/validate-pi-theme.mjs` — theme schema validator (embedded 51-token list).
- `cmd/wsh/cmd/arc-theme.json` — generated copy of `pi/themes/arc.json` (go:embed target).
- `cmd/wsh/cmd/piartifact_test.go` — drift tests (embedded extension/theme == repo `pi/` files).

**Principal modified files**

- `Taskfile.yml` — new `sync:piartifacts` task; wired as a dep of `build:server:internal`, `build:wsh:internal`, and `tauri:dev`.
- `cmd/wsh/cmd/wshcmd-installhooks.go` — theme install, settings defaults merge, keybindings merge, idempotent report.
- `cmd/wsh/cmd/wshcmd-installhooks_test.go` — tests for the new provisioning steps.
- `package.json` — npm script `check:pi-theme`.

---

### Task 1: `pi/` package skeleton

**Files:**
- Create: `pi/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `pi` manifest key that later tasks fill in (`extensions`, `skills`, `prompts`, `themes`). Format verified against installed packages: `keywords: ["pi-package", "pi"]` plus a top-level `"pi": { ... }` object.

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "arc-pi",
  "version": "0.1.0",
  "description": "Arc cockpit integration package for Pi: status extension, arc theme, arc-dev skill, arc-review prompt",
  "license": "Apache-2.0",
  "keywords": ["pi-package", "pi", "arc", "waveterm"],
  "pi": {
    "extensions": ["./extensions/waveterm-status.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

- [ ] **Step 2: Checkpoint**

Run: `git status` and stop for review.

---

### Task 2: Move the status extension source of truth

**Files:**
- Create: `pi/extensions/waveterm-status.ts` (exact copy of `cmd/wsh/cmd/pi-status-extension.ts`)
- Delete: `cmd/wsh/cmd/pi-status-extension.ts` (becomes the sync target)
- Modify: `Taskfile.yml`
- Test: `cmd/wsh/cmd/piartifact_test.go`

**Interfaces:**
- Consumes: the current `cmd/wsh/cmd/pi-status-extension.ts` content (unchanged functionally).
- Produces: `pi/extensions/waveterm-status.ts` authoritative; `cmd/wsh/cmd/pi-status-extension.ts` regenerated by `task sync:piartifacts`; `go:embed pi-status-extension.ts` in `wshcmd-installhooks.go` keeps working unchanged.

- [ ] **Step 1: Move the file**

```bash
git mv cmd/wsh/cmd/pi-status-extension.ts pi/extensions/waveterm-status.ts
```

(The file content is unchanged. `wshcmd-installhooks.go` still embeds `pi-status-extension.ts` — the next build step regenerates that path.)

- [ ] **Step 2: Add the sync task and wire it into builds**

In `Taskfile.yml`, add before `build:server:internal` (line ~171):

```yaml
    sync:piartifacts:
        desc: Copy authored pi/ artifacts into their go:embed locations under cmd/wsh/cmd (generated, never hand-edited).
        cmds:
            - cmd: cp pi/extensions/waveterm-status.ts cmd/wsh/cmd/pi-status-extension.ts
            - cmd: cp pi/themes/arc.json cmd/wsh/cmd/arc-theme.json
        sources:
            - pi/extensions/waveterm-status.ts
            - pi/themes/arc.json
        generates:
            - cmd/wsh/cmd/pi-status-extension.ts
            - cmd/wsh/cmd/arc-theme.json
```

Add `- task: sync:piartifacts` to the `deps:` of `build:server:internal`, `build:wsh:internal` (line ~239), and `tauri:dev` (line ~18). (Windows `cp` works in the Taskfile shell; if a given task runs under cmd.exe rather than bash, use `copy /Y` guarded by `platforms: [windows]` variants — check how neighboring build tasks handle this and match.)

- [ ] **Step 3: Write the failing drift test**

Create `cmd/wsh/cmd/piartifact_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

// repoRoot resolves the repository root relative to this package (cmd/wsh/cmd -> 3 levels up).
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	root, err := filepath.Abs(filepath.Join(dir, "..", "..", ".."))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	return root
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot(t), rel))
	if err != nil {
		t.Fatalf("reading %s: %v", rel, err)
	}
	return string(b)
}

// embeddedPiStatusExtension must track the authored pi/ package file; task sync:piartifacts keeps
// the embed copy current, and this test fails the build when someone edits the authored file without
// re-syncing (or hand-edits the generated copy).
func TestEmbeddedPiStatusExtensionMatchesPackage(t *testing.T) {
	want := readRepoFile(t, "pi/extensions/waveterm-status.ts")
	if piStatusExtensionTemplate != want {
		t.Fatalf("piStatusExtensionTemplate != pi/extensions/waveterm-status.ts\nrun: task sync:piartifacts")
	}
}

func TestEmbeddedArcThemeMatchesPackage(t *testing.T) {
	want := readRepoFile(t, "pi/themes/arc.json")
	if arcThemeTemplate != want {
		t.Fatalf("arcThemeTemplate != pi/themes/arc.json\nrun: task sync:piartifacts")
	}
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run "Embedded" -v`
Expected: FAIL — `arcThemeTemplate` is not defined yet (Task 3 adds the embed), and the sync copy of the extension does not exist yet.

- [ ] **Step 5: Run the sync task**

Run: `task sync:piartifacts` — wait, this needs `pi/themes/arc.json` to exist (Task 3). Run Task 3 Step 1-2 first if the theme file is absent, then:

Run: `task sync:piartifacts`
Expected: `cmd/wsh/cmd/pi-status-extension.ts` and `cmd/wsh/cmd/arc-theme.json` now exist, byte-identical to the `pi/` sources.

- [ ] **Step 6: Checkpoint**

Run: `git status` and stop for review.

---

### Task 3: Arc theme

**Files:**
- Create: `pi/themes/arc.json`
- Create: `scripts/validate-pi-theme.mjs`
- Modify: `package.json` (npm script), `Taskfile.yml` (`check:pi-theme` task)

**Interfaces:**
- Consumes: midnight palette hex values from `frontend/app/view/agents/themes.ts` (bg #0c0e11, surface #0e1116, surfaceRaised #13171d, surfaceHover #171c22, surfaceSelected #1a222c, code #0b0d10, border #1c2128, edgeMid #20262e, edgeStrong #2a313a, edgeFaint #161a20, text #e6e9ed, secondary #cfd5db, muted #7f858b, inkFaint #646a72, accent #7c95ff, success #54c79a, warning #e6b450, error #e0726c).
- Produces: `pi/themes/arc.json` (51 required tokens, schema-valid); `cmd/wsh/cmd/arc-theme.json` via sync (Task 2); `arcThemeTemplate` go:embed in Task 4.

- [ ] **Step 1: Write the failing validator test first (node script + npm script)**

Create `scripts/validate-pi-theme.mjs`:

```js
// Validates pi/themes/arc.json against the published pi theme schema's required token list.
// The required list is vendored here (51 tokens) so the check runs offline; the schema lives at
// https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json
import { readFileSync } from "node:fs";

const required = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg", "userMessageText",
  "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
  "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink",
  "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
  "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
  "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
  "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];

const file = process.argv[2] ?? "pi/themes/arc.json";
const theme = JSON.parse(readFileSync(file, "utf8"));
if (!theme.name) throw new Error(`${file}: missing "name"`);
const missing = required.filter((k) => !(k in theme.colors));
if (missing.length) throw new Error(`${file}: missing required colors: ${missing.join(", ")}`);
const colorValue = (v) => typeof v === "number" || (typeof v === "string" && /^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|[A-Za-z][\w-]*|)$/.test(v));
const bad = Object.entries(theme.colors).filter(([, v]) => !colorValue(v)).map(([k]) => k);
if (bad.length) throw new Error(`${file}: invalid color values for: ${bad.join(", ")}`);
console.log(`ok: ${file} (${Object.keys(theme.colors).length} colors, all ${required.length} required present)`);
```

- [ ] **Step 2: Run it against the theme (fails — file missing)**

Run: `node scripts/validate-pi-theme.mjs`
Expected: FAIL — cannot read `pi/themes/arc.json`.

- [ ] **Step 3: Create `pi/themes/arc.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "arc",
  "vars": {
    "bg": "#0c0e11",
    "surface": "#0e1116",
    "surfaceRaised": "#13171d",
    "surfaceHover": "#171c22",
    "surfaceSelected": "#1a222c",
    "border": "#1c2128",
    "edgeMid": "#20262e",
    "edgeStrong": "#2a313a",
    "edgeFaint": "#161a20",
    "text": "#e6e9ed",
    "secondary": "#cfd5db",
    "muted": "#7f858b",
    "inkFaint": "#646a72",
    "accent": "#7c95ff",
    "success": "#54c79a",
    "warning": "#e6b450",
    "error": "#e0726c"
  },
  "colors": {
    "accent": "accent",
    "border": "border",
    "borderAccent": "edgeStrong",
    "borderMuted": "edgeFaint",
    "success": "success",
    "error": "error",
    "warning": "warning",
    "muted": "muted",
    "dim": "inkFaint",
    "text": "text",
    "thinkingText": "secondary",

    "selectedBg": "surfaceSelected",
    "userMessageBg": "surface",
    "userMessageText": "text",
    "customMessageBg": "surfaceRaised",
    "customMessageText": "text",
    "customMessageLabel": "accent",
    "toolPendingBg": "surfaceRaised",
    "toolSuccessBg": "#15241d",
    "toolErrorBg": "#2a1d1d",
    "toolTitle": "accent",
    "toolOutput": "secondary",

    "mdHeading": "text",
    "mdLink": "accent",
    "mdLinkUrl": "muted",
    "mdCode": "accent",
    "mdCodeBlock": "secondary",
    "mdCodeBlockBorder": "border",
    "mdQuote": "secondary",
    "mdQuoteBorder": "accent",
    "mdHr": "border",
    "mdListBullet": "accent",

    "toolDiffAdded": "success",
    "toolDiffRemoved": "error",
    "toolDiffContext": "muted",

    "syntaxComment": "inkFaint",
    "syntaxKeyword": "accent",
    "syntaxFunction": "text",
    "syntaxVariable": "secondary",
    "syntaxString": "success",
    "syntaxNumber": "warning",
    "syntaxType": "accent",
    "syntaxOperator": "secondary",
    "syntaxPunctuation": "muted",

    "thinkingOff": "border",
    "thinkingMinimal": "edgeFaint",
    "thinkingLow": "edgeMid",
    "thinkingMedium": "edgeStrong",
    "thinkingHigh": "accent",
    "thinkingXhigh": "#a5b8ff",

    "bashMode": "accent"
  }
}
```

The shared tokens map mechanically from the midnight palette; the Pi-specific tokens (`toolSuccessBg`, `toolErrorBg`, `thinkingXhigh`) are hand-tuned per the spec and are the values to revisit if the theme feels off in a live session.

- [ ] **Step 4: Run the validator**

Run: `node scripts/validate-pi-theme.mjs`
Expected: `ok: pi/themes/arc.json (51 colors, all 51 required present)`

- [ ] **Step 5: Wire the check into npm + Taskfile**

In `package.json` scripts, add:

```json
"check:pi-theme": "node scripts/validate-pi-theme.mjs"
```

In `Taskfile.yml`, add next to `check:ts:` (line ~352):

```yaml
    check:pi-theme:
        desc: Validate pi/themes/arc.json against the pi theme schema's required token list.
        cmds:
            - cmd: node scripts/validate-pi-theme.mjs
```

- [ ] **Step 6: Checkpoint**

Run: `git status` and stop for review.

---

### Task 4: Provisioning — theme, settings defaults, keybindings, report

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go`
- Test: `cmd/wsh/cmd/wshcmd-installhooks_test.go`

**Interfaces:**
- Consumes: `arcThemeTemplate` (go:embed of `cmd/wsh/cmd/arc-theme.json`, synced by Task 2), `piLookPath`, the existing `installPiStatusExtension`/`installPiMemoryExtension` idempotent-install pattern, `jsonString`.
- Produces: three new installers with the same no-op-when-absent / idempotent-rewrite contract as the extension installers, wired into `installAgentHooksRun`, plus an install report line:
  - `installPiTheme(home) error` — writes `~/.pi/agent/themes/arc.json`.
  - `mergePiSettingsDefaults(home) (installed []string, skipped []string, err error)` — sets `theme: "arc"` and appends the `packages` entry only when absent.
  - `installPiKeybindings(home) (installed bool, err error)` — writes `~/.pi/agent/keybindings.json` only when the file does not exist.

- [ ] **Step 1: Write the failing tests**

Append to `wshcmd-installhooks_test.go` (mirror the existing test helpers — the file already tests the extension installers with a temp home; follow that structure):

```go
func TestInstallPiTheme(t *testing.T) {
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
	// pre-existing user config: theme and packages already present, defaultProvider preserved
	os.WriteFile(settingsPath, []byte(`{"theme": "cc-dark", "packages": ["npm:pi-tasks"], "defaultProvider": "opencode-go"}`), 0o644)

	installed, skipped, err := mergePiSettingsDefaults(home)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if len(skipped) != 2 { // theme + packages both already set
		t.Fatalf("skipped = %v, want theme+packages skipped", skipped)
	}
	// packages entry must be arc's, deduped
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
	if len(s.Packages) != 1 || s.Packages[0] != "npm:pi-tasks" {
		t.Fatalf("packages = %v, want untouched", s.Packages)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./cmd/wsh/cmd/ -run "PiTheme|PiSettings|PiKeybindings" -v`
Expected: FAIL — `installPiTheme`, `mergePiSettingsDefaults`, `installPiKeybindings`, `arcThemeTemplate` are not defined.

- [ ] **Step 3: Add the embed and the three installers**

In `wshcmd-installhooks.go`, next to the existing embeds:

```go
//go:embed arc-theme.json
var arcThemeTemplate string
```

Add after `installPiMemoryExtension`:

```go
// installPiTheme writes the arc theme into pi's global theme directory (~/.pi/agent/themes/), where
// pi hot-reloads custom theme files. No-op when pi is not installed. Idempotent: rewrites only when
// the installed copy differs (self-heals if the user edits it away; their edits to a present file
// are respected because the rewrite compares against the authored template).
func installPiTheme(home string) error {
	if _, err := piLookPath("pi"); err != nil {
		return nil // pi not installed; nothing to hook
	}
	dir := filepath.Join(home, ".pi", "agent", "themes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	path := filepath.Join(dir, "arc.json")
	if cur, err := os.ReadFile(path); err == nil && string(cur) == arcThemeTemplate {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(arcThemeTemplate), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	fmt.Printf("installed pi arc theme into %s\n", path)
	return nil
}

// arcPackageEntry is the settings.packages entry provisioning adds so pi loads the arc package
// (extensions/skills/prompts/themes declared in the pi manifest).
const arcPackageEntry = "git:github.com/kaeltran16/waveterm"

// mergePiSettingsDefaults writes pi settings defaults only when keys are absent: the arc theme and
// the arc package entry. provider/model/thinking defaults are deliberately not written (arc defines
// no canonical values; pi's built-ins apply on fresh installs). Never clobbers existing values.
// Returns what was installed and what was skipped for the idempotent report.
func mergePiSettingsDefaults(home string) (installed []string, skipped []string, err error) {
	path := filepath.Join(home, ".pi", "agent", "settings.json")
	settings := map[string]any{}
	if b, rerr := os.ReadFile(path); rerr == nil && len(strings.TrimSpace(string(b))) > 0 {
		if uerr := json.Unmarshal(b, &settings); uerr != nil {
			return nil, nil, fmt.Errorf("parsing %s: %w", path, uerr)
		}
	}
	if _, ok := settings["theme"]; !ok {
		settings["theme"] = "arc"
		installed = append(installed, "theme")
	} else {
		skipped = append(skipped, "theme")
	}
	if pkgs, _ := settings["packages"].([]any); !containsString(pkgs, arcPackageEntry) {
		settings["packages"] = append(pkgs, arcPackageEntry)
		installed = append(installed, "packages")
	} else {
		skipped = append(skipped, "packages")
	}
	out, merr := json.MarshalIndent(settings, "", "  ")
	if merr != nil {
		return nil, nil, fmt.Errorf("encoding settings: %w", merr)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, nil, fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(out, '\n'), 0o644); err != nil {
		return nil, nil, fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, nil, fmt.Errorf("replacing %s: %w", path, err)
	}
	return installed, skipped, nil
}

func containsString(items []any, want string) bool {
	for _, it := range items {
		if s, ok := it.(string); ok && s == want {
			return true
		}
	}
	return false
}

// installPiKeybindings writes a minimal arc-aligned keybindings.json only when no user file exists.
// User bindings always win; the four entries mirror the known-good pi 0.84.1 ids (editor history +
// alt-screen navigation). A model-picker binding is deferred until pi's binding id is confirmed.
func installPiKeybindings(home string) (bool, error) {
	path := filepath.Join(home, ".pi", "agent", "keybindings.json")
	if _, err := os.Stat(path); err == nil {
		return false, nil // user file exists; never merge over it
	}
	content := `{
  "tui.editor.historyPrevious": "up",
  "tui.editor.historyNext": "down",
  "tui.altScreen.top": "ctrl+home",
  "tui.altScreen.bottom": "ctrl+end"
}
`
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return false, fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return false, fmt.Errorf("replacing %s: %w", path, err)
	}
	fmt.Printf("installed pi arc keybindings into %s\n", path)
	return true, nil
}
```

- [ ] **Step 4: Wire into `installAgentHooksRun` with the report**

In `installAgentHooksRun`, replace the tail (after the existing `installPiMemoryExtension` call) with:

```go
	if err := installPiStatusExtension(home); err != nil {
		return err
	}
	if err := installPiMemoryExtension(home); err != nil {
		return err
	}
	if err := installPiTheme(home); err != nil {
		return err
	}
	installed, skipped, err := mergePiSettingsDefaults(home)
	if err != nil {
		return err
	}
	kbInstalled, err := installPiKeybindings(home)
	if err != nil {
		return err
	}
	fmt.Printf("pi settings: installed %v, skipped %v\n", installed, skipped)
	if kbInstalled {
		fmt.Println("pi keybindings: installed (no existing file)")
	} else {
		fmt.Println("pi keybindings: skipped (user file present)")
	}
	return nil
```

- [ ] **Step 5: Run all installhooks tests**

Run: `go test ./cmd/wsh/cmd/`
Expected: PASS (new + existing).

- [ ] **Step 6: Typecheck + format**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (expected exit 0), `gofmt -l cmd/wsh/cmd/` (expected zero output), `npx prettier --check pi/` (fix with `--write` if flagged).

- [ ] **Step 7: Checkpoint**

Run: `git status` and stop for review.

---

### Task 5: Repo-root `AGENTS.md`

**Files:**
- Create: `AGENTS.md`

**Interfaces:**
- Consumes: the existing `CLAUDE.md` conventions (this file mirrors it for Pi, which reads `AGENTS.md`).
- Produces: a repo-root `AGENTS.md` covering build/dev/test commands, layout, and conventions.

- [ ] **Step 1: Create `AGENTS.md`**

```markdown
# AGENTS.md

Guidance for AI coding agents working in this repository (Pi reads this file; Claude Code reads
CLAUDE.md, which mirrors the same conventions).

## Project

Wave Terminal — an AI-native terminal. This fork migrated the desktop shell from Electron to
Tauri and pivoted toward an agent-cockpit UI. `main` is the Tauri build. The Go backend
(`wavesrv`) and the React 19 + Vite + Tailwind 4 + jotai cockpit (`frontend/`) run together.

## Build & dev commands

- `task init` — first-time setup (npm install + go mod tidy).
- `task dev` — the main way to run: builds the backend, then `cargo tauri dev` (Vite on :5174, HMR).
- `task build:backend` — builds `wavesrv` + `wsh` into `dist/bin/`.
- `task generate` — regenerates TS + Go bindings from Go source. **Run after changing any
  wshrpc / waveobj / wconfig type.** Never hand-edit generated files.
- `npm test` / `npx vitest` — frontend unit tests.
- `npx vitest run frontend/app/view/agents/<file>.test.ts` — single frontend test.
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Lint / format: `npx eslint .`, `npx prettier --check .` (no Task/npm wrapper).
- Visual verification: `task verify:ui -- <scenario>` drives the live dev app over CDP (WebView2
  on :9222 in debug builds); contact sheet in `cdp-shots/index.html`.

## Gotchas

- `npx tsc` stack-overflows on this repo. Typecheck with
  `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- Bare `go test ./pkg/...` fails to build 6 packages (sqlite-vec CGO header). Use
  `task build:backend` or set `CGO_CFLAGS=-I<repo>/pkg/jarvisembed/csrc` (Windows-style path) from
  PowerShell before `go test ./pkg/...`.
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`,
  `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`) — edit Go, run `task generate`.
- A new registered `waveobj` type needs a SQL migration in `db/migrations-wstore/`.
- `cmd/wsh/cmd/{pi-status-extension.ts,arc-theme.json}` are generated by `task sync:piartifacts`
  from `pi/extensions/` and `pi/themes/` — never edit them directly.

## Layout

- `src-tauri/` — Rust shell (thin host; spawns `wavesrv`, exposes six Tauri commands).
- `pkg/` — Go backend: `pkg/wshrpc` (the typed RPC spine), `pkg/consult` (runs/channels),
  `pkg/harness` (agent harness catalog), `pkg/waveobj` + `pkg/wstore` (object model),
  jarvis/memory/vault packages.
- `frontend/` — the cockpit: `frontend/app/store/` (jotai atoms, wshrpc client, WOS),
  `frontend/app/view/agents/` (surfaces + stores), `frontend/app/cockpit/` (window chrome),
  `frontend/app/view/jarvis/` (second-brain surface).
- `pi/` — the arc Pi package: extension, theme, skills, prompts (see `pi/package.json`).
- `docs/` — specs (`docs/superpowers/specs/`), plans (`docs/superpowers/plans/`), briefs,
  open-issues trackers.

## Conventions

- Testable logic is extracted into pure `.ts` files with `.test.ts` beside them; thin `.tsx`
  components render. No jsdom render/snapshot tests — visual checks go through `task verify:ui`.
- Colors come from `@theme` tokens in `frontend/tailwindsetup.css`; never raw hex in components
  (the pi theme under `pi/themes/arc.json` is the exception — it is a TUI theme file).
- Comments explain "why", never "what". Prefer short functions, KISS/YAGNI.
- Never commit without explicit user approval.
```

- [ ] **Step 2: Checkpoint**

Run: `git status` and stop for review.

---

### Task 6: Skill and prompt template

**Files:**
- Create: `pi/skills/arc-dev/SKILL.md`
- Create: `pi/prompts/arc-review.md`

**Interfaces:**
- Consumes: the skill/prompt formats verified from installed packages: skills are directories with a
  `SKILL.md` (frontmatter `name` + `description`); prompts are `.md` files with frontmatter
  `description` and a `$@` marker for the user's message.
- Produces: `.pi/skills/arc-dev` and `.pi/prompts/arc-review.md` resources declared in the package
  manifest (Task 1), loaded by pi when the package is installed.

- [ ] **Step 1: Create the skill**

```markdown
---
name: arc-dev
description: |
  Work inside the arc repo (Wave Terminal fork): build, test, typecheck, and verify
  changes following the repo conventions. Use for any code change in this repository.
---

# Arc Dev

Workflow for changing code in this repository (Tauri cockpit + Go backend).

1. **Regenerate after type changes.** After editing any wshrpc / waveobj / wconfig Go type, run
   `task generate` at the repo root. Never hand-edit generated files
   (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`,
   `pkg/wshrpc/wshclient/wshclient.go`).
2. **Build.** `task build:backend` (sets the CGO flags itself). For a quick server-only build on
   Windows: `task build:backend:quickdev:windows`.
3. **Test.** Frontend: `npx vitest run <file>`. Backend: `go test ./pkg/...` from PowerShell with
   `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`
   (bare `go test ./pkg/...` fails on sqlite-vec headers). Rust: `cargo test --manifest-path
   src-tauri/Cargo.toml`.
4. **Typecheck.** `npx tsc` stack-overflows here. Use
   `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline is clean).
5. **Verify UI.** Run `task dev`, then `task verify:ui -- <scenario>` (CDP scenario harness,
   contact sheet in `cdp-shots/index.html`).
6. **Theme/skill edits.** If changing `pi/themes/arc.json` run `node scripts/validate-pi-theme.mjs`
   and `task sync:piartifacts`; if changing `pi/extensions/` or `pi/themes/`, re-run
   `task sync:piartifacts` so the embedded copies stay in sync.

Conventions: colors from `@theme` tokens only (never raw hex in components); comments explain
"why"; testable logic goes in pure `.ts` with `.test.ts` beside it; never commit without explicit
user approval.
```

- [ ] **Step 2: Create the prompt template**

```markdown
---
description: Review the staged changes in this repo against arc's conventions
---

Review the staged changes (git diff --cached) in this repository. Work from files and commands, not
conversation history.

Check for:

- Scope creep: changes unrelated to the stated task (reformats, renames, refactors of untouched code).
- Comment quality: comments that restate code ("what" comments) instead of explaining "why".
- Conventions drift: raw hex colors in components (must be @theme tokens), hand-edited generated
  files, non-gofmt Go, missing .test.ts beside new pure .ts logic.
- Tests: business logic covered; edge cases (empty input, missing files, malformed records) handled.
- Errors: swallowed errors or generic messages without context.
- Generated-file discipline: `task generate` output present for any wire-type change; no hand edits.

Return a concise findings list ordered by severity, with file:line references. Do not edit files.

$@
```

- [ ] **Step 3: Validate the package manifest references resolve**

Run: `node -e "const p=require('./pi/package.json'); for (const k of ['extensions','skills','prompts','themes']) for (const e of (p.pi[k]||[])) console.log(k, e, require('fs').existsSync(e)?'ok':'MISSING')"`
Expected: every resource resolves (`pi/skills` and `pi/prompts` are directories — adjust the check for directories with `existsSync` + `statSync().isDirectory()`).

- [ ] **Step 4: Typecheck + format**

Run: `npx prettier --check AGENTS.md pi/` (fix with `--write` if flagged).

- [ ] **Step 5: Checkpoint**

Run: `git status` and stop for review.

---

## Self-Review (run after writing; fix inline)

- **Spec coverage (meta Parts C + D):**
  - Theme (C): `pi/themes/arc.json` + validator (Task 3), provisioning copy + `theme: "arc"` default (Task 4), CI check wired as `check:pi-theme` + npm script (Task 3 Step 5). Hot-reload is a pi property, no code.
  - Keybindings (C): minimal merge only when no user file (Task 4); model-picker binding deferred with documented rationale (Global Constraints).
  - AGENTS.md (D): Task 5.
  - Skills + prompts (D): Task 6.
  - Pi package (D): Task 1 manifest; standalone-installable via the `git:` packages entry (Task 4).
  - Provisioning (D): detect pi (existing `piLookPath`), extension install (existing), package entry + theme (Task 4), no-clobber + idempotent report (Task 4). `defaultProvider`/`defaultModel`/`defaultThinkingLevel` deliberately not written (Global Constraints).
- **Placeholder scan:** no TBD/TODO; every code block is complete. The one "check how neighboring tasks handle Windows cp" note in Task 2 Step 2 is a match-existing-conventions instruction, not a placeholder — resolve it by reading `Taskfile.yml` before writing the task.
- **Type consistency:** `arcThemeTemplate` (Task 3/4), `installPiTheme`, `mergePiSettingsDefaults`, `installPiKeybindings`, `containsString`, `arcPackageEntry` are defined in Task 4 and referenced consistently. `task sync:piartifacts` (Task 2) generates `cmd/wsh/cmd/arc-theme.json` consumed by Task 4's embed — Task 4 must run after `sync:piartifacts` has run once, which Task 2 Step 5 guarantees.
