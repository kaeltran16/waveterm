# Command Transcript Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render slash commands, skill invocations, and conversation compaction as purpose-built elements in the agent transcript instead of raw "You" bubbles, and suppress synthetic (`isMeta`) records. Also render inline markdown in the cockpit recent-activity peek.

**Architecture:** Pure frontend. `transcriptprojection.ts` (Claude transcript → `AgentEntry[]`) gains two new entry kinds (`command`, `compaction`) and suppresses `isMeta` records; `narrationtimeline.tsx` renders a command/skill pill and a compaction divider; three consumers (`groupTimeline`, `conversationText`, `recentactivity`) pass the new kinds through. A small inline-markdown renderer handles the recent-activity peek.

**Tech Stack:** TypeScript, React 19, Tailwind v4 (`@theme` tokens), jotai, vitest, react-markdown.

**Design spec:** `docs/superpowers/specs/2026-07-09-command-transcript-renderer-design.md`

**Approved visuals (visual-companion mockups, for reference while implementing the render tasks):**
- Command pill (slash-only, no glyph): `.superpowers/brainstorm/1310-1783570286/content/slash-variants.html` (variant 1) and `command-render.html` (Option A minus glyph)
- Skill chip (distinct hue + `✦`, leaf name): `.superpowers/brainstorm/1310-1783570286/content/skill-render.html` (Option B)
- Compaction divider + expandable summary: `.superpowers/brainstorm/1310-1783570286/content/compaction-event.html` (Option A/B — divider with trigger + token reduction, summary expandable)

Open these files in a browser (or via the companion server if still running) to match spacing, hues, and layout exactly.

---

## Git / commit policy (overrides the skill default)

The user's git rules are STRICT: **never commit without explicit approval; batch all work into ONE commit at the end.** Therefore each task ends with a **Checkpoint** (verify green), NOT a commit. The single commit is Task 11, gated on approval. Do not `git add`/`git commit` before then.

## Conventions

- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0); any error it reports is yours.
- **Run one test file:** `npx vitest run frontend/app/view/agents/<file>.test.ts`
- **Filter by name:** `npx vitest run -t "compaction"`
- **No hardcoded colors** in `className`/`style` — use `@theme` tokens (generated utilities). **No new SCSS** — Tailwind only.
- **Never hand-edit generated files.** None are touched here.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `frontend/app/view/agents/agentsviewmodel.ts` | modify | Add `command`/`compaction` to `AgentEntry` + `TimelineItem`; pass through `groupTimeline` + `conversationText`. |
| `frontend/app/view/agents/transcriptprojection.ts` | modify | Parse command tags; suppress `isMeta`; route user-invoked skills to command; build compaction from boundary+summary. |
| `frontend/app/view/agents/recentactivity.ts` | modify | Describe the two new kinds for the activity peek. |
| `frontend/app/view/agents/narrationtimeline.tsx` | modify | `CommandChip` + `CompactionDivider` + render branches. |
| `frontend/tailwindsetup.css` | modify | Add `--color-skill` / `--color-skill-soft`. |
| `frontend/app/view/agents/inlinemarkdown.tsx` | create | `condenseToLine()` (pure) + `InlineMarkdown` component. |
| `frontend/app/view/agents/inlinemarkdown.test.ts` | create | Unit-test `condenseToLine()`. |
| `frontend/app/view/agents/cockpitsurface.tsx` | modify | Render the recent-activity peek text via `InlineMarkdown`. |
| `frontend/app/view/agents/transcriptprojection.test.ts` | modify | New cases: command / skill-chip / compaction / isMeta-skip. |
| `frontend/app/view/agents/agentsviewmodel.test.ts` | modify | `groupTimeline` + `conversationText` pass-through cases. |
| `frontend/app/view/agents/recentactivity.test.ts` | modify | Describe command / compaction. |

---

## Task 1: Add `command` + `compaction` entry kinds and pass them through the view-model

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (union `~34-46`, `TimelineItem` `~208-213`, `groupTimeline` `~255-269`, `conversationText` `~287-294`)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Add the two entry kinds to `AgentEntry`**

In `agentsviewmodel.ts`, extend the `AgentEntry` union (after the `action` member, before the closing of the type at ~line 46):

```ts
export type AgentEntry =
    | { kind: "message"; text: string }
    | { kind: "user"; text: string }
    | { kind: "command"; name: string; args?: string; isSkill?: boolean }
    | { kind: "compaction"; trigger?: string; preTokens?: number; postTokens?: number; summary?: string }
    | {
          kind: "action";
          verb: string;
          target: string;
          outcome?: "ok" | "fail";
          note?: string;
          summary?: string;
          durationMs?: number;
          detail?: ActionDetail;
      };
```

