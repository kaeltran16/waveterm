# One-shot Consult (cross-CLI reply) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ask @runtime …` consult gesture to the Channels surface that runs a headless CLI agent (`claude -p`, `codex exec`, `agy -p`) server-side, streams its reply live into the channel, and persists it as a `consult-reply` message — a primitive the future orchestrator's Delegator reuses verbatim.

**Architecture:** A new `pkg/consult` package holds the pure per-runtime argv map + the capped-context prompt builder + a streaming `exec.CommandContext` runner. A streaming wshrpc command `ConsultCommand` wraps it (reads the channel for cwd + context, streams `ConsultChunk`s, posts a persisted `consult-reply` on completion); a `ListConsultRuntimesCommand` probes which CLIs are installed. The frontend adds an `ask`-prefixed branch to the pure `planMessage` router and renders consult question/reply rows, with live streaming rows superseded by the persisted reply via a shared `consultId`.

**Tech Stack:** Go (`os/exec`, `pkg/consult`, wstore/waveobj, streaming wshrpc), `task generate` codegen, React 19 + jotai + Tailwind v4 (@theme tokens), vitest.

**Spec:** `docs/superpowers/specs/2026-06-30-consult-cross-cli-design.md`
**Roadmap (why server-side / verb-as-command):** `docs/orchestrator-roadmap.md`

---

## Preconditions (read before starting)

**This plan builds on Channels v1, which is implemented separately (`docs/superpowers/plans/2026-06-30-channels-tab.md`). Do not start until that work has merged.** Tasks 4–6 edit Channels files and reuse Channels types. Before Task 1, confirm these exist in the merged tree and reconcile any renamed identifiers (names below are from the Channels plan; if the implementer changed them, use the actual ones):

- `pkg/waveobj/wtype.go`: `Channel{OID, ProjectPath, Messages []ChannelMessage, …}` and `ChannelMessage{ID, Kind, Author, Text, RefORef, Ts}`, `OType_Channel = "channel"`.
- `pkg/wstore/wstore_channel.go`: `NewChannelMessage(kind, author, text, refORef string, ts int64) waveobj.ChannelMessage` and `PostChannelMessage(ctx, channelId string, msg waveobj.ChannelMessage) (*waveobj.ChannelMessage, error)`.
- FE `frontend/app/view/agents/channelmessages.ts`: pure `parseMentions(text)` and `planMessage(text, roster)` returning a `MessagePlan` union.
- FE `frontend/app/view/agents/channelactions.ts`: `sendChannelMessage({ model, channelId, projectPath, projectName, roster, text })`.
- FE `frontend/app/view/agents/channelsstore.ts`: `activeChannelAtom`, `activeChannelIdAtom`, `channelsAtom`.
- FE `frontend/app/view/agents/channelssurface.tsx`: the `Row` renderer + the roster mapping `agents.map(a => ({ id, name, blockId }))`.
- The agents roster `model.agentsAtom` of `AgentVM` rows (each with `.id`, `.name`, `.state`).

**No `ChannelMessage` struct change in this plan.** The consult adds two new `Kind` values (`consult`, `consult-reply`) and a `RefORef` convention (`consult:<consultId>`); it touches no Channels schema.

---

## Conventions & gotchas (read once)

- **Never hand-edit generated files.** `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go` come from `task generate`. Edit the Go source, regenerate.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). Baseline has 3 pre-existing `frontend/tauri/api.test.ts` errors — those are expected; anything else is yours.
- **No SCSS, no hardcoded colors.** Use the @theme utility classes (`bg-surface`, `border-border`, `text-primary`, `text-secondary`, `text-muted`, `text-ink-mid`, `border-accent`, `bg-accentbg`, `text-accent-soft`, `border-edge-faint`, `bg-surface-hover`, `text-asking`).
- **Streaming wshrpc commands** return `chan wshrpc.RespOrErrorUnion[T]` in the Go interface and codegen to `AsyncGenerator<T, void, boolean>` on the FE (consumed with `for await`). Reference: `StreamTestCommand` (`wshserver.go:106`) and the FE consumer in `livetranscript.ts:48`.
- **`RespOrErrorUnion[T]` is `{ Response T; Error error }`** — the error arm carries an `error`, not a string.
- **Adding a wshrpc command requires only:** the interface line + `Command*Data`/`*RtnData` structs in `pkg/wshrpc/wshrpctypes.go`, and the server method in `pkg/wshrpc/wshserver/wshserver.go`. Dispatch is reflection-driven; clients regenerate.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `pkg/consult/consult.go` | per-runtime argv map (`SpecFor`, `SupportedRuntimes`) + pure `BuildPrompt` (capped context) | Create |
| `pkg/consult/exec.go` | streaming `Run` (exec + capture) + `ProbeInstalled` | Create |
| `pkg/consult/consult_test.go` | unit tests for the pure helpers + the runner (against `git`) | Create |
| `pkg/wshrpc/wshrpctypes.go` | 2 interface lines + `CommandConsultData`, `ConsultChunk`, `CommandListConsultRuntimesRtnData`, `ConsultRuntimeInfo` | Modify |
| `pkg/wshrpc/wshserver/wshserver.go` | `ConsultCommand` (streaming) + `ListConsultRuntimesCommand` + `postConsultReply` helper | Modify |
| `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go` | generated bindings | Regenerated (`task generate`) |
| `frontend/app/view/agents/channelmessages.ts` | `planMessage` gains an `ask`→consult branch | Modify |
| `frontend/app/view/agents/channelmessages.test.ts` | vitest for the consult branch | Modify |
| `frontend/app/view/agents/channelsstore.ts` | `consultStreamsAtom` + `setConsultStream` | Modify |
| `frontend/app/view/agents/channelactions.ts` | consult branch in `sendChannelMessage` (post question, fan-out, consume streams) | Modify |
| `frontend/app/view/agents/channelssurface.tsx` | consult question + reply row rendering, ephemeral→persisted supersession, autocomplete gating | Modify |

