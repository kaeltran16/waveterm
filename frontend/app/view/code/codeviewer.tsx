// frontend/app/view/code/codeviewer.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Renders whichever variant the store resolved the opened file to. The text case hands off to the
// existing Monaco wrapper, which derives the language from the filename — so Go, Rust and TypeScript
// all highlight without a language map here. Only the text case is editable; an image file renders,
// and every other variant (binary, too large, missing, unreadable) is read-only by construction.
//
// This is also the only module that touches Monaco directly. The store publishes a pending line and
// a handoff asks for the current selection; both are served here so codestore.ts stays IO-and-atoms.

import { ImageZoom, type ZoomImage } from "@/app/element/imagezoom";
import { Markdown } from "@/app/element/markdown";
import { resolveRemoteFile } from "@/app/element/markdown-util";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { joinRepoPath, splitRepoPath } from "@/util/paths";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeBlameColumn, type EditorLineLayout } from "./codeblamecolumn";
import { codeBlameOnAtom } from "./codeblamestore";
import { isImagePath, isMarkdownPath } from "./codeclassify";
import { missingView } from "./codedifftarget";
import { CodeDiffView } from "./codediffview";
import { remember } from "./codeeditorcache";
import { langOf, type Lang } from "./codelang";
import { resolveDocLink } from "./codelink";
import { previewHeadingFor } from "./codeoutline";
import { resolvePendingJump, type JumpResolution } from "./codependingjump";
import { fileComments, reanchor } from "./codereview";
import {
    cancelComment,
    codeCommentDraftAtom,
    codeReviewsAtom,
    consumePendingComment,
    saveComment,
    setCommentSelectionReader,
    startComment,
} from "./codereviewstore";
import {
    codeDraftsAtom,
    codeFileAtom,
    codeIndexAtom,
    codeOutlineAtom,
    codePendingJumpAtom,
    codePlainAtom,
    codeProjectAtom,
    codeStatusAtom,
    codeViewModeAtom,
    draftKey,
    editDraft,
    goToLine,
    openInCode,
    refreshIndex,
    revealFolder,
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

function copyPath(project: CodeProject | null, rel: string): void {
    if (project != null) {
        void navigator.clipboard?.writeText(joinRepoPath(project.path, rel));
    }
}

// Module-scoped rather than a ref: the path bar's handoff control needs the same instance, and the
// surface unmounts on every nav switch. Cleared by the cleanup CodeEditor invokes on unmount.
let editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null;
// the same instance as an atom, for the one consumer that must re-render when it changes: the line layout
const editorAtom = atom<MonacoTypes.editor.IStandaloneCodeEditor | null>(
    null
) as PrimitiveAtom<MonacoTypes.editor.IStandaloneCodeEditor | null>;

function setEditor(ed: MonacoTypes.editor.IStandaloneCodeEditor | null): void {
    editor = ed;
    globalStore.set(editorAtom, ed);
}

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

export function codeEditorSelection(): { startLine: number; endLine: number; endColumn: number } | null {
    const sel = editor?.getSelection();
    if (sel == null || sel.isEmpty()) {
        return null;
    }
    return { startLine: sel.startLineNumber, endLine: sel.endLineNumber, endColumn: sel.endColumn };
}

// a comment with nothing selected is on the caret's line
setCommentSelectionReader(() => {
    const pos = editor?.getPosition();
    return (
        codeEditorSelection() ??
        (pos == null ? null : { startLine: pos.lineNumber, endLine: pos.lineNumber, endColumn: pos.column })
    );
});

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

// The pending jump against the file showing, or null with nothing pending. A drop is cleared here, so a
// jump whose file opened as binary, missing or an error can never fire later on another file.
function resolveShowing(): JumpResolution | null {
    const p = globalStore.get(codePendingJumpAtom);
    if (p == null) {
        return null;
    }
    const headings = globalStore.get(codeOutlineAtom).filter((s) => s.kind === "heading");
    const r = resolvePendingJump(p, globalStore.get(codeFileAtom), headings);
    if (r.kind === "drop") {
        globalStore.set(codePendingJumpAtom, null);
    }
    return r;
}

function applyPendingLine(ed: MonacoTypes.editor.IStandaloneCodeEditor): void {
    const r = resolveShowing();
    if (r?.kind !== "line") {
        return;
    }
    globalStore.set(codePendingJumpAtom, null);
    const line = r.line;
    // a history walk has usually just restored a view that already shows the line, and re-centering
    // it — or dropping the caret's column — would jolt what the reader left
    ed.revealLineInCenterIfOutsideViewport(line);
    if (ed.getPosition()?.lineNumber !== line) {
        ed.setPosition({ lineNumber: line, column: 1 });
    }
}

// A rendered document has no lines, so a jump lands on the heading of the section holding the line —
// which is all a Symbols heading row or an @ pick asks for. "notready" while the document's headings are
// not in the DOM yet; "off" when the scroll did not bring the heading into the preview's frame.
type PreviewReveal = "notready" | "off" | "shown";

function revealPreviewLine(root: HTMLElement | null, line: number): PreviewReveal {
    // the document itself rather than the scroller: which element scrolls is the Markdown component's
    // business, and scrollIntoView finds it
    const doc = root?.querySelector<HTMLElement>("[data-overlayscrollbars-viewport]");
    const outline = globalStore.get(codeOutlineAtom);
    const headings = Array.from(doc?.querySelectorAll<HTMLElement>(".heading") ?? []);
    if (doc == null || (headings.length === 0 && outline.some((s) => s.kind === "heading"))) {
        return "notready";
    }
    const at = previewHeadingFor(
        outline,
        line,
        headings.map((h) => h.textContent ?? "")
    );
    const target = at === -1 ? doc : headings[at];
    target.scrollIntoView({ block: "start" });
    const shown = target.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    return shown.top >= frame.top - 1 && shown.top < frame.bottom ? "shown" : "off";
}

// A fresh document's scroller resets its offset a frame or two after it mounts, undoing a reveal made
// on arrival, so the reveal is re-asserted each frame until it has held this many in a row.
const PREVIEW_JUMP_SETTLE_FRAMES = 8;
// the bound on that, after which a document that rendered gives the jump up
const PREVIEW_JUMP_WAIT_MS = 3000;

// The preview's half of applyPendingLine. The jump stays pending while it settles; one whose document
// never rendered headings is kept, so a later attempt (or a Source toggle) still lands it.
function revealPendingInPreview(root: HTMLElement | null): () => void {
    const r = resolveShowing();
    if (r?.kind !== "line") {
        return () => {}; // nothing pending, dropped, or its file is not showing yet (the effect re-runs when it is)
    }
    const deadline = Date.now() + PREVIEW_JUMP_WAIT_MS;
    let held = 0;
    let rendered = false;
    let frame = 0;
    const step = () => {
        const at = revealPreviewLine(root, r.line);
        rendered ||= at !== "notready";
        held = at === "shown" ? held + 1 : 0;
        if (held >= PREVIEW_JUMP_SETTLE_FRAMES || (Date.now() >= deadline && rendered)) {
            globalStore.set(codePendingJumpAtom, null);
        } else if (Date.now() < deadline) {
            frame = requestAnimationFrame(step);
        }
    };
    step();
    return () => cancelAnimationFrame(frame);
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
            if (globalStore.get(codeIndexAtom)?.paths.some((p) => p.startsWith(`${target.rel}/`))) {
                revealFolder(target.rel);
                return true;
            }
            if (target.rel === path) {
                // this document is already showing, so only the jump is left to do
                if (target.line != null) {
                    goToLine(target.line);
                } else if (target.anchor != null) {
                    globalStore.set(codePendingJumpAtom, { path, anchor: target.anchor });
                }
                return true;
            }
            fireAndForget(() =>
                openInCode(model, {
                    projectPath: project.path,
                    rel: target.rel,
                    line: target.line ?? undefined,
                    anchor: target.anchor ?? undefined,
                })
            );
            return true;
        },
        [model, project, path]
    );
    const [zoomed, setZoomed] = useState<ZoomImage | null>(null);
    const homeRef = useRef<HTMLDivElement>(null);
    const onClickImage = useCallback((src: string, alt: string) => {
        // an image takes no focus, so park it on the preview: the zoom view hands focus back to what had it
        homeRef.current?.focus({ preventScroll: true });
        setZoomed({ src, alt });
    }, []);
    const closeZoom = useCallback(() => setZoomed(null), []);
    // a doc's image paths are relative to the doc, not the repo root
    const resolveOpts = useMemo(
        () =>
            project != null
                ? { connName: "local", baseDir: joinRepoPath(project.path, splitRepoPath(path).dir) }
                : null,
        [project, path]
    );
    return (
        <div ref={homeRef} tabIndex={-1} className="h-full outline-none" data-code-preview="">
            <Markdown
                text={text}
                resolveOpts={resolveOpts}
                scrollable
                className="h-full"
                contentClassName="px-5 py-4"
                onClickLink={onClickLink}
                onClickImage={onClickImage}
            />
            <ImageZoom image={zoomed} onClose={closeZoom} />
        </div>
    );
}

