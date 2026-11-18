// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The terminal Code peek's card: header, mode row, the body for the peek's file state, and the footer.
// Read-only throughout; it renders CodeEditor, Markdown and the Monaco diff viewer directly, never
// through the Code surface's atoms.

import { Markdown } from "@/app/element/markdown";
import { ViewSwap } from "@/app/element/viewswap";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { paneOptions } from "@/app/view/agents/diffoptions";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { cn, fireAndForget } from "@/util/util";
import {
    ArrowUpRight,
    CircleAlert,
    File as FileIcon,
    FileX,
    Folder,
    ImageIcon,
    LoaderCircle,
    X,
    type LucideIcon,
} from "lucide-react";
import type * as MonacoTypes from "monaco-editor";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { isImagePath } from "./codeclassify";
import { binaryPeekMessage, peekModes, peekStat, type PeekFile, type PeekMode } from "./codepeekmodel";
import { closePeek, codePeekFocusedAtom, openPeekInCode, setPeekMode, type CodePeek } from "./codepeekstore";

const MonacoDiffViewer = lazy(() => import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoDiffViewer })));
const MonacoInsertedText = lazy(() =>
    import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoInsertedText }))
);

const MODES: { mode: PeekMode; label: string }[] = [
    { mode: "preview", label: "Preview" },
    { mode: "source", label: "Source" },
    { mode: "diff", label: "Diff" },
];

// keeps the peek's editor models out of the Code surface's kept-model namespace
const MODEL_PREFIX = "peek/";
// its own model uri, apart from the Source view's editor model for the same file
const INSERTED_PREFIX = "peek-new/";

const DIFF_OPTIONS: MonacoTypes.editor.IDiffEditorOptions = {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: false,
    scrollBeyondLastLine: false,
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    minimap: { enabled: false },
    scrollbar: { useShadows: false, verticalScrollbarSize: 5, horizontalScrollbarSize: 5 },
};

// the File tab draws its diff as the Diff surface does, wrapped since the column is narrow
const TAB_DIFF_OPTIONS = paneOptions(false, false, true);

// repo-relative inside a repository, else the absolute path (or what was clicked, when nothing resolved)
function headerPath(peek: CodePeek): string {
    if (peek.file.kind === "text" && peek.file.git.kind === "repo") {
        return peek.file.git.rel;
    }
    return peek.abs ?? peek.raw;
}

function stateMessage(peek: CodePeek): string | null {
    const file = peek.file;
    switch (file.kind) {
        case "loading":
            return `Reading ${peek.abs ?? peek.raw}…`;
        case "missing":
            return `No such file: ${peek.abs}`;
        case "folder":
            return "Folder";
        case "binary":
            return binaryPeekMessage(file.open.rel);
        case "toolarge":
            return "Larger than the 2 MB view limit";
        case "error":
            return file.message;
        case "nocwd":
            return peek.raw.startsWith("~")
                ? `No home folder to resolve ${peek.raw} against`
                : `No working directory to resolve ${peek.raw} against`;
        case "text":
            return null;
    }
}

// the File tab's notice for a file it cannot draw: the card's message, its path on a line of its own where it has one
function tabNotice(peek: CodePeek): { Icon: LucideIcon; text: string; path?: string } {
    const file = peek.file;
    const text = stateMessage(peek) ?? "";
    switch (file.kind) {
        case "loading":
            return { Icon: LoaderCircle, text: "Reading…", path: peek.abs ?? peek.raw };
        case "missing":
            return { Icon: FileX, text: "No such file", path: peek.abs ?? peek.raw };
        case "folder":
            return { Icon: Folder, text };
        case "binary":
            return { Icon: isImagePath(file.open.rel) ? ImageIcon : FileIcon, text };
        case "toolarge":
            return { Icon: FileIcon, text };
        default:
            return { Icon: CircleAlert, text };
    }
}

