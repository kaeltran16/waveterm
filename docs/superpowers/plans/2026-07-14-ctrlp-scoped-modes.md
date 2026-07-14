# Ctrl+P Scoped Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sigil-driven scoped modes to the `Ctrl+P` command palette (`>` commands, `@` agents, `/` sessions, `#` channels) while leaving today's default behavior unchanged.

**Architecture:** One new pure module (`palette-scope.ts`) parses the leading sigil into `{ scope, sub, channelLaunch }`; `command-palette.tsx` branches on that to render a single narrowed group per scope, adds a channel-picker group, and generalizes the existing launch group to target a *picked* channel (`#backend fix auth`) as well as the active one. No Go, no `task generate`.

**Tech Stack:** React 19 + jotai + Tailwind 4, TypeScript, vitest. Reuses the existing `palette-match.ts` fuzzy matcher and `palette-launch.ts` builder.

## Global Constraints

- **Colors:** no raw hex/rgba. This feature reuses existing `@theme` utility classes only — no new colors needed. (See CLAUDE.md / no-hardcoded-colors rule.)
- **Generated files:** none touched. No `task generate`.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo; baseline is clean → any error is yours).
- **Tests:** vitest. Single file: `npx vitest run frontend/app/cockpit/palette-scope.test.ts`.
- **Git (user workflow — overrides the skill's per-task commits):** do NOT commit or push without explicit user approval. Batch ALL changes into ONE commit at the end. The per-task steps below say **"Stage"** (not commit); the single approved commit happens in the final task, and this plan + the spec fold into that same feature commit — never a separate docs commit.
- **Visual verification:** there is no jsdom render harness for the cockpit. Verify UI by screenshotting the live dev app over CDP (`node scripts/cdp-shot.mjs`), or manually in the running dev app.

## File Structure

- **Create** `frontend/app/cockpit/palette-scope.ts` — pure `parseScope(query)` + `resolveChannelToken(token, channels)`. One responsibility: turn the raw query string into a scope decision. No React, no atoms.
- **Create** `frontend/app/cockpit/palette-scope.test.ts` — unit tests for the pure module.
- **Modify** `frontend/app/cockpit/command-palette.tsx` — consume `parseScope`, branch rendering, add channel items + `#`-launch generalization, footer legend, placeholder.

---

### Task 1: `palette-scope.ts` — pure scope parser (TDD)

**Files:**
- Create: `frontend/app/cockpit/palette-scope.ts`
- Test: `frontend/app/cockpit/palette-scope.test.ts`

**Interfaces:**
- Consumes: `fuzzyScore` from `./palette-match` (`(query: string, text: string) => number | null`).
- Produces:
  - `type Scope = "default" | "command" | "agent" | "session" | "channel"`
  - `interface ChannelLaunch { token: string; goal: string }`
  - `interface ParsedScope { scope: Scope; sub: string; channelLaunch: ChannelLaunch | null }`
  - `parseScope(query: string): ParsedScope`
  - `resolveChannelToken<T extends { name: string }>(token: string, channels: T[]): T | undefined`

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/cockpit/palette-scope.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseScope, resolveChannelToken } from "./palette-scope";