- [ ] **Step 2: Add the two kinds to `TimelineItem`**

Extend the `TimelineItem` union (~line 208):

```ts
export type TimelineItem =
    | { kind: "message"; text: string; index: number }
    | { kind: "user"; text: string; index: number }
    | { kind: "command"; name: string; args?: string; isSkill?: boolean; index: number }
    | { kind: "compaction"; trigger?: string; preTokens?: number; postTokens?: number; summary?: string; index: number }
    | { kind: "action"; action: AgentActionEntry; index: number }
    | { kind: "group"; startIndex: number; actions: AgentActionEntry[] }
    | { kind: "edit-burst"; startIndex: number; files: EditFile[]; adds: number; dels: number };
```

- [ ] **Step 3: Write failing tests for `groupTimeline` + `conversationText` pass-through**

Add to `agentsviewmodel.test.ts` (import `groupTimeline`, `conversationText`, `type AgentEntry` if not already imported):

```ts
describe("groupTimeline command/compaction", () => {
    it("passes command and compaction through as standalone items, keeping order and flushing runs", () => {
        const entries: AgentEntry[] = [
            { kind: "command", name: "/review", args: "PR #402" },
            { kind: "action", verb: "ran", target: "gh pr diff" },
            { kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859, summary: "kept" },
            { kind: "command", name: "brainstorming", args: "x", isSkill: true },
        ];
        const items = groupTimeline(entries);
        expect(items.map((i) => i.kind)).toEqual(["command", "action", "compaction", "command"]);
        expect(items[0]).toEqual({ kind: "command", name: "/review", args: "PR #402", isSkill: undefined, index: 0 });
        expect(items[2]).toEqual({
            kind: "compaction",
            trigger: "manual",
            preTokens: 415334,
            postTokens: 22859,
            summary: "kept",
            index: 2,
        });
        expect(items[3]).toMatchObject({ kind: "command", name: "brainstorming", isSkill: true, index: 3 });
    });
});

describe("conversationText command/compaction", () => {
    it("includes commands as slash lines and skips compaction", () => {
        const entries: AgentEntry[] = [
            { kind: "user", text: "hi" },
            { kind: "command", name: "/clear" },
            { kind: "command", name: "brainstorming", args: "design x", isSkill: true },
            { kind: "compaction", summary: "big summary" },
            { kind: "message", text: "done" },
        ];
        expect(conversationText(entries)).toBe("hi\n\n/clear\n\n/brainstorming design x\n\ndone");
    });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "command/compaction"`
Expected: FAIL — `groupTimeline` currently emits `user` items (or drops them), `conversationText` omits commands.

- [ ] **Step 5: Update `groupTimeline` to route the new kinds**

Replace the `flush(); if (e.kind === "message") {...} else {...}` block (~lines 263-268) with an explicit switch over the non-action kinds:

```ts
        flush();
        if (e.kind === "message") {
            items.push({ kind: "message", text: e.text, index: i });
        } else if (e.kind === "user") {
            items.push({ kind: "user", text: e.text, index: i });
        } else if (e.kind === "command") {
            items.push({ kind: "command", name: e.name, args: e.args, isSkill: e.isSkill, index: i });
        } else if (e.kind === "compaction") {
            items.push({
                kind: "compaction",
                trigger: e.trigger,
                preTokens: e.preTokens,
                postTokens: e.postTokens,
                summary: e.summary,
                index: i,
            });
        }
```

- [ ] **Step 6: Update `conversationText` to include commands, skip compaction**

Replace the loop body in `conversationText` (~lines 289-292):

```ts
    for (const e of entries) {
        if (e.kind === "message" || e.kind === "user") {
            out.push(e.text);
        } else if (e.kind === "command") {
            const name = e.isSkill ? "/" + e.name : e.name;
            out.push(e.args ? `${name} ${e.args}` : name);
        }
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "command/compaction"`
Expected: PASS (2 new tests). Also run the whole file to confirm no regressions: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` → all pass.

- [ ] **Step 8: Checkpoint** — typecheck clean: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0. Do not commit.

---

## Task 2: Suppress `isMeta` records and parse slash commands in the projection

**Files:**
- Modify: `frontend/app/view/agents/transcriptprojection.ts` (helpers near top; `user` branch ~114-121)
- Test: `frontend/app/view/agents/transcriptprojection.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `transcriptprojection.test.ts` inside a new `describe`:

