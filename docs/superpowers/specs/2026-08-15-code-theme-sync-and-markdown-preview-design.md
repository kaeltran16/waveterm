# Code surface: Monaco theme sync and markdown preview

**Date:** 2026-08-15
**Status:** design approved in chat, no plan written yet
**Design source:** none — no mockup. Follows the surface's existing shape and the app's established
markdown and theming stacks.
**Supersedes in part:** decision 4 of `2026-08-03-code-browser-surface-design.md` ("Monaco keeps its
stock `vs-dark` token colors; the Code surface will not follow the runtime theme picker"). That
decision is revoked for the Code surface's Monaco instance. The markdown stack's shiki pin is
untouched.

## Why

Two gaps, both visible in daily use:

1. **Monaco does not follow the app theme.** The cockpit has a real runtime theming engine
   (`themes.ts` / `themestore.ts`: dark presets, `--color-*` CSS vars written to `<html>` before
   paint, custom accent/success/warning/error overrides). The engine re-skins all chrome — and the
   Code tab's chrome — but Monaco is hardcoded to `wave-theme-dark`, a `vs-dark` clone with `rules:
   []` (stock token colors) and a transparent background, set once at load. Switch a theme preset
   and the code colors never move; a keyword in a transcript block (`--color-syntax-keyword`) can
   differ from the same keyword in Monaco. The 08-03 spec's "revisit if it reads badly beside the
   rest of the cockpit" condition has been met.
2. **Markdown files render as raw source.** A README is the most-read file in a repository, and the
   surface shows it as markdown text in Monaco. The app already ships a document-grade markdown
   renderer (`element/markdown.tsx`), used by agent screens; the Code surface should reuse it so
   `README.md` reads like a document and can still be edited as source.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Runtime theme engine | `themes.ts` (pure `buildThemeVars(palette, overrides)` → `--color-*` map), `themestore.ts` (`themePresetAtom`, `themeOverridesAtom`, `useApplyCockpitTheme` at cockpit-root) | Shipped. Dark presets only; light ("Paper") explicitly deferred. `buildThemeVars` is a pure function the sync hook can call directly. |
| Syntax token vocabulary | `--color-syntax-{keyword,string,number,comment,punct,ident}` in `frontend/tailwindsetup.css`, live via `text-syntax-*` in `highlight.ts` (transcript code blocks) | Shipped. `@theme` defaults — not part of the runtime palette, so presets never change them. |
| Monaco loader + theme scaffold | `loadMonaco()` in `frontend/app/monaco/monaco-env.ts` — defines `wave-theme-dark` (base `vs-dark`, `rules: []`, transparent bg) and an unreachable `wave-theme-light`, then `setTheme("wave-theme-dark")` | Shipped. `loadMonaco` is exported and called by the lazy `monaco-react` chunk; `monaco-env` is itself part of that lazy chunk. |
| Document markdown renderer | `<Markdown>` in `frontend/app/element/markdown.tsx` — react-markdown + remark-gfm + rehypeRaw + rehype-sanitize + rehype-slug + hljs code blocks (`rehype-highlight`) + OverlayScrollbars + opt-in TOC | Shipped, used by agent screens (`vdom.tsx`, `userinputmodal.tsx`). Props: `text`, `scrollable`, `rehype`, `className`, `contentClassName`, `showTocAtom`, `resolveOpts`. Sanitized by default. |
| File classification | `classifyFile` in `frontend/app/view/code/codeclassify.ts` — size gate, MIME gate, NUL backstop | Shipped, pure, tested. The markdown check extends this module. |
| View-mode state precedent | `codeSearchModeAtom` (files/search column modes) in `codesearchstore.ts` | Shipped. A viewer-mode atom follows the same pattern (module-scoped, reset on project switch). |
| Editor + draft machinery | `codeviewer.tsx` (`draft ?? text` feed, per-path `key`, pending-line reveal), `codestore.ts` drafts/save/conflict | Shipped, unchanged by this design. |

## Resolved decisions

**1. Monaco token colors come from the cockpit's six `--color-syntax-*` tokens, mapped at scope-family level.** Monaco's tokenizer scopes do not map one-to-one onto the cockpit's six syntax roles, so the mapping is deliberately family-level and inherits everything else from the base theme:

| Cockpit token | Monaco scopes |
|---|---|
| keyword | `keyword`, `storage`, `control` |
| string | `string` |
| number | `constant.numeric` |
| comment | `comment` |
| punct | `punctuation`, `delimiter` |
| ident | `editor.foreground` (the default) |

Unlisted scopes (types, functions, variables, constants, tags, etc.) keep the stock `vs-dark`/`vs`
colors — honest coverage rather than a guessed full mapping, and the visual result is the cockpit
vocabulary on top of a sane base. Scopes the cockpit does tokenize always win, because
`defineTheme` rules are longest-prefix matched.

**2. Chrome roles come from the palette, derived through `buildThemeVars` — never read from computed style in an effect.** `useApplyCockpitTheme` runs its layout effect at cockpit-root, and child layout effects run before parent ones, so reading `getComputedStyle` inside the sync hook would race the engine on the commit where the theme changes. Instead the hook calls the same pure `buildThemeVars(activePalette(preset), overrides)` the engine uses and maps:

- `editor.foreground` ← `--color-foreground` (the text role)
- `editor.selectionBackground` ← `--color-surface-selected` alpha-blended (~0.5) via `colord` (existing dep)
- `editor.lineHighlightBackground` ← `--color-surface-hover` alpha-blended
- `editor.background` stays `#00000000` — the chrome's transparent background is the whole reason the editor blends with the surface

**3. Syntax tokens are read once from computed style, with no hardcoded duplicates.** The six
`--color-syntax-*` vars are static `@theme` defaults — presets never change them — so a single
`readSyntaxTokens()` call (getPropertyValue on `document.documentElement`, executed client-side where
the CSS is guaranteed loaded) supplies them. `loadMonaco()` itself routes through the same builder
with these computed tokens plus the chrome roles read from computed style — the one allowed
computed-style read, because `loadMonaco` runs at first editor mount, long after the root's
pre-paint theme application, so the values are settled and there is no ordering race. First paint is
synced before the hook ever runs. A failed read yields `null`s and the builder drops the
corresponding rules (inherit base) rather than inventing values — no duplicated hex constants to
drift from tailwindsetup.css.

**4. The sync hook crosses the lazy chunk boundary with a dynamic import, not a static one.** The
surface's static graph deliberately excludes Monaco (`codeviewer.tsx` imports it only as types;
`codeeditor.tsx` lazy-imports `monaco-react`). A static `import { loadMonaco }` from `monaco-env`
would pull the editor into the Code surface's chunk and load it on surface mount. Instead the hook
does `await import("@/app/monaco/monaco-env")` — the chunk boundary stays explicit, and Monaco loads
on Code-surface mount anyway (the surface is useless without the viewer). `loadMonaco`'s idempotence
guard makes re-entry free.

