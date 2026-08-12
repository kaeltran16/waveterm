# Pi Part B — Bidirectional Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pi↔arc integration bidirectional: pi drives arc via four `wave_*` tools (B1), meaningful pi events surface as arc notifications through a new `wsh notify` endpoint (B3), and arc steers live pi sessions through a per-session control-file pipe (B2).

**Architecture:** A new self-contained pi extension (`pi/extensions/waveterm-tools.ts`) registers the tools, maps pi events to `wsh notify`, and watches `WAVETERM_PI_CONTROL_DIR` for `<sessionId>.json` command files; wavesrv writes those files via a new `PiSendControlCommand` and publishes notifications via `NotifyCommand` on the existing wps broker; the cockpit renders a toast stack and a steer input. Pure logic (argv builders, control-file parser, notification store) is extracted and unit-tested; the extension glue and UI components stay thin.

**Tech Stack:** Go (wshrpc domain, wsh CLI, provisioning), pi extension TypeScript (tools/watcher), React 19 + jotai + Tailwind 4 (toast + steer UI), Vitest, task generate.

**Spec:** [`docs/superpowers/specs/2026-08-12-pi-partb-bidirectional-design.md`](../specs/2026-08-12-pi-partb-bidirectional-design.md). Read it before starting.

## Global Constraints

- Target pi **0.84.1** (same as the spec). Extension APIs used — `registerTool`, `sendUserMessage`, `setSessionName`, `ctx.compact`, `ctx.abort`, `ctx.newSession`, `ctx.switchSession` — exist in that version.
- **Documented deviation from the spec (flag at the batched commit):** the spec says `PiSendControlCommand` "validates the session is a known pi agent session". There is no reliable server-side registry keyed by pi session id (the cockpit roster lives in the wstore agents table; `agentsessions.ScanSessions` parses only claude/codex transcripts). The implementation validates **shape only** (sessionid non-empty, command in the set). The extension is the authority — it only consumes files matching its own session id — and stale files are bounded because the frontend only sends session ids it saw from real `agentstatus` reports. The spec's sentence should be amended when this plan lands.
- **Documented deviation from the spec (flag at the batched commit):** `wave_open_file`'s optional `line` parameter is **not** implemented in v1 — `wsh editor` has no confirmed line-number meta key. The parameter is omitted from the v1 tool schema; add it when the edit view supports it.
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows; baseline exit 0).
- Go tests for `pkg/wshrpc/wshserver` need the CGO_CFLAGS env from the Taskfile. From PowerShell, before any `go test ./pkg/...`:
  `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`.
  `go test ./cmd/wsh/cmd/` needs no CGO workaround.
- `gofmt -l` must be zero on every Go file you touch; run `gofmt -w` after writing.
- **Run `task generate` after any wshrpc/wps/tsgen type change** (Tasks 1 and 5 regenerate bindings). Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, tsgen event outputs).
- `cmd/wsh/cmd/pi-tools-extension.ts` and `cmd/wsh/cmd/pi-tools-core-extension.ts` are **generated sync targets** — never hand-edit them; run `task sync:piartifacts` after changing the `pi/extensions/` sources.
- Vitest: `npx vitest run <file>` for a single test file; `npm test` for the suite.
- Colors in new frontend UI come from `@theme` tokens (`frontend/tailwindsetup.css`), never raw hex.
- **No commits during execution.** This repo's rule: never commit without explicit human approval; one batched commit at the end (the skill's per-task commit steps are omitted for this reason). The batched commit also carries the two spec amendments above.
- The plan's live round-trip (Task 8) needs a running dev wavesrv (`task dev`) and a pi session launched from a Wave tab; the extension install happens via `wsh install-agent-hooks` (or the `~/.pi/agent/extensions/` copy after Task 5).
- Extension files are inert outside a Wave block (no `WAVETERM_BLOCKID` / `WAVETERM_PI_CONTROL_DIR`), matching the existing `waveterm-status.ts` contract.

---

## File Map

**Backend (Go)**
- Create: `pkg/wshrpc/wshrpctypes_picontrol.go` — `NotifyCommandData`, `PiControlCommandData`, `PiControlCommands` interface.
- Modify: `pkg/wshrpc/wshrpctypes.go` — compose `PiControlCommands` into `WshRpcInterface`.
- Create: `pkg/wshrpc/wshserver/wshserver_picontrol.go` — `NotifyCommand`, `PiSendControlCommand` handlers + pure validation/write helpers.
- Create: `pkg/wshrpc/wshserver/wshserver_picontrol_test.go`.
- Modify: `pkg/wps/wpstypes.go` — add `Event_Notify = "notify"` const.
- Modify: `pkg/tsgen/tsgenevent.go` — add the event→type entry.
- Create: `cmd/wsh/cmd/wshcmd-notify.go` — `wsh notify` CLI.
- Create: `cmd/wsh/cmd/wshcmd-notify_test.go`.
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go` — embed + install the tools extension pair.
- Modify: `Taskfile.yml` — `sync:piartifacts` copies the tools extension pair.
- Modify: `pi/package.json` — manifest `pi.extensions` gains the tools pair.

**Extension (TypeScript)**
- Create: `pi/extensions/waveterm-tools-core.ts` — pure helpers (no external imports; no-op default export so pi's auto-load tolerates it).
- Create: `pi/extensions/waveterm-tools-core.test.ts` — Vitest for the helpers.
- Create: `pi/extensions/waveterm-tools.ts` — extension glue: 4 tool registrations, notify event mappings, control-channel watcher.

**Frontend**
- Create: `frontend/app/cockpit/notificationstore.ts` + `notificationstore.test.ts`.
- Create: `frontend/app/cockpit/notificationtoasts.tsx`.
- Modify: `frontend/app/cockpit/cockpit-root.tsx` — mount toasts + subscription.
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx` — steer input for pi sessions.
- Create: `frontend/app/view/agents/pi-control.test.ts` — pure helper for the steer call.

**Verification**
- Modify: `scripts/cdp/scenarios.mjs` — extend the surface-smoke scenario.

---

### Task 1: wshrpc pi-control domain + server handlers (Go, TDD)

**Files:**
- Create: `pkg/wshrpc/wshrpctypes_picontrol.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` (compose interface)
- Create: `pkg/wshrpc/wshserver/wshserver_picontrol.go`
- Create: `pkg/wshrpc/wshserver/wshserver_picontrol_test.go`
- Modify: `pkg/wps/wpstypes.go`, `pkg/tsgen/tsgenevent.go`

