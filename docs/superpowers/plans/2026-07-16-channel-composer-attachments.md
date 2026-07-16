# Channel composer attachments (paste / attach / drag-drop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Channels composer accept images/files via paste, a paperclip picker, and drag-drop, persist them to disk with the existing `WriteTempFileCommand`, and deliver their absolute paths to the spawned/live `claude` worker on both composer faces (Launch and Talk).

**Architecture:** A pure helpers + React hook module (`composerattachments.ts`) owns capture → persist → state; a presentational tray module (`attachmenttray.tsx`) renders chips + the paperclip button; `composer-shell.tsx` gains **opt-in** drop/paste/tray props so its three existing callers are unchanged; the two channel composer faces forward those props; `channelssurface.tsx` owns the hook and injects a trailing "read these files" block into the finalized text at each send branch. No backend change.

**Tech Stack:** React 19 + jotai + Tailwind 4, `lucide-react` icons, `base64-js`, the existing `RpcApi.WriteTempFileCommand` wshrpc client, vitest, CDP against the live Tauri dev app.

**Source spec:** `docs/superpowers/specs/2026-07-16-channel-composer-attachments-design.md`

## Global Constraints

- **No backend / no codegen.** Reuse `RpcApi.WriteTempFileCommand` (already in `frontend/app/store/wshclientapi.ts`). Do **not** run `task generate`.
- **No hardcoded colors.** Use `@theme` utility classes only — `border-edge-mid`, `border-edge-strong`, `bg-surface-raised`, `bg-background`, `text-primary`, `text-secondary`, `text-muted`, `text-ink-mid`, `accent`/`accent-soft`, `text-error`/`border-error`/`bg-error`. Never raw hex/rgba.
- **No emojis** in code or UI copy unless already present in surrounding code.
- **Tailwind, not SCSS.** No new `.scss`.
- **Channels-only.** Do not touch `ComposerShell`'s other callers (Runs new-run panel, inline steer). New `ComposerShell` props are all optional so those callers compile and render byte-for-byte unchanged.
- **Local scope only.** Temp path lives on the wavesrv (local) host; remote/WSL is a documented deferral, not built.
- **Size cap:** `MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024` (10 MB). At the cap is allowed; strictly over is rejected with an `error` chip and no RPC.
- **Persist mechanism:** `file.arrayBuffer()` → `base64.fromByteArray(new Uint8Array(buf))` → `WriteTempFileCommand({ filename: file.name, data64 })`. This reuses the proven pattern in `frontend/app/view/term/termutil.ts:98-113` (the spec's FileReader/data-URL variant is equivalent; we use the codebase's existing idiom).
- **Git:** Per the repo owner's workflow — **no commits until the end**, then a **single batched commit** on explicit approval. The spec doc folds into that feature commit (never a separate docs commit). Each task below ends with a verification gate, not a commit.
- **Typecheck command (tsc overflows on bare `npx tsc`):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline is clean (exit 0); any error it reports is yours.

---

### Task 1: Pure helpers + unit tests (`composerattachments.ts` pure exports)

**Files:**
- Create: `frontend/app/view/agents/composerattachments.ts` (pure exports only in this task — the hook is added in Task 2)
- Test: `frontend/app/view/agents/composerattachments.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2, 3, 5, 6):
  - `MAX_ATTACHMENT_BYTES: number`
  - `type AttachmentKind = "image" | "file"`
  - `type AttachmentStatus = "uploading" | "ready" | "error"`
  - `interface Attachment { id: string; name: string; kind: AttachmentKind; status: AttachmentStatus; size: number; path?: string; previewUrl?: string }`
  - `classifyKind(file: { name: string; type: string }): AttachmentKind`
  - `isOversize(size: number): boolean`
  - `appendAttachments(text: string, atts: Attachment[]): string`

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/composerattachments.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { appendAttachments, classifyKind, isOversize, MAX_ATTACHMENT_BYTES, type Attachment } from "./composerattachments";

function att(over: Partial<Attachment>): Attachment {
    return { id: "1", name: "f", kind: "file", status: "ready", size: 1, path: "/tmp/f", ...over };
}

describe("appendAttachments", () => {
    it("returns text unchanged when there are no attachments", () => {
        expect(appendAttachments("hello", [])).toBe("hello");
    });
    it("skips non-ready attachments", () => {
        const atts = [att({ status: "uploading", path: undefined }), att({ id: "2", status: "error", path: undefined })];
        expect(appendAttachments("hello", atts)).toBe("hello");
    });
    it("appends a trailing block listing ready attachment paths", () => {
        const atts = [att({ path: "C:\\a\\shot.png" }), att({ id: "2", path: "C:\\a\\err.log" })];
        expect(appendAttachments("fix it", atts)).toBe(
            "fix it\n\nAttachments (read these files):\n- C:\\a\\shot.png\n- C:\\a\\err.log"
        );
    });
    it("preserves a leading @-command token", () => {
        const out = appendAttachments("@run fix it", [att({ path: "C:\\a\\shot.png" })]);
        expect(out.startsWith("@run fix it")).toBe(true);
        expect(out).toContain("- C:\\a\\shot.png");
    });
    it("returns just the block when the base text is blank", () => {
        expect(appendAttachments("   ", [att({ path: "C:\\a\\x.png" })])).toBe(
            "Attachments (read these files):\n- C:\\a\\x.png"
        );
    });
});

describe("classifyKind", () => {
    it("classifies by image mime type", () => {
        expect(classifyKind({ name: "x", type: "image/png" })).toBe("image");
    });
    it("classifies by extension when mime is empty", () => {
        expect(classifyKind({ name: "shot.JPG", type: "" })).toBe("image");
    });
    it("classifies non-images as file", () => {
        expect(classifyKind({ name: "error.log", type: "text/plain" })).toBe("file");
    });
});

describe("isOversize", () => {
    it("allows a file exactly at the cap", () => {
        expect(isOversize(MAX_ATTACHMENT_BYTES)).toBe(false);
    });
    it("rejects a file one byte over the cap", () => {
        expect(isOversize(MAX_ATTACHMENT_BYTES + 1)).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/composerattachments.test.ts`
