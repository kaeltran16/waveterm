# Agents Tab — Live Output & Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Agents tab into a height-filling column of live per-agent output panels (narration prominent, tool plumbing suppressed), fed by a new streaming transcript RPC backed by an fsnotify offset-tail watcher.

**Architecture:** A new server streaming RPC (`StreamAgentTranscriptCommand`) tails each agent's transcript JSONL incrementally (byte offset + fsnotify on the project dir) and pushes new lines. The frontend opens one stream per visible working panel, accumulates lines, projects them with the existing `projectTranscript` (reasoning vs. action vs. output, the seam stays unchanged), and renders them. Asking agents reuse the existing `AskCard` unchanged. The session sidebar is the roster and is untouched.

**Tech Stack:** Go (wshrpc streaming RPC, `fsnotify`), TypeScript/React, Jotai atoms, vitest, Go `testing`. Spec: `docs/specs/2026-06-19-agents-tab-triage-design.md`. Visual source of truth: `docs/specs/assets/2026-06-19-agents-tab-triage/`.

**Commits (repo owner's git rules override the skill default):** Do **NOT** auto-commit per task. Each task ends with a **Checkpoint** step: run the task's tests, then `git add` the touched files. After all tasks pass, present **one batched commit** (files + `type(scope): description` message) for explicit approval. The final task covers this.

**Codegen note:** `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, and `pkg/wshrpc/wshclient/wshclient.go` are generated. Never edit them by hand — edit `pkg/wshrpc/wshrpctypes.go` and run `task generate`. Do not run `go build`; VSCode problems indicate compile errors.

---

## File structure

**Backend (Go)**
- `pkg/wshrpc/wshrpctypes.go` — add `CommandStreamAgentTranscriptData`, `AgentTranscriptUpdate`, and the `StreamAgentTranscriptCommand` interface method (Task 2).
- `pkg/wshrpc/wshserver/transcript.go` — add the pure `transcriptTailer` (Task 1) and the `streamTranscript` watcher loop (Task 3). Reuses existing `readTranscriptTail`.
- `pkg/wshrpc/wshserver/transcript_test.go` — new; tailer + stream tests (Tasks 1, 3).
- `pkg/wshrpc/wshserver/wshserver.go` — add the `StreamAgentTranscriptCommand` method (Task 3).

**Frontend (TS/React)** — all under `frontend/app/view/agents/`
- `projectname.ts` + `projectname.test.ts` — derive a friendly project label from a transcript path (Task 4).
- `agentsviewmodel.ts` + `agentsviewmodel.test.ts` — add `outputPanelOrder` (Task 5).
- `livetranscript.ts` — stream controller + `liveEntriesByIdAtom` / `lastActivityByIdAtom` (Task 6).
- `narrationtimeline.ts`x — shared `NarrationTimeline` component extracted from `askcard.tsx`'s `PreviousInfo` (Task 7).
- `askcard.tsx` — `PreviousInfo` re-points to `NarrationTimeline` (Task 7).
- `outputpanel.tsx` — new `WorkingPanel` component (Task 8).
- `agents.tsx` — rework `AgentsView` to the panel column + stream lifecycle (Task 9).
- `agentrows.tsx` — deleted (its `WorkingRow`/`IdleRow` are superseded) (Task 9).

---

### Task 1: Pure transcript tailer (byte-offset + partial-line buffer)

**Files:**
- Modify: `pkg/wshrpc/wshserver/transcript.go`
- Test: `pkg/wshrpc/wshserver/transcript_test.go` (create)

- [ ] **Step 1: Write the failing test**

Create `pkg/wshrpc/wshserver/transcript_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func appendFile(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("append: %v", err)
	}
}