describe("parseScope", () => {
    it("treats plain text as the default scope", () => {
        expect(parseScope("fix the auth bug")).toEqual({ scope: "default", sub: "", channelLaunch: null });
    });
    it("only triggers a scope when the sigil is the first char", () => {
        expect(parseScope("fix #123 bug").scope).toBe("default");
        expect(parseScope("see @claude later").scope).toBe("default");
    });
    it("maps each sigil to its scope with the remainder as sub", () => {
        expect(parseScope(">files")).toMatchObject({ scope: "command", sub: "files" });
        expect(parseScope("@auth")).toMatchObject({ scope: "agent", sub: "auth" });
        expect(parseScope("/main")).toMatchObject({ scope: "session", sub: "main" });
    });
    it("returns a bare scope (empty sub) for a lone sigil", () => {
        expect(parseScope(">")).toMatchObject({ scope: "command", sub: "" });
        expect(parseScope("@")).toMatchObject({ scope: "agent", sub: "" });
        expect(parseScope("#")).toMatchObject({ scope: "channel", sub: "", channelLaunch: null });
    });
    it("# with no goal is picker mode (channelLaunch null)", () => {
        expect(parseScope("#back")).toMatchObject({ scope: "channel", sub: "back", channelLaunch: null });
    });
    it("# with a trailing space but no goal stays picker mode", () => {
        expect(parseScope("#backend ")).toMatchObject({ scope: "channel", channelLaunch: null });
    });
    it("# with token + goal is launch mode", () => {
        expect(parseScope("#backend fix the auth bug")).toMatchObject({
            scope: "channel",
            channelLaunch: { token: "backend", goal: "fix the auth bug" },
        });
    });
    it("trims the launch goal", () => {
        expect(parseScope("#backend   fix auth  ").channelLaunch).toEqual({ token: "backend", goal: "fix auth" });
    });
});