**Interfaces:**
- Consumes: existing `wps.Broker.Publish(wps.WaveEvent{...})` (`pkg/wshrpc/wshserver/wshserver.go:179`), `wavebase.DataHome_VarCache` (`pkg/wavebase/wavebase.go`).
- Produces: `wshrpc.NotifyCommandData`, `wshrpc.PiControlCommandData`, `wshrpc.PiControlCommands` interface, `wps.Event_Notify` const, server methods `NotifyCommand` / `PiSendControlCommand`.

- [ ] **Step 1: Write the failing server tests**

`pkg/wshrpc/wshserver/wshserver_picontrol_test.go`:

```go
package wshserver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestValidateNotifyData(t *testing.T) {
	if err := validateNotifyData(wshrpc.NotifyCommandData{Title: "hi"}); err != nil {
		t.Fatalf("valid notify rejected: %v", err)
	}
	for _, tc := range []struct {
		name string
		data wshrpc.NotifyCommandData
		want string
	}{
		{"empty title", wshrpc.NotifyCommandData{}, "title is required"},
		{"bad level", wshrpc.NotifyCommandData{Title: "hi", Level: "loud"}, "invalid notify level"},
	} {
		if err := validateNotifyData(tc.data); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want error containing %q", tc.name, err, tc.want)
		}
	}
}

func TestValidatePiControlData(t *testing.T) {
	if err := validatePiControlData(wshrpc.PiControlCommandData{SessionId: "s1", Command: "steer"}); err != nil {
		t.Fatalf("valid control rejected: %v", err)
	}
	for _, tc := range []struct {
		name string
		data wshrpc.PiControlCommandData
		want string
	}{
		{"empty session", wshrpc.PiControlCommandData{Command: "steer"}, "sessionid"},
		{"unknown command", wshrpc.PiControlCommandData{SessionId: "s1", Command: "moo"}, "unknown command"},
	} {
		if err := validatePiControlData(tc.data); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want error containing %q", tc.name, err, tc.want)
		}
	}
}

func TestWriteControlFileAtomic(t *testing.T) {
	dir := t.TempDir()
	data := wshrpc.PiControlCommandData{SessionId: "sess-1", Command: "steer", Content: "look at this"}
	if err := writeControlFile(dir, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	path := filepath.Join(dir, "sess-1.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading control file: %v", err)
	}
	var got struct {
		Cmd     string `json:"cmd"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Cmd != "steer" || got.Content != "look at this" {
		t.Fatalf("got %+v, want cmd=steer content='look at this'", got)
	}
	// overwrite is atomic: no *.tmp leftovers, second write replaces
	if err := writeControlFile(dir, wshrpc.PiControlCommandData{SessionId: "sess-1", Command: "abort"}); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	raw2, _ := os.ReadFile(path)
	if !strings.Contains(string(raw2), `"cmd":"abort"`) {
		t.Fatalf("rewrite did not replace: %s", string(raw2))
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected exactly one file, got %d (%v)", len(entries), entries)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

From PowerShell (wshserver tests need CGO_CFLAGS):

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wshrpc/wshserver/ -run 'TestValidate|TestWriteControlFile'
```

Expected: FAIL — undefined: `validateNotifyData` / `validatePiControlData` / `writeControlFile`.

- [ ] **Step 3: Create the wshrpc types**

`pkg/wshrpc/wshrpctypes_picontrol.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// NotifyCommandData is the payload for wsh notify and the wave_notify tool.
type NotifyCommandData struct {
	Title   string `json:"title"`
	Message string `json:"message"`
	Level   string `json:"level"` // info | warn | error (default info)
}

// PiControlCommandData is a steering command for a live pi session. The extension
// consumes {cmd, content, name, path} from the control file (see writeControlFile).
type PiControlCommandData struct {
	SessionId string `json:"sessionid"`
	Command   string `json:"command"` // steer | follow_up | set_session_name | compact | abort | new_session | switch_session
	Content   string `json:"content"` // steer / follow_up message text
	Name      string `json:"name"`    // set_session_name target
	Path      string `json:"path"`    // switch_session target session file
}

// PiControlCommands is the wshrpc domain for pi steering and notifications.
type PiControlCommands interface {
	NotifyCommand(ctx context.Context, data NotifyCommandData) error
	PiSendControlCommand(ctx context.Context, data PiControlCommandData) error
}
```

- [ ] **Step 4: Compose the interface**

In `pkg/wshrpc/wshrpctypes.go`, add `PiControlCommands` to the `WshRpcInterface` body next to the existing `AskCommands` entry:

```go
	AskCommands
	PiControlCommands
```

- [ ] **Step 5: Add the notify event constant**

In `pkg/wps/wpstypes.go`, in the event-const block (next to `Event_AgentStatus = "agent:status"`), add:

```go
	Event_Notify             = "notify"             // type: wshrpc.NotifyCommandData
```

- [ ] **Step 6: Add the tsgen event mapping**

In `pkg/tsgen/tsgenevent.go`, in the `WaveEventDataTypes` map (next to the `wps.Event_AgentStatus:` entry), add:

```go
	wps.Event_Notify: reflect.TypeOf(wshrpc.NotifyCommandData{}),
```

(`tsgenevent.go` imports both `baseds` and `wshrpc` — the map references `wshrpc.TimeSeriesData` for the sysinfo event. Verify with `grep -n "wshrpc" pkg/tsgen/tsgenevent.go | head -3`; if the import is absent, add it.)

- [ ] **Step 7: Implement the server handlers**

`pkg/wshrpc/wshserver/wshserver_picontrol.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const piControlDirName = "pi-control"

var validPiControlCommands = map[string]bool{
	"steer": true, "follow_up": true, "set_session_name": true,
	"compact": true, "abort": true, "new_session": true, "switch_session": true,
}

func validateNotifyData(data wshrpc.NotifyCommandData) error {
	if data.Title == "" {
		return fmt.Errorf("notify title is required")
	}
	if data.Level != "" && data.Level != "info" && data.Level != "warn" && data.Level != "error" {
		return fmt.Errorf("invalid notify level %q (want info, warn, or error)", data.Level)
	}
	return nil
}

func validatePiControlData(data wshrpc.PiControlCommandData) error {
	if data.SessionId == "" {
		return fmt.Errorf("pi control: sessionid is required")
	}
	if !validPiControlCommands[data.Command] {
		return fmt.Errorf("pi control: unknown command %q", data.Command)
	}
	return nil
}

// controlFile mirrors the extension's JSON protocol: {cmd, content, name, path}.
type controlFile struct {
	Cmd     string `json:"cmd"`
	Content string `json:"content,omitempty"`
	Name    string `json:"name,omitempty"`
	Path    string `json:"path,omitempty"`
}

// writeControlFile writes <dir>/<sessionId>.json atomically (temp file + rename).
func writeControlFile(dir string, data wshrpc.PiControlCommandData) error {
	payload, err := json.Marshal(controlFile{Cmd: data.Command, Content: data.Content, Name: data.Name, Path: data.Path})
	if err != nil {
		return fmt.Errorf("marshaling control command: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "*.tmp")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return fmt.Errorf("writing temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing temp file: %w", err)
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, data.SessionId+".json")); err != nil {
		return fmt.Errorf("moving control file into place: %w", err)
	}
	return nil
}

func (ws *WshServer) NotifyCommand(ctx context.Context, data wshrpc.NotifyCommandData) error {
	if err := validateNotifyData(data); err != nil {
		return err
	}
	if data.Level == "" {
		data.Level = "info"
	}
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_Notify, Data: data})
	return nil
}

