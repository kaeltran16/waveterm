# Pi Harness And OpenCode Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pi as a full Agent cockpit harness and correct OpenCode's visible name and icon everywhere.

**Architecture:** Keep the Go harness catalog authoritative for capabilities, install a Wave-managed Pi lifecycle extension for live status, and parse Pi's native version-3 JSONL through one focused `pkg/pisession` package shared by history and usage scanners. Frontend runtime-specific behavior remains in the existing launch, transcript-projector, and branding seams; Pi alone requests complete transcript history because its parent-linked active branch cannot be reconstructed from bounded tails.

**Tech Stack:** Go, Cobra, wshrpc code generation, React 19, TypeScript, jotai, Vitest, Tailwind 4, Pi coding agent 0.84.1, CDP scenario harness.

## Global Constraints

- Target Pi `0.84.1` and native session format version `3`.
- Keep runtime IDs and executable names lowercase (`pi`, `opencode`); visible labels are `Pi` and `OpenCode`.
- Use Pi's native JSONL as the only transcript and usage source; do not create a Wave shadow transcript.
- Only explicit `wsh ask` events produce Pi's asking state; do not infer waiting or register a new Pi question tool.
- Request and retain complete transcript history only for open Pi sessions; preserve existing limits for all other runtimes.
- Use exact structured argument arrays for Pi resume paths; never split or reconstruct a full Windows path.
- Store official OpenCode and Pi marks locally and use existing theme tokens around them; do not add raw component colors.
- Do not add dependencies or a generic harness adapter framework.
- Never hand-edit generated files; run `task generate` after Go wire-type changes.
- Never commit or push without explicit user authorization. Each task ends at a review checkpoint.

---

## File Map

**New backend files**

- `pkg/pisession/pisession.go`: strict Pi v3 JSONL parser, complete-record handling, branch traversal, shared usage/message types.
- `pkg/pisession/pisession_test.go`: parser, partial-write, version, missing-parent, and cycle behavior.
- `cmd/wsh/cmd/pi-status-extension.ts`: Wave-managed Pi lifecycle adapter.
- `pkg/usagestats/pi.go`: Pi billing-record extraction from `pisession.File`.
- `pkg/usagestats/pi_test.go`: Pi usage semantics and routing.

**New frontend files/assets**

- `frontend/app/view/agents/pitranscriptprojection.ts`: active-branch projection into `AgentEntry[]`.
- `frontend/app/view/agents/pitranscriptprojection.test.ts`: branch, tool, title, and compaction projection.
- `frontend/app/view/agents/runtimemark.tsx`: official-logo renderer with glyph fallback.
- `frontend/app/view/agents/runtimelogo.test.ts`: runtime asset lookup.
- `frontend/app/asset/opencode.png`: official OpenCode compact image.
- `frontend/app/asset/pi.svg`: official Pi compact badge.

**Principal modified files**

- `pkg/harness/catalog.go`, `pkg/consult/{consult.go,exec.go}`, `pkg/jarvis/runexec.go`
- `pkg/baseds/baseds.go`, `cmd/wsh/cmd/{wshcmd-agentstatus.go,wshcmd-installhooks.go}`
- `pkg/agentsessions/agentsessions.go`, `pkg/usagestats/usagestats.go`
- `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshserver/{wshserver_agents.go,transcript.go}`
- `frontend/app/view/agents/{launch.ts,runtimemeta.ts,runtimelogo.ts,transcriptregistry.ts,livetranscript.ts,sessionssurface.tsx}`
- Agent picker, channel, settings, usage, chart, row/header/detail, and resume-store files named in Tasks 6-8.
- Generated output from `task generate`: `frontend/types/gotypes.d.ts` and related generated RPC bindings.

---

### Task 1: Parse Pi Native Sessions Once

**Files:**
- Create: `pkg/pisession/pisession.go`
- Create: `pkg/pisession/pisession_test.go`

**Interfaces:**
- Consumes: Pi v3 JSONL files.
- Produces: `Read(path string) (*File, error)`, `Parse(path string, data []byte) (*File, error)`, and `(*File).ActiveBranch() ([]Entry, error)` for Tasks 4, 5, and fixture parity with Task 7.

- [ ] **Step 1: Write failing parser and branch tests**

Create table-driven tests with these exact behaviors:

```go
func TestParseUsesVersionThreeHeader(t *testing.T) {
    data := []byte("{\"type\":\"session\",\"version\":3,\"id\":\"session-1\",\"timestamp\":\"2026-08-11T03:00:00Z\",\"cwd\":\"C:\\\\repo\"}\n" +
        "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"timestamp\":\"2026-08-11T03:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"ship it\"}}\n")
    file, err := Parse(`C:\tmp\session.jsonl`, data)
    require.NoError(t, err)
    assert.Equal(t, "session-1", file.Header.ID)
    assert.Equal(t, `C:\repo`, file.Header.Cwd)
    assert.Len(t, file.Entries, 1)
}

func TestParseRejectsUnsupportedVersion(t *testing.T) {
    _, err := Parse("future.jsonl", []byte("{\"type\":\"session\",\"version\":4,\"id\":\"s\",\"cwd\":\"/repo\"}\n"))
    require.ErrorContains(t, err, "future.jsonl")
    require.ErrorContains(t, err, "unsupported Pi session version 4")
}

func TestParseIgnoresOnlyIncompleteFinalRecord(t *testing.T) {
    data := []byte("{\"type\":\"session\",\"version\":3,\"id\":\"s\",\"cwd\":\"/repo\"}\n" +
        "{\"type\":\"message\",\"id\":\"u\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"keep\"}}\n" +
        "{\"type\":\"message\",\"id\":\"half\"")
    file, err := Parse("partial.jsonl", data)
    require.NoError(t, err)
    assert.Len(t, file.Entries, 1)

    _, err = Parse("complete-bad.jsonl", append(data, '\n'))
    require.ErrorContains(t, err, "complete-bad.jsonl:3")
}
```