---

## Task 1: `pkg/consult` pure helpers — runtime map + prompt builder

The DB-free, process-free core: which binary/args each runtime uses, and how channel history is folded into the prompt. Unit-tested in isolation.

**Files:**
- Create: `pkg/consult/consult.go`
- Test: `pkg/consult/consult_test.go`

- [ ] **Step 1: Smoke-test the three CLIs' prompt delivery (informs the map)**

Before encoding the map, confirm whether each CLI reads its prompt from **stdin** (preferred — avoids shell-quoting/leak issues). Run each:
```bash
printf '%s' "say the word PONG and nothing else" | claude -p
printf '%s' "say the word PONG and nothing else" | codex exec
printf '%s' "say the word PONG and nothing else" | agy -p
```
For any CLI that does NOT answer from stdin (errors, or hangs waiting for a positional prompt), set its `PromptViaStdin: false` in Step 2 (the runner appends the prompt as a positional arg instead). Record the outcome in a comment. Default assumption (all `true`) stands unless a smoke test disproves it.

- [ ] **Step 2: Write the failing test for the pure helpers**

Create `pkg/consult/consult_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package consult

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestSpecFor_knownRuntimes(t *testing.T) {
	cases := map[string]struct {
		bin  string
		arg0 string
	}{
		"claude":      {"claude", "-p"},
		"codex":       {"codex", "exec"},
		"antigravity": {"agy", "-p"},
	}
	for rt, want := range cases {
		spec, ok := SpecFor(rt)
		if !ok {
			t.Fatalf("%s: expected ok", rt)
		}
		if spec.Bin != want.bin || len(spec.BaseArgs) == 0 || spec.BaseArgs[0] != want.arg0 {
			t.Errorf("%s: got bin=%q args=%v", rt, spec.Bin, spec.BaseArgs)
		}
	}
}

func TestSpecFor_unsupported(t *testing.T) {
	if _, ok := SpecFor("terminal"); ok {
		t.Error("terminal should be unsupported")
	}
	if _, ok := SpecFor("gemini"); ok {
		t.Error("gemini should be unsupported in v1")
	}
}

func TestBuildPrompt_emptyHistoryReturnsPromptVerbatim(t *testing.T) {
	got := BuildPrompt(nil, "what is 2+2?")
	if got != "what is 2+2?" {
		t.Errorf("expected verbatim prompt, got %q", got)
	}
}

func TestBuildPrompt_includesRecentHistoryAndRequest(t *testing.T) {
	hist := []waveobj.ChannelMessage{
		{Author: "you", Text: "we are refactoring auth"},
		{Author: "codex", Text: "done, +40 -10"},
	}
	got := BuildPrompt(hist, "does it have races?")
	if !strings.Contains(got, "you: we are refactoring auth") {
		t.Errorf("missing history line: %q", got)
	}
	if !strings.Contains(got, "does it have races?") {
		t.Errorf("missing request: %q", got)
	}
}

func TestBuildPrompt_capsMessageCount(t *testing.T) {
	var hist []waveobj.ChannelMessage
	for i := 0; i < 50; i++ {
		hist = append(hist, waveobj.ChannelMessage{Author: "you", Text: "OLDLINE"})
	}
	hist = append(hist, waveobj.ChannelMessage{Author: "you", Text: "NEWEST"})
	got := BuildPrompt(hist, "q")
	// only the last maxContextMessages are kept; with 51 total, the count of OLDLINE is bounded
	if strings.Count(got, "OLDLINE") > maxContextMessages {
		t.Errorf("kept too many history lines: %d", strings.Count(got, "OLDLINE"))
	}
	if !strings.Contains(got, "NEWEST") {
		t.Errorf("dropped the newest message: %q", got)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails to compile**

Run: `go test ./pkg/consult/ -run TestSpecFor`
Expected: FAIL — `undefined: SpecFor`, `undefined: BuildPrompt`, etc.

- [ ] **Step 4: Implement `consult.go`**

Create `pkg/consult/consult.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Package consult runs a one-shot, headless CLI agent (claude -p / codex exec / agy -p) and returns
// its reply. It is the backend primitive behind the Channels "ask @runtime" gesture and the future
// orchestrator's review tool. This file holds the pure (process-free) parts: the per-runtime argv map
// and the capped-context prompt builder.