```ts
describe("projectTranscript commands and isMeta", () => {
    const L = (o: unknown) => JSON.stringify(o);

    it("parses a <command-name> user string into a command entry (slash kept, message dropped, args when present)", () => {
        const withArgs = "<command-name>/review</command-name>\n  <command-message>review</command-message>\n  <command-args>PR #402</command-args>";
        const bare = "<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>";
        expect(projectTranscript([L({ type: "user", message: { content: withArgs } })])).toEqual([
            { kind: "command", name: "/review", args: "PR #402" },
        ]);
        expect(projectTranscript([L({ type: "user", message: { content: bare } })])).toEqual([
            { kind: "command", name: "/clear" },
        ]);
    });

    it("normalizes a command-name that lacks a leading slash", () => {
        const out = projectTranscript([
            L({ type: "user", message: { content: "<command-name>compact</command-name><command-args></command-args>" } }),
        ]);
        expect(out).toEqual([{ kind: "command", name: "/compact" }]);
    });

    it("skips synthetic isMeta user records (skill body dumps, caveats, continuation)", () => {
        const out = projectTranscript([
            L({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "# Skill body\n\nlong markdown" }] } }),
            L({ type: "user", isMeta: true, message: { content: "<local-command-caveat>Caveat…</local-command-caveat>" } }),
            L({ type: "user", message: { content: "real prompt" } }),
        ]);
        expect(out).toEqual([{ kind: "user", text: "real prompt" }]);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts -t "commands and isMeta"`
Expected: FAIL — commands render as `{kind:"user"}` with raw tags; isMeta bodies render as user text.

- [ ] **Step 3: Add the two parse helpers near the top of the file**

In `transcriptprojection.ts`, add above `projectTranscript` (after the `ActionEntry` type at ~line 55):

```ts
// A slash command lands as a user-record string of XML-ish tags. Parse the name + args and drop the
// redundant <command-message>. Returns null when the string isn't a command payload.
function parseCommand(content: string): { name: string; args?: string } | null {
    const nameMatch = /<command-name>([^]*?)<\/command-name>/.exec(content);
    if (nameMatch == null) {
        return null;
    }
    const raw = nameMatch[1].trim();
    const name = raw.startsWith("/") ? raw : "/" + raw;
    const argsMatch = /<command-args>([^]*?)<\/command-args>/.exec(content);
    const args = argsMatch ? argsMatch[1].trim() : "";
    return args !== "" ? { name, args } : { name };
}

// "superpowers:brainstorming" -> "brainstorming"; "commit" -> "commit".
function skillLeaf(skill: string): string {
    const parts = skill.split(":");
    return parts[parts.length - 1] || skill;
}
```

- [ ] **Step 4: Rewrite the head of the `user` branch**

Replace the start of the `if (rec.type === "user") {` block (the part that handles string content, ~lines 114-121) so it reads:

```ts
        if (rec.type === "user") {
            if (rec.isMeta === true) {
                // synthetic injection (skill body, local-command caveat, continuation prompt, image
                // placeholder) — never a real user turn
                continue;
            }
            const content = rec?.message?.content;
            if (typeof content === "string") {
                const cmd = parseCommand(content);
                if (cmd != null) {
                    entries.push({ kind: "command", ...cmd });
                } else if (content.trim() !== "") {
                    entries.push({ kind: "user", text: content });
                }
                continue;
            }
            if (!Array.isArray(content)) {
                continue;
            }
            for (const block of content) {
```

(The `for (const block of content)` loop body — text blocks and tool_result handling — stays exactly as it is today. `skillLeaf` is used in Task 3; TypeScript may warn it is unused until then — that is expected mid-task.)