**5. The sync hook lives in the Code surface, not in the loader.** `useSyncMonacoTheme()` is called
from `CodeSurface` and watches `themePresetAtom` + `themeOverridesAtom` (the same atoms the engine
watches). The surface is today's only live Monaco consumer (the `aifilediff` block is a documented
removal candidate); a future consumer calls the hook itself. The light-theme code path exists in the
builder (`dark: false` selects base `vs` and the `#fefefe` background the existing `wave-theme-light`
already declares) so Paper slots in without redesign; nothing selects it today.

**6. Markdown detection is by extension, in `codeclassify.ts`.** `isMarkdownPath(rel)` — `.md` /
`.markdown`, case-insensitive — joins the existing pure classification helpers. MIME is not consulted:
the backend maps unknown extensions to an empty MIME (that is how Go and Rust files get classified
text), so MIME would misclassify `.md` reliably. The size gate runs first: a >2 MB markdown file
never reaches the preview.

**7. The viewer gets a mode, not a new pane.** `codeViewModeAtom: "preview" | "source"` in
`codestore.ts`, default `"preview"`, reset by `selectProject`, ignored when the open file is not
markdown. A segmented [Preview | Source] control in the path bar appears only for markdown files.
Source mode is the existing Monaco path — editor, drafts, save, conflict machinery untouched. The
preview renders `draft ?? text` (the same expression Monaco gets), so unsaved edits preview live.

