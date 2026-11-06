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
import { motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { DiffCommentZones } from "./diffcommentcard";
import { commentSplitAtom, mountCommentLayer } from "./diffcommentlayer";
import { activeCommentSourceAtom, relocateComments } from "./diffcomments";
import { firstDifferingLine } from "./diffcontent";
import { diffPairAtom, diffPairFailureAtom, retryDiffPair } from "./diffcontentstore";
import { emptyDiffState } from "./diffempty";
import { changePosition, clearDiffNav, diffNavPosAtom, gotoChange, setDiffNav } from "./diffnav";
import {
    ignoreWsAtom,
    isNewFile,
    paneHeaderLayout,
    paneOptions,
    splitAvailableAtom,
    splitViewAtom,
} from "./diffoptions";
import { activeReviewAtom, markState, noteOpenPair, pairHash, reviewMarksAtom, toggleOpenFile } from "./reviewmarks";
import { fmtBytes } from "./runcompletion";
import { SurfaceEmptyState } from "./surfacescaffold";

const MonacoDiffViewer = lazy(() => import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoDiffViewer })));

const headerBtn =
    "flex h-[28px] flex-none items-center gap-[6px] rounded-[8px] border border-edge-mid px-[10px] text-[11.5px] font-semibold";
const navBtn =
    "flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[6px] text-muted hover:text-ink-hi";

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
}) {
    const pair = useAtomValue(diffPairAtom);
    const failure = useAtomValue(diffPairFailureAtom);
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
    const options = useMemo(() => paneOptions(splitShown, ignoreWs, newFile), [splitShown, ignoreWs, newFile]);
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
                                  onClick: () => fireAndForget(retryDiffPair),
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
                        const unmountComments = mountCommentLayer(diff, monacoApi);
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
                            clearDiffNav(diff);
                            globalStore.set(diffNavPosAtom, null);
                        };
                    }}
                />
                <DiffCommentZones />
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
                    <div data-diff-nav className="flex flex-none items-center gap-[2px]">
                        <button
                            onClick={() => gotoChange("previous")}
                            title="Previous change (⇧P)"
                            aria-label="Previous change (⇧P)"
                            className={navBtn}
                        >
                            <ChevronUp size={14} />
                        </button>
                        <span className="text-center font-mono text-[11px] text-muted">
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
                        headerBtn,
                        ignoreWs ? "border-accent/30 bg-accentbg text-ink-hi" : "text-ink-mid hover:text-ink-hi"
                    )}
                >
                    <Pilcrow size={13} />
                    {layout.labelled ? "Hide whitespace" : null}
                </button>
                {openChange != null ? (
                    <button
                        onClick={() => toggleOpenFile()}
                        title={reviewTitle}
                        aria-label={reviewTitle}
                        aria-pressed={reviewed}
                        data-review-open
                        className={cn(
                            headerBtn,
                            reviewed ? "border-accent/30 bg-accentbg text-ink-hi" : "text-ink-mid hover:text-ink-hi"
                        )}
                    >
                        <Check size={13} />
                        {layout.labelled ? (
                            <>
                                {reviewed ? "Reviewed" : "Mark reviewed"}
                                <kbd className="font-mono text-[10.5px] text-ink-faint">v</kbd>
                            </>
                        ) : null}
                    </button>
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