// Where the open editor draws a line, in pixels from its top edge, so a column beside it can line up with
// the code. `version` changes on every scroll, layout and content change, which is when those answers move.
export function useEditorLineLayout(): EditorLineLayout | null {
    const ed = useAtomValue(editorAtom);
    const [version, setVersion] = useState(0);
    useEffect(() => {
        if (ed == null) {
            return;
        }
        const bump = () => setVersion((v) => v + 1);
        const subs = [
            ed.onDidScrollChange(bump),
            ed.onDidLayoutChange(bump),
            ed.onDidChangeModelContent(bump),
            ed.onDidChangeHiddenAreas(bump),
            ed.onDidChangeModel(bump),
        ];
        return () => subs.forEach((d) => d.dispose());
    }, [ed]);
    return useMemo(() => {
        if (ed == null) {
            return null;
        }
        const top = (line: number) => ed.getTopForLineNumber(line) - ed.getScrollTop();
        return {
            top,
            // bottom of the last line rather than top of the next, which Monaco clamps at the file's end
            height: (start: number, lines: number) =>
                ed.getBottomForLineNumber(start + lines - 1) - ed.getTopForLineNumber(start),
            version,
        };
    }, [ed, version]);
}

// Its own component so a scroll re-renders the column, not the editor beside it.
function BlameGutter(props: { model: AgentsViewModel; path: string; modtime: number; text: string }) {
    const layout = useEditorLineLayout();
    return <CodeBlameColumn {...props} layout={layout} />;
}

