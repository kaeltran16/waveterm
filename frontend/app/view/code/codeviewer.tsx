// frontend/app/view/code/codeviewer.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Renders whichever variant the store resolved the opened file to. The text case hands off to the
// existing Monaco wrapper, which derives the language from the filename — so Go, Rust and TypeScript
// all highlight without a language map here. Only the text case is editable; every other variant
// (binary, too large, missing, unreadable) stays a dead end by construction.
//
// This is also the only module that touches Monaco directly. The store publishes a pending line and
// a handoff asks for the current selection; both are served here so codestore.ts stays IO-and-atoms.

import { Markdown } from "@/app/element/markdown";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { joinRepoPath, splitRepoPath } from "@/util/paths";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { useCallback, useEffect, useMemo } from "react";
import { isMarkdownPath } from "./codeclassify";
import { CodeDiffView } from "./codediffview";
import { remember } from "./codeeditorcache";
import { langOf, type Lang } from "./codelang";
import { resolveDocLink } from "./codelink";
import {
    codeDraftsAtom,
    codeFileAtom,
    codePendingLineAtom,
    codeProjectAtom,
    codeViewModeAtom,
    draftKey,
    editDraft,
    openInCode,
    refreshIndex,
    setCaretLineReader,
    setCaretWordReader,
    type CodeProject,
} from "./codestore";
import { wordAt } from "./codesymbolquery";

function sizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Module-scoped rather than a ref: the path bar's handoff control needs the same instance, and the
// surface unmounts on every nav switch. Cleared by the cleanup CodeEditor invokes on unmount.
let editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null;

setCaretLineReader(() => editor?.getPosition()?.lineNumber ?? null);
setCaretWordReader(codeEditorWordAtCursor);

// The editor unmounts on every file, mode and surface switch. Its model is kept alive and its view
// state saved here, keyed like drafts by absolute path, so coming back restores the caret, scroll,
// selection and undo history. Capped because every kept model holds a full copy of its file.
const KEPT_EDITORS = 20;

interface KeptEditor {
    model: MonacoTypes.editor.ITextModel;
    view: MonacoTypes.editor.ICodeEditorViewState | null;
}

const kept = new Map<string, KeptEditor>();

export function codeEditorSelection(): { startLine: number; endLine: number } | null {
    const sel = editor?.getSelection();
    if (sel == null || sel.isEmpty()) {
        return null;
    }
    return { startLine: sel.startLineNumber, endLine: sel.endLineNumber };
}

// The identifier at the caret and the open file's language. The word is cut by wordAt rather than
// Monaco's getWordAtPosition, whose per-language word rules (CSS's leading ".") would hand the
// definition query a name it was not built for; the language comes from codelang for the same reason.
export function codeEditorWordAtCursor(): { word: string; lang: Lang } | null {
    const pos = editor?.getPosition();
    const model = editor?.getModel();
    const file = globalStore.get(codeFileAtom);
    if (pos == null || model == null || file.kind !== "text") {
        return null;
    }
    const lang = langOf(file.path);
    const word = wordAt(model.getLineContent(pos.lineNumber), pos.column, lang);
    return word == null ? null : { word, lang };
}

function applyPendingLine(ed: MonacoTypes.editor.IStandaloneCodeEditor): void {
    const line = globalStore.get(codePendingLineAtom);
    if (line == null) {
        return;
    }
    globalStore.set(codePendingLineAtom, null);
    // a history walk has usually just restored a view that already shows the line, and re-centering
    // it — or dropping the caret's column — would jolt what the reader left
    ed.revealLineInCenterIfOutsideViewport(line);
    if (ed.getPosition()?.lineNumber !== line) {
        ed.setPosition({ lineNumber: line, column: 1 });
    }
}

function restoreKept(ed: MonacoTypes.editor.IStandaloneCodeEditor, key: string): void {
    const saved = kept.get(key);
    // the mounted model leaves the cache so an eviction can never dispose it out from under the editor
    kept.delete(key);
    if (saved != null) {
        ed.restoreViewState(saved.view);
    }
}

// Both CodeEditor and the Monaco wrapper run this on unmount; the second call finds no model.
function keepEditor(ed: MonacoTypes.editor.IStandaloneCodeEditor, key: string): void {
    const model = ed.getModel();
    if (model == null) {
        return;
    }
    for (const old of remember(kept, key, { model, view: ed.saveViewState() }, KEPT_EDITORS)) {
        old.model.dispose();
    }
}