func (ws *WshServer) PiSendControlCommand(ctx context.Context, data wshrpc.PiControlCommandData) error {
	if err := validatePiControlData(data); err != nil {
		return err
	}
	dir := filepath.Join(wavebase.DataHome_VarCache, piControlDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating pi control dir: %w", err)
	}
	return writeControlFile(dir, data)
}
```

- [ ] **Step 8: Run tests to verify they pass**

Same PowerShell env as Step 2, run:

```powershell
go test ./pkg/wshrpc/wshserver/ -run 'TestValidate|TestWriteControlFile'
```

Expected: PASS (3 tests).

- [ ] **Step 9: Regenerate bindings**

Run: `task generate`
Expected: regenerates `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, and the tsgen event bindings — including `NotifyCommand`/`PiSendControlCommand` client calls and the `notify` wave-event type. Verify the client calls exist: `grep -n "PiSendControlCommand\|NotifyCommand" pkg/wshrpc/wshclient/wshclient.go | head`.

- [ ] **Step 10: gofmt + typecheck**

Run: `gofmt -w pkg/wshrpc/wshrpctypes_picontrol.go pkg/wshrpc/wshserver/wshserver_picontrol.go pkg/wshrpc/wshserver/wshserver_picontrol_test.go pkg/wshrpc/wshrpctypes.go pkg/wps/wpstypes.go pkg/tsgen/tsgenevent.go` then `gofmt -l pkg/wshrpc pkg/wps pkg/tsgen` (zero output).

Then in the repo root (frontend untouched yet, but the generated types must compile):

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: exit 0.

- [ ] **Step 11: Checkpoint — stop for review.** Summary: new wshrpc domain, notify event, tests green, bindings regenerated.

---