// at the last separator of either kind: outside a repo the header shows a Windows absolute path
function splitHeaderPath(p: string): { dir: string; file: string } {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return { dir: p.slice(0, i + 1), file: p.slice(i + 1) };
}

export function Kbd({ children }: { children: string }) {
    return (
        <kbd className="rounded-[4px] border border-edge-strong px-[5px] font-mono text-[10.5px] text-ink-mid">
            {children}
        </kbd>
    );
}

function PeekStat({ file }: { file: PeekFile }) {
    const stat = peekStat(file);
    if (stat == null) {
        return null;
    }
    return (
        <span data-peek-stat className="flex flex-none items-center gap-[8px] font-mono text-[11px]">
            {stat.label ? <span className="text-muted">{stat.label}</span> : null}
            {stat.adds ? <span className="text-diff-added">+{stat.adds}</span> : null}
            {stat.dels ? <span className="text-diff-removed">−{stat.dels}</span> : null}
        </span>
    );
}

function SourceView({ peek, blockId, text }: { peek: CodePeek; blockId: string; text: string }) {
    const line = peek.line;
    return (
        <CodeEditor
            blockId={blockId}
            text={text}
            fileName={MODEL_PREFIX + (peek.abs ?? peek.raw)}
            readonly
            onMount={(ed) => {
                if (line == null) {
                    return () => {};
                }
                ed.revealLineInCenter(line);
                ed.setPosition({ lineNumber: line, column: 1 });
                // the cited line keeps its mark once the cursor moves off it
                const cited = ed.createDecorationsCollection([
                    {
                        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
                        options: {
                            isWholeLine: true,
                            className: "peek-cited-line",
                            lineNumberClassName: "peek-cited-line-number",
                        },
                    },
                ]);
                return () => cited.clear();
            }}
        />
    );
}

function DiffView({ peek, text, inTab }: { peek: CodePeek; text: string; inTab: boolean }) {
    const git = peek.file.kind === "text" ? peek.file.git : null;
    if (git?.kind !== "repo") {
        return null;
    }
    if (git.head.kind === "error") {
        return <PeekMessage text={git.head.message} />;
    }
    const absent = git.head.kind === "absent";
    const options = inTab ? TAB_DIFF_OPTIONS : DIFF_OPTIONS;
    return (
        // in the tab a new file reads as the plain file, as the Diff surface draws one
        <div data-diff-new-file={(inTab && absent) || undefined} className="flex h-full flex-col bg-surface-code">
            {absent ? (
                <div className="flex-none px-[14px] pt-[10px] pb-[8px] text-[11px] text-muted">
                    New file, not in HEAD
                </div>
            ) : null}
            <div className="min-h-0 flex-1">
                <Suspense fallback={null}>
                    {absent ? (
                        <MonacoInsertedText
                            path={INSERTED_PREFIX + (peek.abs ?? peek.raw)}
                            text={text}
                            options={options}
                        />
                    ) : (
                        <MonacoDiffViewer
                            path={MODEL_PREFIX + (peek.abs ?? peek.raw)}
                            original={git.head.kind === "text" ? git.head.text : ""}
                            modified={text}
                            options={options}
                        />
                    )}
                </Suspense>
            </div>
        </div>
    );
}

function PeekMessage({ text }: { text: string }) {
    return (
        <div data-peek-message className="px-[14px] py-[12px] font-mono text-[12px] break-all text-muted">
            {text}
        </div>
    );
}

function PeekNotice({ peek }: { peek: CodePeek }) {
    const { Icon, text, path } = tabNotice(peek);
    return (
        <div
            data-peek-message
            className="flex h-full flex-col items-center justify-center gap-[10px] px-[40px] pb-[40px] text-center"
        >
            <Icon size={20} strokeWidth={1.8} className="text-muted" aria-hidden />
            <div className="max-w-[420px] text-[13px] leading-[1.5] [overflow-wrap:anywhere] text-ink-mid">{text}</div>
            {path ? (
                <div className="max-w-[460px] font-mono text-[11.5px] leading-[1.5] [overflow-wrap:anywhere] text-muted">
                    {path}
                </div>
            ) : null}
        </div>
    );
}