package consult

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	maxContextMessages = 20
	maxContextChars    = 4000
)

// RuntimeSpec is how to invoke a runtime in one-shot/print mode. PromptViaStdin true => pipe the
// prompt over stdin (preferred); false => append it as the final positional arg.
type RuntimeSpec struct {
	Bin            string
	BaseArgs       []string
	PromptViaStdin bool
}

// runtimeSpecs is keyed by the FE Runtime identifier. Note antigravity's binary is "agy", not
// "antigravity" (verified 2026-06-30; the latter does not resolve on PATH). Adjust PromptViaStdin
// per the Task 1 smoke test.
var runtimeSpecs = map[string]RuntimeSpec{
	"claude":      {Bin: "claude", BaseArgs: []string{"-p"}, PromptViaStdin: true},
	"codex":       {Bin: "codex", BaseArgs: []string{"exec"}, PromptViaStdin: true},
	"antigravity": {Bin: "agy", BaseArgs: []string{"-p"}, PromptViaStdin: true},
}

func SpecFor(runtime string) (RuntimeSpec, bool) {
	s, ok := runtimeSpecs[runtime]
	return s, ok
}

func SupportedRuntimes() []string {
	return []string{"claude", "codex", "antigravity"}
}

// BuildPrompt folds a capped tail of channel history into the user's prompt as context. Returns the
// prompt verbatim when there is no usable history.
func BuildPrompt(history []waveobj.ChannelMessage, userPrompt string) string {
	start := 0
	if len(history) > maxContextMessages {
		start = len(history) - maxContextMessages
	}
	var b strings.Builder
	for _, m := range history[start:] {
		b.WriteString(m.Author)
		b.WriteString(": ")
		b.WriteString(m.Text)
		b.WriteByte('\n')
	}
	ctxStr := b.String()
	if len(ctxStr) > maxContextChars {
		ctxStr = ctxStr[len(ctxStr)-maxContextChars:]
		if i := strings.IndexByte(ctxStr, '\n'); i >= 0 {
			ctxStr = ctxStr[i+1:] // drop the partial leading line after slicing
		}
	}
	if strings.TrimSpace(ctxStr) == "" {
		return userPrompt
	}
	return "Recent channel conversation for context:\n" + ctxStr + "\nRequest:\n" + userPrompt
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test ./pkg/consult/ -run "TestSpecFor|TestBuildPrompt"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/consult/consult.go pkg/consult/consult_test.go
git commit -m "feat(consult): per-runtime argv map + capped-context prompt builder"
```

---

## Task 2: `pkg/consult` streaming runner + installed probe

The impure half: run the CLI, stream stdout, capture the full reply and stderr; probe whether a runtime is installed. Tested against `git` (always present in this dev env — see `pkg/gitinfo` precedent) so the test needs no AI CLI.

**Files:**
- Create: `pkg/consult/exec.go`
- Test: `pkg/consult/consult_test.go` (append)

- [ ] **Step 1: Write the failing test (append to `consult_test.go`)**

Add these imports to the existing `import` block: `"context"`, `"time"`. Then append:
```go
func TestRun_streamsAndCapturesOutput(t *testing.T) {
	var chunks []string
	spec := RuntimeSpec{Bin: "git", BaseArgs: []string{"version"}, PromptViaStdin: false}
	full, err := Run(context.Background(), spec, "", "", func(c string) { chunks = append(chunks, c) })
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if !strings.Contains(full, "git version") {
		t.Errorf("expected git version in output, got %q", full)
	}
	if len(chunks) == 0 {
		t.Error("expected at least one streamed chunk")
	}
}

func TestRun_missingBinaryErrors(t *testing.T) {
	spec := RuntimeSpec{Bin: "definitely-not-a-real-binary-xyz", BaseArgs: nil}
	_, err := Run(context.Background(), spec, "", "", func(string) {})
	if err == nil {
		t.Error("expected an error for a missing binary")
	}
}

func TestProbe_presentAndAbsent(t *testing.T) {
	ok, ver := probe(context.Background(), "git")
	if !ok {
		t.Fatal("expected git to be installed in the dev env")
	}
	if !strings.Contains(strings.ToLower(ver), "git") {
		t.Errorf("expected version string to mention git, got %q", ver)
	}
	if absent, _ := probe(context.Background(), "definitely-not-a-real-binary-xyz"); absent {
		t.Error("expected a missing binary to probe as absent")
	}
}

var _ = time.Second // keep the time import if unused elsewhere
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run: `go test ./pkg/consult/ -run "TestRun|TestProbe"`
Expected: FAIL — `undefined: Run`, `undefined: probe`.

- [ ] **Step 3: Implement `exec.go`**

Create `pkg/consult/exec.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The process-running half of pkg/consult: stream a headless CLI's stdout to a callback while
// capturing the full reply, and probe whether a runtime's binary is installed.

package consult

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Run executes the runtime in one-shot mode with the given prompt and cwd, calling emit for each
// stdout chunk as it arrives, and returns the complete captured stdout. On a non-zero exit it
// returns the captured stdout so far plus an error built from stderr.
func Run(ctx context.Context, spec RuntimeSpec, cwd, prompt string, emit func(string)) (string, error) {
	args := append([]string{}, spec.BaseArgs...)
	if !spec.PromptViaStdin {
		args = append(args, prompt)
	}
	cmd := exec.CommandContext(ctx, spec.Bin, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	if spec.PromptViaStdin {
		cmd.Stdin = strings.NewReader(prompt)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("starting %s: %w", spec.Bin, err)
	}
	var full strings.Builder
	buf := make([]byte, 4096)
	for {
		n, rerr := stdout.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])
			full.WriteString(chunk)
			emit(chunk)
		}
		if rerr != nil {
			break
		}
	}
	if werr := cmd.Wait(); werr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = werr.Error()
		}
		return full.String(), fmt.Errorf("%s", msg)
	}
	return full.String(), nil
}

// probe reports whether bin resolves on PATH and its best-effort --version output.
func probe(ctx context.Context, bin string) (bool, string) {
	if _, err := exec.LookPath(bin); err != nil {
		return false, ""
	}
	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(vctx, bin, "--version").CombinedOutput()
	return true, strings.TrimSpace(string(out))
}

// ProbeInstalled reports install state + version for a known runtime identifier.
func ProbeInstalled(ctx context.Context, runtime string) (bool, string) {
	spec, ok := runtimeSpecs[runtime]
	if !ok {
		return false, ""
	}
	return probe(ctx, spec.Bin)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/consult/`
Expected: PASS (all of Task 1 + Task 2). If `git` is somehow not on PATH in the runner, that is an environment problem, not a code problem — confirm `git --version` works in the shell.

- [ ] **Step 5: Remove the throwaway `time` guard line**

Delete `var _ = time.Second // …` from `consult_test.go` (Step 1 of this task added it only to keep the import while `probe`'s timeout was unwritten; it is now genuinely used by `exec.go`, not the test — if `time` is unused in the test file, drop the import instead).

Run: `go test ./pkg/consult/`
Expected: PASS, no unused-import error.

- [ ] **Step 6: Commit**

```bash
git add pkg/consult/exec.go pkg/consult/consult_test.go
git commit -m "feat(consult): streaming exec runner + installed probe"
```

---

## Task 3: wshrpc `ConsultCommand` (streaming) + `ListConsultRuntimesCommand`

Expose the package over wshrpc. `ConsultCommand` reads the channel for cwd + context, streams chunks, and posts a persisted `consult-reply` on completion. These are the verb-as-command surface the future manager calls.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerated: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`

- [ ] **Step 1: Add the interface lines**

In `pkg/wshrpc/wshrpctypes.go`, in `WshRpcInterface` (near the Channels commands added by Channels v1, e.g. `PostChannelMessageCommand`), add:
```go
	ConsultCommand(ctx context.Context, data CommandConsultData) chan RespOrErrorUnion[ConsultChunk]
	ListConsultRuntimesCommand(ctx context.Context) (*CommandListConsultRuntimesRtnData, error)
```

- [ ] **Step 2: Add the command data structs**

In `pkg/wshrpc/wshrpctypes.go`, near the Channels command structs, add:
```go
type CommandConsultData struct {
	ChannelId string `json:"channelid"`
	Runtime   string `json:"runtime"`
	Prompt    string `json:"prompt"`
	ConsultId string `json:"consultid"`
}

type ConsultChunk struct {
	Text string `json:"text"`
}

type ConsultRuntimeInfo struct {
	Runtime   string `json:"runtime"`
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
}

type CommandListConsultRuntimesRtnData struct {
	Runtimes []ConsultRuntimeInfo `json:"runtimes"`
}
```

- [ ] **Step 3: Implement the commands**

In `pkg/wshrpc/wshserver/wshserver.go`, confirm the import block has `"context"`, `"fmt"`, `"strings"`, `"github.com/wavetermdev/waveterm/pkg/panichandler"`, `"github.com/wavetermdev/waveterm/pkg/wstore"`, `"github.com/wavetermdev/waveterm/pkg/wcore"`, `"github.com/wavetermdev/waveterm/pkg/waveobj"` (add any missing), plus the new `"github.com/wavetermdev/waveterm/pkg/consult"`. Then add near the Channels command implementations:
```go
const consultTimeout = 120 * time.Second

// postConsultReply persists a consult-reply message and live-updates the pinned channel atom.
func postConsultReply(ctx context.Context, data wshrpc.CommandConsultData, text string) {
	msg := wstore.NewChannelMessage("consult-reply", data.Runtime, text, "consult:"+data.ConsultId, time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg); err != nil {
		log.Printf("consult: failed to post reply: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
}

func (ws *WshServer) ConsultCommand(ctx context.Context, data wshrpc.CommandConsultData) chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("ConsultCommand", recover())
		}()
		defer close(rtn)
		ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Error: fmt.Errorf("channel not found: %w", err)}
			return
		}
		spec, ok := consult.SpecFor(data.Runtime)
		if !ok {
			postConsultReply(ctx, data, "consult is not supported for @"+data.Runtime)
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Error: fmt.Errorf("unsupported runtime: %s", data.Runtime)}
			return
		}
		prompt := consult.BuildPrompt(ch.Messages, data.Prompt)
		runCtx, cancel := context.WithTimeout(ctx, consultTimeout)
		defer cancel()
		full, runErr := consult.Run(runCtx, spec, ch.ProjectPath, prompt, func(chunk string) {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Response: wshrpc.ConsultChunk{Text: chunk}}
		})
		reply := strings.TrimSpace(full)
		if runErr != nil {
			if reply != "" {
				reply += "\n\n"
			}
			reply += "consult failed: " + runErr.Error()
		}
		postConsultReply(ctx, data, reply)
	}()
	return rtn
}