Add active-branch tests where an abandoned sibling is excluded, and separate tests where a missing parent or cycle returns a path-qualified error.

- [ ] **Step 2: Run the tests and confirm the missing package failure**

Run: `go test ./pkg/pisession`

Expected: FAIL because `pkg/pisession` and its exported types do not exist.

- [ ] **Step 3: Implement the strict parser and branch traversal**

Define these public contracts exactly:

```go
package pisession

const SupportedVersion = 3

type Header struct {
    Type          string `json:"type"`
    Version       int    `json:"version"`
    ID            string `json:"id"`
    Timestamp     string `json:"timestamp"`
    Cwd           string `json:"cwd"`
    ParentSession string `json:"parentSession,omitempty"`
}

type Usage struct {
    Input         int     `json:"input"`
    Output        int     `json:"output"`
    CacheRead     int     `json:"cacheRead"`
    CacheWrite    int     `json:"cacheWrite"`
    CacheWrite1h  int     `json:"cacheWrite1h,omitempty"`
    Reasoning     int     `json:"reasoning,omitempty"`
    TotalTokens   int     `json:"totalTokens"`
    Cost          Cost    `json:"cost"`
}

type Cost struct {
    Total float64 `json:"total"`
}

type Entry struct {
    Type      string          `json:"type"`
    ID        string          `json:"id"`
    ParentID  *string         `json:"parentId"`
    Timestamp string          `json:"timestamp"`
    Provider  string          `json:"provider,omitempty"`
    ModelID   string          `json:"modelId,omitempty"`
    Name      string          `json:"name,omitempty"`
    Summary   string          `json:"summary,omitempty"`
    Usage     *Usage          `json:"usage,omitempty"`
    Message   json.RawMessage `json:"message,omitempty"`
    Raw       json.RawMessage `json:"-"`
}

type File struct {
    Path    string
    Header  Header
    Entries []Entry
}

func Read(path string) (*File, error)
func Parse(path string, data []byte) (*File, error)
func (f *File) ActiveBranch() ([]Entry, error)
```

`Parse` must require a `type:"session"` first record, validate required header fields, reject duplicate entry IDs, ignore only a malformed non-newline-terminated final record, and include `path:line` in malformed complete-record errors. `ActiveBranch` starts at the last entry, follows `parentId`, detects missing parents/cycles, and reverses the result to root-first order.

- [ ] **Step 4: Run focused tests**

Run: `go test ./pkg/pisession`

Expected: PASS.

- [ ] **Step 5: Review checkpoint**

Inspect `git diff -- pkg/pisession`. Confirm there is no runtime-specific UI or scanner logic in this package and do not commit without explicit authorization.

---

### Task 2: Add Pi Catalog, Worker, And Consult Execution

**Files:**
- Modify: `pkg/harness/catalog.go`
- Modify: `pkg/harness/catalog_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_harness_test.go`
- Modify: `pkg/jarvis/runexec.go`
- Modify: `pkg/jarvis/runexec_test.go`
- Modify: `pkg/consult/consult.go`
- Modify: `pkg/consult/exec.go`
- Modify: `pkg/consult/consult_test.go`
- Modify: `pkg/consult/exec_test.go`

**Interfaces:**
- Consumes: existing `harness.Spec`, `consult.RuntimeSpec`, and `jarvis.RunWorkerSpec` seams.
- Produces: catalog runtime `pi`, persistent Pi workers with one positional prompt argument, and isolated Pi consults using `--mode json --no-session --no-extensions`.

- [ ] **Step 1: Write failing catalog and worker tests**

Require catalog order and capabilities:

```go
assert.Equal(t, []string{"claude", "codex", "opencode", "pi", "antigravity"}, runtimes)
pi, ok := harness.Lookup("pi")
require.True(t, ok)
assert.Equal(t, "pi", pi.Bin)
assert.Equal(t, "Pi", pi.Label)
assert.True(t, pi.ConsultCapable)
assert.True(t, pi.RunWorkerCapable)
```

Add this worker case to `runexec_test.go`:

```go
{"pi", "pi", []string{"do work"}},
```

- [ ] **Step 2: Write failing consult parser tests**

Add exact argv expectations and parser cases:

```go
spec, ok := SpecFor("pi")
require.True(t, ok)
assert.Equal(t, "pi", spec.Bin)
assert.Equal(t, []string{"--mode", "json", "--no-session", "--no-extensions"}, spec.BaseArgs)
assert.False(t, spec.PromptViaStdin)

event := spec.ParseLine([]byte(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello "},{"type":"text","text":"world"}],"stopReason":"stop"}}`))
assert.Equal(t, "hello world", event.Text)
assert.NoError(t, event.Err)

event = spec.ParseLine([]byte(`{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"provider failed"}}`))
require.ErrorContains(t, event.Err, "provider failed")

event = spec.ParseLine([]byte(`{"type":"agent_settled"}`))
assert.True(t, event.Complete)
```

- [ ] **Step 3: Run focused tests and confirm failures**

Run: `go test ./pkg/harness ./pkg/jarvis ./pkg/consult`

Expected: FAIL on absent Pi entries and absent structured parse result.

- [ ] **Step 4: Add Pi to the catalog and worker switch**

Add this catalog entry after OpenCode:

```go
{Runtime: "pi", Bin: "pi", Label: "Pi", ConsultCapable: true, RunWorkerCapable: true},
```

Add this `RunWorkerSpecFor` branch:

```go
case "pi":
    return RunWorkerSpec{Bin: h.Bin, Args: []string{prompt}}, true
```

- [ ] **Step 5: Generalize consult parsing without changing existing output**

Replace the two-value parser contract with:

```go
type ParsedEvent struct {
    Text     string
    Complete bool
    Err      error
}

