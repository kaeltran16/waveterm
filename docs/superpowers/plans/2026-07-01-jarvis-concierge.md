# Jarvis (Concierge tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Jarvis — an observe-only manager you `@mention` in a Channels channel that posts a triage summary of that channel's workers.

**Architecture:** Jarvis is a `@mention` participant. The frontend deterministically snapshots the channel's dispatched workers (`buildFleetSnapshot`) and builds a prompt (`buildJarvisPrompt`); a new streaming `JarvisCommand` runs a headless `claude -p` through the existing `pkg/consult` exec and posts the reply as a `jarvis-reply` message. Model phrases, code computes. No worktree, no persistent process, no MCP.

**Tech Stack:** Go (wshrpc/wshserver, reusing `pkg/consult`), React 19 + jotai + Tailwind v4 (@theme tokens), vitest, Chrome DevTools Protocol for live verification.

**Deviations from the spec (refined against the shipped 2-pane redesign — intentional, YAGNI):**
- **No `pkg/jarvis` in v1.** `JarvisCommand` lives in `wshserver.go` beside `ConsultCommand` and reuses `pkg/consult`. A `pkg/jarvis` home is deferred to when Gatekeeper adds real logic (nothing to put there yet).
- **Pure derivations in `jarvisderive.ts`** (matches the shipped `channelderive.ts` naming), not the spec's tentative `jarvismessages.ts`.
- **Send path folded into `channelactions.ts`** (one composer send path, DRY with the consult streaming code), not a separate `jarvisactions.ts`.
- **Ephemeral stream reuses `consultStreamsAtom`** keyed `${reqId}:jarvis` (identical shape; no new atom).
- **No composer autocomplete** (the redesign shipped a plain insert-`@` button); discoverability via the placeholder hint.
- **Message grouping mirrors consult:** anchor `kind:"jarvis"` `author:"you"` + reply `kind:"jarvis-reply"` `author:"jarvis"`, grouped by `reforef:"jarvis:<reqId>"`.

---

## File structure

- **Modify** `frontend/app/view/agents/channelmessages.ts` — add a `jarvis` branch to `planMessage` + the `MessagePlan` union.
- **Modify** `frontend/app/view/agents/channelmessages.test.ts` — `planMessage` jarvis tests.
- **Create** `frontend/app/view/agents/jarvisderive.ts` — pure `buildFleetSnapshot` + `buildJarvisPrompt`.
- **Create** `frontend/app/view/agents/jarvisderive.test.ts` — unit tests for both.
- **Modify** `pkg/wshrpc/wshrpctypes.go` — `CommandJarvisData`, `JarvisChunk`, interface method.
- **Modify** `pkg/wshrpc/wshserver/wshserver.go` — `JarvisCommand` + `postJarvisReply`.
- **Regenerate** `frontend/app/store/wshclientapi.ts` + Go client via `task generate` (never hand-edit).
- **Modify** `frontend/app/view/agents/channelactions.ts` — `jarvis` branch in `sendChannelMessage`; add `agents` arg.
- **Modify** `frontend/app/view/agents/channelssurface.tsx` — `JarvisRow`, render branch, pass `agents`, placeholder hint.

---

### Task 1: `planMessage` jarvis branch (pure, FE)