func (ws *WshServer) ListConsultRuntimesCommand(ctx context.Context) (*wshrpc.CommandListConsultRuntimesRtnData, error) {
	var infos []wshrpc.ConsultRuntimeInfo
	for _, rt := range consult.SupportedRuntimes() {
		installed, version := consult.ProbeInstalled(ctx, rt)
		infos = append(infos, wshrpc.ConsultRuntimeInfo{Runtime: rt, Installed: installed, Version: version})
	}
	return &wshrpc.CommandListConsultRuntimesRtnData{Runtimes: infos}, nil
}
```
(If `"log"` and `"time"` are not yet imported in `wshserver.go`, add them.)

- [ ] **Step 4: Build the backend**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 5: Regenerate bindings**

Run: `task generate`
Expected: success.

- [ ] **Step 6: Verify the generated types exist**

Run: `grep -n "ConsultCommand" frontend/app/store/wshclientapi.ts && grep -n "type ConsultChunk = " frontend/types/gotypes.d.ts && grep -n "ListConsultRuntimesCommand" frontend/app/store/wshclientapi.ts`
Expected: `ConsultCommand` generated as an `AsyncGenerator<ConsultChunk, …>`, the `ConsultChunk` TS type, and the `ListConsultRuntimesCommand` client method.

- [ ] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
git commit -m "feat(consult): streaming ConsultCommand + ListConsultRuntimesCommand"
```

