# Shared Agent Memory — Namespace & Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code receive project-scoped facts recorded by Pi, Codex, and its own past sessions, without Arc and the Claude memory tool sharing one directory.

**Architecture:** Arc's vault→Claude export moves out of `~/.claude/projects/<hash>/memory/` (which `ClaudeHubDirs()` enumerates and harvest re-ingests) into a sibling `shared/` directory that harvest never walks. The echo is then prevented by directory layout rather than filter logic. A rendered manifest — one line per fact, bodies left on disk — reaches Claude through a `SessionStart` hook running `wsh agent-memory-project --inject`.

**Tech Stack:** Go (`pkg/memvault`, `pkg/memroots`, `cmd/wsh`), wshrpc codegen, Claude Code `settings.json` hooks.

**Spec:** `docs/superpowers/specs/2026-09-03-shared-agent-memory-namespace-design.md`

## Global Constraints

- **Git: never commit or push without explicit user approval.** Every task ends by *staging* its changes. There is exactly one commit at the end of the whole plan, and only after the user approves it. This overrides the writing-plans skill's per-task commit convention.
- **The spec and this plan fold into the feature commit.** Do not create a docs-only commit for them.
- **No emojis** in code, comments, commit messages, or output.
- **Comments explain "why", never "what".** Lower case. Only where the reason is non-obvious.
- **Never hand-edit generated files.** `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, and `frontend/types/gotypes.d.ts` come from `task generate`.
- **Go test invocation (Windows):** targeted package tests run bare — `go test ./pkg/memvault/`. Only a full `go test ./pkg/...` needs the CGO header path:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
- **Exactly one context field in hook output.** Claude Code reads both `additional_context` and `hookSpecificOutput` without deduplication. Emit `hookSpecificOutput.additionalContext` and nothing else.
- **Hook fail-safe is absolute.** Outside Wave (no `WAVETERM_JWT_TOKEN`), on RPC failure, or with an empty `--cwd`, `--inject` exits 0 and writes **nothing** to stdout. A memory failure must never degrade session start.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `pkg/memvault/projection.go` | Projection targets, export, manifest render | Modify — add `SharedDirForCwd`, `RenderManifest`; repoint `Project()` |
| `pkg/memvault/projection_test.go` | Projection unit tests | Modify — append tests |
| `pkg/memvault/harvest.go` | Vault fold + note writers | Modify — preserve `description` in `foldHubNote` and `writeSourcedNote` |
| `pkg/memvault/harvest_test.go` | Harvest unit tests | Modify — append tests |
| `pkg/wshrpc/wshrpctypes_memory.go` | Memory RPC command declarations | Modify — add `MemoryProjectManifest` |
| `pkg/wshrpc/wshserver/wshserver_memory.go` | Memory RPC server impl | Modify — add handler |
| `cmd/wsh/cmd/wshcmd-agent-memory-project.go` | The `agent-memory-project` CLI command | Modify — add `--inject` |
| `cmd/wsh/cmd/wshcmd-installhooks.go` | Managed hook registration | Modify — add `SessionStart` entry |
| `cmd/wsh/cmd/wshcmd-installhooks_test.go` | Hook registration tests | Modify — append test |
| `pkg/memvault/migrate_hub.go` | One-time eviction of Arc notes from the hub | Create |
| `pkg/memvault/migrate_hub_test.go` | Eviction tests | Create |

Task 4 touches wshrpc declarations; the exact filenames for the memory domain must be confirmed with `ls pkg/wshrpc/wshrpctypes_*.go` before editing, since the interface is split per domain.

---

### Task 1: Export to `shared/`, out of the harvest path

This is the whole of spec stage 1 and is shippable on its own. Today every Arc-written note is re-folded into the vault on each cycle and flagged `gardener_flag: duplicate` — all 14 in the waveterm hub currently are.

**Files:**
- Modify: `pkg/memvault/projection.go` (add `SharedDirForCwd` near `HubDirForCwd:247`; repoint `Project:257`)
- Test: `pkg/memvault/projection_test.go`

**Interfaces:**
- Consumes: `memroots.ProjectHash(cwd) string`, `wavebase.GetHomeDir() string`, `exportToHub(hubDir string, notes []NoteWithBody) (int, int, error)`
- Produces: `SharedDirForCwd(cwd string) string` — used by Tasks 3, 4, and 7.

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/projection_test.go`:

