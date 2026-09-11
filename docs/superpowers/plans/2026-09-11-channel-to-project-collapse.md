# Channel → Project Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire "channel" as a user-facing noun — the cockpit names the project, and the channel becomes storage resolved by path.

**Architecture:** A channel is a project reference plus the state of working in it (thread, runs, profile, archived flag). The project is the identity; the channel is the state. This plan makes that true in the UI: one pure derivation (`projectLabel`) becomes the only name a channel may render, every display site consumes it, and `CreateChannelCommand` becomes idempotent per project path so the 1:1 is enforced rather than merely conventional. The Go `Channel` type is **not** renamed or migrated — runs join to it via the indexed `ChannelOID`, and messages/profile/meta live on it. The concept dies in the UI; the table stays as storage.

**Tech Stack:** React 19 + jotai + Tailwind 4 (frontend), Go + SQLite (`pkg/wstore`, `pkg/wshrpc/wshserver`), vitest (frontend tests), `go test` (backend tests).

**Spec:** `docs/superpowers/specs/2026-09-09-jarvis-brief-meta-spec.md` — this is sub-project **B6**, the follow-on to B5's retirement. No separate spec doc: per the meta spec's "What this document is", sub-projects do not get their own design specs. The design decision this plan implements is recorded in Task 8, which adds the B6 row.

**Predecessor, already landed (do not redo):** `+ Channel` became `+ Run` — `frontend/app/view/jarvis/newruncontrol.tsx` (project picker + goal, find-or-create behind it), `frontend/app/view/jarvis/newrun.ts` + `newrun.test.ts` (`resolveChannelTarget`, `launchOptsFromProfile`), the `jarvis:new-run` binding on `r`, and the `NewRunControl` mount in `briefsurface.tsx:1218`. Every new channel from that path is already named after its project.

## Global Constraints

- **No emojis anywhere** — not in code, comments, copy, or commit messages.
- **Colors come from `@theme` tokens** in `frontend/tailwindsetup.css`. Never raw hex/rgba in components — a hardcoded color silently opts out of every runtime theme.
- **Never introduce new design tokens** without an explicit stated reason; reuse the existing ones.
- **Comments explain "why", never "what."** Lower case. Only when necessary.
- **Never hand-edit generated files.** Go is the source of truth for wire types; run `task generate` after changing any wshrpc/waveobj/wconfig type. This plan changes no wire types, so `task generate` should report no changes.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — bare `npx tsc` stack-overflows on this repo. Baseline is exit 0; any error it reports is yours.
- **Go tests need the vendored sqlite header.** From PowerShell at the repo root, before `go test ./pkg/...`:
  ```powershell
  $env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
  ```
  A Git-Bash POSIX path silently fails with the identical "sqlite3.h: No such file or directory".
- **Append to existing test files, never Write over them.** `pkg/wstore/wstore_channel_test.go` and `pkg/wshrpc/wshserver/wshserver_channels_test.go` both already exist. Use a heredoc append (`cat >> file <<'EOF'`), not the Write tool — Write replaces the file.
- **No `prettier --write` on `scripts/*.mjs`** (`.editorconfig` omits `.mjs`, so it reindents to 2-space). Frontend `.ts`/`.tsx` files are fine.
- **Commit per task.** Do not push. Do not add a co-author trailer.

## Deliberately out of scope

- **Renaming the Go `Channel` type**, its table, or its RPC command names. ~127 Go files reference it; zero user-visible gain.
- **The palette's internal scope key** `"channel"` in `frontend/app/cockpit/palette-scope.ts` (`parseScope("#") → {scope: "channel"}`). It is an internal discriminator, never rendered. The `#` token's *user-visible* hint and empty-state copy are in scope (Task 4).
- **`renameChannel` / archive semantics.** Under a 1:1 collapse these become project operations, and renaming a project today is a `projects.json` edit while renaming a channel is an RPC. That is a design decision, not a mechanical port — see "Open decision" at the end. Both commands keep working untouched by this plan.
- **`scripts/cdp/jarvis-tour.mjs`.** Already stale before this plan (it asserts the "Point me at some work" empty Stage that B5 deleted and clicks the deleted Subjects column), and wired into no task. Leave it; its retirement belongs with the wider CDP reconciliation the meta spec's B5 row already flags as unfinished.

---

### Task 1: The one name a channel may render

Two pure helpers plus a shared path normalizer, in one new file. Every later task consumes these, so this task lands first and alone.