type RuntimeSpec struct {
    Bin            string
    BaseArgs       []string
    PromptViaStdin bool
    UsePty         bool
    ParseLine      func(line []byte) ParsedEvent
    ApiBackend     apiBackend
    Model          string
}
```

Adapt Claude, Codex, and OpenCode parsers to return `ParsedEvent{Text: text}` for their current reply events and `ParsedEvent{}` otherwise. Add:

```go
func piParseLine(line []byte) ParsedEvent {
    var ev struct {
        Type    string `json:"type"`
        Message struct {
            Role         string `json:"role"`
            StopReason   string `json:"stopReason"`
            ErrorMessage string `json:"errorMessage"`
            Content      []struct {
                Type string `json:"type"`
                Text string `json:"text"`
            } `json:"content"`
        } `json:"message"`
    }
    if err := json.Unmarshal(line, &ev); err != nil {
        return ParsedEvent{}
    }
    if ev.Type == "agent_settled" {
        return ParsedEvent{Complete: true}
    }
    if ev.Type != "message_end" || ev.Message.Role != "assistant" {
        return ParsedEvent{}
    }
    if ev.Message.StopReason == "error" {
        return ParsedEvent{Err: fmt.Errorf("Pi assistant error: %s", ev.Message.ErrorMessage)}
    }
    var text strings.Builder
    for _, block := range ev.Message.Content {
        if block.Type == "text" {
            text.WriteString(block.Text)
        }
    }
    return ParsedEvent{Text: text.String()}
}
```

Add the runtime spec:

```go
"pi": {
    Bin: "pi",
    BaseArgs: []string{"--mode", "json", "--no-session", "--no-extensions"},
    PromptViaStdin: false,
    ParseLine: piParseLine,
},
```

In `runPipe`, continue draining stdout after `Complete`, append only non-empty `Text`, remember the first parse error, reap the process, then return the parse error with `spec.Bin` context. Process exit remains valid even when `agent_settled` is absent.

- [ ] **Step 6: Run focused tests**

Run: `go test ./pkg/harness ./pkg/jarvis ./pkg/consult`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Inspect the task diff. Confirm consults use both `--no-session` and `--no-extensions`, existing parser tests remain unchanged semantically, and no commit occurs without authorization.

---

### Task 3: Report Pi Live Status Through A Managed Extension

**Files:**
- Modify: `pkg/baseds/baseds.go`
- Modify: `cmd/wsh/cmd/wshcmd-agentstatus.go`
- Modify: `cmd/wsh/cmd/wshcmd-agentstatus_test.go`
- Create: `cmd/wsh/cmd/pi-status-extension.ts`
- Create: `cmd/wsh/cmd/pi-status-extension.test.ts`
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go`
- Modify: `cmd/wsh/cmd/wshcmd-installhooks_test.go`

**Interfaces:**
- Consumes: Pi `ExtensionAPI` lifecycle callbacks and existing `wsh agentstatus` publishing.
- Produces: `AgentStatusData.Cwd`, `.SessionID`, and `.Provider`; managed file `~/.pi/agent/extensions/waveterm-status.ts`.

- [ ] **Step 1: Write failing status-payload tests**

Extract and test a pure builder with this signature:

```go
func buildAgentStatusData(
    oref *waveobj.ORef,
    state, detail, agent, cwd, transcriptPath, sessionID, title, provider, model string,
    ts int64,
) baseds.AgentStatusData
```

Assert a Pi payload preserves `C:\Users\Jane Doe\.pi\agent\sessions\s.jsonl` as one string, carries `session-1`, `openai-codex`, and `gpt-5.5`, and still validates only working/waiting/idle states.

- [ ] **Step 2: Write failing installer tests**

Tests must stub `piLookPath`, install into a temporary home, and assert:

```go
path := filepath.Join(home, ".pi", "agent", "extensions", "waveterm-status.ts")
body, err := os.ReadFile(path)
require.NoError(t, err)
assert.NotContains(t, string(body), "__WSH_PATH__")
assert.Contains(t, string(body), jsonString(fakeWshPath))
```

Also test absent Pi is a no-op, equal bytes preserve mtime, and a changed executable path rewrites the file.

- [ ] **Step 3: Run tests and confirm failures**

Run: `go test ./cmd/wsh/cmd -run 'AgentStatus|PiStatusExtension'`

Expected: FAIL because fields, flags, extension, and installer do not exist.

- [ ] **Step 4: Extend the status payload and CLI flags**

Add to `baseds.AgentStatusData`:

```go
Cwd       string `json:"cwd,omitempty"`
SessionID string `json:"sessionid,omitempty"`
Provider  string `json:"provider,omitempty"`
```

Add `--cwd`, `--session-id`, and `--provider` flags; update `--agent` help to `claude | codex | opencode | pi | antigravity`. Build the event through `buildAgentStatusData` so tests do not depend on Cobra globals.

- [ ] **Step 5: Implement the Pi extension lifecycle mapping**

The extension's testable registration function and default export must register these exact state transitions:

```ts
export function registerWavetermStatus(pi: any, wshPath: string): void {
    let state: "working" | "idle" = "idle";
    const report = async (ctx: any, next: "working" | "idle", detail = "") => {
        state = next;
        const args = [
            "agentstatus",
            "--agent", "pi",
            "--state", next,
            "--cwd", ctx.cwd ?? "",
            "--transcript", ctx.sessionManager.getSessionFile() ?? "",
            "--session-id", ctx.sessionManager.getSessionId() ?? "",
            "--title", ctx.sessionManager.getSessionName?.() ?? "",
            "--provider", ctx.model?.provider ?? "",
            "--model", ctx.model?.id ?? "",
        ];
        if (detail) args.push("--detail", detail.slice(0, 160));
        try { await pi.exec(wshPath, args); } catch { /* live reporting is best-effort */ }
    };

    const reportUsage = async (ctx: any) => {
        const usage = ctx.getContextUsage?.();
        if (usage?.percent == null) return;
        try {
            await pi.exec(wshPath, [
                "agentstatus", "--usage",
                "--context-pct", String(usage.percent),
                "--context-max", String(usage.contextWindow),
            ]);
        } catch { /* live reporting is best-effort */ }
    };

    pi.on("session_start", (_event: any, ctx: any) => report(ctx, "idle"));
    pi.on("session_info_changed", (_event: any, ctx: any) => report(ctx, state));
    pi.on("model_select", (_event: any, ctx: any) => report(ctx, state));
    pi.on("agent_start", (_event: any, ctx: any) => report(ctx, "working"));
    pi.on("tool_execution_start", (event: any, ctx: any) => report(ctx, "working", event.toolName ?? "tool"));
    pi.on("message_end", async (_event: any, ctx: any) => {
        await report(ctx, state);
        await reportUsage(ctx);
    });
    pi.on("agent_settled", (_event: any, ctx: any) => report(ctx, "idle"));
    pi.on("session_shutdown", (_event: any, ctx: any) => report(ctx, "idle"));
}

export default function wavetermStatus(pi: any): void {
    registerWavetermStatus(pi, "__WSH_PATH__");
}
```

