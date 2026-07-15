# Context-menu polish + centralized OS-modifier glyphs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the right-click context menu look polished (leading icons, real glyphs, floating highlight, Comfortable spacing) and route every keyboard-modifier glyph in the app through one platform-aware source of truth (`^` on Windows/Linux, `⌘` on macOS).

**Architecture:** A new pure `keysym` util maps modifier tokens to platform glyphs; a shared `<KeyCap>` element renders chips from it. The context-menu renderer (`contextmenu.tsx`) gains an icon/state leading column, lucide `Check`/`ChevronRight`, an inset rounded highlight, and a right-aligned `<KeyCap>` shortcut column. Icons are then populated across all 10 menu call sites, and the ~7 hardcoded modifier-glyph sites are migrated onto the new util. Display-only; no key-dispatch or menu-behavior changes.

**Tech Stack:** React 19, TypeScript, Tailwind 4 (`@theme` tokens), jotai, `lucide-react`, vitest. Tauri dev app verified over CDP (`:9222`).

## Global Constraints

- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0) — any error is yours.
- **Tests:** `npx vitest run <file>` for a single file; `npx vitest run` for all. Baseline is green.
- **Icons:** `lucide-react` only (already the house icon lib). Size icons at 13–15px.
- **Colors:** `@theme` tokens only (`text-muted`, `text-accent`, `text-error`, `bg-accent/…`, `border-edge-mid`, …). Never raw hex/rgba.
- **No new SCSS.** Tailwind utilities only.
- **Platform source:** read platform via `isMacOS()` from `@/util/platformutil` (set once at boot). **Never** compute a glyph at module-evaluation time — only inside render/function calls — because the module graph can load before boot sets the platform. Glyph-producing helpers are functions; call sites invoke them at render.
- **Modifier convention:** both `Cmd` and `Ctrl` tokens are the primary accelerator → `^` (Windows/Linux) / `⌘` (macOS). `Shift`→`⇧`, `Alt`/`Option`→`⌥` (mac) / `Alt` (win). This collapses the Ctrl/Cmd distinction on macOS (safe: app is Windows-only today; see spec).
- **Git:** Do NOT commit or push without explicit user approval. Every task below ends at a **checkpoint** (tsc + relevant tests green), NOT a commit. All work batches into ONE feature commit in Task 11, after approval, folding in the spec + this plan doc. Do not add Claude as co-author.

Spec: `docs/superpowers/specs/2026-07-15-contextmenu-polish-and-os-modifier-glyphs-design.md`

---

### Task 1: `keysym` central module

**Files:**
- Create: `frontend/util/keysym.ts`
- Test: `frontend/util/keysym.test.ts`

**Interfaces:**
- Consumes: `isMacOS`, `setPlatform` from `@/util/platformutil`.
- Produces:
  - `modSymbol(token: string): string`
  - `formatChord(keys: string): string[]`
  - `formatChordString(keys: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/util/keysym.test.ts
import { describe, expect, it } from "vitest";
import { setPlatform } from "./platformutil";
import { formatChord, formatChordString, modSymbol } from "./keysym";

describe("keysym", () => {
    it("primary accelerator is ^ on Windows", () => {
        setPlatform("win32");
        expect(modSymbol("Ctrl")).toBe("^");
        expect(modSymbol("Cmd")).toBe("^");
        expect(modSymbol("Shift")).toBe("⇧");
        expect(modSymbol("Alt")).toBe("Alt");
    });
    it("primary accelerator is ⌘ on macOS", () => {
        setPlatform("darwin");
        expect(modSymbol("Ctrl")).toBe("⌘");
        expect(modSymbol("Cmd")).toBe("⌘");
        expect(modSymbol("Option")).toBe("⌥");
    });
    it("formats modifier chords, upper-casing the final letter key", () => {
        setPlatform("win32");
        expect(formatChord("Ctrl:p")).toEqual(["^", "P"]);
        expect(formatChord("Ctrl:Shift:Tab")).toEqual(["^", "⇧", "Tab"]);
        expect(formatChord("Shift:Escape")).toEqual(["⇧", "esc"]);
        expect(formatChordString("Cmd:Enter")).toBe("^⏎");
    });
    it("keeps leader-chord keys as typed (no upper-casing)", () => {
        setPlatform("win32");
        expect(formatChord("g p")).toEqual(["g", "p"]);
    });
    it("maps named keys", () => {
        setPlatform("win32");
        expect(modSymbol("Enter")).toBe("⏎");
        expect(modSymbol("ArrowUp")).toBe("↑");
        expect(modSymbol("Escape")).toBe("esc");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/util/keysym.test.ts`