// Bars in the line-decorations gutter for the open file's comments, where their anchors sit now; the
// note shows on hover. Recomputed from the buffer, so an edit above a comment carries it along.
function CommentMarkers({ path, text }: { path: string; text: string }) {
    const ed = useAtomValue(editorAtom);
    const reviews = useAtomValue(codeReviewsAtom);
    const project = useAtomValue(codeProjectAtom);
    useEffect(() => {
        if (ed == null || project == null) {
            return;
        }
        const lines = text.split(/\r?\n/);
        const markers = ed.createDecorationsCollection(
            fileComments(reviews, project.path, path).map((c) => {
                const at = reanchor(c, lines);
                return {
                    range: { startLineNumber: at.startLine, startColumn: 1, endLineNumber: at.endLine, endColumn: 1 },
                    options: {
                        isWholeLine: true,
                        linesDecorationsClassName: "code-comment-marker",
                        hoverMessage: { value: c.note },
                    },
                };
            })
        );
        return () => markers.clear();
    }, [ed, reviews, project, path, text]);
    return null;
}

// room between the input's shadow and the code line below it
const COMMENT_ZONE_GAP_PX = 4;

// The note being written, drawn under the draft's last line. Enter and Escape are the input's own and
// stop here; the window's Escape (back to Cockpit) already stands down while a field holds focus.
function CommentInput({ path }: { path: string }) {
    const draft = useAtomValue(codeCommentDraftAtom);
    const ed = useAtomValue(editorAtom);
    const layout = useEditorLineLayout();
    const [note, setNote] = useState("");
    const boxRef = useRef<HTMLDivElement>(null);
    const shown = draft != null && draft.path === path && layout != null;
    // An empty view zone as tall as the input pushes the lines after the draft down, so the input sits in
    // a gap rather than over code. The input stays outside the zone: Monaco would take its clicks and keys.
    useEffect(() => {
        const box = boxRef.current;
        if (!shown || ed == null || box == null) {
            return;
        }
        let id = "";
        ed.changeViewZones((a) => {
            id = a.addZone({
                afterLineNumber: draft.endLine,
                heightInPx: box.offsetHeight + COMMENT_ZONE_GAP_PX,
                domNode: document.createElement("div"),
            });
        });
        // a no-op on an editor already disposed by a file switch
        return () => ed.changeViewZones((a) => a.removeZone(id));
    }, [shown, ed, draft]);
    if (!shown) {
        return null;
    }
    const close = (save: boolean) => {
        if (save) {
            saveComment(note);
        } else {
            cancelComment();
        }
        setNote("");
        editor?.focus();
    };
    const range = draft.endLine === draft.startLine ? `${draft.startLine}` : `${draft.startLine}-${draft.endLine}`;
    return (
        <div
            ref={boxRef}
            style={{ top: layout.top(draft.endLine) + layout.height(draft.endLine, 1) }}
            className="absolute inset-x-3 z-10 rounded-[8px] border border-border bg-surface p-1.5 shadow-popover-md"
        >
            <input
                autoFocus
                value={note}
                data-code-comment-input
                aria-label={`Comment on line ${range}`}
                placeholder={`Comment on line ${range} (Enter saves, Esc cancels)`}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        close(e.key === "Enter");
                    }
                }}
                className="w-full rounded-[6px] border border-border bg-surface px-2 py-1 text-[12px] text-primary outline-none placeholder:text-muted"
            />
        </div>
    );
}