**Files:**
- Create: `frontend/app/view/agents/projectlabel.ts`
- Create: `frontend/app/view/agents/projectlabel.test.ts`
- Modify: `frontend/app/view/agents/channelderive.ts:39-46` (export the normalizer that is currently inline in `resolveTargetChannel`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `normProjectPath(p: string): string` from `channelderive.ts` — separator- and trailing-slash-insensitive path key.
  - `projectLabel(channel: Channel | null | undefined, projects: Record<string, ProjectKeywords>): string` from `projectlabel.ts`.
  - `dedupeByProject(channels: Channel[]): Channel[]` from `projectlabel.ts`.

`Channel` and `ProjectKeywords` are global generated types (`frontend/types/gotypes.d.ts`) — do not import them.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/projectlabel.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { dedupeByProject, projectLabel } from "./projectlabel";

const ch = (oid: string, projectpath: string, name = ""): Channel => ({ oid, projectpath, name }) as Channel;
const registry = (entries: Record<string, string>): Record<string, ProjectKeywords> =>
    Object.fromEntries(Object.entries(entries).map(([name, path]) => [name, { path }]));

describe("projectLabel", () => {
    it("names the registered project at the channel's path", () => {
        const projects = registry({ waveterm: "/repo/waveterm" });
        expect(projectLabel(ch("c1", "/repo/waveterm", "some-old-name"), projects)).toBe("waveterm");
    });

    it("matches across separator styles, so a Windows channel path still resolves", () => {
        const projects = registry({ waveterm: "C:/Users/k/waveterm" });
        expect(projectLabel(ch("c1", "C:\\Users\\k\\waveterm"), projects)).toBe("waveterm");
    });

    it("ignores a trailing slash on either side", () => {
        expect(projectLabel(ch("c1", "/repo/a/"), registry({ a: "/repo/a" }))).toBe("a");
        expect(projectLabel(ch("c1", "/repo/a"), registry({ a: "/repo/a/" }))).toBe("a");
    });

    it("falls back to the channel's own name when the project is not registered", () => {
        expect(projectLabel(ch("c1", "/repo/gone", "legacy thread"), registry({}))).toBe("legacy thread");
    });

    it("falls back to the oid when there is no name either", () => {
        expect(projectLabel(ch("c1", "", ""), registry({}))).toBe("c1");
    });

    it("is empty for no channel", () => {
        expect(projectLabel(null, registry({ a: "/repo/a" }))).toBe("");
        expect(projectLabel(undefined, registry({ a: "/repo/a" }))).toBe("");
    });
});

describe("dedupeByProject", () => {
    it("keeps one channel per project path, first wins", () => {
        const list = [ch("new", "/repo/a"), ch("old", "/repo/a"), ch("b", "/repo/b")];
        expect(dedupeByProject(list).map((c) => c.oid)).toEqual(["new", "b"]);
    });

    it("collapses duplicates written with different separators", () => {
        const list = [ch("new", "C:/Users/k/w"), ch("old", "C:\\Users\\k\\w")];
        expect(dedupeByProject(list).map((c) => c.oid)).toEqual(["new"]);
    });

    it("keeps every channel that has no project path — they collapse onto nothing", () => {
        const list = [ch("a", ""), ch("b", "")];
        expect(dedupeByProject(list).map((c) => c.oid)).toEqual(["a", "b"]);
    });

    it("preserves input order", () => {
        const list = [ch("b", "/repo/b"), ch("a", "/repo/a")];
        expect(dedupeByProject(list).map((c) => c.oid)).toEqual(["b", "a"]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/projectlabel.test.ts`
Expected: FAIL — `Failed to resolve import "./projectlabel"`.

- [ ] **Step 3: Export the normalizer from `channelderive.ts`**

In `frontend/app/view/agents/channelderive.ts`, replace the body of `resolveTargetChannel` (currently lines 39-46) so the path key is a named export rather than a closure. The exported function goes immediately above `resolveTargetChannel`:

```ts
// The comparison key for a project path. A channel stores what the user registered (backslashes on
// Windows) while a radar report stores it canonPath'd, so two spellings of one project must land on one
// key or the app mints a duplicate channel for a project that already has one. Mirrors Go's canonPath.
export function normProjectPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

// resolveTargetChannel finds the channel a Radar finding should hand off to: the first whose bound
// project path matches. Both paths trace back to the same project registry, but a radar report stores it
// canonPath'd (forward slashes, per pkg/reporadar) while a channel stores it verbatim — so on Windows a
// backslash channel path must be separator-normalized before comparing, mirroring Go's canonPath.
export function resolveTargetChannel(channels: Channel[], projectPath: string | undefined): Channel | undefined {
    if (!projectPath) {
        return undefined;
    }
    const want = normProjectPath(projectPath);
    return channels.find((c) => c.projectpath != null && normProjectPath(c.projectpath) === want);
}
```

- [ ] **Step 4: Write `projectlabel.ts`**

Create `frontend/app/view/agents/projectlabel.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one name a channel is allowed to show. A channel is storage for "work in this project", so what a
// user reads is the project registered at its path — never the channel's own `name`, which is free text a
// pre-collapse channel could have set to anything. The fallbacks are for channels the registry cannot
// explain: an unregistered or since-removed project keeps rendering as *something* rather than blank.

import { normProjectPath } from "./channelderive";

export function projectLabel(
    channel: Channel | null | undefined,
    projects: Record<string, ProjectKeywords>
): string {
    if (channel == null) {
        return "";
    }
    const path = channel.projectpath ?? "";
    if (path !== "") {
        const want = normProjectPath(path);
        for (const [name, p] of Object.entries(projects ?? {})) {
            if (p?.path != null && normProjectPath(p.path) === want) {
                return name;
            }
        }
    }
    return channel.name || channel.oid;
}

// One row per project for any list a user picks from. CreateChannelCommand is idempotent per path from
// Task 7 on, but channels created before that are still out there, and two rows carrying one project's
// name is exactly the confusion this work removes. First wins, which is newest: GetChannels sorts by
// CreatedTs descending and channelsAtom preserves that order, so this agrees with resolveTargetChannel
// and with the server's own ChannelAtPath rather than quietly picking a different duplicate.
export function dedupeByProject(channels: Channel[]): Channel[] {
    const seen = new Set<string>();
    const out: Channel[] = [];
    for (const c of channels) {
        const path = c.projectpath ?? "";
        if (path === "") {
            // nothing to collapse onto: a pathless channel is not "a project", so it keeps its own row
            out.push(c);
            continue;
        }
        const key = normProjectPath(path);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(c);
    }
    return out;
}
```

Note: `dedupeByProject` deliberately takes no `projects` argument. The project path on the channel *is* the project identity — the registry only supplies a display name — so passing the registry in would be an unused parameter (and this repo's eslint `argsIgnorePattern` is `^(_[a-zA-Z0-9_]*|e|get)$`, so it would be flagged). Every call site already holds `projects` for `projectLabel`; it just does not need it here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/projectlabel.test.ts frontend/app/view/agents/channelderive.test.ts`
Expected: PASS — the new file's 10 tests plus the existing `channelderive` suite (the `resolveTargetChannel` tests must still pass unchanged; they cover exactly the normalization that just moved).

- [ ] **Step 6: Typecheck, lint, format**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/agents/projectlabel.ts frontend/app/view/agents/projectlabel.test.ts frontend/app/view/agents/channelderive.ts
npx prettier --write frontend/app/view/agents/projectlabel.ts frontend/app/view/agents/projectlabel.test.ts frontend/app/view/agents/channelderive.ts
```
Expected: tsc exit 0, eslint silent, prettier writes or reports unchanged. If eslint reports the unused `projects` parameter, rename it to `_projects` in both the signature and this plan's later call sites (the call sites pass it positionally, so they do not change).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/projectlabel.ts frontend/app/view/agents/projectlabel.test.ts frontend/app/view/agents/channelderive.ts
git commit -m "feat(jarvis): derive a channel's display name from its project"
```

---

### Task 2: The run surfaces name the project

**Files:**
- Modify: `frontend/app/view/jarvis/briefsheet.tsx` — the `ChannelLaunch` eyebrow (`:155`), `SheetChannelPending`'s two states (`:243`, `:250`), the `SheetShell` `label` and `title` props in `BriefSheet` (`:297`, `:312`, `:333`)
- Modify: `frontend/app/view/agents/runlauncher.tsx:173-194` — the `channelName` prop and its heading
- Modify: `frontend/app/view/agents/runcompletionsurface.tsx:97` — the completed run's breadcrumb

**Interfaces:**
- Consumes: `projectLabel` from `@/app/view/agents/projectlabel` (Task 1).
- Produces: `RunLauncher` takes `projectName: string` instead of `channelName: string`. `briefsheet.tsx` is its only caller.

- [ ] **Step 1: Rename the launcher's prop and heading**

In `frontend/app/view/agents/runlauncher.tsx`, replace the whole `RunLauncher` function (currently lines 173-194):

```tsx
export function RunLauncher({ projectName }: { projectName: string }) {
    const shape = useAtomValue(runShapeAtom);
    const orchestration = useAtomValue(orchestrationAtom);
    const face = runLauncherFace(shape, orchestration);
    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-2">
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
                <div className="flex flex-col gap-1">
                    <span className="text-[15px] font-semibold text-primary">Start a run in {projectName}</span>
                    <span className="text-[12px] leading-[1.5] text-muted">
                        Set it up here, then give Jarvis the goal below and press Run ⏎. Typing @quick, @run or @ask in
                        the goal overrides the shape for that one launch.
                    </span>
                </div>
                <ShapeCards />
                {face.showMachine ? <MachineCards /> : null}
                {face.showParallelism ? <ParallelismStepper /> : null}
                <RoutingSection showWorkerRoute={face.showWorkerRoute} />
            </div>
        </div>
    );
}
```

Keep the comment immediately above the function ("No Launch button of its own…") — it explains why there is no button here, which this change does not affect. The only differences are the prop name and the dropped `#` sigil: in this heading `#` was decoration, and a project name does not wear one.

- [ ] **Step 2: Point the sheet at the project label**

In `frontend/app/view/jarvis/briefsheet.tsx`, add the import beside the existing `@/app/view/agents/...` imports:

```tsx
import { projectLabel } from "@/app/view/agents/projectlabel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
```

In `ChannelLaunch`, add the two reads next to the existing `const channels = useAtomValue(channelsAtom);`:

```tsx
    const projects = useAtomValue(projectsAtom);
```

and replace the eyebrow span (currently `:153-156`):

```tsx
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.13em] text-feed-label">
                run this in {projectLabel(channel, projects)}
            </span>
```

- [ ] **Step 3: Rewrite the two pending states**

In `frontend/app/view/jarvis/briefsheet.tsx`, replace the two copy strings inside `SheetChannelPending` (currently `:243` and `:250`):

```tsx
                <span className="text-[12px] text-secondary">This run's project is no longer available.</span>
```

```tsx
            <span className="text-[12px] text-secondary">Reading this project…</span>
```

Leave the `data-jarvis-brief-sheet-state` attributes (`"unavailable"`, `"loading"`) exactly as they are — CDP scenarios select on them, and they are not user-visible copy.

- [ ] **Step 4: Label the sheet header by project**

In `BriefSheet`, add the projects read beside the other `useAtomValue` calls:

```tsx
    const projects = useAtomValue(projectsAtom);
```

Replace the `title` computation (currently `:297-300`, just below `const close = ...`) — it reads `channel?.name ?? ""`:

```tsx
    const title =
        face.kind === "channel"
            ? projectLabel(channel, projects)
            : (effortCache.get("effort:" + face.effortId)?.title ?? "Initiative");
```

Replace the `SheetShell` label prop (currently `:312`, reads `"session"`):

```tsx
                label={face.kind === "effort" ? "initiative" : "project"}
```

And the launcher branch (currently `:333`, reads `channelName={channel.name ?? face.channelId}`), which now passes a project name. `projectLabel` already falls back through `channel.name` to the oid, so the `?? face.channelId` guard is redundant and goes:

```tsx
                            <RunLauncher projectName={projectLabel(channel, projects)} />
```

- [ ] **Step 5: Rename the completed run's breadcrumb**

`RunCompletion` is what the sheet shows once a run finishes (`runbody.tsx:639`), and its breadcrumb reads `#<channel> / run <id>`. In `frontend/app/view/agents/runcompletionsurface.tsx`, add the same two imports plus `import { useAtomValue } from "jotai";` if the file does not already have it, add `const projects = useAtomValue(projectsAtom);` inside `RunCompletion`, and replace line 97:

```tsx
                                <span className="text-ink-mid">{projectLabel(channel, projects)}</span>
```

- [ ] **Step 6: Typecheck and run the suite**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
```
Expected: tsc exit 0. vitest all green — the baseline after the `+ Run` work is **2918 passed, 2 skipped**; this task adds no tests, so expect the same numbers. A drop means you broke something.

- [ ] **Step 7: Lint and format**

```bash
npx eslint frontend/app/view/jarvis/briefsheet.tsx frontend/app/view/agents/runlauncher.tsx frontend/app/view/agents/runcompletionsurface.tsx
npx prettier --write frontend/app/view/jarvis/briefsheet.tsx frontend/app/view/agents/runlauncher.tsx frontend/app/view/agents/runcompletionsurface.tsx
```
Expected: eslint silent.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/briefsheet.tsx frontend/app/view/agents/runlauncher.tsx frontend/app/view/agents/runcompletionsurface.tsx
git commit -m "feat(jarvis): the run surfaces name the project"
```

---

### Task 3: The autonomy ladder and the profile picker name the project

**Files:**
- Modify: `frontend/app/view/jarvis/briefautonomy.ts:38-51` (`channelAutonomy` takes the registry)
- Modify: `frontend/app/view/jarvis/briefautonomy.test.ts` (existing `channelAutonomy` describe block, lines 17-43)
- Modify: `frontend/app/view/jarvis/autonomyladderview.tsx:60`
- Modify: `frontend/app/view/jarvis/briefprofileview.tsx` — the modal's own header (`:386`) and the channel `<option>` list (`:420-424`)

**Interfaces:**
- Consumes: `projectLabel`, `dedupeByProject` from `@/app/view/agents/projectlabel` (Task 1).
- Produces: `channelAutonomy(channels: Channel[] | null | undefined, projects: Record<string, ProjectKeywords>): ChannelAutonomy[]` — the second parameter is new and required.

- [ ] **Step 1: Write the failing test**

In `frontend/app/view/jarvis/briefautonomy.test.ts`, the existing `channelAutonomy` tests call it with one argument. Add this test to the existing `describe("channelAutonomy", ...)` block, and add the registry helper above the describe if the file does not already have one:

```ts
    it("labels each row with the registered project, not the channel's own name", () => {
        const rows = channelAutonomy([{ oid: "c1", name: "old-thread-name", projectpath: "/repo/wave" } as Channel], {
            wave: { path: "/repo/wave" },
        });
        expect(rows[0]).toMatchObject({ channelId: "c1", name: "wave" });
    });

    it("shows one row per project when a project has duplicate channels", () => {
        const rows = channelAutonomy(
            [
                { oid: "new", name: "a", projectpath: "/repo/a" } as Channel,
                { oid: "old", name: "a (2)", projectpath: "/repo/a" } as Channel,
            ],
            { a: { path: "/repo/a" } }
        );
        expect(rows.map((r) => r.channelId)).toEqual(["new"]);
    });
```

Then update every existing `channelAutonomy(...)` call in that file to pass `{}` as the second argument — `channelAutonomy([...])` becomes `channelAutonomy([...], {})`, and `channelAutonomy(null)` becomes `channelAutonomy(null, {})`. With an empty registry the existing expectations still hold, because `projectLabel` falls back to `channel.name`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/briefautonomy.test.ts`
Expected: FAIL — the new "labels each row with the registered project" case reports `name: "old-thread-name"`, and the duplicate case returns two rows.

- [ ] **Step 3: Implement**

In `frontend/app/view/jarvis/briefautonomy.ts`, add the import:

```ts
import { dedupeByProject, projectLabel } from "@/app/view/agents/projectlabel";
```

and replace `channelAutonomy` (currently lines 38-51):

```ts
export function channelAutonomy(
    channels: Channel[] | null | undefined,
    projects: Record<string, ProjectKeywords>
): ChannelAutonomy[] {
    const active = dedupeByProject(partitionChannels(channels ?? []).active);
    return active
        .map((c) => {
            const meta = c.meta as Record<string, unknown> | undefined;
            return {
                channelId: c.oid,
                name: projectLabel(c, projects),
                tier: tierFromMeta(meta),
                mode: typeof meta?.["delegator:mode"] === "string" ? (meta["delegator:mode"] as string) : "",
            };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/briefautonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the two call sites**

In `frontend/app/view/jarvis/autonomyladderview.tsx`, add beside the other atom reads in `AutonomyLadder`:

```tsx
    const projects = useAtomValue(projectsAtom);
```

with the import `import { projectsAtom } from "@/app/view/agents/projectsstore";`, and change line 60:

```tsx
    const rows = useMemo(() => channelAutonomy(channels, projects), [channels, projects]);
```

In `frontend/app/view/jarvis/briefprofileview.tsx` (the component is `BriefProfileModal`, `:206`), add the imports (`projectLabel`, `dedupeByProject`, `projectsAtom`) and a `const projects = useAtomValue(projectsAtom);` read, then replace the modal header's subject line (`:386`) — a profile scoped to a channel is a profile scoped to that channel's project, so it should say so:

```tsx
                        {isGlobal ? "Global defaults" : (projectLabel(channel, projects) || "No project")}
```

`projectLabel` returns `""` only when `channel` is null, which is exactly the case the `"No project"` fallback is for — hence `||`, not `??`.

Then replace the option list (currently lines 420-424):

```tsx
                                {dedupeByProject(channels ?? []).map((c) => (
                                    <option key={c.oid} value={c.oid}>
                                        {projectLabel(c, projects)}
                                    </option>
                                ))}
```

Leave the `channel?.projectpath` line immediately below it (`:429`) — it is the disambiguator that tells you *which* checkout a project name refers to, and it is the one place the raw path earns its space.

- [ ] **Step 6: Typecheck, suite, lint, format**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx eslint frontend/app/view/jarvis/briefautonomy.ts frontend/app/view/jarvis/briefautonomy.test.ts frontend/app/view/jarvis/autonomyladderview.tsx frontend/app/view/jarvis/briefprofileview.tsx
npx prettier --write frontend/app/view/jarvis/briefautonomy.ts frontend/app/view/jarvis/briefautonomy.test.ts frontend/app/view/jarvis/autonomyladderview.tsx frontend/app/view/jarvis/briefprofileview.tsx
```
Expected: tsc exit 0; vitest 2920 passed, 2 skipped (2918 baseline + the 2 new cases); eslint silent.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/briefautonomy.ts frontend/app/view/jarvis/briefautonomy.test.ts frontend/app/view/jarvis/autonomyladderview.tsx frontend/app/view/jarvis/briefprofileview.tsx
git commit -m "feat(jarvis): the autonomy ladder and profile picker name the project"
```

---

### Task 4: The command palette's `#` scope reads as projects

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx` — the group-label map (`:70`, `:77`), the row builder (`:313-329`), the launch group's `projectName` and name argument (`:268`, `:288`), `emptyMessage` (`:445-451`), the "Launch in" group heading (`:547-550`), the footer hint row (`:712`)
- Modify: `frontend/app/cockpit/palette-launch.ts:25-52` — the `channelName` parameter name and its comment

**Interfaces:**
- Consumes: `projectLabel`, `dedupeByProject` from `@/app/view/agents/projectlabel` (Task 1).
- Produces: `buildLaunchItems(query: string, projectName: string | undefined, deps: LaunchDeps): LaunchItem[]` — second parameter renamed only; the arguments stay positional and the footer strings are byte-identical, so `palette-launch.test.ts` passes untouched.

The palette's internal `parseScope` discriminator stays `"channel"` — see "Deliberately out of scope". The `#` sigil also stays on the rows: unlike the sheet and Peter Rand, where `#` was decoration, here it is the character the user literally typed to get this list. What changes is what the sigil is attached to — a project name, not a channel name.

- [ ] **Step 1: Label and dedupe the rows**

In `frontend/app/cockpit/command-palette.tsx`, add:

```tsx
import { dedupeByProject, projectLabel } from "@/app/view/agents/projectlabel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
```

and a `const projects = useAtomValue(projectsAtom);` read beside the existing `const channels = useAtomValue(channelsAtom);` (`:118`).

Replace the row builder and its comment (currently `:313-329`) in full:

```tsx
    // Project picker rows (# scope, no goal). Enter switches the active project and opens the surface.
    const channelItems = useMemo<PaletteItem[]>(
        () =>
            dedupeByProject(channels ?? []).map((c) => {
                const name = projectLabel(c, projects);
                return {
                    key: `channel:${c.oid}`,
                    kind: "channel" as const,
                    search: `#${name} ${c.projectpath ?? ""}`,
                    title: `#${name}`,
                    subtitle: c.projectpath ? c.projectpath.split(/[\\/]/).pop() : undefined,
                    run: () => {
                        void openChannelSheet(c.oid, null);
                        globalStore.set(model.surfaceAtom, "jarvis");
                        close();
                    },
                };
            }),
        [channels, close, model, projects]
    );
```

The `channelItems` variable name stays: it is the palette's internal handle for the `#`-scope group, and renaming it would ripple through `capGroups` and the group-kind union for no user-visible gain.

If eslint's exhaustive-deps disagrees with the dependency array above (the existing array is `[channels, model]`, so `close` may already be exempt), take eslint's answer — it sees the real closure.

- [ ] **Step 2: Rewrite the empty-state copy**

Replace `emptyMessage` and its comment (currently `:445-451`):

```tsx
    // Scope-aware empty text: a '#<token>' that resolves to nothing vs. an empty project list.
    const emptyMessage =
        parsed.scope === "channel" && channelLaunch
            ? `No project matches “${channelLaunch.token}”`
            : parsed.scope === "channel"
              ? "No projects."
              : "No results.";
```

- [ ] **Step 3: Rewrite the "Launch in" heading, its comment, and the footer hint**

Replace the launch group heading (currently `:547-550`) — only the name source changes, the `#` stays:

```tsx
                                            {g.kind === "launch" ? (
                                                <>
                                                    Launch in{" "}
                                                    <span className="text-accent-100">
                                                        #{projectLabel(targetChannel, projects)}
                                                    </span>
                                                </>
```

Replace the comment at `:70`, which names the old label:

```tsx
// The launch group renders its own dynamic label ("Launch in #<project>"), so it is excluded here.
```

Replace the footer hint row's `#` entry (currently `:712`):

```tsx
                                    <span className="text-secondary">#</span> projects{"  "}
```

Replace the group-label map's `channel` entry (`:77`) — this is the heading over the `#`-scope results:

```tsx
    channel: "Projects",
```

- [ ] **Step 4: Rename the launch-item parameter and feed it the project**

In `frontend/app/cockpit/palette-launch.ts`, replace the comment and signature (`:25-31`):

```ts
// Empty goal or no project -> []. Otherwise the 4 launch rows, Quick first (preselected by the caller).
export function buildLaunchItems(
    query: string,
    projectName: string | undefined,
    deps: LaunchDeps
): LaunchItem[] {
    const goal = query.trim();
    if (!goal || !projectName) {
        return [];
    }
```

and the two footer template strings (`:42`, `:51`) — `#` stays, only the interpolated variable is renamed:

```ts
            footer: `Spawns a Quick worker on “${goal}” in #${projectName}`,
```
```ts
            footer: `Starts a quick run on “${goal}” in #${projectName}`,
```

Back in `command-palette.tsx`, pass the project rather than the channel's own name at the two places the launch group reads it — `:268`, inside `sendText`:

```tsx
                projectName: projectLabel(ch, projects) || "agent",
```

and `:288`, the `buildLaunchItems` call:

```tsx
        return buildLaunchItems(launchGoal, projectLabel(ch, projects), deps).map((li) => ({
```

Add `projects` to that `useMemo`'s dependency array (`:297` — currently `[showLaunch, targetChannel, launchGoal, agents, model]`).

- [ ] **Step 5: Typecheck, suite, lint, format**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx eslint frontend/app/cockpit/command-palette.tsx frontend/app/cockpit/palette-launch.ts
npx prettier --write frontend/app/cockpit/command-palette.tsx frontend/app/cockpit/palette-launch.ts
```
Expected: tsc exit 0; vitest 2920 passed, 2 skipped; eslint silent. `palette-scope.test.ts` and `palette-launch.test.ts` must both still pass **untouched** — if `palette-scope` fails you changed the internal scope key, and if `palette-launch` fails you changed a footer string. Neither is this task's job.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/cockpit/command-palette.tsx frontend/app/cockpit/palette-launch.ts
git commit -m "feat(cockpit): the palette's # scope reads as projects"
```

---

### Task 5: Peter Rand's destination picker names the project

**Files:**
- Modify: `frontend/app/view/jarvis/peterrand.tsx:46-48` (options list + placeholder), `:128` (the select's `title`), `:134-139` (the `<option>` bodies)

**Interfaces:**
- Consumes: `projectLabel`, `dedupeByProject` from `@/app/view/agents/projectlabel` (Task 1).
- Produces: nothing new.

The `"no channel active"` string in the `blocker` filter (`:52`) is an **internal reason code**, compared against and filtered *out* of the rendered output — it never reaches a user. Leave it.

- [ ] **Step 1: Dedupe the options and rewrite the placeholder**

In `frontend/app/view/jarvis/peterrand.tsx`, add:

```tsx
import { dedupeByProject, projectLabel } from "@/app/view/agents/projectlabel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
```

and a `const projects = useAtomValue(projectsAtom);` read beside the component's other atom reads. Then replace lines 46-48:

```tsx
    const options = dedupeByProject(channels ?? []);
    const placeholder =
        dest == null ? "No project to send to yet" : busy ? "Jarvis is thinking" : "Ask Jarvis anything";
```

- [ ] **Step 2: Rewrite the select's title and options**

Replace the `title` prop (currently `:128`):

```tsx
                        title={dest != null ? `Reply lands in ${projectLabel(dest, projects)}` : undefined}
```

Replace the comment and the option bodies (currently `:133-139`) — the old comment justified the `#`, which is going:

```tsx
                        {/* no "→" glyph: the project name already reads as a destination and the arrow
                            only costs width */}
                        {options.map((channel) => (
                            <option key={channel.oid} value={channel.oid}>
                                {projectLabel(channel, projects)}
                            </option>
                        ))}
```

Leave `data-pet-errand-dest` and `aria-label="Where the reply lands"` exactly as they are.

- [ ] **Step 3: Typecheck, suite, lint, format**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx eslint frontend/app/view/jarvis/peterrand.tsx
npx prettier --write frontend/app/view/jarvis/peterrand.tsx
```
Expected: tsc exit 0; vitest 2920 passed, 2 skipped; eslint silent.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/jarvis/peterrand.tsx
git commit -m "feat(jarvis): Peter Rand's destination picker names the project"
```

---

### Task 6: The composer's target and the shortcut cheat sheet

The last two places the word surfaces: the composer's "who am I talking to" label, which names the channel behind a live run, and the keybinding labels the cheat sheet prints verbatim (`shortcuts-cheatsheet.tsx:32` filters and renders `b.label`).

**Files:**
- Modify: `frontend/app/view/jarvis/briefcomposertarget.ts:31,64` — rename the `channelName` input field
- Modify: `frontend/app/view/jarvis/briefcomposertarget.test.ts:65` — the renamed field
- Modify: `frontend/app/view/jarvis/briefsurface.tsx:669,677` — feed it the project label
- Modify: `frontend/app/store/keybindings/bindings.ts:90,568,576` — three cheat-sheet labels

**Interfaces:**
- Consumes: `projectLabel` from `@/app/view/agents/projectlabel` (Task 1).
- Produces: `BriefTargetInput.projectName?: string` replaces `BriefTargetInput.channelName?: string`. `briefsurface.tsx` is the only production caller.

- [ ] **Step 1: Update the test to the new field name**

In `frontend/app/view/jarvis/briefcomposertarget.test.ts`, line 65, rename the input field. The value stays `"waveterm"` — it was already a project name, which is the tell that this field always wanted to be one:

```ts
                projectName: "waveterm",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/briefcomposertarget.test.ts`
Expected: FAIL — `sessionName` comes back as `"claude"` (the lead's name, the fallback) because `input.channelName` is now undefined.

- [ ] **Step 3: Rename the field**

In `frontend/app/view/jarvis/briefcomposertarget.ts`, line 31:

```ts
    projectName?: string;
```

and line 64:

```ts
        sessionName: input.projectName?.trim() || lead.name,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/briefcomposertarget.test.ts`
Expected: PASS.

- [ ] **Step 5: Feed it the project label**

In `frontend/app/view/jarvis/briefsurface.tsx`, add:

```tsx
import { projectLabel } from "@/app/view/agents/projectlabel";
import { projectsAtom } from "@/app/view/agents/projectsstore";
```

and a `const projects = useAtomValue(projectsAtom);` read beside `const channel = useAtomValue(activeChannelAtom);` (`:640`). Then replace `:669`:

```tsx
        projectName: projectLabel(channel, projects),
```

and the `project` field of the worker branch at `:677`:

```tsx
            ? { peek: "sheet", kind: "session", name: target.sessionName, project: projectLabel(channel, projects) }
```

- [ ] **Step 6: Rename the three cheat-sheet labels**

In `frontend/app/store/keybindings/bindings.ts`, the `g`-leader target at `:90`:

```ts
    { letter: "c", surface: "jarvis", label: "Jarvis (projects, records, recall)" },
```

and the two run-stepping labels at `:568` and `:576`:

```ts
            label: "Next run in this project",
```
```ts
            label: "Previous run in this project",
```

Leave every binding `id` alone (`jarvis:next-run`, `channels:submit`, …) — ids are internal keys, and `store.test.ts:257` asserts on `"channels:submit"` by name.

- [ ] **Step 7: Typecheck, suite, lint, format**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx vitest run
npx eslint frontend/app/view/jarvis/briefcomposertarget.ts frontend/app/view/jarvis/briefcomposertarget.test.ts frontend/app/view/jarvis/briefsurface.tsx frontend/app/store/keybindings/bindings.ts
npx prettier --write frontend/app/view/jarvis/briefcomposertarget.ts frontend/app/view/jarvis/briefcomposertarget.test.ts frontend/app/view/jarvis/briefsurface.tsx frontend/app/store/keybindings/bindings.ts
```
Expected: tsc exit 0; vitest 2920 passed, 2 skipped; eslint silent. `bindings.test.ts` and `store.test.ts` must still pass — they assert on ids and keys, not labels.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/briefcomposertarget.ts frontend/app/view/jarvis/briefcomposertarget.test.ts frontend/app/view/jarvis/briefsurface.tsx frontend/app/store/keybindings/bindings.ts
git commit -m "feat(jarvis): the composer target and shortcut labels name the project"
```

---

### Task 7: One channel per project, enforced server-side

Makes `CreateChannelCommand` idempotent per project path. Returning the existing channel rather than an error is deliberate: the frontend's find-or-create in `newrun.ts` races against a second window doing the same thing, and an error there would surface as a failed launch for what is actually the desired end state.

**Files:**
- Modify: `pkg/wstore/wstore_channel.go` (add `ChannelAtPath` + `normProjectPath` above `CreateChannel`, currently line 46)
- Modify: `pkg/wshrpc/wshserver/wshserver_channels.go:20-26` (`CreateChannelCommand`)
- Modify (append only): `pkg/wstore/wstore_channel_test.go`
- Modify (append only): `pkg/wshrpc/wshserver/wshserver_channels_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the backend half and could land first).
- Produces: `wstore.ChannelAtPath(ctx context.Context, projectPath string) (*waveobj.Channel, error)` — returns `(nil, nil)` when nothing matches or `projectPath` is empty.

- [ ] **Step 1: Write the failing store test**

Append to `pkg/wstore/wstore_channel_test.go` with a heredoc — do **not** use the Write tool, the file already has content:

```bash
cat >> pkg/wstore/wstore_channel_test.go <<'EOF'

func TestChannelAtPath(t *testing.T) {
	ctx := context.Background()
	a, err := CreateChannel(ctx, "alpha", "/repo/alpha")
	if err != nil {
		t.Fatalf("CreateChannel alpha: %v", err)
	}
	if _, err := CreateChannel(ctx, "beta", "/repo/beta"); err != nil {
		t.Fatalf("CreateChannel beta: %v", err)
	}

	got, err := ChannelAtPath(ctx, "/repo/alpha")
	if err != nil {
		t.Fatalf("ChannelAtPath: %v", err)
	}
	if got == nil || got.OID != a.OID {
		t.Fatalf("ChannelAtPath(/repo/alpha) = %v, want %s", got, a.OID)
	}

	// a Windows spelling and a trailing slash are the same project
	got, err = ChannelAtPath(ctx, "/repo/alpha/")
	if err != nil {
		t.Fatalf("ChannelAtPath trailing slash: %v", err)
	}
	if got == nil || got.OID != a.OID {
		t.Fatalf("ChannelAtPath(/repo/alpha/) = %v, want %s", got, a.OID)
	}

	got, err = ChannelAtPath(ctx, "/repo/nothing")
	if err != nil {
		t.Fatalf("ChannelAtPath miss: %v", err)
	}
	if got != nil {
		t.Fatalf("ChannelAtPath(/repo/nothing) = %v, want nil", got)
	}

	// an empty path is not "every channel with no path" — it is no answer
	got, err = ChannelAtPath(ctx, "")
	if err != nil {
		t.Fatalf("ChannelAtPath empty: %v", err)
	}
	if got != nil {
		t.Fatalf("ChannelAtPath(\"\") = %v, want nil", got)
	}
}

func TestChannelAtPathMatchesSeparatorStyles(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "wave", `C:\Users\k\wave`)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	got, err := ChannelAtPath(ctx, "C:/Users/k/wave")
	if err != nil {
		t.Fatalf("ChannelAtPath: %v", err)
	}
	if got == nil || got.OID != ch.OID {
		t.Fatalf("ChannelAtPath forward-slash = %v, want %s", got, ch.OID)
	}
}
EOF
```

`pkg/wstore/wstore_channel_test.go` currently imports only `"testing"` and `waveobj` — add `"context"` to its import block.

- [ ] **Step 2: Run the store test to verify it fails**

From PowerShell at the repo root:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/wstore/ -run TestChannelAtPath -v
```
Expected: FAIL to **build** — `undefined: ChannelAtPath`.

- [ ] **Step 3: Implement `ChannelAtPath`**

In `pkg/wstore/wstore_channel.go`, insert above `CreateChannel` (currently line 46):

```go
// normProjectPath is the comparison key for a project path. A channel stores what the user registered
// (backslashes on Windows) while a radar report stores it canonPath'd, so two spellings of one project
// must land on one key. Mirrors the frontend's normProjectPath in channelderive.ts.
func normProjectPath(p string) string {
	return strings.TrimRight(strings.ReplaceAll(p, "\\", "/"), "/")
}

// ChannelAtPath returns the channel bound to projectPath, or (nil, nil) if there is none. An empty path
// matches nothing rather than matching every pathless channel — "this channel has no project" is not an
// answer to "which channel is this project's". Reads through GetChannels, which sorts newest-first, so a
// pre-collapse project with duplicates resolves to the same one the frontend's resolveTargetChannel picks.
func ChannelAtPath(ctx context.Context, projectPath string) (*waveobj.Channel, error) {
	want := normProjectPath(projectPath)
	if want == "" {
		return nil, nil
	}
	chans, err := GetChannels(ctx)
	if err != nil {
		return nil, err
	}
	for _, ch := range chans {
		if normProjectPath(ch.ProjectPath) == want {
			return ch, nil
		}
	}
	return nil, nil
}
```

Add `"strings"` to the file's import block if it is not already there.

- [ ] **Step 4: Run the store test to verify it passes**

```powershell
go test ./pkg/wstore/ -run TestChannelAtPath -v
```
Expected: PASS, both tests.

- [ ] **Step 5: Write the failing RPC test**

Append to `pkg/wshrpc/wshserver/wshserver_channels_test.go` with a heredoc:

```bash
cat >> pkg/wshrpc/wshserver/wshserver_channels_test.go <<'EOF'

func TestCreateChannelCommandIsIdempotentPerProject(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	first, err := ws.CreateChannelCommand(ctx, wshrpc.CommandCreateChannelData{Name: "wave", ProjectPath: "/repo/wave"})
	if err != nil {
		t.Fatalf("first CreateChannelCommand: %v", err)
	}
	second, err := ws.CreateChannelCommand(ctx, wshrpc.CommandCreateChannelData{Name: "wave again", ProjectPath: "/repo/wave/"})
	if err != nil {
		t.Fatalf("second CreateChannelCommand: %v", err)
	}
	if second.OID != first.OID {
		t.Fatalf("second create made a new channel %s, want the existing %s", second.OID, first.OID)
	}
	// the existing channel is returned as it stands: a second create does not rename it
	if second.Name != "wave" {
		t.Fatalf("second create renamed the channel to %q, want %q", second.Name, "wave")
	}
}

func TestCreateChannelCommandStillCreatesWithoutAProject(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	a, err := ws.CreateChannelCommand(ctx, wshrpc.CommandCreateChannelData{Name: "scratch one"})
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	b, err := ws.CreateChannelCommand(ctx, wshrpc.CommandCreateChannelData{Name: "scratch two"})
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if a.OID == b.OID {
		t.Fatalf("two pathless channels collapsed onto %s; a pathless channel is not a project", a.OID)
	}
}
EOF
```

No import changes here: `pkg/wshrpc/wshserver/wshserver_channels_test.go` already imports `context`, `testing`, `waveobj`, `wshrpc` and `wstore`.

- [ ] **Step 6: Run the RPC test to verify it fails**

```powershell
go test ./pkg/wshrpc/wshserver/ -run TestCreateChannelCommand -v
```
Expected: FAIL — `TestCreateChannelCommandIsIdempotentPerProject` reports a new OID from the second create.

- [ ] **Step 7: Make the command idempotent**

In `pkg/wshrpc/wshserver/wshserver_channels.go`, replace `CreateChannelCommand` (currently lines 20-26):

```go
func (ws *WshServer) CreateChannelCommand(ctx context.Context, data wshrpc.CommandCreateChannelData) (*waveobj.Channel, error) {
	// One channel per project: the channel is storage for "work in this project", and the cockpit labels
	// every channel with its project's name, so a second one at the same path is a row the user cannot
	// tell from the first. Mirrors wconfig.ProjectNameAtPath, which already refuses a second project at
	// one path. Returning the existing channel rather than an error is deliberate — two windows racing
	// the frontend's find-or-create both want the same end state, and an error there is a failed launch.
	existing, err := wstore.ChannelAtPath(ctx, data.ProjectPath)
	if err != nil {
		return nil, fmt.Errorf("looking for this project's channel: %w", err)
	}
	if existing != nil {
		return existing, nil
	}
	ch, err := wstore.CreateChannel(ctx, data.Name, data.ProjectPath)
	if err != nil {
		return nil, fmt.Errorf("creating channel: %w", err)
	}
	return ch, nil
}
```

- [ ] **Step 8: Run the RPC test to verify it passes**

```powershell
go test ./pkg/wshrpc/wshserver/ -run TestCreateChannelCommand -v
```
Expected: PASS, both tests.

- [ ] **Step 9: Run the full backend suite and confirm no wire drift**

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/...
```
Expected: all packages pass. Then:

```bash
task generate
git status --short
```
Expected: `task generate` reports no changes to tracked generated files — this task changed no wire types. If it does change them, stop: something in `wshrpctypes_*.go` moved that should not have.

- [ ] **Step 10: Rebuild the backend so live checks hit the new binary**

```bash
task build:backend
```
A worktree build writes to *that* worktree's `dist/bin`; if you are in one, the main checkout's `wavesrv` stays stale and any live check will route against the old command.

- [ ] **Step 11: Commit**

```bash
git add pkg/wstore/wstore_channel.go pkg/wstore/wstore_channel_test.go pkg/wshrpc/wshserver/wshserver_channels.go pkg/wshrpc/wshserver/wshserver_channels_test.go
git commit -m "feat(channels): one channel per project, enforced at create"
```

---

### Task 8: Record the sub-project and verify it live

**Files:**
- Modify: `docs/superpowers/specs/2026-09-09-jarvis-brief-meta-spec.md` — the tracking table (rows at `:197-201`) and its `**Status:**` line (`:4`)
- Modify: `docs/open-issues.md` — only if the live pass finds something this plan does not cover

**Interfaces:**
- Consumes: every prior task.
- Produces: nothing code-facing.

- [ ] **Step 1: Add the B6 row**

Append to the tracking table in `docs/superpowers/specs/2026-09-09-jarvis-brief-meta-spec.md`, immediately after the `| B5 |` row, matching the existing `| # | Sub-project | Plan | Built |` format:

```markdown
| B6 | Channel → project collapse | [Plan](../plans/2026-09-11-channel-to-project-collapse.md) | **Built** — `+ Channel` became `+ Run` (`newruncontrol.tsx`, `newrun.ts`): one modal taking a project and a goal, resolving the project's channel by path or minting one, then `CreateRun` — so the goal box is in the doorway instead of two clicks into the sheet, and Radar's "Start investigation" can no longer silently drop a draft for a project with no channel. `projectLabel` / `dedupeByProject` (`projectlabel.ts`) became the only name a channel may render, consumed by the sheet, the launcher, the autonomy ladder, the profile picker, the palette's `#` scope, Peter Rand's destination picker, the composer's target label and the shortcut cheat sheet. `CreateChannelCommand` is idempotent per project path (`wstore.ChannelAtPath`), mirroring `wconfig.ProjectNameAtPath`. The `c` binding became `r` / `jarvis:new-run`. Deliberately not done: the Go `Channel` type keeps its name, the palette's internal `parseScope` discriminator stays `"channel"`, and rename/archive semantics are still channel-shaped — see the plan's "Open decision". |
```

Update the file's `**Status:**` line (`:4`) so B6 appears in the built list.

- [ ] **Step 2: Verify live over CDP**

The cockpit has no jsdom render harness — rendered UI is verified against the running dev app. With `task dev` running:

```bash
task verify:ui -- surface-smoke brief-surface
```
Expected: PASS for both. Two scenarios are known-bad before this plan and must be discounted rather than chased: `jarvis-ask` (0/2 — it still sends Ctrl+P, but the palette moved to Ctrl+Shift+P) and `harness-picker` (0/0 — its arrange trips the `wshserver.go:247` guard whenever a preferred runtime is set).

If CDP refuses with `ECONNREFUSED` on `:9222`, check the dev log for "going away" first — a concurrent session's edit crashing `task dev` looks exactly like a CDP fault.

- [ ] **Step 3: Walk the changed surfaces by hand**

With the dev app up, confirm each of these reads as a project and never as a channel:

1. Press `r` on the Brief → the New run modal opens, lists projects, focus is in the goal field.
2. Pick a project, type a goal, press ⌘⏎ → the sheet opens on a live run.
3. Press `r` again, same project, new goal → **no second channel appears**; the run lands in the same project.
4. Open the palette, type `#` → rows are project names, the hint row reads "# projects", and an unmatched token says "No project matches …".
5. Open the Brief's Profile sheet → the picker lists one row per project, with the path beneath as the disambiguator.
6. The autonomy ladder rows are project names.
7. Peter Rand's destination select lists project names.
8. Open the shortcuts cheat sheet (`?`) → "Next run in this project", "Previous run in this project", and the `g c` target reads "Jarvis (projects, records, recall)".
9. Let a run finish → the completion header's breadcrumb reads `<project> / run <id>`, with no `#`.

- [ ] **Step 4: Commit the doc with the feature**

Spec and plan docs fold into the feature commit they describe — never a separate docs-only commit. Since Tasks 1-7 are already committed, amend this doc onto the last of them or commit it with whatever the live pass fixed:

```bash
git add docs/superpowers/specs/2026-09-09-jarvis-brief-meta-spec.md
git commit -m "docs(jarvis): record B6, the channel to project collapse"
```

---

## Open decision (not planned — needs a call before anyone builds it)

**What do `renameChannel` and archive mean once a channel is a project?**

Both RPCs exist and keep working after this plan; nothing in Tasks 1-8 touches them. But under a 1:1 collapse they are project operations wearing channel clothes, and they cannot simply be ported:

- **Rename.** `RenameChannelCommand` writes `Channel.Name`, which after Task 1 is a fallback nothing displays for a registered project. Renaming a *project* means editing `projects.json` (`wconfig.SetProjectConfigValue`) — a different store, a different command, and it changes the name every surface shows. Either rename becomes a project-registry operation, or it is removed as dead.
- **Archive.** `partitionChannels` reads a `Channel.Meta` `archived` flag and the Brief tucks archived rows away. "Archive a project" is a plausible feature, but it currently hides a *channel* and the project stays registered, so the two nouns disagree about what is hidden.

Resolve these before touching either command. Recording the resolution belongs in `docs/deferred.md` if the answer is "drop it", with the `git show COMMIT:path` recovery command for whatever is deleted.

## Known pre-existing conditions (not caused by this plan)

- `scripts/cdp/jarvis-tour.mjs` asserts the two-step `+ Channel` picker, the deleted Subjects column and B5's deleted empty-Stage copy. Already broken, wired into no task.
- `scripts/cdp/scenarios.mjs` has 13 `no-undef` eslint errors. Pre-existing; "clean" is the wrong word for that file.
- The CDP suite stands at 30 registrations and has not had a full live pass since B5 — several survivors still select a channel row from the deleted column.
- **`frontend/app/view/agents/channelcomposers.tsx` is dead.** Both its exports, `LaunchComposer` (`:35`) and `TalkComposer` (`:227`), have zero references anywhere in `frontend/` — B5 deleted the Stage that mounted them and left the file behind. `LaunchComposer:137` carries a `→ direct quick launch in #${channelName}` string that this sweep would otherwise have to rewrite, which is how it surfaced. **No task touches it**: deleting ~250 lines of composer is a separate call from a terminology sweep, and the strings it holds are not rendered to anyone. Raise it for a decision rather than folding it in.