func TestTranscriptTailer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	writeFile(t, path, "a\nb\n")
	tl := &transcriptTailer{}

	got, err := tl.readNew(path)
	if err != nil {
		t.Fatalf("readNew: %v", err)
	}
	if !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("initial: got %v", got)
	}

	// no change -> no lines
	got, _ = tl.readNew(path)
	if len(got) != 0 {
		t.Fatalf("no-change: got %v", got)
	}

	// partial line buffered until its newline arrives, then joined
	appendFile(t, path, "c")
	got, _ = tl.readNew(path)
	if len(got) != 0 {
		t.Fatalf("partial: expected none, got %v", got)
	}
	appendFile(t, path, "d\n")
	got, _ = tl.readNew(path)
	if !reflect.DeepEqual(got, []string{"cd"}) {
		t.Fatalf("join: got %v", got)
	}

	// truncation resets the offset
	writeFile(t, path, "x\n")
	got, _ = tl.readNew(path)
	if !reflect.DeepEqual(got, []string{"x"}) {
		t.Fatalf("truncate: got %v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from project root): `go test ./pkg/wshrpc/wshserver/ -run TestTranscriptTailer -v`
Expected: FAIL — `undefined: transcriptTailer`.

- [ ] **Step 3: Write the tailer**

Append to `pkg/wshrpc/wshserver/transcript.go` (add `"io"` to the imports — `os`, `strings` are already imported):

```go
// transcriptTailer reads only the lines appended to a file since the last call.
// It buffers a partial (non-newline-terminated) trailing line until its newline
// arrives, and resets on truncation/rotation (size shrinks below the read offset).
// The transcript is append-only JSONL; the projection tolerates the rare malformed
// line, so this stays deliberately simple.
type transcriptTailer struct {
	offset  int64
	partial []byte
}

func (t *transcriptTailer) readNew(path string) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	size := info.Size()
	if size < t.offset {
		t.offset = 0
		t.partial = nil
	}
	if size == t.offset {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	t.offset = size
	buf := append(t.partial, data...)
	var lines []string
	start := 0
	for i := 0; i < len(buf); i++ {
		if buf[i] != '\n' {
			continue
		}
		line := strings.TrimRight(string(buf[start:i]), "\r")
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
		start = i + 1
	}
	t.partial = append([]byte(nil), buf[start:]...)
	return lines, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestTranscriptTailer -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run the test above (PASS), then stage: `git add pkg/wshrpc/wshserver/transcript.go pkg/wshrpc/wshserver/transcript_test.go`

---

### Task 2: Streaming RPC types + interface + codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface near `:92`; types after `:575`)
- Generated (do not hand-edit): `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`

- [ ] **Step 1: Add the interface method**

In `pkg/wshrpc/wshrpctypes.go`, directly below the existing `GetAgentTranscriptCommand` interface line (`:92`), add:

```go
	StreamAgentTranscriptCommand(ctx context.Context, data CommandStreamAgentTranscriptData) chan RespOrErrorUnion[AgentTranscriptUpdate] // stream the transcript tail; new lines pushed as appended
```

- [ ] **Step 2: Add the data types**

In `pkg/wshrpc/wshrpctypes.go`, directly after `CommandGetAgentTranscriptRtnData` (`:575`), add:

```go
type CommandStreamAgentTranscriptData struct {
	Path      string `json:"path"`
	TailLines int    `json:"taillines,omitempty"`
}

type AgentTranscriptUpdate struct {
	Lines []string `json:"lines"`
}
```

- [ ] **Step 3: Generate clients**

Run (from project root): `task generate`
Expected: completes without error.

- [ ] **Step 4: Verify generation**

Run: `grep -n "StreamAgentTranscriptCommand" frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts`
Expected: `wshclientapi.ts` shows a method returning `AsyncGenerator<AgentTranscriptUpdate, void, boolean>`; `gotypes.d.ts` shows `type AgentTranscriptUpdate = { lines: string[] }` and `type CommandStreamAgentTranscriptData = { path: string; taillines?: number }`.

> Note: until Task 3 implements the method on `WshServer`, VSCode will flag `*WshServer` as not satisfying the interface. That's expected and resolves in Task 3.

- [ ] **Step 5: Checkpoint**

Confirm VSCode shows no errors except the expected "WshServer does not implement" one, then stage: `git add pkg/wshrpc/wshrpctypes.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go`

---

### Task 3: Server streaming impl (fsnotify watcher loop)

**Files:**
- Modify: `pkg/wshrpc/wshserver/transcript.go` (add `streamTranscript`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (add the `StreamAgentTranscriptCommand` method)
- Test: `pkg/wshrpc/wshserver/transcript_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/wshrpc/wshserver/transcript_test.go` (add imports `"context"`, `"time"`, and `"github.com/wavetermdev/waveterm/pkg/wshrpc"`):

```go
func TestStreamTranscript(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, `{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`+"\n")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := make(chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate], 16)
	done := make(chan struct{})
	go func() {
		_ = streamTranscript(ctx, path, 100, ch)
		close(done)
	}()

	// backlog chunk
	select {
	case msg := <-ch:
		if msg.Error != nil || len(msg.Response.Lines) != 1 {
			t.Fatalf("backlog: %+v", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for backlog")
	}

	// append -> incremental chunk
	appendFile(t, path, `{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}`+"\n")
	select {
	case msg := <-ch:
		if msg.Error != nil || len(msg.Response.Lines) != 1 {
			t.Fatalf("increment: %+v", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for increment")
	}

	// cancel -> loop returns
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("streamTranscript did not return after cancel")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestStreamTranscript -v`
Expected: FAIL — `undefined: streamTranscript`.

- [ ] **Step 3: Implement `streamTranscript`**

Append to `pkg/wshrpc/wshserver/transcript.go` (add imports: `"context"`, `"fmt"` already present, `"log"`, `"path/filepath"`, `"github.com/fsnotify/fsnotify"`, `"github.com/wavetermdev/waveterm/pkg/wshrpc"`):

```go
// streamTranscript emits the transcript backlog (last tailLines) then watches the
// containing directory and pushes newly-appended lines as they arrive. Returns when
// ctx is cancelled or on a fatal error (the caller forwards the error onto the channel).
func streamTranscript(ctx context.Context, path string, tailLines int, ch chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]) error {
	if path == "" {
		return fmt.Errorf("transcript path is required")
	}
	if tailLines <= 0 {
		tailLines = defaultTranscriptTailLines
	}
	tailer := &transcriptTailer{}
	backlog, err := tailer.readNew(path)
	if err != nil {
		return fmt.Errorf("reading transcript: %w", err)
	}
	if len(backlog) > tailLines {
		backlog = backlog[len(backlog)-tailLines:]
	}
	ch <- wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]{Response: wshrpc.AgentTranscriptUpdate{Lines: backlog}}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("creating watcher: %w", err)
	}
	defer watcher.Close()
	if err := watcher.Add(filepath.Dir(path)); err != nil {
		return fmt.Errorf("watching transcript dir: %w", err)
	}
	target := filepath.Clean(path)
	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-watcher.Events:
			if !ok {
				return nil
			}
			if filepath.Clean(event.Name) != target {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			lines, err := tailer.readNew(path)
			if err != nil {
				log.Printf("transcript tail read: %v\n", err)
				continue
			}
			if len(lines) == 0 {
				continue
			}
			ch <- wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]{Response: wshrpc.AgentTranscriptUpdate{Lines: lines}}
		case werr, ok := <-watcher.Errors:
			if !ok {
				return nil
			}
			log.Printf("transcript watcher error: %v\n", werr)
		}
	}
}
```

- [ ] **Step 4: Add the RPC method**

In `pkg/wshrpc/wshserver/wshserver.go`, directly after `GetAgentTranscriptCommand` (`:1407`), add (the `StreamTestCommand` at `:103` is the pattern):

```go
func (ws *WshServer) StreamAgentTranscriptCommand(ctx context.Context, data wshrpc.CommandStreamAgentTranscriptData) chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate] {
	ch := make(chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate], 16)
	go func() {
		defer func() {
			panichandler.PanicHandler("StreamAgentTranscriptCommand", recover())
		}()
		defer close(ch)
		if err := streamTranscript(ctx, data.Path, data.TailLines, ch); err != nil {
			ch <- wshutil.RespErr[wshrpc.AgentTranscriptUpdate](err)
		}
	}()
	return ch
}
```

Verify `panichandler` and `wshutil` are already imported in `wshserver.go` (they are — used throughout). The "WshServer does not implement" error from Task 2 should now clear.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run 'TestStreamTranscript|TestTranscriptTailer' -v`
Expected: PASS (both).

