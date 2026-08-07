# opencode Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give opencode full cockpit parity with Claude Code and Codex: launch, `@opencode` consult, resumable sessions, a live roster row with narration, and storage-derived cost/token usage.

**Architecture:** opencode rides every existing per-agent seam. The launch catalog (`launch.ts`), consult specs (`pkg/consult`), sessions scanner (`pkg/agentsessions`), transcript projector registry, and the `wsh agent-hook` status reporter each gain an `opencode` entry. The one genuinely new piece is a live-roster plugin: opencode has no lifecycle-hook contract, so a small Bun plugin (installed into `~/.config/opencode/plugins/` by `wsh install-agent-hooks`) translates opencode events into the existing `wsh agent-hook` contract and writes a JSONL shadow transcript the cockpit streams unchanged.

**Tech Stack:** Go (`pkg/consult`, `pkg/agentsessions`, `cmd/wsh`), TypeScript/React (cockpit FE, Vitest), opencode plugin SDK (`@opencode-ai/plugin`, runs under Bun).

## Global Constraints

- The agent identity string is `"opencode"`; the binary is `opencode`. Never invent a second name (contrast `antigravity`/`agy`).
- opencode data root: `~/.local/share/opencode` (same path on Windows). Layout (verified 2026-08-07): `storage/session/<projectID>/<sessionID>.json` (session info), `storage/message/<sessionID>/<messageID>.json` (message meta incl. `role`, `model.{providerID,modelID}`), `storage/part/<messageID>/<partID>.json` (parts; `step-finish` parts carry `cost` + `tokens`; `tool` parts carry `state.{status,input.command,metadata.exit}`).
- Consult invokes `opencode run --format json`, whose output is **JSONL** (verified 2026-08-07): assistant text arrives as `{"type":"text",...,"part":{"type":"text","text":...}}` events; `step_start`/`step_finish`/reasoning/tool events carry no reply text and are skipped.
- Live roster: the opencode plugin must **no-op entirely outside a Wave block** — no shadow writes, no `wsh` spawns — when `WAVETERM_BLOCKID` or `WAVETERM_JWT` is absent.
- Shadow transcript: `~/.local/share/opencode/waveterm/<sessionID>.jsonl`, one JSON object per line (`session`/`user`/`assistant`/`tool`/`state` records). The filename stem IS the resume/session id.
- The `provider` abstraction in `pkg/agentsessions` is generalized to pass the transcript file path into `extract`/`events` (claude/codex ignore it) so opencode can resolve sibling `message`/`part` dirs; their underlying parser functions are NOT changed.
- No wshrpc/waveobj/wconfig type changes → **`task generate` is never run** in this plan.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows; `task check:ts` is unusable). Baseline is clean — any error belongs to this work.
- Go tests that touch `pkg/jarvisembed` dependents need the CGO wrapper; use it for all Go test commands:
  `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`
- Git: repo CLAUDE.md forbids commits without explicit user approval and says to batch into one commit at the end. The `git commit` step in each task is the plan's record of a natural checkpoint; **do not actually run `git commit` without the user's approval** — stage nothing either.
- Never `prettier --write` whole files except the ones already Prettier-formatted; hand-format additions to each file's existing style.
- Out of scope (do not build): `bgagents` background-lane parity; `syncstrip.tsx` and `cockpit-actions.ts` memory/lackey sync for opencode; the opencode brand logo asset (`runtimelogo.ts` returns `undefined`, channel avatars fall back to the colored initial); live context-%/plan gauges; `dailychart.ts`/window-token aggregates.

---

## Phase 1 — Launch + chrome

### Task 1: opencode launch catalog + resume args

**Files:**
- Modify: `frontend/app/view/agents/launch.ts`
- Test: `frontend/app/view/agents/launch.test.ts`

**Interfaces:**
- Produces: `Runtime` union gains `"opencode"`; `RUNTIME_CMD.opencode === "opencode"`; `RUNTIME_FLAGS.opencode`; `resumeArgsForOpencode(sessionId: string, baseArgs: string[]): string[]` → `["-s", sessionId, ...kept]`. `buildLaunchMeta` passes the opencode task positionally (no `-i` special case). `sessionIdFromTranscript` already returns the shadow filename stem, unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/app/view/agents/launch.test.ts`. In the `runtime helpers` describe, extend `derives the startup command`:

```ts
    it("derives the startup command", () => {
        expect(runtimeStartupCommand("claude")).toBe("claude");
        expect(runtimeStartupCommand("codex")).toBe("codex");
        expect(runtimeStartupCommand("opencode")).toBe("opencode");
        expect(runtimeStartupCommand("terminal")).toBe("");
    });
    it("catalogs opencode's boolean launch flags", () => {
        expect(RUNTIME_FLAGS.opencode.map((f) => f.flag)).toEqual(["--auto", "--pure", "-c"]);
        expect(composeStartupCommand("opencode", "opencode", { auto: true })).toBe("opencode --auto");
    });
```

Add a new describe block at the end of the file:

```ts
describe("resumeArgsForOpencode", () => {
    it("prepends -s <id> and keeps launch flags", () => {
        expect(resumeArgsForOpencode("s1", ["--auto"])).toEqual(["-s", "s1", "--auto"]);
    });
    it("preserves value-taking options (does not mistake the value for a prompt)", () => {
        expect(resumeArgsForOpencode("s1", ["--model", "openai/gpt-5"])).toEqual(["-s", "s1", "--model", "openai/gpt-5"]);
    });
    it("drops a prior -s <id> so resuming twice never stacks", () => {
        expect(resumeArgsForOpencode("s2", ["-s", "s1", "--auto"])).toEqual(["-s", "s2", "--auto"]);
        expect(resumeArgsForOpencode("s2", ["--session", "s1"])).toEqual(["-s", "s2"]);
    });
    it("drops -c/--continue to avoid a conflicting double-resume", () => {
        expect(resumeArgsForOpencode("s1", ["-c"])).toEqual(["-s", "s1"]);
        expect(resumeArgsForOpencode("s1", ["--continue"])).toEqual(["-s", "s1"]);
    });
    it("handles empty base args", () => {
        expect(resumeArgsForOpencode("s1", [])).toEqual(["-s", "s1"]);
    });
});
```

Update the `buildLaunchMeta` describe — add:

```ts
    it("passes the opencode task positionally with cwd", () => {
        const m = buildLaunchMeta({ runtime: "opencode", startupCommand: "opencode", task: "refactor auth", cwd: "/x" });
        expect(m).toMatchObject({ cmd: "opencode", "cmd:args": ["refactor auth"], "cmd:shell": false, "cmd:cwd": "/x" });
        expect(m["agent:baseargs"]).toEqual([]);
    });
```

Update the `resumeArgsForClaude` import list at the top to also import `resumeArgsForOpencode`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/launch.test.ts`
Expected: FAIL — `RUNTIME_FLAGS.opencode` is undefined, `runtimeStartupCommand("opencode")` returns `""`, `resumeArgsForOpencode` is not exported.

- [ ] **Step 3: Implement**

In `frontend/app/view/agents/launch.ts`, widen the union and the command map:

```ts
export type Runtime = "claude" | "codex" | "antigravity" | "opencode" | "terminal";

const RUNTIME_CMD: Record<Runtime, string> = {
    claude: "claude",
    codex: "codex",
    antigravity: "agy",
    opencode: "opencode",
    terminal: "",
};
```