*Rejected: side-by-side split.* A third layout, a resize concern, and nothing states the need.
*Rejected: auto-render with a "raw" escape hatch only.* The file is editable; hiding the editor
behind a gesture would bury the surface's write capability.

**8. The preview is `<Markdown>` from `element/markdown.tsx`, reused as-is.** Same component agent
screens use, so a README in the Code tab reads identically to markdown everywhere else in the
cockpit: sanitized raw HTML (`rehype` stays on — same trust posture as agent screens), GFM tables,
hljs code blocks, OverlayScrollbars (fills the viewer pane). `showTocAtom` stays unset — the TOC
renders below the content, which is the wrong shape for a pane. `resolveOpts` stays unset, so remote
images degrade to the component's own `[img]` placeholder exactly as they do elsewhere; repo-relative
image/links resolution is a separate slice and is not in scope. Code blocks inside the preview keep
the app's standard hljs look — the shiki pin (`streamdown.tsx`) and transcript styling are untouched;
theme sync covers the Monaco editor, not the markdown stack.

**9. Jump-to-line applies in Source mode only.** A search-result jump (`path:123`) into a markdown
file with the preview open has no line to reveal — the pending line is cleared on entry (the
`codePendingLineAtom` handler in `codeviewer.tsx` checks the mode) and the user lands in the preview;
switching to Source does not re-target. Documented, not engineered around.

**10. The preview remounts per file.** `codeviewer.tsx` keys its viewer by `file.path` today
(Monaco model lifecycle); the preview branch gets the same `key` so scroll position and rendered
content reset on file switch instead of bleeding across files.

## 1. Frontend — theme sync

### `frontend/app/monaco/monacotheme.ts` (new, pure core + hook)

```ts
export interface SyntaxTokens {
    keyword: string | null; string: string | null; number: string | null;
    comment: string | null; punct: string | null; ident: string | null;
}

export function monacoThemeFromTokens(
    tokens: SyntaxTokens,
    chrome: { foreground: string; selection: string; lineHighlight: string },
    dark: boolean
): IStandaloneThemeData;   // import type only — the module stays monaco-free at runtime

export function readSyntaxTokens(root: HTMLElement): SyntaxTokens;   // getPropertyValue × 6
export function useSyncMonacoTheme(): void;                          // watches themePresetAtom + themeOverridesAtom
```

`monacoThemeFromTokens` builds `rules` from the decision-1 table (dropping null entries), sets
`editor.foreground` / `selectionBackground` (colord α≈0.5) / `lineHighlightBackground` from `chrome`,
keeps `editor.background` transparent, and selects base `vs-dark` or `vs` by `dark`. The hook derives
`chrome` from `buildThemeVars(activePalette(preset), overrides)` (decision 2), merges
`readSyntaxTokens` (decision 3), and on change does `await import("@/app/monaco/monaco-env")` →
`loadMonaco()` → `defineTheme` + `setTheme` (decision 4).

### `frontend/app/monaco/monaco-env.ts` (changed)

`loadMonaco()`'s two static `defineTheme` calls route through `monacoThemeFromTokens` with
`readSyntaxTokens(document.documentElement)` and the current chrome defaults — `wave-theme-dark`
stays the applied theme at load; the hook corrects the chrome roles on first run. The `rules: []`
scaffold and the unreachable-light-theme duplication both disappear.

## 2. Frontend — markdown preview

### `codeclassify.ts` (changed)