- [ ] **Step 6: Checkpoint**

Confirm no VSCode errors, tests PASS, then stage: `git add pkg/wshrpc/wshserver/transcript.go pkg/wshrpc/wshserver/transcript_test.go pkg/wshrpc/wshserver/wshserver.go`

---

### Task 4: Project-name derivation (pure)

**Files:**
- Create: `frontend/app/view/agents/projectname.ts`
- Test: `frontend/app/view/agents/projectname.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/projectname.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { projectNameFromTranscriptPath } from "./projectname";

describe("projectNameFromTranscriptPath", () => {
    it("derives the repo name from the encoded cwd dir", () => {
        const p = "/home/u/.claude/projects/C--Users-kael02-IdeaProjects-waveterm/abc.jsonl";
        expect(projectNameFromTranscriptPath(p)).toBe("waveterm");
    });
    it("handles backslash paths", () => {
        const p = "C:\\Users\\u\\.claude\\projects\\C--Users-kael02-IdeaProjects-cyber_anomaly_detector\\x.jsonl";
        expect(projectNameFromTranscriptPath(p)).toBe("cyber_anomaly_detector");
    });
    it("returns empty for paths without a projects segment", () => {
        expect(projectNameFromTranscriptPath("/tmp/foo.jsonl")).toBe("");
        expect(projectNameFromTranscriptPath("")).toBe("");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from project root): `npx vitest run frontend/app/view/agents/projectname.test.ts`
Expected: FAIL — cannot resolve `./projectname`.

- [ ] **Step 3: Implement**

Create `frontend/app/view/agents/projectname.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Claude Code stores transcripts at <home>/.claude/projects/<encoded-cwd>/<id>.jsonl,
// where <encoded-cwd> is the working directory with path separators replaced by '-'.
// The friendly project label is the last '-' segment (the repo dir). Best-effort: a
// repo dir containing a literal '-' will be clipped to its final token (display only).
export function projectNameFromTranscriptPath(path: string): string {
    if (!path) {
        return "";
    }
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    const projIdx = parts.lastIndexOf("projects");
    if (projIdx < 0 || projIdx + 1 >= parts.length) {
        return "";
    }
    const segs = parts[projIdx + 1].split("-").filter(Boolean);
    return segs[segs.length - 1] ?? "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/projectname.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint**

Stage: `git add frontend/app/view/agents/projectname.ts frontend/app/view/agents/projectname.test.ts`

---

### Task 5: Output-panel ordering (pure)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/agentsviewmodel.test.ts` (import `outputPanelOrder` alongside the existing imports from `./agentsviewmodel`):

```ts
describe("outputPanelOrder", () => {
    const mk = (id: string, state: AgentState, n: number): AgentVM =>
        ({ id, name: id, task: "", state, blockedMs: n, activeMs: n }) as AgentVM;

    it("orders asking-first then working, excludes idle", () => {
        const agents = [
            mk("w1", "working", 100),
            mk("idle1", "idle", 0),
            mk("ask1", "asking", 50),
            mk("w2", "working", 300),
        ];
        const out = outputPanelOrder(agents).map((a) => a.id);
        expect(out).toEqual(["ask1", "w2", "w1"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `outputPanelOrder` is not exported.

- [ ] **Step 3: Implement**

Append to `frontend/app/view/agents/agentsviewmodel.ts` (reuses the existing `sortAgents`):

```ts
/** Pure: the agents to render as output panels — asking → working (sortAgents order),
 *  idle excluded (idle agents live in the sidebar, not this view). */
export function outputPanelOrder(agents: AgentVM[]): AgentVM[] {
    return sortAgents(agents).filter((a) => a.state !== "idle");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Checkpoint**

Stage: `git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts`

---

### Task 6: Live transcript stream controller + atoms

**Files:**
- Create: `frontend/app/view/agents/livetranscript.ts`
- Test: `frontend/app/view/agents/transcriptprojection.test.ts` (append a guard test)

This is integration glue over the generated RPC; its pure core (`projectTranscript`) is already unit-tested, so the controller itself is verified live in Task 10. We add one guard test for the `thinking`-skip behavior the controller relies on (spec §5).

- [ ] **Step 1: Add the `thinking`-skip guard test**

Append to `frontend/app/view/agents/transcriptprojection.test.ts` (import `projectTranscript` is already imported there):

```ts
describe("projectTranscript thinking blocks", () => {
    it("skips assistant thinking blocks (internal chain-of-thought is not narration)", () => {
        const lines = [
            JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "secret reasoning" }] } }),
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "visible narration" }] } }),
        ];
        const entries = projectTranscript(lines);
        expect(entries).toEqual([{ kind: "message", text: "visible narration" }]);
    });
});
```

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: PASS — `projectTranscript` only matches `text`/`tool_use`/`tool_result`, so `thinking` is already skipped. This is a regression guard (green immediately), not red-green TDD; it locks the spec §5 behavior so a future change can't leak `thinking` into the narration.

- [ ] **Step 2: Implement the controller**

Create `frontend/app/view/agents/livetranscript.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Live narration for working agents: opens StreamAgentTranscriptCommand per visible
// agent, accumulates raw JSONL lines, and projects them with projectTranscript (the
// unchanged seam) into liveEntriesByIdAtom. lastActivityByIdAtom stamps each chunk for
// the liveness cue. The open stream IS the subscription — stopTranscriptStream cancels
// the generator, which cancels the backend ctx and tears down the fsnotify watcher.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentEntry } from "./agentsviewmodel";
import { projectTranscript } from "./transcriptprojection";

const STREAM_TAIL_LINES = 300;

export const liveEntriesByIdAtom = atom<Record<string, AgentEntry[]>>({}) as PrimitiveAtom<Record<string, AgentEntry[]>>;
export const lastActivityByIdAtom = atom<Record<string, number>>({}) as PrimitiveAtom<Record<string, number>>;

interface StreamHandle {
    stop: () => void;
}
const streams = new Map<string, StreamHandle>();

export function startTranscriptStream(id: string, path: string): void {
    if (!path || streams.has(id)) {
        return;
    }
    const gen = RpcApi.StreamAgentTranscriptCommand(TabRpcClient, { path, taillines: STREAM_TAIL_LINES }, null);
    let cancelled = false;
    streams.set(id, {
        stop: () => {
            cancelled = true;
            void gen.return?.(undefined);
        },
    });
    const lines: string[] = [];
    void (async () => {
        try {
            for await (const chunk of gen) {
                if (cancelled) {
                    break;
                }
                if (!chunk?.lines?.length) {
                    continue;
                }
                lines.push(...chunk.lines);
                const entries = projectTranscript(lines);
                globalStore.set(liveEntriesByIdAtom, { ...globalStore.get(liveEntriesByIdAtom), [id]: entries });
                globalStore.set(lastActivityByIdAtom, { ...globalStore.get(lastActivityByIdAtom), [id]: Date.now() });
            }
        } catch {
            // stream ended or errored — keep the last entries, just stop updating
        } finally {
            streams.delete(id);
        }
    })();
}

export function stopTranscriptStream(id: string): void {
    const handle = streams.get(id);
    if (!handle) {
        return;
    }
    handle.stop();
    streams.delete(id);
}
```

- [ ] **Step 3: Verify it compiles**

Confirm VSCode shows no errors in `livetranscript.ts` (the generated `StreamAgentTranscriptCommand` from Task 2 must resolve).

- [ ] **Step 4: Checkpoint**

Run the guard test (PASS), then stage: `git add frontend/app/view/agents/livetranscript.ts frontend/app/view/agents/transcriptprojection.test.ts`

---

### Task 7: Extract the shared NarrationTimeline component

**Files:**
- Create: `frontend/app/view/agents/narrationtimeline.tsx`
- Modify: `frontend/app/view/agents/askcard.tsx` (re-point `PreviousInfo`)

- [ ] **Step 1: Create the shared component**

Create `frontend/app/view/agents/narrationtimeline.tsx` (this is the current `PreviousInfo` body, plus an optional `accentLatest` that highlights the newest message — the green left-border treatment from mockup 01):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import type { AgentEntry } from "./agentsviewmodel";

// Reasoning (message) entries render as prose; action entries render as a dim
// monospace verb/target strip. tool_result content is never present here (the
// projection discards it). With accentLatest, the newest message is highlighted.
export function NarrationTimeline({
    entries,
    accentLatest,
    className,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    className?: string;
}) {
    let lastMessageIdx = -1;
    if (accentLatest) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].kind === "message") {
                lastMessageIdx = i;
                break;
            }
        }
    }
    return (
        <div className={cn("leading-relaxed", className)}>
            {entries.map((e, i) =>
                e.kind === "message" ? (
                    <div
                        key={i}
                        className={cn(
                            "mt-2.5 text-[13px]",
                            i === lastMessageIdx ? "border-l-2 border-[#3fb950] pl-2 text-[#f0f6fc]" : "text-[#dde3ea]"
                        )}
                    >
                        {e.text}
                    </div>
                ) : (
                    <div
                        key={i}
                        className="my-2.5 border-l-2 border-[#2a2f3a] pl-3.5 font-mono text-[12px] leading-7 text-[#7d8896]"
                    >
                        <span className="inline-block w-14 text-[#9aa4b2]">{e.verb}</span>
                        {e.target}
                        {e.note ? <span className="text-[#6b7585]"> ({e.note})</span> : null}
                        {e.outcome === "ok" ? <span className="text-[#3fb950]"> ✓</span> : null}
                        {e.outcome === "fail" ? <span className="text-[#f85149]"> ✗</span> : null}
                    </div>
                )
            )}
        </div>
    );
}
```

- [ ] **Step 2: Re-point `PreviousInfo` in `askcard.tsx`**

In `frontend/app/view/agents/askcard.tsx`, replace the `PreviousInfo` function (lines `8-28`) with a thin wrapper, and add the import:

```tsx
import { NarrationTimeline } from "./narrationtimeline";
```
```tsx
function PreviousInfo({ entries }: { entries: AgentEntry[] }) {
    return <NarrationTimeline entries={entries} className="mt-2.5 max-w-[80ch]" />;
}
```

Leave the rest of `askcard.tsx` unchanged (the asking card stays one-shot per spec §3). Remove the now-unused `cn` import only if eslint flags it as unused (it is still used elsewhere in the file — leave it).

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` (from project root)
Expected: no new type errors. Confirm VSCode shows no errors in `askcard.tsx` / `narrationtimeline.tsx`.

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/view/agents/narrationtimeline.tsx frontend/app/view/agents/askcard.tsx`

---

### Task 8: WorkingPanel component (live narration + auto-scroll + liveness)

**Files:**
- Create: `frontend/app/view/agents/outputpanel.tsx`

- [ ] **Step 1: Implement the panel**

Create `frontend/app/view/agents/outputpanel.tsx` (matches mockup 01: header with dot/name/project·task, `model · elapsed · ⟳ since`, "Open terminal"; flex-1 body that scrolls internally and sticks to the latest line unless the user scrolled up):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { formatAge, type AgentVM } from "./agentsviewmodel";
import { liveEntriesByIdAtom, lastActivityByIdAtom } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { projectNameFromTranscriptPath } from "./projectname";

function formatSince(ms: number): string {
    if (ms < 60_000) {
        return `${Math.max(1, Math.floor(ms / 1000))}s`;
    }
    return `${Math.floor(ms / 60_000)}m`;
}

export function WorkingPanel({ agent, now, onOpen }: { agent: AgentVM; now: number; onOpen: (id: string) => void }) {
    const liveEntries = useAtomValue(liveEntriesByIdAtom);
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const entries = liveEntries[agent.id] ?? agent.previousInfo ?? [];
    const since = lastActivity[agent.id] != null ? formatSince(Math.max(0, now - lastActivity[agent.id])) : null;
    const project = projectNameFromTranscriptPath(agent.transcriptPath);

    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [entries]);
    const onScroll = () => {
        const el = scrollRef.current;
        if (el) {
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }
    };

    return (
        <div className="flex min-h-[140px] flex-1 flex-col overflow-hidden rounded-[9px] border border-[#1c2230] bg-[#0b0e14]">
            <div className="flex shrink-0 items-center gap-2.5 border-b border-[#1c2230] px-[14px] py-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-[#3fb950]" />
                <b className="text-[13px] text-[#e6edf3]">{agent.name}</b>
                <span className="truncate text-[11.5px] text-[#6b7585]">
                    {project ? `${project} · ` : ""}
                    {agent.task}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-[#7d8896]">
                    {agent.model ? `${agent.model} · ` : ""}
                    {formatAge(agent.activeMs)}
                    {since ? ` · ⟳ ${since}` : ""}
                </span>
                <button
                    type="button"
                    onClick={() => onOpen(agent.id)}
                    className="shrink-0 cursor-pointer rounded-[5px] border border-[#2c3340] px-2.5 py-0.5 text-[10.5px] text-[#c9d1d9] hover:bg-white/[0.04]"
                >
                    Open terminal
                </button>
            </div>
            <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-[14px] py-[11px]">
                <NarrationTimeline entries={entries} accentLatest />
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm no VSCode errors in `outputpanel.tsx`.

- [ ] **Step 3: Checkpoint**

Stage: `git add frontend/app/view/agents/outputpanel.tsx`

---

### Task 9: Rework AgentsView into the panel column + stream lifecycle

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`
- Delete: `frontend/app/view/agents/agentrows.tsx`