Expected: FAIL — cannot resolve `./composerattachments` (module not created yet).

- [ ] **Step 3: Create the pure module**

Create `frontend/app/view/agents/composerattachments.ts` (pure exports only — the hook lands in Task 2):

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels composer attachments: capture (paste / paperclip / drag-drop) -> persist to a wavesrv temp
// file via WriteTempFileCommand -> reference-by-path in the sent text. Pure helpers below are unit-tested
// (composerattachments.test.ts); the useComposerAttachments hook (impure: RPC + FileReader + object URLs)
// is verified over CDP against the live dev app, per CLAUDE.md's testing convention.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB; base64 inflates ~33%, bounding the RPC payload

export type AttachmentKind = "image" | "file";
export type AttachmentStatus = "uploading" | "ready" | "error";

export interface Attachment {
    id: string;
    name: string;
    kind: AttachmentKind;
    status: AttachmentStatus;
    size: number;
    path?: string; // absolute temp path once uploaded
    previewUrl?: string; // object URL for image thumbnails
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"]);

// image when the mime says so, else fall back to the extension (dragged/pasted files often have empty type).
export function classifyKind(file: { name: string; type: string }): AttachmentKind {
    if (file.type.startsWith("image/")) {
        return "image";
    }
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return IMAGE_EXTS.has(ext) ? "image" : "file";
}

// at the cap is allowed; strictly over is rejected before any RPC.
export function isOversize(size: number): boolean {
    return size > MAX_ATTACHMENT_BYTES;
}

// Appends a trailing "read these files" block listing every ready attachment's absolute path. Returns
// `text` unchanged when nothing is ready; when the base text is blank, returns just the block.
export function appendAttachments(text: string, atts: Attachment[]): string {
    const ready = atts.filter((a) => a.status === "ready" && a.path);
    if (ready.length === 0) {
        return text;
    }
    const block = "Attachments (read these files):\n" + ready.map((a) => `- ${a.path}`).join("\n");
    return text.trim() ? `${text}\n\n${block}` : block;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/composerattachments.test.ts`
Expected: PASS — all 10 assertions green.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 2: The capture/persist hook (`useComposerAttachments`)

**Files:**
- Modify: `frontend/app/view/agents/composerattachments.ts` (append the hook + its return type)

**Interfaces:**
- Consumes: `Attachment`, `classifyKind`, `isOversize` (Task 1); `RpcApi` (`@/app/store/wshclientapi`), `TabRpcClient` (`@/app/store/wshrpcutil`), `fireAndForget` (`@/util/util`), `base64` (`base64-js`).
- Produces (consumed by Tasks 5, 6):
  - `interface UseComposerAttachments { attachments: Attachment[]; add: (files: FileList | File[]) => void; remove: (id: string) => void; retry: (id: string) => void; clear: () => void; uploading: boolean; readyCount: number; isDragging: boolean; dnd: { onPaste: React.ClipboardEventHandler; onDragOver: React.DragEventHandler; onDragLeave: React.DragEventHandler; onDrop: React.DragEventHandler } }`
  - `function useComposerAttachments(): UseComposerAttachments`

- [ ] **Step 1: Add imports at the top of `composerattachments.ts`**

Add below the header comment, above `export const MAX_ATTACHMENT_BYTES`:

```ts
import base64 from "base64-js";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
```

- [ ] **Step 2: Append the hook to the end of `composerattachments.ts`**

```ts
export interface UseComposerAttachments {
    attachments: Attachment[];
    add: (files: FileList | File[]) => void;
    remove: (id: string) => void;
    retry: (id: string) => void;
    clear: () => void;
    uploading: boolean;
    readyCount: number;
    isDragging: boolean;
    dnd: {
        onPaste: (e: ClipboardEvent) => void;
        onDragOver: (e: DragEvent) => void;
        onDragLeave: (e: DragEvent) => void;
        onDrop: (e: DragEvent) => void;
    };
}

// Owns attachment state + the three capture sources. Lives in channelssurface (both faces share `draft`
// and the single send handler), passed down to the presentational composers.
export function useComposerAttachments(): UseComposerAttachments {
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const filesRef = useRef<Map<string, File>>(new Map()); // retained for retry(); not part of the serializable chip
    const previewsRef = useRef<Set<string>>(new Set()); // outstanding object URLs to revoke

    const update = useCallback((id: string, patch: Partial<Attachment>) => {
        setAttachments((cur) => cur.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    }, []);

    const persist = useCallback(
        async (id: string, file: File) => {
            try {
                const buf = await file.arrayBuffer();
                const data64 = base64.fromByteArray(new Uint8Array(buf));
                const path = await RpcApi.WriteTempFileCommand(TabRpcClient, { filename: file.name, data64 });
                update(id, { status: "ready", path });
            } catch {
                update(id, { status: "error" });
            }
        },
        [update]
    );

    const add = useCallback(
        (files: FileList | File[]) => {
            for (const file of Array.from(files)) {
                const id = crypto.randomUUID();
                const kind = classifyKind(file);
                if (isOversize(file.size)) {
                    setAttachments((cur) => [...cur, { id, name: file.name, kind, status: "error", size: file.size }]);
                    continue; // rejected before any RPC
                }
                const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
                if (previewUrl) {
                    previewsRef.current.add(previewUrl);
                }
                filesRef.current.set(id, file);
                setAttachments((cur) => [
                    ...cur,
                    { id, name: file.name, kind, status: "uploading", size: file.size, previewUrl },
                ]);
                fireAndForget(() => persist(id, file));
            }
        },
        [persist]
    );

    const remove = useCallback((id: string) => {
        setAttachments((cur) => {
            const target = cur.find((a) => a.id === id);
            if (target?.previewUrl) {
                URL.revokeObjectURL(target.previewUrl);
                previewsRef.current.delete(target.previewUrl);
            }
            return cur.filter((a) => a.id !== id);
        });
        filesRef.current.delete(id);
    }, []);

    const retry = useCallback(
        (id: string) => {
            const file = filesRef.current.get(id);
            if (!file) {
                return;
            }
            update(id, { status: "uploading" });
            fireAndForget(() => persist(id, file));
        },
        [persist, update]
    );

    const clear = useCallback(() => {
        for (const url of previewsRef.current) {
            URL.revokeObjectURL(url);
        }
        previewsRef.current.clear();
        filesRef.current.clear();
        setAttachments([]);
    }, []);

    // revoke any outstanding object URLs on unmount
    useEffect(
        () => () => {
            for (const url of previewsRef.current) {
                URL.revokeObjectURL(url);
            }
            previewsRef.current.clear();
        },
        []
    );

    const dnd = {
        // only intercept when the clipboard carries files; plain text paste is left untouched.
        onPaste: (e: ClipboardEvent) => {
            const files = filesFromClipboard(e);
            if (files.length > 0) {
                e.preventDefault();
                add(files);
            }
        },
        onDragOver: (e: DragEvent) => {
            e.preventDefault();
            setIsDragging(true);
        },
        // ignore dragleave onto a descendant (prevents overlay flicker while dragging over the tray/input)
        onDragLeave: (e: DragEvent) => {
            if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) {
                setIsDragging(false);
            }
        },
        onDrop: (e: DragEvent) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files.length > 0) {
                add(e.dataTransfer.files);
            }
        },
    };