- [ ] **Step 5: Run to verify passing**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts -t "commands and isMeta"`
Expected: PASS. Run the whole file too: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts` → all pass (existing tests unaffected: none use `isMeta`, and command strings weren't previously exercised).

- [ ] **Step 6: Checkpoint** — do not commit. (Typecheck may still flag `skillLeaf` as unused until Task 3; that is fine within this batch. If running tsc now, expect that single "declared but never read" note and no others.)

---

## Task 3: Route user-invoked skills (`caller.type === "direct"`) to a command chip

**Files:**
- Modify: `frontend/app/view/agents/transcriptprojection.ts` (tool_use handling ~81-104)
- Test: `frontend/app/view/agents/transcriptprojection.test.ts`

Rationale: every observed skill call is `caller.type:"direct"` (a user-typed `/skill`). We render those as command chips (`isSkill:true`, leaf name). Any non-direct skill keeps the existing `skill` action line, so the two existing skill tests (lines ~209-223) stay green and the `skill` ActionDetail path stays live.

- [ ] **Step 1: Write failing tests**

Add to the `describe("projectTranscript commands and isMeta")` block:

```ts
    it("renders a user-invoked skill (caller.direct) as a skill command chip with the leaf name", () => {
        const out = projectTranscript([
            L({
                type: "assistant",
                message: {
                    content: [
                        { type: "tool_use", id: "s1", name: "Skill", input: { skill: "superpowers:brainstorming", args: "design the cache" }, caller: { type: "direct" } },
                    ],
                },
            }),
        ]);
        expect(out).toEqual([{ kind: "command", name: "brainstorming", isSkill: true, args: "design the cache" }]);
    });

    it("omits args for a skill chip with no args", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "s2", name: "Skill", input: { skill: "commit" }, caller: { type: "direct" } }] } }),
        ]);
        expect(out).toEqual([{ kind: "command", name: "commit", isSkill: true }]);
    });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts -t "skill"`
Expected: FAIL on the two new tests (they currently produce `{kind:"action", verb:"skill"}`). The two pre-existing skill tests (no `caller`) should still PASS.

- [ ] **Step 3: Add the direct-skill branch before the action is built**

In the `if (block?.type === "tool_use" && typeof block.name === "string") {` block (~line 81), insert at the very top, before `const action: ActionEntry = ...`:

```ts
                if (block?.type === "tool_use" && typeof block.name === "string") {
                    // user-typed /skill routes through the Skill tool (caller "direct") -> render as a
                    // command chip, not a tool action. Non-direct skills keep the skill action line.
                    if (block.name === "Skill" && block?.caller?.type === "direct" && typeof block.input?.skill === "string") {
                        const args = typeof block.input.args === "string" ? block.input.args.trim() : "";
                        entries.push({
                            kind: "command",
                            name: skillLeaf(block.input.skill),
                            isSkill: true,
                            ...(args !== "" ? { args } : {}),
                        });
                        continue;
                    }
                    const action: ActionEntry = { kind: "action", verb: verbFor(block.name), target: targetFor(block.input) };
```

(The rest of the tool_use handling is unchanged. `continue` here continues the `for (const block of content)` loop, correctly skipping action creation for this block.)

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: PASS — the two new skill-chip tests pass; the two legacy skill-action tests (no `caller`) still pass.

- [ ] **Step 5: Checkpoint** — do not commit. Typecheck clean now that `skillLeaf` is used: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.

---

## Task 4: Build a compaction entry from the boundary + summary records

**Files:**
- Modify: `frontend/app/view/agents/transcriptprojection.ts` (helper + `user` isCompactSummary rule + new `system` branch)
- Test: `frontend/app/view/agents/transcriptprojection.test.ts`

Ground truth: a `type:"system"` `subtype:"compact_boundary"` record (carrying `compactMetadata.{trigger,preTokens,postTokens}`) is immediately followed by a `type:"user"` `isCompactSummary:true` record (the summary string; **not** `isMeta`). Merge them into one entry; tolerate either being absent.

- [ ] **Step 1: Write failing tests**

Add a new `describe`:

```ts
describe("projectTranscript compaction", () => {
    const L = (o: unknown) => JSON.stringify(o);
    const boundary = L({
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 415334, postTokens: 22859 },
    });
    const summary = L({ type: "user", isCompactSummary: true, message: { content: "This session is being continued…\n\nSummary:\n**kept**" } });

    it("merges an adjacent boundary + summary into one compaction entry", () => {
        expect(projectTranscript([boundary, summary])).toEqual([
            { kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859, summary: "This session is being continued…\n\nSummary:\n**kept**" },
        ]);
    });

    it("produces a summary-only compaction when there is no boundary", () => {
        expect(projectTranscript([summary])).toEqual([
            { kind: "compaction", summary: "This session is being continued…\n\nSummary:\n**kept**" },
        ]);
    });

    it("produces a stats-only compaction when there is no summary", () => {
        expect(projectTranscript([boundary])).toEqual([
            { kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859 },
        ]);
    });

    it("does not fold a real user turn into the compaction", () => {
        const out = projectTranscript([boundary, L({ type: "user", message: { content: "next thing" } }), summary]);
        expect(out).toEqual([
            { kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859 },
            { kind: "user", text: "next thing" },
            { kind: "compaction", summary: "This session is being continued…\n\nSummary:\n**kept**" },
        ]);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts -t "compaction"`
Expected: FAIL — `system` records are ignored; `isCompactSummary` renders as a user bubble.

- [ ] **Step 3: Add the merge helper near the other helpers**

```ts
// Fold the compact_boundary (stats) and the isCompactSummary user record (summary) — adjacent
// records, either may be absent — into one entry. Merge into the trailing compaction entry when the
// previous entry is one; otherwise start a new entry.
function mergeCompaction(entries: AgentEntry[], patch: Partial<Extract<AgentEntry, { kind: "compaction" }>>): void {
    const last = entries[entries.length - 1];
    if (last != null && last.kind === "compaction") {
        Object.assign(last, patch);
        return;
    }
    entries.push({ kind: "compaction", ...patch });
}
```

- [ ] **Step 4: Add the `isCompactSummary` rule at the top of the `user` branch**

Immediately after the `if (rec.isMeta === true) { continue; }` guard added in Task 2, and before `const content = rec?.message?.content;`, insert:

```ts
            if (rec.isCompactSummary === true) {
                const raw = rec?.message?.content;
                const summary =
                    typeof raw === "string"
                        ? raw
                        : Array.isArray(raw)
                          ? raw.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
                          : "";
                mergeCompaction(entries, summary.trim() !== "" ? { summary } : {});
                continue;
            }
```

- [ ] **Step 5: Add the `system` compact_boundary branch**

At the end of the `for` loop over `lines`, after the `if (rec.type === "user") { … }` block closes (before the loop's closing brace), add:

```ts
        if (rec.type === "system" && rec.subtype === "compact_boundary") {
            const m = rec.compactMetadata ?? {};
            const patch: Partial<Extract<AgentEntry, { kind: "compaction" }>> = {};
            if (typeof m.trigger === "string") {
                patch.trigger = m.trigger;
            }
            if (typeof m.preTokens === "number") {
                patch.preTokens = m.preTokens;
            }
            if (typeof m.postTokens === "number") {
                patch.postTokens = m.postTokens;
            }
            mergeCompaction(entries, patch);
            continue;
        }
```

- [ ] **Step 6: Run to verify passing**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: PASS (all compaction tests + every prior test).

- [ ] **Step 7: Checkpoint** — typecheck clean; do not commit.

---

## Task 5: Describe the new kinds in the recent-activity peek

**Files:**
- Modify: `frontend/app/view/agents/recentactivity.ts` (`describe`, ~20-28)
- Test: `frontend/app/view/agents/recentactivity.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `recentactivity.test.ts` (mirror the existing `buildRecentActivity` call style; reuse whatever agent-factory helper the file already defines — shown here as `mk`):

```ts
it("describes a command entry with its slash name and args", () => {
    const out = buildRecentActivity([mk("a", "working")], { a: [{ kind: "command", name: "/review", args: "PR #402" }] }, { a: 5 }, 5, 0);
    expect(out[0]).toMatchObject({ text: "/review PR #402", typeLabel: "command" });
});

it("describes a skill command with a slash-prefixed leaf name", () => {
    const out = buildRecentActivity([mk("a", "working")], { a: [{ kind: "command", name: "brainstorming", args: "x", isSkill: true }] }, { a: 5 }, 5, 0);
    expect(out[0]).toMatchObject({ text: "/brainstorming x", typeLabel: "skill" });
});

it("describes a compaction entry as compacted", () => {
    const out = buildRecentActivity([mk("a", "working")], { a: [{ kind: "compaction", trigger: "manual", preTokens: 1, postTokens: 1 }] }, { a: 5 }, 5, 0);
    expect(out[0]).toMatchObject({ text: "Conversation compacted", typeLabel: "compacted" });
});
```

If `recentactivity.test.ts` does not already define an agent factory, add one matching the existing pattern:

```ts
const mk = (id: string, state: AgentState): AgentVM => ({ id, name: id, state } as AgentVM);
```

(Only add it if the file lacks one — check first to avoid a duplicate identifier.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/recentactivity.test.ts -t "command\|skill\|compaction"`
Expected: FAIL — `describe` falls through to the action branch and reads `entry.verb`/`entry.target` (undefined).

- [ ] **Step 3: Update `describe`**

Replace the body of `describe` in `recentactivity.ts`:

```ts
function describe(entry: AgentEntry): { text: string; typeLabel: string } {
    if (entry.kind === "message") {
        return { text: entry.text, typeLabel: "said" };
    }
    if (entry.kind === "user") {
        return { text: entry.text, typeLabel: "you" };
    }
    if (entry.kind === "command") {
        const name = entry.isSkill ? "/" + entry.name : entry.name;
        return { text: entry.args ? `${name} ${entry.args}` : name, typeLabel: entry.isSkill ? "skill" : "command" };
    }
    if (entry.kind === "compaction") {
        return { text: "Conversation compacted", typeLabel: "compacted" };
    }
    return { text: `${entry.verb} ${entry.target}`.trim(), typeLabel: entry.verb };
}
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run frontend/app/view/agents/recentactivity.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Checkpoint** — typecheck clean; do not commit.

---

## Task 6: Add the skill hue theme tokens

**Files:**
- Modify: `frontend/tailwindsetup.css` (after `--color-accentbg`, ~line 52)

- [ ] **Step 1: Add the tokens**

After the accent block (`--color-accentbg: rgba(124, 149, 255, 0.12);`, ~line 52), add:

```css
    /* skill invocation chip (distinct from accent commands) */
    --color-skill: #c58cff;
    --color-skill-soft: #dcc0ff;
```

- [ ] **Step 2: Verify utilities generate**

Run typecheck (unaffected) and confirm the dev server (if running) HMR-reloads. There is no unit test for CSS. Verified visually in Task 7. Tailwind v4 generates `text-skill`, `text-skill-soft`, `bg-skill/[…]`, `border-skill/[…]` from these tokens.

- [ ] **Step 3: Checkpoint** — do not commit.

---

## Task 7: Render `CommandChip` + `CompactionDivider` in the timeline

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx` (imports ~10-23; add components; add branches in the `items.map` ~349-373)

No unit test (no cockpit render harness — per CLAUDE.md, verify via CDP). Match the approved mockups referenced at the top of this plan.

- [ ] **Step 1: Import `formatTokens`**

In the import block from `./agentsviewmodel` (~lines 10-20), add `formatTokens` to the named imports:

```ts
import {
    burstRenderMode,
    conversationText,
    detailExceedsInline,
    formatTokens,
    groupTimeline,
    summarizeActions,
    type ActionDetail,
    type AgentActionEntry,
    type AgentEntry,
    type EditFile,
} from "./agentsviewmodel";
```

- [ ] **Step 2: Add the `CommandChip` component**

Add above `NarrationTimeline` (e.g. after `EditBurstRow`):

```tsx
// A slash command or user-invoked skill. Right-aligned monospace pill. Commands use the accent hue
// and keep their slash; skills use a distinct hue + ✦ mark and a leaf name (see skill-render.html /
// slash-variants.html). Args, when present, sit behind a faint divider.
function CommandChip({ name, args, isSkill }: { name: string; args?: string; isSkill?: boolean }) {
    return (
        <div className="mt-2 flex justify-end">
            <span
                className={cn(
                    "inline-flex max-w-[88%] flex-wrap items-baseline rounded-lg border px-[11px] py-[5px] font-mono",
                    isSkill ? "border-skill/35 bg-skill/[0.08]" : "border-accent/35 bg-accent/[0.07]"
                )}
            >
                {isSkill ? <span className="mr-[7px] self-center text-[11px] text-skill">✦</span> : null}
                <span className={cn("text-[12px] font-semibold", isSkill ? "text-skill-soft" : "text-accent-soft")}>
                    {name}
                </span>
                {args ? (
                    <span
                        className={cn(
                            "ml-2 border-l pl-2 text-[11.5px] text-feed-summary",
                            isSkill ? "border-skill/25" : "border-accent/25"
                        )}
                    >
                        {args}
                    </span>
                ) : null}
            </span>
        </div>
    );
}
```

- [ ] **Step 3: Add the `CompactionDivider` component**

```tsx
// A conversation-compaction marker (see compaction-event.html). Centered rule + a pill showing the
// token reduction and trigger. When a summary is present the pill toggles an expandable, markdown-
// rendered "kept context" box; otherwise it is a static divider.
function CompactionDivider({
    trigger,
    preTokens,
    postTokens,
    summary,
}: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    summary?: string;
}) {
    const [open, setOpen] = useState(false);
    const stat = preTokens != null && postTokens != null ? `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens` : null;
    const canExpand = !!summary;
    return (
        <div className="mt-3.5">
            <button
                type="button"
                disabled={!canExpand}
                onClick={() => setOpen((v) => !v)}
                className={cn("flex w-full items-center gap-2.5", canExpand ? "cursor-pointer" : "cursor-default")}
            >
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
                <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-accent/30 bg-accent/[0.07] px-[11px] py-[3px] font-mono text-[10px]">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-accent-soft">Compacted</span>
                    {stat ? (
                        <>
                            <span className="text-edge-strong">·</span>
                            <span className="text-feed-summary">{stat}</span>
                        </>
                    ) : null}
                    {trigger ? (
                        <>
                            <span className="text-edge-strong">·</span>
                            <span className="text-muted">{trigger}</span>
                        </>
                    ) : null}
                    {canExpand ? <span className="text-[8px] text-muted">{open ? "▲" : "▼"}</span> : null}
                </span>
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
            </button>
            <AnimatePresence initial={false}>
                {open && summary ? (
                    <motion.div
                        key="sum"
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="my-2 overflow-hidden rounded-[10px] border border-edge-faint bg-surface-code px-3.5 py-3"
                    >
                        <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.06em] text-feed-label">
                            Summary — kept context
                        </div>
                        <MarkdownMessage text={summary} />
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
```

- [ ] **Step 4: Add render branches in `NarrationTimeline`'s `items.map`**

After the `if (item.kind === "user") { … }` return block (~line 367) and before `if (item.kind === "action")`, add:

```tsx
                if (item.kind === "command") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <CommandChip name={item.name} args={item.args} isSkill={item.isSkill} />
                        </motion.div>
                    );
                }
                if (item.kind === "compaction") {
                    return (
                        <motion.div
                            key={item.index}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                        >
                            <CompactionDivider
                                trigger={item.trigger}
                                preTokens={item.preTokens}
                                postTokens={item.postTokens}
                                summary={item.summary}
                            />
                        </motion.div>
                    );
                }
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Visual verification (CDP)**

Ensure `task dev` is running (headless: `tail -f /dev/null | task dev`). Inject or open an agent whose transcript contains a slash command, a `/skill`, and a compaction. Capture: `node scripts/cdp-shot.mjs transcript-render.png`. Confirm against the mockups:
- command → accent pill, slash name, args behind divider;
- skill → purple `✦` chip, leaf name;
- compaction → centered `Compacted · Nk → Mk tokens · manual` divider; clicking expands the markdown summary; no giant You bubble anywhere; no skill-body dump.

- [ ] **Step 7: Checkpoint** — do not commit.

---

## Task 8: `condenseToLine` pure util for the recent-activity peek

**Files:**
- Create: `frontend/app/view/agents/inlinemarkdown.tsx`
- Create: `frontend/app/view/agents/inlinemarkdown.test.ts`

- [ ] **Step 1: Write the failing test**

Create `inlinemarkdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { condenseToLine } from "./inlinemarkdown";

describe("condenseToLine", () => {
    it("keeps a plain first line unchanged", () => {
        expect(condenseToLine("just a line")).toBe("just a line");
    });
    it("strips a leading heading marker", () => {
        expect(condenseToLine("## Direct answer")).toBe("Direct answer");
    });
    it("strips a leading bullet or blockquote or ordered marker", () => {
        expect(condenseToLine("- item one")).toBe("item one");
        expect(condenseToLine("> quoted")).toBe("quoted");
        expect(condenseToLine("1. first")).toBe("first");
    });
    it("takes only the first paragraph and folds inner newlines to spaces", () => {
        expect(condenseToLine("line one\nline two\n\nsecond para")).toBe("line one line two");
    });
    it("leaves inline emphasis markers for the renderer", () => {
        expect(condenseToLine("**bold** and `code`")).toBe("**bold** and `code`");
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/agents/inlinemarkdown.test.ts`
Expected: FAIL — module/`condenseToLine` not found.

- [ ] **Step 3: Create `inlinemarkdown.tsx` with `condenseToLine`**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { openLink } from "@/app/store/global";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Condense a possibly multi-paragraph markdown string to ONE line for the compact activity peek:
// take the first paragraph, strip a leading block marker (heading/list/blockquote), and fold inner
// newlines to spaces. Inline emphasis (**bold**, `code`, [links]) is left intact for InlineMarkdown.
export function condenseToLine(text: string): string {
    const firstPara = text.split(/\n\s*\n/)[0] ?? "";
    return firstPara
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*>\s+/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
}
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run frontend/app/view/agents/inlinemarkdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — do not commit. (`ReactMarkdown`/`Components`/`openLink`/`remarkGfm` imports are used by the component added in Task 9; a mid-batch unused-import note is acceptable, or add the component now in Task 9 before the next typecheck.)

---

## Task 9: `InlineMarkdown` component + wire it into the recent-activity peek

**Files:**
- Modify: `frontend/app/view/agents/inlinemarkdown.tsx` (add the component)
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (import + peek text ~1076)

No unit test (react-markdown output needs a render harness the cockpit lacks — verify via CDP).

- [ ] **Step 1: Add the `InlineMarkdown` component to `inlinemarkdown.tsx`**

```tsx
// Inline-only markdown for the one-line activity peek. Whitelists inline elements and unwraps block
// wrappers (react-markdown drops disallowed <p>/<h*>/<li> but keeps their inline children), so the
// output flows inline beside the agent name. Fed a pre-condensed single line.
const INLINE_ALLOWED = ["a", "strong", "em", "code", "del"];

const INLINE_COMPONENTS: Components = {
    a: ({ href, children }) => (
        <a
            href={href}
            onClick={(e) => {
                e.preventDefault();
                openLink(href);
            }}
            className="cursor-pointer text-accent hover:underline"
        >
            {children}
        </a>
    ),
    code: ({ children }) => <code className="font-mono text-accent-soft">{children}</code>,
};

export function InlineMarkdown({ text }: { text: string }) {
    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={INLINE_ALLOWED} unwrapDisallowed components={INLINE_COMPONENTS}>
            {condenseToLine(text)}
        </ReactMarkdown>
    );
}
```

- [ ] **Step 2: Import `InlineMarkdown` in `cockpitsurface.tsx`**

Add near the other `./` imports (e.g. beside the `buildRecentActivity` import ~line 58):

```ts
import { InlineMarkdown } from "./inlinemarkdown";
```

- [ ] **Step 3: Render the peek text through `InlineMarkdown`**

At ~line 1076, replace the bare `{e.text}`:

```tsx
                                                              <span className="font-mono font-semibold text-primary">
                                                                  {e.agent}
                                                              </span>{" "}
                                                              <InlineMarkdown text={e.text} />
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Visual verification (CDP)**

With `task dev` running and an agent whose newest message contains markdown (e.g. `**bold**`, `` `code` ``), open the cockpit recent-activity rail and `node scripts/cdp-shot.mjs recent-activity.png`. Confirm the peek shows rendered bold/code (no literal `**`/backticks) on a single line, with no layout break.

- [ ] **Step 6: Checkpoint** — do not commit.

---

## Task 10: Full verification

- [ ] **Step 1: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline).

- [ ] **Step 2: Full frontend test suite**

Run: `npx vitest run`
Expected: all pass, including the new/updated `transcriptprojection`, `agentsviewmodel`, `recentactivity`, and `inlinemarkdown` tests. Note the totals (files, tests) in the checkpoint.

- [ ] **Step 3: End-to-end visual pass (CDP)**

Confirm all four behaviors in the live dev app against the mockups: command pill, skill `✦` chip, compaction divider (+ expandable summary), recent-activity inline markdown. Confirm the three bugs are gone: raw `<command-*>` tags, dumped skill body, giant compaction You bubble.

- [ ] **Step 4: Self-review the diff**

`git diff` — confirm no debug logging, no commented-out code, no stray console statements, only the files in the File Structure table are touched.

---

## Task 11: Commit (approval-gated)

Per the user's STRICT git rules, present the batch and wait for explicit approval before committing. Do NOT push.

- [ ] **Step 1: Show the batch**

List changed files with status (M/A/D) and a one-line summary each, then the proposed message:

```
feat(agents): render slash-command, skill, and compaction transcript entries

Slash commands, user-invoked skills, and /compact each arrive as a `user`
transcript record; the projection rendered all three (and synthetic isMeta
injections) as raw "You" bubbles. Project them into dedicated `command` and
`compaction` entries — a command/skill pill and an expandable compaction
divider — and suppress isMeta records. Also render inline markdown in the
cockpit recent-activity peek. Frontend-only; Claude transcripts only.
```

Then ask: **"Awaiting approval. Proceed? (yes/no)"**

- [ ] **Step 2: On approval, commit**

The spec + plan docs fold into THIS feature commit (not a separate docs commit), per the user's git rules.

```bash
git add frontend/ docs/superpowers/specs/2026-07-09-command-transcript-renderer-design.md docs/superpowers/plans/2026-07-09-command-transcript-renderer.md
git commit -F <message-file>
```

(Use `git commit -F` with a temp message file for the multi-line body — do not use PowerShell here-strings in the Bash tool on Windows. Do not add a co-author.)

---

## Self-review (author checklist — completed)

**Spec coverage:** command chip → Tasks 2,7; skill chip (leaf, `✦`) → Tasks 3,6,7; compaction divider + expandable summary → Tasks 4,7; `isMeta` suppression → Task 2; `groupTimeline`/`conversationText`/`recentactivity` pass-through → Tasks 1,5; bundled inline-markdown peek → Tasks 8,9. All spec sections mapped.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command has an expected result.

**Type consistency:** `AgentEntry`/`TimelineItem` `command` = `{name, args?, isSkill?}` and `compaction` = `{trigger?, preTokens?, postTokens?, summary?}` used identically across Tasks 1,4,5,7. Helpers `parseCommand`/`skillLeaf`/`mergeCompaction` (Task 2–4) and `condenseToLine`/`InlineMarkdown` (Task 8–9) referenced consistently. `formatTokens` is reused (already exists in `agentsviewmodel.ts`), not redefined.