describe("resolveChannelToken", () => {
    const channels = [{ name: "backend-api" }, { name: "frontend" }, { name: "Payments" }];
    it("matches an exact name case-insensitively", () => {
        expect(resolveChannelToken("payments", channels)).toEqual({ name: "Payments" });
    });
    it("falls back to the best fuzzy match", () => {
        expect(resolveChannelToken("backend", channels)).toEqual({ name: "backend-api" });
    });
    it("returns undefined when nothing matches", () => {
        expect(resolveChannelToken("zzzzz", channels)).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/cockpit/palette-scope.test.ts`
Expected: FAIL — `Failed to resolve import "./palette-scope"` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `frontend/app/cockpit/palette-scope.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure parser for the command palette's leading sigil. Turns the raw query into a scope
// decision so command-palette.tsx can render one narrowed group per scope. The sigil only
// triggers at position 0, so a launch goal like "fix #123" stays in the default scope.

import { fuzzyScore } from "./palette-match";

export type Scope = "default" | "command" | "agent" | "session" | "channel";

export interface ChannelLaunch {
    token: string; // channel selector (first whitespace token after '#')
    goal: string; // trimmed goal text after the token
}

export interface ParsedScope {
    scope: Scope;
    sub: string; // filter text within the scope ("" for default)
    channelLaunch: ChannelLaunch | null; // non-null only for a '#<token> <goal>' launch
}

const SIGILS: Record<string, Scope> = { ">": "command", "@": "agent", "/": "session", "#": "channel" };

export function parseScope(query: string): ParsedScope {
    const scope = SIGILS[query[0]];
    if (!scope) {
        return { scope: "default", sub: "", channelLaunch: null };
    }
    const rest = query.slice(1);
    if (scope !== "channel") {
        return { scope, sub: rest, channelLaunch: null };
    }
    // channel: picker unless a whitespace gap after the first token is followed by a real goal.
    const trimmed = rest.replace(/^\s+/, "");
    const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
    if (m && m[2].trim() !== "") {
        return { scope, sub: trimmed, channelLaunch: { token: m[1], goal: m[2].trim() } };
    }
    return { scope, sub: trimmed, channelLaunch: null };
}

// Resolve a channel selector token to a channel: exact (case-insensitive) name first,
// else the best fuzzy match, else undefined.
export function resolveChannelToken<T extends { name: string }>(token: string, channels: T[]): T | undefined {
    const t = token.toLowerCase();
    const exact = channels.find((c) => c.name.toLowerCase() === t);
    if (exact) {
        return exact;
    }
    let best: T | undefined;
    let bestScore = -Infinity;
    for (const c of channels) {
        const s = fuzzyScore(token, c.name);
        if (s != null && s > bestScore) {
            bestScore = s;
            best = c;
        }
    }
    return best;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/cockpit/palette-scope.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean).

- [ ] **Step 6: Stage (do NOT commit — see Global Constraints)**

Run: `git add frontend/app/cockpit/palette-scope.ts frontend/app/cockpit/palette-scope.test.ts`

---

### Task 2: Wire scopes into `command-palette.tsx`

Delivers all scopes end-to-end: narrowing for `>`/`@`/`/`, the `#` channel picker, `#<channel> <goal>` launch into a picked channel, scope-aware empty states, footer legend, and placeholder. One file, one deliverable; verified per-scope via CDP.

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx`

**Interfaces:**
- Consumes (Task 1): `parseScope`, `resolveChannelToken`, `type ParsedScope`.
- Consumes (existing): `channelsAtom`, `selectChannel`, `activeChannelAtom` from `@/app/view/agents/channelsstore`; `buildLaunchItems`/`LaunchDeps` from `./palette-launch`; `rankPaletteItems` from `./palette-match`; `Channel` global type (`{ oid, name, projectpath?, createdts }`).
- Produces: no new exports (component-internal wiring).

- [ ] **Step 1: Extend the channels-store import**

In `frontend/app/cockpit/command-palette.tsx`, replace:

```ts
import { activeChannelAtom } from "@/app/view/agents/channelsstore";
```

with:

```ts
import { activeChannelAtom, channelsAtom, selectChannel } from "@/app/view/agents/channelsstore";
```

- [ ] **Step 2: Add the palette-scope import**

Immediately below the existing `import { buildLaunchItems, type LaunchDeps } from "./palette-launch";` line, add:

```ts
import { parseScope, resolveChannelToken } from "./palette-scope";
```

- [ ] **Step 3: Add "channel" to the palette kinds + group label**

Replace:

```ts
type PaletteKind = "launch" | "command" | "agent" | "session";
```

with:

```ts
type PaletteKind = "launch" | "command" | "agent" | "session" | "channel";
```

Then replace:

```ts
const GROUP_LABELS: Record<Exclude<PaletteKind, "launch">, string> = {
    command: "Commands",
    agent: "Agents",
    session: "Sessions",
};
```

with:

```ts
const GROUP_LABELS: Record<Exclude<PaletteKind, "launch">, string> = {
    command: "Commands",
    agent: "Agents",
    session: "Sessions",
    channel: "Channels",
};
```

- [ ] **Step 4: Read the channels list**

Replace:

```ts
    const channel = useAtomValue(activeChannelAtom);
```

with:

```ts
    const channel = useAtomValue(activeChannelAtom);
    const channels = useAtomValue(channelsAtom);
```

- [ ] **Step 5: Parse the query into a scope + derive the launch target**

Replace:

```ts
    const close = () => globalStore.set(model.paletteOpenAtom, false);
```

with:

```ts
    const close = () => globalStore.set(model.paletteOpenAtom, false);

    // Sigil scope + launch target. In '#<token> <goal>' mode the launch group targets the
    // picked channel; otherwise it targets the active channel (today's behavior). Scopes
    // other than default/channel-launch never show the launch group.
    const parsed = useMemo(() => parseScope(query), [query]);
    const channelLaunch = parsed.scope === "channel" ? parsed.channelLaunch : null;
    const pickedChannel = channelLaunch ? (resolveChannelToken(channelLaunch.token, channels ?? []) ?? null) : null;
    const targetChannel = channelLaunch ? pickedChannel : channel;
    const launchGoal = channelLaunch ? channelLaunch.goal : query;
    const showLaunch = parsed.scope === "default" || (parsed.scope === "channel" && channelLaunch != null);
```

- [ ] **Step 6: Prefetch the Jarvis profile for the launch *target* channel**

Replace the active-channel prefetch effect:

```ts
    useEffect(() => {
        if (!open || !channel) {
            setRunProfile(null);
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const p = await getJarvisProfile(channel.oid);
            if (!cancelled) {
                setRunProfile({ mode: p.resolved?.defaultmode, planGate: p.resolved?.defaultplangate });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, channel?.oid]);
```

with:

```ts
    useEffect(() => {
        if (!open || !targetChannel) {
            setRunProfile(null);
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const p = await getJarvisProfile(targetChannel.oid);
            if (!cancelled) {
                setRunProfile({ mode: p.resolved?.defaultmode, planGate: p.resolved?.defaultplangate });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, targetChannel?.oid]);
```

- [ ] **Step 7: Generalize the launch group to the target channel**

Replace the entire `launchItems` memo:

```ts
    const launchItems = useMemo<PaletteItem[]>(() => {
        if (!channel) {
            return [];
        }
        const fireLaunch = (action: () => Promise<unknown>) => {
            fireAndForget(action);
            globalStore.set(model.surfaceAtom, "channels"); // surface the result, then close
            close();
        };
        const sendText = (text: string) =>
            sendChannelMessage({
                model,
                channelId: channel.oid,
                projectPath: channel.projectpath ?? "",
                projectName: channel.name ?? "agent",
                roster: agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId })),
                agents,
                text,
            });
        const deps: LaunchDeps = {
            dispatch: (runtime, goal) => fireLaunch(() => sendText(`@${runtime} ${goal}`)),
            run: (goal) =>
                fireLaunch(() =>
                    createRun(channel.oid, goal, {
                        mode: runProfile?.mode ?? "pipeline",
                        planGate: runProfile?.planGate ?? true,
                    })
                ),
            consult: (runtime, goal) => fireLaunch(() => sendText(`ask @${runtime} ${goal}`)),
        };
        return buildLaunchItems(query, channel.name, runProfile?.mode, deps).map((li) => ({
            key: li.key,
            kind: "launch" as const,
            search: "",
            title: li.mode,
            run: li.run,
            glyph: li.glyph,
            mode: li.mode,
            suffix: li.suffix,
            desc: li.desc,
            footer: li.footer,
        }));
    }, [query, channel, runProfile, agents, model]);
```

with:

```ts
    const launchItems = useMemo<PaletteItem[]>(() => {
        if (!showLaunch || !targetChannel) {
            return [];
        }
        const ch = targetChannel;
        const fireLaunch = (action: () => Promise<unknown>) => {
            fireAndForget(action);
            globalStore.set(model.surfaceAtom, "channels"); // surface the result, then close
            close();
        };
        const sendText = (text: string) =>
            sendChannelMessage({
                model,
                channelId: ch.oid,
                projectPath: ch.projectpath ?? "",
                projectName: ch.name ?? "agent",
                roster: agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId })),
                agents,
                text,
            });
        const deps: LaunchDeps = {
            dispatch: (runtime, goal) => fireLaunch(() => sendText(`@${runtime} ${goal}`)),
            run: (goal) =>
                fireLaunch(() =>
                    createRun(ch.oid, goal, {
                        mode: runProfile?.mode ?? "pipeline",
                        planGate: runProfile?.planGate ?? true,
                    })
                ),
            consult: (runtime, goal) => fireLaunch(() => sendText(`ask @${runtime} ${goal}`)),
        };
        return buildLaunchItems(launchGoal, ch.name, runProfile?.mode, deps).map((li) => ({
            key: li.key,
            kind: "launch" as const,
            search: "",
            title: li.mode,
            run: li.run,
            glyph: li.glyph,
            mode: li.mode,
            suffix: li.suffix,
            desc: li.desc,
            footer: li.footer,
        }));
    }, [showLaunch, targetChannel, launchGoal, runProfile, agents, model]);

    // Channel picker rows (# scope, no goal). Enter switches the active channel and opens the surface.
    const channelItems = useMemo<PaletteItem[]>(
        () =>
            (channels ?? []).map((c) => ({
                key: `channel:${c.oid}`,
                kind: "channel" as const,
                search: `#${c.name} ${c.projectpath ?? ""}`,
                title: `#${c.name}`,
                subtitle: c.projectpath ? c.projectpath.split(/[\\/]/).pop() : undefined,
                run: () => {
                    fireAndForget(() => selectChannel(c.oid));
                    globalStore.set(model.surfaceAtom, "channels");
                    close();
                },
            })),
        [channels, model]
    );
```

- [ ] **Step 8: Rebuild the groups by scope**

Replace:

```ts
    // rankPaletteItems sorts globally by score; re-grouping by kind preserves per-kind
    // score order (stable sort). Empty query -> natural order in GROUP_ORDER.
    const ranked = useMemo(() => rankPaletteItems(items, query), [items, query]);
    const rankedGroups = GROUP_ORDER.map((kind) => ({ kind, items: ranked.filter((it) => it.kind === kind) })).filter(
        (g) => g.items.length > 0
    );
    // Launch group leads and is never fuzzy-ranked.
    const groups: { kind: PaletteKind; items: PaletteItem[] }[] =
        launchItems.length > 0 ? [{ kind: "launch", items: launchItems }, ...rankedGroups] : rankedGroups;
    const flat = groups.flatMap((g) => g.items);
```

with:

```ts
    // A sigil scope narrows to one group; default keeps today's launch-lead + ranked kinds.
    let groups: { kind: PaletteKind; items: PaletteItem[] }[];
    if (parsed.scope === "channel") {
        if (channelLaunch) {
            groups = launchItems.length > 0 ? [{ kind: "launch", items: launchItems }] : [];
        } else {
            const ranked = rankPaletteItems(channelItems, parsed.sub);
            groups = ranked.length > 0 ? [{ kind: "channel", items: ranked }] : [];
        }
    } else if (parsed.scope === "default") {
        const ranked = rankPaletteItems(items, query);
        groups = GROUP_ORDER.map((kind) => ({ kind, items: ranked.filter((it) => it.kind === kind) })).filter(
            (g) => g.items.length > 0
        );
        if (launchItems.length > 0) {
            groups = [{ kind: "launch", items: launchItems }, ...groups];
        }
    } else {
        const kind = parsed.scope; // "command" | "agent" | "session"
        const ranked = rankPaletteItems(
            items.filter((it) => it.kind === kind),
            parsed.sub
        );
        groups = ranked.length > 0 ? [{ kind, items: ranked }] : [];
    }
    const flat = groups.flatMap((g) => g.items);

    // Scope-aware empty text: a '#<token>' that resolves to nothing vs. an empty channel list.
    const emptyMessage =
        parsed.scope === "channel" && channelLaunch
            ? `No channel matches “${channelLaunch.token}”`
            : parsed.scope === "channel"
              ? "No channels."
              : "No results.";
```

- [ ] **Step 9: Use the scope-aware empty message**

Replace:

```tsx
                        <div className="px-4 py-8 text-center text-[13px] text-muted">No results.</div>
```

with:

```tsx
                        <div className="px-4 py-8 text-center text-[13px] text-muted">{emptyMessage}</div>
```

- [ ] **Step 10: Update the placeholder to hint the sigils**

Replace:

```tsx
                        placeholder="Search agents, sessions, commands…"
```

with:

```tsx
                        placeholder="Search, or type &gt; @ # / to scope…"
```

- [ ] **Step 11: Add the sigil legend to the footer**

Replace:

```tsx
                        ) : (
                            <>
                                <span className="font-mono text-[10.5px] text-muted">↑↓ navigate</span>
                                <span className="font-mono text-[10.5px] text-muted">↵ open</span>
                            </>
                        )}