### Task 2: `wsh notify` CLI (Go, TDD)

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-notify.go`
- Create: `cmd/wsh/cmd/wshcmd-notify_test.go`

**Interfaces:**
- Consumes: `wshrpc.NotifyCommandData` (Task 1), `wshclient.NotifyCommand` (generated, Task 1).
- Produces: `notifyCmd` cobra command, `notifyDataFromArgs(title, message, level string) wshrpc.NotifyCommandData`.

- [ ] **Step 1: Write the failing test**

`cmd/wsh/cmd/wshcmd-notify_test.go`:

```go
package cmd

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestNotifyDataFromArgs(t *testing.T) {
	got := notifyDataFromArgs("build failed", "the build failed", "error")
	want := wshrpc.NotifyCommandData{Title: "build failed", Message: "the build failed", Level: "error"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if got := notifyDataFromArgs("hi", "", ""); got.Level != "" {
		t.Fatalf("default level should be empty (server defaults to info), got %q", got.Level)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/wsh/cmd/ -run TestNotifyDataFromArgs`
Expected: FAIL — undefined: `notifyDataFromArgs`.

- [ ] **Step 3: Write the CLI command**

`cmd/wsh/cmd/wshcmd-notify.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var notifyMessage string
var notifyLevel string

var notifyCmd = &cobra.Command{
	Use:   "notify [title]",
	Short: "send a Wave notification (title required)",
	Args:  cobra.ExactArgs(1),
	RunE:  notifyRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	notifyCmd.Flags().StringVar(&notifyMessage, "message", "", "notification message body")
	notifyCmd.Flags().StringVar(&notifyLevel, "level", "", "notification level (info, warn, error)")
	rootCmd.AddCommand(notifyCmd)
}

func notifyDataFromArgs(title, message, level string) wshrpc.NotifyCommandData {
	return wshrpc.NotifyCommandData{Title: title, Message: message, Level: level}
}

func notifyRun(cmd *cobra.Command, args []string) error {
	err := wshclient.NotifyCommand(RpcClient, notifyDataFromArgs(args[0], notifyMessage, notifyLevel), &wshrpc.RpcOpts{Timeout: 5000})
	if err != nil {
		return fmt.Errorf("sending notification: %w", err)
	}
	WriteStdout("notification sent\n")
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/wsh/cmd/ -run TestNotifyDataFromArgs`
Expected: PASS.

- [ ] **Step 5: gofmt**

Run: `gofmt -w cmd/wsh/cmd/wshcmd-notify.go cmd/wsh/cmd/wshcmd-notify_test.go` then `gofmt -l cmd/wsh/cmd` (zero output).

- [ ] **Step 6: Checkpoint — stop for review.** Summary: `wsh notify` CLI, test green.

---

### Task 3: Extension core — pure helpers (TypeScript, Vitest TDD)

**Files:**
- Create: `pi/extensions/waveterm-tools-core.ts`
- Create: `pi/extensions/waveterm-tools-core.test.ts`

**Interfaces:**
- Consumes: nothing (no external imports — this is what keeps it vitest-testable in the repo, which has no typebox).
- Produces: `CONTROL_COMMANDS`, `ControlCommand`, `PiControlCommand`, `controlFileName(sessionId)`, `runCommandArgs(command, cwd?)`, `captureTailArgs(blockId)`, `openFileArgs(absPath)`, `querySessionsArgs()`, `notifyArgs(title, opts?)`, `parseControlCommand(raw)`.

- [ ] **Step 1: Write the failing test**

`pi/extensions/waveterm-tools-core.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
    captureTailArgs,
    controlFileName,
    notifyArgs,
    openFileArgs,
    parseControlCommand,
    querySessionsArgs,
    runCommandArgs,
} from "./waveterm-tools-core";

describe("waveterm-tools-core", () => {
    it("builds wsh run argv with an optional cwd", () => {
        expect(runCommandArgs("echo hi", "C:\\proj")).toEqual(["run", "--cwd", "C:\\proj", "-c", "echo hi"]);
        expect(runCommandArgs("echo hi")).toEqual(["run", "-c", "echo hi"]);
    });

    it("builds the capture-tail argv", () => {
        expect(captureTailArgs("b1")).toEqual(["termscrollback", "-b", "b1", "--lastcommand"]);
    });

    it("builds open-file and query-sessions argv", () => {
        expect(openFileArgs("C:\\a.txt")).toEqual(["editor", "C:\\a.txt"]);
        expect(querySessionsArgs()).toEqual(["blocks", "list", "--json"]);
    });

    it("builds notify argv with optional message and level", () => {
        expect(notifyArgs("t")).toEqual(["notify", "t"]);
        expect(notifyArgs("t", { message: "m", level: "error" })).toEqual(["notify", "t", "--message", "m", "--level", "error"]);
        expect(notifyArgs("t", { level: "info" })).toEqual(["notify", "t"]);
    });

    it("names control files by session id", () => {
        expect(controlFileName("sess-1")).toBe("sess-1.json");
    });

    it("parses a valid control command", () => {
        const cmd = parseControlCommand(JSON.stringify({ cmd: "steer", content: "look at this" }));
        expect(cmd).toEqual({ cmd: "steer", content: "look at this", name: "", path: "" });
    });

    it("rejects malformed or unknown control commands", () => {
        expect(parseControlCommand("not json")).toBeNull();
        expect(parseControlCommand(JSON.stringify({ cmd: "moo" }))).toBeNull();
        expect(parseControlCommand(JSON.stringify({ content: "no cmd" }))).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run pi/extensions/waveterm-tools-core.test.ts`
Expected: FAIL — cannot resolve `./waveterm-tools-core` (module missing).

- [ ] **Step 3: Write the core module**

`pi/extensions/waveterm-tools-core.ts`:

```typescript
// Pure helpers for the waveterm tools + steering extension. No external imports so the repo's
// vitest can cover it. The default export is a no-op: pi auto-loads every file in the extensions
// directory, and this module is a dependency, not an extension.

export const CONTROL_COMMANDS = [
    "steer",
    "follow_up",
    "set_session_name",
    "compact",
    "abort",
    "new_session",
    "switch_session",
] as const;

export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

export interface PiControlCommand {
    cmd: ControlCommand;
    content: string;
    name: string;
    path: string;
}

export function controlFileName(sessionId: string): string {
    return `${sessionId}.json`;
}

export function runCommandArgs(command: string, cwd?: string): string[] {
    const args = ["run"];
    if (cwd) {
        args.push("--cwd", cwd);
    }
    return [...args, "-c", command];
}

export function captureTailArgs(blockId: string): string[] {
    return ["termscrollback", "-b", blockId, "--lastcommand"];
}

export function openFileArgs(absPath: string): string[] {
    return ["editor", absPath];
}

export function querySessionsArgs(): string[] {
    return ["blocks", "list", "--json"];
}

export function notifyArgs(title: string, opts: { message?: string; level?: string } = {}): string[] {
    const args = ["notify", title];
    if (opts.message) {
        args.push("--message", opts.message);
    }
    if (opts.level && opts.level !== "info") {
        args.push("--level", opts.level);
    }
    return args;
}

export function parseControlCommand(raw: string): PiControlCommand | null {
    let j: unknown;
    try {
        j = JSON.parse(raw);
    } catch {
        return null;
    }
    const obj = j as Record<string, unknown>;
    if (typeof obj.cmd !== "string" || !(CONTROL_COMMANDS as readonly string[]).includes(obj.cmd)) {
        return null;
    }
    return {
        cmd: obj.cmd as ControlCommand,
        content: typeof obj.content === "string" ? obj.content : "",
        name: typeof obj.name === "string" ? obj.name : "",
        path: typeof obj.path === "string" ? obj.path : "",
    };
}

export default function noop(): void {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run pi/extensions/waveterm-tools-core.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Checkpoint — stop for review.** Summary: pure helper module + tests green.

---

### Task 4: Extension glue — tools, notify mappings, control watcher (TypeScript)

**Files:**
- Create: `pi/extensions/waveterm-tools.ts`

**Interfaces:**
- Consumes: all `waveterm-tools-core.ts` exports (Task 3); pi 0.84.1 APIs `registerTool`, `on`, `sendUserMessage`, `setSessionName`, `exec`; ctx APIs `compact`, `abort`, `newSession`, `switchSession`.
- Produces: `registerWavetermTools(pi, wshPath)` and the default extension export.

- [ ] **Step 1: Write the extension**

`pi/extensions/waveterm-tools.ts` — a single self-contained file. Follow the `pi/extensions/waveterm-status.ts` layout: comments at the top documenting the `__WSH_PATH__` substitution and the inert-outside-Wave contract, a `registerWavetermTools` function, and a default export calling it with the placeholder:

```typescript
// pi extension: wave_* tools (pi drives arc), notification bridge (B3), and the control
// channel watcher (arc steers pi). Installed by `wsh install-agent-hooks` into
// ~/.pi/agent/extensions/waveterm-tools.ts with __WSH_PATH__ substituted for the absolute wsh
// path. Bare pi outside a Wave block is inert: the tools fail closed with a clear error, the
// watcher needs WAVETERM_PI_CONTROL_DIR.
import { existsSync, readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
    captureTailArgs,
    controlFileName,
    notifyArgs,
    openFileArgs,
    parseControlCommand,
    querySessionsArgs,
    runCommandArgs,
    type PiControlCommand,
} from "./waveterm-tools-core";

export function registerWavetermTools(pi: any, wshPath: string): void {
    const wsh = async (args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
        try {
            const { stdout } = await pi.exec(wshPath, args);
            return { ok: true, stdout, stderr: "" };
        } catch (e) {
            return { ok: false, stdout: "", stderr: String(e) };
        }
    };

    // --- B1: wave_* tools --------------------------------------------------

    pi.registerTool({
        name: "wave_run_command",
        label: "Run Command in Wave",
        description: "Run a command visibly in a new Wave tab and return the command's block id.",
        promptSnippet: "Run a command visibly in a Wave tab",
        promptGuidelines: ["Use wave_run_command when the user wants a command run and visible in Wave."],
        parameters: Type.Object({
            command: Type.String({ description: "Full command line to run (shell string)" }),
            cwd: Type.Optional(Type.String({ description: "Working directory for the command" })),
            capture: Type.Optional(Type.Boolean({ description: "Also return a truncated tail of the output" })),
        }),
        async execute(_toolCallId: string, params: any): Promise<unknown> {
            const r = await wsh(runCommandArgs(params.command, params.cwd));
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_run_command failed: ${r.stderr}` }], details: {} };
            }
            let text = r.stdout.trim();
            if (params.capture) {
                const blockId = (r.stdout.match(/block\s+(\S+)/i)?.[1] ?? "").trim();
                if (blockId) {
                    const tail = await wsh(captureTailArgs(blockId));
                    text += `\n\nTail:\n${tail.ok ? tail.stdout.slice(-4000) : tail.stderr}`;
                }
            }
            return { content: [{ type: "text", text }], details: {} };
        },
    });

    pi.registerTool({
        name: "wave_open_file",
        label: "Open File in Wave",
        description: "Open an existing file in a Wave tab.",
        promptSnippet: "Open a file in a Wave tab",
        promptGuidelines: ["Use wave_open_file when the user wants a file opened in Wave."],
        parameters: Type.Object({
            path: Type.String({ description: "Absolute path to the file to open" }),
        }),
        async execute(_toolCallId: string, params: any): Promise<unknown> {
            const r = await wsh(openFileArgs(params.path));
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_open_file failed: ${r.stderr}` }], details: {} };
            }
            return { content: [{ type: "text", text: r.stdout.trim() }], details: {} };
        },
    });

    pi.registerTool({
        name: "wave_query_sessions",
        label: "Query Wave Sessions",
        description: "List open Wave blocks (terminal and edit views) as JSON so the model can reference them.",
        promptSnippet: "List open Wave tabs/blocks",
        promptGuidelines: ["Use wave_query_sessions to list open Wave tabs before referencing one."],
        parameters: Type.Object({}),
        async execute(): Promise<unknown> {
            const r = await wsh(querySessionsArgs());
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_query_sessions failed: ${r.stderr}` }], details: {} };
            }
            return { content: [{ type: "text", text: r.stdout.slice(-8000) }], details: {} };
        },
    });

    pi.registerTool({
        name: "wave_notify",
        label: "Notify in Wave",
        description: "Send a Wave notification (title required; optional message and level).",
        promptSnippet: "Send a Wave notification",
        promptGuidelines: ["Use wave_notify to send a short notification into Wave."],
        parameters: Type.Object({
            title: Type.String({ description: "Notification title" }),
            message: Type.Optional(Type.String({ description: "Optional message body" })),
            level: Type.Optional(Type.String({ description: "info, warn, or error (default info)" })),
        }),
        async execute(_toolCallId: string, params: any): Promise<unknown> {
            const r = await wsh(notifyArgs(params.title, { message: params.message, level: params.level }));
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_notify failed: ${r.stderr}` }], details: {} };
            }
            return { content: [{ type: "text", text: "Notification sent." }], details: {} };
        },
    });

    // --- B3: notification bridge (event → wsh notify) ----------------------

    const notify = async (title: string, opts: { message?: string; level?: string }): Promise<void> => {
        try {
            await wsh(notifyArgs(title, opts));
        } catch {
            // best-effort: a failed notify never breaks the session
        }
    };

    pi.on("agent_settled", async (event: any, ctx: any) => {
        // The settled-payload error signal is confirmed during Task 8's live round-trip; the
        // predicate below covers the documented error carriers (event.error / ctx.lastError).
        if (event?.error || ctx?.lastError) {
            await notify("Pi session ended with an error", { level: "error" });
        }
    });

    // --- B2: control channel watcher ---------------------------------------

    // makeDispatcher maps a parsed command file onto pi/ctx APIs. ctx is the session ctx from
    // the enclosing session_start; the ctx-dependent commands (compact/abort/new_session/
    // switch_session) use it, per the spec's session-replacement notes.
    const makeDispatcher = (ctx: any, log: (m: string) => void) => {
        return async (cmd: PiControlCommand): Promise<void> => {
            try {
                switch (cmd.cmd) {
                    case "steer":
                        await pi.sendUserMessage(cmd.content, { deliverAs: "steer" });
                        break;
                    case "follow_up":
                        await pi.sendUserMessage(cmd.content, { deliverAs: "followUp" });
                        break;
                    case "set_session_name":
                        if (cmd.name) pi.setSessionName(cmd.name);
                        break;
                    case "compact":
                        ctx.compact({ customInstructions: cmd.content || undefined });
                        break;
                    case "abort":
                        if (typeof ctx.abort === "function") ctx.abort();
                        break;
                    case "new_session":
                        await ctx.newSession({ withSession: async () => {} });
                        break;
                    case "switch_session":
                        if (!cmd.path) {
                            log("pi-control: switch_session requires a session path");
                            break;
                        }
                        await ctx.switchSession(cmd.path, { withSession: async () => {} });
                        break;
                }
            } catch (e) {
                log(`pi-control: command ${cmd.cmd} failed: ${String(e)}`);
                await notify(`Pi control command failed: ${cmd.cmd}`, { level: "error" });
            }
        };
    };

    // startControlWatcher watches dir for <sessionId>.json, executes each parsed command, and
    // deletes the file when processing finishes (idempotent; a wedged command cannot replay).
    // fs.watch with a polling fallback when the platform/dir cannot watch.
    const startControlWatcher = (
        dir: string,
        sessionId: string,
        onCommand: (cmd: PiControlCommand) => Promise<void>,
        log: (m: string) => void,
    ): (() => void) => {
        const file = join(dir, controlFileName(sessionId));
        const process = async (): Promise<void> => {
            if (!existsSync(file)) return;
            let cmd: PiControlCommand | null = null;
            try {
                cmd = parseControlCommand(readFileSync(file, "utf8"));
            } catch {
                log(`pi-control: unreadable control file ${file}`);
            }
            if (!cmd) {
                log(`pi-control: ignoring malformed or unknown command in ${file}`);
                rmSync(file, { force: true });
                return;
            }
            try {
                await onCommand(cmd);
            } finally {
                rmSync(file, { force: true });
            }
        };
        let watcher: ReturnType<typeof watch> | null = null;
        let poll: ReturnType<typeof setInterval> | null = null;
        try {
            watcher = watch(dir, (_eventType, filename) => {
                if (filename === controlFileName(sessionId)) void process();
            });
        } catch {
            poll = setInterval(() => void process(), 1000);
        }
        return () => {
            watcher?.close();
            if (poll) clearInterval(poll);
        };
    };

    let cleanup: (() => void) | undefined;

    pi.on("session_start", (_event: any, ctx: any) => {
        cleanup?.();
        const dir = process.env.WAVETERM_PI_CONTROL_DIR;
        const sessionId = ctx?.sessionManager?.getSessionId?.();
        if (!dir || !sessionId) return; // bare pi outside a Wave block — inert
        cleanup = startControlWatcher(dir, sessionId, makeDispatcher(ctx, (m) => console.log(m)), (m) => console.log(m));
    });

    pi.on("session_shutdown", () => {
        cleanup?.();
        cleanup = undefined;
    });
}

export default function wavetermTools(pi: any): void {
    registerWavetermTools(pi, "__WSH_PATH__");
}
```

- [ ] **Step 2: Typecheck the extension**

Run: `npx tsc --noEmit --strict --moduleResolution node --module esnext --target es2022 pi/extensions/waveterm-tools.ts` (isolated check — the file uses `node:fs`, `node:path`, and `typebox`, none of which are in the repo's tsconfig project; if this isolated check errors on `typebox` resolution, fall back to the repo-wide check below, which excludes pi/ — the extension's correctness is verified by the live round-trip in Task 8).

Then run the repo-wide check (must stay clean — it does not include pi/):

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Checkpoint — stop for review.** Summary: extension glue written (4 tools, notify mapping, watcher); not unit-tested (thin glue — matches the repo's extracted-logic convention); verified live in Task 8.

---

### Task 5: Sync + provisioning (Taskfile, Go embed/install, manifest)

**Files:**
- Modify: `Taskfile.yml`
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go`
- Modify: `pi/package.json`

**Interfaces:**
- Consumes: the two new `pi/extensions/` sources (Tasks 3–4).
- Produces: synced copies `cmd/wsh/cmd/pi-tools-extension.ts` + `cmd/wsh/cmd/pi-tools-core-extension.ts`, embedded templates `piToolsExtensionTemplate` / `piToolsCoreExtensionTemplate`, `installPiToolsExtension(dir, exe)`, manifest entries.

- [ ] **Step 1: Extend the sync task**

In `Taskfile.yml`, extend `sync:piartifacts` (currently copies `pi/extensions/waveterm-status.ts` and `pi/themes/arc.json`):

```yaml
    sync:piartifacts:
        desc: Copy authored pi/ artifacts into their go:embed locations under cmd/wsh/cmd (generated, never hand-edited).
        cmds:
            - cmd: cp pi/extensions/waveterm-status.ts cmd/wsh/cmd/pi-status-extension.ts
            - cmd: cp pi/themes/arc.json cmd/wsh/cmd/arc-theme.json
            - cmd: cp pi/extensions/waveterm-tools.ts cmd/wsh/cmd/pi-tools-extension.ts
            - cmd: cp pi/extensions/waveterm-tools-core.ts cmd/wsh/cmd/pi-tools-core-extension.ts
        sources:
            - pi/extensions/waveterm-status.ts
            - pi/themes/arc.json
            - pi/extensions/waveterm-tools.ts
            - pi/extensions/waveterm-tools-core.ts
        generates:
            - cmd/wsh/cmd/pi-status-extension.ts
            - cmd/wsh/cmd/arc-theme.json
            - cmd/wsh/cmd/pi-tools-extension.ts
            - cmd/wsh/cmd/pi-tools-core-extension.ts
```

Run: `task sync:piartifacts`
Expected: the two new files exist under `cmd/wsh/cmd/`. Verify: `ls cmd/wsh/cmd/ | grep pi-tools`.

- [ ] **Step 2: Embed + install the tools extension in provisioning**

In `cmd/wsh/cmd/wshcmd-installhooks.go`, next to the existing embeds:

```go
//go:embed pi-tools-extension.ts
var piToolsExtensionTemplate string

//go:embed pi-tools-core-extension.ts
var piToolsCoreExtensionTemplate string
```

Add `installPiToolsExtension` next to `installPiStatusExtension` (same shape — it writes both files into `~/.pi/agent/extensions/` with the `"__WSH_PATH__"` substitution; the core file contains no placeholder, so it is copied verbatim):

```go
// installPiToolsExtension writes the Wave tools + steering extension pair into pi's global
// extension directory, where pi auto-loads every file. Same contract as
// installPiStatusExtension: __WSH_PATH__ is replaced with the absolute wsh exe path.
func installPiToolsExtension(home string, exe string) error {
	dir := filepath.Join(home, ".pi", "agent", "extensions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating pi extensions dir: %w", err)
	}
	tools := strings.ReplaceAll(piToolsExtensionTemplate, `"__WSH_PATH__"`, jsonString(exe))
	if err := os.WriteFile(filepath.Join(dir, "waveterm-tools.ts"), []byte(tools), 0o644); err != nil {
		return fmt.Errorf("writing waveterm-tools.ts: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "waveterm-tools-core.ts"), []byte(piToolsCoreExtensionTemplate), 0o644); err != nil {
		return fmt.Errorf("writing waveterm-tools-core.ts: %w", err)
	}
	return nil
}
```

Wire it into the install flow: find the function that currently calls `installPiStatusExtension` (the pi install entrypoint) and add `installPiToolsExtension` as a sibling call after it. Do not change the status/memory extension installs.

- [ ] **Step 3: Update the package manifest**

In `pi/package.json`, extend the `pi.extensions` array:

```json
    "pi": {
        "extensions": [
            "./extensions/waveterm-status.ts",
            "./extensions/waveterm-tools.ts",
            "./extensions/waveterm-tools-core.ts"
        ],
```

- [ ] **Step 4: Verify**

Run (no CGO needed for this package):

```bash
go build ./cmd/wsh/...
gofmt -l cmd/wsh/cmd
```

Expected: build succeeds; `gofmt -l` zero.

Run: `go test ./cmd/wsh/cmd/`
Expected: PASS (existing provisioning/merge tests still green — the new embed vars and install function are additive).

- [ ] **Step 5: Checkpoint — stop for review.** Summary: sync + provisioning wired; manifest updated; tests green.

---

### Task 6: Frontend toast surface (TypeScript/TSX, Vitest)

**Files:**
- Create: `frontend/app/cockpit/notificationstore.ts`
- Create: `frontend/app/cockpit/notificationstore.test.ts`
- Create: `frontend/app/cockpit/notificationtoasts.tsx`
- Modify: `frontend/app/cockpit/cockpit-root.tsx`

**Interfaces:**
- Consumes: generated `NotifyCommandData` + `notify` wave-event type (Task 1), `waveEventSubscribeSingle` (`frontend/app/store/wps.ts`), `globalStore` (`@/app/store/jotaiStore`).
- Produces: `toastsAtom`, `pushToast`, `dismissToast`, `setupNotificationSubscription`, `<NotificationToasts/>`.

- [ ] **Step 1: Write the failing store test**

`frontend/app/cockpit/notificationstore.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";
import { dismissToast, pushToast, toastsAtom } from "./notificationstore";

describe("notificationstore", () => {
    beforeEach(() => {
        globalStore.set(toastsAtom, []);
        vi.useFakeTimers();
    });

    it("pushes a toast into the atom", () => {
        pushToast({ title: "hi", message: "there", level: "info" });
        const toasts = globalStore.get(toastsAtom);
        expect(toasts).toHaveLength(1);
        expect(toasts[0].title).toBe("hi");
    });

    it("caps the stack at five and auto-dismisses", () => {
        for (let i = 0; i < 6; i++) pushToast({ title: `t${i}`, message: "", level: "info" });
        expect(globalStore.get(toastsAtom)).toHaveLength(5);
        vi.advanceTimersByTime(7000);
        expect(globalStore.get(toastsAtom)).toHaveLength(0);
    });

    it("dismisses a specific toast", () => {
        pushToast({ title: "a", message: "", level: "info" });
        pushToast({ title: "b", message: "", level: "info" });
        const first = globalStore.get(toastsAtom)[0];
        dismissToast(first.id);
        expect(globalStore.get(toastsAtom).map((t) => t.title)).toEqual(["b"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/cockpit/notificationstore.test.ts`
Expected: FAIL — cannot resolve `./notificationstore`.

- [ ] **Step 3: Write the store**

`frontend/app/cockpit/notificationstore.ts`:

```typescript
// Minimal toast store for the cockpit. Notifications arrive on the "notify" wave event
// (wsh notify / wave_notify) and live only in this atom — no router, no persistence.

import { atom } from "jotai";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";

export interface ToastNotification {
    id: number;
    title: string;
    message: string;
    level: "info" | "warn" | "error";
}

export const toastsAtom = atom<ToastNotification[]>([]);

let nextId = 1;
export const TOAST_TTL_MS = 6000;
const MAX_TOASTS = 5;

export function pushToast(n: Omit<ToastNotification, "id">): void {
    const toast = { ...n, id: nextId++ };
    globalStore.set(toastsAtom, (prev) => [...prev.slice(-(MAX_TOASTS - 1)), toast]);
    setTimeout(() => dismissToast(toast.id), TOAST_TTL_MS);
}

export function dismissToast(id: number): void {
    globalStore.set(toastsAtom, (prev) => prev.filter((t) => t.id !== id));
}

let subscribed = false;
export function setupNotificationSubscription(): void {
    if (subscribed) return;
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "notify",
        handler: (event) => {
            const data = event.data as NotifyCommandData;
            if (!data?.title) return;
            pushToast({ title: data.title, message: data.message ?? "", level: data.level ?? "info" });
        },
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/cockpit/notificationstore.test.ts`
Expected: PASS (3 tests). (If the `notify` event type is not yet in the generated `WaveEventName` union, regenerate with `task generate` — Task 1 did; if it still errors, the tsgen entry from Task 1 Step 6 is the culprit — re-check it.)

- [ ] **Step 5: Write the toast component**

`frontend/app/cockpit/notificationtoasts.tsx`:

```tsx
// Toast stack for transient cockpit notifications. Thin render over toastsAtom; colors come
// from @theme tokens only.
import { useAtomValue } from "jotai";
import { dismissToast, toastsAtom } from "./notificationstore";

export function NotificationToasts(): React.JSX.Element {
    const toasts = useAtomValue(toastsAtom);
    if (toasts.length === 0) return <></>;
    return (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
            {toasts.map((t) => (
                <button
                    key={t.id}
                    type="button"
                    data-notification-toast
                    onClick={() => dismissToast(t.id)}
                    className={`pointer-events-auto rounded-lg border p-3 text-left shadow-lg ${
                        t.level === "error"
                            ? "border-danger/40 bg-bg-secondary text-primary"
                            : t.level === "warn"
                              ? "border-warning/40 bg-bg-secondary text-primary"
                              : "border-border bg-bg-secondary text-primary"
                    }`}
                >
                    <div className="text-sm font-medium">{t.title}</div>
                    {t.message ? <div className="text-xs text-secondary">{t.message}</div> : null}
                </button>
            ))}
        </div>
    );
}
```

(Token names (`border-danger`, `bg-bg-secondary`, `text-primary`, `border-border`, `text-secondary`, `border-warning`) follow the existing `@theme` tokens in `frontend/tailwindsetup.css`. If a token does not exist, use the closest existing token — do not add new colors.)

- [ ] **Step 6: Mount the toasts in the cockpit root**

In `frontend/app/cockpit/cockpit-root.tsx`, import and mount once, and start the subscription next to the other `setup*Subscription()` calls (mirror how `agentaskstore.ts` subscriptions are started — find the existing subscription setup call sites in cockpit-root.tsx and add a sibling):

```tsx
import { NotificationToasts } from "./notificationtoasts";
import { setupNotificationSubscription } from "./notificationstore";
// ...inside the component/effect that starts other subscriptions:
setupNotificationSubscription();
// ...inside the returned JSX, alongside the other fixed overlays:
<NotificationToasts />
```

- [ ] **Step 7: Typecheck + run the frontend suite**

Run:

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run frontend/app/cockpit/notificationstore.test.ts
```

Expected: exit 0; PASS.

- [ ] **Step 8: Checkpoint — stop for review.** Summary: toast store + component + subscription wired.

---

### Task 7: Frontend steer UI (TypeScript/TSX, Vitest)

**Files:**
- Create: `frontend/app/view/agents/pi-control.ts`
- Create: `frontend/app/view/agents/pi-control.test.ts`
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx`

**Interfaces:**
- Consumes: generated `PiSendControlCommand` client call + `PiControlCommandData` (Task 1); `TabRpcClient` + `RpcApi` (`@/app/store/wshclientapi`, `@/app/store/wshrpcutil`).
- Produces: `steerData(sessionId, content)` pure helper; steer input in the rail.

- [ ] **Step 1: Write the failing helper test**

`frontend/app/view/agents/pi-control.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { steerData } from "./pi-control";

describe("pi-control", () => {
    it("builds a steer command for a pi session", () => {
        expect(steerData("sess-1", "look at this")).toEqual({
            sessionid: "sess-1",
            command: "steer",
            content: "look at this",
        });
    });

    it("trims empty content to an empty string", () => {
        expect(steerData("sess-1", "   ").content).toBe("");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/pi-control.test.ts`
Expected: FAIL — cannot resolve `./pi-control`.

- [ ] **Step 3: Write the helper**

`frontend/app/view/agents/pi-control.ts`:

```typescript
// Pure builder for the pi control-channel call. The session id is the one the status
// extension reports via agentstatus --session-id and the cockpit stores on the agent record.
import type { PiControlCommandData } from "@/app/store/wshclientapi";

export function steerData(sessionId: string, content: string): PiControlCommandData {
    return { sessionid: sessionId, command: "steer", content: content.trim() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/pi-control.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the steer input to the agent detail rail**

In `frontend/app/view/agents/agentdetailsrail.tsx`, add a steer input block rendered only for pi sessions. First find the session-id field on the agent record: the status extension reports `--session-id` (`cmd/wsh/cmd/wshcmd-agenthook.go`, payload `baseds.AgentStatusData.SessionID`), and the cockpit stores it on the `AgentVM` (`frontend/app/view/agents/agentsessionstart.ts` / the agent record built from the agents table). Use that field; if `AgentVM` does not expose it, thread it through from the record that carries `AgentStatusData.SessionID`.

Then, in the rail's JSX (a `localStorage`-free, controlled input using a component-local `useState` — the rail stays mounted while its agent is open):

```tsx
function SteerInput({ sessionId }: { sessionId: string }): React.JSX.Element {
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const submit = async () => {
        const content = draft.trim();
        if (!content || sending) return;
        setSending(true);
        try {
            await RpcApi.PiSendControlCommand(TabRpcClient, steerData(sessionId, content));
            setDraft("");
        } finally {
            setSending(false);
        }
    };
    return (
        <div className="flex items-center gap-2">
            <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                }}
                placeholder="Steer this Pi session…"
                className="min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-primary outline-none focus:border-accent"
            />
            <button
                type="button"
                onClick={() => void submit()}
                disabled={sending || !draft.trim()}
                className="rounded-md bg-accent px-2 py-1 text-xs text-on-accent disabled:opacity-50"
            >
                Steer
            </button>
        </div>
    );
}
```

Render it inside the rail when the agent is a pi session with a known session id (e.g. in the same section that shows the runtime row, gated on `agent.agent === "pi" && sessionId !== ""`).

- [ ] **Step 6: Typecheck + verify**

Run:

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run frontend/app/view/agents/pi-control.test.ts
```

Expected: exit 0; PASS. (`RpcApi.PiSendControlCommand` must exist — it was generated in Task 1 Step 9.)

- [ ] **Step 7: Checkpoint — stop for review.** Summary: steer helper + rail input for pi sessions.

---

### Task 8: CDP scenario + live round-trip verification

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: everything above; the running dev app (CDP :9222).

- [ ] **Step 1: Extend the surface-smoke scenario**

In `scripts/cdp/scenarios.mjs`, extend the existing `surfaceSmoke` scenario (or add a new `piControl` scenario) with two steps:

1. **Toast appears on notify:** after the surface loads, dispatch a notification through the backend (e.g. via the wsh CLI from the dev shell: `wsh notify "cdp test" --level info`) and assert `[data-notification-toast]` (add a `data-notification-toast` attribute to the toast container in `notificationtoasts.tsx` for stable selection) is present within a few seconds, then auto-dismisses.
2. **Steer input visible on a pi session card:** when a pi session is present in the roster, assert the steer input placeholder `Steer this Pi session…` is present.

If no live pi session exists during the run, make step 2 conditional (log SKIP) so the scenario does not fail spuriously — the steer input is verified in the manual round-trip below.

- [ ] **Step 2: Manual live round-trip (documented procedure, requires a dev session)**

With `task dev` running and a pi session launched from a Wave tab (after Task 5, re-run `task build:backend` and restart dev so the new `wsh` and `wavesrv` are live):

1. `wsh notify "hello from wsh"` → assert a toast appears in the cockpit and auto-dismisses.
2. From a pi session, ask the model to use `wave_run_command` (`echo hello-from-pi`) → assert a new block opens and runs it; assert the tool's text result returns.
3. `wave_open_file <some existing file>` → assert an editor/preview block opens.
4. `wave_query_sessions` → assert JSON block list returns.
5. Control channel: write a steer file manually first — `wsh` has no steer CLI (by design; the writer is the frontend), so from a pi session's dev shell: `mkdir -p "<dataHome>/pi-control"` and `echo '{"cmd":"steer","content":"hello from arc"}' > "<dataHome>/pi-control/<sessionId>.json"` (sessionId = the id shown in the cockpit's pi session card / `agentstatus --session-id`), then assert the pi session receives the message and the file is deleted.
6. `agent_settled` error mapping: end a pi session with an error (e.g. a failing command) and assert an error-level toast appears (this also confirms the settled-payload predicate — adjust the `event?.error || ctx?.lastError` guard in `waveterm-tools.ts` to the actual payload field observed, then re-sync with `task sync:piartifacts`).

- [ ] **Step 3: Verify:ui**

Run: `task verify:ui -- surface-smoke`
Expected: scenario passes (or the conditional pi step reports SKIP).

- [ ] **Step 4: Checkpoint — stop for review.** Summary: CDP scenario extended; live round-trip results recorded, including the settled-error predicate correction if any.

---

## Batched commit decision (human gate)

All work above is left **uncommitted**. The batched commit (after human approval) includes:

- the 6 implementation tasks' files,
- the two documented spec amendments (session-validation sentence, `wave_open_file` line parameter),
- this plan document (folds into the feature commit per repo convention).
