# Code Theme Sync + Markdown Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Code tab's Monaco editor follow the cockpit's runtime theme (syntax tokens + chrome roles) and render markdown files as documents with a Preview/Source toggle.

**Architecture:** A pure, monaco-free bridge module (`monacotheme.ts`) maps the cockpit's six `--color-syntax-*` tokens onto Monaco scope families and the theme engine's `--color-*` roles onto editor chrome, driven by a hook that watches the same atoms the theme engine watches. Markdown detection extends the existing `codeclassify.ts`; a `codeViewModeAtom` switches the viewer between the app's existing `<Markdown>` document renderer and the current Monaco editor path.

**Tech Stack:** React 19 + jotai, Monaco via the existing lazy chunk (`monaco-env.ts`), react-markdown via `element/markdown.tsx`, colord (existing dep), vitest, CDP scenario harness (`scripts/cdp/scenarios.mjs`).

**Spec:** `docs/superpowers/specs/2026-08-15-code-theme-sync-and-markdown-preview-design.md`

## Global Constraints

- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — bare `npx tsc` stack-overflows on this repo; `task check:ts` is unusable. Baseline is clean; any reported error belongs to this work.
- Unit tests run in vitest's node environment (no jsdom declared) — no DOM access in `.test.ts` files. Test only pure modules; component/loader edits are verified by typecheck + the CDP/visual passes.
- Never run `prettier --write` on `scripts/cdp/scenarios.mjs` (`.editorconfig` omits `.mjs`; Prettier would reindent the whole file). Hand-format additions to the file's existing four-space style.
- No `task generate` needed — no wshrpc/waveobj/wconfig type changes in this work.
- Do not hand-edit generated files (none touched here).
- Colors come from token vars, never raw hex in components — `monacotheme.ts` maps token *values* (data), which is the exception the spec authorizes.
- No per-task commits. Per repo convention, batch everything into ONE commit at the end of Task 9, which requires explicit user approval before running `git commit`.
- CDP tasks need the dev app running (`task dev` in a separate terminal; builds backend first). `task verify:ui -- <scenario>` drives it over CDP.
- A new `Markdown` render in the viewer pane must fill it — verify `h-full` behavior visually in Task 9 and fall back to a wrapping flex container if the pane shows empty space.

## Spec ambiguity resolved (flagged for the user)

The spec's decision 1 table says ident maps to `editor.foreground`, and decision 2 says `editor.foreground` ← `--color-foreground`. Both claim one property. Resolution: **chrome's `foreground` wins; the ident token is the fallback** — the surface's text role should govern plain text in the editor, and `--color-foreground` is always set by the theme engine, so ident only matters before the engine runs.

---

### Task 1: Monaco theme bridge module

**Files:**
- Create: `frontend/app/monaco/monacotheme.ts`
- Create: `frontend/app/monaco/monacotheme.test.ts`

**Interfaces:**
- Consumes: `THEMES`, `activePalette(presetId)`, `buildThemeVars(palette, overrides)` from `@/app/view/agents/themes`; `themePresetAtom`, `themeOverridesAtom` from `@/app/view/agents/themestore`; `colord`.
- Produces (later tasks depend on these exact signatures):
  - `interface SyntaxTokens { keyword: string | null; string: string | null; number: string | null; comment: string | null; punct: string | null; ident: string | null }`
  - `interface MonacoChrome { foreground: string | null; selection: string | null; lineHighlight: string | null }`
  - `monacoThemeFromTokens(tokens: SyntaxTokens, chrome: MonacoChrome, dark: boolean): IStandaloneThemeData` (import type only — module stays monaco-free at runtime)
  - `readSyntaxTokens(root: HTMLElement): SyntaxTokens`
  - `readChromeRoles(root: HTMLElement): MonacoChrome`
  - `useSyncMonacoTheme(): void`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/monaco/monacotheme.test.ts`:

```ts
// frontend/app/monaco/monacotheme.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { monacoThemeFromTokens, type MonacoChrome, type SyntaxTokens } from "./monacotheme";

const TOKENS: SyntaxTokens = {
    keyword: "#aebfff",
    string: "#7fd6ab",
    number: "#e6b450",
    comment: "#6b7178",
    punct: "#8b939d",
    ident: "#cdd3da",
};

const CHROME: MonacoChrome = {
    foreground: "#e2e8f0",
    selection: "#1a222c",
    lineHighlight: "#171c22",
};