```go
func TestSharedDirIsOutsideHarvestPath(t *testing.T) {
	repo := `C:\Users\k\proj`
	shared := SharedDirForCwd(repo)
	hub := HubDirForCwd(repo)
	if shared == hub {
		t.Fatalf("shared dir must not be the hub dir, both %q", shared)
	}
	if filepath.Base(shared) != "shared" {
		t.Fatalf("shared dir should end in 'shared', got %q", shared)
	}
	// the echo guarantee: both live under the same project hash, but only the hub is enumerated
	if filepath.Dir(shared) != filepath.Dir(hub) {
		t.Fatalf("shared %q and hub %q should be siblings", shared, hub)
	}
	if SharedDirForCwd("") != "" {
		t.Fatalf("empty cwd must yield empty shared dir")
	}
}

func TestClaudeHubDirsNeverEnumeratesShared(t *testing.T) {
	root := t.TempDir()
	projDir := filepath.Join(root, ".claude", "projects", "C--proj")
	if err := os.MkdirAll(filepath.Join(projDir, "memory"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(projDir, "shared"), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := ClaudeHubDirs
	t.Cleanup(func() { ClaudeHubDirs = orig })
	ClaudeHubDirs = func() []string {
		entries, err := os.ReadDir(filepath.Join(root, ".claude", "projects"))
		if err != nil {
			return nil
		}
		var out []string
		for _, e := range entries {
			hub := filepath.Join(root, ".claude", "projects", e.Name(), "memory")
			if info, statErr := os.Stat(hub); statErr == nil && info.IsDir() {
				out = append(out, hub)
			}
		}
		return out
	}
	for _, d := range ClaudeHubDirs() {
		if filepath.Base(d) == "shared" {
			t.Fatalf("harvest would walk the export dir: %q", d)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/memvault/ -run "TestSharedDir|TestClaudeHubDirsNever" -v`
Expected: FAIL, `undefined: SharedDirForCwd`.

- [ ] **Step 3: Add `SharedDirForCwd`**

In `pkg/memvault/projection.go`, immediately after `HubDirForCwd` (ends line 252):

```go
// SharedDirForCwd is the vault -> Claude export target: a sibling of the memory hub, deliberately
// outside ClaudeHubDirs' `*/memory` enumeration. Claude's memory tool authors into the hub and
// maintains its own MEMORY.md index there; exporting into the same directory made harvest re-ingest
// our own output and left Arc-written notes unindexed and invisible.
func SharedDirForCwd(cwd string) string {
	if cwd == "" {
		return ""
	}
	return filepath.Join(wavebase.GetHomeDir(), ".claude", "projects", memroots.ProjectHash(cwd), "shared")
}
```

- [ ] **Step 4: Repoint `Project()`**

In `pkg/memvault/projection.go`, in `Project` (line 257), replace:

```go
	hubDir := HubDirForCwd(cwd)
	if _, _, err := exportToHub(hubDir, notes); err != nil {
		return fmt.Errorf("exporting to hub: %w", err)
	}
```

with:

```go
	if _, _, err := exportToHub(SharedDirForCwd(cwd), notes); err != nil {
		return fmt.Errorf("exporting to shared dir: %w", err)
	}
```

`HubDirForCwd` stays — Task 7's migration reads it, and it remains the correct address of Claude's authored store.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/memvault/ -run "TestSharedDir|TestClaudeHubDirsNever" -v`
Expected: PASS.

- [ ] **Step 6: Run the whole package to check for regressions**

Run: `go test ./pkg/memvault/`
Expected: PASS. Any existing test asserting the export lands in `memory/` is now wrong by design — update it to `SharedDirForCwd` and note the change in your task report.

- [ ] **Step 7: Stage (do not commit)**

```bash
git add pkg/memvault/projection.go pkg/memvault/projection_test.go
```

---

### Task 2: Preserve `description` through fold and export

`Note.Description` already exists (`memvault.go:25`) and `parseNote` reads it. Only the two *writers* drop it, so a vault note has no short form and the manifest has nothing to render. `writeSourcedNote` is shared by four call sites, so its signature change is the invasive part of this task.

**Files:**
- Modify: `pkg/memvault/harvest.go` (`writeSourcedNote:146`, `writeHarvestedNote:182`, `foldHubNote:228`)
- Modify: `pkg/memvault/projection.go` (`exportToHub:194` call site)
- Test: `pkg/memvault/harvest_test.go`

**Interfaces:**
- Consumes: `Note.Description string`, `factHash(body string) string`
- Produces: `synthDescription(body string) string`; `writeSourcedNote(dir, slug, noteType, scope, source, hash, description, body string) (bool, error)` — note the new seventh parameter, before `body`.

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/harvest_test.go`:

