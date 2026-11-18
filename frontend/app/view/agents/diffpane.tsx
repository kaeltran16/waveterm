// frontend/app/view/agents/diffpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 3 of the Diff surface. One Monaco diff editor for every state the surface has — the working
// tree, a commit, a comparison — because they differ only in which two refs feed it. Split is gated
// on the pane's own measured width rather than the window's: a collapsed history column at the
// shipped 1000x700 leaves enough room for unified and not for split.

import { MOTION } from "@/app/element/motiontokens";
import { SkeletonLine, SkeletonRows } from "@/app/element/skeleton";
import { globalStore } from "@/app/store/jotaiStore";
import { openInCode } from "@/app/view/code/codestore";
import { splitRepoPath } from "@/util/paths";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, ChevronDown, ChevronUp, Code, FileText, Pilcrow, RotateCw } from "lucide-react";
import type * as MonacoTypes from "monaco-editor";
import { motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { DiffCommentZones } from "./diffcommentcard";
import { commentSplitAtom, mountCommentLayer } from "./diffcommentlayer";
import { activeCommentSourceAtom, relocateComments } from "./diffcomments";
import { firstDifferingLine } from "./diffcontent";
import { diffSurfacePair, type DiffPairSource } from "./diffcontentstore";
import { emptyDiffState } from "./diffempty";
import { changePosition, clearDiffNav, diffNavPosAtom, gotoChange, setDiffNav } from "./diffnav";
import {
    ignoreWsAtom,
    isNewFile,
    paneHeaderLayout,
    paneOptions,
    splitAvailableAtom,
    splitViewAtom,
    wrapSignLines,
} from "./diffoptions";
import { activeReviewAtom, markState, noteOpenPair, pairHash, reviewMarksAtom, toggleOpenFile } from "./reviewmarks";
import { fmtBytes } from "./runcompletion";
import { SurfaceEmptyState } from "./surfacescaffold";

const MonacoDiffViewer = lazy(() => import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoDiffViewer })));

const headerBtn = "flex h-[28px] flex-none items-center gap-[6px] rounded-[8px] px-[10px] text-[11.5px] font-semibold";
const boxedBtn = cn(headerBtn, "border border-edge-mid");
const navBtn = "flex h-full w-[28px] flex-none items-center justify-center text-muted hover:text-ink-hi";

// monaco's own sign classes, so the pane's signs look like the unwrapped Diff surface's
const INSERT_SIGN = "insert-sign codicon codicon-diff-insert";
const DELETE_SIGN = "delete-sign codicon codicon-diff-remove";

function signAt(className: string) {
    return (line: number): MonacoTypes.editor.IModelDeltaDecoration => ({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        // first line only: a wrapped line gets one sign, on its first row
        options: { firstLineDecorationClassName: className },
    });
}

// With wrap, paneOptions turns monaco's indicators off (it repeats them on every wrapped row) and the
// pane signs each changed line once. Deleted lines in the unified view are monaco's view zones, which
// take no decorations, so only their band marks them.
function mountWrapSigns(diff: MonacoTypes.editor.IStandaloneDiffEditor): () => void {
    const inserted = diff.getModifiedEditor().createDecorationsCollection();
    const deleted = diff.getOriginalEditor().createDecorationsCollection();
    const refresh = () => {
        const model = diff.getModel();
        // read per update: the editor outlives a change of file, so the new-file state can change under it
        const newFile = model != null && isNewFile(model.original.getValue(), model.modified.getValue());
        const lines = wrapSignLines(diff.getLineChanges() ?? [], newFile);
        inserted.set(lines.inserted.map(signAt(INSERT_SIGN)));
        deleted.set(lines.deleted.map(signAt(DELETE_SIGN)));
    };
    const sub = diff.onDidUpdateDiff(refresh);
    refresh();
    return () => {
        sub.dispose();
        inserted.clear();
        deleted.clear();
    };
}