    return {
        attachments,
        add,
        remove,
        retry,
        clear,
        uploading: attachments.some((a) => a.status === "uploading"),
        readyCount: attachments.filter((a) => a.status === "ready").length,
        isDragging,
        dnd,
    };
}

function filesFromClipboard(e: ClipboardEvent): File[] {
    const cd = e.clipboardData;
    if (!cd) {
        return [];
    }
    if (cd.files && cd.files.length > 0) {
        return Array.from(cd.files);
    }
    // fallback: some sources expose files only via items
    return Array.from(cd.items ?? [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => f != null);
}
```

- [ ] **Step 3: Re-run the pure tests (guard against a regression in Task 1's exports)**

Run: `npx vitest run frontend/app/view/agents/composerattachments.test.ts`
Expected: PASS — still 10 green (adding the hook must not change pure behavior).

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

---

### Task 3: The chip tray + paperclip button (`attachmenttray.tsx`)

**Files:**
- Create: `frontend/app/view/agents/attachmenttray.tsx`

**Interfaces:**
- Consumes: `Attachment` (Task 1); `lucide-react` (`File`, `Loader2`, `Paperclip`, `RotateCw`, `X`).
- Produces (consumed by Task 5):
  - `function AttachmentTray(props: { items: Attachment[]; onRemove: (id: string) => void; onRetry: (id: string) => void }): JSX.Element | null`
  - `function AttachButton(props: { onFiles: (files: FileList) => void }): JSX.Element`

- [ ] **Step 1: Create the tray module**

Create `frontend/app/view/agents/attachmenttray.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Presentational pieces for the Channels composer attachments: the chip tray (image thumbnails / file
// icons with per-chip remove + retry) and the paperclip attach button (a hidden multi <input type=file>).
// State + behavior live in useComposerAttachments (composerattachments.ts); these are pure props-in views.

import { File as FileIcon, Loader2, Paperclip, RotateCw, X } from "lucide-react";
import { type Attachment } from "./composerattachments";

function fmtSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Chip({
    att,
    onRemove,
    onRetry,
}: {
    att: Attachment;
    onRemove: (id: string) => void;
    onRetry: (id: string) => void;
}) {
    const isError = att.status === "error";
    const isUploading = att.status === "uploading";
    const shell =
        "flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-[11px] " +
        (isError ? "border-error/40 bg-error/10 text-error" : "border-edge-mid bg-background text-secondary") +
        (isUploading ? " opacity-70" : "");
    return (
        <span className={shell}>
            {att.kind === "image" && att.previewUrl ? (
                <img src={att.previewUrl} alt="" className="h-7 w-7 rounded object-cover" />
            ) : (
                <FileIcon size={13} className="shrink-0 text-muted" />
            )}
            <span className="max-w-[120px] truncate font-mono">{att.name}</span>
            {att.kind !== "image" ? <span className="text-muted">{fmtSize(att.size)}</span> : null}
            {isUploading ? <Loader2 size={12} className="shrink-0 animate-spin text-muted" /> : null}
            {isError ? (
                <button
                    type="button"
                    title="Retry"
                    onClick={() => onRetry(att.id)}
                    className="shrink-0 cursor-pointer text-error hover:opacity-80"
                >
                    <RotateCw size={12} />
                </button>
            ) : null}
            <button
                type="button"
                title="Remove"
                onClick={() => onRemove(att.id)}
                className="shrink-0 cursor-pointer text-muted hover:text-error"
            >
                <X size={12} />
            </button>
        </span>
    );
}

export function AttachmentTray({
    items,
    onRemove,
    onRetry,
}: {
    items: Attachment[];
    onRemove: (id: string) => void;
    onRetry: (id: string) => void;
}) {
    if (items.length === 0) {
        return null;
    }
    return (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
            {items.map((a) => (
                <Chip key={a.id} att={a} onRemove={onRemove} onRetry={onRetry} />
            ))}
        </div>
    );
}

// The paperclip: a <label> wrapping a hidden multi file input. Resets value after change so re-picking
// the same file still fires onChange.
export function AttachButton({ onFiles }: { onFiles: (files: FileList) => void }) {
    return (
        <label
            title="Attach files"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[6px] border border-edge-mid text-muted hover:border-edge-strong hover:text-secondary"
        >
            <Paperclip size={13} />
            <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                    const files = e.target.files;
                    if (files && files.length > 0) {
                        onFiles(files);
                    }
                    e.target.value = "";
                }}
            />
        </label>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (Confirm `lucide-react` exports `File`, `Loader2`, `Paperclip`, `RotateCw`, `X` — all are already imported elsewhere in this dir; see `channelrail.tsx`, `radarscanstatepanel.tsx`, `agenttree.tsx`.)

---

### Task 4: `ComposerShell` opt-in drop/paste/tray props

**Files:**
- Modify: `frontend/app/view/agents/composer-shell.tsx`

**Interfaces:**
- Produces (consumed by Task 5): `ComposerShell` gains optional props `onPaste?: React.ClipboardEventHandler`, `onDrop?: React.DragEventHandler`, `onDragOver?: React.DragEventHandler`, `onDragLeave?: React.DragEventHandler`, `isDragging?: boolean`, `attachments?: React.ReactNode`. All existing props/behavior unchanged.

- [ ] **Step 1: Replace the whole `ComposerShell` file**

Replace the entire contents of `frontend/app/view/agents/composer-shell.tsx` with (only the import line, the props type, and the JSX wrapper change; the textarea/footer/button internals are identical to the current file):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The shared composer frame used by the channel chat composer, the Runs new-run panel, and the inline
// steer composer, so the three read as one system. Owns the rounded card, the footer row, and the Send
// button. Callers either use the built-in auto-growing textarea (value/onChange/onSubmit) or pass a
// custom `inputRegion` (chat's mention-highlight backdrop + textarea) plus an `overlay` (chat's mention
// dropdown). Outer positioning/padding around the card belongs to the caller (bottom bar vs centered
// panel vs inline steer), so it is intentionally not owned here.
//
// Attachment props (onPaste/onDrop/onDragOver/onDragLeave/isDragging/attachments) are opt-in: callers
// that omit them render byte-for-byte as before. The Channels composer uses them for paste/attach/drop.

import {
    useLayoutEffect,
    useRef,
    type ClipboardEventHandler,
    type DragEventHandler,
    type KeyboardEvent,
    type ReactNode,
} from "react";

export function ComposerShell({
    onSubmit,
    value,
    onChange,
    placeholder,
    disabled,
    autoFocus,
    inputRegion,
    overlay,
    footerLeft,
    footerRight,
    sendLabel = "Send ⏎",
    sendDisabled,
    onPaste,
    onDrop,
    onDragOver,
    onDragLeave,
    isDragging,
    attachments,
}: {
    onSubmit: () => void;
    value?: string;
    onChange?: (next: string) => void;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    inputRegion?: ReactNode;
    overlay?: ReactNode;
    footerLeft?: ReactNode;
    footerRight?: ReactNode;
    sendLabel?: string;
    sendDisabled?: boolean;
    onPaste?: ClipboardEventHandler;
    onDrop?: DragEventHandler;
    onDragOver?: DragEventHandler;
    onDragLeave?: DragEventHandler;
    isDragging?: boolean;
    attachments?: ReactNode;
}) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    // grow the built-in textarea to fit its content (capped by max-h). Chat supplies its own inputRegion
    // and sizes itself via the highlight backdrop, so this only runs for the built-in path.
    useLayoutEffect(() => {
        const ta = taRef.current;
        if (ta && inputRegion == null) {
            ta.style.height = "0px";
            ta.style.height = `${ta.scrollHeight}px`;
        }
    }, [value, inputRegion]);
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
        }
    };
    return (
        <div className="relative">
            {overlay}
            <div
                className="relative rounded-lg border border-edge-mid bg-surface-raised px-[15px] py-3"
                onPaste={onPaste}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
            >
                {isDragging ? (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-surface-raised/80">
                        <span className="font-mono text-[12px] font-semibold text-accent-soft">Drop files to attach</span>
                    </div>
                ) : null}
                {attachments}
                <div className="relative">
                    {inputRegion ?? (
                        <textarea
                            ref={taRef}
                            value={value ?? ""}
                            onChange={(e) => onChange?.(e.target.value)}
                            onKeyDown={onKeyDown}
                            rows={1}
                            autoFocus={autoFocus}
                            placeholder={placeholder}
                            disabled={disabled}
                            className="max-h-[160px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none disabled:opacity-50"
                            style={{ caretColor: "var(--color-primary)" }}
                        />
                    )}
                </div>
                <div className="mt-2.5 flex items-center gap-2.5">
                    {footerLeft}
                    <div className="flex-1" />
                    {footerRight}
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={sendDisabled ?? disabled}
                        className="shrink-0 cursor-pointer rounded bg-accent px-[15px] py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-50"
                    >
                        {sendLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
```

Notes on what changed vs. the current file: (a) import adds `ClipboardEventHandler`/`DragEventHandler` types; (b) props type gains the six optional attachment props; (c) the card `<div>` gains `relative` (visually inert with no positioned descendant) + the four DOM handlers; (d) a conditional drag overlay and the `{attachments}` slot render inside the card, above the input. The `pointer-events-none` overlay lets the drop event still land on the card.

- [ ] **Step 2: Confirm existing callers still compile unchanged**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. The Runs new-run panel and inline steer composer pass none of the new props → unchanged.

- [ ] **Step 3: (Optional sanity) list the callers to confirm none break**

Run: `grep -rn "ComposerShell" frontend/app --include=*.tsx`
Expected: only `composer-shell.tsx` (definition) and `channelcomposers.tsx` (+ any Runs/steer callers) reference it; new props are optional so all still typecheck.

---

### Task 5: Wire tray + paperclip + capture into both composer faces

**Files:**
- Modify: `frontend/app/view/agents/channelcomposers.tsx`

**Interfaces:**
- Consumes: `UseComposerAttachments` (Task 2), `AttachmentTray`/`AttachButton` (Task 3), the new `ComposerShell` props (Task 4).
- Produces (consumed by Task 6): `LaunchComposer` and `TalkComposer` each gain a **required** prop `attach: UseComposerAttachments`.

- [ ] **Step 1: Add imports**

In `frontend/app/view/agents/channelcomposers.tsx`, after the existing `import { ComposerShell } from "./composer-shell";` line, add:

```ts
import { AttachButton, AttachmentTray } from "./attachmenttray";
import { type UseComposerAttachments } from "./composerattachments";
```

- [ ] **Step 2: Extend `LaunchComposer`'s props and wire it**

In `LaunchComposer`, add `attach` to the destructured params and its type:

```ts
export function LaunchComposer({
    value,
    onChange,
    onSubmit,
    profile,
    channelName,
    pending,
    attach,
}: {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    profile: JarvisProfile | undefined;
    channelName: string;
    pending: boolean;
    attach: UseComposerAttachments;
}) {
```

Then update the `<ComposerShell ...>` opening in `LaunchComposer`. Replace its current `sendDisabled` and `footerLeft`, and add the attachment props. The opening tag becomes:

```tsx
        <ComposerShell
            onSubmit={onSubmit}
            sendLabel={sendLabel}
            sendDisabled={(!value.trim() && attach.readyCount === 0) || attach.uploading}
            onPaste={attach.dnd.onPaste}
            onDrop={attach.dnd.onDrop}
            onDragOver={attach.dnd.onDragOver}
            onDragLeave={attach.dnd.onDragLeave}
            isDragging={attach.isDragging}
            attachments={<AttachmentTray items={attach.attachments} onRemove={attach.remove} onRetry={attach.retry} />}
            overlay={
```

(leave the `overlay={...}` and `inputRegion={...}` bodies exactly as they are), and replace the `footerLeft` prop at the end of `LaunchComposer`'s `ComposerShell` with:

```tsx
            footerLeft={
                <>
                    <AttachButton onFiles={attach.add} />
                    <span className="font-mono text-[11px] text-ink-mid">{footer}</span>
                </>
            }
```

- [ ] **Step 3: Extend `TalkComposer`'s props and wire it**

In `TalkComposer`, add `attach` to the destructured params and its type:

```ts
export function TalkComposer({
    worker,
    phaseLabel,
    value,
    onChange,
    onSubmit,
    onNewRun,
    attach,
}: {
    worker: AgentVM;
    phaseLabel: string | undefined;
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    onNewRun: () => void;
    attach: UseComposerAttachments;
}) {
```

Update `TalkComposer`'s `<ComposerShell ...>` opening — replace `sendDisabled` and add the attachment props:

```tsx
        <ComposerShell
            onSubmit={onSubmit}
            sendLabel="Send ⏎"
            sendDisabled={(!value.trim() && attach.readyCount === 0) || attach.uploading}
            onPaste={attach.dnd.onPaste}
            onDrop={attach.dnd.onDrop}
            onDragOver={attach.dnd.onDragOver}
            onDragLeave={attach.dnd.onDragLeave}
            isDragging={attach.isDragging}
            attachments={<AttachmentTray items={attach.attachments} onRemove={attach.remove} onRetry={attach.retry} />}
            inputRegion={
```

(leave the `inputRegion={...}` body exactly as it is), and replace `TalkComposer`'s `footerLeft` with:

```tsx
            footerLeft={
                <>
                    <AttachButton onFiles={attach.add} />
                    <span className="font-mono text-[11px] text-ink-mid">
                        → injected as a follow-up turn to {worker.name}
                    </span>
                </>
            }
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: **FAIL** with a TS error at `channelssurface.tsx` — `<LaunchComposer>` / `<TalkComposer>` are now missing the required `attach` prop. That is expected and is fixed in Task 6. (If it fails anywhere *inside* `channelcomposers.tsx`, fix that here.)

---

### Task 6: Own the hook in the surface; inject on send; clear on send/switch

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx`

**Interfaces:**
- Consumes: `useComposerAttachments` + `appendAttachments` (Tasks 1, 2); the `attach` prop on both composers (Task 5).

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/channelssurface.tsx`, add near the other `./` imports (e.g. after the `import { LaunchComposer, TalkComposer } from "./channelcomposers";` line):

```ts
import { appendAttachments, useComposerAttachments } from "./composerattachments";
```

- [ ] **Step 2: Call the hook**

Immediately after `const [draft, setDraft] = useState("");` (currently `channelssurface.tsx:59`), add:

```ts
    const attach = useComposerAttachments();
```

- [ ] **Step 3: Clear attachments when the channel changes**

In the effect keyed on `[activeId]` (currently `channelssurface.tsx:77-82`) that already calls `setDraft("")`, add `attach.clear();`:

```ts
    useEffect(() => {
        setDismissed(new Set());
        resetSummary();
        setDraft("");
        attach.clear();
        setOverviewOpen(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId]);
```

(If the effect has no eslint-disable line yet, add it as shown — `attach.clear` is a stable useCallback but keep the dep list at `[activeId]` to preserve current behavior.)

- [ ] **Step 4: Rewrite `send()` to guard uploads, inject attachments, and clear**

Replace the entire `send` function body (currently `channelssurface.tsx:173-227`) with:

```ts
    const send = () => {
        if (!active) {
            return;
        }
        if (attach.uploading) {
            return; // Enter bypasses the disabled Send button; block until every attachment resolves
        }
        if (face.face === "talk") {
            const text = appendAttachments(draft.trim(), attach.attachments);
            if (!text.trim()) {
                return;
            }
            setDraft("");
            attach.clear();
            fireAndForget(() => steerWorker({ channelId: active.oid, workerORef: `tab:${face.worker.id}`, agents, text }));
            return;
        }
        // Launch face
        if (pendingDraft) {
            const goal = appendAttachments(pendingDraft.goal.trim(), attach.attachments);
            if (!goal.trim()) {
                return;
            }
            const radarOrigin = pendingDraft.radarOrigin;
            setPendingDraft(null);
            attach.clear();
            fireAndForget(async () => {
                const created = await launchRun(goal, { radarOrigin });
                setActiveRunId(created.id);
            });
            return;
        }
        const text = appendAttachments(draft.trim(), attach.attachments);
        if (!text.trim()) {
            return;
        }
        setDraft("");
        attach.clear();
        const cmd = parseComposerCommand(text);
        if (cmd.mode === "run") {
            fireAndForget(async () => {
                const created = await launchRun(cmd.body);
                setActiveRunId(created.id);
            });
            return;
        }
        // Quick → dispatch a bare worker; Ask → one-shot consult. Both route through sendChannelMessage's
        // planMessage transport (@runtime … / ask @runtime …); this mirrors the Ctrl+P palette exactly.
        const transport = cmd.mode === "quick" ? `@${cmd.runtime ?? "claude"} ${cmd.body}` : `ask @${cmd.runtime ?? "claude"} ${cmd.body}`;
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: active.oid,
                projectPath: active.projectpath ?? "",
                projectName: active.name ?? "agent",
                roster,
                agents,
                text: transport,
            })
        );
    };
```

Rationale for each branch (matches spec §Delivery): Launch appends **before** `parseComposerCommand` so the leading `@run`/`@quick`/`@ask` token is preserved and the paths flow into `cmd.body`; the Radar pending-draft branch appends into the draft goal; Talk appends before `steerWorker`. `appendAttachments` returns the text unchanged when nothing is ready, so a plain text send is identical to today. The empty guard now uses the **appended** text so an attachment-only send (no typed text) still goes through.

- [ ] **Step 5: Pass `attach` to both composers**

In the composer render block (currently `channelssurface.tsx:353-371`), add `attach={attach}` to each:

```tsx
                                        {face.face === "talk" ? (
                                            <TalkComposer
                                                worker={face.worker}
                                                phaseLabel={phaseLabel}
                                                value={draft}
                                                onChange={setDraft}
                                                onSubmit={send}
                                                onNewRun={selectNewRun}
                                                attach={attach}
                                            />
                                        ) : (
                                            <LaunchComposer
                                                value={launchValue}
                                                onChange={onLaunchChange}
                                                onSubmit={send}
                                                profile={profile}
                                                channelName={active.name ?? "channel"}
                                                pending={!!pendingDraft}
                                                attach={attach}
                                            />
                                        )}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (the Task 5 error is now resolved).

- [ ] **Step 7: Run the full frontend unit suite (regression guard)**

Run: `npx vitest run`
Expected: PASS except the one **known** pre-existing failure noted in CLAUDE.md/memory is a Go test, not vitest — the vitest suite should be fully green. If any vitest fails, it is yours.

---

### Task 7: Surface OS file-drops as DOM events (`tauri.conf.json`)

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add `dragDropEnabled: false` to the `main` window**

Change the `windows` entry (currently `src-tauri/tauri.conf.json:14`) from:

```json
      { "label": "main", "title": "Arc", "width": 1000, "height": 700, "decorations": false }
```

to:

```json
      { "label": "main", "title": "Arc", "width": 1000, "height": 700, "decorations": false, "dragDropEnabled": false }
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Note for the executor (no command)**

`cargo tauri dev` watches `src-tauri/`, so the change activates on the next dev rebuild. This governs only OS *file* drops (they now surface as DOM `drop` with `dataTransfer.files`); the layout engine's element drag-drop and the terminal's already-dead drop handler are unaffected. No action needed beyond the config edit; verified live in Task 9.

---

### Task 8: Document the deferrals (`docs/deferred.md`)

**Files:**
- Modify: `docs/deferred.md`

- [ ] **Step 1: Prepend a new entry**

Insert the following block immediately after the intro paragraph (currently ends at `docs/deferred.md:4`, before the first `## Channel notes …` heading), honoring the file's "Append new entries at the top" convention:

```markdown
## Channel composer attachments — temp-file cleanup + remote-worker paths (2026-07-16)

Shipped paste/attach/drag-drop attachments in the Channels composer (spec/plan
`docs/superpowers/{specs,plans}/2026-07-16-channel-composer-attachments*.md`). Two edges deferred:

1. **Temp-file cleanup.** Each attachment is persisted via `WriteTempFileCommand`, which `os.MkdirTemp`s a
   fresh dir per file and never deletes it. v1 deliberately does not clean up (the worker may read the file
   any time after send, and lifecycle tracking is out of scope). Over time these accumulate under the OS
   temp dir. **To resume:** track written paths against the run/worker that consumed them and reap on
   worker exit (or a periodic sweep of `waveterm-*` temp dirs older than N days).

2. **Remote / WSL workers can't see local temp paths.** The temp file lands on the wavesrv (local) host;
   an SSH/WSL worktree worker resolves the injected path against *its* filesystem and won't find it. v1 is
   local-scope only (matches the "keep v1 local" principle used across Files/git). **To resume:** route the
   write to `wsh` on the worker's host (same `WriteTempFileCommand`, remote route) and inject the
   remote-side path.

No cross-reload persistence of pending attachments, no image annotation, and no Tauri native file-dialog
plugin were built (all out of scope per the spec's non-goals).
```

- [ ] **Step 2: Verify placement**

Run: `grep -n "Channel composer attachments" docs/deferred.md`
Expected: one match, near the top of the file (line < 10).

---

### Task 9: Full verification (rollout checklist)

**Files:** none (verification only).

This task runs the spec's rollout checklist end-to-end. It gates the single batched commit.

- [ ] **Step 1: Confirm no codegen was needed**

Run: `grep -c WriteTempFileCommand frontend/app/store/wshclientapi.ts`
Expected: `≥ 1` (the client already has it — confirms no `task generate`).

- [ ] **Step 2: Unit tests green**

Run: `npx vitest run frontend/app/view/agents/composerattachments.test.ts`
Expected: PASS (10 assertions).

- [ ] **Step 3: Typecheck clean**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: CDP verification against the live dev app**

Ensure `task dev` is running (start it if not; on Windows headless use `tail -f /dev/null | task dev` per the memory note, and `TaskStop` it explicitly when done). Inject a channel scenario if the cockpit is empty (`node scripts/inject-live-agents.mjs <scenario>`). Then drive these four flows over CDP (`:9222`; attach via the same pattern as `scripts/cdp-shot.mjs`, using `Input.dispatchKeyEvent` / synthetic paste+drop and `Runtime.evaluate` to read the created run's goal). Screenshot each with `node scripts/cdp-shot.mjs <name>.png`:

  1. **Paste (Launch):** focus the Launch composer, dispatch a clipboard paste carrying an image → an image thumbnail chip appears → type/prepend `@run <goal>` → Send → confirm the created run's goal contains the temp path (the injected `Attachments (read these files):` block).
  2. **Paperclip (Launch):** click the paperclip → pick a non-image file → a file chip with size appears → Send → path present in the goal.
  3. **Drag-drop (Launch):** dispatch an OS file drop onto the composer card → the dashed "Drop files to attach" overlay shows during drag → a chip appears on drop → Send → path present. (This validates `dragDropEnabled:false`; if the overlay never shows and no chip appears, the Tauri config change did not take effect — rebuild dev.)
  4. **Talk face:** with a live worker selected (Talk face showing), paste an image → chip → Send → confirm the follow-up turn injected into the worker carries the path (check the directive message / worker input).

Expected: all four pass; capture a screenshot showing a populated chip tray + the drag overlay for the handoff.

- [ ] **Step 5: Confirm the deferred entry exists**

Run: `grep -n "Channel composer attachments" docs/deferred.md`
Expected: one match near the top.

- [ ] **Step 6: Self-review the diff, then request approval to commit**

Run: `git status` and `git --no-pager diff --stat`
Expected files touched: `frontend/app/view/agents/composerattachments.ts`, `composerattachments.test.ts`, `attachmenttray.tsx`, `composer-shell.tsx`, `channelcomposers.tsx`, `channelssurface.tsx`, `src-tauri/tauri.conf.json`, `docs/deferred.md`, and the spec + this plan under `docs/superpowers/`.

Then, **only on explicit user approval**, create one batched commit folding in the spec + plan docs (per the repo git workflow). Do not commit before approval, and do not add a co-author.

---

## Self-Review (against the spec)

**Spec coverage:**
- Goal §1 (three sources) → Task 2 (`dnd.onPaste`, `dnd.onDrop`) + Task 3 (`AttachButton`). ✓
- Goal §2 (both faces) → Task 5 (both composers), Task 6 (all three send branches: Talk, Radar pending, Launch). ✓
- Delivery mechanism (persist + reference-by-path) → Task 2 `persist` + `appendAttachments`. ✓
- Architecture: `composerattachments.ts` (Tasks 1-2), `attachmenttray.tsx` (Task 3), `composer-shell.tsx` opt-in props (Task 4), `channelcomposers.tsx` presentational (Task 5), `channelssurface.tsx` owns state (Task 6), `tauri.conf.json` (Task 7). ✓
- Capture (paste only when `files.length>0`, paperclip reset value, drag sets/clears `isDragging`) → Tasks 2, 3. ✓
- Persist pipeline (oversize→error no RPC, uploading chip, previewUrl for images, ready/error, retry) → Task 2. ✓
- Send injection + `uploading` block + `clear()` after send → Task 6. ✓
- UI: chip tray, paperclip in footerLeft, `sendDisabled` formula, drag overlay → Tasks 3, 4, 5. ✓
- Testing: vitest for `appendAttachments`/`classifyKind`/size boundary (Task 1); CDP for the 4 flows (Task 9). ✓
- Rollout checklist → Task 9. ✓
- Deferred notes (temp-file cleanup + remote paths) → Task 8. ✓

**Type consistency:** `Attachment`, `UseComposerAttachments`, `attach`, `readyCount`, `uploading`, `dnd`, `add`/`remove`/`retry`/`clear` names are identical across Tasks 1/2/5/6. `appendAttachments(text, atts)` signature matches its test (Task 1) and its two call sites (Task 6). `classifyKind`/`isOversize`/`MAX_ATTACHMENT_BYTES` consistent between Task 1 (define+test) and Task 2 (consume).

**Deviations from the spec (intentional, noted inline):**
- Persist uses `file.arrayBuffer()` + `base64-js` (the repo's existing `termutil.ts` idiom) instead of the spec's `FileReader`/data-URL-prefix-strip — functionally equivalent, DRY with existing code.
- Composers take one cohesive `attach: UseComposerAttachments` prop rather than 8 flat props — DRY across the two faces; composers remain presentational (they only render `<AttachmentTray>`/`<AttachButton>` and forward `attach.dnd`), matching the spec's intent.