---

## Task 4: `planMessage` consult branch (pure)

Route a leading reserved `ask` keyword to a consult plan carrying the mentioned runtimes. Dispatch/steer/post stay unchanged.

**Files:**
- Modify: `frontend/app/view/agents/channelmessages.ts`
- Modify: `frontend/app/view/agents/channelmessages.test.ts`

- [ ] **Step 1: Write the failing test (append to `channelmessages.test.ts`)**

Add to the existing `describe("planMessage", …)` block (the `roster` const already exists from Channels v1):
```ts
    it("plans a consult when prefixed with ask + a runtime", () => {
        expect(planMessage("ask @claude does this have races?", roster)).toEqual({
            kind: "consult",
            runtimes: ["claude"],
            text: "does this have races?",
        });
    });
    it("fans a consult out across multiple runtimes", () => {
        expect(planMessage("ask @codex @claude review this", roster)).toEqual({
            kind: "consult",
            runtimes: ["codex", "claude"],
            text: "review this",
        });
    });
    it("treats ask with no known runtime as a plain post (kept verbatim)", () => {
        expect(planMessage("ask @nobody anything", roster)).toEqual({ kind: "post", text: "ask @nobody anything" });
    });
    it("does not consult without the ask keyword (leading @runtime still dispatches)", () => {
        expect(planMessage("@claude build it", roster)).toEqual({ kind: "dispatch", runtime: "claude", text: "build it" });
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts`
Expected: FAIL — consult cases return `post`/throw (no consult branch yet).