function PeekBody({ peek, blockId, inTab }: { peek: CodePeek; blockId: string; inTab: boolean }) {
    const file = peek.file;
    if (file.kind !== "text") {
        return inTab ? <PeekNotice peek={peek} /> : <PeekMessage text={stateMessage(peek) ?? ""} />;
    }
    // keyed by the file, so a moved card never shows the previous file's models
    const key = `${peek.abs}|${peek.mode}`;
    if (peek.mode === "preview") {
        return (
            <Markdown key={key} text={file.text} scrollable className="h-full" contentClassName="px-[26px] py-[20px]" />
        );
    }
    if (peek.mode === "diff") {
        return <DiffView key={key} peek={peek} text={file.text} inTab={inTab} />;
    }
    return <SourceView key={`${key}|${peek.line}`} peek={peek} blockId={blockId} text={file.text} />;
}

// the card offers every mode, a disabled one titled with why; the tab shows only the ones the file has, and none
// when there is a single one to pick
function ModeSwitch({
    peek,
    modes,
    enabledOnly,
}: {
    peek: CodePeek;
    modes: Record<PeekMode, { enabled: boolean; reason?: string }>;
    enabledOnly: boolean;
}) {
    const shown = enabledOnly ? MODES.filter(({ mode }) => modes[mode].enabled) : MODES;
    if (enabledOnly && shown.length < 2) {
        return null;
    }
    return (
        <div className="flex flex-none items-center gap-[2px] rounded-[6px] border border-border p-[2px]">
            {shown.map(({ mode, label }) => {
                const state = modes[mode];
                const pressed = peek.mode === mode && state.enabled;
                return (
                    <button
                        key={mode}
                        type="button"
                        data-peek-mode={mode}
                        aria-pressed={pressed}
                        disabled={!state.enabled}
                        title={state.reason}
                        onClick={() => setPeekMode(mode)}
                        className={cn(
                            "rounded-[4px] px-[8px] py-[2px] text-[11px]",
                            pressed ? "bg-accentbg text-accent-soft" : "text-muted",
                            state.enabled ? "cursor-pointer hover:text-secondary" : "cursor-default opacity-50"
                        )}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

// "card" floats over the terminal with its own close and a footer; "tab" fills a workspace File tab, whose tab closes
// it, so its header carries Open in Code and it has no footer (the File board)
export function CodePeekCard({
    peek,
    model,
    blockId,
    side,
    variant = "card",
}: {
    peek: CodePeek;
    model: AgentsViewModel;
    blockId: string;
    side?: "below" | "above";
    variant?: "card" | "tab";
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const modes = useMemo(() => peekModes(peek.abs ?? peek.raw, peek.file), [peek.abs, peek.raw, peek.file]);
    const path = headerPath(peek);
    const canOpen = "open" in peek.file;
    const isFolder = peek.file.kind === "folder";
    const inTab = variant === "tab";
    const openLabel = isFolder ? "Open folder in Code" : "Open in Code";
    const openInCode = () => fireAndForget(() => openPeekInCode(model));
    const { dir, file } = splitHeaderPath(path);
    const citedLine = peek.file.kind === "text" ? peek.line : null;

    // a new anchor is a new card: it takes focus so Enter and Esc reach it
    useEffect(() => {
        rootRef.current?.focus({ preventScroll: true });
    }, [peek.blockId, peek.bufferLine, peek.start, peek.raw, peek.line]);

    return (
        <div
            ref={rootRef}
            tabIndex={-1}
            role="dialog"
            aria-label={`Peek at ${path}`}
            data-code-peek
            data-peek-state={peek.file.kind}
            data-peek-side={side}
            data-peek-variant={variant}
            onFocus={() => globalStore.set(codePeekFocusedAtom, true)}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    globalStore.set(codePeekFocusedAtom, false);
                }
            }}
            className={cn(
                "flex h-full w-full flex-col overflow-hidden bg-background text-primary outline-none",
                !inTab && "rounded-[8px] border border-edge-strong shadow-popover-md"
            )}
        >
            {inTab ? (
                <div className="flex min-h-[40px] flex-none items-center gap-[10px] overflow-hidden border-b border-border pr-[12px] pl-[14px]">
                    <span
                        data-peek-path
                        title={peek.abs ?? peek.raw}
                        className="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-[11.5px] whitespace-nowrap"
                    >
                        {isFolder ? <Folder size={13} className="mr-[6px] flex-none text-ink-mid" aria-hidden /> : null}
                        {/* rtl cuts the folder from the left, so the name always shows; the bdi keeps the text
                            itself left-to-right (the Diff pane's header) */}
                        <span className="min-w-0 truncate text-muted [direction:rtl]">
                            <bdi dir="ltr">{dir}</bdi>
                        </span>
                        <span className="max-w-full min-w-0 flex-none truncate text-primary">{file}</span>
                        {citedLine != null ? <span className="flex-none text-muted">:{citedLine}</span> : null}
                    </span>
                    <PeekStat file={peek.file} />
                    <ModeSwitch peek={peek} modes={modes} enabledOnly />
                    <button
                        type="button"
                        data-peek-open
                        disabled={!canOpen}
                        onClick={openInCode}
                        className="flex flex-none cursor-pointer items-center gap-[3px] font-mono text-[10.5px] font-semibold text-accent-soft hover:text-primary disabled:cursor-default disabled:opacity-50"
                    >
                        {openLabel}
                        <ArrowUpRight size={11} aria-hidden />
                    </button>
                </div>
            ) : (
                <>
                    <div className="flex min-h-[44px] flex-none items-center gap-[10px] border-b border-border pr-[8px] pl-[14px]">
                        <span className="font-mono text-[10.5px] font-bold tracking-[0.1em] text-accent-soft uppercase">
                            {isFolder ? "Folder" : "File"}
                        </span>
                        <span
                            data-peek-path
                            title={peek.abs ?? peek.raw}
                            className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-secondary"
                        >
                            {path}
                        </span>
                        <button
                            type="button"
                            aria-label="Close the peek"
                            onClick={closePeek}
                            className="flex h-[28px] w-[28px] flex-none cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-raised hover:text-secondary"
                        >
                            <X size={14} aria-hidden />
                        </button>
                    </div>
                    <div className="flex flex-none items-center gap-[8px] border-b border-border px-[12px] py-[6px]">
                        <ModeSwitch peek={peek} modes={modes} enabledOnly={false} />
                        <PeekStat file={peek.file} />
                        <span className="flex-1" />
                        <span className="text-[11px] text-muted">Read-only</span>
                    </div>
                </>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
                {/* the file landing over its "Reading…" line, or another mode's view, fades in rather than cutting */}
                <ViewSwap swapKey={`${peek.file.kind}|${peek.mode}`} className="h-full">
                    <PeekBody peek={peek} blockId={blockId} inTab={inTab} />
                </ViewSwap>
            </div>
            {inTab ? null : (
                <div className="flex flex-none items-center gap-[12px] border-t border-border px-[14px] py-[10px]">
                    <button
                        type="button"
                        data-peek-open
                        disabled={!canOpen}
                        onClick={openInCode}
                        className="cursor-pointer rounded-[7px] bg-accent px-[13px] py-[7px] text-[12px] font-semibold text-background disabled:cursor-default disabled:opacity-50"
                    >
                        {openLabel}
                    </button>
                    <span className="flex-1" />
                    <span className="flex items-center gap-[6px] text-[11px] text-muted">
                        <Kbd>Enter</Kbd>open in Code
                    </span>
                    <span className="flex items-center gap-[6px] text-[11px] text-muted">
                        <Kbd>Esc</Kbd>close
                    </span>
                </div>
            )}
        </div>
    );
}