Export the registration function separately from the default export so `pi-status-extension.test.ts` can inject a fake executable path, capture `pi.on` handlers, invoke every lifecycle event, and assert exact status/usage argv. The installed default calls that function with `"__WSH_PATH__"`; replace the complete quoted placeholder with a JSON string literal during installation. Do not register waiting detection or an ask tool. Explicit `wsh ask` events are already overlaid by frontend `withAsk` independently of runtime status.

- [ ] **Step 6: Embed and install the extension idempotently**

Mirror the OpenCode installer using:

```go
//go:embed pi-status-extension.ts
var piStatusExtensionTemplate string

var piLookPath = exec.LookPath

func installPiStatusExtension(home string) error
```

Replace the complete `"__WSH_PATH__"` token with `jsonString(exe)`, write to `~/.pi/agent/extensions/waveterm-status.ts` via `.tmp` plus rename, and call the installer after `installOpencodePlugin(home)` in `installAgentHooksRun`.

- [ ] **Step 7: Run focused tests**

Run: `go test ./cmd/wsh/cmd -run 'AgentStatus|PiStatusExtension|InstallAgentHooks'`

Run: `npx vitest run cmd/wsh/cmd/pi-status-extension.test.ts`

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Confirm reporting failures are swallowed only inside the Pi extension boundary, all Go filesystem errors remain contextual, and no commit occurs without authorization.

---

### Task 4: Discover Pi Sessions And Carry Exact Resume Arguments

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go`
- Add tests in: `pkg/agentsessions/agentsessions_test.go`
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_agents.go`
- Modify: `frontend/app/view/agents/launch.ts`
- Modify: `frontend/app/view/agents/launch.test.ts`
- Modify: `frontend/app/cockpit/cockpit-actions.ts`
- Modify: `frontend/app/cockpit/cockpit-actions.test.ts`
- Modify resume callers: `frontend/app/view/agents/sessionssurface.tsx`, `frontend/app/view/agents/agentlaunchhero.tsx`, `frontend/app/cockpit/command-palette.tsx`
- Modify: `frontend/app/view/agents/session-models/agentresumestore.ts`
- Modify: `frontend/app/view/agents/session-models/agentresumestore.test.ts`
- Modify generated outputs only through: `task generate`

**Interfaces:**
- Consumes: `pisession.Read/Parse/ActiveBranch` from Task 1.
- Produces: `SessionInfo.ResumeArgs []string`, wire `resumeargs`, exact frontend `startupArgs`, Pi history discovery, and live-session persistence.

- [ ] **Step 1: Write failing Pi session-discovery tests**

Create a fixture under a deliberately misleading encoded directory and assert:

```go
assert.Equal(t, "session-uuid", got.ID)
assert.Equal(t, `C:\Users\Jane Doe\IdeaProjects\waveterm`, got.ProjectPath)
assert.Equal(t, "waveterm", got.ProjectName)
assert.Equal(t, fullTranscriptPath, got.TranscriptPath)
assert.Equal(t, []string{"--session", fullTranscriptPath}, got.ResumeArgs)
assert.Equal(t, "Pi session title", got.Task)
assert.Equal(t, "openai-codex/gpt-5.5", got.Model)
```

Add fixtures proving latest active `session_info.name` wins, first active user text is the fallback, abandoned branch text does not become the task/model, a partial final record survives, and an unsupported version is logged/skipped while another valid session remains.

- [ ] **Step 2: Write failing structured-resume frontend tests**

Require exact argument preservation:

```ts
expect(buildLaunchMeta({
    runtime: "pi",
    startupCommand: "pi",
    startupArgs: ["--session", "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl"],
    task: "",
    cwd: "C:\\repo",
})["cmd:args"]).toEqual([
    "--session",
    "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl",
]);

expect(resumeArgsForPi("C:\\new path\\s.jsonl", ["--session", "C:\\old path\\s.jsonl", "--model", "x"]))
    .toEqual(["--session", "C:\\new path\\s.jsonl", "--model", "x"]);
```

Add a `launchAgent` test where `resumePath` points at a missing Pi JSONL. Mock `RpcApi.FileInfoCommand` to reject and assert `WorkspaceService.CreateTab` is not called and the error contains `Pi session no longer exists` plus the exact path.

- [ ] **Step 3: Run tests and confirm failures**

Run: `go test ./pkg/agentsessions -run Pi`

Run: `npx vitest run frontend/app/view/agents/launch.test.ts frontend/app/cockpit/cockpit-actions.test.ts frontend/app/view/agents/session-models/agentresumestore.test.ts`

Expected: FAIL on absent provider, resume fields, Pi runtime, and structured args.

- [ ] **Step 4: Add the Pi provider and metadata extraction**

Add `ResumeArgs []string` to internal `agentsessions.SessionInfo`. Register:

```go
piProvider(filepath.Join(home, ".pi", "agent", "sessions"))
```

Use header ID/cwd/timestamp only. Walk the active branch for title/model, but sum all billed records for `TokensTotal`. Set:

```go
s.Runtime = "pi"
s.TranscriptPath = path
s.ResumeCommand = "pi --session " + strconv.Quote(path)
s.ResumeArgs = []string{"--session", path}
```

Malformed Pi files must be logged with path context and skipped without discarding valid sibling sessions.

- [ ] **Step 5: Add exact resume args to wire types and conversion**

Add `TranscriptPath` and exact arguments to `wshrpc.SessionInfo`, and exact arguments to `wshrpc.SessionActivity`:

```go
// SessionInfo
TranscriptPath string   `json:"transcriptpath"`
ResumeArgs []string `json:"resumeargs,omitempty"`

// SessionActivity
ResumeArgs []string `json:"resumeargs,omitempty"`
```

Map the internal field in `GetRecentSessionsCommand` and `GetSessionsActivityCommand`. Keep `ResumeCommand` for display/backward compatibility.

- [ ] **Step 6: Regenerate bindings**

Run: `task generate`

Expected: PASS; generated TypeScript `SessionInfo` contains `transcriptpath: string` and both session types contain optional `resumeargs?: string[]`. Do not manually edit generated files.

- [ ] **Step 7: Add frontend structured launch arguments**

Extend both launch option types with `startupArgs?: string[]`; add `resumePath?: string` to `LaunchAgentOpts`. Before worktree or tab creation, preflight `resumePath` through:

```ts
if (opts.resumePath) {
    try {
        await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: opts.resumePath } });
    } catch {
        throw new Error(`Pi session no longer exists: ${opts.resumePath}`);
    }
}
```

History resume callers pass the Pi transcript path as `resumePath`. In `buildLaunchMeta`, use `startupArgs` verbatim when present; only split `startupCommand` for legacy callers. Add:

```ts
export function resumeArgsForPi(transcriptPath: string, baseArgs: string[] = []): string[] {
    const kept: string[] = [];
    for (let i = 0; i < baseArgs.length; i++) {
        if (baseArgs[i] === "--session") {
            i++;
            continue;
        }
        kept.push(baseArgs[i]);
    }
    return ["--session", transcriptPath, ...kept];
}
```

History launch callers use generated `resumeargs` and `resumePath`; live persistence uses the full transcript path as Pi's cache key and accepts `meta.cmd === "pi"`. Never call `sessionIdFromTranscript` for Pi. The preflight prevents a stale archived entry from reaching Pi's create-if-missing `--session` behavior.

- [ ] **Step 8: Run focused tests and type generation check**

Run: `go test ./pkg/agentsessions ./pkg/wshrpc/wshserver -run 'Pi|Session'`

Run: `npx vitest run frontend/app/view/agents/launch.test.ts frontend/app/cockpit/cockpit-actions.test.ts frontend/app/view/agents/session-models/agentresumestore.test.ts`

Expected: PASS.

- [ ] **Step 9: Review checkpoint**

Confirm paths with spaces remain one argv element, removed files are never converted to `--session-id`, generated changes originate from Go, and no commit occurs without authorization.

---

### Task 5: Aggregate Pi Usage Without Double Counting

**Files:**
- Create: `pkg/usagestats/pi.go`
- Create: `pkg/usagestats/pi_test.go`
- Modify: `pkg/usagestats/usagestats.go`

**Interfaces:**
- Consumes: every physical `pisession.Entry`, not only `ActiveBranch`.
- Produces: ordinary `usagestats.Record` values with harness `pi`, separate provider/model, normalized reasoning, cache usage, and reported cost.

- [ ] **Step 1: Write failing extraction and routing tests**

Use one fixture containing an active assistant, abandoned assistant, tool-result usage, compaction usage, and branch-summary usage. Assert:

```go
assert.Equal(t, "pi", record.Harness)
assert.Equal(t, "openai-codex", record.Provider)
assert.Equal(t, "gpt-5.5", record.Model)
assert.Equal(t, native.Output-native.Reasoning, record.Output)
assert.Equal(t, native.Reasoning, record.Reasoning)
assert.Equal(t, native.CacheWrite, record.CacheCreate)
assert.Equal(t, native.CacheWrite1h, record.CacheCreate1h)
```

Also assert abandoned branches remain billed, provider/model/day buckets remain separate, partial final records work through `pisession`, and `TranscriptUsage` recognizes `/.pi/agent/sessions/` paths.

- [ ] **Step 2: Run tests and confirm failure**

Run: `go test ./pkg/usagestats -run Pi`

Expected: FAIL because Pi scan kind and extraction do not exist.

- [ ] **Step 3: Implement Pi extraction**

Define:

```go
func extractPi(file *pisession.File, cutoff time.Time) []Record
func walkPiFiles(root string, cutoff time.Time) []scanFile
```

Track current provider/model from `model_change` and assistant messages. Emit records for assistant messages, tool-result messages, compaction, and branch-summary usage. Normalize:

```go
reasoning := max(usage.Reasoning, 0)
output := max(usage.Output-reasoning, 0)
```

Keep `CacheCreate1h` as metadata inside `CacheCreate`; do not add it to total tokens separately. Use each entry timestamp for cutoff filtering and `usage.Cost.Total` for reported cost.

- [ ] **Step 4: Register scan and transcript routing**

Add `scanPi`, append `~/.pi/agent/sessions` in `ScanUsage`, parse via `pisession.Read`, and route native Pi transcripts before Claude/Codex heuristics in `transcriptRecords`.

- [ ] **Step 5: Run tests**

Run: `go test ./pkg/pisession ./pkg/usagestats`

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Confirm transcript projection excludes abandoned branches while usage intentionally includes them, reasoning/cache subsets are not doubled, and no commit occurs without authorization.

---

### Task 6: Add Pi Runtime, Launch, Picker, And Channel Support