- [ ] **Step 3: Add the consult branch + type**

In `frontend/app/view/agents/channelmessages.ts`:

Add `consult` to the `MessagePlan` union:
```ts
export type MessagePlan =
    | { kind: "dispatch"; runtime: Runtime; text: string }
    | { kind: "steer"; targetId: string; blockId?: string; text: string }
    | { kind: "consult"; runtimes: Runtime[]; text: string }
    | { kind: "post"; text: string };
```

At the top of `planMessage`, before the existing dispatch/steer logic, add the `ask` branch. The `RUNTIMES` const already exists in this file from Channels v1:
```ts
    const trimmed = text.trimStart();
    const askMatch = /^ask\s+/i.exec(trimmed);
    if (askMatch) {
        const { mentions, body } = parseMentions(trimmed.slice(askMatch[0].length));
        const runtimes = mentions.filter((m): m is Runtime => (RUNTIMES as string[]).includes(m));
        if (runtimes.length > 0) {
            return { kind: "consult", runtimes, text: body };
        }
        // "ask" with no known runtime -> not a consult; fall through to a plain post of the original text
    }
```
(The existing `parseMentions`/dispatch/steer/post logic below is unchanged. The fall-through returns the original `text` verbatim via the existing final `return { kind: "post", text }`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts`
Expected: PASS (consult cases + the unchanged dispatch/steer/post cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelmessages.ts frontend/app/view/agents/channelmessages.test.ts
git commit -m "feat(consult): ask @runtime routing in planMessage"
```

---

## Task 5: consult-stream store state + the send action

Hold live streaming text in a shared atom (the action layer, not the component, kicks off the streams), and add the consult branch to `sendChannelMessage` that posts one question row and fans out the streams.

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts`
- Modify: `frontend/app/view/agents/channelactions.ts`

- [ ] **Step 1: Add the consult-stream atom + setter to `channelsstore.ts`**

Append to `frontend/app/view/agents/channelsstore.ts`:
```ts
// Ephemeral live consult streams, keyed `${consultId}:${runtime}`. Not persisted — superseded by the
// consult-reply message (matched by RefORef `consult:<consultId>` + author) once it arrives via WOS.
export interface ConsultStream {
    text: string;
    status: "streaming" | "done" | "error";
}
export const consultStreamsAtom = atom<Record<string, ConsultStream>>({}) as PrimitiveAtom<
    Record<string, ConsultStream>
>;

export function consultStreamKey(consultId: string, runtime: string): string {
    return `${consultId}:${runtime}`;
}

export function setConsultStream(consultId: string, runtime: string, stream: ConsultStream): void {
    const key = consultStreamKey(consultId, runtime);
    globalStore.set(consultStreamsAtom, { ...globalStore.get(consultStreamsAtom), [key]: stream });
}
```
(If `atom`/`PrimitiveAtom` are not already imported in this file, add `import { atom, type PrimitiveAtom } from "jotai";` — Channels v1 already imports from `jotai` here.)

- [ ] **Step 2: Add the consult branch to `sendChannelMessage`**

In `frontend/app/view/agents/channelactions.ts`, add imports (if Channels v1 already imports `RpcApi`/`TabRpcClient` here, do not duplicate):
```ts
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { globalStore } from "@/app/store/jotaiStore";
import { consultStreamsAtom, consultStreamKey, setConsultStream } from "./channelsstore";
```
**Note on the id:** `consultId` uses `crypto.randomUUID()` — a renderer global in WebView2/Chromium, no import needed. If the codebase has its own uuid helper already imported in this file, use that for consistency.

In `sendChannelMessage`, after the existing `const plan = planMessage(text, roster);`, add the consult branch before the dispatch branch:
```ts
    if (plan.kind === "consult") {
        const consultId = crypto.randomUUID();
        // one question row (author "you"), grouped to its replies by the shared consultId
        await RpcApi.PostChannelMessageCommand(TabRpcClient, {
            channelid: channelId,
            kind: "consult",
            author: "you",
            text: plan.text,
            reforef: `consult:${consultId}`,
        });
        // fan out: one streaming consult per runtime, accumulating into the ephemeral atom
        await Promise.all(
            plan.runtimes.map(async (runtime) => {
                setConsultStream(consultId, runtime, { text: "", status: "streaming" });
                try {
                    const gen = RpcApi.ConsultCommand(TabRpcClient, {
                        channelid: channelId,
                        runtime,
                        prompt: plan.text,
                        consultid: consultId,
                    });
                    let acc = "";
                    for await (const chunk of gen) {
                        acc += chunk?.text ?? "";
                        setConsultStream(consultId, runtime, { text: acc, status: "streaming" });
                    }
                    setConsultStream(consultId, runtime, { text: acc, status: "done" });
                } catch {
                    // the backend still posts a consult-reply with the error; mark the live row done
                    setConsultStream(consultId, runtime, {
                        text: globalStore.get(consultStreamsAtom)[consultStreamKey(consultId, runtime)]?.text ?? "",
                        status: "error",
                    });
                }
            })
        );
        return;
    }
```
(If `globalStore` / `consultStreamsAtom` are needed here, import them from `@/app/store/jotaiStore` and `./channelsstore`. The existing dispatch/steer/post branches below are unchanged.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3 pre-existing `api.test.ts` ones. (Confirm `RpcApi.ConsultCommand` returns an `AsyncGenerator` — if `for await` complains, the codegen produced a different shape; check `wshclientapi.ts`.)

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/channelsstore.ts frontend/app/view/agents/channelactions.ts
git commit -m "feat(consult): consult-stream store state + fan-out send action"
```

---

## Task 6: render consult rows + supersession + autocomplete gating

Render the consult question, group its replies by `consultId`, show live streaming rows until the persisted reply supersedes them, and gate `@mention` autocomplete to installed runtimes.

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx`

- [ ] **Step 1: Load installed runtimes for autocomplete**

In `channelssurface.tsx`, inside the `ChannelsSurface` component, add state + a one-time load (place beside the existing `useEffect` that calls `loadChannels`):
```tsx
    const [installedRuntimes, setInstalledRuntimes] = useState<string[]>([]);
    useEffect(() => {
        fireAndForget(async () => {
            const rtn = await RpcApi.ListConsultRuntimesCommand(TabRpcClient);
            setInstalledRuntimes((rtn.runtimes ?? []).filter((r) => r.installed).map((r) => r.runtime));
        });
    }, []);
```
(Add imports if missing: `RpcApi` from `@/app/store/wshclientapi`, `TabRpcClient` from `@/app/store/wshrpcutil`. Wire `installedRuntimes` into the existing composer autocomplete suggestion list so an `ask @` only offers installed runtimes; if Channels v1's composer has no autocomplete yet, surface it minimally as a placeholder hint: `ask @claude / @codex / @agy`. Do not block on autocomplete — gating is the goal, not a new autocomplete engine.)

- [ ] **Step 2: Read the consult streams + group replies by consultId**

Inside `ChannelsSurface`, add:
```tsx
    const consultStreams = useAtomValue(consultStreamsAtom);
```
And a helper (module scope, beside the existing `workerFor`):
```tsx
function consultIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("consult:") ? refORef.slice("consult:".length) : undefined;
}
```
Add the import: `import { consultStreamsAtom, consultStreamKey } from "./channelsstore";`.

- [ ] **Step 3: Render consult question + reply rows**

In the message-rendering path, handle the two new kinds. A `consult-reply` message is rendered *under its question* (grouped by consultId), so skip it in the top-level `.map` and render it from the question row instead. Replace the top-level message map body so reply rows are not rendered standalone:
```tsx
                        messages
                            .filter((m) => m.kind !== "consult-reply")
                            .map((m) =>
                                m.kind === "consult" ? (
                                    <ConsultRow
                                        key={m.id}
                                        msg={m}
                                        allMessages={messages}
                                        streams={consultStreams}
                                        now={now}
                                    />
                                ) : (
                                    <Row key={m.id} model={model} agents={agents} msg={m} now={now} />
                                )
                            )