```

with:

```tsx
                        ) : (
                            <span className="font-mono text-[10.5px] text-muted">
                                <span className="text-secondary">{">"}</span> commands{"  "}
                                <span className="text-secondary">@</span> agents{"  "}
                                <span className="text-secondary">#</span> channels{"  "}
                                <span className="text-secondary">/</span> sessions
                            </span>
                        )}
```

- [ ] **Step 12: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean).

- [ ] **Step 13: Run the palette test suite**

Run: `npx vitest run frontend/app/cockpit/`
Expected: PASS — `palette-scope`, `palette-launch`, `palette-match`, `footer-visible` all green.

- [ ] **Step 14: Visual verification (live dev app / CDP)**

If the dev app is not already running, start it (`task dev`; see repo notes on stdin EOF). Then, with `Ctrl+P` open, confirm each scope and screenshot with `node scripts/cdp-shot.mjs`:

- Empty query → default: launch group (if a channel is active) + Commands/Agents/Sessions; footer shows the sigil legend.
- `>` → only the Commands group; `>files` narrows it.
- `@` → only live Agents; Enter opens that agent's terminal.
- `/` → only resumable Sessions; Enter resumes.
- `#` → Channels list; Enter switches the active channel and lands on the Channels surface.
- `#<channel> a goal` (e.g. `#<realchannelname> hello`) → a single "Launch in #<channel>" group targeting the *picked* channel; the header shows the resolved channel name.
- `#zzzzz goal` (no match) → empty state reads `No channel matches "zzzzz"`.
- Confirm the default path is unchanged: a plain goal with an active channel still shows the launch group and dispatches into the active channel.