**Files:**
- Modify: `frontend/app/view/agents/launch.ts`
- Modify: `frontend/app/view/agents/launch.test.ts`
- Modify: `frontend/app/view/agents/runtimemeta.ts`
- Modify: `frontend/app/view/agents/runtimemeta.test.ts`
- Modify: `frontend/app/view/agents/newagentmodal.tsx`
- Modify: `frontend/app/view/agents/settingssurface.tsx`
- Modify: `frontend/app/view/agents/channelmessages.ts`
- Modify: `frontend/app/view/agents/channelmessages.test.ts`
- Modify: `frontend/app/view/agents/composercommand.test.ts`
- Modify: `frontend/app/view/agents/harnesspicker.test.ts`
- Modify: `frontend/app/view/agents/usagestats.ts`
- Modify: `frontend/app/view/agents/usagestats.test.ts`

**Interfaces:**
- Consumes: Go catalog runtime `pi`, generated harness capabilities, and structured resume support from Task 4.
- Produces: interactive Pi launch, picker/settings selection, `@pi` dispatch, `ask @pi`, and Pi usage filtering.

- [ ] **Step 1: Write failing runtime and launch tests**

Add expectations:

```ts
expect(runtimeStartupCommand("pi")).toBe("pi");
expect(RUNTIME_FLAGS.pi).toEqual([]);
expect(runtimeMeta("PI").label).toBe("Pi");
expect(buildLaunchMeta({ runtime: "pi", startupCommand: "pi", task: "audit auth", cwd: "C:\\repo" })["cmd:args"])
    .toEqual(["audit auth"]);
```

Update the harness fixture/order to include Pi after OpenCode and before Antigravity.

- [ ] **Step 2: Write failing channel and usage tests**

Add:

```ts
expect(planMessage("@pi investigate")).toEqual({ kind: "dispatch", runtime: "pi", prompt: "investigate" });
expect(planMessage("ask @pi review this")).toEqual({ kind: "consult", runtimes: ["pi"], prompt: "review this" });
```

Add Pi buckets to usage aggregation and assert Pi remains separate from its provider/model dimensions.

- [ ] **Step 3: Run tests and confirm failures**

Run: `npx vitest run frontend/app/view/agents/launch.test.ts frontend/app/view/agents/runtimemeta.test.ts frontend/app/view/agents/channelmessages.test.ts frontend/app/view/agents/composercommand.test.ts frontend/app/view/agents/harnesspicker.test.ts frontend/app/view/agents/usagestats.test.ts`

Expected: FAIL on absent runtime entries and stale fixture counts.

- [ ] **Step 4: Add Pi to runtime-specific frontend seams**

Extend `Runtime` with `"pi"`, add `RUNTIME_CMD.pi = "pi"`, `RUNTIME_FLAGS.pi = []`, and runtime metadata:

```ts
{
    id: "pi",
    label: "Pi",
    glyph: "Pi",
    text: "text-rt-pi",
    soft: "bg-rt-pi-soft",
    line: "border-rt-pi-line",
}
```

Add Pi to the New Agent order and Settings runtime order. Render a `No launch flags available` state for Pi rather than an empty flag box.

- [ ] **Step 5: Add Pi to legacy channel parsing and catalog fixtures**

Add `"pi"` to `channelmessages.ts`'s hardcoded runtime list. Keep the newer composer and harness picker catalog-driven; update only their test fixtures and expectations.

- [ ] **Step 6: Run focused tests**

Run the Step 3 command again.

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm frontend code does not duplicate catalog capability decisions, Pi has no speculative flags, and no commit occurs without authorization.

---

### Task 7: Project Complete Pi Active-Branch Transcripts

**Files:**
- Create: `frontend/app/view/agents/pitranscriptprojection.ts`
- Create: `frontend/app/view/agents/pitranscriptprojection.test.ts`
- Modify: `frontend/app/view/agents/transcriptregistry.ts`
- Modify: `frontend/app/view/agents/transcriptregistry.test.ts`
- Modify: `frontend/app/view/agents/livetranscript.ts`
- Modify tests in: `frontend/app/view/agents/livetranscript.test.ts`
- Modify: `frontend/app/view/agents/sessionssurface.tsx`
- Modify: `pkg/wshrpc/wshserver/transcript.go`
- Modify: `pkg/wshrpc/wshserver/transcript_test.go`

**Interfaces:**
- Consumes: complete Pi JSONL lines and existing `AgentEntry` union.
- Produces: `projectPiTranscript(lines)`, `extractPiTitle(lines)`, registry routing, and a negative-limit full-history transcript request used only for Pi.

- [ ] **Step 1: Write failing projector tests**

Use the same branch fixture semantics as Task 1 and assert:

```ts
expect(projectPiTranscript(lines)).toMatchObject([
    { kind: "user", text: "implement it" },
    { kind: "message", text: "Inspecting." },
    { kind: "action", tool: "bash", target: "go test ./pkg/...", outcome: "ok" },
    { kind: "user", text: "use approach B" },
    { kind: "message", text: "Approach B works." },
]);
expect(projectPiTranscript(lines).some((entry) => JSON.stringify(entry).includes("Approach A failed"))).toBe(false);
```

Add failed-tool, compaction, branch-summary exclusion, malformed-line tolerance, cycle termination, and latest `session_info` title tests.

- [ ] **Step 2: Write failing registry and complete-history tests**

Assert explicit `pi` and both Windows/POSIX `/.pi/agent/sessions/` paths select the Pi projector. Assert an unrelated project path containing `pi` does not.

At the backend boundary, add a test that `taillines: -1` returns every complete line while positive limits retain existing tail behavior. In `livetranscript.test.ts`, assert Pi requests `taillines: -1` and does not apply `MAX_RETAINED_LINES`, while Claude still requests `300` and caps at `4000`.

- [ ] **Step 3: Run tests and confirm failures**

Run: `go test ./pkg/wshrpc/wshserver -run Transcript`

Run: `npx vitest run frontend/app/view/agents/pitranscriptprojection.test.ts frontend/app/view/agents/transcriptregistry.test.ts frontend/app/view/agents/livetranscript.test.ts`