- [ ] **Step 1: Replace the `AgentsView` component**

In `frontend/app/view/agents/agents.tsx`, replace the imports of `IdleRow, WorkingRow` and `groupAgents` and the `AgentsView` function body. New imports block (keep the existing `AskCard`, store, jotai, util imports):

```tsx
import { useEffect, useRef, useState } from "react";
import { AskCard } from "./askcard";
import { askingCount, outputPanelOrder, type AgentVM } from "./agentsviewmodel";
import { ensurePreviousInfo, liveAgentsAtom } from "./liveagents";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { WorkingPanel } from "./outputpanel";
```

New `AgentsView` (delete `SectionLabel` if unused; the header keeps the existing count summary):

```tsx
function AgentsView({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const ordered = outputPanelOrder(agents);
    const asking = askingCount(agents);
    const working = ordered.filter((a) => a.state === "working").length;
    const open = (id: string) => setActiveTab(id);
    const answer = (oref: string, answers: AgentAnswerItem[]) => {
        if (!oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers }));
    };

    // 1s tick so the liveness cue (⟳ since) stays current without a global ticker
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // one-shot previous-info for asking agents (unchanged, spec §3)
    useEffect(() => {
        for (const a of agents) {
            if (a.state === "asking" && a.transcriptPath) {
                void ensurePreviousInfo(a.id, a.transcriptPath);
            }
        }
    }, [agents]);

    // open a live transcript stream per visible working agent; stop streams that left the set
    const streamedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const wantedById = new Map<string, string>();
        for (const a of ordered) {
            if (a.state === "working" && a.transcriptPath) {
                wantedById.set(a.id, a.transcriptPath);
            }
        }
        for (const [id, path] of wantedById) {
            if (!streamedRef.current.has(id)) {
                startTranscriptStream(id, path);
                streamedRef.current.add(id);
            }
        }
        for (const id of [...streamedRef.current]) {
            if (!wantedById.has(id)) {
                stopTranscriptStream(id);
                streamedRef.current.delete(id);
            }
        }
    }, [ordered]);

    useEffect(() => {
        return () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
            }
            streamedRef.current.clear();
        };
    }, []);

    return (
        <div className="flex h-full w-full flex-col bg-[#0b0e14] text-[#c9d1d9]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3">
                <b className="text-[15px] text-[#e6edf3]">Agents</b>
                <span className="text-[12px] text-[#6b7585]">
                    <span className="text-[#d29922]">{asking} asking</span> · {working} working
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-[18px]">
                {ordered.length === 0 && (
                    <div className="px-0.5 py-6 text-[13px] text-[#6b7585]">No active agents</div>
                )}
                {ordered.map((a) =>
                    a.state === "asking" ? (
                        <div key={a.ask?.askId ?? a.id} className="shrink-0">
                            <AskCard agent={a} onAnswer={answer} onOpen={open} />
                        </div>
                    ) : (
                        <WorkingPanel key={a.id} agent={a} now={now} onOpen={open} />
                    )
                )}
            </div>
        </div>
    );
}
```