Expected: FAIL — cannot resolve `./keysym`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/util/keysym.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Single source of truth for keyboard-modifier / key display glyphs. Platform-aware:
// the primary accelerator (Cmd/Ctrl) renders "^" on Windows/Linux and "⌘" on macOS.
// Never call these at module-eval time — platform is set at boot (see platformutil).

import { isMacOS } from "./platformutil";

// non-modifier keys with a canonical glyph; also used to avoid upper-casing named keys.
const NAMED: Record<string, string> = {
    Enter: "⏎",
    Return: "⏎",
    Escape: "esc",
    Esc: "esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Space: "Space",
    Tab: "Tab",
    Backspace: "⌫",
    Delete: "Del",
    PageUp: "PgUp",
    PageDown: "PgDn",
    Home: "Home",
    End: "End",
};

// One chord token -> display glyph. Modifier tokens branch on platform; letters upper-case.
export function modSymbol(token: string): string {
    switch (token) {
        case "Cmd":
        case "Ctrl":
            return isMacOS() ? "⌘" : "^";
        case "Shift":
            return "⇧";
        case "Alt":
        case "Option":
            return isMacOS() ? "⌥" : "Alt";
        case "Meta":
            return isMacOS() ? "⌘" : "Win";
    }
    if (NAMED[token] != null) {
        return NAMED[token];
    }
    return token.length === 1 ? token.toUpperCase() : token;
}

// Full chord -> per-part glyphs. Space-separated = leader chord (keys kept as typed);
// colon-separated = modifier chord (each part through modSymbol).
export function formatChord(keys: string): string[] {
    if (keys.includes(" ")) {
        return keys.split(" ").map((k) => NAMED[k] ?? k);
    }
    return keys.split(":").map((k) => modSymbol(k));
}