Expected: FAIL because Pi projection and all-lines semantics do not exist.

- [ ] **Step 4: Implement the pure Pi projector**

Export:

```ts
export function projectPiTranscript(lines: string[]): AgentEntry[];
export function extractPiTitle(lines: string[]): string | undefined;
```

Parse valid v3 records, index branch-bearing records by ID, follow the final record's parent chain, reverse it, and map only active entries. Map user/assistant text blocks to existing entry kinds, join tool results to tool calls by `toolCallId`, map compaction to the existing compaction kind, and never render `branch_summary` as user content. Return a safe reachable suffix on malformed frontend input; strict file diagnostics remain backend-owned.

- [ ] **Step 5: Register Pi and route Sessions detail through the registry**

Add:

```ts
pi: { project: projectPiTranscript, extractTitle: extractPiTitle },
```

Normalize path separators before matching `/.pi/agent/sessions/`. Replace Sessions detail's Codex/Claude binary branch with:

```ts
projectorFor(session.runtime, session.transcriptpath).project(lines)
```

This also corrects archived OpenCode sessions currently falling through to Claude projection.

- [ ] **Step 6: Add full-history transport for Pi only**

In backend transcript reads, define `limit < 0` as all complete lines; preserve current defaults for `0` and positive tail behavior. In `startTranscriptStream` derive:

```ts
const isPi = agent?.toLowerCase() === "pi" || path.replaceAll("\\", "/").includes("/.pi/agent/sessions/");
const tailLines = isPi ? -1 : STREAM_TAIL_LINES;
```

For Pi, retain every streamed line while the session is open. For other runtimes, keep `capLines(lines, MAX_RETAINED_LINES)`. Archived Pi Session detail requests `limit: -1`; other runtimes retain `2000`.

- [ ] **Step 7: Run focused tests**

Run the Step 3 commands again.

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Confirm abandoned transcript branches are hidden but still billed in Task 5, only Pi gets unbounded open-session retention, OpenCode archive projection now routes correctly, and no commit occurs without authorization.

---

### Task 8: Correct OpenCode Branding And Add Pi Marks

**Files:**
- Create from canonical source: `frontend/app/asset/opencode.png`
- Create from canonical source: `frontend/app/asset/pi.svg`
- Modify: `frontend/app/view/agents/runtimelogo.ts`
- Create: `frontend/app/view/agents/runtimelogo.test.ts`
- Create: `frontend/app/view/agents/runtimemark.tsx`
- Modify: `frontend/app/view/agents/runtimemeta.ts`
- Modify: `frontend/app/view/agents/agentrow.tsx`
- Modify: `frontend/app/view/agents/agentheader.tsx`
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx`
- Modify: `frontend/app/view/agents/runworkercard.tsx`
- Modify: `frontend/app/view/agents/sessionssurface.tsx`
- Modify: `frontend/app/view/agents/newagentmodal.tsx`
- Modify: `frontend/app/view/agents/harnesspicker.tsx`
- Modify: `frontend/app/view/agents/channelsprimitives.tsx`
- Modify: `frontend/app/view/agents/settingssurface.tsx`
- Modify: `frontend/app/view/agents/usagesurface.tsx`
- Modify: `frontend/app/view/agents/dailychart.tsx`
- Modify: `frontend/app/view/agents/cockpitrailmodel.ts`
- Modify adjacent tests for runtime labels/charts/rail.
- Modify: `frontend/tailwindsetup.css`

**Interfaces:**
- Consumes: canonical OpenCode compact PNG and Pi compact SVG.
- Produces: `runtimeLogo(runtime)`, shared `<RuntimeMark>`, consistent `OpenCode`/`Pi` labels, and Pi theme tokens.

- [ ] **Step 1: Add canonical local assets and failing lookup tests**

Download byte-for-byte from:

```text
https://opencode.ai/apple-touch-icon-v3.png
https://pi.dev/favicon.svg
```

Test:

```ts
expect(runtimeLogo("OpenCode")).toContain("opencode");
expect(runtimeLogo("PI")).toContain("pi");
expect(runtimeLogo("unknown")).toBeUndefined();
```

- [ ] **Step 2: Run lookup and label tests to confirm failure**

Run: `npx vitest run frontend/app/view/agents/runtimelogo.test.ts frontend/app/view/agents/runtimemeta.test.ts frontend/app/view/agents/dailychart.test.ts frontend/app/view/agents/cockpitrailmodel.test.ts`

Expected: FAIL on missing assets/Pi map and lowercase OpenCode expectations.

- [ ] **Step 3: Add logo lookup and shared mark rendering**

Map `opencode` and `pi` in `runtimelogo.ts`. Add:

```tsx
export function RuntimeMark({ runtime, className, imageClassName }: {
    runtime?: string;
    className?: string;
    imageClassName?: string;
}) {
    const logo = runtimeLogo(runtime);
    const meta = runtimeMeta(runtime);
    if (logo) {
        return <img src={logo} alt={`${meta.label} logo`} className={imageClassName ?? className} />;
    }
    return <span className={className}>{meta.glyph}</span>;
}
```

Replace direct runtime glyphs in the listed Agent components with `RuntimeMark`. `channelsprimitives.Avatar` already uses `runtimeLogo`; normalize its `alt` and `title` through `runtimeMeta(name).label`.

- [ ] **Step 4: Normalize labels and add Pi runtime tokens**

Change every visible OpenCode string to `OpenCode` while retaining lowercase IDs. Add `Pi` labels to settings, usage chips, chart metadata, and cockpit rail. Make `harnessSub()` render `HARNESS_CHIP_LABEL[h] ?? h` instead of raw IDs.

Add `--color-provider-pi`, `--color-rt-pi`, `--color-rt-pi-soft`, and `--color-rt-pi-line` in `frontend/tailwindsetup.css`, using the existing neutral runtime palette pattern rather than raw colors in components.

- [ ] **Step 5: Run focused frontend tests**

Run: `npx vitest run frontend/app/view/agents/runtimelogo.test.ts frontend/app/view/agents/runtimemeta.test.ts frontend/app/view/agents/harnesspicker.test.ts frontend/app/view/agents/dailychart.test.ts frontend/app/view/agents/cockpitrailmodel.test.ts frontend/app/view/agents/usagestats.test.ts`

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Search visible lowercase branding:

Run: `rg -n '(["`>])opencode(["`<])' frontend/app/view/agents`

Expected: remaining matches are internal IDs, commands, keys, or fixtures only. Confirm all runtime images are local bundled assets and no commit occurs without authorization.

---

### Task 9: Documentation, CDP Coverage, And End-To-End Verification

**Files:**
- Modify: `docs/agents/channels-reference.md`
- Modify: `scripts/cdp/scenarios.mjs`
- Modify fixture builders referenced by `usage-charts` and `harness-picker` scenarios.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: updated operator/runtime documentation and repeatable visual/runtime verification.

- [ ] **Step 1: Update runtime documentation**

Document:

```text
Pi is discovered from `pi` on PATH. `wsh install-agent-hooks` installs
`~/.pi/agent/extensions/waveterm-status.ts`. Pi sessions remain authoritative under
`~/.pi/agent/sessions`; Wave reads them directly and resumes with `pi --session` plus the exact native path as one argument.
Launching Pi with `--no-extensions` disables live status reporting but not history, usage, or resume.
```

Add `@pi` and `ask @pi` channel examples. Keep OpenCode casing corrected in touched prose.

- [ ] **Step 2: Extend CDP fixtures and assertions**

In `usage-charts`, add Pi buckets, select the Pi filter, verify provider/model separation, and assert legend text `OpenCode` and `Pi`. In `harness-picker`, require `harness-option-pi`, local loaded `<img>` marks for OpenCode/Pi, `naturalWidth > 0`, and no remote asset URLs. Keep Pi selection conditional on installation while still asserting the unavailable row exists.

- [ ] **Step 3: Run backend tests with required CGO setup**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/pisession ./pkg/harness ./pkg/consult ./pkg/jarvis ./pkg/agentsessions ./pkg/usagestats ./pkg/wshrpc/wshserver ./cmd/wsh/cmd
```