```go
func TestSynthDescription(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Use Postgres, not a new dependency. It is already deployed.", "Use Postgres, not a new dependency."},
		{"Single sentence with no period", "Single sentence with no period"},
		{"", ""},
	}
	for _, c := range cases {
		if got := synthDescription(c.in); got != c.want {
			t.Fatalf("synthDescription(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	long := strings.Repeat("a", 300) + ". tail"
	if got := synthDescription(long); len(got) > 200 {
		t.Fatalf("description not capped, len=%d", len(got))
	}
}

func TestFoldHubNotePreservesDescription(t *testing.T) {
	vault := t.TempDir()
	n := Note{ID: "keeps-desc", Description: "the short form", Type: "reference", Scope: "proj"}
	if _, err := foldHubNote(vault, n, "Long body text. Second sentence.\n"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(vault, "keeps-desc.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "description: \"the short form\"") {
		t.Fatalf("description not written:\n%s", data)
	}
}

func TestFoldHubNoteSynthesizesMissingDescription(t *testing.T) {
	vault := t.TempDir()
	n := Note{ID: "no-desc", Type: "learning", Scope: "proj"}
	if _, err := foldHubNote(vault, n, "First sentence here. Second one.\n"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(vault, "no-desc.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "description: \"First sentence here.\"") {
		t.Fatalf("description not synthesized:\n%s", data)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/memvault/ -run "TestSynthDescription|TestFoldHubNote" -v`
Expected: FAIL, `undefined: synthDescription`.

- [ ] **Step 3: Add `synthDescription`**

In `pkg/memvault/harvest.go`, above `writeSourcedNote`:

```go
// synthDescription derives a manifest-sized short form for notes that carry no frontmatter
// description — pi- and codex-sourced facts never have one. First sentence, capped.
func synthDescription(body string) string {
	s := strings.TrimSpace(body)
	if s == "" {
		return ""
	}
	if i := strings.Index(s, ". "); i >= 0 {
		s = s[:i+1]
	} else if strings.HasSuffix(s, ".") {
		s = strings.TrimSuffix(s, ".") + "."
	}
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 200 {
		s = strings.TrimSpace(s[:200])
	}
	return s
}
```

- [ ] **Step 4: Emit `description` from `foldHubNote`**

In `foldHubNote` (line 228), after the `type` line and before `scope`:

```go
	desc := n.Description
	if desc == "" {
		desc = synthDescription(body)
	}
	if desc != "" {
		b.WriteString("  description: " + yamlQuote(desc) + "\n")
	}
```

Note the placement: `description` goes inside the `metadata:` block here, matching how `foldHubNote` already nests `type` and `scope`.

- [ ] **Step 5: Add the parameter to `writeSourcedNote` and update all call sites**

Change the signature (line 146) to:

```go
func writeSourcedNote(dir, slug, noteType, scope, source, hash, description, body string) (bool, error) {
```

and inside, after the `type` line:

```go
	if description == "" {
		description = synthDescription(body)
	}
	if description != "" {
		b.WriteString("  description: " + yamlQuote(description) + "\n")
	}
```

Then update every caller. Find them all first:

Run: `grep -rn "writeSourcedNote(" pkg/ --include="*.go"`

- In `writeHarvestedNote` (line 182), pass `""` for description — the bullet body is the fact and `synthDescription` handles it.
- In `exportToHub` (`projection.go:194`), pass `nw.Note.Description`:

```go
		wrote, werr := writeSourcedNote(dir, boundedSlug(nw.Note.ID, "note"), nw.Note.Type, nw.Note.Scope, "vault", h, nw.Note.Description, nw.Body)
```