function PaneSkeleton() {
    return (
        <SkeletonRows className="min-h-0 flex-1 px-[20px] py-[14px]">
            {(i) => (
                <div key={i} className="mb-[10px] flex gap-[10px]">
                    <SkeletonLine className="h-[12px] w-[30px]" />
                    <SkeletonLine className="h-[12px] w-[72%]" />
                </div>
            )}
        </SkeletonRows>
    );
}

export function DiffPane({
    path,
    adds,
    dels,
    repoCwd,
    model,
    nothingToCompare = null,
    noCommit = false,
    lineCounts = true,
    source = diffSurfacePair,
    wrap = false,
}: {
    path: string | null;
    adds: number;
    dels: number;
    // false while git could not count lines: the header then draws no counts rather than +0 −0
    lineCounts?: boolean;
    repoCwd: string | null;
    model: AgentsViewModel;
    // compare's aggregate is selected and the two refs list no files
    nothingToCompare?: { base: string; head: string } | null;
    // no commit is open; the surface drops the commit pane, so this pane asks for one
    noCommit?: boolean;
    // the pair this pane shows: the Diff surface's unless a host keeps its own (the workspace pane's Changes tab)
    source?: DiffPairSource;
    // wrap long lines instead of scrolling sideways
    wrap?: boolean;
}) {
    const pair = useAtomValue(source.pairAtom);
    const failure = useAtomValue(source.failureAtom);
    const commentable = source === diffSurfacePair;
    const split = useAtomValue(splitViewAtom);
    const ignoreWs = useAtomValue(ignoreWsAtom);
    const navPos = useAtomValue(diffNavPosAtom);
    const active = useAtomValue(activeReviewAtom);
    const reviews = useAtomValue(reviewMarksAtom);
    const hostRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const el = hostRef.current;
        if (el == null) {
            return;
        }
        const ro = new ResizeObserver(() => setWidth(el.clientWidth));
        ro.observe(el);
        setWidth(el.clientWidth);
        return () => ro.disconnect();
    }, []);

    // every load of the open file's pair, the working-tree poll's refresh included: a changed pair is
    // what turns a mark stale when the file's counts did not move. The subject is a dependency because
    // the surface publishes it in its own effect, after this one has run on mount.
    const reviewSubject = active?.subject;
    const reviewOpen = active?.open;
    useEffect(() => {
        if (pair != null && reviewSubject != null && pair.path === reviewOpen) {
            noteOpenPair(reviewSubject, pair.path, pairHash(pair.original, pair.modified));
        }
    }, [pair, reviewSubject, reviewOpen]);

    // Re-find pending comments on every load of the pair, the poll's included: a deleted, binary or emptied
    // file loads with empty text and its comments go lost until text returns. A tooLarge pair is skipped,
    // since its text was never read rather than gone.
    const commentKey = useAtomValue(activeCommentSourceAtom)?.key;
    useEffect(() => {
        if (pair != null && commentKey != null && !pair.tooLarge) {
            relocateComments(commentKey, pair.path, pair.refs, { original: pair.original, modified: pair.modified });
        }
    }, [pair, commentKey]);

    const openChange = active?.open != null && active.open === path ? active.files.find((c) => c.path === path) : null;
    const reviewed = openChange != null && markState(reviews[active.subject], openChange) === "ok";
    const reviewTitle = reviewed ? "Unmark this file (v)" : "Mark reviewed and open the next file (v)";
    const layout = paneHeaderLayout(width);
    const splitShown = split && layout.split;
    const newFile = pair != null && isNewFile(pair.original, pair.modified);
    const options = useMemo(
        () => paneOptions(splitShown, ignoreWs, newFile, wrap),
        [splitShown, ignoreWs, newFile, wrap]
    );
    useEffect(() => {
        globalStore.set(commentSplitAtom, splitShown);
    }, [splitShown]);
    useEffect(() => {
        globalStore.set(splitAvailableAtom, layout.split);
    }, [layout.split]);
    const empty = emptyDiffState({ path, pair, nothingToCompare, noCommit, failure });

    const body = () => {
        if (empty) {
            return (
                <SurfaceEmptyState
                    data={{ "data-diff-empty": empty.kind }}
                    glyph={
                        <span className="mb-[12px] flex h-[28px] w-[28px] items-center justify-center rounded-[8px] border border-edge-mid bg-surface text-muted">
                            <FileText size={16} />
                        </span>
                    }
                    title={empty.title}
                    body={<span className="break-words">{empty.body}</span>}
                    action={
                        empty.kind === "failed"
                            ? {
                                  label: (
                                      <>
                                          <RotateCw size={13} />
                                          Retry
                                      </>
                                  ),
                                  onClick: () => fireAndForget(source.retry),
                                  data: { "data-diff-retry": "" },
                              }
                            : undefined
                    }
                />
            );
        }
        if (pair == null || pair.path !== path) {
            return <PaneSkeleton />;
        }
        return (
            <Suspense fallback={<PaneSkeleton />}>
                <MonacoDiffViewer
                    path={path}
                    original={pair.original}
                    modified={pair.modified}
                    options={options}
                    // publishes the editor so Shift+N / Shift+P can walk its hunks without focusing it,
                    // and mounts the comment layer on it
                    onMount={(diff, monacoApi) => {
                        setDiffNav(diff);
                        // comments anchor to the Diff surface's pair, so another source's editor draws none
                        const unmountComments = commentable ? mountCommentLayer(diff, monacoApi) : () => {};
                        const unmountSigns = wrap ? mountWrapSigns(diff) : () => {};
                        const update = () =>
                            globalStore.set(
                                diffNavPosAtom,
                                changePosition(
                                    (diff.getLineChanges() ?? []).map((c) => ({
                                        start: c.modifiedStartLineNumber,
                                        end: c.modifiedEndLineNumber,
                                    })),
                                    diff.getModifiedEditor().getPosition()?.lineNumber ?? 0
                                )
                            );
                        const subs = [
                            diff.onDidUpdateDiff(update),
                            diff.getModifiedEditor().onDidChangeCursorPosition(update),
                        ];
                        return () => {
                            subs.forEach((s) => s.dispose());
                            unmountComments();
                            unmountSigns();
                            clearDiffNav(diff);
                            globalStore.set(diffNavPosAtom, null);
                        };
                    }}
                />
                {commentable ? <DiffCommentZones /> : null}
            </Suspense>
        );
    };

    const header = () => {
        const { dir, file } = splitRepoPath(path);
        return (
            <div
                data-diff-header
                className="flex h-[48px] flex-none items-center gap-[10px] border-b border-border pl-[18px] pr-[14px]"
            >
                <span className="flex min-w-0 items-baseline overflow-hidden font-mono text-[12.5px]">
                    {/* rtl truncates from the left, but alone it would move the directory's trailing "/"
                        to its front; the bdi keeps the text itself left-to-right */}
                    <span className="min-w-0 truncate text-muted [direction:rtl]">
                        <bdi dir="ltr">{dir}</bdi>
                    </span>
                    {/* never wider than the wrapper, so the directory beside it shrinks to nothing first and
                        the name truncates only once it is gone */}
                    <span
                        data-diff-filename
                        className="min-w-0 max-w-full flex-none truncate font-semibold text-ink-hi"
                    >
                        {file}
                    </span>
                </span>
                {lineCounts ? (
                    <>
                        <span data-diff-adds className="flex-none font-mono text-[11px] font-bold text-diff-added">
                            +{adds}
                        </span>
                        <span data-diff-dels className="flex-none font-mono text-[11px] font-bold text-diff-removed">
                            −{dels}
                        </span>
                    </>
                ) : null}
                {empty?.kind === "toolarge" && pair != null ? (
                    <span className="flex-none font-mono text-[11px] text-muted">{fmtBytes(pair.size)}</span>
                ) : null}
                <div className="flex-1" />
                {navPos != null && navPos.total > 0 ? (
                    <div
                        data-diff-nav
                        role="group"
                        aria-label="Changes"
                        className="flex h-[28px] flex-none items-center overflow-hidden rounded-[8px] border border-edge-mid"
                    >
                        <button
                            onClick={() => gotoChange("previous")}
                            title="Previous change (⇧P)"
                            aria-label="Previous change (⇧P)"
                            className={navBtn}
                        >
                            <ChevronUp size={14} />
                        </button>
                        <span className="px-[6px] text-center font-mono text-[11px] text-muted">
                            {layout.labelled ? "change " : ""}
                            {navPos.index}/{navPos.total}
                        </span>
                        <button
                            onClick={() => gotoChange("next")}
                            title="Next change (⇧N)"
                            aria-label="Next change (⇧N)"
                            className={navBtn}
                        >
                            <ChevronDown size={14} />
                        </button>
                    </div>
                ) : null}
                {layout.split ? (
                    <div
                        role="group"
                        title="Unified / split (⇧D)"
                        className="flex h-[28px] flex-none overflow-hidden rounded-[8px] border border-edge-mid"
                    >
                        {[false, true].map((v) => (
                            <button
                                key={String(v)}
                                onClick={() => globalStore.set(splitViewAtom, v)}
                                aria-pressed={split === v}
                                className={cn(
                                    "px-[10px] text-[11.5px] font-semibold",
                                    split === v ? "bg-surface-selected text-ink-hi" : "text-muted hover:text-ink-hi"
                                )}
                            >
                                {v ? "Split" : "Unified"}
                            </button>
                        ))}
                    </div>
                ) : null}
                <button
                    onClick={() => globalStore.set(ignoreWsAtom, !ignoreWs)}
                    title="Hide whitespace (⇧W)"
                    aria-label="Hide whitespace (⇧W)"
                    aria-pressed={ignoreWs}
                    className={cn(
                        boxedBtn,
                        ignoreWs ? "border-accent/30 bg-accentbg text-ink-hi" : "text-ink-mid hover:text-ink-hi"
                    )}
                >
                    <Pilcrow size={13} />
                    {layout.labelled ? "Hide whitespace" : null}
                </button>
                {/* separates the view toggles from the file actions, each of which is conditional */}
                {repoCwd || openChange != null ? (
                    <span data-diff-header-divider className="h-[16px] w-px flex-none bg-edge-mid" />
                ) : null}
                {repoCwd && (
                    <button
                        onClick={() =>
                            fireAndForget(() =>
                                openInCode(model, {
                                    projectPath: repoCwd,
                                    rel: path,
                                    line: pair ? firstDifferingLine(pair.original, pair.modified) : undefined,
                                })
                            )
                        }
                        title="Open in Code (Enter)"
                        aria-label="Open in Code (Enter)"
                        className={cn(headerBtn, "text-ink-mid hover:text-ink-hi")}
                    >
                        <Code size={13} />
                        {layout.labelled ? "Open in Code" : null}
                    </button>
                )}
                {openChange != null ? (
                    <button
                        onClick={() => toggleOpenFile()}
                        title={reviewTitle}
                        aria-label={reviewTitle}
                        aria-pressed={reviewed}
                        data-review-open
                        className={cn(
                            boxedBtn,
                            reviewed ? "border-accent/30 bg-accentbg text-ink-hi" : "text-ink-mid hover:text-ink-hi"
                        )}
                    >
                        <Check size={13} className={reviewed ? "text-accent" : undefined} />
                        {layout.labelled ? (reviewed ? "Reviewed" : "Mark reviewed") : null}
                    </button>
                ) : null}
            </div>
        );
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            ref={hostRef}
            data-diff-pane
            data-diff-new-file={newFile || undefined}
        >
            {path ? header() : null}
            {body()}
        </motion.div>
    );
}
