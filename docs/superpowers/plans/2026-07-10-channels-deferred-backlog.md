# Channels Deferred Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the four deferred Channels-tab backlog items — ambient "needs you" attention + Cockpit dedup (A), channel archive (B), per-worker fleet dismiss (C), and consult inheriting the operator's global CLAUDE.md (D).

**Architecture:** Item A is FE-only, driven by one pure helper (`pendingAskCount`) shared by the nav-rail badge and Cockpit counter so they can't disagree. Item B mirrors the shipped `RenameChannelCommand` with a `Channel.Meta` archived flag + a client-side rail partition. Item C persists via a new `dismiss` message kind through the existing `PostChannelMessageCommand` (no new backend command), interpreted in `buildFleetSnapshot`. Item D reads `~/.claude/CLAUDE.md` and injects it as a preamble for non-`claude` consult runtimes only.

**Tech Stack:** React 19 + jotai + Tailwind 4 (frontend); Go + wshrpc (backend); vitest (FE unit); `go test` (Go unit); CDP `:9222` against `cargo tauri dev` (visual verification).

**Spec:** `docs/superpowers/specs/2026-07-10-channels-deferred-backlog-design.md`.

## Global Constraints

- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline clean (exit 0). `npx tsc` stack-overflows on this repo; never use it. Any error it reports is yours.
- **FE unit tests:** `npx vitest run frontend/app/view/agents/<file>.test.ts`.
- **Go unit tests:** `go test ./pkg/consult/`.
- **Never hand-edit generated files.** `task generate` produces `pkg/wshrpc/wshclient/wshclient.go` and `frontend/app/store/wshclientapi.ts` from the Go definitions.
- **Do NOT commit.** The user batches all changes into one commit and approves it (repo git policy is STRICT — never auto-commit). End each task at verification, not a commit.
- **Visual verification:** the dev app must run via `tail -f /dev/null | task dev` (headless `task dev` dies on stdin EOF). Capture with `node scripts/cdp-shot.mjs <out.png>`; drive DOM/keys over raw CDP on `:9222`. **Never** `Page.reload` — it breaks Tauri boot. If the dev app is not running, state the visual step is unverified rather than claiming it passed.
- **Comments:** lower-case, explain "why" not "what", only when necessary (matches the existing files).

---

## Execution ordering

Tasks that share a file must be sequenced (one subagent per task, review between):
- `jarvisderive.ts` / `jarvisderive.test.ts`: **Task 1 → Task 6**.
- `channelssurface.tsx`: **Task 5 → Task 7**.
- `pkg/wshrpc/wshserver/wshserver.go`: **Task 3 → Task 9**.

Recommended order: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**. File-disjoint tasks (4 is `channelderive.ts` only; 8 is `consult.go` only) may run in parallel with unrelated tasks if desired, but the sequential order above is conflict-free.

---

## Task 1: `pendingAskCount` helper (Item A logic) — TDD

**Files:**
- Modify: `frontend/app/view/agents/jarvisderive.ts`
- Test: `frontend/app/view/agents/jarvisderive.test.ts`