Every call site must be updated or the package will not compile — that is the check.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test ./pkg/memvault/ -run "TestSynthDescription|TestFoldHubNote" -v`
Expected: PASS.

- [ ] **Step 7: Run the whole package**

Run: `go test ./pkg/memvault/`
Expected: PASS.

- [ ] **Step 8: Stage (do not commit)**

```bash
git add pkg/memvault/harvest.go pkg/memvault/harvest_test.go pkg/memvault/projection.go
```

---

### Task 3: Render the manifest

One line per fact plus a pointer to the directory holding the bodies. The measured full-body payload for this project is ~16,500 tokens; the manifest target is ~1.2k.

**Files:**
- Modify: `pkg/memvault/projection.go`
- Test: `pkg/memvault/projection_test.go`

**Interfaces:**
- Consumes: `readHubNotes(dir string) []NoteWithBody`, `SharedDirForCwd`, `projectLabel(cwd string, projects map[string]string) string`, `memroots.RegistryProjects() map[string]string`
- Produces: `RenderManifest(cwd string) string` — used by Task 4's RPC handler. Returns `""` when there is nothing to inject.

- [ ] **Step 1: Write the failing test**

Append to `pkg/memvault/projection_test.go`:

```go
func TestRenderManifestLines(t *testing.T) {
	dir := t.TempDir()
	notes := []NoteWithBody{
		{Note: Note{ID: "wsh-not-on-path", Description: "non-interactive launch leaves wsh off PATH"}, Body: "long body"},
		{Note: Note{ID: "no-desc-note"}, Body: "First sentence. Second sentence."},
	}
	got := renderManifestFrom("waveterm", dir, notes)
	if !strings.Contains(got, "Shared project memory: waveterm") {
		t.Fatalf("missing label header:\n%s", got)
	}
	if !strings.Contains(got, "- wsh-not-on-path — non-interactive launch leaves wsh off PATH") {
		t.Fatalf("missing manifest line:\n%s", got)
	}
	if !strings.Contains(got, "- no-desc-note — First sentence.") {
		t.Fatalf("missing synthesized line:\n%s", got)
	}
	if strings.Contains(got, "long body") {
		t.Fatalf("manifest must not carry bodies:\n%s", got)
	}
	if !strings.Contains(got, dir) {
		t.Fatalf("manifest must name the directory holding the bodies:\n%s", got)
	}
}

func TestRenderManifestEmptyIsBlank(t *testing.T) {
	if got := renderManifestFrom("waveterm", t.TempDir(), nil); got != "" {
		t.Fatalf("empty note set must render blank, got %q", got)
	}
}