export function formatChordString(keys: string): string {
    return formatChord(keys).join("");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/util/keysym.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (Do NOT commit — see Global Constraints.)

---

### Task 2: `<KeyCap>` shared element

**Files:**
- Create: `frontend/app/element/keycap.tsx`

**Interfaces:**
- Consumes: `formatChord` from `@/util/keysym`; `cn` from `@/util/util`.
- Produces: `KeyCap({ chord, variant?, className? })` where `variant` is `"chips" | "inline"` (default `"chips"`).

> No render-test harness exists for the cockpit (see CLAUDE.md). This component's logic is `formatChord` (tested in Task 1); the visual is verified in the final CDP pass (Task 11). Task checkpoint is typecheck only.

- [ ] **Step 1: Write the implementation**

```tsx
// frontend/app/element/keycap.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one keyboard-shortcut chip. `chord` is binding notation ("Ctrl:p", "g p", "Cmd:Enter");
// glyphs come from the platform-aware keysym formatter. "chips" = one bordered box per key;
// "inline" = a single terse box (for dense footers / menu shortcut columns).

import { formatChord } from "@/util/keysym";
import { cn } from "@/util/util";

const BOX = "rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px]";

export function KeyCap({
    chord,
    variant = "chips",
    className,
}: {
    chord: string;
    variant?: "chips" | "inline";
    className?: string;
}) {
    const parts = formatChord(chord);
    if (variant === "inline") {
        return <span className={cn(BOX, "text-muted", className)}>{parts.join("")}</span>;
    }
    return (
        <span className={cn("inline-flex items-center gap-1", className)}>
            {parts.map((p, i) => (
                <span key={i} className={cn(BOX, "text-primary")}>
                    {p}
                </span>
            ))}
        </span>
    );
}
```

- [ ] **Step 2: Typecheck checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 3: `ContextMenuItem` fields + `hasLeadingColumn` helper

**Files:**
- Modify: `frontend/types/custom.d.ts` (the `ContextMenuItem` type, ~line 153)
- Modify: `frontend/app/store/contextmenu.ts`
- Test: `frontend/app/store/contextmenu.test.ts`

**Interfaces:**
- Produces: `hasLeadingColumn(items: ContextMenuItem[]): boolean`; new optional fields `icon?: React.ReactNode` and `accel?: string` on `ContextMenuItem`.

- [ ] **Step 1: Add the fields to `ContextMenuItem`**

In `frontend/types/custom.d.ts`, inside `type ContextMenuItem = { … }` (after the existing `danger?: boolean;` line):

```ts
        icon?: React.ReactNode; // leading icon (renderer shows it in the leading column)
        accel?: string; // shortcut in binding notation ("Cmd:t"); rendered as a right-aligned KeyCap
```

(React types are ambient in this repo — `custom.d.ts` already uses global DOM/React types, so no import is needed.)

- [ ] **Step 2: Write the failing test**

Append to `frontend/app/store/contextmenu.test.ts`:

```ts
import { hasLeadingColumn } from "./contextmenu";

describe("hasLeadingColumn", () => {
    it("is false for a plain action-only menu", () => {
        expect(hasLeadingColumn([{ label: "Copy" }, { label: "Paste" }])).toBe(false);
    });
    it("is true when any item has an icon", () => {
        expect(hasLeadingColumn([{ label: "Copy", icon: null as any }, { label: "X", icon: "i" as any }])).toBe(true);
    });
    it("is true when a checkbox or radio is present", () => {
        expect(hasLeadingColumn([{ label: "A" }, { type: "checkbox", label: "Live", checked: true }])).toBe(true);
        expect(hasLeadingColumn([{ type: "radio", label: "Opus", checked: true }])).toBe(true);
    });
    it("ignores separators and headers, and hidden items", () => {
        expect(hasLeadingColumn([{ type: "separator" }, { type: "header", label: "H" }, { label: "A" }])).toBe(false);
        expect(hasLeadingColumn([{ type: "checkbox", label: "hid", visible: false }, { label: "A" }])).toBe(false);
    });
});
```

Note: the `icon: "i" as any` / `icon: null as any` casts sidestep `React.ReactNode` in a `.ts` test — the helper only checks `!= null`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: FAIL — `hasLeadingColumn` is not exported.

- [ ] **Step 4: Implement the helper**

In `frontend/app/store/contextmenu.ts`, after the existing `visibleItems` function:

```ts
// True when the menu needs a fixed leading column: any visible item carries an icon, or is a
// checkbox/radio (whose checked-state marker lives in that column). Plain menus stay flush.
export function hasLeadingColumn(items: ContextMenuItem[]): boolean {
    return visibleItems(items).some((it) => it.type === "checkbox" || it.type === "radio" || it.icon != null);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: PASS (existing tests + 4 new).

- [ ] **Step 6: Typecheck checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 4: Context-menu renderer rework

**Files:**
- Modify: `frontend/app/element/contextmenu.tsx` (full rewrite of the presentation; logic imports unchanged)

**Interfaces:**
- Consumes: `hasLeadingColumn` (Task 3), `KeyCap` (Task 2), `Check`/`ChevronRight` from `lucide-react`; all existing exports from `@/app/store/contextmenu` and `@floating-ui/react` as today.
- Produces: no new exports (same `ContextMenu` component).

> Visual task — no unit test (no render harness). Verified over CDP in this task.

- [ ] **Step 1: Rewrite the presentation constants + `Marker`→leading column + row tail**

Replace the top constants and the `Marker`/`MenuLevel`/`MenuRow` presentation in `frontend/app/element/contextmenu.tsx` with the following. Keep `runClick`, `ContextMenu`, keyboard handlers, and all imports from `@/app/store/contextmenu` exactly as they are; add the three new imports.

```tsx
import { Check, ChevronRight } from "lucide-react";
import { KeyCap } from "./keycap";
import { hasLeadingColumn } from "@/app/store/contextmenu";
```

New constants (replace the existing `PANEL`/`ITEM`/`ITEM_ACTIVE`/… block):

```tsx
const PANEL = "z-[1000] min-w-[200px] rounded-[8px] border border-edge-mid bg-surface-raised p-1 shadow-lg";
const ITEM =
    "relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 font-mono text-[12.5px] text-secondary";
const ITEM_ACTIVE = "bg-accent/12 text-primary";
const ITEM_DANGER = "text-error";
const ITEM_DANGER_ACTIVE = "bg-error/10 text-error";
const ITEM_DISABLED = "cursor-default opacity-50";
const LEAD = "flex w-[16px] shrink-0 items-center justify-center";
```

Replace `Marker` with a leading-column renderer:

```tsx
// The leading column: icon for normal rows; a check for a ticked checkbox; a dot for radio-on.
// Rendered only when the menu reserves the column (hasLeadingColumn).
function Leading({ item, highlighted, danger }: { item: ContextMenuItem; highlighted: boolean; danger: boolean }) {
    let content: React.ReactNode = null;
    if (item.type === "checkbox") {
        content = item.checked ? <Check size={13} className="text-accent" /> : null;
    } else if (item.type === "radio") {
        content = item.checked ? <span className="h-[6px] w-[6px] rounded-full bg-accent" /> : null;
    } else if (item.icon != null) {
        content = item.icon;
    }
    const color = danger ? "text-error" : highlighted ? "text-accent-soft" : "text-muted";
    return <span className={cn(LEAD, "[&_svg]:h-[15px] [&_svg]:w-[15px]", color)}>{content}</span>;
}
```

- [ ] **Step 2: Update `MenuLevel` to compute the leading column and inset separators/headers**

`MenuLevel` computes `hasLead` once and passes it to each row; separators/headers get inset spacing:

```tsx
function MenuLevel({ items, basePath, active, setActive }: {
    items: ContextMenuItem[]; basePath: MenuPath; active: MenuPath; setActive: (p: MenuPath) => void;
}) {
    const level = basePath.length;
    const vis = visibleItems(items);
    const hasLead = hasLeadingColumn(items);
    return (
        <>
            {vis.map((item, i) => {
                if (item.type === "separator") {
                    return <div key={i} className="mx-2 my-1.5 h-px bg-edge-mid" />;
                }
                if (item.type === "header") {
                    return (
                        <div key={i} className="px-2.5 pb-1 pt-2 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-muted">
                            {item.label}
                        </div>
                    );
                }
                const rowPath = [...basePath, i];
                const onPath = active[level] === i;
                const submenuOpen = onPath && item.submenu != null && active.length > level + 1;
                return (
                    <MenuRow
                        key={i}
                        item={item}
                        rowPath={rowPath}
                        highlighted={onPath}
                        submenuOpen={submenuOpen}
                        disabled={item.enabled === false}
                        danger={item.danger === true}
                        hasLead={hasLead}
                        active={active}
                        setActive={setActive}
                    />
                );
            })}
        </>
    );
}
```

- [ ] **Step 3: Update `MenuRow` to render leading column, label, and the accel/chevron tail**

Keep the existing `onEnter`/`flipLeft`/`ref` logic. Change the returned JSX body to:

```tsx
    const activeCls = danger ? ITEM_DANGER_ACTIVE : ITEM_ACTIVE;
    return (
        <div
            ref={ref}
            className={cn(ITEM, danger && !highlighted && ITEM_DANGER, highlighted && activeCls, disabled && ITEM_DISABLED)}
            onMouseEnter={onEnter}
            onClick={() => (hasSub ? undefined : runClick(item))}
        >
            {hasLead ? <Leading item={item} highlighted={highlighted} danger={danger} /> : null}
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            {hasSub ? (
                <ChevronRight size={13} className="ml-auto text-muted" />
            ) : item.accel ? (
                <KeyCap chord={item.accel} variant="inline" className="ml-auto" />
            ) : item.sublabel ? (
                <span className="ml-auto text-muted">{item.sublabel}</span>
            ) : null}
            {submenuOpen ? (
                <div className={cn(PANEL, "absolute top-[-5px]", flipLeft ? "right-full mr-1" : "left-full ml-1")}>
                    <MenuLevel items={item.submenu!} basePath={rowPath} active={active} setActive={setActive} />
                </div>
            ) : null}
        </div>
    );
```

Add `hasLead: boolean` to `MenuRow`'s props type and destructuring.

- [ ] **Step 4: Typecheck + existing menu tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx vitest run frontend/app/store/contextmenu.test.ts`
Expected: PASS (keyboard-nav tests still green).

- [ ] **Step 5: CDP visual verification**

With the dev app running (`task dev`), inject the representative menu and screenshot:

```bash
node scripts/cdp-shot.mjs cdp-shots/ctxmenu-task4.png
```
Then inject a menu with icon/checkbox/radio/accel/danger items (reuse the inject pattern in `scripts/inject-live-agents.mjs` header, or a one-off Runtime.evaluate importing `/@fs/…/frontend/app/store/contextmenu.ts` and calling `ContextMenuModel.getInstance().showContextMenu(...)`), then screenshot.
Expected: leading icon column aligned; `Check` for the checked box; dot for radio-on; `ChevronRight` on submenu rows; highlight rounded and inset (not touching the panel corners); danger rows red. Compare against `cdp-shots/ctxmenu-current.png` (the pre-change baseline).

---

### Task 5: Populate icons — agent & channel menus

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (menu ~line 275)
- Modify: `frontend/app/view/agents/agentheader.tsx` (menu ~line 68)
- Modify: `frontend/app/view/agents/agenttree.tsx` (menu ~line 57)
- Modify: `frontend/app/view/agents/channelrail.tsx` (menu ~line 112)
- Modify: `frontend/app/view/agents/channelsprimitives.tsx` (menu ~line 136)

**Icon mapping (verb → lucide):**

| Label | Icon |
|---|---|
| Open / Open agent | `PanelRight` |
| Open terminal | `SquareTerminal` |
| Review changes | `GitCompare` |
| Move to background | `Minimize2` |
| Copy name | `Copy` |
| Close agent | `X` |
| Interrupt turn | `CircleStop` |
| Duplicate | `CopyPlus` |
| Autonomy (submenu) | `Bot` |
| Rename channel | `Pencil` |
| Archive channel | `Archive` |
| Delete channel | `Trash2` |
| Dismiss | `X` |

- [ ] **Step 1: Add icons in `agentrow.tsx`**

Add to the lucide import at top: `import { Scaling, PanelRight, SquareTerminal, GitCompare, Minimize2, Copy, X } from "lucide-react";` (merge with the existing `Scaling` import). Add `icon:` to each menu item:

```tsx
{ label: "Open", icon: <PanelRight size={15} />, click: () => … },
{ label: "Open terminal", icon: <SquareTerminal size={15} />, click: () => … },
{ label: "Review changes", icon: <GitCompare size={15} />, click: () => … },
{ label: "Move to background", icon: <Minimize2 size={15} />, click: () => … },
{ label: "Copy name", icon: <Copy size={15} />, click: () => … },
{ label: "Close agent", icon: <X size={15} />, danger: true, click: () => … },
```

(Preserve every existing field — `click`, `danger`, `type`, `visible`, ordering. Only add `icon`.)

- [ ] **Step 2: Add icons in `agentheader.tsx`**

Merge into the lucide import (`Maximize2, Minimize2, Square, X` already imported): add `CircleStop`. Then:

```tsx
{ label: "Interrupt turn", icon: <CircleStop size={15} />, … },
{ label: "Close agent", icon: <X size={15} />, danger: true, … },
```

- [ ] **Step 3: Add icons in `agenttree.tsx`**

Add import: `import { CopyPlus, Copy, X } from "lucide-react";` Then:

```tsx
{ label: "Duplicate", icon: <CopyPlus size={15} />, … },
{ label: "Copy name", icon: <Copy size={15} />, … },
{ label: "Close agent", icon: <X size={15} />, danger: true, … },
```

- [ ] **Step 4: Add icons in `channelrail.tsx`**

Add import: `import { PanelRight, Bot, Pencil, Archive, Trash2 } from "lucide-react";` Then:

```tsx
{ label: "Open", icon: <PanelRight size={15} />, … },
{ label: "Autonomy", icon: <Bot size={15} />, submenu: [ … ] },   // submenu radios keep state markers, no per-item icon
{ label: "Rename channel", icon: <Pencil size={15} />, … },
{ label: "Archive channel", icon: <Archive size={15} />, … },
{ label: "Delete channel", icon: <Trash2 size={15} />, danger: true, … },
```

- [ ] **Step 5: Add icons in `channelsprimitives.tsx`**

Add import: `import { PanelRight, X } from "lucide-react";` Then:

```tsx
{ label: "Open agent", icon: <PanelRight size={15} />, … },
{ label: "Dismiss", icon: <X size={15} />, … },
```

- [ ] **Step 6: Typecheck checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 6: Populate icons — files, memory, narration menus

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx` (menu ~line 450)
- Modify: `frontend/app/view/agents/memorysurface.tsx` (menus ~line 168 and ~430)
- Modify: `frontend/app/view/agents/narrationtimeline.tsx` (menu ~line 452)

**Icon mapping:**

| Label | Icon |
|---|---|
| Open in editor | `Pencil` |
| Copy path / Copy absolute path / Copy title | `Copy` |
| Open | `FolderOpen` |
| Delete | `Trash2` |
| Copy text / Copy conversation | `Copy` |

- [ ] **Step 1: Add icons in `filessurface.tsx`**

Add import: `import { Pencil, Copy } from "lucide-react";` Then:

```tsx
{ label: "Open in editor", icon: <Pencil size={15} />, … },
{ label: "Copy path", icon: <Copy size={15} />, … },
{ label: "Copy absolute path", icon: <Copy size={15} />, … },
```

- [ ] **Step 2: Add icons in `memorysurface.tsx`**

`Check` is already imported; add `FolderOpen, Copy, Trash2`. The list menu (~line 168):

```tsx
{ label: "Open", icon: <FolderOpen size={15} />, … },
{ label: "Copy title", icon: <Copy size={15} />, … },
{ label: "Copy path", icon: <Copy size={15} />, … },
{ label: "Delete", icon: <Trash2 size={15} />, danger: true, … },
```

For the detail menu (~line 430, label "Memory detail") — leave as-is unless it has actionable rows; if it only holds a header/label, no icon needed.

- [ ] **Step 3: Add icons in `narrationtimeline.tsx`**

Add import: `import { Copy } from "lucide-react";` Then:

```tsx
{ label: "Copy text", icon: <Copy size={15} />, … },
{ label: "Copy conversation", icon: <Copy size={15} />, … },
```

- [ ] **Step 4: Typecheck checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 7: Populate icons — terminal menu

**Files:**
- Modify: `frontend/app/view/term/term-model.ts` (menu built ~lines 815–1270)

**Rule:** add `icon` to action rows and submenu-parent rows only. The many radio/checkbox leaf options (`Default`, `Block`, `Bar`, `On`, `Off`, `Info`, `Verbose`, transparency toggles, cursor styles, etc.) keep their state markers — do NOT give them per-item icons.

**Icon mapping:**

| Label | Icon |
|---|---|
| Copy | `Copy` |
| Paste | `ClipboardPaste` |
| Open URL in external browser | `ExternalLink` |
| Save session as... | `Save` |
| Themes (submenu) | `Palette` |
| Font size (submenu) | `Type` |
| Cursor (submenu) | `TextCursor` |
| Transparency (submenu) | `Blend` |
| Allow bracketed paste mode (submenu) | `Clipboard` |
| Debug connection (submenu) | `Bug` |
| Force restart controller | `RotateCcw` |
| Clear output on restart (submenu) | `Eraser` |
| Run on startup (submenu) | `Power` |
| Restart session in standard mode | `RefreshCw` |
| Restart session in durable mode | `RefreshCw` |
| Advanced (submenu) | `SlidersHorizontal` |
| Close Toolbar | `X` |

- [ ] **Step 1: Import icons**

At the top of `term-model.ts`, add:

```ts
import {
    Copy, ClipboardPaste, ExternalLink, Save, Palette, Type, TextCursor, Blend,
    Clipboard, Bug, RotateCcw, Eraser, Power, RefreshCw, SlidersHorizontal, X,
} from "lucide-react";
```

Note: `term-model.ts` is a `.ts` file that builds JSX menu items. It already returns `ContextMenuItem[]` with `React.ReactNode`-compatible fields is fine, but if the file has no JSX, use `React.createElement`: e.g. `icon: React.createElement(Copy, { size: 15 })`. **Check the file's top:** if it already imports React / uses `.tsx`-style JSX, use `<Copy size={15} />`; otherwise use `React.createElement`. Prefer `React.createElement` here since `term-model.ts` is `.ts` (no JSX).

- [ ] **Step 2: Add `icon` to the action / submenu-parent items**

For each labeled item in the mapping table, add `icon: React.createElement(Icon, { size: 15 })`. Example for the `Copy` item (~line 818):

```ts
{ label: "Copy", icon: React.createElement(Copy, { size: 15 }), click: () => … },
```

Repeat for every row in the mapping table. Leave all radio/checkbox leaves and their `checked`/`type`/`click` fields untouched.

- [ ] **Step 3: Typecheck checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (If `React` is not in scope, add `import React from "react";` — match the file's existing import style.)

---

### Task 8: Migrate hardcoded `⌘` glyphs (app-bar, empty-state, new-agent modal)

**Files:**
- Modify: `frontend/app/cockpit/app-bar.tsx:67`
- Modify: `frontend/app/view/agents/cockpitemptystate.tsx:62,69`
- Modify: `frontend/app/view/agents/newagentmodal.tsx:629`

**Interfaces:** Consumes `formatChordString` from `@/util/keysym`.

- [ ] **Step 1: `app-bar.tsx`**

Add import: `import { formatChordString } from "@/util/keysym";`
Replace line 67's content `⌘P` with the computed glyph (keep the span styling):

```tsx
<span className="rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px]">
    {formatChordString("Ctrl:p")}
</span>
```

- [ ] **Step 2: `cockpitemptystate.tsx`**

Add import: `import { formatChordString } from "@/util/keysym";`
Line 62: replace `⌘N` with `{formatChordString("Ctrl:n")}`.
Line 69: replace `⌘P` with `{formatChordString("Ctrl:p")}`.
(Keep both surrounding spans' styling untouched.)

- [ ] **Step 3: `newagentmodal.tsx`**

Add import: `import { formatChordString } from "@/util/keysym";`
Line 629: replace `⌘↵` with `{formatChordString("Cmd:Enter")}` (→ `^⏎` on Windows, `⌘⏎` on macOS).

- [ ] **Step 4: Typecheck checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 9: Migrate footer hints + cockpit hints (render-time glyphs)

**Files:**
- Modify: `frontend/app/cockpit/footerhints.ts`
- Modify: `frontend/app/cockpit/hints-footer.tsx`
- Modify: `frontend/app/view/agents/cockpithelp.tsx`

**Interfaces:** Consumes `formatChordString` from `@/util/keysym`.

- [ ] **Step 1: Give `FooterHint` a `keys` field**

In `footerhints.ts`, change the interface so modifier hints carry a chord instead of a baked glyph:

```ts
export interface FooterHint {
    ids: string[];
    keys?: string; // chord in binding notation ("Ctrl:p"); glyph computed at render
    glyph?: string; // literal glyph for composite/non-modifier hints ("↑↓", "[ ]", "esc")
    label: string;
}
```

Convert the modifier entries (leave the composite/plain ones on `glyph`):

```ts
export const GLOBAL_HINTS: FooterHint[] = [
    { ids: ["go:cockpit"], glyph: "g", label: "go" },
    { ids: ["palette"], keys: "Ctrl:p", label: "palette" },
    { ids: ["new-agent"], keys: "Ctrl:n", label: "new" },
    { ids: ["help"], glyph: "?", label: "help" },
];

export const SURFACE_HINTS: Partial<Record<SurfaceKey, FooterHint[]>> = {
    agent: [
        { ids: ["agent:prev-k", "agent:next-j", "agent:prev", "agent:next"], glyph: "↑↓", label: "move" },
        { ids: ["agent:toggle-rail"], glyph: "d", label: "rail" },
        { ids: ["agent:fullscreen"], glyph: "f", label: "full" },
        { ids: ["agent:back"], glyph: "esc", label: "back" },
        { ids: ["cycle-agent-next", "cycle-agent-prev"], keys: "Ctrl:Tab", label: "cycle" },
        { ids: ["agent:return-nav"], keys: "Shift:Escape", label: "leave" },
    ],
};
```

- [ ] **Step 2: Compute the glyph at render in `hints-footer.tsx`**

Add import: `import { formatChordString } from "@/util/keysym";`
The rest-posture chip map (line ~90) must resolve `glyph ?? formatChordString(keys)`:

```tsx
{chips.map((c) => (
    <Chip key={(c.glyph ?? c.keys) + c.label} glyph={c.glyph ?? formatChordString(c.keys!)} label={c.label} />
))}
```

Check `footer-visible.ts` / `visibleHints` typing still returns `FooterHint[]` (now with optional `glyph`/`keys`) — no logic change needed, only the render resolves the display string. If `footer-visible.ts` reads `.glyph` anywhere for filtering, it does not (it filters by `ids`), so no change there.

- [ ] **Step 3: Compute cockpit `HINTS` modifier glyphs at render in `cockpithelp.tsx`**

Add import: `import { formatChordString } from "@/util/keysym";`
Move the `HINTS` array **inside** `HintsBar` (so `formatChordString` runs at render, after boot sets platform), and use the formatter for the two modifier rows:

```tsx
export function HintsBar({ onOpenHelp }: { onOpenHelp: () => void }) {
    const HINTS: [string, string][] = [
        ["↑↓ / j k", "move"],
        ["⏎", "open"],
        ["esc", "back"],
        ["1–9", "answer"],
        ["r", "reply"],
        ["t", "terminal"],
        ["b", "background"],
        ["n", "next ask"],
        ["[ ]", "switch surface"],
        ["g", "go"],
        [formatChordString("Ctrl:p"), "palette"],
        [formatChordString("Ctrl:n"), "new"],
    ];
    return ( /* unchanged JSX using HINTS */ );
}
```

Delete the old module-level `HINTS` const.

- [ ] **Step 4: Typecheck + footer test**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx vitest run frontend/app/cockpit/footerhints.test.ts` (if present) and `frontend/app/cockpit/footer-visible.test.ts`
Expected: PASS. (These assert binding-id existence, unaffected by the glyph change; fix any type mismatch if a test constructs a `FooterHint` with a now-removed required `glyph`.)

---

### Task 10: Migrate the shortcuts cheat sheet

**Files:**
- Modify: `frontend/app/cockpit/shortcuts-cheatsheet.tsx`

**Interfaces:** Consumes `formatChord` from `@/util/keysym`.

- [ ] **Step 1: Delegate `keyChips` to `formatChord`**

Add import: `import { formatChord } from "@/util/keysym";`
Replace the local `keyChips` (lines 17–21):

```tsx
function keyChips(keys: string) {
    return formatChord(keys); // "Ctrl:Shift:Tab" -> ["^","⇧","Tab"]; "g p" -> ["g","p"]
}
```

The existing chip render (lines 70–79) already maps `keyChips(b.keys)` to styled spans — it now shows platform glyphs (`^` on Windows) instead of the raw word `Ctrl`. No further change.

- [ ] **Step 2: Typecheck checkpoint**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

> **Deviation from spec (flagged):** `command-palette.tsx`'s `⏎` markers are left as-is. `⏎` (Enter) is platform-invariant and is not an OS-modifier glyph — migrating it would add churn without fixing the cross-platform bug. Noted for the user; revisit only if a unified Enter glyph is later desired.

---

### Task 11: Full verification + single feature commit

**Files:** none (verification + commit).

- [ ] **Step 1: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all green (baseline + `keysym.test.ts` + new `hasLeadingColumn` tests). Note the known pre-existing failure `pkg/tsgen` is Go, not vitest — vitest should be fully green.

- [ ] **Step 3: CDP before/after of the context menu**

With `task dev` running, inject the representative menu (icons + checkbox + radio + accel + danger) and capture:

```bash
node scripts/cdp-shot.mjs cdp-shots/ctxmenu-final.png
```
Compare to `cdp-shots/ctxmenu-current.png` (baseline). Confirm: leading icons aligned, real `Check`/`ChevronRight`, inset rounded highlight, Comfortable spacing, danger rows red, and (if an `accel` was injected) a right-aligned keycap.

- [ ] **Step 4: CDP spot-check a migrated surface**

Screenshot the app bar / empty state; confirm the search chip shows `^P` (not `⌘P`) on this Windows dev build.

```bash
node scripts/cdp-shot.mjs cdp-shots/appbar-final.png
```

- [ ] **Step 5: Self-review the diff**

Run: `git status && git --no-pager diff --stat`
Review: no stray debug/commented code; only intended files touched; spec + plan docs present.

- [ ] **Step 6: Commit (ONLY after explicit user approval)**

Per Global Constraints, ask the user to approve the commit first. On approval, on a feature branch (create one if on `main`):

```bash
git add -A
git commit -F <message-file>
```
Message (folds the spec + plan into the feature commit, no separate docs commit; no co-author):

```
feat(contextmenu): polish menu UI + centralize OS-modifier glyphs

Leading lucide icons + real Check/ChevronRight glyphs, inset rounded
highlight, Comfortable spacing, and a KeyCap shortcut column in the
shared context menu. New keysym util is the single source of truth for
modifier glyphs (^ on Windows/Linux, ⌘ on macOS); folds app-bar,
cockpit empty-state, new-agent modal, footer hints, cockpit hints, and
the shortcuts cheat sheet onto it. Icons populated across all menu call
sites. Display-only; no key-dispatch or menu-behavior changes.
```

---

## Self-Review

**Spec coverage:**
- Unit 1 (keysym) → Task 1. ✓
- Unit 2 (KeyCap) → Task 2. ✓
- Unit 3 (renderer + `icon?`/`accel?` + `hasLeadingColumn`) → Tasks 3–4. ✓
- Unit 4 (icon population, all 10 call sites) → Tasks 5–7 (agent/channel; files/memory/narration; terminal). ✓
- Unit 5 (migrate render sites) → Tasks 8–10 (app-bar/empty-state/modal; footer/cockpit hints; cheat sheet). `quicktips` skipped (dead). `command-palette` Enter left (flagged deviation). ✓
- Convention decision + render-time-glyph footgun → Global Constraints. ✓
- Testing (keysym mac/win, hasLeadingColumn, existing menu nav) → Tasks 1, 3, 4, 9, 11. ✓
- CDP verification → Tasks 4, 11. ✓

**Placeholder scan:** No TBD/TODO. All code steps show real code; icon assignments enumerated in mapping tables; migration edits reference exact lines. `term-model.ts` step notes the `.ts` vs JSX `React.createElement` choice explicitly.

**Type consistency:** `hasLeadingColumn(items)` (Task 3) used identically in Task 4. `formatChord`/`formatChordString`/`modSymbol` signatures identical across Tasks 1, 2, 8, 9, 10. `KeyCap({chord, variant, className})` defined in Task 2, consumed in Task 4 with `variant="inline"`. `FooterHint` `keys?`/`glyph?` change (Task 9 Step 1) matched by the render resolve (Task 9 Step 2). `icon?: React.ReactNode` / `accel?: string` added in Task 3, consumed in Tasks 4–7.
