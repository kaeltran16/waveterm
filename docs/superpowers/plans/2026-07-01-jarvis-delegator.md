# Jarvis Delegator (v1: Report + Manage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Jarvis spawn and run a Claude worker toward a goal posted in a delegator-enabled channel — Report (plain task, human reviews) and Manage (`/goal` self-runs to completion, Gatekeeper auto-answers).

**Architecture:** Reuse the shipped FE dispatch spine (`launchAgent` + a `"dispatch"` channel message whose RefORef the Gatekeeper watcher already matches). The only new backend is a `SetChannelTierCommand` that persists the per-channel autonomy tier as two derived meta booleans. Routing is a pure FE decision (`planDelegate`); Report vs Manage is the presence/absence of the `/goal` wrapper on the launched task. Fan-out is out of scope (separate v1.1 plan).

**Tech Stack:** Go (wavesrv, wshrpc), TypeScript/React (cockpit FE), vitest, Go testing. Codegen via `task generate`.

**Spec:** `docs/superpowers/specs/2026-07-01-jarvis-delegator-design.md`

---

### Task 1: `TierMeta` — derive channel-meta booleans from a tier (Go, pure)

**Files:**
- Modify: `pkg/jarvis/resolve.go`
- Test: `pkg/jarvis/resolve_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/jarvis/resolve_test.go`:

```go
func TestTierMeta(t *testing.T) {
	cases := []struct {
		tier          string
		wantGatekeeper bool
		wantDelegator  bool
	}{
		{"delegator", true, true},
		{"gatekeeper", true, false},
		{"concierge", false, false},
		{"", false, false},
		{"bogus", false, false},
	}
	for _, c := range cases {
		gk, del := TierMeta(c.tier)
		if gk != c.wantGatekeeper || del != c.wantDelegator {
			t.Errorf("TierMeta(%q) = (%v,%v), want (%v,%v)", c.tier, gk, del, c.wantGatekeeper, c.wantDelegator)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestTierMeta -v`
Expected: FAIL — `undefined: TierMeta`.

- [ ] **Step 3: Write minimal implementation**

Append to `pkg/jarvis/resolve.go` (below the existing `MetaKey_GatekeeperEnabled` const, add the two new keys and the helper):

```go
// MetaKey_DelegatorEnabled toggles the Delegator (act) tier for a channel; nested above Gatekeeper.
// MetaKey_DelegatorMode is the channel's default dispatch mode ("report" | "manage" | "fanout").
const (
	MetaKey_DelegatorEnabled = "delegator:enabled"
	MetaKey_DelegatorMode    = "delegator:mode"
)

// TierMeta derives the two per-channel autonomy booleans from a tier name. The ladder is nested:
// delegator implies gatekeeper. Any unknown/empty tier falls to the floor (both off = concierge).
func TierMeta(tier string) (gatekeeper bool, delegator bool) {
	switch tier {
	case "delegator":
		return true, true
	case "gatekeeper":
		return true, false
	default:
		return false, false
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestTierMeta -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/resolve.go pkg/jarvis/resolve_test.go
git commit -m "feat(jarvis): TierMeta derives channel autonomy booleans from tier"
```

---

### Task 2: `SetChannelTierCommand` — persist the tier (Go wshrpc)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface + data type)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handler)
- Runs codegen: `task generate` (regenerates `pkg/wshrpc/wshclient/wshclient.go` and `frontend/app/store/wshclientapi.ts`)

- [ ] **Step 1: Add the command to the interface**

In `pkg/wshrpc/wshrpctypes.go`, directly below the `SetChannelGatekeeperCommand` line (~line 112) add:

```go
	SetChannelTierCommand(ctx context.Context, data CommandSetChannelTierData) error // sets a channel's Jarvis autonomy tier (concierge|gatekeeper|delegator) + default dispatch mode
```

- [ ] **Step 2: Add the data type**

In `pkg/wshrpc/wshrpctypes.go`, directly below the `CommandSetChannelGatekeeperData` struct (~line 704) add:

```go
type CommandSetChannelTierData struct {
	ChannelId string `json:"channelid"`
	Tier      string `json:"tier"`           // concierge | gatekeeper | delegator
	Mode      string `json:"mode,omitempty"` // default dispatch mode: report | manage | fanout
}
```

- [ ] **Step 3: Implement the handler**

In `pkg/wshrpc/wshserver/wshserver.go`, directly below `SetChannelGatekeeperCommand` (ends ~line 1638) add:

```go
func (ws *WshServer) SetChannelTierCommand(ctx context.Context, data wshrpc.CommandSetChannelTierData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	gk, del := jarvis.TierMeta(data.Tier)
	mode := data.Mode
	if mode == "" {
		mode = "report"
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[jarvis.MetaKey_GatekeeperEnabled] = gk
		ch.Meta[jarvis.MetaKey_DelegatorEnabled] = del
		ch.Meta[jarvis.MetaKey_DelegatorMode] = mode
	})
	if err != nil {
		return fmt.Errorf("updating channel tier: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: no errors; `git diff --stat` shows changes in `pkg/wshrpc/wshclient/wshclient.go` and `frontend/app/store/wshclientapi.ts` adding `SetChannelTierCommand`.

- [ ] **Step 5: Verify the backend builds**

Run: `go build ./pkg/... ./cmd/...`
Expected: no errors (confirms the interface is fully implemented and no import cycle).

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts
git commit -m "feat(jarvis): SetChannelTierCommand persists per-channel autonomy tier"
```

---

### Task 3: `planMessage` — parse `@jarvis:<mode>` override (FE, pure)

**Files:**
- Modify: `frontend/app/view/agents/channelmessages.ts`
- Test: `frontend/app/view/agents/channelmessages.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/channelmessages.test.ts`:

```ts
describe("planMessage @jarvis mode override", () => {
    it("parses a bare @jarvis with no mode", () => {
        const p = planMessage("@jarvis what's the fleet doing?", []);
        expect(p).toEqual({ kind: "jarvis", text: "what's the fleet doing?", mode: undefined });
    });
    it("parses @jarvis:manage <goal>", () => {
        const p = planMessage("@jarvis:manage add rate limiting", []);
        expect(p).toEqual({ kind: "jarvis", text: "add rate limiting", mode: "manage" });
    });
    it("parses @jarvis:report and @jarvis:fanout", () => {
        expect(planMessage("@jarvis:report do x", [])).toMatchObject({ kind: "jarvis", mode: "report" });
        expect(planMessage("@jarvis:fanout do y", [])).toMatchObject({ kind: "jarvis", mode: "fanout" });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts -t "mode override"`
Expected: FAIL — `mode` is undefined on the returned object / regex does not capture the mode.

- [ ] **Step 3: Update the type and the jarvis branch**

In `frontend/app/view/agents/channelmessages.ts`:

Add the mode type near the top of the file (after imports):

```ts
export type DispatchMode = "report" | "manage" | "fanout";
```

Change the jarvis variant of `MessagePlan` (currently `| { kind: "jarvis"; text: string }`) to:

```ts
    | { kind: "jarvis"; text: string; mode?: DispatchMode }
```

Replace the jarvis regex + return (currently the `jarvisMatch` block, ~lines 44-47) with:

```ts
    const jarvisMatch = /^@jarvis(?::(report|manage|fanout))?\b\s*([\s\S]*)$/i.exec(trimmed);
    if (jarvisMatch) {
        const mode = jarvisMatch[1] ? (jarvisMatch[1].toLowerCase() as DispatchMode) : undefined;
        return { kind: "jarvis", text: jarvisMatch[2].trim(), mode };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts`
Expected: PASS (new tests + all existing planMessage tests still green).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelmessages.ts frontend/app/view/agents/channelmessages.test.ts
git commit -m "feat(jarvis): parse @jarvis:<mode> dispatch override"
```

---

### Task 4: `planDelegate` + `tierFromMeta` — the routing decision (FE, pure)

**Files:**
- Modify: `frontend/app/view/agents/channelmessages.ts`
- Test: `frontend/app/view/agents/channelmessages.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/channelmessages.test.ts`:

```ts
describe("tierFromMeta", () => {
    it("reads the nested tier from meta booleans", () => {
        expect(tierFromMeta({})).toBe("concierge");
        expect(tierFromMeta({ "gatekeeper:enabled": true })).toBe("gatekeeper");
        expect(tierFromMeta({ "gatekeeper:enabled": true, "delegator:enabled": true })).toBe("delegator");
    });
});