// Markdown is memoized, but only a stable link handler lets the memo hold: an inline one re-parsed the
// whole document on every unrelated re-render, which froze the pane for as long as a large file renders.
function MarkdownPreview({
    model,
    project,
    path,
    text,
}: {
    model: AgentsViewModel;
    project: CodeProject | null;
    path: string;
    text: string;
}) {
    const onClickLink = useCallback(
        (href: string) => {
            const target = project != null ? resolveDocLink(path, href) : null;
            if (target == null) {
                return false;
            }
            fireAndForget(() =>
                openInCode(model, {
                    projectPath: project.path,
                    rel: target.rel,
                    line: target.line ?? undefined,
                })
            );
            return true;
        },
        [model, project, path]
    );
    // a doc's image paths are relative to the doc, not the repo root
    const resolveOpts = useMemo(
        () =>
            project != null
                ? { connName: "local", baseDir: joinRepoPath(project.path, splitRepoPath(path).dir) }
                : null,
        [project, path]
    );
    return (
        <Markdown
            text={text}
            resolveOpts={resolveOpts}
            scrollable
            className="h-full"
            contentClassName="px-5 py-4"
            onClickLink={onClickLink}
        />
    );
}

export function CodeViewer({ model }: { model: AgentsViewModel }) {
    const file = useAtomValue(codeFileAtom);
    const project = useAtomValue(codeProjectAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    const pendingLine = useAtomValue(codePendingLineAtom);
    const mode = useAtomValue(codeViewModeAtom);

    // Two paths, both needed. Monaco is keyed by file path, so opening a DIFFERENT file remounts it
    // and onMount is the only hook that runs late enough to reveal a line. Jumping to another line
    // in the file already open does not remount, so the effect covers that — and it cannot cover
    // the first mount, because Monaco lazy-loads and no re-render follows its arrival.
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

    switch (file.kind) {
        case "none":
            return (
                <SurfaceEmptyState
                    title="No file open"
                    body="Pick a file from the tree, or press Ctrl+P to search by name."
                />
            );
        case "loading":
            return <SurfaceEmptyState title="Opening…" body={file.path} />;
        case "missing":
            return (
                <SurfaceEmptyState
                    title="File no longer exists"
                    body={`${file.path} — the file list is a snapshot, so it can fall behind.`}
                    action={{ label: "Refresh index", onClick: () => fireAndForget(refreshIndex) }}
                />
            );
        case "binary":
            return <SurfaceEmptyState title="Binary file" body={`${file.path} — ${sizeLabel(file.size)}`} />;
        case "toolarge":
            return (
                <SurfaceEmptyState
                    title="File too large to display"
                    body={`${file.path} — ${sizeLabel(file.size)}`}
                    action={{
                        label: "Copy path",
                        onClick: () => {
                            if (project != null) {
                                void navigator.clipboard?.writeText(joinRepoPath(project.path, file.path));
                            }
                        },
                    }}
                />
            );
        case "error":
            return <SurfaceEmptyState title="Could not read the file" body={`${file.path} — ${file.message}`} />;
        case "text": {
            // `text` is the draft when one exists, so the buffer survives a surface unmount. Monaco's
            // prop-sync effect no-ops when the incoming text already equals the model's (monaco-react
            // checks before pushing an edit), so feeding our own keystrokes back does not move the caret.
            const abs = project != null ? draftKey(project, file.path) : file.path;
            const draft = drafts.get(abs);
            // keyed by path: MonacoDiffViewer creates its models once, so a new file needs a new
            // instance or it keeps the previous file's model URI and language
            if (mode === "diff") {
                return <CodeDiffView key={file.path} path={file.path} text={draft?.text ?? file.text} />;
            }
            // READMEs and other prose render as documents; Source (the CodeEditor below) stays one
            // toggle away, and the draft feeds the preview so unsaved edits show what you would save
            if (isMarkdownPath(file.path) && mode === "preview") {
                return (
                    <MarkdownPreview
                        key={file.path}
                        model={model}
                        project={project}
                        path={file.path}
                        text={draft?.text ?? file.text}
                    />
                );
            }
            return (
                // keyed and named by absolute path: kept models outlive a project switch, so two
                // projects' same relative path must not share a model URI
                <CodeEditor
                    key={abs}
                    blockId={model.blockId}
                    text={draft?.text ?? file.text}
                    fileName={abs}
                    readonly={false}
                    keepModel
                    onChange={editDraft}
                    onMount={(ed) => {
                        editor = ed;
                        restoreKept(ed, abs);
                        applyPendingLine(ed);
                        return () => {
                            if (editor === ed) {
                                editor = null;
                            }
                            keepEditor(ed, abs);
                        };
                    }}
                />
            );
        }
    }
}