Expected: PASS.

- [ ] **Step 4: Run focused and full frontend verification**

Run:

```powershell
npx vitest run frontend/app/view/agents/launch.test.ts frontend/app/view/agents/session-models/agentresumestore.test.ts frontend/app/view/agents/channelmessages.test.ts frontend/app/view/agents/composercommand.test.ts frontend/app/view/agents/harnesspicker.test.ts frontend/app/view/agents/runtimemeta.test.ts frontend/app/view/agents/runtimelogo.test.ts frontend/app/view/agents/pitranscriptprojection.test.ts frontend/app/view/agents/transcriptregistry.test.ts frontend/app/view/agents/livetranscript.test.ts frontend/app/view/agents/usagestats.test.ts frontend/app/view/agents/dailychart.test.ts frontend/app/view/agents/cockpitrailmodel.test.ts
npx vitest run cmd/wsh/cmd/pi-status-extension.test.ts
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: PASS.

- [ ] **Step 5: Check formatting and lint only on touched scopes**

Run:

```powershell
npx prettier --check frontend/app/view/agents frontend/app/asset frontend/tailwindsetup.css cmd/wsh/cmd/pi-status-extension.ts cmd/wsh/cmd/pi-status-extension.test.ts scripts/cdp/scenarios.mjs
npx eslint frontend/app/view/agents cmd/wsh/cmd/pi-status-extension.ts cmd/wsh/cmd/pi-status-extension.test.ts scripts/cdp/scenarios.mjs
```

Expected: no errors in touched files. Ignore unrelated pre-existing lint configuration references documented in repository guidance.

- [ ] **Step 6: Run live Pi and CDP verification**

With the dev app running, run:

```powershell
wsh install-agent-hooks
pi "report your state, run one read-only tool, then settle"
pi --mode json --no-session --no-extensions "reply with pong"
task verify:ui -- surface-smoke usage-charts harness-picker
```

Verify working then idle live state, exact Pi title/provider/model, native transcript discovery, complete active-branch projection, usage, `OpenCode`/`Pi` marks, and no consult session pollution. Invoke `wsh ask` from a Pi workflow fixture and confirm the existing `agent:ask` overlay shows asking and clears without any inferred status transition.

- [ ] **Step 7: Verify exact resume and missing-file behavior**

Copy a disposable native session into a path containing spaces, then resume it:

```powershell
$sessions = @(Get-ChildItem -LiteralPath "$HOME\.pi\agent\sessions" -Filter "*.jsonl" -Recurse)
$session = $sessions[0]
if ($null -eq $session) { throw "No Pi session available for resume verification" }
$resumeParent = $env:TEMP
if (-not (Test-Path -LiteralPath $resumeParent)) { throw "Temp parent does not exist: $resumeParent" }
$resumeDir = Join-Path $resumeParent "wave pi resume"
New-Item -ItemType Directory -Path $resumeDir -Force | Out-Null
$resumePath = Join-Path $resumeDir "session copy.jsonl"
Copy-Item -LiteralPath $session.FullName -Destination $resumePath -Force
pi --session $resumePath
```

Launch the same session from Sessions and verify the terminal receives one path argument. Remove only a disposable fixture session, attempt its saved cockpit resume, and verify Wave surfaces the launch/preflight failure rather than substituting `--session-id` or a fresh generic launch.

- [ ] **Step 8: Final self-review checkpoint**

Run `git status --short` and `git diff --check`, then inspect the complete diff for generated-file provenance, remote asset URLs, lowercase visible OpenCode labels, debug output, and unrelated changes. Do not alter pre-existing `.gitignore` or `frontend/app/view/agents/filessurface.tsx` changes, and do not commit or push without explicit authorization.