```ts
export function isMarkdownPath(rel: string): boolean;   // /\.md$/i or /\.markdown$/i
```

### `codestore.ts` (changed)

`codeViewModeAtom: PrimitiveAtom<"preview" | "source">`, default `"preview"`, reset in
`selectProject` beside the other resets.

### `codeviewer.tsx` (changed)

The `text` branch gains a markdown path: `isMarkdownPath(file.path) && mode === "preview"` renders

```tsx
<Markdown key={file.path} text={draft?.text ?? file.text} scrollable className="h-full" />
```

inside the existing viewer pane. The pending-line effect and `applyPendingLine` gain a mode guard
(decision 9). Everything else — Monaco branch, binary/toolarge/missing/error states, editor
module-scope — is untouched.

### `codepathbar.tsx` (changed)

For markdown files, a segmented [Preview | Source] control sits left of the copy control, bound to
`codeViewModeAtom`. Non-markdown files render the bar exactly as today.

### `codesurface.tsx` (changed)

One `useSyncMonacoTheme()` call.

## 3. Failure modes

| Situation | What the user sees |
|---|---|
| Theme preset or overrides change while browsing | Monaco re-defines within the same commit cycle; chrome and tokens land together |
| `--color-syntax-*` read fails (empty vars) | The affected rules are dropped; Monaco inherits the base theme — never a crash, never fake colors |
| Light theme data present but unselected | Nothing changes today; the builder's `dark: false` path is exercised by unit tests only |
| Markdown file opened | Preview by default; Source restores the full editor |
| Markdown file with unsaved draft | Preview renders the draft (live preview); Source keeps the existing save/conflict flow |
| `:123` jump into a markdown file | Pending line cleared; lands in preview; documented in the code |
| `.MD` / `.markdown` case variants | Classified markdown (case-insensitive) |
| Markdown file > 2 MB | The existing too-large gate fires first; the preview never sees it |
| Repo-relative images/links in preview | The component's stock `[img]` placeholder / non-resolving link — identical to agent screens; out of scope |

## 4. Testing

**Vitest, beside each pure module.**

- `monacotheme.test.ts` — every token family maps to the right scope and color; null tokens drop
  their rules; `editor.foreground` = ident; selection/lineHighlight come from chrome with alpha;
  `dark: false` selects base `vs`; background stays transparent.
- `codeclassify.test.ts` (extended) — `isMarkdownPath`: `.md`, `.markdown`, `.MD`, `README.md` at
  root, `docs/x.md`, and non-markdown paths (`.mdown`-adjacent false positives like `.md5`, `.mds`).

**CDP** — one new `code-markdown` scenario in `scripts/cdp/scenarios.mjs`: pick the project, open a
markdown file, assert the rendered document (`.markdown .heading` present), toggle Source, assert the
editor mounted, toggle back. Theme sync is unit-tested plus a visual contact-sheet check across two
presets (open a `.ts` file, switch preset, shot shows token colors moving with it).

**Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare
`npx tsc` stack-overflows here). **Prettier** on touched files — never on `scenarios.mjs`
(hand-format additions to the file's four-space style; `.editorconfig` omits `.mjs`).

## 5. Suggested phasing

1. `monacotheme.ts` + tests + `monaco-env.ts` rerouting. Verified by Vitest, typecheck, and a dev-app
   look at token colors vs. transcript blocks.
2. `isMarkdownPath` + `codeViewModeAtom` + the preview branch + path-bar control. Verified by Vitest,
   the CDP `code-markdown` scenario, and the visual preset check.

## 6. Explicitly out of scope

Diff-vs-HEAD toggle and the "changed on disk" staleness bar (designed in chat 2026-08-15, shelved by
user redirect). Syncing the markdown stack's code-block colors (shiki pin, transcript styling).
Repo-relative image/link resolution in the preview. A sidebar TOC. Light mode ("Paper" — the builder
merely makes it a slot-in). Every other item in the 08-03 and 08-06 out-of-scope lists stands.