// An image file, fetched the way a Markdown image is (wavesrv bytes as a blob url) and fit to the pane.
function ImageView({ project, path, size }: { project: CodeProject | null; path: string; size: number }) {
    const [src, setSrc] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const root = project?.path;
    useEffect(() => {
        if (root == null) {
            return;
        }
        const { dir, file } = splitRepoPath(path);
        let url: string | null = null;
        let gone = false;
        setSrc(null);
        setFailed(false);
        void resolveRemoteFile(file, { connName: "local", baseDir: joinRepoPath(root, dir) }).then((u) => {
            url = u;
            if (gone) {
                if (u != null) {
                    URL.revokeObjectURL(u);
                }
            } else if (u == null) {
                setFailed(true);
            } else {
                setSrc(u);
            }
        });
        return () => {
            gone = true;
            if (url != null) {
                URL.revokeObjectURL(url);
            }
        };
    }, [root, path]);
    return (
        <div data-code-image className="flex h-full flex-col items-center p-4">
            <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                {failed ? (
                    <p className="text-[12px] text-error">Could not load the image.</p>
                ) : src != null ? (
                    <img
                        src={src}
                        alt={path}
                        onError={() => setFailed(true)}
                        className="max-h-full max-w-full object-contain"
                    />
                ) : null}
            </div>
            <div className="flex flex-none items-center gap-2 pt-3 text-[12px] text-muted">
                <span>{sizeLabel(size)}</span>
                <button
                    type="button"
                    onClick={() => copyPath(project, path)}
                    className="cursor-pointer rounded-[6px] px-2 py-0.5 hover:bg-surface-hover hover:text-primary"
                >
                    Copy path
                </button>
            </div>
        </div>
    );
}