**Interfaces:**
- Consumes: `answeredAskORefs(messages)` from `./jarviscards` (already exists), `AgentVM` from `./agentsviewmodel`.
- Produces: `pendingAskCount(channels: Channel[], agents: AgentVM[]): number` — used by Task 2 (nav badge + Cockpit counter).

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/agents/jarvisderive.test.ts`, add `pendingAskCount` to the existing import from `./jarvisderive`, and append:

```ts
describe("pendingAskCount", () => {
    const answeredCard = (askORef: string) =>
        JSON.stringify({ askORef, workerORef: "tab:x", question: "q", options: [{ label: "y" }], choice: 0 });
    const chan = (msgs: unknown[]) => ({ name: "c", messages: msgs }) as unknown as Channel;
    const agent = (id: string, state: string, askoref?: string) =>
        ({
            id,
            name: "claude",
            state,
            ask: askoref ? { oref: askoref, questions: [{ question: "q?" }] } : undefined,
        }) as unknown as AgentVM;

    it("counts an asking worker with no answered card", () => {
        expect(pendingAskCount([chan([])], [agent("w1", "asking", "block:a")])).toBe(1);
    });
    it("drops an asking worker whose ask Jarvis already answered", () => {
        const msgs = [{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:a") }];
        expect(pendingAskCount([chan(msgs)], [agent("w1", "asking", "block:a")])).toBe(0);
    });
    it("keeps a NEW ask from a worker whose PREVIOUS ask was answered", () => {
        const msgs = [{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:old") }];
        expect(pendingAskCount([chan(msgs)], [agent("w1", "asking", "block:new")])).toBe(1);
    });
    it("ignores non-asking workers", () => {
        expect(pendingAskCount([chan([])], [agent("w1", "working")])).toBe(0);
    });
    it("dedupes an ask answered in ANY channel", () => {
        const answered = chan([{ id: "1", kind: "jarvis-answered", author: "jarvis", text: "", ts: 0, data: answeredCard("block:a") }]);
        expect(pendingAskCount([chan([]), answered], [agent("w1", "asking", "block:a")])).toBe(0);
    });
    it("is 0 for no channels and no agents", () => {
        expect(pendingAskCount([], [])).toBe(0);
    });
});
```

(If `AgentVM`/`Channel` are not already imported in the test file, add `import type { AgentVM } from "./agentsviewmodel";` — `Channel` is a global ambient type used elsewhere in the file, no import needed.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts -t pendingAskCount`
Expected: FAIL — `pendingAskCount is not a function` / not exported.

- [ ] **Step 3: Implement `pendingAskCount`**

In `frontend/app/view/agents/jarvisderive.ts`, add `import { answeredAskORefs } from "./jarviscards";` under the existing `AgentVM` import (line 8), then append at the end of the file:

```ts
// Fleet-wide count of workers genuinely blocked on the human: asking, minus any ask Jarvis has already
// auto-answered (a jarvis-answered card exists for that ask oref) across ALL channels. Single source of
// truth for the nav-rail badge and the Cockpit "need you" counter, so they cannot disagree — and it
// drops Jarvis-answered asks, which the Cockpit counter historically over-counted.
export function pendingAskCount(channels: Channel[], agents: AgentVM[]): number {
    const answered = new Set<string>();
    for (const ch of channels) {
        for (const o of answeredAskORefs(ch.messages ?? [])) {
            answered.add(o);
        }
    }
    return agents.filter((a) => a.state === "asking" && !(a.ask?.oref && answered.has(a.ask.oref))).length;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts`
Expected: PASS (existing tests + 6 new). No import cycle: `jarvisderive` → `jarviscards` → `channelmessages` (jarviscards does not import jarvisderive).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

## Task 2: Nav-rail badge + Cockpit counter dedup (Item A wiring)

**Files:**
- Modify: `frontend/app/view/agents/navrail.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx:787`

**Interfaces:**
- Consumes: `pendingAskCount` (Task 1), `channelsAtom` from `./channelsstore`, `model.agentsAtom`.

- [ ] **Step 1: Badge the Channels nav item**

In `frontend/app/view/agents/navrail.tsx`:

1. Change the jotai import (line 5) to add `useAtomValue`:
```tsx
import { useAtom, useAtomValue } from "jotai";
```
2. Add imports after the `AgentsViewModel` type import (line 17):
```tsx
import { channelsAtom } from "./channelsstore";
import { pendingAskCount } from "./jarvisderive";
```
3. Inside `NavRail`, after the `useAtom(model.surfaceAtom)` line (line 44), add:
```tsx
    const channels = useAtomValue(channelsAtom);
    const agents = useAtomValue(model.agentsAtom);
    const needsYou = pendingAskCount(channels ?? [], agents);
```
4. Change `renderItem` (line 45) to accept a badge count and render it over the icon:
```tsx
    const renderItem = (key: SurfaceKey, label: string, badge = 0) => {
        const isActive = active === key;
        return (
            <button
                key={key}
                type="button"
                onClick={() => setActive(key)}
                className={cn(
                    "relative mx-2 flex cursor-pointer flex-col items-center gap-[5px] rounded-[10px] border-0 bg-transparent py-[11px] text-muted hover:text-muted-foreground",
                    isActive && "text-accent-soft"
                )}
            >
                {isActive ? (
                    <>
                        <span className="absolute inset-0 rounded-[10px] bg-accent/10" />
                        <span className="absolute left-[-8px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-[3px] bg-accent" />
                    </>
                ) : null}
                <span className="relative z-[1]">
                    {ICON[key]}
                    {badge > 0 ? (
                        <span className="absolute -right-2 -top-1.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-asking px-1 font-mono text-[9px] font-bold text-background">
                            {badge}
                        </span>
                    ) : null}
                </span>
                <span className="relative z-[1] text-[10px] font-semibold">{label}</span>
            </button>
        );
    };
```
5. Pass the count only to the `channels` item (line 70):
```tsx
            {ITEMS.map(({ key, label }) => renderItem(key, label, key === "channels" ? needsYou : 0))}
```

- [ ] **Step 2: Route the Cockpit counter through the same helper**

In `frontend/app/view/agents/cockpitsurface.tsx`:

1. Add imports (near the other `./` imports — place beside the existing agents-view imports): `import { channelsAtom } from "./channelsstore";` and `import { pendingAskCount } from "./jarvisderive";` (add `pendingAskCount` to an existing `./jarvisderive` import if one is present).
2. In `CockpitSurface`, after `const { asking, working, idle } = groupAgents(agents);` (line 221), add:
```tsx
    // channel-aware "needs you": excludes asks Jarvis already auto-answered, so it matches the Channels
    // rail dot and nav badge (the raw asking.length historically over-counted).
    const channels = useAtomValue(channelsAtom);
    const needsYou = pendingAskCount(channels ?? [], agents);
```
3. Replace the counter at line 787:
```tsx
                                <RollingCount value={needsYou} /> need you
```
(`asking` stays in use for the grouping/layout below — only the displayed count changes.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verify (dev app, best-effort)**

With the dev app running and a channel whose dispatched worker is `asking`: confirm a count badge appears on the Channels nav item and the Cockpit "N need you" matches it; answering the ask (or a Jarvis auto-answer) clears both. Reproducing a live asking state over CDP may be impractical — if so, rely on Task 1's unit tests and mark this unverified with that reason. Capture `scripts/cdp-shot.mjs` if reproducible.

---

## Task 3: `ArchiveChannelCommand` backend + regen (Item B backend)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wstore/wstore_channel.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Generated (via `task generate`, do NOT hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Produces: `RpcApi.ArchiveChannelCommand(client, { channelid, archived })` (TS) and `wstore.MetaKey_Archived` (Go) — used by Task 5.

- [ ] **Step 1: Declare the command + data struct**

In `pkg/wshrpc/wshrpctypes.go`, after the `RenameChannelCommand` interface line (line 126), add:
```go
	ArchiveChannelCommand(ctx context.Context, data CommandArchiveChannelData) error // archives/unarchives a channel (hides it from the active rail list; kept, not deleted)
```

After `CommandRenameChannelData` (ends line 780), add:
```go
type CommandArchiveChannelData struct {
	ChannelId string `json:"channelid"`
	Archived  bool   `json:"archived"`
}
```

- [ ] **Step 2: Add the meta key constant**

In `pkg/wstore/wstore_channel.go`, after `const MetaKey_ReadTs = "read:ts"` (line 134), add:
```go
// MetaKey_Archived hides a channel from the active rail list. Reversible; the channel is kept, not deleted.
const MetaKey_Archived = "archived"
```

- [ ] **Step 3: Implement the server command**

In `pkg/wshrpc/wshserver/wshserver.go`, after `RenameChannelCommand` (ends ~line 1849, the function returning after `SendWaveObjUpdate`), add:
```go
func (ws *WshServer) ArchiveChannelCommand(ctx context.Context, data wshrpc.CommandArchiveChannelData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[wstore.MetaKey_Archived] = data.Archived
	})
	if err != nil {
		return fmt.Errorf("updating channel archived flag: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: exit 0. Verify with `grep -rn "ArchiveChannelCommand" frontend/app/store/wshclientapi.ts pkg/wshrpc/wshclient/wshclient.go` — hits in both (do not hand-edit them).

- [ ] **Step 5: Build the backend**

Run: `task build:backend`
Expected: exit 0. (If the running dev app must exercise archive, restart `task dev` after this so it picks up the new backend.)

- [ ] **Step 6: Frontend typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (generated `wshclientapi.ts` typechecks; no FE callers yet).

---

## Task 4: `partitionChannels` helper (Item B logic) — TDD

**Files:**
- Modify: `frontend/app/view/agents/channelderive.ts`
- Test: `frontend/app/view/agents/channelderive.test.ts`

**Interfaces:**
- Produces: `partitionChannels(channels: Channel[]): { active: Channel[]; archived: Channel[] }` — used by Task 5.

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/agents/channelderive.test.ts`, add `partitionChannels` to the existing `./channelderive` import, and append:
```ts
describe("partitionChannels", () => {
    const ch = (name: string, archived?: boolean): Channel =>
        ({ oid: name, name, createdts: 0, messages: [], meta: archived ? { archived: true } : {} }) as unknown as Channel;
    it("puts everything in active when nothing is archived", () => {
        const { active, archived } = partitionChannels([ch("a"), ch("b")]);
        expect(active.map((c) => c.name)).toEqual(["a", "b"]);
        expect(archived).toHaveLength(0);
    });
    it("splits archived out of active, preserving order", () => {
        const { active, archived } = partitionChannels([ch("a"), ch("b", true), ch("c")]);
        expect(active.map((c) => c.name)).toEqual(["a", "c"]);
        expect(archived.map((c) => c.name)).toEqual(["b"]);
    });
    it("composes with filterChannels (filter first, then partition)", () => {
        const list = [ch("wave"), ch("wave-old", true), ch("other")];
        const { active, archived } = partitionChannels(filterChannels(list, "wave"));
        expect(active.map((c) => c.name)).toEqual(["wave"]);
        expect(archived.map((c) => c.name)).toEqual(["wave-old"]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts -t partitionChannels`
Expected: FAIL — `partitionChannels is not a function`.

- [ ] **Step 3: Implement `partitionChannels`**

In `frontend/app/view/agents/channelderive.ts`, after `filterChannels` (ends line 27), add:
```ts
export interface ChannelPartition {
    active: Channel[];
    archived: Channel[];
}

// Split channels into active vs archived by the "archived" meta flag (see wstore.MetaKey_Archived). The
// rail shows active rows and tucks archived ones under a collapsible "Archived · N" disclosure. Order-preserving.
export function partitionChannels(channels: Channel[]): ChannelPartition {
    const active: Channel[] = [];
    const archived: Channel[] = [];
    for (const c of channels) {
        if ((c.meta as Record<string, unknown> | undefined)?.["archived"] === true) {
            archived.push(c);
        } else {
            active.push(c);
        }
    }
    return { active, archived };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/channelderive.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

## Task 5: Archive affordance in the rail (Item B UI) — depends on Tasks 3 + 4

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts`
- Modify: `frontend/app/view/agents/channelrail.tsx`
- Modify: `frontend/app/view/agents/channelssurface.tsx` (pass the new prop to `<ChannelRail>`)

**Interfaces:**
- Consumes: `RpcApi.ArchiveChannelCommand` (Task 3), `partitionChannels` (Task 4).
- Produces: `archiveChannel(channelId, archived)` in `channelsstore.ts`; `onArchiveChannel` prop on `ChannelRail`.

- [ ] **Step 1: Add `archiveChannel` to the store**

In `frontend/app/view/agents/channelsstore.ts`, after `renameChannel` (ends line 79), add:
```ts
// Archive/unarchive a channel (a Channel.Meta flag), then refresh the snapshot-fed rail. Mirrors
// setChannelTier/renameChannel — the rail reads the channelsAtom snapshot, so it needs a re-fetch.
export async function archiveChannel(channelId: string, archived: boolean): Promise<void> {
    await RpcApi.ArchiveChannelCommand(TabRpcClient, { channelid: channelId, archived });
    await loadChannels();
}
```

- [ ] **Step 2: Add the prop + state + partition to the rail**

In `frontend/app/view/agents/channelrail.tsx`:

1. Add `partitionChannels` to the `./channelderive` import (line 12):
```tsx
import { channelHasAsk, filterChannels, partitionChannels } from "./channelderive";
```
2. Add the prop to the props type (after `onRenameChannel`, line 39) and to the destructured params (line 27 block):
```tsx
    onArchiveChannel: (id: string, archived: boolean) => void;
```
3. Replace the `filtered` memo (line 44) with a partitioned memo + an archived-disclosure state:
```tsx
    const { active, archived } = useMemo(
        () => partitionChannels(filterChannels(channels ?? [], query)),
        [channels, query]
    );
    const [showArchived, setShowArchived] = useState(false);
```

- [ ] **Step 3: Render the active list + add the Archive menu item**

In `channelrail.tsx`:

1. Change the channel-list map source (line 81) from `{filtered.map((c) => {` to `{active.map((c) => {`.
2. In the row context menu, add an "Archive channel" item after the "Rename channel" item (after line 114, before the `{ type: "separator" }` at line 115):
```tsx
                                        {
                                            label: "Archive channel",
                                            click: () => onArchiveChannel(c.oid, true),
                                        },
```

- [ ] **Step 4: Render the "Archived · N" disclosure**

In `channelrail.tsx`, immediately after the `})}` that closes the `active.map(...)` block (the closing of the channel-list map, before the "+ New channel" button / picker block), add:
```tsx
                {archived.length > 0 ? (
                    <div className="mt-2 border-t border-edge-faint pt-2">
                        <button
                            type="button"
                            onClick={() => setShowArchived((v) => !v)}
                            className="mb-1 flex w-full cursor-pointer items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-[.09em] text-muted hover:text-secondary"
                        >
                            <span>{showArchived ? "▾" : "▸"}</span> Archived · {archived.length}
                        </button>
                        {showArchived
                            ? archived.map((c) => (
                                  <div
                                      key={c.oid}
                                      className="group flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 hover:bg-surface-hover"
                                  >
                                      <button
                                          type="button"
                                          onClick={() => onSelect(c.oid)}
                                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                                      >
                                          <span className="font-mono text-[12px] text-muted">#</span>
                                          <span className="flex-1 truncate text-[12px] text-muted">{c.name}</span>
                                      </button>
                                      <button
                                          type="button"
                                          title="Unarchive"
                                          onClick={() => onArchiveChannel(c.oid, false)}
                                          className="flex-none cursor-pointer rounded-[5px] border border-edge-mid bg-surface-raised px-1.5 py-0.5 font-mono text-[9px] font-semibold text-ink-mid opacity-0 hover:border-accent hover:text-accent group-hover:opacity-100"
                                      >
                                          Unarchive
                                      </button>
                                  </div>
                              ))
                            : null}
                    </div>
                ) : null}
```

- [ ] **Step 5: Pass the prop from the surface**

In `frontend/app/view/agents/channelssurface.tsx`:
1. Add `archiveChannel` to the `./channelsstore` import block (the block importing `renameChannel`, `setChannelTier`, etc.).
2. On the `<ChannelRail>` element (the block with `onRenameChannel={...}`), add:
```tsx
                    onArchiveChannel={(id, archived) => fireAndForget(() => archiveChannel(id, archived))}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 7: Visual verify (dev app — requires the Task 3 backend build)**

With the rebuilt dev app running: right-click a rail row → "Archive channel"; confirm it leaves the active list and appears under "Archived · N"; expand the disclosure and click "Unarchive" → it returns to the active list. Archive a channel, cycle to another nav tab and back → confirm it stays archived (proves the meta write + snapshot refresh). Capture. If dev app not running, mark unverified.

---

## Task 6: Per-worker dismiss in `buildFleetSnapshot` (Item C logic) — TDD — depends on Task 1

**Files:**
- Modify: `frontend/app/view/agents/jarvisderive.ts`
- Test: `frontend/app/view/agents/jarvisderive.test.ts`

**Interfaces:**
- Produces: `buildFleetSnapshot` now hides a gone worker whose latest `dismiss` message is newer than its latest `dispatch`/`directive`. Consumed by Task 7's UI (the dismiss message it posts) and all existing `buildFleetSnapshot` callers.

- [ ] **Step 1: Write the failing tests**

In `frontend/app/view/agents/jarvisderive.test.ts`, append:
```ts
describe("buildFleetSnapshot dismiss", () => {
    const dispatch = (oref: string, ts: number) => ({ id: String(ts), kind: "dispatch", author: "claude", text: "go", reforef: oref, ts });
    const dismiss = (oref: string, ts: number) => ({ id: "d" + ts, kind: "dismiss", author: "you", text: "", reforef: oref, ts });
    const chan = (msgs: unknown[]) => ({ name: "c", messages: msgs }) as unknown as Channel;

    it("hides a gone worker dismissed after its dispatch", () => {
        const snap = buildFleetSnapshot(chan([dispatch("tab:w1", 1), dismiss("tab:w1", 2)]), [] as unknown as AgentVM[]);
        expect(snap.find((w) => w.oref === "tab:w1")).toBeUndefined();
    });
    it("keeps a gone worker re-dispatched after its dismiss", () => {
        const snap = buildFleetSnapshot(chan([dispatch("tab:w1", 1), dismiss("tab:w1", 2), dispatch("tab:w1", 3)]), [] as unknown as AgentVM[]);
        expect(snap.find((w) => w.oref === "tab:w1")?.state).toBe("gone");
    });
    it("never hides a live worker even if a dismiss exists", () => {
        const agents = [{ id: "w1", name: "claude", state: "working", task: "" }] as unknown as AgentVM[];
        const snap = buildFleetSnapshot(chan([dispatch("tab:w1", 1), dismiss("tab:w1", 2)]), agents);
        expect(snap.find((w) => w.oref === "tab:w1")?.state).toBe("working");
    });
    it("ignores a dismiss for an oref never dispatched", () => {
        const snap = buildFleetSnapshot(chan([dispatch("tab:w1", 1), dismiss("tab:ghost", 2)]), [] as unknown as AgentVM[]);
        expect(snap).toHaveLength(1);
        expect(snap[0].oref).toBe("tab:w1");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts -t "buildFleetSnapshot dismiss"`
Expected: FAIL — the dismissed gone worker still appears / re-dispatch test may pass by luck but "hides a gone worker dismissed after its dispatch" fails.

- [ ] **Step 3: Implement dismiss handling in `buildFleetSnapshot`**

In `frontend/app/view/agents/jarvisderive.ts`, modify `buildFleetSnapshot` (lines 26-58). Add two maps and populate them in the message loop, then filter the result:

Replace the message loop + return (lines 27-57) with:
```ts
    const orefs: string[] = [];
    const dispatchInfo = new Map<string, { name: string; task?: string }>();
    const activeTs = new Map<string, number>(); // latest dispatch/directive ts per oref
    const dismissTs = new Map<string, number>(); // latest dismiss ts per oref
    for (const m of channel.messages ?? []) {
        if (!m.reforef?.startsWith(OREF_PREFIX)) {
            continue;
        }
        if (m.kind === "dispatch" && !dispatchInfo.has(m.reforef)) {
            dispatchInfo.set(m.reforef, { name: m.author, task: m.text || undefined });
        }
        if (m.kind === "dispatch" || m.kind === "directive") {
            if (!orefs.includes(m.reforef)) {
                orefs.push(m.reforef);
            }
            activeTs.set(m.reforef, Math.max(activeTs.get(m.reforef) ?? 0, m.ts));
        }
        if (m.kind === "dismiss") {
            dismissTs.set(m.reforef, Math.max(dismissTs.get(m.reforef) ?? 0, m.ts));
        }
    }
    return orefs
        .map((oref): WorkerState => {
            const id = oref.slice(OREF_PREFIX.length);
            const dispatchTask = dispatchInfo.get(oref)?.task;
            const live = agents.find((a) => a.id === id);
            if (live) {
                return {
                    oref,
                    name: live.name,
                    state: live.state,
                    task: live.task || undefined,
                    dispatchTask,
                    askText: live.state === "asking" ? live.ask?.questions?.[0]?.question : undefined,
                    askORef: live.state === "asking" ? live.ask?.oref : undefined,
                };
            }
            const info = dispatchInfo.get(oref);
            return { oref, name: info?.name ?? "worker", state: "gone" as const, task: info?.task, dispatchTask };
        })
        // a gone worker dismissed after its last dispatch/directive drops out; a later re-dispatch
        // (newer activeTs) brings it back. live workers are never hidden.
        .filter((w) => w.state !== "gone" || (dismissTs.get(w.oref) ?? 0) <= (activeTs.get(w.oref) ?? 0));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/jarvisderive.test.ts`
Expected: PASS (Task 1's tests + the dismiss suite + any pre-existing `buildFleetSnapshot` tests — confirm none regressed).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

## Task 7: Dismiss affordance on `WorkerRow` (Item C UI) — depends on Tasks 5 + 6

**Files:**
- Modify: `frontend/app/view/agents/channelactions.ts`
- Modify: `frontend/app/view/agents/channelsprimitives.tsx` (`WorkerRow`)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`ContextPanel` gone-worker rows)

**Interfaces:**
- Consumes: `post` (existing, in `channelactions.ts`), the dismiss message-kind handling from Task 6.
- Produces: `dismissWorker(channelId, workerORef)` in `channelactions.ts`; `WorkerRow` gains optional `channelId` + `onDismiss` props.

- [ ] **Step 1: Add the `dismissWorker` action**

In `frontend/app/view/agents/channelactions.ts`, after the `post` helper (ends line 42), add:
```ts
// Dismiss a finished ("gone") worker from a channel's fleet panel by posting a dismiss message; the
// snapshot subtracts it (a later re-dispatch of the same oref supersedes the dismiss). Fire-and-forget.
export async function dismissWorker(channelId: string, workerORef: string): Promise<void> {
    await post(channelId, "dismiss", "you", "", workerORef);
}
```

- [ ] **Step 2: Add the Dismiss menu item to `WorkerRow`**

In `frontend/app/view/agents/channelsprimitives.tsx`, change the `WorkerRow` signature and context menu (lines 118-133):
```tsx
export function WorkerRow({
    model,
    w,
    channelId,
    onDismiss,
}: {
    model: AgentsViewModel;
    w: WorkerState;
    channelId?: string;
    onDismiss?: (channelId: string, oref: string) => void;
}) {
    return (
        <div
            className="mb-2.5"
            onContextMenu={(ev) =>
                ContextMenuModel.getInstance().showContextMenu(
                    [
                        {
                            label: "Open agent",
                            enabled: w.state !== "gone",
                            click: () => jumpToAgent(model, w.oref.slice("tab:".length)),
                        },
                        ...(w.state === "gone" && channelId && onDismiss
                            ? [{ label: "Dismiss", click: () => onDismiss(channelId, w.oref) }]
                            : []),
                    ],
                    ev
                )
            }
        >
```
(The rest of `WorkerRow`'s body is unchanged.)

- [ ] **Step 3: Wire the gone-worker rows in `ContextPanel`**

In `frontend/app/view/agents/channelssurface.tsx`:
1. Add `dismissWorker` to the `./channelactions` import.
2. In `ContextPanel`, change the gone-workers render (line 811) to pass the channel id + dismiss callback:
```tsx
                                    {showGone
                                        ? goneWorkers.map((w) => (
                                              <WorkerRow
                                                  key={w.oref}
                                                  model={model}
                                                  w={w}
                                                  channelId={channel?.oid}
                                                  onDismiss={(cid, oref) => fireAndForget(() => dismissWorker(cid, oref))}
                                              />
                                          ))
                                        : null}
```
(Confirm `fireAndForget` is already imported in `channelssurface.tsx`; it is used by the rail handlers. If not, add it from `@/util/util`.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verify (dev app)**

With the dev app running and a channel that has a gone worker under "Done · N": right-click the gone row → "Dismiss"; confirm it disappears from the Done list. Cycle nav tabs / reselect the channel → confirm it stays gone (proves persistence via the dismiss message). Confirm a live worker's context menu has no "Dismiss". If dev app not running, mark unverified.

---

## Task 8: Consult `OperatorPrinciples` + `BuildPrompt` preamble (Item D logic) — TDD

**Files:**
- Modify: `pkg/consult/consult.go`
- Test: `pkg/consult/consult_test.go` (create if absent)

**Interfaces:**
- Produces: `consult.OperatorPrinciples() (string, error)`; `consult.BuildPrompt(history, userPrompt, principles string) string` (new third param). Consumed by Task 9.

- [ ] **Step 1: Write the failing tests**

Create/append `pkg/consult/consult_test.go`:
```go
package consult

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestBuildPromptNoPrinciplesMatchesLegacy(t *testing.T) {
	history := []waveobj.ChannelMessage{{Author: "you", Text: "hello"}}
	got := BuildPrompt(history, "do the thing", "")
	if !strings.Contains(got, "Recent channel conversation") || !strings.Contains(got, "do the thing") {
		t.Fatalf("expected context + request body, got: %q", got)
	}
	if strings.Contains(got, "Operator principles") {
		t.Fatalf("empty principles must not add a preamble, got: %q", got)
	}
}

func TestBuildPromptEmptyHistoryEmptyPrinciplesIsBarePrompt(t *testing.T) {
	if got := BuildPrompt(nil, "just this", ""); got != "just this" {
		t.Fatalf("expected bare prompt, got: %q", got)
	}
}

func TestBuildPromptPrependsPrinciples(t *testing.T) {
	got := BuildPrompt(nil, "review this", "Always prefer KISS.")
	if !strings.HasPrefix(got, "Operator principles (follow these):\nAlways prefer KISS.") {
		t.Fatalf("expected principles preamble first, got: %q", got)
	}
	if !strings.Contains(got, "review this") {
		t.Fatalf("expected the request to survive, got: %q", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/consult/ -run TestBuildPrompt`
Expected: FAIL to **compile** — `BuildPrompt` currently takes 2 args, tests pass 3.

- [ ] **Step 3: Implement `OperatorPrinciples` + the new `BuildPrompt` param**

In `pkg/consult/consult.go`:
1. Extend the import block (lines 11-16) to add `errors`, `os`, `path/filepath`, and `wavebase`:
```go
import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)
```
2. Add `OperatorPrinciples` (e.g. after `SupportedRuntimes`, line 115):
```go
// OperatorPrinciples returns the operator's global ~/.claude/CLAUDE.md, or "" if there is none. A
// missing file is normal (not every operator keeps global principles); only a real read error propagates.
func OperatorPrinciples() (string, error) {
	path := filepath.Join(wavebase.GetHomeDir(), ".claude", "CLAUDE.md")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(b), nil
}
```
3. Change `BuildPrompt` (lines 119-142) to take `principles` and prepend it (NOT subject to the history char cap):
```go
// BuildPrompt folds a capped tail of channel history into the user's prompt as context, and — when
// principles is non-empty — prepends the operator's global principles verbatim (not capped: truncating
// a principles document mid-sentence would mislead the consulted agent).
func BuildPrompt(history []waveobj.ChannelMessage, userPrompt, principles string) string {
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
	var body string
	if strings.TrimSpace(ctxStr) == "" {
		body = userPrompt
	} else {
		body = "Recent channel conversation for context:\n" + ctxStr + "\nRequest:\n" + userPrompt
	}
	if strings.TrimSpace(principles) != "" {
		return "Operator principles (follow these):\n" + principles + "\n\n" + body
	}
	return body
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/consult/`
Expected: PASS.

- [ ] **Step 5: Confirm no other caller breaks**

Run: `grep -rn "consult.BuildPrompt\|BuildPrompt(" pkg/ | grep -v _test.go`
Expected: the only non-test caller is `pkg/wshrpc/wshserver/wshserver.go` (updated in Task 9). If any other caller exists, note it — Task 9 must update every caller (the signature changed).

---

## Task 9: Consult server injects principles for non-claude runtimes (Item D wiring) — depends on Tasks 3 + 8

**Files:**
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (`ConsultCommand`, line 2196)

**Interfaces:**
- Consumes: `consult.OperatorPrinciples()`, `consult.BuildPrompt(history, prompt, principles)` (Task 8).

- [ ] **Step 1: Gate the principles on runtime and pass them to BuildPrompt**

In `pkg/wshrpc/wshserver/wshserver.go`, replace line 2196:
```go
		prompt := consult.BuildPrompt(ch.Messages, data.Prompt)
```
with:
```go
		// claude discovers ~/.claude/CLAUDE.md itself (it runs with cwd = project path); other runtimes
		// don't, so inject the operator's global principles for them. A read failure must not fail the
		// consult — log and continue with none.
		var principles string
		if data.Runtime != "claude" {
			p, perr := consult.OperatorPrinciples()
			if perr != nil {
				log.Printf("consult: reading operator principles: %v", perr)
			}
			principles = p
		}
		prompt := consult.BuildPrompt(ch.Messages, data.Prompt, principles)
```
(Confirm `log` is imported in `wshserver.go` — it is used widely. If somehow absent, add `"log"` to the import block.)

- [ ] **Step 2: Build the backend**

Run: `task build:backend`
Expected: exit 0 (Go compiles with the updated `BuildPrompt` signature and the new call).

- [ ] **Step 3: Verify (behavioral note, not automated)**

`claude` consults are unchanged by construction (`principles` is always ""). `codex`/`antigravity` consults now carry the "Operator principles (follow these):" preamble read from `~/.claude/CLAUDE.md`. Driving a real external CLI is out of scope for automated tests; state this as verified-by-construction + Task 8's unit tests, not by a live run. (No `task generate` needed — `BuildPrompt`/`OperatorPrinciples` are internal Go; the `ConsultCommand` wire signature is unchanged.)

---

## Final verification (after all tasks)

- [ ] `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
- [ ] `npx vitest run frontend/app/view/agents/` → all PASS (new: `pendingAskCount`, `partitionChannels`, `buildFleetSnapshot dismiss`).
- [ ] `go test ./pkg/consult/` → PASS.
- [ ] `task build:backend` → exit 0.
- [ ] Update `docs/agents/channels-improvements.md`: mark #8 (in-app attention badge + Cockpit dedup), #3 (archive), and #9 (per-worker dismiss) shipped, and note §C10 (consult global CLAUDE.md) shipped for non-claude runtimes. Note the OS/taskbar badge remains deferred (in-app only, per the 2026-07-10 decision).

## Self-Review

- **Spec coverage:** A → Tasks 1+2 (helper, nav badge, Cockpit dedup); B → Tasks 3+4+5 (backend command, partition helper, rail UI); C → Tasks 6+7 (snapshot logic, WorkerRow dismiss); D → Tasks 8+9 (consult helper + prompt param, server wiring). Non-goals (OS badge, Sessions reconciliation, bulk archive, dismiss-all) carry no task, matching the spec.
- **Placeholder scan:** every code step shows the actual code; test steps show real assertions; no TBD/"handle errors"/"similar to".
- **Type consistency:** `pendingAskCount(channels, agents)` identical in Tasks 1/2; `partitionChannels(channels) → {active, archived}` identical in Tasks 4/5; `archiveChannel(channelId, archived)` ↔ `RpcApi.ArchiveChannelCommand({channelid, archived})` ↔ `CommandArchiveChannelData{ChannelId, Archived}`; `dismissWorker(channelId, workerORef)` posts kind `"dismiss"` which Task 6's `buildFleetSnapshot` reads; `BuildPrompt(history, userPrompt, principles)` signature identical in Tasks 8/9; `wstore.MetaKey_Archived = "archived"` matches the `"archived"` key read in `partitionChannels`.
- **Conflict check:** shared-file sequencing (jarvisderive.ts 1→6, channelssurface.tsx 5→7, wshserver.go 3→9) is stated in Execution ordering and each task's dependency line.
