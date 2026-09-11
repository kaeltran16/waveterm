// frontend/app/view/agents/diffpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pane 3 of the Diff surface. One Monaco diff editor for every state the surface has — the working
// tree, a commit, a comparison — because they differ only in which two refs feed it. Split is gated
// on the pane's own measured width rather than the window's: a collapsed history column at the
// shipped 1000x700 leaves enough room for unified and not for split.

import { MOTION } from "@/app/element/motiontokens";
import { SkeletonLine } from "@/app/element/skeleton";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { openInCode } from "@/app/view/code/codestore";
import { joinRepoPath } from "@/util/paths";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { firstDifferingLine } from "./diffcontent";
import { diffPairAtom } from "./diffcontentstore";
import { clearDiffNav, setDiffNav } from "./diffnav";
import { ignoreWsAtom, paneOptions, SPLIT_MIN_PX, splitViewAtom } from "./diffoptions";
import { fmtBytes } from "./runcompletion";

const MonacoDiffViewer = lazy(() => import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoDiffViewer })));

function Centered({ msg }: { msg: string }) {
    return (
        <div className="flex h-full items-center justify-center px-[20px] text-center text-[13px] text-muted">
            {msg}
        </div>
    );
}

function PaneSkeleton() {
    return (
        <div className="flex-1 overflow-hidden px-[20px] py-[14px]">
            {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="mb-[10px] flex gap-[10px]">
                    <SkeletonLine className="h-[12px] w-[30px]" />
                    <SkeletonLine className="h-[12px] w-[72%]" />
                </div>
            ))}
        </div>
    );
}

export function DiffPane({
    path,
    adds,
    dels,
    editorCwd,
    repoCwd,
    model,
}: {
    path: string | null;
    adds: number;
    dels: number;
    editorCwd: string | null;
    repoCwd: string | null;
    model: AgentsViewModel;
}) {
    const pair = useAtomValue(diffPairAtom);
    const split = useAtomValue(splitViewAtom);
    const ignoreWs = useAtomValue(ignoreWsAtom);
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

    const splitAvailable = width >= SPLIT_MIN_PX;
    const options = useMemo(() => paneOptions(split && splitAvailable, ignoreWs), [split, splitAvailable, ignoreWs]);

    const body = () => {
        if (!path) {
            return <Centered msg="Select a file to view its changes" />;
        }
        if (pair == null || pair.path !== path) {
            return <PaneSkeleton />;
        }
        if (pair.tooLarge) {
            return <Centered msg={`File too large to display (${fmtBytes(pair.size)}).`} />;
        }
        if (pair.binary) {
            return <Centered msg="Binary file — git reports a change but has no text to show." />;
        }
        if (pair.original === pair.modified) {
            // a pure rename or a mode change: git listed the file, nothing inside it moved
            return <Centered msg="Nothing inside this file changed." />;
        }
        return (
            <Suspense fallback={<PaneSkeleton />}>
                <MonacoDiffViewer
                    path={path}
                    original={pair.original}
                    modified={pair.modified}
                    options={options}
                    // publishes the editor so Shift+N / Shift+P can walk its hunks without focusing it
                    onMount={(diff) => {
                        setDiffNav(diff);
                        return () => clearDiffNav(diff);
                    }}
                />
            </Suspense>
        );
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            ref={hostRef}
        >
            {path ? (
                <div className="flex flex-none items-center gap-[11px] border-b border-border px-[20px] py-[13px]">
                    <span className="min-w-0 truncate font-mono text-[13px] font-semibold">{path}</span>
                    <span className="flex-none font-mono text-[11px] font-bold text-success">+{adds}</span>
                    <span className="flex-none font-mono text-[11px] font-bold text-error">−{dels}</span>
                    <div className="flex-1" />
                    <button
                        onClick={() => splitAvailable && globalStore.set(splitViewAtom, !split)}
                        disabled={!splitAvailable}
                        title={splitAvailable ? "Toggle split view" : "Not enough room for split view"}
                        className={cn(
                            "flex-none rounded border border-border px-[11px] py-[6px] font-mono text-[11px]",
                            splitAvailable ? "text-ink-mid hover:text-foreground" : "text-ink-faint opacity-50"
                        )}
                    >
                        {split && splitAvailable ? "split" : "unified"}
                    </button>
                    <button
                        onClick={() => globalStore.set(ignoreWsAtom, !ignoreWs)}
                        title={
                            ignoreWs
                                ? "Showing the change without whitespace-only lines"
                                : "Ignore whitespace-only changes"
                        }
                        className={cn(
                            "flex-none rounded border border-border px-[11px] py-[6px] font-mono text-[11px]",
                            ignoreWs ? "text-ink-hi" : "text-ink-mid hover:text-foreground"
                        )}
                    >
                        {ignoreWs ? "ws ignored" : "ws shown"}
                    </button>
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
                            className="flex-none rounded border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                        >
                            Open in Code
                        </button>
                    )}
                    {editorCwd && (
                        <button
                            onClick={() => getApi().openExternal(joinRepoPath(editorCwd, path))}
                            className="flex-none rounded border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                        >
                            Open in editor ↗
                        </button>
                    )}
                </div>
            ) : null}
            {body()}
        </motion.div>
    );
}