**Files:**
- Modify: `frontend/app/view/agents/channelmessages.ts`
- Test: `frontend/app/view/agents/channelmessages.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `channelmessages.test.ts` (it already imports `planMessage`):

```ts
describe("planMessage @jarvis", () => {
    it("routes @jarvis with a focus body to a jarvis plan", () => {
        expect(planMessage("@jarvis what's blocked?", [])).toEqual({ kind: "jarvis", text: "what's blocked?" });
    });
    it("routes a bare @jarvis to a jarvis plan with empty text", () => {
        expect(planMessage("@jarvis", [])).toEqual({ kind: "jarvis", text: "" });
    });
    it("treats jarvis as reserved even if a roster worker is named jarvis", () => {
        expect(planMessage("@jarvis go", [{ id: "t1", name: "jarvis" }]).kind).toBe("jarvis");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts -t "@jarvis"`
Expected: FAIL — `planMessage` returns `{kind:"post",...}` (or `steer`), not `jarvis`.

- [ ] **Step 3: Add the union case and the branch**

In `channelmessages.ts`, extend `MessagePlan`:

```ts
export type MessagePlan =
    | { kind: "dispatch"; runtime: Runtime; text: string }
    | { kind: "steer"; targetId: string; blockId?: string; text: string }
    | { kind: "consult"; runtimes: Runtime[]; text: string }
    | { kind: "jarvis"; text: string }
    | { kind: "post"; text: string };
```

In `planMessage`, immediately after `const first = mentions[0];` (and before the runtime `if`), add:

```ts
    if (first === "jarvis") {
        return { kind: "jarvis", text: body };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts -t "@jarvis"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelmessages.ts frontend/app/view/agents/channelmessages.test.ts
git commit -m "feat(jarvis): route @jarvis to a jarvis message plan"
```

---

### Task 2: `buildFleetSnapshot` + `buildJarvisPrompt` (pure, FE)

**Files:**
- Create: `frontend/app/view/agents/jarvisderive.ts`
- Test: `frontend/app/view/agents/jarvisderive.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `jarvisderive.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { buildFleetSnapshot, buildJarvisPrompt } from "./jarvisderive";

function chan(messages: Partial<ChannelMessage>[]): Channel {
    return { oid: "c1", version: 1, name: "payments-api", createdts: 0, meta: {}, messages: messages as ChannelMessage[] };
}
function agent(over: Partial<AgentVM>): AgentVM {
    return { id: "t1", name: "claude", task: "", state: "working", ...over };
}

describe("buildFleetSnapshot", () => {
    it("resolves a dispatched worker to its live state, task, and ask", () => {
        const c = chan([{ kind: "dispatch", author: "claude", text: "harden webhooks", reforef: "tab:t1" }]);
        const agents = [agent({ id: "t1", name: "claude", state: "asking", task: "harden webhooks", ask: { questions: [{ question: "A or B?" }] } })];
        expect(buildFleetSnapshot(c, agents)).toEqual([
            { oref: "tab:t1", name: "claude", state: "asking", task: "harden webhooks", askText: "A or B?" },
        ]);
    });

    it("marks a dispatched worker with no live row as gone, falling back to the dispatch runtime + task", () => {
        const c = chan([{ kind: "dispatch", author: "codex", text: "build auth", reforef: "tab:t2" }]);
        expect(buildFleetSnapshot(c, [])).toEqual([{ oref: "tab:t2", name: "codex", state: "gone", task: "build auth" }]);
    });

    it("dedups a worker that was dispatched then steered into one entry", () => {
        const c = chan([
            { kind: "dispatch", author: "claude", text: "build", reforef: "tab:t1" },
            { kind: "directive", author: "you", text: "also add tests", reforef: "tab:t1" },
        ]);
        const snap = buildFleetSnapshot(c, [agent({ id: "t1", name: "claude", state: "working", task: "build" })]);
        expect(snap).toHaveLength(1);
        expect(snap[0].name).toBe("claude");
    });

    it("ignores non-dispatch messages and returns [] for an empty channel", () => {
        expect(buildFleetSnapshot(chan([{ kind: "human", author: "you", text: "hi", reforef: "" }]), [])).toEqual([]);
        expect(buildFleetSnapshot(chan([]), [])).toEqual([]);
    });
});

describe("buildJarvisPrompt", () => {
    const snap = [{ oref: "tab:t1", name: "claude", state: "asking" as const, task: "build", askText: "A or B?" }];
    it("includes each worker's name, state, task, and ask", () => {
        const p = buildJarvisPrompt(snap, chan([]), "");
        expect(p).toContain("claude [asking]");
        expect(p).toContain("build");
        expect(p).toContain("A or B?");
    });
    it("uses the focus text as the task when provided", () => {
        expect(buildJarvisPrompt(snap, chan([]), "what's blocked?")).toContain("what's blocked?");
    });
    it("falls back to a default task when focus is empty", () => {
        expect(buildJarvisPrompt(snap, chan([]), "  ")).toContain("Summarize the current state");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts`
Expected: FAIL — cannot resolve `./jarvisderive`.

- [ ] **Step 3: Implement `jarvisderive.ts`**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure derivations for Jarvis (the observe-only manager). buildFleetSnapshot resolves the workers a
// channel dispatched into their current roster state; buildJarvisPrompt turns that snapshot + recent
// timeline into the prompt handed to a headless `claude -p`. No React, no Wave runtime imports.

import type { AgentVM } from "./agentsviewmodel";

export interface WorkerState {
    oref: string; // "tab:<id>"
    name: string; // live roster name, else the dispatch runtime
    state: "working" | "asking" | "idle" | "gone";
    task?: string; // live task, else the dispatch text
    askText?: string; // first pending question, when asking
}

const OREF_PREFIX = "tab:";
const MAX_TIMELINE = 12;

// Resolve every worker this channel dispatched/steered to its current state. A dispatched oref with no
// live roster row is "gone" (its terminal exited) and falls back to the dispatch message's runtime +
// task. Dedup by oref (a channel steers the same worker repeatedly).
export function buildFleetSnapshot(channel: Channel, agents: AgentVM[]): WorkerState[] {
    const orefs: string[] = [];
    const dispatchInfo = new Map<string, { name: string; task?: string }>();
    for (const m of channel.messages ?? []) {
        if (!m.reforef?.startsWith(OREF_PREFIX)) {
            continue;
        }
        if (m.kind === "dispatch" && !dispatchInfo.has(m.reforef)) {
            dispatchInfo.set(m.reforef, { name: m.author, task: m.text || undefined });
        }
        if ((m.kind === "dispatch" || m.kind === "directive") && !orefs.includes(m.reforef)) {
            orefs.push(m.reforef);
        }
    }
    return orefs.map((oref) => {
        const id = oref.slice(OREF_PREFIX.length);
        const live = agents.find((a) => a.id === id);
        if (live) {
            return {
                oref,
                name: live.name,
                state: live.state,
                task: live.task || undefined,
                askText: live.state === "asking" ? live.ask?.questions?.[0]?.question : undefined,
            };
        }
        const info = dispatchInfo.get(oref);
        return { oref, name: info?.name ?? "worker", state: "gone" as const, task: info?.task };
    });
}

// Compose the fleet snapshot + a capped recent timeline into the prompt for `claude -p`. focus is the
// user's optional "@jarvis <focus>" text; empty focus => a general fleet summary.
export function buildJarvisPrompt(snapshot: WorkerState[], channel: Channel, focus: string): string {
    const fleetLines = snapshot.length
        ? snapshot
              .map((w) => {
                  const bits = [`- ${w.name} [${w.state}]`];
                  if (w.task) {
                      bits.push(`task: ${w.task}`);
                  }
                  if (w.askText) {
                      bits.push(`asking: ${w.askText}`);
                  }
                  return bits.join(" — ");
              })
              .join("\n")
        : "(no workers dispatched in this channel)";
    const timeline = (channel.messages ?? [])
        .slice(-MAX_TIMELINE)
        .map((m) => `${m.author}: ${m.text}`)
        .join("\n");
    const task = focus.trim() || "Summarize the current state of this channel's workers.";
    return [
        `You are Jarvis, a concise engineering concierge watching a fleet of coding agents in the "${channel.name}" channel.`,
        `Task: ${task}`,
        `Answer in 2-4 short lines: which workers are up, which are blocked (and on what), which are done. Be specific and terse. Do not invent workers not listed.`,
        ``,
        `Fleet:`,
        fleetLines,
        ``,
        `Recent channel messages:`,
        timeline || "(none)",
    ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/jarvisderive.ts frontend/app/view/agents/jarvisderive.test.ts
git commit -m "feat(jarvis): pure fleet-snapshot + prompt derivations"
```

---

### Task 3: `JarvisCommand` backend (Go, reuses `pkg/consult`)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerate: `frontend/app/store/wshclientapi.ts` (+ Go client) via `task generate`

Note: this task has no Go unit test — like `ConsultCommand`, `JarvisCommand` is pure delegation to `consult.Run` (a real CLI) plus a persisted-message write, exercised by the Task 6 CDP run. Its verification here is compile + a clean `task generate` diff.

- [ ] **Step 1: Add the RPC types**

In `pkg/wshrpc/wshrpctypes.go`, next to `CommandConsultData`/`ConsultChunk` (~line 702):

```go
type CommandJarvisData struct {
	ChannelId string `json:"channelid"`
	Prompt    string `json:"prompt"`
	RequestId string `json:"requestid"`
}

type JarvisChunk struct {
	Text string `json:"text"`
}
```

And in the `WshRpcInterface`, next to the `ConsultCommand` line (~line 112):

```go
	JarvisCommand(ctx context.Context, data CommandJarvisData) chan RespOrErrorUnion[JarvisChunk] // Jarvis (observe-only manager): headless claude summary of a channel's fleet; streams chunks, posts a jarvis-reply on completion
```

- [ ] **Step 2: Implement `JarvisCommand` + `postJarvisReply`**

In `pkg/wshrpc/wshserver/wshserver.go`, directly after `ConsultCommand` (after ~line 1679). Reuses `consultTimeout`, `consult.SpecFor`, `consult.Run`, `wstore.NewChannelMessage`, `wstore.PostChannelMessage`, `wcore.SendWaveObjUpdate` — all already imported in this file:

```go
func postJarvisReply(data wshrpc.CommandJarvisData, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("jarvis-reply", "jarvis", text, "jarvis:"+data.RequestId, time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg); err != nil {
		log.Printf("jarvis: failed to post reply: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
}

func (ws *WshServer) JarvisCommand(ctx context.Context, data wshrpc.CommandJarvisData) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("JarvisCommand", recover())
		}()
		defer close(rtn)
		ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Error: fmt.Errorf("channel not found: %w", err)}
			return
		}
		spec, ok := consult.SpecFor("claude")
		if !ok {
			postJarvisReply(data, "jarvis requires the claude CLI, which is not available")
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Error: fmt.Errorf("claude runtime unavailable")}
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, consultTimeout)
		defer cancel()
		full, runErr := consult.Run(runCtx, spec, ch.ProjectPath, data.Prompt, func(chunk string) {
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Response: wshrpc.JarvisChunk{Text: chunk}}:
			case <-runCtx.Done():
			}
		})
		reply := strings.TrimSpace(full)
		if runErr != nil {
			if reply != "" {
				reply += "\n\n"
			}
			reply += "jarvis failed: " + runErr.Error()
		}
		postJarvisReply(data, reply)
	}()
	return rtn
}
```

- [ ] **Step 3: Regenerate bindings**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` gains a `JarvisCommand` method (streaming, returns an async generator) and the Go client gains its stub. No other unexpected diffs.

- [ ] **Step 4: Build the backend to verify it compiles**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go
git commit -m "feat(jarvis): JarvisCommand — headless claude fleet summary reusing pkg/consult"
```

---

### Task 4: wire the `jarvis` branch into `sendChannelMessage`

**Files:**
- Modify: `frontend/app/view/agents/channelactions.ts`

No new unit test: `sendChannelMessage` is the impure orchestration seam (RPC + streaming), like the existing consult branch it sits beside; its logic is the composition of the Task 1/2 pure functions (tested) and the Task 3 command (CDP-tested in Task 6).

- [ ] **Step 1: Add imports**

At the top of `channelactions.ts`, add the snapshot helpers, the active-channel atom, and the `AgentVM` type:

```ts
import { buildFleetSnapshot, buildJarvisPrompt } from "./jarvisderive";
import type { AgentVM } from "./agentsviewmodel";
```

Extend the existing `channelsstore` import to include `activeChannelAtom`:

```ts
import { activeChannelAtom, consultStreamKey, consultStreamsAtom, setConsultStream } from "./channelsstore";
```

- [ ] **Step 2: Add `agents` to the args type**

Change the `sendChannelMessage` args object to include the live roster VMs:

```ts
export async function sendChannelMessage(args: {
    model: AgentsViewModel;
    channelId: string;
    projectPath: string;
    projectName: string;
    roster: RosterEntry[];
    agents: AgentVM[];
    text: string;
}): Promise<void> {
    const { model, channelId, projectPath, projectName, roster, agents, text } = args;
```

- [ ] **Step 3: Add the jarvis branch**

Immediately before the `if (plan.kind === "dispatch")` branch, add:

```ts
    if (plan.kind === "jarvis") {
        const reqId = crypto.randomUUID();
        // anchor: the user's request, grouped to its reply by requestId (mirrors the consult grouping)
        await RpcApi.PostChannelMessageCommand(TabRpcClient, {
            channelid: channelId,
            kind: "jarvis",
            author: "you",
            text: plan.text || "summarize the fleet",
            reforef: `jarvis:${reqId}`,
        });
        const channel = globalStore.get(activeChannelAtom);
        const snapshot = channel ? buildFleetSnapshot(channel, agents) : [];
        if (snapshot.length === 0) {
            // nothing dispatched here — answer without spending a model call
            await post(channelId, "jarvis-reply", "jarvis", "No workers dispatched in this channel yet.", `jarvis:${reqId}`);
            return;
        }
        const prompt = buildJarvisPrompt(snapshot, channel!, plan.text);
        setConsultStream(reqId, "jarvis", { text: "", status: "streaming" });
        try {
            const gen = RpcApi.JarvisCommand(
                TabRpcClient,
                { channelid: channelId, prompt, requestid: reqId },
                { timeout: CONSULT_RPC_TIMEOUT_MS }
            );
            let acc = "";
            for await (const chunk of gen) {
                acc += chunk?.text ?? "";
                setConsultStream(reqId, "jarvis", { text: acc, status: "streaming" });
            }
            setConsultStream(reqId, "jarvis", { text: acc, status: "done" });
        } catch {
            // the backend still posts a jarvis-reply with the error; mark the live row done
            setConsultStream(reqId, "jarvis", {
                text: globalStore.get(consultStreamsAtom)[consultStreamKey(reqId, "jarvis")]?.text ?? "",
                status: "error",
            });
        }
        return;
    }
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` errors (the known baseline) — no new errors. (Task 5 will fix the now-required `agents` arg at the call site; if you run tsc before Task 5 you will also see one "missing property 'agents'" error in `channelssurface.tsx` — that is expected and resolved next.)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelactions.ts
git commit -m "feat(jarvis): send @jarvis — snapshot, prompt, stream JarvisCommand"
```

---

### Task 5: render Jarvis rows in the Channels surface

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx`

- [ ] **Step 1: Add the reqId helper + `JarvisRow` component**

After the existing `consultIdOf` helper, add:

```tsx
function jarvisReqIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("jarvis:") ? refORef.slice("jarvis:".length) : undefined;
}
```

After the `ConsultRow` component, add `JarvisRow` (single reply grouped by requestId; the persisted `jarvis-reply` if present, else the live streaming text):

```tsx
function JarvisRow({
    msg,
    allMessages,
    streams,
    now,
}: {
    msg: ChannelMessage;
    allMessages: ChannelMessage[];
    streams: Record<string, ConsultStream>;
    now: number;
}) {
    const reqId = jarvisReqIdOf(msg.reforef);
    const reply = reqId
        ? allMessages.find((m) => m.kind === "jarvis-reply" && jarvisReqIdOf(m.reforef) === reqId)
        : undefined;
    const live = reqId && !reply ? streams[`${reqId}:jarvis`] : undefined;
    return (
        <div className="flex items-start gap-3">
            <Avatar name={msg.author} />
            <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-primary">{msg.author}</span>
                    <Tag label="jarvis" tone="muted" />
                    <span className="font-mono text-[10.5px] text-muted">{timeLabel(msg.ts, now)}</span>
                </div>
                <p className="mb-2.5 text-[14px] leading-[1.6] text-secondary">{msg.text || "(empty)"}</p>
                {reply ? (
                    <div className="rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-2.5">
                        <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">jarvis</div>
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{reply.text}</div>
                    </div>
                ) : (
                    <div className="rounded-[9px] border border-accent/40 bg-accentbg/30 px-3 py-2.5">
                        <div className="mb-1 font-mono text-[11px] font-semibold text-accent-soft">
                            jarvis {!live || live.status === "streaming" ? "· thinking…" : ""}
                        </div>
                        <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">
                            {live?.text || "…"}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Route the `jarvis` kind and hide `jarvis-reply` in the message map**

Replace the existing message `.filter(...).map(...)` block with:

```tsx
                            messages
                                .filter((m) => m.kind !== "consult-reply" && m.kind !== "jarvis-reply")
                                .map((m) =>
                                    m.kind === "consult" ? (
                                        <ConsultRow
                                            key={m.id}
                                            msg={m}
                                            allMessages={messages}
                                            streams={consultStreams}
                                            now={now}
                                        />
                                    ) : m.kind === "jarvis" ? (
                                        <JarvisRow
                                            key={m.id}
                                            msg={m}
                                            allMessages={messages}
                                            streams={consultStreams}
                                            now={now}
                                        />
                                    ) : (
                                        <MessageRow key={m.id} model={model} agents={agents} msg={m} now={now} />
                                    )
                                )
```

- [ ] **Step 3: Pass `agents` to `sendChannelMessage`**

In the `send` function, add `agents,` to the `sendChannelMessage({...})` call:

```tsx
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: activeId,
                projectPath: active?.projectpath ?? "",
                projectName: active?.name ?? "agent",
                roster,
                agents,
                text,
            })
        );
```

- [ ] **Step 4: Add a jarvis hint to the composer placeholder**

Change the placeholder to advertise `@jarvis`. Replace the `placeholder=` on the textarea with:

```tsx
                            placeholder={`Message #${active?.name ?? "channel"}…${askHint} · @jarvis to summarize`}
```

- [ ] **Step 5: Typecheck + full test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `api.test.ts` errors.

Run: `npx vitest run`
Expected: full suite green (prior count + the new jarvis tests from Tasks 1–2).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(jarvis): render jarvis query + reply rows in Channels"
```

---

### Task 6: end-to-end verification (live dev app, CDP)

**Files:** none (verification only).

- [ ] **Step 1: Rebuild the backend and launch the dev app**

The Go change means the packaged/dev `wavesrv` must be rebuilt. Per the project's dev gotcha, keep stdin open:

Run: `task build:backend` then `tail -f /dev/null | task dev`
(If `wavesrv` boot-errors on EOF, that stdin redirect is the fix. CDP `Page.reload` breaks Tauri boot — touch `src-tauri/` to relaunch instead.)

- [ ] **Step 2: Inject a populated fleet (optional) and open Channels**

If no live agents are running, populate one: `node scripts/inject-live-agents.mjs <scenario>`. Then screenshot to confirm the Channels tab renders: `node scripts/cdp-shot.mjs jarvis-before.png`.

- [ ] **Step 3: Verify the happy path**

In a channel that has dispatched at least one worker (`@claude ...`), type `@jarvis what's blocked?` and send. Confirm via `node scripts/cdp-shot.mjs jarvis-summary.png`:
- a `you` row with the `jarvis` tag and your query text,
- a nested card that shows `jarvis · thinking…` then streams, and
- on completion, a persisted `jarvis` reply card with a 2–4 line triage that names the real workers (no invented ones).

- [ ] **Step 4: Verify the empty-channel short-circuit**

In a channel with **no** dispatched workers, send `@jarvis`. Confirm the reply card reads "No workers dispatched in this channel yet." and that it appears near-instantly (no model-call latency).

- [ ] **Step 5: Commit any verification artifacts / notes**

If you keep screenshots or a short verification note, commit under the scratchpad or a docs note; otherwise record the CDP result in the PR/commit description. Do not commit large PNGs to the repo.

---

## Self-review

**1. Spec coverage:**
- Trigger `@jarvis`, on-demand only → Task 1 (`planMessage`) + Task 4 (send). ✅
- Per-channel scope (resolve this channel's dispatch/directive refORefs) → Task 2 `buildFleetSnapshot`. ✅
- Model-for-judgment/code-for-determinism (FE builds snapshot, model phrases) → Tasks 2 + 4 build snapshot/prompt; Task 3 only runs claude. ✅
- Reuse `pkg/consult` exec, Claude-only → Task 3 (`consult.SpecFor("claude")`, `consult.Run`). ✅
- Empty-channel short-circuit, no model call → Task 4. ✅
- Error/timeout reuse consult path (post reply, never hang) → Task 3 (`postJarvisReply` on `runErr`, `consultTimeout`) + Task 4 catch. ✅
- Distinct jarvis row rendering → Task 5 `JarvisRow`. ✅
- Testing: vitest for pure fns (Tasks 1–2), tsc + full vitest (Task 5), CDP (Task 6). ✅
- Deferred (all-idle auto-trigger, ↗ links, backend fleet-query/MCP, any write verb) → not in any task, correctly out of scope. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step gives an exact command + expected result. ✅

**3. Type consistency:** `WorkerState` fields (`oref/name/state/task/askText`) are consistent across Task 2 definition, its tests, and `buildJarvisPrompt`. `CommandJarvisData{channelid,prompt,requestid}` matches the FE call in Task 4 (`{channelid, prompt, requestid: reqId}`). Message kinds `jarvis` (anchor) / `jarvis-reply` (reply) and `reforef` `jarvis:<reqId>` are consistent across Tasks 3 (post), 4 (post anchor + short-circuit), and 5 (filter + group). Stream key `${reqId}:jarvis` matches `consultStreamKey(reqId, "jarvis")`. `MessagePlan` `jarvis.text` is read as `plan.text` in Task 4. ✅