> Note on sizing (spec §8): the column is `flex flex-col`; `WorkingPanel` is `flex-1 min-h-[140px]` so working panels share leftover height, while the asking `AskCard` is wrapped in `shrink-0` so it keeps its natural height. With many agents, `min-h-[140px]` forces the column to scroll.

- [ ] **Step 2: Delete the superseded rows file**

Run: `git rm frontend/app/view/agents/agentrows.tsx`
(Its `WorkingRow`/`IdleRow` are replaced by `WorkingPanel`; idle agents are no longer rendered here.)

- [ ] **Step 3: Verify the view compiles and pure tests still pass**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors (no remaining references to `agentrows`, `groupAgents`, `IdleRow`, `WorkingRow`).
Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS.

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/view/agents/agents.tsx` (the `git rm` already stages the deletion).

---

### Task 10: Live walkthrough verification

**Files:** none (verification only). Uses the dev app + CDP per the team's verification flow (`memory/cdp-verify-dev-app.md`).

- [ ] **Step 1: Rebuild backend + relaunch dev app**

Run: `task build:wsh` and rebuild/relaunch the dev app so the new `StreamAgentTranscriptCommand` and the `--transcript`-carrying status are live (Windows packaging caveats: `memory/windows-package-build-gotchas.md`).

- [ ] **Step 2: Drive a real agent and observe**

Start a Claude agent in a project, open the Agents tab. Verify against mockup 01 (`docs/specs/assets/2026-06-19-agents-tab-triage/01-full-height-output.html`):
- A working agent renders a panel whose body shows its **narration** (assistant prose), with tool calls as thin `verb target ✓/✗` lines and **no** command output / diffs.
- New narration appends live and the panel **sticks to the latest line**; scrolling up and waiting shows it does **not** yank back.
- Header shows `model · elapsed · ⟳ <since>`; `⟳` advances each second; "Open terminal" jumps to the session.
- An asking agent renders the amber `AskCard` first (above working panels) with its question + answer pills; answering from the panel still resolves (dual-answer unaffected).
- Panels flex to share the tab height; idle agents do not appear (they remain in the sidebar).

- [ ] **Step 3: Verify watcher teardown**

Close the Agents tab (or let an agent go idle so its panel unmounts). Confirm in the wavesrv log that the stream goroutine returns (no leaked watchers) — the `StreamAgentTranscriptCommand` goroutine should exit on ctx cancel.

- [ ] **Step 4: Record results**

Note PASS/FAIL per check (screenshots optional) in the session notes.

---

### Task 11: Batched commit (approval-gated)

Per the repo owner's git rules — no auto-commit; one batched commit, explicit approval.

- [ ] **Step 1: Show the diff summary**

Run: `git status` and `git diff --staged --stat`
Present the file list (M/A/D + one-line summary each) and the proposed message:

```
feat(agents): live narration output panels via streaming transcript RPC
```

- [ ] **Step 2: Get approval**

Ask the owner: "Awaiting approval. Proceed with the commit? (yes/no)". Only on explicit "yes":

```bash
git commit -m "feat(agents): live narration output panels via streaming transcript RPC"
```

Do not push unless separately asked.