export function CodeViewer({ model }: { model: AgentsViewModel }) {
    const file = useAtomValue(codeFileAtom);
    const project = useAtomValue(codeProjectAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    const pendingJump = useAtomValue(codePendingJumpAtom);
    const mode = useAtomValue(codeViewModeAtom);
    const blameOn = useAtomValue(codeBlameOnAtom);
    const plain = useAtomValue(codePlainAtom);
    const status = useAtomValue(codeStatusAtom);
    const previewRef = useRef<HTMLDivElement>(null);

    // Two paths, both needed. Monaco is keyed by file path, so opening a DIFFERENT file remounts it
    // and onMount is the only hook that runs late enough to reveal a line. Jumping to another line
    // in the file already open does not remount, so the effect covers that — and it cannot cover
    // the first mount, because Monaco lazy-loads and no re-render follows its arrival.
    useEffect(() => {
        if (pendingJump == null) {
            return;
        }
        // consumed here too, so a later Source toggle does not half-open the file at a stale position
        if (file.kind === "text" && isMarkdownPath(file.path) && mode === "preview") {
            return revealPendingInPreview(previewRef.current);
        }
        if (editor != null) {
            applyPendingLine(editor);
        }
    }, [pendingJump, file, mode]);

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
            // refreshing the index cannot help a deletion git still tracks, so it shows what was removed
            if (missingView(status?.get(file.path), plain) === "deleted") {
                return (
                    <div data-code-deleted className="flex h-full flex-col">
                        <div className="flex flex-none items-baseline gap-2 border-b border-border px-3 py-1.5 text-[12px]">
                            <span className="font-semibold text-primary">Deleted in the working tree</span>
                            <span className="min-w-0 truncate text-muted">{file.path}</span>
                        </div>
                        <div className="min-h-0 flex-1">
                            <CodeDiffView key={file.path} path={file.path} text="" fixedTarget="head" />
                        </div>
                    </div>
                );
            }
            return (
                <SurfaceEmptyState
                    title="File no longer exists"
                    body={`${file.path} — the file list is a snapshot, so it can fall behind.`}
                    action={{ label: "Refresh index", onClick: () => fireAndForget(refreshIndex) }}
                />
            );
        case "binary":
            if (isImagePath(file.path)) {
                return <ImageView key={file.path} project={project} path={file.path} size={file.size} />;
            }
            return (
                <SurfaceEmptyState
                    title="Binary file"
                    body={`${file.path} — ${sizeLabel(file.size)}`}
                    action={{ label: "Copy path", onClick: () => copyPath(project, file.path) }}
                />
            );
        case "toolarge":
            return (
                <SurfaceEmptyState
                    title="File too large to display"
                    body={`${file.path} — ${sizeLabel(file.size)}`}
                    action={{ label: "Copy path", onClick: () => copyPath(project, file.path) }}
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
                    <div ref={previewRef} className="h-full">
                        <MarkdownPreview
                            key={file.path}
                            model={model}
                            project={project}
                            path={file.path}
                            text={draft?.text ?? file.text}
                        />
                    </div>
                );
            }
            const source = (
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
                        setEditor(ed);
                        restoreKept(ed, abs);
                        applyPendingLine(ed);
                        const commentAction = ed.addAction({
                            id: "arc.code.comment",
                            label: "Add review comment",
                            contextMenuGroupId: "navigation",
                            run: () => startComment(),
                        });
                        // an Alt+M from Preview or Diff waited for this editor's caret
                        consumePendingComment();
                        return () => {
                            commentAction.dispose();
                            if (editor === ed) {
                                setEditor(null);
                            }
                            keepEditor(ed, abs);
                        };
                    }}
                />
            );
            // one tree shape whether blame is on or off, so toggling it never remounts the editor
            return (
                <div className="flex h-full">
                    {blameOn && !plain ? (
                        <BlameGutter model={model} path={file.path} modtime={file.modtime} text={file.text} />
                    ) : null}
                    <div className="relative h-full min-w-0 flex-1 overflow-hidden">
                        {source}
                        <CommentMarkers path={file.path} text={draft?.text ?? file.text} />
                        <CommentInput path={file.path} />
                    </div>
                </div>
            );
        }
    }
}
