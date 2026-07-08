# Transcript Feed Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the cockpit agent-card transcript feed to the claude-design `Wave-transcript-feed.dc.html` spec — styled code blocks, and expandable per-tool detail (grep matches / read snippets / bash output / edit diffs) that opens inline under a per-kind line threshold and escalates to a viewport modal above it.

**Architecture:** Five phases, each independently committable. Phase 1 (code blocks) is fully standalone — it rides the existing markdown path and touches no projection code. Phases 2–4 enrich the deterministic, LLM-free transcript projection to carry tool detail (currently discarded), extend the view-model types additively, then render the detail inline + in a modal. Phase 5 is card-chrome polish. v1 targets **Claude Code transcripts only** with **pragmatic diffs** (removed-block then added-block, no line-number gutters); Codex parity and full-fidelity diffs are explicit follow-ups.

**Tech Stack:** React 19, Tailwind 4 (`@theme` tokens in `frontend/tailwindsetup.css`), jotai, `react-markdown` ^9 + `remark-gfm`, `motion` ^12, vitest. No new dependencies.

**Design source of truth:** `wave-handoff/wave/project/Wave-transcript-feed.dc.html` (local copy of the claude.ai design file). Open it when a pixel/behavior detail is ambiguous — its `DCLogic` class defines `parseMd`, `hlLine`, the per-kind `capped` thresholds, and the block data shapes this plan mirrors. (It also lives in the claude.ai design project `76055164-ad6f-4b77-946c-14227a3824ff`, re-fetchable via `DesignSync get_file` with path `Wave-transcript-feed.dc.html`.) Note: the `.dc.html` needs the claude-design `support.js` runtime to render, so read it as source — the running reference is the claude.ai project.

**Design-system rule (hard constraint):** Never put raw hex/rgba in `className`/`style`. Map every color to an existing `@theme` utility (`bg-surface-code`, `text-accent`, `border-edge-mid`, …) or, when no token exists, add a `--color-*` token to `frontend/tailwindsetup.css` first and use the generated utility. No new SCSS — Tailwind only.

### Color token map (design hex → utility)

| Hex (mock) | Token / utility |
|---|---|
| `#0c0e11` | `bg-background` |
| `#0e1116` | `bg-surface` |
| `#13171d` | `bg-surface-raised` |
| `#0b0d10` | `bg-surface-code` |
| `#12161b` | `bg-lane` |
| `#1a222c` | `bg-surface-selected` |
| `#e6e9ed` | `text-primary` |
| `#cfd5db` | `text-secondary` |
| `#dfe4ea` | `text-ink-hi` |
| `#9aa3ad` | `text-ink-mid` (aka `text-feed-summary`) |
| `#6b7178` | `text-muted` |
| `#4f565f` | `text-feed-time` |
| `#777f89` | `text-feed-label` |
| `#1c2128` | `border-border` |
| `#20262e` | `border-edge-mid` |
| `#2a313a` | `border-edge-strong` |
| `#161a20` / `#14181e` | `border-edge-faint` |
| `#7c95ff` | `accent` (`text-accent` / `bg-accent`) |
| `#aebfff` | `accent-soft` |
| `rgba(124,149,255,.1–.12)` | `bg-accent/10` / `bg-accentbg` |
| `#54c79a` | `success` |
| `#e0726c` | `error` |
| `#e6b450` | `warning` |
| `#d97757` | `provider-claude` (`text-provider-claude`) |

Syntax colors have **no** existing token — added in Task 1a: `--color-syntax-keyword #aebfff`, `--color-syntax-string #7fd6ab`, `--color-syntax-number #e6b450`, `--color-syntax-comment #6b7178`, `--color-syntax-punct #8b939d`, `--color-syntax-ident #cdd3da`.

---

## File structure

| File | Responsibility | Phase |
|---|---|---|
| `frontend/tailwindsetup.css` | add `--color-syntax-*` tokens | 1 |
| `frontend/app/view/agents/highlight.ts` (new) | pure line tokenizer (port of mock `hlLine`) | 1 |
| `frontend/app/view/agents/highlight.test.ts` (new) | tokenizer tests | 1 |
| `frontend/app/view/agents/codeblock.tsx` (new) | styled fenced-code component (lang, path, copy, gutters, tokens) | 1 |
| `frontend/app/view/agents/markdownmessage.tsx` | route fenced code through `CodeBlock` | 1 |
| `frontend/app/view/agents/agentsviewmodel.ts` | additive `AgentEntry` detail fields + detail types + edit-burst grouping + threshold helpers | 2 |
| `frontend/app/view/agents/agentsviewmodel.test.ts` | grouping / threshold / summary tests | 2 |
| `frontend/app/view/agents/tooldetail.ts` (new) | pure detail extractors: `parseGrep`, `sliceRead`, `buildEditDiff`, `formatDuration` | 3 |
| `frontend/app/view/agents/tooldetail.test.ts` (new) | extractor tests | 3 |
| `frontend/app/view/agents/transcriptprojection.ts` | capture tool_result bodies + tool_use inputs + timestamps → detail | 3 |
| `frontend/app/view/agents/transcriptprojection.test.ts` | detail projection tests | 3 |
| `frontend/app/view/agents/narrationtimeline.tsx` | expandable tool rows, threshold routing, caret glyph, edit-burst diffs | 4 |
| `frontend/app/view/agents/tooldetailmodal.tsx` (new) | viewport modal for full detail | 4 |
| `frontend/app/modals/modalsrenderer.tsx` | register `AgentToolDetailModal` | 4 |
| `frontend/app/view/agents/agentrow.tsx` | streaming flow bar under header while working | 5 |

---

## Phase 1 — Styled code blocks (standalone, shippable)

### Task 1a: Add syntax-highlight color tokens

**Files:**
- Modify: `frontend/tailwindsetup.css` (inside the `@theme { … }` block, after the ANSI colors ~line 135)