In `RUNTIME_FLAGS`, add the opencode catalog (boolean flags only, matching the catalog's shape):

```ts
    opencode: [
        { id: "auto", flag: "--auto", desc: "Auto-approve non-denied permissions (dangerous)" },
        { id: "pure", flag: "--pure", desc: "Run without external plugins" },
        { id: "continue", flag: "-c", desc: "Resume the last session" },
    ],
```

After `resumeArgsForClaude`, add:

```ts
// Recompose an opencode launch as a resume: `opencode -s <id> <baseArgs>`. -s/--session resume a
// named session (a cockpit worker's session id is its shadow filename stem); -c resumes only the
// last session and is stripped like claude's --continue so a repeated resume cannot stack directives.
export function resumeArgsForOpencode(sessionId: string, baseArgs: string[]): string[] {
    const kept: string[] = [];
    for (let i = 0; i < baseArgs.length; i++) {
        const a = baseArgs[i];
        if (a === "-s" || a === "--session") {
            i++; // also skip its id value
            continue;
        }
        if (a === "-c" || a === "--continue") {
            continue;
        }
        kept.push(a);
    }
    return ["-s", sessionId, ...kept];
}
```

`buildLaunchMeta` needs no change for opencode: it is not `"terminal"` (so it is an agent) and not `"antigravity"` (so the task is a bare positional).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/launch.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Typecheck the workspace**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If any other file exhaustively switches on `Runtime`, widen its cases (the error message names it).

- [ ] **Step 6: Commit checkpoint**

```bash
git add frontend/app/view/agents/launch.ts frontend/app/view/agents/launch.test.ts
git commit -m "feat(agents): add opencode to the launch catalog and resume args"
```
(Subject to the repo Git rule in Global Constraints — do not run without approval.)

---

### Task 2: channel runtimes (`@opencode` dispatch + `ask @opencode`)

**Files:**
- Modify: `frontend/app/view/agents/channelmessages.ts`
- Modify: `frontend/app/view/agents/composercommand.ts`
- Test: `frontend/app/view/agents/channelmessages.test.ts`
- Test: `frontend/app/view/agents/composercommand.test.ts`

**Interfaces:**
- Consumes: `Runtime` union from Task 1.
- Produces: `RUNTIMES` includes `"opencode"` (channel dispatch + consult); `KNOWN_RUNTIMES` includes `"opencode"` (`@ask opencode …` runtime override).

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/agents/channelmessages.test.ts`, add:

```ts
    it("dispatches to opencode by leading mention", () => {
        expect(planMessage("@opencode fix the flaky test", [])).toEqual({
            kind: "dispatch",
            runtime: "opencode",
            text: "fix the flaky test",
        });
    });
    it("consults opencode after ask", () => {
        expect(planMessage("ask @opencode does this race?", [])).toEqual({
            kind: "consult",
            runtimes: ["opencode"],
            text: "does this race?",
        });
    });
```

In `frontend/app/view/agents/composercommand.test.ts`, add:

```ts
    it("accepts opencode as an @ask runtime override", () => {
        expect(parseComposerCommand("@ask opencode audit the auth path")).toEqual({
            mode: "ask",
            runtime: "opencode",
            body: "audit the auth path",
        });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts frontend/app/view/agents/composercommand.test.ts`
Expected: FAIL — `@opencode` parses as a plain post / unknown runtime.

- [ ] **Step 3: Implement**

`channelmessages.ts`:

```ts
const RUNTIMES: Runtime[] = ["claude", "codex", "antigravity", "opencode", "terminal"];
```

`composercommand.ts`:

```ts
const KNOWN_RUNTIMES = new Set(["claude", "codex", "antigravity", "opencode"]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts frontend/app/view/agents/composercommand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```bash
git add frontend/app/view/agents/channelmessages.ts frontend/app/view/agents/composercommand.ts frontend/app/view/agents/channelmessages.test.ts frontend/app/view/agents/composercommand.test.ts
git commit -m "feat(agents): route @opencode dispatch and ask @opencode consult"
```
(Subject to the repo Git rule.)

---

### Task 3: runtime chrome (pill, glyph, theme tokens)

**Files:**
- Modify: `frontend/app/view/agents/runtimemeta.ts`
- Modify: `frontend/tailwindsetup.css`
- Test: `frontend/app/view/agents/runtimemeta.test.ts`

**Interfaces:**
- Produces: `RuntimeMeta.id` union gains `"opencode"`; `runtimeMeta("opencode")` returns `{ id: "opencode", label: "opencode", glyph: "◇", … }`; Tailwind utilities `text-rt-opencode`, `bg-rt-opencode-soft`, `border-rt-opencode-line` exist via `--color-rt-opencode*` tokens.

- [ ] **Step 1: Write the failing test**

In `frontend/app/view/agents/runtimemeta.test.ts`, add to the existing `describe("runtimeMeta")`:

```ts
        expect(runtimeMeta("opencode").id).toBe("opencode");
        expect(runtimeMeta("opencode").label).toBe("opencode");
        expect(runtimeMeta("Opencode").id).toBe("opencode");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/runtimemeta.test.ts`
Expected: FAIL — `runtimeMeta("opencode").id` falls back to `"claude"`.

- [ ] **Step 3: Implement**

`runtimemeta.ts` — widen the id union and add the entry:

```ts
export interface RuntimeMeta {
    id: "claude" | "codex" | "opencode" | "terminal";
    ...
}
```

```ts
    opencode: {
        id: "opencode",
        label: "opencode",
        glyph: "◇",
        text: "text-rt-opencode",
        softBg: "bg-rt-opencode-soft",
        line: "border-rt-opencode-line",
    },
```

`frontend/tailwindsetup.css` — insert after the existing `--color-rt-codex-line` line (the three-line `--color-rt-codex*` block ends at line ~109):

```css
    --color-rt-opencode: #a78bfa;
    --color-rt-opencode-soft: rgba(167, 139, 250, 0.13);
    --color-rt-opencode-line: rgba(167, 139, 250, 0.34);
```

Also insert the provider-dot token in the "Provider brand identity" block (line ~72, beside `--color-provider-claude`/`--color-provider-codex`) — Task 5's `providerDot("opencode")` returns `bg-provider-opencode`, which resolves from this token:

```css
    --color-provider-opencode: #a78bfa;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/runtimemeta.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit checkpoint**

```bash
git add frontend/app/view/agents/runtimemeta.ts frontend/app/view/agents/runtimemeta.test.ts frontend/tailwindsetup.css
git commit -m "feat(agents): runtime chrome + theme tokens for opencode"
```
(Subject to the repo Git rule.)

---

### Task 4: resume-on-reopen for opencode

**Files:**
- Modify: `frontend/app/view/agents/session-models/agentresumestore.ts`
- Modify: `frontend/app/view/agents/session-models/agentstatusstore.ts`
- Test: `frontend/app/view/agents/session-models/agentresumestore.test.ts`

**Interfaces:**
- Consumes: `resumeArgsForOpencode` (Task 1).
- Produces: `shouldPersistResume(provider, rememberFlags)` (true for `claude` | `opencode`); `persistResume(oref, provider, transcriptPath)` (renamed from `persistClaudeResume`, same params); `agentstatusstore.ts` calls `persistResume`.

- [ ] **Step 1: Write the failing tests**

Replace the body of `frontend/app/view/agents/session-models/agentresumestore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldPersistResume } from "./agentresumestore";

describe("shouldPersistResume", () => {
    it("resumes a claude or opencode agent when Remember flags is on", () => {
        expect(shouldPersistResume("claude", true)).toBe(true);
        expect(shouldPersistResume("opencode", true)).toBe(true);
    });

    it("does not resume when Remember flags is off (user wants a clean slate)", () => {
        expect(shouldPersistResume("opencode", false)).toBe(false);
    });

    it("never resumes codex/antigravity/unknown providers", () => {
        expect(shouldPersistResume("codex", true)).toBe(false);
        expect(shouldPersistResume("antigravity", true)).toBe(false);
        expect(shouldPersistResume(undefined, true)).toBe(false);
    });

    it("matches the provider case-insensitively", () => {
        expect(shouldPersistResume("OpEnCoDe", true)).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/session-models/agentresumestore.test.ts`
Expected: FAIL — `shouldPersistResume` is not exported (and opencode is not persisted).

- [ ] **Step 3: Implement**

In `agentresumestore.ts`, replace the gate function and generalize the persister:

```ts
// Pure: resume-on-reopen is Claude- and opencode-only, gated on the user's "Remember flags" New
// Agent default. When that setting is off the user wants a clean slate, so the agent relaunches
// fresh on reopen; when on (the default) reopening reattaches to the live session. codex and
// antigravity always restart fresh.
export function shouldPersistResume(provider: string | undefined, rememberFlags: boolean): boolean {
    const p = (provider ?? "").toLowerCase();
    return (p === "claude" || p === "opencode") && rememberFlags === true;
}
```

```ts
// Bake the live session's resume key into the block's persisted cmd:args. Fire-and-forget: any
// failure just leaves the block to relaunch fresh (today's behavior), so callers ignore the result.
export async function persistResume(
    oref: string,
    provider: string | undefined,
    transcriptPath: string | undefined
): Promise<void> {
    if (!shouldPersistResume(provider, globalStore.get(naRememberFlagsAtom))) {
        return;
    }
    const sessionId = sessionIdFromTranscript(transcriptPath);
    if (!sessionId || bakedResumeId.get(oref) === sessionId) {
        return;
    }
    const block = WOS.getObjectValue<Block>(oref);
    const meta = block?.meta as Record<string, unknown> | undefined;
    if (!meta || meta["controller"] !== "cmd" || (meta["cmd"] !== "claude" && meta["cmd"] !== "opencode")) {
        return;
    }
    const baseArgs = meta["agent:baseargs"] as string[] | undefined;
    if (baseArgs == null) {
        return; // launched before resume support: relaunches fresh
    }
    const nextArgs =
        meta["cmd"] === "opencode"
            ? resumeArgsForOpencode(sessionId, baseArgs)
            : resumeArgsForClaude(sessionId, baseArgs);
    const curArgs = (meta["cmd:args"] as string[] | undefined) ?? [];
    if (sameArgs(nextArgs, curArgs)) {
        bakedResumeId.set(oref, sessionId);
        return;
    }
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, { oref, meta: { "cmd:args": nextArgs } });
        await WOS.reloadWaveObject(oref); // keep the cached block fresh for the next comparison
        bakedResumeId.set(oref, sessionId);
    } catch {
        // leave bakedResumeId unset so a later status retries
    }
}
```

Update the import line at the top to add `resumeArgsForOpencode`:

```ts
import { resumeArgsForClaude, resumeArgsForOpencode, sessionIdFromTranscript } from "../launch";
```

In `agentstatusstore.ts`, change the import and call site:

```ts
import { persistResume } from "./agentresumestore";
```

```ts
                void persistResume(data.oref, data.agent, data.transcriptpath);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/session-models/agentresumestore.test.ts frontend/app/view/agents/session-models/agentstatusstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (confirms no other caller of `persistClaudeResume`/`shouldPersistClaudeResume` remains).

- [ ] **Step 6: Commit checkpoint**

```bash
git add frontend/app/view/agents/session-models/agentresumestore.ts frontend/app/view/agents/session-models/agentresumestore.test.ts frontend/app/view/agents/session-models/agentstatusstore.ts
git commit -m "feat(agents): resume-on-reopen extends to opencode workers"
```
(Subject to the repo Git rule.)

---

### Task 5: launch UI + provider surfacing

**Files:**
- Modify: `frontend/app/view/agents/newagentmodal.tsx`
- Modify: `frontend/app/view/agents/settingssurface.tsx`
- Modify: `frontend/app/view/agents/agentsviewmodel.ts`
- Modify: `frontend/app/view/agents/cockpitrailmodel.ts`
- Modify: `frontend/app/view/agents/usagesurface.tsx`
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`
- Test: `frontend/app/view/agents/cockpitrailmodel.test.ts`

**Interfaces:**
- Consumes: `Runtime` union (Task 1).
- Produces: opencode appears in the New Agent runtime picker, the Settings flag editor, the usage-row sort rank, and the rail/usage provider labels.

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/agents/agentsviewmodel.test.ts`, in the `providerPlanUsage` describe, add:

```ts
        it("sorts opencode after codex", () => {
            const claude = mk("c", "working", { agent: "claude", usage: { fivehourpct: 10, weekpct: 10 } });
            const codex = mk("x", "working", { agent: "codex", usage: { fivehourpct: 10, weekpct: 10 } });
            const opencode = mk("o", "working", { agent: "opencode", usage: { fivehourpct: 10, weekpct: 10 } });
            const rows = providerPlanUsage([opencode, claude, codex]);
            expect(rows.map((r) => r.provider)).toEqual(["claude", "codex", "opencode"]);
        });
```

In `frontend/app/view/agents/cockpitrailmodel.test.ts`, extend the existing provider assertions:

```ts
        expect(providerLabel("opencode")).toBe("opencode");
        expect(providerDot("opencode")).toBe("bg-provider-opencode");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts frontend/app/view/agents/cockpitrailmodel.test.ts`
Expected: FAIL — `providerPlanUsage` puts opencode after claude by the default rank; `providerLabel("opencode")` returns `"opencode"` via the fallback (passes), `providerDot("opencode")` returns `"bg-muted"` (fails).

- [ ] **Step 3: Implement**

`agentsviewmodel.ts` — line ~402:

```ts
const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1, opencode: 2 };
```

`cockpitrailmodel.ts` — lines 10-11:

```ts
const PROVIDER_DOT: Record<string, string> = {
    claude: "bg-provider-claude",
    codex: "bg-provider-codex",
    opencode: "bg-provider-opencode",
};
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "opencode" };
```

`usagesurface.tsx` — line 31:

```ts
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "opencode" };
```

`newagentmodal.tsx` — line 35-40, add before `terminal`:

```ts
    { id: "opencode", name: "opencode", glyph: "◇" },
```

`settingssurface.tsx` — `FLAG_RUNTIMES` (~line 32), add:

```ts
    { id: "opencode", name: "opencode" },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts frontend/app/view/agents/cockpitrailmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit checkpoint**

```bash
git add frontend/app/view/agents/newagentmodal.tsx frontend/app/view/agents/settingssurface.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/cockpitrailmodel.ts frontend/app/view/agents/usagesurface.tsx frontend/app/view/agents/agentsviewmodel.test.ts frontend/app/view/agents/cockpitrailmodel.test.ts
git commit -m "feat(agents): surface opencode in the launch UI and provider labels"
```
(Subject to the repo Git rule.)

---

## Phase 2 — Consult

### Task 6: `opencode run` consult runtime

**Files:**
- Modify: `pkg/consult/consult.go`
- Test: `pkg/consult/consult_test.go`

**Interfaces:**
- Produces: `SpecFor("opencode")` → `{Bin: "opencode", BaseArgs: ["run", "--format", "json"], PromptViaStdin: false, ParseLine: opencodeParseLine}`; `SupportedRuntimes()` includes `"opencode"`; `ProbeInstalled("opencode")` works automatically (reads `runtimeSpecs`). Tiers leave opencode untouched (only claude has a `--model` contract).

- [ ] **Step 1: Write the failing tests**

In `pkg/consult/consult_test.go`:

- Extend `TestSpecFor_knownRuntimes` cases:

```go
		"opencode":    {"opencode", "run"},
```

- Extend `TestSpecFor_streamingModes` (add after the `agy` block):

```go
	opencode, _ := SpecFor("opencode")
	if opencode.ParseLine == nil {
		t.Error("opencode should use JSONL line parsing (run --format json)")
	}
```

- Add a new test:

```go
func TestOpencodeParseLine_extractsText(t *testing.T) {
	// real `opencode run --format json` events (captured 2026-08-07)
	skip := []string{
		`{"type":"step_start","timestamp":1786080035726,"sessionID":"ses_x","part":{"id":"p1","messageID":"m1","sessionID":"ses_x","snapshot":"s","type":"step-start"}}`,
		`{"type":"reasoning","timestamp":1786080035800,"sessionID":"ses_x","part":{"id":"p2","messageID":"m1","sessionID":"ses_x","type":"reasoning","text":"thinking..."}}`,
		`{"type":"step_finish","timestamp":1786080036726,"sessionID":"ses_x","part":{"id":"p3","messageID":"m1","sessionID":"ses_x","type":"step-finish","reason":"stop","cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}`,
	}
	for _, line := range skip {
		if txt, ok := opencodeParseLine([]byte(line)); ok || txt != "" {
			t.Errorf("expected skip for %q, got %q", line, txt)
		}
	}
	reply := `{"type":"text","timestamp":1786080036000,"sessionID":"ses_x","part":{"id":"p4","messageID":"m1","sessionID":"ses_x","type":"text","text":"pong"}}`
	txt, ok := opencodeParseLine([]byte(reply))
	if !ok || txt != "pong" {
		t.Errorf("expected text part 'pong', got %q ok=%v", txt, ok)
	}
	if _, ok := opencodeParseLine([]byte("not json")); ok {
		t.Error("garbage line should not parse as a reply")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (PowerShell, from repo root):

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/consult/... -run "TestSpecFor|TestOpencodeParseLine" -v
```

Expected: FAIL — `SpecFor("opencode")` is not ok; `opencodeParseLine` is undefined.

- [ ] **Step 3: Implement**

In `pkg/consult/consult.go`, add the runtimeSpec (after the `antigravity` line in `runtimeSpecs`):

```go
	"opencode": {Bin: "opencode", BaseArgs: []string{"run", "--format", "json"}, PromptViaStdin: false, ParseLine: opencodeParseLine},
```

Add the parser after `claudeParseLine`:

```go
// opencodeParseLine extracts assistant text from an `opencode run --format json` JSONL event.
// Verified 2026-08-07: run --format json emits one event per line; assistant text arrives as a
// `text` event whose part.type is "text". step_start/step_finish/reasoning/tool events carry no
// reply text and are skipped. Streaming is incremental — each text event carries its own delta.
func opencodeParseLine(line []byte) (string, bool) {
	var ev struct {
		Type string `json:"type"`
		Part struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"part"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return "", false
	}
	if ev.Type != "text" || ev.Part.Type != "text" {
		return "", false
	}
	if strings.TrimSpace(ev.Part.Text) == "" {
		return "", false
	}
	return ev.Part.Text, true
}
```

Update `SupportedRuntimes`:

```go
func SupportedRuntimes() []string {
	return []string{"claude", "codex", "antigravity", "opencode"}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/consult/...
```

Expected: PASS.

- [ ] **Step 5: Live sanity check (optional but recommended)**

From repo root, confirm the consult actually streams a reply:

Run: `opencode run --format json "Reply with exactly: pong" 2>$null | Select-String '"type":"text"' | Select-Object -First 1`
Expected: a line containing `"type":"text"` and `"text":"pong"`.

- [ ] **Step 6: Commit checkpoint**

```bash
git add pkg/consult/consult.go pkg/consult/consult_test.go
git commit -m "feat(consult): add opencode run --format json consult runtime"
```
(Subject to the repo Git rule.)

---

## Phase 3 — Sessions

### Task 7: opencode sessions scanner

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go`
- Test: `pkg/agentsessions/agentsessions_test.go`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `provider.extract`/`provider.events` signatures gain a leading `path` argument; `SessionInfo.CostUsd float64`; `opencodeProvider(storageRoot string) provider`; `ScanSessions` includes opencode; `ExtractSession(path, "opencode")` works. claude/codex parsers are unchanged (wrapped in closures that ignore `path`).

- [ ] **Step 1: Write the failing tests**

Add to `pkg/agentsessions/agentsessions_test.go`:

```go
func writeJSON(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// buildOpencodeTree creates the opencode storage layout (session info + message + part dirs) under
// root and returns the storage root.
func buildOpencodeTree(t *testing.T, root string) string {
	storage := filepath.Join(root, "opencode", "storage")
	writeJSON(t, filepath.Join(storage, "session", "proj1", "ses_abc.json"),
		`{"id":"ses_abc","slug":"tidy-meadow","projectID":"proj1","directory":"/home/me/payments-api","title":"Fix auth","time":{"created":1770000000000,"updated":1770000100000}}`)
	writeJSON(t, filepath.Join(storage, "message", "ses_abc", "msg_1.json"),
		`{"id":"msg_1","sessionID":"ses_abc","role":"user","time":{"created":1770000000000}}`)
	writeJSON(t, filepath.Join(storage, "message", "ses_abc", "msg_2.json"),
		`{"id":"msg_2","sessionID":"ses_abc","role":"assistant","model":{"providerID":"openai","modelID":"gpt-5.2-codex"},"time":{"created":1770000090000}}`)
	writeJSON(t, filepath.Join(storage, "part", "msg_1", "p1.json"),
		`{"id":"p1","sessionID":"ses_abc","messageID":"msg_1","type":"text","text":"Fix the auth race"}`)
	writeJSON(t, filepath.Join(storage, "part", "msg_2", "p1.json"),
		`{"id":"p1","sessionID":"ses_abc","messageID":"msg_2","type":"text","text":"done, +40 -10"}`)
	writeJSON(t, filepath.Join(storage, "part", "msg_2", "p2.json"),
		`{"id":"p2","sessionID":"ses_abc","messageID":"msg_2","type":"step-finish","reason":"stop","cost":0.5,"tokens":{"input":100,"output":50,"reasoning":0,"cache":{"read":0,"write":0}}}`)
	return storage
}

func TestScanProvider_opencodeExtractsInfoAndUsage(t *testing.T) {
	storage := buildOpencodeTree(t, t.TempDir())
	got := scanProvider(opencodeProvider(storage), 0, 10)
	if len(got) != 1 {
		t.Fatalf("want 1 opencode session, got %d", len(got))
	}
	s := got[0]
	if s.ID != "ses_abc" {
		t.Errorf("ID = %q, want the info-file stem ses_abc", s.ID)
	}
	if s.Runtime != "opencode" {
		t.Errorf("runtime = %q", s.Runtime)
	}
	if s.ProjectName != "payments-api" {
		t.Errorf("projectName = %q", s.ProjectName)
	}
	if s.Model != "openai/gpt-5.2-codex" {
		t.Errorf("model = %q", s.Model)
	}
	if s.Task != "Fix the auth race" {
		t.Errorf("task = %q (must be the first user text part)", s.Task)
	}
	if s.ResumeCommand != "opencode -s ses_abc" {
		t.Errorf("resumeCommand = %q", s.ResumeCommand)
	}
	if s.TokensTotal != 150 {
		t.Errorf("tokensTotal = %d, want 150", s.TokensTotal)
	}
	if s.CostUsd != 0.5 {
		t.Errorf("costUsd = %v, want 0.5", s.CostUsd)
	}
	if len(s.Events) == 0 {
		t.Fatal("expected lifecycle events")
	}
	if s.Events[0].Type != "started" || !strings.Contains(s.Events[0].Text, "Fix the auth race") {
		t.Errorf("first event = %+v, want started with the task", s.Events[0])
	}
}

func TestScanProvider_opencodeSkipsSubagentOnlySession(t *testing.T) {
	storage := buildOpencodeTree(t, t.TempDir())
	writeJSON(t, filepath.Join(storage, "session", "proj2", "ses_xyz.json"),
		`{"id":"ses_xyz","directory":"/x","time":{"created":1770000200000}}`)
	// no message dir for ses_xyz => no user task => skipped
	if got := scanProvider(opencodeProvider(storage), 0, 10); len(got) != 1 {
		t.Fatalf("want only ses_abc, got %d", len(got))
	}
}

func TestExtractSession_opencode(t *testing.T) {
	storage := buildOpencodeTree(t, t.TempDir())
	path := filepath.Join(storage, "session", "proj1", "ses_abc.json")
	s, err := ExtractSession(path, "opencode")
	if err != nil {
		t.Fatalf("ExtractSession error: %v", err)
	}
	if s == nil || s.ID != "ses_abc" {
		t.Fatalf("want ses_abc, got %+v", s)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/agentsessions/... -run "TestScanProvider_opencode|TestExtractSession_opencode" -v
```

Expected: FAIL — `opencodeProvider`, `CostUsd`, and the new `extract` signature are undefined.

- [ ] **Step 3: Implement**

In `pkg/agentsessions/agentsessions.go`:

**3a. Widen `SessionInfo`** — add the field after `TokensTotal`:

```go
	TokensTotal   int
	CostUsd       float64
```

**3b. Generalize the `provider` struct** and the two existing providers (their parsers are unchanged; closures ignore the new `path` arg):

```go
type provider struct {
	runtime   string
	root      string
	matches   func(name string) bool
	extract   func(path, stem string, lines []string) *SessionInfo
	resumeCmd func(s *SessionInfo) string
	events    func(path string, lines []string) sessionEvents
}

func claudeProvider(root string) provider {
	return provider{
		runtime:   "claude",
		root:      root,
		matches:   func(name string) bool { return strings.HasSuffix(name, ".jsonl") },
		extract:   func(_ string, id string, lines []string) *SessionInfo { return extractClaudeSession(id, lines) },
		resumeCmd: func(s *SessionInfo) string { return "claude --resume " + s.ID },
		events:    func(_ string, lines []string) sessionEvents { return extractClaudeEvents(lines) },
	}
}

func codexProvider(root string) provider {
	return provider{
		runtime: "codex",
		root:    root,
		matches: func(name string) bool {
			return strings.HasPrefix(name, "rollout-") && strings.HasSuffix(name, ".jsonl")
		},
		extract:   func(_ string, id string, lines []string) *SessionInfo { return extractCodexSession(id, lines) },
		resumeCmd: func(s *SessionInfo) string { return "codex resume " + s.ID },
		events:    func(_ string, lines []string) sessionEvents { return extractCodexEvents(lines) },
	}
}
```

**3c. Update the two `scanProvider`/`ExtractSession` call sites** to pass `path`:

In `scanProvider`:

```go
		s := p.extract(c.path, c.stem, lines)
```

and

```go
		se := p.events(c.path, lines)
```

In `ExtractSession`, add the opencode arm and pass `path`:

```go
	var p provider
	switch runtime {
	case "claude":
		p = claudeProvider("")
	case "codex":
		p = codexProvider("")
	case "opencode":
		p = opencodeProvider("")
	default:
		return nil, fmt.Errorf("agentsessions: unknown runtime %q", runtime)
	}
	lines := readLines(path)
	// ".json" (not ".jsonl") so opencode session-info files are trimmed correctly; a claude/codex
	// ".jsonl" path does not end in ".json", so the trim is a no-op for them.
	stem := strings.TrimSuffix(filepath.Base(path), ".json")
	s := p.extract(path, stem, lines)
	if s == nil {
		return nil, nil
	}
	s.Runtime = runtime
	s.TranscriptPath = path
	se := p.events(path, lines)
```

(Note: the current `stem` uses `.jsonl`; the block above changes it to `.json`. A claude/codex path `foo.jsonl` does not end in `.json`, so trimming `.json` is a no-op for them while opencode's `ses_x.json` is trimmed correctly.)

**3d. Add the opencode provider and its readers.** `storageRootOf` derives the storage root from a session-info path `<root>/session/<project>/<id>.json` (three dirs up):

```go
// opencodeProvider scans opencode's native storage. root is the storage root (…/opencode/storage);
// scanProvider walks its session subdir. extract/events resolve the sibling message/part dirs by
// session id, which is the info-file filename stem.
func opencodeProvider(storageRoot string) provider {
	return provider{
		runtime: "opencode",
		root:    filepath.Join(storageRoot, "session"),
		matches: func(name string) bool {
			return strings.HasPrefix(name, "ses_") && strings.HasSuffix(name, ".json")
		},
		extract:   extractOpencodeSession,
		resumeCmd: func(s *SessionInfo) string { return "opencode -s " + s.ID },
		events:    extractOpencodeEvents,
	}
}

// storageRootOf derives the storage root from an opencode session-info path
// (<root>/session/<projectID>/<sessionID>.json).
func storageRootOf(path string) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(path)))
}

type opencodeMsg struct {
	ID    string `json:"id"`
	Role  string `json:"role"`
	Model struct {
		ProviderID string `json:"providerID"`
		ModelID    string `json:"modelID"`
	} `json:"model"`
	Time struct {
		Created int64 `json:"created"`
	} `json:"time"`
}

// opencodeMessages returns a session's message files, oldest-first by creation time.
func opencodeMessages(dir string) []opencodeMsg {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []opencodeMsg
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var m opencodeMsg
		if json.Unmarshal(b, &m) != nil || m.ID == "" {
			continue
		}
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time.Created < out[j].Time.Created })
	return out
}

type opencodePart struct {
	Type      string `json:"type"`
	Text      string `json:"text"`
	Tool      string `json:"tool"`
	Synthetic bool   `json:"synthetic"`
	State     struct {
		Status string `json:"status"`
		Input  struct {
			Command string `json:"command"`
		} `json:"input"`
		Metadata struct {
			Exit *int `json:"exit"`
		} `json:"metadata"`
	} `json:"state"`
	Cost   float64 `json:"cost"`
	Tokens struct {
		Input     int `json:"input"`
		Output    int `json:"output"`
		Reasoning int `json:"reasoning"`
		Cache     struct {
			Read  int `json:"read"`
			Write int `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
}

// opencodeParts returns a message's part files, in filename order.
func opencodeParts(root, messageID string) []opencodePart {
	dir := filepath.Join(root, "part", messageID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []opencodePart
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var p opencodePart
		if json.Unmarshal(b, &p) != nil || p.Type == "" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// extractOpencodeSession folds one session info file + its message/part siblings into a
// SessionInfo. The resume key is the info-file stem. The task is the first user text part; the
// model is the last assistant message's provider/model id. Token/cost sums come from step-finish
// parts. Returns nil when the session has no human task (a subagent-only session isn't resumable).
func extractOpencodeSession(path, sessionID string, lines []string) *SessionInfo {
	s := &SessionInfo{ID: sessionID}
	root := storageRootOf(path)
	for _, line := range lines {
		var info struct {
			Directory string `json:"directory"`
		}
		if json.Unmarshal([]byte(line), &info) != nil {
			continue
		}
		if info.Directory != "" {
			s.ProjectPath = info.Directory
			s.ProjectName = filepath.Base(info.Directory)
		}
	}
	hasTask := false
	for _, m := range opencodeMessages(filepath.Join(root, "message", sessionID)) {
		if m.Role == "assistant" && m.Model.ProviderID != "" {
			s.Model = m.Model.ProviderID + "/" + m.Model.ModelID // last assistant model wins
		}
		if !hasTask && m.Role == "user" {
			if task := firstUserText(root, m.ID); task != "" {
				s.Task = trimTo(task, maxTaskLen)
				hasTask = true
			}
		}
	}
	if !hasTask {
		return nil
	}
	for _, m := range opencodeMessages(filepath.Join(root, "message", sessionID)) {
		for _, p := range opencodeParts(root, m.ID) {
			s.TokensTotal += p.Tokens.Input + p.Tokens.Output + p.Tokens.Reasoning + p.Tokens.Cache.Read + p.Tokens.Cache.Write
			s.CostUsd += p.Cost
		}
	}
	return s
}

// firstUserText returns the first non-empty, non-environment text part of a user message.
func firstUserText(root, messageID string) string {
	for _, p := range opencodeParts(root, messageID) {
		if p.Type != "text" || strings.TrimSpace(p.Text) == "" || p.Synthetic {
			continue
		}
		if strings.HasPrefix(p.Text, "<environment_context") {
			continue
		}
		return p.Text
	}
	return ""
}

// extractOpencodeEvents derives lifecycle events from a session's stored parts: first user text ->
// started, last assistant text -> finished, a failed bash tool -> errored, a git commit -> committed.
func extractOpencodeEvents(path string, _ []string) sessionEvents {
	root := storageRootOf(path)
	sessionID := strings.TrimSuffix(filepath.Base(path), ".json")
	var raw []SessionEvent
	var firstTs, lastTs int64
	var firstUser, lastAssistant string
	for _, m := range opencodeMessages(filepath.Join(root, "message", sessionID)) {
		if ts := m.Time.Created; ts > 0 {
			if firstTs == 0 {
				firstTs = ts
			}
			lastTs = ts
		}
		for _, p := range opencodeParts(root, m.ID) {
			switch {
			case m.Role == "user" && p.Type == "text" && firstUser == "" && !p.Synthetic &&
				!strings.HasPrefix(p.Text, "<environment_context") && strings.TrimSpace(p.Text) != "":
				firstUser = clipText(p.Text)
			case m.Role == "assistant" && p.Type == "text" && strings.TrimSpace(p.Text) != "":
				lastAssistant = clipText(p.Text)
			case p.Type == "tool" && p.Tool == "bash" && commitRe.MatchString(p.State.Input.Command):
				raw = append(raw, SessionEvent{Type: "committed", Ts: m.Time.Created, Text: commitSubject(p.State.Input.Command)})
			case p.Type == "tool" && p.State.Metadata.Exit != nil && *p.State.Metadata.Exit != 0:
				cmd := p.State.Input.Command
				if cmd == "" {
					cmd = "a command"
				}
				raw = append(raw, SessionEvent{Type: "errored", Ts: m.Time.Created, Text: "failed: " + clipText(cmd)})
			}
		}
	}
	startedText := "started session"
	if firstUser != "" {
		startedText = firstUser
	}
	finishedText := "finished"
	if lastAssistant != "" {
		finishedText = lastAssistant
	}
	return assembleEvents(raw, firstTs, lastTs, startedText, finishedText)
}
```

**3e. Add opencode to `ScanSessions`:**

```go
	home := wavebase.GetHomeDir()
	opencodeRoot := filepath.Join(home, ".local", "share", "opencode", "storage")
	providers := []provider{
		claudeProvider(filepath.Join(home, ".claude", "projects")),
		codexProvider(filepath.Join(home, ".codex", "sessions")),
		opencodeProvider(opencodeRoot),
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/agentsessions/... ./pkg/consult/...
```

Expected: PASS (existing claude/codex tests included — the `provider` generalization must not regress them).

- [ ] **Step 5: Commit checkpoint**

```bash
git add pkg/agentsessions/agentsessions.go pkg/agentsessions/agentsessions_test.go
git commit -m "feat(sessions): scan opencode sessions from native storage"
```
(Subject to the repo Git rule.)

---

## Phase 4 — Live roster

### Task 8: opencode shadow transcript projector (FE)

**Files:**
- Create: `frontend/app/view/agents/opencodetranscriptprojection.ts`
- Create: `frontend/app/view/agents/opencodetranscriptprojection.test.ts`
- Modify: `frontend/app/view/agents/transcriptregistry.ts`
- Test: `frontend/app/view/agents/transcriptregistry.test.ts`

**Interfaces:**
- Consumes: `AgentEntry` from `./agentsviewmodel`; shadow JSONL schema from Task 10.
- Produces: `projectOpencodeTranscript(lines: string[]): AgentEntry[]`, `extractOpencodeTitle(lines: string[]): string | undefined`; `PROJECTORS.opencode` registered; `agentFromPath` matches a path containing `opencode` (no dot) after the `.claude`/`.codex` checks. No `extractTasks` (opencode has no TodoWrite equivalent — the interface's `extractTasks` is optional).

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/opencodetranscriptprojection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractOpencodeTitle, projectOpencodeTranscript } from "./opencodetranscriptprojection";

const SHADOW = [
    `{"type":"session","id":"ses_x","model":"openai/gpt-5.2-codex","title":"Fix the flaky test","ts":100}`,
    `{"type":"state","state":"working","ts":101}`,
    `{"type":"user","text":"fix the flaky test","ts":102}`,
    `{"type":"assistant","text":"Looking at the spec…","ts":103}`,
    `{"type":"tool","name":"bash","state":"running","input":"go test ./...","ts":104}`,
    `{"type":"tool","name":"bash","state":"error","input":"go test ./...","ts":105}`,
];

describe("projectOpencodeTranscript", () => {
    it("projects user/assistant/tool lines into entries", () => {
        const entries = projectOpencodeTranscript(SHADOW);
        expect(entries[0]).toEqual({ kind: "user", text: "fix the flaky test" });
        expect(entries[1]).toEqual({ kind: "message", text: "Looking at the spec…" });
        expect(entries[2]).toMatchObject({ kind: "action", verb: "ran", target: "go test ./...", outcome: "ok" });
        expect(entries[3]).toMatchObject({ kind: "action", verb: "ran", target: "go test ./...", outcome: "fail" });
    });
    it("skips state records and unparseable lines", () => {
        const entries = projectOpencodeTranscript([...SHADOW, "not json"]);
        expect(entries.some((e) => (e as any).kind === "state")).toBe(false);
    });
    it("maps edit/write/read tool targets to a file name", () => {
        const entries = projectOpencodeTranscript([
            `{"type":"tool","name":"edit","state":"completed","input":"{\\"filePath\\":\\"/a/b/auth.go\\"}","ts":1}`,
        ]);
        expect(entries[0]).toMatchObject({ kind: "action", verb: "edited", target: "auth.go" });
    });
});

describe("extractOpencodeTitle", () => {
    it("prefers the session record title", () => {
        expect(extractOpencodeTitle(SHADOW)).toBe("Fix the flaky test");
    });
    it("falls back to the first user text", () => {
        expect(
            extractOpencodeTitle([`{"type":"user","text":"do the thing","ts":1}`])
        ).toBe("do the thing");
    });
    it("returns undefined for empty input", () => {
        expect(extractOpencodeTitle([])).toBeUndefined();
    });
});
```

Extend `frontend/app/view/agents/transcriptregistry.test.ts`:

```ts
    it("routes by explicit agent: opencode", () => {
        expect(projectorFor("opencode", "/no/such/path").project).toBeDefined();
    });
    it("falls back to opencode for a shadow path", () => {
        expect(projectorFor(undefined, "C:\\Users\\u\\.local\\share\\opencode\\waveterm\\ses_x.jsonl")).toBe(
            PROJECTORS.opencode
        );
    });
```

(Import `PROJECTORS` if not already imported; the existing test file may not export it — if `PROJECTORS` is not exported, assert via `projectorFor(undefined, path).project` presence instead. The `agentFromPath` segment match returns opencode only when the path contains `opencode`; the test path does.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/opencodetranscriptprojection.test.ts frontend/app/view/agents/transcriptregistry.test.ts`
Expected: FAIL — module does not exist / opencode routes to the claude default.

- [ ] **Step 3: Implement**

Create `frontend/app/view/agents/opencodetranscriptprojection.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure projection of an opencode shadow transcript (JSONL lines written by the Wave status plugin,
// installed from cmd/wsh/cmd/opencode-plugin.js) into AgentEntry[]. No React, no Wave runtime imports.

import type { AgentEntry } from "./agentsviewmodel";

const VERB_BY_TOOL: Record<string, string> = {
    bash: "ran",
    read: "read",
    write: "wrote",
    edit: "edited",
    grep: "grep",
    glob: "glob",
    todo: "updated",
    agent: "spawned",
};

function verbFor(name: string): string {
    return VERB_BY_TOOL[name] ?? name.toLowerCase();
}

// the target line for a tool: the command for bash, a file name or pattern for the file tools
function targetFor(name: string, input: string): string {
    if (name === "bash") {
        return input;
    }
    if (!input) {
        return name;
    }
    let args: any;
    try {
        args = JSON.parse(input);
    } catch {
        return input;
    }
    for (const key of ["filePath", "file_path"]) {
        if (typeof args[key] === "string" && args[key]) {
            return args[key].split(/[/\\]/).pop() || args[key];
        }
    }
    if (typeof args.pattern === "string" && args.pattern) {
        return args.pattern;
    }
    return input;
}

/** Pure: project shadow JSONL lines into ordered entries. user -> asked, assistant -> message,
 *  tool -> action (bash fails on an error state), state/session -> no entry. Unparseable lines and
 *  unknown record types are skipped. */
export function projectOpencodeTranscript(lines: string[]): AgentEntry[] {
    const entries: AgentEntry[] = [];
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {
            entries.push({ kind: "user", text: rec.text });
            continue;
        }
        if (rec.type === "assistant" && typeof rec.text === "string" && rec.text.trim() !== "") {
            entries.push({ kind: "message", text: rec.text });
            continue;
        }
        if (rec.type === "tool" && typeof rec.name === "string") {
            const input = typeof rec.input === "string" ? rec.input : "";
            const action: any = { kind: "action", verb: verbFor(rec.name), target: targetFor(rec.name, input) };
            if (rec.name === "bash" && input) {
                action.outcome = rec.state === "error" ? "fail" : "ok";
            }
            entries.push(action);
            continue;
        }
    }
    return entries;
}

/** Pure: the session record's title if the plugin wrote one, else the first user text. */
export function extractOpencodeTitle(lines: string[]): string | undefined {
    let title: string | undefined;
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type === "session" && typeof rec.title === "string" && rec.title.trim() !== "") {
            title = rec.title;
        }
    }
    if (title) {
        return title;
    }
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {
            return rec.text;
        }
    }
    return undefined;
}
```

Modify `frontend/app/view/agents/transcriptregistry.ts`:

```ts
import { extractOpencodeTitle, projectOpencodeTranscript } from "./opencodetranscriptprojection";
import { extractCodexTasks, projectCodexTranscript } from "./codextranscriptprojection";
import { extractAiTitle, extractTasks, projectTranscript } from "./transcriptprojection";
```

```ts
const PROJECTORS: Record<string, TranscriptProjector> = {
    claude: { project: projectTranscript, extractTitle: extractAiTitle, extractTasks },
    codex: { project: projectCodexTranscript, extractTasks: extractCodexTasks },
    opencode: { project: projectOpencodeTranscript, extractTitle: extractOpencodeTitle },
};
```

In `agentFromPath`, add the opencode segment check after the `.codex` check (a shadow path is `…/opencode/waveterm/…` — `opencode` with no leading dot):

```ts
    if (path.includes(".codex")) {
        return "codex";
    }
    if (path.includes("opencode")) {
        return "opencode";
    }
    return undefined;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/opencodetranscriptprojection.test.ts frontend/app/view/agents/transcriptregistry.test.ts frontend/app/view/agents/livetranscript.test.ts`
Expected: PASS (livetranscript covers the streaming path over the registry).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit checkpoint**

```bash
git add frontend/app/view/agents/opencodetranscriptprojection.ts frontend/app/view/agents/opencodetranscriptprojection.test.ts frontend/app/view/agents/transcriptregistry.ts frontend/app/view/agents/transcriptregistry.test.ts
git commit -m "feat(agents): project opencode shadow transcripts"
```
(Subject to the repo Git rule.)

---

### Task 9: `wsh agent-hook` opencode path

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-agenthook.go`
- Test: `cmd/wsh/cmd/wshcmd-agenthook_test.go`

**Interfaces:**
- Consumes: shadow schema (written by Task 10's plugin).
- Produces: `agent-hook` gains `--agent <name>` (default `"claude"`), `--shadow <path>`, `--state <state>`; with `--shadow` it skips stdin parsing, stamps `Agent: <agent>` + `TranscriptPath: <shadow>`, and derives `Model`/`Title` from the shadow via `readShadowSessionInfo(path) (model, title string)` / `readShadowFirstUser(path) string`. Claude behavior unchanged (no flags).

- [ ] **Step 1: Write the failing tests**

Add to `cmd/wsh/cmd/wshcmd-agenthook_test.go`:

```go
func TestReadShadowSessionInfoAndFirstUser(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ses_x.jsonl")
	content := `{"type":"session","id":"ses_x","title":"First title","ts":1}
{"type":"user","text":"fix the flaky test","ts":2}
{"type":"session","id":"ses_x","model":"openai/gpt-5.2-codex","title":"Final title","ts":3}
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	model, title := readShadowSessionInfo(path)
	if model != "openai/gpt-5.2-codex" {
		t.Fatalf("model = %q, want openai/gpt-5.2-codex (last session record wins)", model)
	}
	if title != "Final title" {
		t.Fatalf("title = %q, want Final title", title)
	}
	if got := readShadowFirstUser(path); got != "fix the flaky test" {
		t.Fatalf("first user = %q, want fix the flaky test", got)
	}
}

func TestAgentHookFlagsRegistered(t *testing.T) {
	cmd, _, err := rootCmd.Find([]string{"agent-hook"})
	if err != nil || cmd == nil {
		t.Fatalf("agent-hook not found: %v", err)
	}
	if cmd.Flags().Lookup("agent") == nil {
		t.Fatal("agent-hook missing --agent flag")
	}
	if cmd.Flags().Lookup("shadow") == nil {
		t.Fatal("agent-hook missing --shadow flag")
	}
	if cmd.Flags().Lookup("state") == nil {
		t.Fatal("agent-hook missing --state flag")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./cmd/wsh/... -run "TestReadShadow|TestAgentHookFlags" -v
```

Expected: FAIL — `readShadowSessionInfo`/`readShadowFirstUser` undefined; the flags not registered.

- [ ] **Step 3: Implement**

In `cmd/wsh/cmd/wshcmd-agenthook.go`:

**3a. Add the shadow readers** near `readLastUserPrompt`:

```go
// shadowSessionRecord is the `session` line of an opencode shadow transcript.
type shadowSessionRecord struct {
	Type  string `json:"type"`
	Model string `json:"model"`
	Title string `json:"title"`
}

// readShadowSessionInfo returns the model + title from the last `session` record in an opencode
// shadow transcript (the plugin refreshes it as the session gains a model/title).
func readShadowSessionInfo(path string) (model, title string) {
	for _, ln := range tailLines(path) {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var rec shadowSessionRecord
		if json.Unmarshal([]byte(ln), &rec) == nil && rec.Type == "session" {
			if rec.Model != "" {
				model = rec.Model
			}
			if rec.Title != "" {
				title = rec.Title
			}
		}
	}
	return model, title
}

// readShadowFirstUser returns the first `user` record's text in an opencode shadow transcript.
func readShadowFirstUser(path string) string {
	for _, ln := range tailLines(path) {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var rec struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(ln), &rec) == nil && rec.Type == "user" && strings.TrimSpace(rec.Text) != "" {
			return rec.Text
		}
	}
	return ""
}
```

**3b. Add the flag vars** next to the command definition:

```go
var (
	agentHookAgent  string
	agentHookShadow string
	agentHookState  string
)
```

**3c. Register the flags** in `init()`:

```go
func init() {
	rootCmd.AddCommand(agentHookCmd)
	agentHookCmd.Flags().StringVar(&agentHookAgent, "agent", "claude", "agent identity to stamp (claude | opencode)")
	agentHookCmd.Flags().StringVar(&agentHookShadow, "shadow", "", "opencode shadow transcript path to report as the transcript")
	agentHookCmd.Flags().StringVar(&agentHookState, "state", "", "explicit agent state (opencode path; claude derives it from the hook payload)")
}
```

**3d. Rework `agentHookRun`** so the opencode path supplies state explicitly and the claude path keeps today's stdin derivation:

```go
// agentHookRun always returns nil: a hook must never break the agent's turn.
func agentHookRun(cmd *cobra.Command, args []string) error {
	if os.Getenv("WAVETERM_BLOCKID") == "" {
		return nil // not inside an Arc block; near-instant no-op (not logged: not an error)
	}
	// The opencode path (--shadow) supplies its state explicitly — the plugin derives it from
	// opencode events. The claude path derives state from the lifecycle-hook payload on stdin.
	ev := ccHookEvent{}
	if agentHookShadow == "" {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			hookDebugLine("skip: read stdin failed")
			return nil
		}
		if json.Unmarshal(raw, &ev) != nil {
			hookDebugLine("skip: unmarshal hook event failed")
			return nil
		}
	}
	em := planEmission(ev)
	if agentHookShadow != "" {
		em = agentEmission{State: agentHookState, AttachModelTitle: true}
	}
	if em.State == "" {
		hookDebugLine("skip: no emission for event=" + ev.HookEventName)
		return nil
	}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		hookDebugLine("skip: no jwt in env (WAVETERM_BLOCKID set) event=" + ev.HookEventName)
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		hookDebugLine("skip: setupRpcClient failed event=" + ev.HookEventName)
		return nil
	}
	oref, err := resolveBlockArg()
	if err != nil {
		hookDebugLine("skip: resolveBlockArg failed event=" + ev.HookEventName)
		return nil
	}
	// stamp the transcript path so a gone-worker exit can derive its outcome from the transcript.
	// best-effort: a hook must never fail the turn.
	transcriptPath := ev.TranscriptPath
	if agentHookShadow != "" {
		transcriptPath = agentHookShadow
	}
	if transcriptPath != "" {
		_ = wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{
			ORef: *oref,
			Meta: waveobj.MetaMapType{waveobj.MetaKey_AgentTranscriptPath: transcriptPath},
		}, &wshrpc.RpcOpts{Timeout: 2000})
	}
	data := baseds.AgentStatusData{
		ORef:           oref.String(),
		State:          em.State,
		Detail:         em.Detail,
		Agent:          agentHookAgent,
		TranscriptPath: transcriptPath,
		Ts:             time.Now().UnixMilli(),
	}
	if em.AttachModelTitle && transcriptPath != "" {
		if agentHookShadow != "" {
			data.Model, data.Title = readShadowSessionInfo(transcriptPath)
			if data.Title == "" {
				data.Title = titleFromPrompt(readShadowFirstUser(transcriptPath))
			}
		} else {
			data.Model = readLastModel(transcriptPath)
			data.Title = readLastTitle(transcriptPath)
			// no ai-title yet (e.g. a skill/slash-command turn) -> fall back to the user's prompt so
			// the row still gets a head-text summary instead of the bare agent name
			if data.Title == "" {
				data.Title = titleFromPrompt(readLastUserPrompt(transcriptPath))
			}
		}
	}
	_ = publishAgentStatusData(oref, data, 1)
	hookDebugLine("published event=" + ev.HookEventName + " state=" + em.State + " oref=" + oref.String())
	return nil
}
```

Note: `planEmission(ev)` is now called unconditionally but its result is only used on the claude path (`em = agentEmission{...}` overwrites it for `--shadow`). The `Detail` for the opencode path is empty (the plugin carries no tool detail beyond the shadow, which the projector renders).

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./cmd/wsh/...
```

Expected: PASS (all existing agenthook tests — `TestPlanEmission`, `TestReadLastModelAndTitle`, `TestAgentHookRegistered`, etc. — plus the new ones).

- [ ] **Step 5: Commit checkpoint**

```bash
git add cmd/wsh/cmd/wshcmd-agenthook.go cmd/wsh/cmd/wshcmd-agenthook_test.go
git commit -m "feat(wsh): agent-hook --agent/--shadow/--state for opencode status"
```
(Subject to the repo Git rule.)

---

### Task 10: opencode status plugin + install step

**Files:**
- Create: `cmd/wsh/cmd/opencode-plugin.js` (embedded, go:embed)
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go`
- Test: `cmd/wsh/cmd/wshcmd-installhooks_test.go`

**Interfaces:**
- Consumes: `wsh agent-hook --agent opencode --shadow <path> --state <state>` (Task 9).
- Produces: `installOpencodePlugin(home string) error` (idempotent; no-ops when `opencode` is not on PATH); `opencodePluginTemplate` embedded; `jsonString(s string) string`; `opencodeLookPath` var (overridable in tests). The installed plugin file resolves in `~/.config/opencode/plugins/waveterm-status.js` and is auto-loaded by opencode (docs verified 2026-08-07: files in `~/.config/opencode/plugins/` load automatically; the config `plugin` array is npm-only and must NOT be edited).

- [ ] **Step 1: Write the failing tests**

Add to `cmd/wsh/cmd/wshcmd-installhooks_test.go`:

```go
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
```

(Confirm the imports in the test file include `os`, `path/filepath`, `strings`, `testing` — add any missing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./cmd/wsh/... -run "TestJsonString|TestInstallOpencodePlugin" -v
```

Expected: FAIL — `jsonString`, `installOpencodePlugin`, `opencodeLookPath` undefined.

- [ ] **Step 3: Implement**

**3a. Create `cmd/wsh/cmd/opencode-plugin.js`** (the `__WSH_PATH__` placeholder is replaced by the installer; the file is never run verbatim):

```js
// opencode plugin reporting a running session into the Wave cockpit.
// Installed by `wsh install-agent-hooks` into ~/.config/opencode/plugins/waveterm-status.js with
// __WSH_PATH__ substituted for the absolute wsh path. opencode auto-loads files in that directory
// (docs verified 2026-08-07); the config `plugin` array is npm-only and is not touched.
// A bare opencode outside a Wave block is fully inert: nothing runs without WAVETERM_BLOCKID + JWT.

import { appendFileSync, mkdirSync } from "node:fs";

const WSH = "__WSH_PATH__";
const SHADOW_DIR = "waveterm";

const stateBySession = new Map();
const rolesByMessage = new Map();
const lastTextByPart = new Map();

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function shadowPath(sessionID) {
  return homeDir() + "/.local/share/opencode/" + SHADOW_DIR + "/" + sessionID + ".jsonl";
}

function appendLine(sessionID, line) {
  if (!sessionID) return;
  try {
    const p = shadowPath(sessionID);
    mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    appendFileSync(p, JSON.stringify(line) + "\n");
  } catch (_) {}
}

function report(sessionID, state) {
  if (!sessionID || stateBySession.get(sessionID) === state) return;
  stateBySession.set(sessionID, state);
  appendLine(sessionID, { type: "state", state, ts: Date.now() });
  if (!process.env.WAVETERM_BLOCKID || !process.env.WAVETERM_JWT) return;
  try {
    Bun.spawn([WSH, "agent-hook", "--agent", "opencode", "--shadow", shadowPath(sessionID), "--state", state], {
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (_) {}
}

export const WaveStatusPlugin = async () => {
  return {
    event: async ({ event }) => {
      if (!process.env.WAVETERM_BLOCKID || !process.env.WAVETERM_JWT) return;
      const p = event.properties || {};

      if (event.type === "session.updated" && p.info && p.info.id) {
        appendLine(p.info.id, {
          type: "session",
          id: p.info.id,
          title: typeof p.info.title === "string" ? p.info.title : "",
          ts: Date.now(),
        });
        return;
      }
      if (event.type === "message.updated" && p.info && p.info.role) {
        rolesByMessage.set(p.info.id, p.info.role);
        if (p.info.role === "assistant" && p.info.modelID) {
          appendLine(p.info.sessionID, {
            type: "session",
            id: p.info.sessionID,
            model: (p.info.providerID || "") + "/" + p.info.modelID,
            ts: Date.now(),
          });
          report(p.info.sessionID, "working");
        }
        return;
      }
      if (event.type === "message.part.updated" && p.part) {
        const part = p.part || {};
        const sessionID = part.sessionID;
        if (!sessionID) return;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
          const role = rolesByMessage.get(part.messageID) || "assistant";
          const prev = lastTextByPart.get(part.id) || "";
          const delta = part.text.startsWith(prev) ? part.text.slice(prev.length) : part.text;
          if (delta.trim() !== "") {
            appendLine(sessionID, { type: role, text: delta, ts: Date.now() });
            lastTextByPart.set(part.id, part.text);
          }
          report(sessionID, "working");
          return;
        }
        if (part.type === "tool" && typeof part.tool === "string") {
          const st = part.state || {};
          const input = st.input || {};
          appendLine(sessionID, {
            type: "tool",
            name: part.tool,
            state: st.status || "running",
            input: typeof input.command === "string" ? input.command : "",
            ts: Date.now(),
          });
          report(sessionID, "working");
          return;
        }
        return;
      }
      if (event.type === "permission.asked" && p.sessionID) {
        report(p.sessionID, "waiting");
        return;
      }
      if (event.type === "session.idle" && p.sessionID) {
        report(p.sessionID, "idle");
        return;
      }
      if (event.type === "session.error" && p.sessionID) {
        report(p.sessionID, "idle");
        return;
      }
    },
  };
};
```

**3b. Add the embed + helpers + installer to `cmd/wsh/cmd/wshcmd-installhooks.go`.** Imports gain `bytes` if not present (not needed here — the idempotency check compares strings directly) and `os/exec`:

```go
//go:embed opencode-plugin.js
var opencodePluginTemplate string

// opencodeLookPath is a var so tests can simulate a machine with or without opencode installed.
var opencodeLookPath = exec.LookPath

// jsonString marshals s as a JSON string literal (escapes backslashes/quotes) for substitution
// into the plugin's WSH constant.
func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// installOpencodePlugin writes the Wave status plugin into opencode's global plugin directory
// (~/.config/opencode/plugins/), where opencode auto-loads every file. No-op when opencode is not
// installed. Idempotent: rewrites only when the installed copy differs (the wsh path changes when
// the app install moves), so re-running on every launch self-heals without churn.
func installOpencodePlugin(home string) error {
	if _, err := opencodeLookPath("opencode"); err != nil {
		return nil // opencode not installed; nothing to hook
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving wsh path: %w", err)
	}
	want := strings.ReplaceAll(opencodePluginTemplate, "__WSH_PATH__", jsonString(exe))
	dir := filepath.Join(home, ".config", "opencode", "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	path := filepath.Join(dir, "waveterm-status.js")
	if cur, err := os.ReadFile(path); err == nil && string(cur) == want {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(want), 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	fmt.Printf("installed opencode status plugin into %s\n", path)
	return nil
}
```

**3c. Call the installer from `installAgentHooksRun`** so it runs on every invocation regardless of the Claude config's health. Restructure the tail of the function:

```go
func installAgentHooksRun(cmd *cobra.Command, args []string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolving home dir: %w", err)
	}
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	path := filepath.Join(dir, "settings.json")

	existing := map[string]any{}
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &existing); err != nil {
			return fmt.Errorf("parsing %s: %w", path, err)
		}
	}

	if configIsHealthy(existing, func(p string) bool {
		_, err := os.Stat(p)
		return err == nil
	}) {
		fmt.Printf("Arc agent hooks already installed in %s (skipping)\n", path)
	} else {
		exe, err := os.Executable()
		if err != nil {
			return fmt.Errorf("resolving wsh path: %w", err)
		}

		merged := mergeAgentHooks(existing, exe)
		merged = mergeStatusLine(merged, exe)
		out, err := json.MarshalIndent(merged, "", "  ")
		if err != nil {
			return fmt.Errorf("encoding settings: %w", err)
		}

		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, append(out, '\n'), 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", tmp, err)
		}
		if err := os.Rename(tmp, path); err != nil {
			return fmt.Errorf("replacing %s: %w", path, err)
		}
		fmt.Printf("installed Arc agent hooks into %s\n", path)
	}
	if err := installOpencodePlugin(home); err != nil {
		return err
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./cmd/wsh/...
```

Expected: PASS (all existing installhooks tests — `mergeAgentHooks`, `configIsHealthy`, etc. — plus the new ones; the `go:embed` compiles).

- [ ] **Step 5: Verify the embed is present in the binary**

Run: `go vet ./cmd/wsh/...`
Expected: exit 0 (confirms `//go:embed` path resolves).

- [ ] **Step 6: Commit checkpoint**

```bash
git add cmd/wsh/cmd/opencode-plugin.js cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/wshcmd-installhooks_test.go
git commit -m "feat(wsh): install the opencode status plugin with agent hooks"
```
(Subject to the repo Git rule.)

---

## Phase 5 — Verification & docs

### Task 11: docs + manual verification

**Files:**
- Modify: `docs/agents/channels-reference.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Update the channels reference**

In `docs/agents/channels-reference.md`, update the consult/support notes: add `opencode` to the runtime list in the gotchas (alongside the `agy` positional quirk), and note the opencode specifics — the JSONL `run --format json` consult shape, the `~/.local/share/opencode/waveterm/<sessionID>.jsonl` shadow transcript, and that the plugin is auto-installed by `wsh install-agent-hooks` into `~/.config/opencode/plugins/` (no `opencode.json` edit). Keep the edit to a few lines.

- [ ] **Step 2: Full verification sweep**

Run all test suites and typecheck:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/consult/... ./pkg/agentsessions/... ./cmd/wsh/...
```

Run: `npx vitest run frontend/app/view/agents`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

All expected: PASS / exit 0.

- [ ] **Step 3: Manual roster + consult check (dev app)**

With the dev app running (`task dev`), in a Wave block run an opencode worker whose project has `wsh` on PATH. Expected: the roster shows an opencode row that narrates as it works; a channel `ask @opencode` streams a consult reply. These are CDP-verifiable via `scripts/cdp-shot.mjs` / the existing `surface-smoke` scenario (unchanged).

- [ ] **Step 4: Commit checkpoint**

```bash
git add docs/agents/channels-reference.md
git commit -m "docs(agents): note the opencode consult, shadow, and plugin install"
```
(Subject to the repo Git rule.)