Expected: all scopes behave as above; no console errors.

- [ ] **Step 15: Stage (do NOT commit — see Global Constraints)**

Run: `git add frontend/app/cockpit/command-palette.tsx`

---

### Task 3: Single feature commit (after explicit approval)

**Files:** none changed — this task only commits what Tasks 1–2 staged, plus the spec and this plan.

- [ ] **Step 1: Show the user the staged diff and ask for commit approval**

Run: `git status && git diff --cached --stat`

Then ask the user to approve committing. Do NOT proceed without an explicit "yes."

- [ ] **Step 2: Stage the spec + plan so they fold into the feature commit**

Run: `git add docs/superpowers/specs/2026-07-14-ctrlp-scoped-modes-design.md docs/superpowers/plans/2026-07-14-ctrlp-scoped-modes.md`

(Do not stage or commit the unrelated pre-existing changes already in the index — the cross-surface-consistency-scaffold files. If they are staged, leave the commit to the user or reset them first per their instruction.)

- [ ] **Step 3: Commit (only after approval)**

Run:

```bash
git commit -m "feat(palette): sigil scopes for Ctrl+P (> commands, @ agents, / sessions, # channels)"
```

Do not push unless the user asks.

---

## Self-Review

**1. Spec coverage:**
- Sigil parsing + position-0 rule + shadowing tradeoff → Task 1 (`parseScope`) + tests.
- `>` / `@` / `/` narrowing with existing Enter actions → Task 2 Step 8 (else branch), verified Step 14.
- `#` picker → navigate (`selectChannel` + surface) → Task 2 Steps 7 (channelItems) + 8 + 14.
- `#<channel> <goal>` launch into picked channel → Task 2 Steps 5 (`targetChannel`), 7 (generalized launch), 8, verified 14.
- Launch generalization / DRY (one `targetChannel` path, profile prefetch keyed on it) → Task 2 Steps 5–7.
- Footer legend + placeholder → Task 2 Steps 10–11.
- Edge cases (no channels, unresolved token, lone sigil, trailing space) → Task 1 tests + Task 2 Steps 8–9.
- No Go / no regen → honored (only FE files touched).

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code.

**3. Type consistency:** `ParsedScope`/`Scope`/`ChannelLaunch` defined in Task 1 are consumed unchanged in Task 2. `parseScope`/`resolveChannelToken` signatures match their call sites. `targetChannel` typed `Channel | null` (both `channel` and `pickedChannel` are `Channel | null`). `PaletteKind` gains `"channel"` and `GROUP_LABELS` is extended in the same step so the `Record<Exclude<PaletteKind,"launch">, string>` type stays satisfied.