func TestRenderManifestEmptyCwd(t *testing.T) {
	if got := RenderManifest(""); got != "" {
		t.Fatalf("empty cwd must render blank, got %q", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/memvault/ -run TestRenderManifest -v`
Expected: FAIL, `undefined: renderManifestFrom`.

- [ ] **Step 3: Implement the renderer**

In `pkg/memvault/projection.go`, after `renderFacts` (line 43):

```go
// renderManifestFrom builds the injected manifest: one line per fact, bodies left on disk. Split
// from RenderManifest so the rendering is testable without a home dir or a vault.
func renderManifestFrom(label, sharedDir string, notes []NoteWithBody) string {
	if len(notes) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("## Shared project memory: " + label + "\n")
	b.WriteString("Facts recorded by past Claude, pi, and codex sessions on this project.\n")
	b.WriteString("Read the full body of any fact from: " + sharedDir + "\\<name>.md\n\n")
	for _, nw := range notes {
		desc := nw.Note.Description
		if desc == "" {
			desc = synthDescription(nw.Body)
		}
		if desc == "" {
			continue
		}
		b.WriteString("- " + nw.Note.ID + " — " + desc + "\n")
	}
	return b.String()
}

// RenderManifest renders cwd's shared-memory manifest for injection at session start. Empty cwd, a
// missing shared dir, or no notes all render blank so the caller emits nothing at all.
func RenderManifest(cwd string) string {
	if cwd == "" {
		return ""
	}
	sharedDir := SharedDirForCwd(cwd)
	label := projectLabel(cwd, memroots.RegistryProjects())
	return renderManifestFrom(label, sharedDir, readHubNotes(sharedDir))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/memvault/ -run TestRenderManifest -v`
Expected: PASS.

- [ ] **Step 5: Stage (do not commit)**

```bash
git add pkg/memvault/projection.go pkg/memvault/projection_test.go
```

---

### Task 4: The `MemoryProjectManifest` RPC

`wsh` does not import `pkg/memvault` or `pkg/memroots` today, and `memroots` pulls in `wconfig`. Rather than drag the config watcher into the CLI binary, the server renders the manifest and returns it.

**Files:**
- Modify: the wshrpc memory domain declaration file — confirm with `ls pkg/wshrpc/wshrpctypes_*.go` and `grep -rn "MemoryProjectCommand" pkg/wshrpc/`
- Modify: the matching `pkg/wshrpc/wshserver/wshserver_*.go`
- Regenerate: `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `memvault.Project(cwd string) error`, `memvault.RenderManifest(cwd string) string`, existing `CommandMemoryProjectData{Cwd string}`
- Produces: `wshclient.MemoryProjectManifestCommand(client, CommandMemoryProjectData, *RpcOpts) (string, error)` — used by Task 5.

- [ ] **Step 1: Locate the existing command declaration**

Run: `grep -rn "MemoryProjectCommand" pkg/wshrpc/ --include="*.go" | grep -v wshclient`
Expected: one interface method declaration and one server implementation. Note both file paths before editing.

- [ ] **Step 2: Declare the new command**

Beside the existing `MemoryProjectCommand` declaration in the interface, add:

```go
	MemoryProjectManifestCommand(ctx context.Context, data CommandMemoryProjectData) (string, error)
```

Reuse `CommandMemoryProjectData` — the input is identical and a second single-field struct would be duplication.

- [ ] **Step 3: Implement the handler**

In the matching `wshserver_*.go`, beside the existing memory-project handler:

```go
// MemoryProjectManifestCommand projects cwd's memory and returns the manifest for session-start
// injection. One round trip so the hook cannot inject a manifest older than the projection.
func (ws *WshServer) MemoryProjectManifestCommand(ctx context.Context, data wshrpc.CommandMemoryProjectData) (string, error) {
	if err := memvault.Project(data.Cwd); err != nil {
		return "", err
	}
	return memvault.RenderManifest(data.Cwd), nil
}
```

- [ ] **Step 4: Regenerate the bindings**

Run: `task generate`
Expected: `pkg/wshrpc/wshclient/wshclient.go` gains `MemoryProjectManifestCommand`. Do not hand-edit any generated file.

- [ ] **Step 5: Verify it compiles**

Run: `go build ./pkg/... ./cmd/...`
Expected: exit 0.

- [ ] **Step 6: Stage (do not commit)**

```bash
git add pkg/wshrpc/ frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

### Task 5: `wsh agent-memory-project --inject`

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agent-memory-project.go`

**Interfaces:**
- Consumes: `wshclient.MemoryProjectManifestCommand`, existing `agentMemoryProjectCwd` flag, `wshutil.WaveJwtTokenVarName`
- Produces: the `SessionStart` stdout contract consumed by Task 6's hook.

- [ ] **Step 1: Add the flag**

In `init()`, beside the existing `--cwd` flag:

```go
	agentMemoryProjectCmd.Flags().BoolVar(&agentMemoryProjectInject, "inject", false, "")
```

and declare it beside `agentMemoryProjectCwd`:

```go
var agentMemoryProjectInject bool
```

- [ ] **Step 2: Branch the run function**

Replace the final line of `agentMemoryProjectRun`:

```go
	return wshclient.MemoryProjectCommand(RpcClient, wshrpc.CommandMemoryProjectData{Cwd: agentMemoryProjectCwd}, &wshrpc.RpcOpts{Timeout: 15000})
```

with:

```go
	if !agentMemoryProjectInject {
		return wshclient.MemoryProjectCommand(RpcClient, wshrpc.CommandMemoryProjectData{Cwd: agentMemoryProjectCwd}, &wshrpc.RpcOpts{Timeout: 15000})
	}
	manifest, err := wshclient.MemoryProjectManifestCommand(RpcClient, wshrpc.CommandMemoryProjectData{Cwd: agentMemoryProjectCwd}, &wshrpc.RpcOpts{Timeout: 15000})
	if err != nil || strings.TrimSpace(manifest) == "" {
		return nil // fail-safe: a memory failure must never degrade session start
	}
	// claude code reads both additional_context and hookSpecificOutput without deduplication, so
	// exactly one of them may be emitted
	payload := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     "SessionStart",
			"additionalContext": manifest,
		},
	}
	out, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	fmt.Println(string(out))
	return nil
}
```

Add `encoding/json`, `fmt`, and `strings` to the file's imports.

The three existing early returns (`agentMemoryProjectCwd == ""`, missing JWT, `setupRpcClient` failure) already return nil before any output, which satisfies the fail-safe constraint unchanged.

- [ ] **Step 3: Verify the silent paths by hand**

Run from a shell with no Wave JWT set:

```bash
./dist/bin/wsh-0.14.5-windows.x64.exe agent-memory-project --inject --cwd "$(pwd)"
```

Expected: exit 0, **no stdout output at all**. This is the single most important check in the task — this command runs at the start of every Claude session on the machine.

- [ ] **Step 4: Verify the JSON shape**

Run: `go build ./cmd/wsh/` then, inside a Wave block where the JWT is set, run the same command.
Expected: a single line of JSON parsing as `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`. Confirm with:

```bash
./dist/bin/wsh-0.14.5-windows.x64.exe agent-memory-project --inject --cwd "$(pwd)" | python -c "import json,sys; d=json.load(sys.stdin); print(list(d.keys())); print(d['hookSpecificOutput']['hookEventName'])"
```

Expected: `['hookSpecificOutput']` then `SessionStart`. A second top-level key is a bug — Claude Code would inject the manifest twice.

- [ ] **Step 5: Stage (do not commit)**

```bash
git add cmd/wsh/cmd/wshcmd-agent-memory-project.go
```

---

### Task 6: Register the `SessionStart` hook

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go` (`managedHooks:28`, `isManagedCommand:63`)
- Test: `cmd/wsh/cmd/wshcmd-installhooks_test.go`

**Interfaces:**
- Consumes: `managedHook{Event, Matcher, Args, Timeout}`, `isManagedCommand(command string) bool`
- Produces: a `SessionStart` entry in the user's `settings.json` written by `wsh install-agent-hooks`.

- [ ] **Step 1: Write the failing test**

Append to `cmd/wsh/cmd/wshcmd-installhooks_test.go`:

```go
func TestSessionStartMemoryHookIsManaged(t *testing.T) {
	var found *managedHook
	for i := range managedHooks {
		if managedHooks[i].Event == "SessionStart" && managedHooks[i].Args == "agent-memory-project --inject" {
			found = &managedHooks[i]
			break
		}
	}
	if found == nil {
		t.Fatal("no managed SessionStart memory hook registered")
	}
	if found.Matcher != "startup|clear|compact" {
		t.Fatalf("matcher = %q, want startup|clear|compact", found.Matcher)
	}
	if !isManagedCommand(`"C:\bin\wsh-0.14.5-windows.x64.exe" agent-memory-project --inject`) {
		t.Fatal("SessionStart command not recognized as Arc-managed; re-runs would duplicate it")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestSessionStartMemoryHook -v`
Expected: FAIL, "no managed SessionStart memory hook registered".

- [ ] **Step 3: Register the hook**

In `managedHooks` (line 28), append after the `SessionEnd` entry:

```go
	{"SessionStart", "startup|clear|compact", "agent-memory-project --inject", 15},
```

The matcher mirrors the superpowers plugin's own `SessionStart` hook, so memory is re-injected after `/clear` and after a compaction — both of which drop the previous injection from context.

- [ ] **Step 4: Teach `isManagedCommand` the new subcommand**

In the switch (line 65), extend the case:

```go
	case "agent-hook", "ask", "ask --clear", "agent-memory-hook", "agent-memory-project --inject":
		return true
```

Without this, every `install-agent-hooks` run appends a duplicate `SessionStart` entry instead of replacing the managed one.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./cmd/wsh/cmd/ -run TestSessionStartMemoryHook -v`
Expected: PASS.

- [ ] **Step 6: Run the whole package**

Run: `go test ./cmd/wsh/cmd/`
Expected: PASS. If an existing test asserts an exact managed-hook count or a golden `settings.json`, update it for the new entry.

- [ ] **Step 7: Stage (do not commit)**

```bash
git add cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/wshcmd-installhooks_test.go
```

---

### Task 7: Evict Arc's notes from Claude's hub

14 notes in the waveterm hub carry `source: agent` and all 14 are flagged `gardener_flag: duplicate`. They are Arc's output sitting in the memory tool's namespace. Eviction **moves**, never deletes, and only for notes provably present in the vault.

**Files:**
- Create: `pkg/memvault/migrate_hub.go`
- Test: `pkg/memvault/migrate_hub_test.go`

**Interfaces:**
- Consumes: `readHubNotes`, `HubDirForCwd`, `SharedDirForCwd`, `factHash(body string) string`, `DefaultVaultPath() string`
- Produces: `EvictExportedHubNotes(cwd string) (moved int, kept int, err error)`

- [ ] **Step 1: Write the failing test**

Create `pkg/memvault/migrate_hub_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTestNote(t *testing.T, dir, slug, source, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	fm := "---\nname: " + slug + "\nmetadata:\n  type: reference\n"
	if source != "" {
		fm += "  source: " + source + "\n"
	}
	fm += "---\n\n" + body + "\n"
	if err := os.WriteFile(filepath.Join(dir, slug+".md"), []byte(fm), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEvictMovesOnlyVaultBackedAgentNotes(t *testing.T) {
	hub := t.TempDir()
	shared := t.TempDir()
	vault := t.TempDir()

	writeTestNote(t, hub, "authored-by-claude", "", "a fact claude wrote")
	writeTestNote(t, hub, "safe-to-evict", "agent", "a fact arc exported")
	writeTestNote(t, hub, "orphan-not-in-vault", "agent", "a fact only here")
	writeTestNote(t, vault, "safe-to-evict", "vault", "a fact arc exported")

	moved, kept, err := evictExportedNotes(hub, shared, vault)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 1 {
		t.Fatalf("moved = %d, want 1", moved)
	}
	if kept != 1 {
		t.Fatalf("kept = %d, want 1 (the orphan)", kept)
	}
	if _, err := os.Stat(filepath.Join(hub, "authored-by-claude.md")); err != nil {
		t.Fatal("claude-authored note must never be touched")
	}
	if _, err := os.Stat(filepath.Join(hub, "safe-to-evict.md")); !os.IsNotExist(err) {
		t.Fatal("vault-backed agent note should have left the hub")
	}
	if _, err := os.Stat(filepath.Join(shared, "safe-to-evict.md")); err != nil {
		t.Fatal("evicted note should land in shared/")
	}
	if _, err := os.Stat(filepath.Join(hub, "orphan-not-in-vault.md")); err != nil {
		t.Fatal("a note absent from the vault must be moved, not lost — it stays until copied")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/memvault/ -run TestEvict -v`
Expected: FAIL, `undefined: evictExportedNotes`.

- [ ] **Step 3: Implement the migration**

Create `pkg/memvault/migrate_hub.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memvault

import (
	"os"
	"path/filepath"
)

// evictExportedNotes moves Arc-written notes (source != "") out of Claude's authored hub and into
// the shared dir. A note whose body hash is not already in the vault is left in place: a fact that
// exists nowhere else must not be destroyed by a namespace cleanup.
func evictExportedNotes(hubDir, sharedDir, vaultDir string) (int, int, error) {
	vaultHashes := map[string]bool{}
	for _, nw := range readHubNotes(vaultDir) {
		vaultHashes[factHash(nw.Body)] = true
	}
	moved, kept := 0, 0
	for _, nw := range readHubNotes(hubDir) {
		if nw.Note.Source == "" {
			continue // authored by the memory tool; not ours to move
		}
		if !vaultHashes[factHash(nw.Body)] {
			kept++
			continue
		}
		if err := os.MkdirAll(sharedDir, 0o755); err != nil {
			return moved, kept, err
		}
		dst := filepath.Join(sharedDir, filepath.Base(nw.Note.Path))
		if err := os.Rename(nw.Note.Path, dst); err != nil {
			return moved, kept, err
		}
		moved++
	}
	return moved, kept, nil
}

// EvictExportedHubNotes is the one-time migration entry point for cwd's project.
func EvictExportedHubNotes(cwd string) (int, int, error) {
	return evictExportedNotes(HubDirForCwd(cwd), SharedDirForCwd(cwd), DefaultVaultPath())
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/memvault/ -run TestEvict -v`
Expected: PASS.

- [ ] **Step 5: Dry-run against the real hub before touching it**

Back up first, then count what would move:

```bash
cp -r "/c/Users/kael02/.claude/projects/C--Users-kael02-IdeaProjects-waveterm/memory" "$TEMP/hub-backup-$(date +%s)"
cd "/c/Users/kael02/.claude/projects/C--Users-kael02-IdeaProjects-waveterm/memory" && grep -l "^  source:" *.md | wc -l
```

Expected: 14. If the count differs, stop and report — the hub changed since the spec was measured.

- [ ] **Step 6: Stage (do not commit)**

```bash
git add pkg/memvault/migrate_hub.go pkg/memvault/migrate_hub_test.go
```

---

### Task 8: Live round-trip verification

No new files. This proves the loop rather than assuming it.

- [ ] **Step 1: Rebuild the backend**

Run: `task build:backend`
Expected: exit 0. The new RPC does not exist in the running `wavesrv` until this completes; skipping it makes every later check fail with a route error.

- [ ] **Step 2: Install the hook**

Run: `./dist/bin/wsh-0.14.5-windows.x64.exe install-agent-hooks`
Then confirm the entry landed exactly once:

```bash
grep -c "agent-memory-project --inject" /c/Users/kael02/.claude/settings.json
```

Expected: `1`. Run `install-agent-hooks` a second time and re-check — still `1`, proving Task 6 Step 4 works.

- [ ] **Step 3: Confirm the export moved**

Run: `ls "/c/Users/kael02/.claude/projects/C--Users-kael02-IdeaProjects-waveterm/shared/" | wc -l`
Expected: non-zero after a projection runs.

- [ ] **Step 4: Confirm no new duplicates**

Run: `grep -l "gardener_flag: duplicate" /c/Users/kael02/.claude/projects/C--Users-kael02-IdeaProjects-waveterm/memory/*.md | wc -l`
Expected: `0` after Task 7's eviction runs. This is success criterion 2.

- [ ] **Step 5: Confirm the Pi → Claude path**

Record a fact in a pi session in this repo, let it shut down (which enqueues the transcript), then start a fresh Claude session here and confirm the fact's line appears in the injected manifest.

- [ ] **Step 6: Confirm a session outside Wave is unaffected**

Start Claude Code in a directory with no Wave block and confirm no manifest is injected and no error appears. This is success criterion 5.

- [ ] **Step 7: Report results, then request commit approval**

Report which checks passed with their actual output. Then ask the user to approve a single commit covering the spec, this plan, and all code changes. Do not commit before that approval.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §6.1 projection target | Task 1 |
| §6.2 manifest format + `description` gap | Tasks 2, 3 |
| §6.3 `--inject` contract | Tasks 4, 5 |
| §6.4 hook wiring | Task 6 |
| §7 migration + precondition | Task 7 |
| §9 testing | Tasks 1-7 unit steps, Task 8 live |
| §10 Q1 SessionStart schema | **Resolved before planning** — verified against the superpowers plugin's on-disk emitter; envelope and the single-field rule are in Global Constraints |
| §11 success criteria | Task 8 steps 4, 5, 6 |

**Deliberately unaddressed**, matching spec §4 non-goals: the 35 dead `MEMORY.md` links, the 19 legacy `C---Users--` memories, and the 6 worktree-stranded hubs. Spec §10 Q2 (global vs project scope) and Q3 (staleness) stay open; the implementation inherits `vaultNotesForProject`'s existing behavior, which already includes `""`/`shared` scoped notes.

**Type consistency:** `SharedDirForCwd` (Tasks 1, 3, 7), `synthDescription` (Tasks 2, 3), `renderManifestFrom`/`RenderManifest` (Tasks 3, 4), `MemoryProjectManifestCommand` (Tasks 4, 5), `evictExportedNotes`/`EvictExportedHubNotes` (Task 7) are each spelled identically at every use. `writeSourcedNote`'s new `description` parameter sits seventh, before `body`, in both the definition and the `exportToHub` call site.

**Known risk:** Task 4's file paths are given as a grep rather than a literal, because the wshrpc interface is split per domain and the memory domain's filename was not confirmed. Step 1 of that task resolves it before any edit.