describe("monacoThemeFromTokens", () => {
    it("maps each syntax token to its scope family on a dark base", () => {
        const t = monacoThemeFromTokens(TOKENS, CHROME, true);
        expect(t.base).toBe("vs-dark");
        expect(t.inherit).toBe(true);
        const rule = (token: string) => t.rules.find((r) => r.token === token);
        expect(rule("keyword")?.foreground).toBe("#aebfff");
        expect(rule("storage")?.foreground).toBe("#aebfff");
        expect(rule("control")?.foreground).toBe("#aebfff");
        expect(rule("string")?.foreground).toBe("#7fd6ab");
        expect(rule("constant.numeric")?.foreground).toBe("#e6b450");
        expect(rule("comment")?.foreground).toBe("#6b7178");
        expect(rule("punctuation")?.foreground).toBe("#8b939d");
        expect(rule("delimiter")?.foreground).toBe("#8b939d");
    });

    it("drops rules for null tokens instead of inventing colors", () => {
        const t = monacoThemeFromTokens({ ...TOKENS, keyword: null, punct: null }, CHROME, true);
        for (const token of ["keyword", "storage", "control", "punctuation", "delimiter"]) {
            expect(t.rules.find((r) => r.token === token)).toBeUndefined();
        }
        expect(t.rules.find((r) => r.token === "string")).toBeDefined();
    });

    it("sets editor.foreground from chrome, falling back to the ident token", () => {
        expect(monacoThemeFromTokens(TOKENS, CHROME, true).colors["editor.foreground"]).toBe("#e2e8f0");
        const noChrome = monacoThemeFromTokens(TOKENS, { ...CHROME, foreground: null }, true);
        expect(noChrome.colors["editor.foreground"]).toBe("#cdd3da");
        const neither = monacoThemeFromTokens({ ...TOKENS, ident: null }, { ...CHROME, foreground: null }, true);
        expect(neither.colors["editor.foreground"]).toBeUndefined();
    });

    it("alpha-blends the selection and line-highlight chrome colors", () => {
        const t = monacoThemeFromTokens(TOKENS, CHROME, true);
        expect(t.colors["editor.selectionBackground"]).toMatch(/^#1a222c[0-9a-f]{2}$/);
        expect(t.colors["editor.lineHighlightBackground"]).toMatch(/^#171c22[0-9a-f]{2}$/);
    });

    it("drops chrome colors that are null so the base theme's values inherit", () => {
        const t = monacoThemeFromTokens(TOKENS, { ...CHROME, selection: null, lineHighlight: null }, true);
        expect(t.colors["editor.selectionBackground"]).toBeUndefined();
        expect(t.colors["editor.lineHighlightBackground"]).toBeUndefined();
    });

    it("keeps the editor background transparent on dark and opaque on light", () => {
        expect(monacoThemeFromTokens(TOKENS, CHROME, true).colors["editor.background"]).toBe("#00000000");
        expect(monacoThemeFromTokens(TOKENS, CHROME, false).colors["editor.background"]).toBe("#fefefe");
    });

    it("keeps the existing minimap/sticky-scroll chrome values", () => {
        const t = monacoThemeFromTokens(TOKENS, CHROME, true);
        expect(t.colors["minimap.background"]).toBe("#00000077");
        expect(t.colors["editorStickyScroll.background"]).toBe("#00000055");
    });

    it("selects the light base when dark is false", () => {
        expect(monacoThemeFromTokens(TOKENS, CHROME, false).base).toBe("vs");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/monaco/monacotheme.test.ts`
Expected: FAIL — `Cannot find module './monacotheme'`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/app/monaco/monacotheme.ts`:

```ts
// frontend/app/monaco/monacotheme.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The bridge between the cockpit's theme vocabulary and Monaco's. The cockpit tokenizes six syntax
// roles (--color-syntax-*) plus chrome roles the runtime engine writes as --color-* vars; Monaco's
// tokenizer scopes do not map one-to-one, so the mapping is family-level and everything else
// inherits the stock base theme. The module imports monaco-editor only as a type, so it stays
// outside the lazy monaco chunk and unit-testable in node.

import { colord } from "colord";
import { useAtomValue } from "jotai";
import { useLayoutEffect } from "react";
import type { IStandaloneThemeData } from "monaco-editor";
import { activePalette, buildThemeVars, THEMES } from "@/app/view/agents/themes";
import { themeOverridesAtom, themePresetAtom } from "@/app/view/agents/themestore";

export interface SyntaxTokens {
    keyword: string | null;
    string: string | null;
    number: string | null;
    comment: string | null;
    punct: string | null;
    ident: string | null;
}

export interface MonacoChrome {
    foreground: string | null;
    selection: string | null;
    lineHighlight: string | null;
}

const SELECTION_ALPHA = 0.5;
const LINE_HIGHLIGHT_ALPHA = 0.35;

// token family -> cockpit role. "storage"/"control" read as keyword-family declarations
// (let/const/type), "delimiter" joins "punctuation" (braces, brackets, separators).
const KEYWORD_SCOPES = ["keyword", "storage", "control"] as const;
const PUNCT_SCOPES = ["punctuation", "delimiter"] as const;

export function monacoThemeFromTokens(
    tokens: SyntaxTokens,
    chrome: MonacoChrome,
    dark: boolean
): IStandaloneThemeData {
    const rules: IStandaloneThemeData["rules"] = [];
    const add = (token: string, color: string | null): void => {
        if (color != null) {
            rules.push({ token, foreground: color });
        }
    };
    for (const scope of KEYWORD_SCOPES) {
        add(scope, tokens.keyword);
    }
    add("string", tokens.string);
    add("constant.numeric", tokens.number);
    add("comment", tokens.comment);
    for (const scope of PUNCT_SCOPES) {
        add(scope, tokens.punct);
    }
    const colors: Record<string, string> = {
        // transparent background lets the surface chrome show through; opaque on light
        "editor.background": dark ? "#00000000" : "#fefefe",
        // carried over from the original scaffold so the minimap/sticky scroll do not regress
        "editorStickyScroll.background": "#00000055",
        "minimap.background": "#00000077",
        focusBorder: "#00000000",
    };
    // the text role governs plain text; the ident token is the code-default fallback (see plan
    // "Spec ambiguity resolved" — chrome wins, ident is the pre-engine fallback)
    const fg = chrome.foreground ?? tokens.ident;
    if (fg != null) {
        colors["editor.foreground"] = fg;
    }
    if (chrome.selection != null) {
        colors["editor.selectionBackground"] = colord(chrome.selection).alpha(SELECTION_ALPHA).toHex();
    }
    if (chrome.lineHighlight != null) {
        colors["editor.lineHighlightBackground"] = colord(chrome.lineHighlight).alpha(LINE_HIGHLIGHT_ALPHA).toHex();
    }
    return { base: dark ? "vs-dark" : "vs", inherit: true, rules, colors };
}

function cssVar(root: HTMLElement, name: string): string | null {
    const v = root.ownerDocument.defaultView?.getComputedStyle(root).getPropertyValue(name).trim();
    return v === "" ? null : v;
}

// the six --color-syntax-* vars are static @theme defaults, so a read at any point after CSS load
// is stable; a null means "inherit the base theme", never a guessed value
export function readSyntaxTokens(root: HTMLElement): SyntaxTokens {
    return {
        keyword: cssVar(root, "--color-syntax-keyword"),
        string: cssVar(root, "--color-syntax-string"),
        number: cssVar(root, "--color-syntax-number"),
        comment: cssVar(root, "--color-syntax-comment"),
        punct: cssVar(root, "--color-syntax-punct"),
        ident: cssVar(root, "--color-syntax-ident"),
    };
}

export function readChromeRoles(root: HTMLElement): MonacoChrome {
    return {
        foreground: cssVar(root, "--color-foreground"),
        selection: cssVar(root, "--color-surface-selected"),
        lineHighlight: cssVar(root, "--color-surface-hover"),
    };
}

// Watches the same atoms the theme engine watches and re-themes Monaco. Chrome roles are derived
// through the engine's own pure buildThemeVars rather than computed style, because this layout
// effect runs BEFORE cockpit-root's (child effects run first) and a computed-style read would race
// the engine on the commit where the theme changes. Syntax tokens are static, so readSyntaxTokens
// is safe here. The dynamic import keeps monaco-editor out of the surface's static chunk graph.
export function useSyncMonacoTheme(): void {
    const preset = useAtomValue(themePresetAtom);
    const overrides = useAtomValue(themeOverridesAtom);
    useLayoutEffect(() => {
        const def = THEMES.find((t) => t.id === preset);
        const vars = buildThemeVars(activePalette(preset), overrides);
        const chrome: MonacoChrome = {
            foreground: vars["--color-foreground"],
            selection: vars["--color-surface-selected"],
            lineHighlight: vars["--color-surface-hover"],
        };
        const tokens = readSyntaxTokens(document.documentElement);
        let cancelled = false;
        void import("@/app/monaco/monaco-env").then((m) => {
            if (cancelled) {
                return;
            }
            m.loadMonaco();
            m.applyMonacoTheme("wave-theme-dark", monacoThemeFromTokens(tokens, chrome, def?.dark ?? true));
        });
        return () => {
            cancelled = true;
        };
    }, [preset, overrides]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/monaco/monacotheme.test.ts`
Expected: PASS — all 8 `it` blocks green.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

---

### Task 2: Route the Monaco loader through the bridge

**Files:**
- Modify: `frontend/app/monaco/monaco-env.ts`

**Interfaces:**
- Consumes: `monacoThemeFromTokens`, `readChromeRoles`, `readSyntaxTokens` from `./monacotheme` (Task 1).
- Produces: `applyMonacoTheme(name: string, theme: IStandaloneThemeData): void` — used by Task 7's hook.

- [ ] **Step 1: Replace the static theme definitions**

In `frontend/app/monaco/monaco-env.ts`, add the import beside the existing monaco import:

```ts
import { monacoThemeFromTokens, readChromeRoles, readSyntaxTokens } from "./monacotheme";
```

Replace the two `defineTheme` calls inside `loadMonaco()` (the `wave-theme-dark` block and the `wave-theme-light` block, including their `rules: []` color maps) with:

```ts
    // theme definitions now come from the cockpit's own tokens (see monacotheme.ts); computed-style
    // reads are safe here because loadMonaco runs at first editor mount, long after cockpit-root's
    // pre-paint theme application, so the values are settled
    const tokens = readSyntaxTokens(document.documentElement);
    const chrome = readChromeRoles(document.documentElement);
    monaco.editor.defineTheme("wave-theme-dark", monacoThemeFromTokens(tokens, chrome, true));
    monaco.editor.defineTheme("wave-theme-light", monacoThemeFromTokens(tokens, chrome, false));
```

Keep the existing `monaco.editor.setTheme("wave-theme-dark")` call, the diagnostics options, and the "no monaco-yaml here on purpose" comment.

Add the exported apply helper at the end of the file (below `loadMonaco`):

```ts
// The hook's entry point across the lazy chunk boundary: redefine under the same name (defineTheme
// overwrites) and activate. Keeps monaco usage inside this module so monacotheme.ts stays type-only.
export function applyMonacoTheme(name: string, theme: IStandaloneThemeData): void {
    monaco.editor.defineTheme(name, theme);
    monaco.editor.setTheme(name);
}
```

`IStandaloneThemeData` is available as a type from the existing `import * as monaco from "monaco-editor"` module namespace — do not add a new import for it.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Suite still green**

Run: `npx vitest run frontend/app/monaco/monacotheme.test.ts`
Expected: PASS.

---

### Task 3: Markdown file classification

**Files:**
- Modify: `frontend/app/view/code/codeclassify.ts`
- Modify: `frontend/app/view/code/codeclassify.test.ts`

**Interfaces:**
- Produces: `isMarkdownPath(rel: string): boolean` — consumed by Task 5 and Task 6.

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/code/codeclassify.test.ts`:

```ts
import { classifyFile, hasNulByte, isMarkdownPath, MAX_VIEW_BYTES } from "./codeclassify";
```

(update the existing import line to add `isMarkdownPath`), then append:

```ts
describe("isMarkdownPath", () => {
    it("accepts .md and .markdown, case-insensitively, at any depth", () => {
        expect(isMarkdownPath("README.md")).toBe(true);
        expect(isMarkdownPath("docs/guide.markdown")).toBe(true);
        expect(isMarkdownPath("CHANGELOG.MD")).toBe(true);
        expect(isMarkdownPath("frontend/app/view/code/readme.md")).toBe(true);
    });

    it("rejects extensions that merely contain md", () => {
        expect(isMarkdownPath("file.md5")).toBe(false);
        expect(isMarkdownPath("file.mds")).toBe(false);
        expect(isMarkdownPath("foo.md.txt")).toBe(false);
        expect(isMarkdownPath("src/main.ts")).toBe(false);
        expect(isMarkdownPath("Makefile")).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/code/codeclassify.test.ts`
Expected: FAIL — `isMarkdownPath is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `frontend/app/view/code/codeclassify.ts`, below the `MAX_VIEW_BYTES` constant:

```ts
// READMEs and other prose read as documents; the viewer renders them with the app's markdown
// component. Extension-only: the backend maps unknown extensions to an empty mimetype (how Go and
// Rust files pass the text gate), so MIME would misclassify .md reliably.
const MARKDOWN_EXT = /\.(?:md|markdown)$/i;

export function isMarkdownPath(rel: string): boolean {
    return MARKDOWN_EXT.test(rel);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/code/codeclassify.test.ts`
Expected: PASS — both describes green.

---

### Task 4: Viewer mode atom

**Files:**
- Modify: `frontend/app/view/code/codestore.ts`

**Interfaces:**
- Produces: `codeViewModeAtom: PrimitiveAtom<"preview" | "source">` — consumed by Task 5 and Task 6.

- [ ] **Step 1: Add the atom**

In `frontend/app/view/code/codestore.ts`, next to the other module-scoped atoms (after `codeTreeFocusedAtom`):

```ts
// Markdown files render as documents by default; Source switches to the editable Monaco view.
// Ignored for non-markdown files, which are always Source. Reset on project switch, but not on
// file switch — a reader who prefers source stays in source across files.
export const codeViewModeAtom = atom<"preview" | "source">("preview") as PrimitiveAtom<"preview" | "source">;
```

- [ ] **Step 2: Reset it on project switch**

In `selectProject`, beside the other resets (after `globalStore.set(codePendingLineAtom, null);`):

```ts
    globalStore.set(codeViewModeAtom, "preview");
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

---

### Task 5: Preview branch in the viewer

**Files:**
- Modify: `frontend/app/view/code/codeviewer.tsx`

**Interfaces:**
- Consumes: `isMarkdownPath` (Task 3), `codeViewModeAtom` (Task 4), `Markdown` from `@/app/element/markdown`.

- [ ] **Step 1: Imports**

In `frontend/app/view/code/codeviewer.tsx`, add to the existing import block:

```ts
import { Markdown } from "@/app/element/markdown";
import { isMarkdownPath } from "./codeclassify";
```

and extend the `codestore` import with `codeViewModeAtom`:

```ts
import {
    codeDraftsAtom,
    codeFileAtom,
    codePendingLineAtom,
    codeProjectAtom,
    codeViewModeAtom,
    draftKey,
    editDraft,
    refreshIndex,
} from "./codestore";
```

- [ ] **Step 2: Mode-guard the pending-line effect**

In `CodeViewer`, read the mode and replace the existing pending-line effect:

```tsx
    const mode = useAtomValue(codeViewModeAtom);
```

```tsx
    useEffect(() => {
        if (pendingLine == null) {
            return;
        }
        // a rendered document has no line to reveal; consume the request so a later Source toggle
        // does not half-open the file at a stale position
        if (file.kind === "text" && isMarkdownPath(file.path) && mode === "preview") {
            globalStore.set(codePendingLineAtom, null);
            return;
        }
        if (editor != null) {
            applyPendingLine(editor);
        }
    }, [pendingLine, file, mode]);
```

- [ ] **Step 3: Add the preview branch to the text case**

In the `case "text"` block, between the draft lookup and the existing `<CodeEditor …>` return:

```tsx
            // READMEs and other prose render as documents; Source (the CodeEditor below) stays one
            // toggle away, and the draft feeds the preview so unsaved edits show what you would save
            if (isMarkdownPath(file.path) && mode === "preview") {
                return (
                    <Markdown key={file.path} text={draft?.text ?? file.text} scrollable className="h-full" />
                );
            }
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

---

### Task 6: Preview/Source toggle in the path bar

**Files:**
- Modify: `frontend/app/view/code/codepathbar.tsx`

**Interfaces:**
- Consumes: `isMarkdownPath` (Task 3), `codeViewModeAtom` (Task 4).

- [ ] **Step 1: Imports and mode toggle**

In `frontend/app/view/code/codepathbar.tsx`:

- Change `import { useAtomValue } from "jotai";` to `import { useAtom, useAtomValue } from "jotai";`
- Extend the `./codestore` import with `codeViewModeAtom`.
- Add `import { isMarkdownPath } from "./codeclassify";`
- Add the toggle component at the end of the file:

```tsx
// Markdown files render as documents by default; this is the escape back to the editable view.
// The segmented control mirrors the Files/Search column-mode idiom.
function ViewModeToggle() {
    const [mode, setMode] = useAtom(codeViewModeAtom);
    return (
        <div className="flex flex-none items-center gap-0.5 rounded-[6px] border border-border p-[2px]">
            {(["preview", "source"] as const).map((m) => (
                <button
                    key={m}
                    type="button"
                    data-code-view-mode={m}
                    onClick={() => setMode(m)}
                    className={cn(
                        "cursor-pointer rounded-[4px] px-2 py-[2px] text-[11px] capitalize",
                        m === mode ? "bg-accent/10 text-accent-soft" : "text-muted hover:text-primary"
                    )}
                >
                    {m}
                </button>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Render it for markdown files**

In `CodePathBar`, between the dirty-dot span and the `<div className="flex-1" />` spacer:

```tsx
            {file.kind === "text" && isMarkdownPath(file.path) ? <ViewModeToggle /> : null}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

---

### Task 7: Wire the theme hook into the surface

**Files:**
- Modify: `frontend/app/view/code/codesurface.tsx`

**Interfaces:**
- Consumes: `useSyncMonacoTheme` from `@/app/monaco/monacotheme` (Task 1).

- [ ] **Step 1: Hook call**

In `frontend/app/view/code/codesurface.tsx`:

- Add `import { useSyncMonacoTheme } from "@/app/monaco/monacotheme";`
- In `CodeSurface`, at the top of the component body (after the existing `useKeybindings(codeBindings);` line):

```tsx
    useSyncMonacoTheme();
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

---

### Task 8: CDP scenario for the markdown preview

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (hand-format to the file's four-space style; never prettier)

**Interfaces:**
- Consumes: the UI from Tasks 5–6: `[data-code-view-mode="preview"|"source"]` buttons, `.markdown .heading` rendered elements, the finder input `input[placeholder="Find a file by name — add :123 for a line"]`.
- Reuses existing helpers: `openProjectPicker`, `chooseProjectRow`, `SURFACE_LABEL` (all already in this file).

- [ ] **Step 1: Add the finder helper and the scenario**

Place the helper next to `setSearchQuery` (which sits just above the `codeSearch` scenario), and the scenario immediately after `codeSearch`'s closing brace. Both in the file's four-space style:

```js
const setFinderQuery = (h, text) =>
    h.ev(`(() => {
        const input = document.querySelector('input[placeholder="Find a file by name — add :123 for a line"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
    })()`);

const codeMarkdown = {
    name: "code-markdown",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        steps.push({
            step: "Code surface is active",
            ok: (await h.activeSurfaceLabel()) === SURFACE_LABEL.code,
            detail: `active=${await h.activeSurfaceLabel()}`,
        });

        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            const picked = await chooseProjectRow(h);
            steps.push({ step: "select a project", ok: picked === true, detail: `picked=${picked}` });
            await sleep(1200); // the index is one git ls-files call
        }

        // Ctrl+P opens the file finder (the command palette moved to Ctrl+Shift+P); Enter opens the
        // top-ranked match
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
        );
        await sleep(300);
        const typed = await setFinderQuery(h, "README.md");
        steps.push({ step: "open the finder with Ctrl+P and open README.md", ok: typed === true, detail: `typed=${typed}` });
        await sleep(800); // one stat-then-read round trip

        const heading = await h.ev(`(() => {
            const h = document.querySelector('.markdown .heading');
            return h ? (h.textContent || '').trim() : null;
        })()`);
        steps.push({
            step: "markdown file renders as a document (a heading is present)",
            ok: heading != null && heading.length > 0,
            detail: `heading=${heading}`,
        });
        await h.shot("cdp-shots/code-markdown-preview.png");

        const toSource = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="source"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(600);
        const editor = await h.ev(`(() => !!document.querySelector('.monaco-editor'))()`);
        steps.push({
            step: "toggle to Source mounts the Monaco editor",
            ok: toSource === true && editor === true,
            detail: `toggled=${toSource} editor=${editor}`,
        });

        const backToPreview = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="preview"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(400);
        const previewAgain = await h.ev(`(() => !!document.querySelector('.markdown .heading'))()`);
        steps.push({
            step: "toggle back to Preview re-renders the document",
            ok: backToPreview === true && previewAgain === true,
            detail: `toggled=${backToPreview} preview=${previewAgain}`,
        });

        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};
```

- [ ] **Step 2: Register the scenario**

In the `SCENARIOS` export array, insert `codeMarkdown,` right after `codeSearch,`.

- [ ] **Step 3: Run the scenario against the dev app**

With the dev app running (`task dev` in a separate terminal, first run also does `task init` if `node_modules`/`dist/bin` are missing):

Run: `task verify:ui -- code-markdown`
Expected: all steps `ok: true`; `cdp-shots/code-markdown-preview.png` written. If the project registry is empty in the dev app, the scenario records the picker steps as skipped/failed the same way `code-search` does — register the repo as a project in Settings first.

---

### Task 9: Full verification and commit

**Files:**
- Verify: the full change set from Tasks 1–8.
- Include in the commit (single commit, per repo convention): all source + test files from Tasks 1–8, plus the spec `docs/superpowers/specs/2026-08-15-code-theme-sync-and-markdown-preview-design.md` and this plan `docs/superpowers/plans/2026-08-15-code-theme-sync-and-markdown-preview.md`.

- [ ] **Step 1: Full unit suite**

Run: `npx vitest run`
Expected: PASS (baseline is green; any failure belongs to this work).

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Prettier on touched files (not scenarios.mjs)**

Run: `npx prettier --check frontend/app/monaco/monacotheme.ts frontend/app/monaco/monacotheme.test.ts frontend/app/monaco/monaco-env.ts frontend/app/view/code/codeclassify.ts frontend/app/view/code/codeclassify.test.ts frontend/app/view/code/codestore.ts frontend/app/view/code/codeviewer.tsx frontend/app/view/code/codepathbar.tsx frontend/app/view/code/codesurface.tsx`
Expected: all clean. If any file fails, run `npx prettier --write <that file>` and re-run the check. Never include `scenarios.mjs`.

- [ ] **Step 4: CDP regression + new scenario**

With the dev app running:

Run: `task verify:ui -- surface-smoke` then `task verify:ui -- code-markdown`
Expected: surface-smoke all green (Code surface included), code-markdown all green.

- [ ] **Step 5: Visual theme check (contact sheet)**

With the dev app running, in the Code surface open a `.ts` file (e.g. `frontend/app/view/code/codestore.ts`). Confirm the Monaco token colors match the cockpit syntax tokens (a keyword in Monaco vs. a keyword in a transcript code block). Then switch the theme preset:

In the app's Settings → Theme (or directly in the devtools console): `localStorage.setItem('cockpit.theme.preset', 'slate'); location.reload();`

Confirm: (a) the chrome re-skins, (b) Monaco's token colors are unchanged (syntax tokens are preset-independent by design) while selection/line-highlight/foreground come from the new palette, (c) the markdown preview renders identically. Take `cdp-shots` of both states for the contact sheet if a visual record is wanted. Also confirm the `h-full` fill of the preview pane (Global Constraints): a README should scroll inside the pane, not leave empty space below.

- [ ] **Step 6: Commit (awaiting approval)**

Show the change summary and the message, then wait for explicit user approval before running:

```bash
git add frontend/app/monaco/monacotheme.ts frontend/app/monaco/monacotheme.test.ts frontend/app/monaco/monaco-env.ts frontend/app/view/code/codeclassify.ts frontend/app/view/code/codeclassify.test.ts frontend/app/view/code/codestore.ts frontend/app/view/code/codeviewer.tsx frontend/app/view/code/codepathbar.tsx frontend/app/view/code/codesurface.tsx scripts/cdp/scenarios.mjs docs/superpowers/specs/2026-08-15-code-theme-sync-and-markdown-preview-design.md docs/superpowers/plans/2026-08-15-code-theme-sync-and-markdown-preview.md
git commit -m "feat(code): sync monaco theme and render markdown files as documents"
```

Subject is 68 chars, explains why: the editor now follows the cockpit palette, and READMEs read as documents with a Source escape hatch. Do NOT commit without approval; do NOT add a co-author.