describe("planDelegate", () => {
    it("returns summary when not a delegator channel", () => {
        expect(planDelegate({ tier: "gatekeeper", defaultMode: "report", goal: "do x" }))
            .toEqual({ action: "summary" });
    });
    it("returns summary for a delegator channel with an empty goal (bare @jarvis)", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "manage", goal: "" }))
            .toEqual({ action: "summary" });
    });
    it("Report dispatches the plain goal (no /goal wrapper)", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "report", goal: "add x" }))
            .toEqual({ action: "dispatch", task: "add x", mode: "report" });
    });
    it("Manage wraps the goal in /goal", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "manage", goal: "add x" }))
            .toEqual({ action: "dispatch", task: "/goal add x", mode: "manage" });
    });
    it("a per-message override beats the channel default", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "report", override: "manage", goal: "add x" }))
            .toEqual({ action: "dispatch", task: "/goal add x", mode: "manage" });
    });
    it("Fan-out degrades to a single /goal dispatch in v1", () => {
        expect(planDelegate({ tier: "delegator", defaultMode: "fanout", goal: "add x" }))
            .toEqual({ action: "dispatch", task: "/goal add x", mode: "fanout" });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts -t "planDelegate"`
Expected: FAIL — `tierFromMeta`/`planDelegate` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/app/view/agents/channelmessages.ts`:

```ts
export type JarvisTier = "concierge" | "gatekeeper" | "delegator";

// tierFromMeta reads the nested autonomy tier from a channel's meta booleans (delegator ⇒ gatekeeper).
export function tierFromMeta(meta: Record<string, unknown> | undefined): JarvisTier {
    if (meta?.["delegator:enabled"]) {
        return "delegator";
    }
    if (meta?.["gatekeeper:enabled"]) {
        return "gatekeeper";
    }
    return "concierge";
}

export type DelegatePlan = { action: "summary" } | { action: "dispatch"; task: string; mode: DispatchMode };

// planDelegate decides whether an @jarvis message in this channel is an observe-only summary or a
// worker dispatch. Only a delegator-tier channel with a non-empty goal dispatches. Report launches the
// plain goal (one bounded pass); Manage/Fan-out wrap it in /goal (loop to completion). Fan-out has no
// decompose backend yet (v1), so it degrades to a single /goal dispatch.
export function planDelegate(args: {
    tier: JarvisTier;
    defaultMode: DispatchMode;
    override?: DispatchMode;
    goal: string;
}): DelegatePlan {
    const goal = args.goal.trim();
    if (args.tier !== "delegator" || goal === "") {
        return { action: "summary" };
    }
    const mode = args.override ?? args.defaultMode;
    const task = mode === "report" ? goal : `/goal ${goal}`;
    return { action: "dispatch", task, mode };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/channelmessages.test.ts`
Expected: PASS (all planDelegate + tierFromMeta cases + prior tests green).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelmessages.ts frontend/app/view/agents/channelmessages.test.ts
git commit -m "feat(jarvis): planDelegate routes @jarvis goals to dispatch by tier/mode"
```

---

### Task 5: Wire the delegate branch into `sendChannelMessage` (FE glue)

**Files:**
- Modify: `frontend/app/view/agents/channelactions.ts`

- [ ] **Step 1: Add imports**

In `frontend/app/view/agents/channelactions.ts`, extend the existing import from `./channelmessages`:

```ts
import { planDelegate, planMessage, tierFromMeta, type RosterEntry } from "./channelmessages";
```

- [ ] **Step 2: Route the jarvis branch through planDelegate**

In `sendChannelMessage`, at the very top of the `if (plan.kind === "jarvis") {` block (before the existing summary logic that posts the `jarvis` request message), insert the delegate check:

```ts
    if (plan.kind === "jarvis") {
        const channel = globalStore.get(activeChannelAtom);
        const tier = tierFromMeta(channel?.meta as Record<string, unknown> | undefined);
        const defaultMode = ((channel?.meta as Record<string, unknown>)?.["delegator:mode"] as
            | "report"
            | "manage"
            | "fanout") ?? "report";
        const del = planDelegate({ tier, defaultMode, override: plan.mode, goal: plan.text });
        if (del.action === "dispatch") {
            const tabId = await launchAgent(model, {
                runtime: "claude",
                startupCommand: runtimeStartupCommand("claude"),
                task: del.task,
                projectPath,
                projectName: projectName || "agent",
            });
            await post(channelId, "dispatch", "claude", del.task, `tab:${tabId}`);
            return;
        }
        // (existing observe-only summary logic continues below unchanged)
```

Leave the rest of the jarvis branch (the `reqId` / `JarvisCommand` summary path) exactly as-is — it now only runs when `del.action === "summary"`.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` baseline errors; no new errors.

- [ ] **Step 4: Run the FE test suite**

Run: `npx vitest run`
Expected: all green (no behavioral regression; the summary path is unchanged for non-delegator channels).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelactions.ts
git commit -m "feat(jarvis): dispatch a worker for @jarvis goals in delegator channels"
```

---

### Task 6: Tier dial control in the channel header (FE UI)

**Files:**
- Modify: the channels surface component that currently renders the Gatekeeper toggle. Find it first.

- [ ] **Step 1: Locate the existing Gatekeeper toggle**

Run: `git grep -n "SetChannelGatekeeperCommand" -- frontend/`
Expected: one FE call site (the shipped per-channel Gatekeeper toggle). That component + location is where the tier dial goes.

- [ ] **Step 2: Add a 3-way tier control**

In that component, replace/augment the Gatekeeper on/off toggle with a 3-segment control (Concierge / Gatekeeper / Delegator). Read the current tier with `tierFromMeta(channel.meta)` (import from `./channelmessages`), highlight the active segment, and on click call:

```ts
await RpcApi.SetChannelTierCommand(TabRpcClient, {
    channelid: channel.oid,
    tier, // "concierge" | "gatekeeper" | "delegator"
    mode: (channel.meta?.["delegator:mode"] as string) ?? "report",
});
```

Follow the existing toggle's styling conventions (use `@theme` tokens, per project convention — no raw hex). The visual reference is the handoff mock at `wave-handoff/wave/project/Wave-cockpit-live.dc.html` (header segmented control).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: baseline-only errors.

- [ ] **Step 4: Run the FE test suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/
git commit -m "feat(jarvis): per-channel autonomy tier dial (Concierge/Gatekeeper/Delegator)"
```

---

### Task 7: Live verification (CDP on the dev app)

**Reference:** `docs` note "CDP verify dev app" — drive the running dev app over Chrome DevTools Protocol on `:9222` (see `scripts/cdp-shot.mjs`). The dev app must be running with the rebuilt backend (`SetChannelTierCommand` requires a wavesrv rebuild; per project notes, touch `src-tauri/src/main.rs` to trigger the cargo-tauri watcher relaunch that re-spawns wavesrv from `dist/bin`). Run `task dev` kept alive via `tail -f /dev/null | task dev`.

- [ ] **Step 1: Set a channel to the Delegator tier**

Over CDP, invoke `window.TabRpcClient` `SetChannelTierCommand` for a test channel with `{tier:"delegator", mode:"report"}`. Confirm the channel header dial shows Delegator active and `channel.meta` has `gatekeeper:enabled=true`, `delegator:enabled=true`, `delegator:mode="report"`.

- [ ] **Step 2: Report dispatch**

In that channel, send `@jarvis add a top-level README note`. Verify: a new agent tab/worker spawns in the channel's repo, a `"dispatch"` message with `tab:<id>` appears in the channel, the worker runs `claude` with the plain goal (no `/goal`), and the roster shows the worker.

- [ ] **Step 3: Manage dispatch + Gatekeeper auto-answer**

Send `@jarvis:manage <a goal that provokes a routine single-select question>`. Verify: the worker launches with `/goal ...`, and when it raises a routine `AskUserQuestion`, the Gatekeeper auto-answers it (a `jarvis-answered` message appears and the worker resumes) — reusing the proven Gatekeeper path.

- [ ] **Step 4: Confirm non-delegator channels are unaffected**

In a concierge/gatekeeper channel, send `@jarvis status` and confirm it still returns the observe-only summary (no dispatch).

- [ ] **Step 5: Record results**

Note pass/fail per step in the PR/commit description. No code commit for this task unless a fix is needed.

---

## Self-review notes

- **Spec coverage:** Report (Task 5, plain task), Manage (Task 5, `/goal` wrapper + Gatekeeper coupling via Task 2's `gatekeeper:enabled`), tier persistence (Task 2), mode override (Task 3), routing (Task 4), UI dial (Task 6), Gatekeeper reuse (no code — verified Task 7). Fan-out is explicitly deferred to v1.1 (Task 4 degrades it to a single `/goal` dispatch so a `fanout` default never errors).
- **Type consistency:** `DispatchMode` / `JarvisTier` / `DelegatePlan` defined in Task 3–4 and consumed in Task 5–6; `TierMeta` (Go) defined Task 1, consumed Task 2; meta keys `gatekeeper:enabled` / `delegator:enabled` / `delegator:mode` are the single string constants used across Go (Task 1/2) and FE (`tierFromMeta`, Task 4).
- **No new spawn / migration:** confirmed — dispatch reuses `launchAgent`; no waveobj type added.

## Deferred to v1.1 (separate plan)

- Fan-out: `JarvisDecomposeCommand` (`claude -p` decompose, fail-safe to `[goal]`) + per-worker worktrees (`launchAgent({branch})`) + aggregation card.
- Goal-sharpening model call; "dispatch complete" summary message; worktree auto-trust affordance.