- [ ] **Step 1: Add the tokens**

Insert inside `@theme`:

```css
    /* Code syntax highlight (transcript code blocks; see highlight.ts) */
    --color-syntax-keyword: #aebfff;
    --color-syntax-string: #7fd6ab;
    --color-syntax-number: #e6b450;
    --color-syntax-comment: #6b7178;
    --color-syntax-punct: #8b939d;
    --color-syntax-ident: #cdd3da;
```

- [ ] **Step 2: Verify utilities compile**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (tokens don't affect TS; this is the baseline check). Tailwind generates `text-syntax-keyword` etc. at build.

- [ ] **Step 3: Commit**

```bash
git add frontend/tailwindsetup.css
git commit -m "feat(cockpit): add syntax-highlight color tokens"
```

### Task 1b: Pure syntax tokenizer

**Files:**
- Create: `frontend/app/view/agents/highlight.ts`
- Test: `frontend/app/view/agents/highlight.test.ts`

A `token`'s `cls` is a Tailwind text-color utility name (design-system tokens), NOT a hex. This keeps the renderer token-only.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { highlightLine } from "./highlight";

describe("highlightLine", () => {
    it("classifies keyword, ident, punctuation and string", () => {
        expect(highlightLine('const x = "hi";')).toEqual([
            { t: "const", cls: "text-syntax-keyword" },
            { t: " ", cls: "text-syntax-ident" },
            { t: "x", cls: "text-syntax-ident" },
            { t: " ", cls: "text-syntax-ident" },
            { t: "=", cls: "text-syntax-punct" },
            { t: " ", cls: "text-syntax-ident" },
            { t: '"hi"', cls: "text-syntax-string" },
            { t: ";", cls: "text-syntax-punct" },
        ]);
    });

    it("classifies numbers and line comments", () => {
        expect(highlightLine("return 42; // done")).toEqual([
            { t: "return", cls: "text-syntax-keyword" },
            { t: " ", cls: "text-syntax-ident" },
            { t: "42", cls: "text-syntax-number" },
            { t: ";", cls: "text-syntax-punct" },
            { t: " ", cls: "text-syntax-ident" },
            { t: "// done", cls: "text-syntax-comment" },
        ]);
    });

    it("never returns an empty token list (blank line yields one space)", () => {
        expect(highlightLine("")).toEqual([{ t: " ", cls: "text-syntax-ident" }]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/highlight.test.ts`
Expected: FAIL — `highlightLine` not exported.

- [ ] **Step 3: Implement**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure, dependency-free line tokenizer for transcript code blocks. Ported from the claude-design
// mock's hlLine. Returns tokens tagged with a Tailwind text-color utility (design-system token),
// never a raw hex. Language-agnostic lexical heuristics (keywords/strings/numbers/comments) — good
// enough for prose code snippets, not a full parser.

export interface CodeToken {
    t: string;
    cls: string;
}

const KEYWORDS = new Set([
    "const", "let", "var", "function", "return", "new", "import", "from", "export", "default",
    "if", "else", "for", "while", "await", "async", "class", "extends", "true", "false", "null",
    "undefined", "this", "void", "type", "interface",
]);

// group order matters: comment | string | number | ident | whitespace | punctuation
const TOKEN_RE =
    /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z0-9_$])/g;

export function highlightLine(line: string): CodeToken[] {
    const toks: CodeToken[] = [];
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(line))) {
        let cls = "text-syntax-ident";
        if (m[1]) cls = "text-syntax-comment";
        else if (m[2]) cls = "text-syntax-string";
        else if (m[3]) cls = "text-syntax-number";
        else if (m[4]) cls = KEYWORDS.has(m[4]) ? "text-syntax-keyword" : "text-syntax-ident";
        else if (m[6]) cls = "text-syntax-punct";
        toks.push({ t: m[0], cls });
    }
    if (toks.length === 0) toks.push({ t: " ", cls: "text-syntax-ident" });
    return toks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/highlight.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/highlight.ts frontend/app/view/agents/highlight.test.ts
git commit -m "feat(cockpit): pure syntax tokenizer for code blocks"
```

### Task 1c: CodeBlock component

**Files:**
- Create: `frontend/app/view/agents/codeblock.tsx`

Copy state is component-local. Line numbers + tokens per line; horizontal scroll inside the block so it never widens the card.

- [ ] **Step 1: Implement** (no unit test — pure presentation; verified via CDP in Task 1e)

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { highlightLine } from "./highlight";

// Styled fenced-code block for transcript prose (Wave-transcript-feed.dc.html code block).
// lang label + optional path + copy affordance + line-number gutter + tokenized source.
export function CodeBlock({ code, lang, path }: { code: string; lang?: string; path?: string }) {
    const [copied, setCopied] = useState(false);
    const lines = code.replace(/\n$/, "").split("\n");
    const copy = () => {
        try {
            void navigator.clipboard?.writeText(code);
        } catch {
            // clipboard unavailable — no-op
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
    };
    return (
        <div className="my-1.5 overflow-hidden rounded-[10px] border border-border bg-surface-code">
            <div className="flex items-center gap-2 border-b border-edge-faint bg-surface px-[11px] py-[7px]">
                {lang ? (
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-accent">
                        {lang}
                    </span>
                ) : null}
                {path ? <span className="font-mono text-[10.5px] text-muted">{path}</span> : null}
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={copy}
                    className={cnCopy(copied)}
                >
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <div className="overflow-x-auto">
                <div className="min-w-min py-[9px]">
                    {lines.map((ln, i) => (
                        <div key={i} className="flex whitespace-pre font-mono text-[12px] leading-[1.75]">
                            <span className="w-[34px] shrink-0 select-none pr-[14px] text-right text-ink-faint">
                                {i + 1}
                            </span>
                            <span className="pr-4">
                                {highlightLine(ln).map((tk, k) => (
                                    <span key={k} className={tk.cls}>
                                        {tk.t}
                                    </span>
                                ))}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function cnCopy(copied: boolean): string {
    return (
        "flex items-center gap-[5px] rounded-[6px] border border-edge-mid px-2 py-[3px] font-mono " +
        "text-[9.5px] tracking-[0.03em] hover:border-edge-strong " +
        (copied ? "text-success" : "text-muted")
    );
}
```

Note: `text-ink-faint` maps to `--color-ink-faint` (#3a424c) — the closest existing token to the mock's `#3f4751` gutter.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/codeblock.tsx
git commit -m "feat(cockpit): styled CodeBlock component"
```

### Task 1d: Route fenced code through CodeBlock

**Files:**
- Modify: `frontend/app/view/agents/markdownmessage.tsx`

react-markdown ^9 renders a fenced block as `<pre><code class="language-xxx">…</code></pre>`. Override `pre` to detect the child `code`, pull its language + text, and render `CodeBlock`. Leave inline `code` (the existing `.agent-md code` style) untouched.

- [ ] **Step 1: Add the `pre` component override**

In `MD_COMPONENTS`, add:

```tsx
    pre: ({ children }) => {
        // children is the <code> element react-markdown produced for a fenced block
        const child: any = Array.isArray(children) ? children[0] : children;
        const props = child?.props ?? {};
        const className: string = props.className ?? "";
        const lang = /language-(\w+)/.exec(className)?.[1];
        const raw = Array.isArray(props.children) ? props.children.join("") : String(props.children ?? "");
        return <CodeBlock code={raw} lang={lang} />;
    },
```

Add the import at the top:

```tsx
import { CodeBlock } from "./codeblock";
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Run the existing markdown/insight tests**

Run: `npx vitest run frontend/app/view/agents/insightblocks.test.ts`
Expected: PASS (rendering path unchanged for non-code segments).

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/markdownmessage.tsx
git commit -m "feat(cockpit): render fenced code via CodeBlock in narration"
```

### Task 1e: Visual verification (Phase 1)

- [ ] **Step 1: Ensure dev app is running**

Run (background, once): `tail -f /dev/null | task dev` (see memory: `task dev` dies on stdin EOF otherwise).

- [ ] **Step 2: Inject a transcript with a fenced code block and screenshot**

Run: `node scripts/inject-live-agents.mjs <scenario>` then `node scripts/cdp-shot.mjs code-block.png`
Expected: a card whose assistant message shows a dark code block — uppercase lang label, Copy button, line-number gutter, colored tokens. Confirm no horizontal overflow of the card (code scrolls inside its own box).

- [ ] **Step 3: Checkpoint** — Phase 1 is independently shippable. Stop here if only the code renderer was in scope.

---

## Phase 2 — View-model: detail types + edit-burst grouping (pure)

### Task 2a: Extend `AgentEntry` with detail (additive)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (the `AgentEntry` union ~line 9, `AgentActionEntry` ~line 130)

All new fields are **optional** so every existing consumer (`agentdetailsrail`, `previousinfo`, `liveagents`, `recentactivity`) keeps compiling and behaving identically.

- [ ] **Step 1: Replace the `AgentEntry` union and add detail types**

```ts
// Detail captured from a tool call's result / input (Wave-transcript-feed.dc.html). All optional:
// absent detail renders exactly as today (bare verb + target line).
export interface GrepMatch { loc: string; code: string }
export interface DiffLine { sign: "+" | "-" | ""; text: string }
export interface EditFile { path: string; badge: "M" | "A"; adds: number; dels: number; lines: DiffLine[] }

export type ActionDetail =
    | { kind: "grep"; matches: GrepMatch[]; more?: string }
    | { kind: "read"; snippet: string; truncated?: boolean }
    | { kind: "bash"; output: string; exit: number }
    | { kind: "edit"; files: EditFile[] };

export type AgentEntry =
    | { kind: "message"; text: string }
    | { kind: "user"; text: string }
    | {
          kind: "action";
          verb: string;
          target: string;
          outcome?: "ok" | "fail";
          note?: string;
          summary?: string; // e.g. "14 matches", "80 lines", "24 passing"
          durationMs?: number; // tool_use → tool_result wall time, when timestamps present
          detail?: ActionDetail; // rich, expandable detail; absent = bare line
      };
```

- [ ] **Step 2: Add pure detail-class + threshold helpers**

Append near `CollapseRunThreshold`:

```ts
// Per-kind inline line budget (Wave-transcript-feed.dc.html DCLogic `capped`). At or under the
// budget the detail expands inline; over it, the row opens the modal instead.
export const DETAIL_INLINE_MAX: Record<ActionDetail["kind"], number> = {
    grep: 6,
    read: 9,
    bash: 8,
    edit: 9,
};

// Pure: number of lines a detail would render inline (drives inline-vs-modal routing).
export function detailLineCount(d: ActionDetail): number {
    switch (d.kind) {
        case "grep":
            return d.matches.length;
        case "read":
            return d.snippet.split("\n").length;
        case "bash":
            return d.output.split("\n").length;
        case "edit":
            return d.files.reduce((n, f) => n + f.lines.length + 1, 0);
    }
}

// Pure: true when detail exceeds its inline budget and a click should open the modal directly.
export function detailExceedsInline(d: ActionDetail): boolean {
    return detailLineCount(d) > DETAIL_INLINE_MAX[d.kind];
}
```

- [ ] **Step 3: Write the failing test** (append to `agentsviewmodel.test.ts`)

```ts
import { detailExceedsInline, detailLineCount } from "./agentsviewmodel";

describe("detail inline routing", () => {
    it("counts grep matches", () => {
        expect(detailLineCount({ kind: "grep", matches: [{ loc: "a", code: "b" }] })).toBe(1);
    });
    it("routes a 7-match grep to the modal (budget 6)", () => {
        const matches = Array.from({ length: 7 }, () => ({ loc: "x", code: "y" }));
        expect(detailExceedsInline({ kind: "grep", matches })).toBe(true);
    });
    it("keeps a 6-match grep inline", () => {
        const matches = Array.from({ length: 6 }, () => ({ loc: "x", code: "y" }));
        expect(detailExceedsInline({ kind: "grep", matches })).toBe(false);
    });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (new + all existing).

- [ ] **Step 5: Typecheck (blast-radius check)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 — confirms additive fields broke no consumer.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(cockpit): additive tool-detail types + inline threshold helpers"
```

### Task 2b: Edit-burst grouping

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (`TimelineItem` ~line 143, `groupTimeline` ~line 150)

The mock's burst is edit-specific: a run of consecutive edit actions collapses into one `edit-burst` carrying each file's diff plus aggregate `+adds −dels`. Non-edit action runs keep the existing generic `group` behavior.

- [ ] **Step 1: Add the `edit-burst` timeline item + aggregation**

Extend `TimelineItem`:

```ts
    | { kind: "edit-burst"; startIndex: number; files: EditFile[]; adds: number; dels: number };
```

Add a pure aggregator:

```ts
// Pure: fold a run of edit actions (verb "edited"/"wrote" carrying an edit detail) into one burst.
export function aggregateEditBurst(actions: AgentActionEntry[], startIndex: number): Extract<TimelineItem, { kind: "edit-burst" }> {
    const files: EditFile[] = [];
    for (const a of actions) {
        if (a.detail?.kind === "edit") files.push(...a.detail.files);
    }
    const adds = files.reduce((n, f) => n + f.adds, 0);
    const dels = files.reduce((n, f) => n + f.dels, 0);
    return { kind: "edit-burst", startIndex, files, adds, dels };
}

// Pure: does this action participate in an edit burst?
export function isEditAction(e: AgentEntry): boolean {
    return e.kind === "action" && (e.verb === "edited" || e.verb === "wrote") && e.detail?.kind === "edit";
}
```

- [ ] **Step 2: Route edit runs in `groupTimeline`**

In `groupTimeline`'s `flush()`, before the generic group/inline branch, add: if every action in the run `isEditAction`, push `aggregateEditBurst(run, runStart)` instead. Full replacement `flush`:

```ts
    const flush = () => {
        if (run.length === 0) return;
        if (run.length >= threshold && run.every((a) => isEditAction(a))) {
            items.push(aggregateEditBurst(run, runStart));
        } else if (run.length >= threshold) {
            items.push({ kind: "group", startIndex: runStart, actions: run });
        } else {
            run.forEach((action, k) => items.push({ kind: "action", action, index: runStart + k }));
        }
        run = [];
        runStart = -1;
    };
```

- [ ] **Step 3: Write the failing test**

```ts
import { groupTimeline } from "./agentsviewmodel";

describe("edit-burst grouping", () => {
    const edit = (path: string): AgentEntry => ({
        kind: "action", verb: "edited", target: path,
        detail: { kind: "edit", files: [{ path, badge: "M", adds: 2, dels: 1, lines: [{ sign: "+", text: "a" }] }] },
    });
    it("folds 3+ consecutive edits into one edit-burst with summed totals", () => {
        const items = groupTimeline([edit("a.ts"), edit("b.ts"), edit("c.ts")]);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: "edit-burst", adds: 6, dels: 3 });
        expect((items[0] as any).files).toHaveLength(3);
    });
    it("leaves a 2-edit run as inline actions", () => {
        const items = groupTimeline([edit("a.ts"), edit("b.ts")]);
        expect(items.map((i) => i.kind)).toEqual(["action", "action"]);
    });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(cockpit): fold consecutive edits into a diff burst"
```

---

## Phase 3 — Projection: capture tool detail (Claude)

### Task 3a: Pure detail extractors

**Files:**
- Create: `frontend/app/view/agents/tooldetail.ts`
- Test: `frontend/app/view/agents/tooldetail.test.ts`

Pragmatic diffs: `buildEditDiff` emits the removed block (`-`) then the added block (`+`), no line-number gutters (v1 tradeoff). `parseGrep` best-effort splits `path:line: code`. `sliceRead` bounds a Read body. `formatDuration` matches the mock's `0.4s` / `3.2s` / `12m`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildEditDiff, formatDuration, parseGrep, sliceRead, toolResultText } from "./tooldetail";

describe("toolResultText", () => {
    it("returns a string result verbatim", () => {
        expect(toolResultText("hello")).toBe("hello");
    });
    it("joins text blocks of an array result", () => {
        expect(toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    });
    it("returns '' for missing/odd content", () => {
        expect(toolResultText(undefined)).toBe("");
        expect(toolResultText(42)).toBe("");
    });
});

describe("buildEditDiff", () => {
    it("emits removed lines then added lines with counts", () => {
        const f = buildEditDiff("/proj/a.ts", "old1\nold2", "new1");
        expect(f).toEqual({
            path: "/proj/a.ts", badge: "M", adds: 1, dels: 2,
            lines: [
                { sign: "-", text: "old1" },
                { sign: "-", text: "old2" },
                { sign: "+", text: "new1" },
            ],
        });
    });
    it("marks an empty old_string as an add (new file)", () => {
        const f = buildEditDiff("/proj/n.ts", "", "line");
        expect(f.badge).toBe("A");
        expect(f.dels).toBe(0);
    });
});

describe("parseGrep", () => {
    it("splits path:line prefix from code", () => {
        expect(parseGrep("src/a.ts:42:  const x = 1")).toEqual([{ loc: "src/a.ts:42", code: "  const x = 1" }]);
    });
    it("falls back to whole line as code when no prefix", () => {
        expect(parseGrep("no-prefix line")).toEqual([{ loc: "", code: "no-prefix line" }]);
    });
});

describe("sliceRead", () => {
    it("keeps content under the cap intact", () => {
        expect(sliceRead("a\nb", 9)).toEqual({ snippet: "a\nb", truncated: false });
    });
    it("truncates past the cap and flags it", () => {
        const r = sliceRead("1\n2\n3\n4", 2);
        expect(r).toEqual({ snippet: "1\n2", truncated: true });
    });
});

describe("formatDuration", () => {
    it("sub-minute → seconds with one decimal", () => {
        expect(formatDuration(3200)).toBe("3.2s");
        expect(formatDuration(400)).toBe("0.4s");
    });
    it("minutes past 60s", () => {
        expect(formatDuration(720000)).toBe("12m");
    });
    it("undefined → empty", () => {
        expect(formatDuration(undefined)).toBe("");
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/tooldetail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure detail extractors for the transcript projection. No React, no Wave runtime imports.
// Deterministic; no LLM. v1 diffs are pragmatic: removed block then added block, no line gutters.

import type { EditFile, GrepMatch } from "./agentsviewmodel";

// A Claude tool_result `content` is either a string or an array of { type:"text", text }.
export function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n");
    }
    return "";
}

function baseCount(s: string): number {
    return s === "" ? 0 : s.split("\n").length;
}

export function buildEditDiff(path: string, oldStr: string, newStr: string): EditFile {
    const dels = baseCount(oldStr);
    const adds = baseCount(newStr);
    const lines = [
        ...(oldStr === "" ? [] : oldStr.split("\n").map((text) => ({ sign: "-" as const, text }))),
        ...(newStr === "" ? [] : newStr.split("\n").map((text) => ({ sign: "+" as const, text }))),
    ];
    return { path, badge: oldStr === "" ? "A" : "M", adds, dels, lines };
}

const GREP_PREFIX = /^(.*?:\d+):?(.*)$/;

export function parseGrep(output: string): GrepMatch[] {
    return output
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => {
            const m = GREP_PREFIX.exec(l);
            return m ? { loc: m[1], code: m[2] } : { loc: "", code: l };
        });
}

export function sliceRead(output: string, maxLines: number): { snippet: string; truncated: boolean } {
    const lines = output.split("\n");
    if (lines.length <= maxLines) return { snippet: output, truncated: false };
    return { snippet: lines.slice(0, maxLines).join("\n"), truncated: true };
}

export function formatDuration(ms?: number): string {
    if (ms == null) return "";
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run frontend/app/view/agents/tooldetail.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/tooldetail.ts frontend/app/view/agents/tooldetail.test.ts
git commit -m "feat(cockpit): pure tool-detail extractors (diff/grep/read/duration)"
```

### Task 3b: Enrich the Claude projection

**Files:**
- Modify: `frontend/app/view/agents/transcriptprojection.ts`

Capture: the `tool_use` input (for Read/Grep target + Edit old/new strings), the record `timestamp` (ISO) for duration, and the matching `tool_result` body (for grep/read/bash detail). The MODAL read cap is generous (400 lines); inline routing then uses the per-kind budget from Phase 2.

- [ ] **Step 1: Write the failing tests** (append to `transcriptprojection.test.ts`)

```ts
import { projectTranscript } from "./transcriptprojection";

describe("projectTranscript detail", () => {
    const L = (o: unknown) => JSON.stringify(o);

    it("attaches an edit diff from Edit old/new strings", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/p/a.ts", old_string: "a\nb", new_string: "c" } }] } }),
            L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e1", is_error: false }] } }),
        ]);
        expect(out[0]).toMatchObject({ kind: "action", verb: "edited", target: "a.ts" });
        expect((out[0] as any).detail).toEqual({
            kind: "edit",
            files: [{ path: "/p/a.ts", badge: "M", adds: 1, dels: 2, lines: [
                { sign: "-", text: "a" }, { sign: "-", text: "b" }, { sign: "+", text: "c" },
            ] }],
        });
    });

    it("attaches bash output + exit from the tool_result body", () => {
        const out = projectTranscript([
            L({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }] } }),
            L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", is_error: false, content: "24 passing" }] } }),
        ]);
        expect((out[0] as any).detail).toEqual({ kind: "bash", output: "24 passing", exit: 0 });
    });

    it("computes durationMs from record timestamps", () => {
        const out = projectTranscript([
            L({ type: "assistant", timestamp: "2026-07-08T00:00:00.000Z", message: { content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "x" } }] } }),
            L({ type: "user", timestamp: "2026-07-08T00:00:03.200Z", message: { content: [{ type: "tool_result", tool_use_id: "b2", is_error: false, content: "" }] } }),
        ]);
        expect((out[0] as any).durationMs).toBe(3200);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: FAIL — no `detail`/`durationMs` yet.

- [ ] **Step 3: Implement**

Add imports at top:

```ts
import type { ActionDetail } from "./agentsviewmodel";
import { buildEditDiff, parseGrep, sliceRead, toolResultText } from "./tooldetail";

const READ_MODAL_MAX_LINES = 400; // bound stored Read body (modal view); inline uses the per-kind budget
```

Extend the `ActionEntry` local type and carry `input` + timestamp on tool_use. In the `assistant` branch where a `tool_use` action is built (currently ~line 74), capture the input and timestamp:

```ts
                if (block?.type === "tool_use" && typeof block.name === "string") {
                    const action: ActionEntry = { kind: "action", verb: verbFor(block.name), target: targetFor(block.input) };
                    if (block.name === "Edit" && block.input && typeof block.input.old_string === "string") {
                        action.detail = { kind: "edit", files: [buildEditDiff(String(block.input.file_path ?? ""), block.input.old_string, String(block.input.new_string ?? ""))] };
                    } else if (block.name === "Write" && block.input && typeof block.input.content === "string") {
                        action.detail = { kind: "edit", files: [buildEditDiff(String(block.input.file_path ?? ""), "", block.input.content)] };
                    }
                    (action as any)._useTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
                    (action as any)._tool = block.name;
                    entries.push(action);
                    if (typeof block.id === "string") {
                        actionById.set(block.id, action);
                    }
                }
```

In the `user`/`tool_result` branch (currently ~line 105), after resolving `action`, attach result-derived detail + duration, then set outcome as before:

```ts
                const action = actionById.get(block.tool_use_id);
                if (action == null) {
                    continue;
                }
                const body = toolResultText(block.content);
                const tool = (action as any)._tool as string | undefined;
                if (tool === "Grep" && body) {
                    const matches = parseGrep(body);
                    action.detail = { kind: "grep", matches };
                    action.summary = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
                } else if ((tool === "Read" || tool === "Glob") && body) {
                    const { snippet, truncated } = sliceRead(body, READ_MODAL_MAX_LINES);
                    action.detail = { kind: "read", snippet, truncated };
                    action.summary = `${body.split("\n").length} lines`;
                } else if (tool === "Bash") {
                    action.detail = { kind: "bash", output: body, exit: block.is_error === true ? 1 : 0 };
                }
                const resTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
                const useTs = (action as any)._useTs as number;
                if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {
                    action.durationMs = resTs - useTs;
                }
                if (block.is_error === true) {
                    action.outcome = "fail";
                } else if (action.verb === "ran") {
                    action.outcome = "ok";
                }
```

Strip the private `_useTs`/`_tool` scratch fields before returning so they don't leak into the contract:

```ts
    for (const e of entries) {
        if (e.kind === "action") {
            delete (e as any)._useTs;
            delete (e as any)._tool;
        }
    }
    return entries;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: PASS (new + existing — the original tests have no `detail`/`durationMs`, and `toMatchObject`/`toEqual` on the originals still hold because those lines carry no result body and Edit test inputs there have no `old_string`).

- [ ] **Step 5: Full agents test run + typecheck**

Run: `npx vitest run frontend/app/view/agents/` then `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/transcriptprojection.ts frontend/app/view/agents/transcriptprojection.test.ts
git commit -m "feat(cockpit): capture tool detail + durations in Claude projection"
```

---

## Phase 4 — Renderer: expandable detail + modal

### Task 4a: Detail modal component + registration

**Files:**
- Create: `frontend/app/view/agents/tooldetailmodal.tsx`
- Modify: `frontend/app/modals/modalsrenderer.tsx`

The modal is pushed with the action entry; it renders the same per-kind detail at full size. Mirror `ConfirmModal`'s use of `ModalShell` (fetch its exact prop shape with a quick read of `frontend/app/modals/confirmmodal.tsx` before implementing) so backdrop/escape/motion are consistent.

- [ ] **Step 1: Read the modal shell contract**

Run: read `frontend/app/modals/confirmmodal.tsx` and `frontend/app/modals/modalshell.tsx` to copy the `ModalShell` usage + `modalsModel.popModal()` close pattern.

- [ ] **Step 2: Implement `AgentToolDetailModal`**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { modalsModel } from "@/app/store/modalmodel";
import { ModalShell } from "@/app/modals/modalshell";
import type { AgentActionEntry } from "./agentsviewmodel";
import { formatDuration } from "./tooldetail";
import { ToolDetailBody } from "./narrationtimeline";

// Viewport-level full-detail view for one tool call. Pushed via modalsModel.pushModal
// ("AgentToolDetailModal", { action }). The card is overflow-hidden, so detail that exceeds the
// inline budget escalates here where there is room. Reuses ToolDetailBody (shared with the inline view).
export function AgentToolDetailModal({ action }: { action: AgentActionEntry }) {
    const close = () => modalsModel.popModal();
    const ok = action.outcome !== "fail";
    return (
        <ModalShell onClose={close} className="w-[min(720px,100%)]">
            <div className="flex items-center gap-2.5 border-b border-edge-faint px-[15px] py-[13px]">
                <span className={ok ? "text-success" : "text-error"}>{ok ? "✓" : "✗"}</span>
                <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.06em] text-feed-label">
                    {action.verb}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-primary">{action.target}</span>
                {action.durationMs ? (
                    <span className="font-mono text-[11px] text-muted">{formatDuration(action.durationMs)}</span>
                ) : null}
                <button type="button" onClick={close} className="rounded-[7px] border border-edge-mid px-2 py-1 text-muted hover:text-primary">
                    ✕
                </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto bg-surface-code">
                {action.detail ? <ToolDetailBody detail={action.detail} variant="modal" /> : null}
            </div>
        </ModalShell>
    );
}
```

- [ ] **Step 3: Register it**

In `modalsrenderer.tsx`, import and add to `REGISTRY`:

```tsx
import { AgentToolDetailModal } from "@/app/view/agents/tooldetailmodal";
// …
const REGISTRY: Record<string, ComponentType<any>> = {
    ConfirmModal,
    MessageModal,
    UserInputModal,
    AgentToolDetailModal,
};
```

- [ ] **Step 4: Typecheck** — expect a temporary error that `ToolDetailBody` isn't exported yet; it lands in Task 4b. If executing strictly test-first, do Task 4b before typechecking this task.

- [ ] **Step 5: Commit** (after 4b compiles)

```bash
git add frontend/app/view/agents/tooldetailmodal.tsx frontend/app/modals/modalsrenderer.tsx
git commit -m "feat(cockpit): tool-detail modal + registration"
```

### Task 4b: Shared `ToolDetailBody` + expandable tool rows

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`

Export a shared `ToolDetailBody` (used inline capped, and by the modal uncapped). Rework `ToolLine`: clickable; on click, if `detailExceedsInline(detail)` → `modalsModel.pushModal("AgentToolDetailModal", { action })`, else toggle inline. Caret shows `▶` for inline, `↗` for modal. Inline detail footer has an icon-only `↗` button (manual escalation) that pushes the modal even for short detail.

- [ ] **Step 1: Implement the detail body + reworked ToolLine**

Key pieces (full styling per the mock; tokens per the map — no raw hex):

```tsx
import { modalsModel } from "@/app/store/modalmodel";
import {
    detailExceedsInline,
    type ActionDetail,
    // …existing imports
} from "./agentsviewmodel";
import { formatDuration } from "./tooldetail";
import { CodeBlock } from "./codeblock"; // reuse if a detail ever needs code framing; optional

export function ToolDetailBody({ detail, variant }: { detail: ActionDetail; variant: "inline" | "modal" }) {
    const pad = variant === "modal" ? "px-4 py-3" : "px-[11px] py-[9px]";
    if (detail.kind === "grep") {
        return (
            <div className={pad}>
                {detail.matches.map((g, i) => (
                    <div key={i} className="flex gap-2.5 whitespace-pre font-mono text-[11px] leading-[1.6]">
                        <span className="shrink-0 text-muted">{g.loc}</span>
                        <span className="truncate text-secondary">{g.code}</span>
                    </div>
                ))}
                {detail.more ? <div className="pt-1.5 font-mono text-[10px] text-feed-time">{detail.more}</div> : null}
            </div>
        );
    }
    if (detail.kind === "read") {
        return <pre className={`overflow-x-auto whitespace-pre font-mono text-[11px] leading-[1.7] text-ink-mid ${pad}`}>{detail.snippet}</pre>;
    }
    if (detail.kind === "bash") {
        return (
            <div>
                <pre className={`overflow-x-auto whitespace-pre font-mono text-[11px] leading-[1.7] ${pad} ${detail.exit ? "text-error" : "text-ink-mid"}`}>{detail.output}</pre>
                <div className="flex items-center gap-2 px-[13px] pb-[9px]">
                    <span className={`rounded-[4px] px-[7px] py-0.5 font-mono text-[8.5px] font-semibold uppercase ${detail.exit ? "bg-error/15 text-error" : "bg-success/15 text-success"}`}>
                        exit {detail.exit}
                    </span>
                </div>
            </div>
        );
    }
    // edit
    return (
        <div className="flex flex-col">
            {detail.files.map((f, i) => (
                <div key={i} className="border-b border-lane last:border-b-0">
                    <div className="flex items-center gap-2.5 bg-surface px-[11px] py-[7px]">
                        <span className={`flex h-[15px] w-[15px] items-center justify-center rounded-[4px] font-mono text-[8.5px] font-bold ${f.badge === "A" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>{f.badge}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-hi">{f.path}</span>
                        <span className="font-mono text-[9.5px] font-bold text-success">+{f.adds}</span>
                        <span className="font-mono text-[9.5px] font-bold text-error">−{f.dels}</span>
                    </div>
                    <div className="overflow-x-auto bg-surface-code py-1">
                        <div className="min-w-min">
                            {f.lines.map((l, k) => (
                                <div key={k} className={`flex whitespace-pre font-mono text-[11px] leading-[1.7] ${l.sign === "+" ? "bg-success/[0.09]" : l.sign === "-" ? "bg-error/[0.09]" : ""}`}>
                                    <span className={`w-[13px] shrink-0 text-center ${l.sign === "+" ? "text-success" : l.sign === "-" ? "text-error" : "text-ink-faint"}`}>{l.sign}</span>
                                    <span className={`pr-3.5 ${l.sign === "+" ? "text-success-soft" : l.sign === "-" ? "text-error" : "text-secondary"}`}>{l.text}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
```

Reworked `ToolLine` (replaces the current one; keeps the bare-line look when `detail` is absent):

```tsx
function ToolLine({ action }: { action: AgentActionEntry }) {
    const [open, setOpen] = useState(false);
    const ok = action.outcome !== "fail";
    const detail = action.detail;
    const toModal = detail ? detailExceedsInline(detail) : false;
    const onClick = () => {
        if (!detail) return;
        if (toModal) modalsModel.pushModal("AgentToolDetailModal", { action });
        else setOpen((v) => !v);
    };
    return (
        <div>
            <div
                onClick={onClick}
                className={cn(
                    "flex items-center gap-1.5 rounded-[6px] px-1.5 py-[3px]",
                    detail ? "cursor-pointer opacity-[0.72] hover:bg-lane hover:opacity-100" : "opacity-[0.68]"
                )}
            >
                <span className={cn("flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] text-[8px]", ok ? "bg-success/15 text-success" : "bg-error/15 text-error")}>
                    {ok ? "✓" : "✗"}
                </span>
                <span className="shrink-0 font-mono text-[8px] font-semibold uppercase tracking-[0.03em] text-feed-label">{action.verb}</span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-feed-summary">{action.target}</span>
                {action.summary ? <span className={cn("shrink-0 font-mono text-[10.5px]", ok ? "text-feed-summary" : "text-error")}>{action.summary}</span> : null}
                <div className="min-w-[6px] flex-1" />
                {action.durationMs ? <span className="shrink-0 font-mono text-[9.5px] text-feed-time">{formatDuration(action.durationMs)}</span> : null}
                {detail ? <span className="shrink-0 font-mono text-[8px] text-edge-strong">{toModal ? "↗" : open ? "▼" : "▶"}</span> : null}
            </div>
            {detail && open && !toModal ? (
                <div className="my-1.5 overflow-hidden rounded-[9px] border border-edge-faint bg-surface-code">
                    <div className="max-h-[200px] overflow-auto">
                        <ToolDetailBody detail={detail} variant="inline" />
                    </div>
                    <div className="flex items-center border-t border-edge-faint px-3 py-1">
                        <div className="flex-1" />
                        <button type="button" title="Expand" onClick={() => modalsModel.pushModal("AgentToolDetailModal", { action })} className="text-accent hover:text-accent-soft">
                            ↗
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (resolves the Task 4a `ToolDetailBody` import too).

- [ ] **Step 3: Run agents tests**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (renderer change is presentation; view-model tests unaffected).

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/narrationtimeline.tsx
git commit -m "feat(cockpit): expandable tool rows with inline→modal detail routing"
```

### Task 4c: Render edit-burst rows

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx` (the `items.map` switch in `NarrationTimeline`)

- [ ] **Step 1: Handle the `edit-burst` timeline item**

In the `NarrationTimeline` map, add a branch for `item.kind === "edit-burst"`: a clickable summary row (`edited · N files · +adds −dels`) that toggles inline (reuse `ToolDetailBody` with a synthetic `{ kind: "edit", files: item.files }`) when the total is within the edit budget, else opens the modal with a synthetic action `{ kind: "action", verb: "edited", target: `${item.files.length} files`, detail: { kind: "edit", files: item.files } }`. Use the same routing helper `detailExceedsInline({ kind: "edit", files: item.files })`.

```tsx
                if (item.kind === "edit-burst") {
                    return <EditBurstRow key={"eb" + item.startIndex} files={item.files} adds={item.adds} dels={item.dels} />;
                }
```

Add the `EditBurstRow` component (mirrors `ToolLine`'s routing, summary row per the mock's burst):

```tsx
function EditBurstRow({ files, adds, dels }: { files: EditFile[]; adds: number; dels: number }) {
    const [open, setOpen] = useState(false);
    const detail = { kind: "edit" as const, files };
    const toModal = detailExceedsInline(detail);
    const action = { kind: "action" as const, verb: "edited", target: `${files.length} file${files.length === 1 ? "" : "s"}`, detail };
    const onClick = () => (toModal ? modalsModel.pushModal("AgentToolDetailModal", { action }) : setOpen((v) => !v));
    return (
        <div>
            <div onClick={onClick} className="flex cursor-pointer items-center gap-1.5 rounded-[6px] px-1.5 py-[3px] opacity-[0.72] hover:bg-lane hover:opacity-100">
                <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] bg-success/15 text-[8px] text-success">✓</span>
                <span className="shrink-0 font-mono text-[8px] font-semibold uppercase tracking-[0.03em] text-feed-label">edited</span>
                <span className="font-mono text-[10.5px] text-feed-summary">{action.target}</span>
                <span className="shrink-0 font-mono text-[10px] text-success">+{adds}</span>
                <span className="shrink-0 font-mono text-[10px] text-error">−{dels}</span>
                <div className="min-w-[6px] flex-1" />
                <span className="shrink-0 font-mono text-[8px] text-edge-strong">{toModal ? "↗" : open ? "▼" : "▶"}</span>
            </div>
            {open && !toModal ? (
                <div className="my-1.5 overflow-hidden rounded-[9px] border border-edge-faint bg-surface-code">
                    <ToolDetailBody detail={detail} variant="inline" />
                </div>
            ) : null}
        </div>
    );
}
```

Add `EditFile` to the imports from `agentsviewmodel`.

- [ ] **Step 2: Typecheck + agents tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` then `npx vitest run frontend/app/view/agents/`
Expected: exit 0, PASS.

- [ ] **Step 3: Visual verification**

Run: `node scripts/cdp-shot.mjs tool-detail.png` (dev app running with an injected/live agent).
Expected: tool rows show summaries + durations; clicking a short grep/read expands inline; a long one and the edit-burst open the modal; the ↗ vs ▶ caret matches behavior.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/narrationtimeline.tsx
git commit -m "feat(cockpit): render edit-burst diff rows"
```

---

## Phase 5 — Card chrome: streaming flow bar (polish)

### Task 5a: Streaming flow bar under the header

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (header block ~line 320) and `frontend/tailwindsetup.css` (keyframes)

- [ ] **Step 1: Add the flow keyframe** to `tailwindsetup.css` (near `@keyframes pulseDot`):

```css
@keyframes flowBar {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
}
```

- [ ] **Step 2: Render it when working**, directly after the header `</div>` (~line 393):

```tsx
            {working ? (
                <div className="h-[2px] shrink-0 overflow-hidden bg-lane">
                    <div className="h-full w-[26%] bg-gradient-to-r from-transparent via-accent to-transparent animate-[flowBar_1.9s_linear_infinite] motion-reduce:animate-none" />
                </div>
            ) : null}
```

- [ ] **Step 3: Typecheck + visual check**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`; screenshot a working card via `node scripts/cdp-shot.mjs flow-bar.png`.
Expected: exit 0; a subtle accent sweep under the header only while working.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx frontend/tailwindsetup.css
git commit -m "feat(cockpit): streaming flow bar on working cards"
```

---

## Final verification

- [ ] **Step 1: Full frontend test suite**

Run: `npx vitest run`
Expected: all PASS (no regressions in the ~299-test baseline; new tests included).

- [ ] **Step 2: Typecheck (clean baseline)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: End-to-end visual pass**

With a live Claude agent (or injected transcript) that does grep → read → prose+code → 3 edits → bash pass → bash fail: confirm styled code blocks, quiet tool lines with summaries/durations, inline expansion under threshold, modal escalation over threshold + via the ↗ icon, edit-burst diff, and the working flow bar. Screenshot each with `scripts/cdp-shot.mjs`.

- [ ] **Step 4: Self-review the diff** — no raw hex in `className`/`style`, no leftover `_useTs`/`_tool`, no dead code.

---

## Deferred (explicit non-goals for v1)
- **Codex parity** — `codextranscriptprojection.ts` still emits bare actions; its shell-based reads/`apply_patch` map differently. Follow-up plan.
- **Full-fidelity diffs** — line-number gutters + interleaved context via an LCS. v1 shows removed-block/added-block only.
- **"Thinking" row** and the live typing caret from the mock — not wired to real data yet; skipped.
- **Bash exit codes** — approximated as `is_error ? 1 : 0`; Claude tool_result rarely carries the real code.