```
Add the `ConsultRow` component (module scope). It shows the question, then for each runtime either the persisted reply (preferred) or the live streaming text:
```tsx
function ConsultRow({
    msg,
    allMessages,
    streams,
    now,
}: {
    msg: ChannelMessage;
    allMessages: ChannelMessage[];
    streams: Record<string, import("./channelsstore").ConsultStream>;
    now: number;
}) {
    const consultId = consultIdOf(msg.reforef);
    const replies = consultId
        ? allMessages.filter((m) => m.kind === "consult-reply" && consultIdOf(m.reforef) === consultId)
        : [];
    const repliedRuntimes = new Set(replies.map((r) => r.author));
    // live streams for this consultId whose persisted reply has not yet arrived
    const liveKeys = consultId
        ? Object.keys(streams).filter((k) => k.startsWith(`${consultId}:`) && !repliedRuntimes.has(k.split(":")[1]))
        : [];
    return (
        <div className="border-b border-edge-faint px-1 py-3 last:border-b-0">
            <div className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] font-semibold text-primary">{msg.author}</span>
                <span className="rounded-[5px] border border-border px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.08em] text-muted">
                    ask
                </span>
                <span className="ml-auto font-mono text-[10.5px] text-muted">
                    {now - msg.ts < 60_000 ? "now" : new Date(msg.ts).toLocaleTimeString()}
                </span>
            </div>
            <div className="mt-1 text-[13.5px] leading-[1.5] text-secondary">{msg.text || "(empty)"}</div>
            {replies.map((r) => (
                <div key={r.id} className="mt-2 rounded-[8px] border border-border bg-surface-hover/40 p-2.5">
                    <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">{r.author}</div>
                    <div className="whitespace-pre-wrap text-[13px] leading-[1.5] text-secondary">{r.text}</div>
                </div>
            ))}
            {liveKeys.map((k) => {
                const runtime = k.split(":")[1];
                const s = streams[k];
                return (
                    <div key={k} className="mt-2 rounded-[8px] border border-accent/40 bg-accentbg/30 p-2.5">
                        <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">
                            {runtime} {s.status === "streaming" ? "· consulting…" : ""}
                        </div>
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.5] text-secondary">
                            {s.text || "…"}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
```
(Markdown rendering of replies is deferred — `whitespace-pre-wrap` text is the v1 renderer, consistent with keeping scope tight. If Channels v1 already imports a markdown component used by other rows, reuse it for `r.text`.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3 pre-existing `api.test.ts` ones.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(consult): consult question/reply rows + live-stream supersession + runtime gating"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Go tests**

Run: `go test ./pkg/consult/ ./pkg/wstore/ ./pkg/wshrpc/...`
Expected: PASS (incl. the new `pkg/consult` tests).

- [ ] **Step 2: Go build**

Run: `go build ./pkg/... ./cmd/...`
Expected: no errors.

- [ ] **Step 3: Frontend unit tests**

Run: `npx vitest run`
Expected: PASS (existing suite + the new consult cases in `channelmessages.test.ts`).

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` errors.

- [ ] **Step 5: CDP visual verification (live dev app)**

Start the dev app keeping wavesrv's stdin alive (closed stdin makes wavesrv exit on EOF): `tail -f /dev/null | task dev`. Then over CDP on `:9222` (`node scripts/cdp-shot.mjs consult.png`, `Runtime.evaluate` to drive):
- In a project-bound channel, send `ask @claude does this repo have tests?` → a **consult** question row appears immediately, a live **consulting…** row streams the reply in, and on completion it is replaced by a persisted **consult-reply** row that **survives a reload** (it is on the `Channel` waveobj).
- Send `ask @codex @claude review the auth flow` → **one** question row and **two** reply rows fill in **parallel**.
- Send `ask @<uninstalled-runtime> …` → the composer does not offer it (autocomplete gated); if forced, a reply row shows the not-installed/unsupported message and the channel does not break.
- Force a failure (e.g. a runtime whose process exits non-zero) → an error reply row renders; the channel keeps working.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(consult): verification fixups"
```

---

## Notes for the executor

- **Server-side exec is deliberate** (see `docs/orchestrator-roadmap.md`): the consult is a backend command so a future headless manager calls the identical verb. Do not move the exec into a frontend cmd-block.
- **`consultId` does three jobs:** groups the question to its replies, keys the ephemeral live stream, and lets the persisted reply supersede the live row. Keep it flowing through `RefORef = consult:<id>`.
- **stdin-vs-positional** (Task 1 Step 1): the map assumes stdin for all three; flip `PromptViaStdin` to false for any CLI the smoke test shows needs a positional prompt. This is the one real-world unknown in the plan.
- **Markdown / streaming polish deferred:** v1 renders replies as `whitespace-pre-wrap` text and streams in coarse byte chunks. Token-smoothing and markdown are deferred per the spec.
- **Per the user's git workflow:** fold this plan + the spec into the consult feature commit series; get explicit approval before any push.
```
