// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SkeletonLine } from "@/app/element/skeleton";
import { globalStore } from "@/app/store/jotaiStore";
import { openInCode } from "@/app/view/code/codestore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, ChevronDown, ChevronRight, ChevronUp, Code, FileText, Pilcrow, RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { agentDiffScope, openDiff } from "./agentdiffnav";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { DIFF_NOTES, DiffHunks } from "./diffhunks";
import { ignoreWsAtom } from "./diffoptions";
import { lineCountsShown, statusColor } from "./gitstatus";
import { useRailGit } from "./railgit";
import { loadRailForAgent } from "./railstore";
import { SurfaceEmptyState } from "./surfacescaffold";
import { changesLine, changesView, fileOpen, hunkWalk, type ChangesFile } from "./workspacechangesmodel";
import {
    changesAtAtom,
    changesGroupsFor,
    changesPatchAtom,
    changesScrollAtom,
    changesToggledAtom,
    clearChangesPatch,
    loadChangesPatch,
    openChangesFile,
    stepChangesHunk,
    toggleChangesFile,
} from "./workspacechangesstore";
import type { WorkspaceTab } from "./workspacemodel";

const LOADING_ROWS = 3;

// the header's buttons: borderless, one style
const barBtn =
    "inline-flex h-[28px] flex-none cursor-pointer items-center justify-center rounded-[8px] text-ink-mid hover:bg-surface-hover hover:text-ink-hi";

const emptyGlyph = (
    <span className="mb-[12px] flex h-[28px] w-[28px] items-center justify-center rounded-[8px] border border-edge-mid bg-surface text-muted">
        <FileText size={16} />
    </span>
);

const fileSelector = (path: string) => `[data-changes-file="${CSS.escape(path)}"]`;

// moves only the tab's own scroller (scrollIntoView would also move a clipping ancestor), landing the element under
// the sticky rows its scroll-margin names
function revealAtTop(scroller: HTMLElement | null, el: Element | null | undefined): void {
    if (scroller == null || el == null) {
        return;
    }
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin;
}

// the workspace pane's Changes tab: every changed file in one scroll, by folder, each a block of its hunks
export function ChangesTab({
    model,
    agent,
    tab,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "changes" }>;
}) {
    const rail = useRailGit(agent);
    // the Agent surface stays mounted under the others; off it, the tab does not read
    const onScreen = useAtomValue(model.surfaceAtom) === "agent";
    const ignoreWs = useAtomValue(ignoreWsAtom);
    const patch = useAtomValue(changesPatchAtom);
    const toggled = useAtomValue(changesToggledAtom(agent.id));
    const at = useAtomValue(changesAtAtom(agent.id));
    const scroll = useAtomValue(changesScrollAtom(agent.id));
    const scrollRef = useRef<HTMLDivElement>(null);
    // a step made before this mount was already scrolled to; only a new one scrolls
    const scrolledTo = useRef(scroll?.n);
    const view = changesView(rail);
    const groups = useMemo(() => changesGroupsFor(agent.id, rail, patch), [agent.id, rail, patch]);
    const total = useMemo(() => hunkWalk(groups).length, [groups]);
    const cwd = rail?.cwd;
    const failure = patch?.agentId === agent.id ? patch.failure : undefined;

    // rail is a dependency so the agent's next edit, which reloads the list, re-reads the patch too; the rail blanks
    // only for another agent's read, and so does the patch
    useEffect(() => {
        if (rail == null) {
            clearChangesPatch();
            return;
        }
        const { cwd, ref } = rail;
        if (onScreen && cwd && rail.isRepo && (rail.changes?.files.length ?? 0) > 0) {
            fireAndForget(() => loadChangesPatch(agent.id, cwd, ref ?? ""));
        }
    }, [onScreen, rail, ignoreWs, agent.id]);

    useEffect(() => {
        if (scroll == null || scroll.n === scrolledTo.current) {
            return;
        }
        scrolledTo.current = scroll.n;
        const el = scrollRef.current?.querySelector(
            `${fileSelector(scroll.path)} [data-changes-hunk="${scroll.hunk}"]`
        );
        revealAtTop(scrollRef.current, el);
    }, [scroll?.n]);

    const selected = groups.flatMap((g) => g.files).find((f) => f.change.path === tab.selected);
    useEffect(() => {
        if (selected == null) {
            return;
        }
        openChangesFile(agent.id, selected.change.path, selected.isNew);
        revealAtTop(scrollRef.current, scrollRef.current?.querySelector(fileSelector(selected.change.path)));
    }, [tab.selected, selected != null]);

    if (view === "failed" || view === "norepo" || view === "clean") {
        return <ChangesEmpty view={view} agent={agent} cwd={cwd} failure={rail?.failure} />;
    }
    const line = rail != null && view === "files" ? changesLine(rail) : null;
    const counted = lineCountsShown(rail?.changes);
    const retry = () => cwd && fireAndForget(() => loadChangesPatch(agent.id, cwd, rail?.ref ?? ""));
    return (
        <div data-workspace-changes className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-[44px] flex-none items-center gap-[2px] border-b border-border pl-[18px] pr-[10px] font-mono">
                {line != null ? (
                    <span
                        data-workspace-changes-line
                        className="flex min-w-0 flex-1 items-baseline gap-[8px] overflow-hidden whitespace-nowrap text-[11.5px]"
                    >
                        {/* the spaces between the spans are for copied text; a flex row draws none of them */}
                        <span className="flex-none text-ink-hi">{line.count}</span>{" "}
                        {counted ? (
                            <>
                                <span className="flex-none text-diff-added">+{line.adds}</span>{" "}
                                <span className="flex-none text-diff-removed">−{line.dels}</span>{" "}
                            </>
                        ) : null}
                        <span className="min-w-0 truncate text-muted">{line.where}</span>
                    </span>
                ) : (
                    <span className="flex-1">
                        <SkeletonLine className="h-[12px] w-[180px]" />
                    </span>
                )}
                {total > 0 ? (
                    <>
                        <button
                            type="button"
                            data-changes-prev
                            onClick={() => stepChangesHunk(agent.id, "previous")}
                            title="Previous change (⇧P)"
                            aria-label="Previous change (⇧P)"
                            className={cn(barBtn, "w-[26px]")}
                        >
                            <ChevronUp size={14} />
                        </button>
                        <span
                            data-changes-counter
                            aria-label={`Change ${Math.min(at, total)} of ${total}`}
                            className="min-w-[28px] flex-none text-center text-[11px] text-ink-mid"
                        >
                            {Math.min(at, total)}/{total}
                        </span>
                        <button
                            type="button"
                            data-changes-next
                            onClick={() => stepChangesHunk(agent.id, "next")}
                            title="Next change (⇧N)"
                            aria-label="Next change (⇧N)"
                            className={cn(barBtn, "w-[26px]")}
                        >
                            <ChevronDown size={14} />
                        </button>
                    </>
                ) : null}
                <button
                    type="button"
                    data-changes-ignore-ws
                    onClick={() => globalStore.set(ignoreWsAtom, !ignoreWs)}
                    title="Hide whitespace (⇧W)"
                    aria-label="Hide whitespace (⇧W)"
                    aria-pressed={ignoreWs}
                    className={cn(barBtn, "ml-[2px] w-[28px]", ignoreWs && "bg-accentbg text-ink-hi")}
                >
                    <Pilcrow size={13} />
                </button>
                <span className="mx-[6px] h-[16px] w-px flex-none bg-edge-mid" />
                <button
                    type="button"
                    data-workspace-open-diff
                    onClick={() => openDiff(model, agentDiffScope(agent.id, agent.name, agent.agent))}
                    className={cn(barBtn, "gap-[3px] px-[6px] text-[11px] font-semibold text-accent-soft")}
                >
                    Open on Diff
                    <ArrowUpRight size={11} aria-hidden />
                </button>
            </div>
            <div
                ref={scrollRef}
                data-workspace-changes-scroll
                className="min-h-0 flex-1 overflow-y-auto bg-surface-code pb-[16px]"
            >
                {failure != null ? (
                    <div
                        data-workspace-changes-patch-failed
                        className="m-[8px] flex items-center gap-[10px] rounded-[8px] border border-border bg-surface py-[6px] pl-[12px] pr-[6px] text-[12px]"
                    >
                        <span className="min-w-0 flex-1 break-words text-ink-mid">
                            <span className="text-error">Couldn’t read the diff.</span> {failure}
                        </span>
                        <button
                            type="button"
                            data-workspace-changes-patch-retry
                            onClick={retry}
                            className={cn(barBtn, "gap-[5px] px-[8px] text-[11.5px] font-semibold")}
                        >
                            <RotateCw size={13} />
                            Retry
                        </button>
                    </div>
                ) : null}
                {groups.map((g) => (
                    <div key={g.dir} data-changes-group={g.dir}>
                        {g.dir !== "" ? (
                            <div
                                data-changes-folder
                                className="sticky top-0 z-[3] flex h-[32px] items-center gap-[8px] bg-surface-code px-[18px] font-mono text-[11.5px]"
                            >
                                <span className="min-w-0 flex-1 truncate text-muted">{g.dir}/</span>
                                <span className="flex-none text-ink-faint">{g.count}</span>
                            </div>
                        ) : null}
                        {g.files.map((f) => (
                            <FileBlock
                                key={f.change.path}
                                model={model}
                                agentId={agent.id}
                                f={f}
                                open={fileOpen(f, toggled[f.change.path] ?? false)}
                                foldered={g.dir !== ""}
                                counted={counted}
                                failed={failure != null}
                                cwd={cwd}
                            />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

function FileBlock({
    model,
    agentId,
    f,
    open,
    foldered,
    counted,
    failed,
    cwd,
}: {
    model: AgentsViewModel;
    agentId: string;
    f: ChangesFile;
    open: boolean;
    foldered: boolean;
    counted: boolean;
    failed: boolean;
    cwd: string | null | undefined;
}) {
    const { adds, dels, status, path } = f.change;
    // a deleted file has no file on disk to open
    const codable = cwd && status !== "D";
    return (
        <div
            data-changes-file={path}
            data-changes-open={open || undefined}
            // clip, not hidden: a hidden overflow would make the block the header's sticky container. A jump lands
            // the block under the 32px folder label that sticks over it.
            className={cn(
                "mx-[8px] mb-[8px] overflow-clip rounded-[8px] border border-border",
                foldered && "scroll-mt-[32px]"
            )}
        >
            <div
                className={cn(
                    "sticky z-[2] flex h-[34px] items-center gap-[4px] bg-surface pr-[6px]",
                    foldered ? "top-[32px]" : "top-0"
                )}
            >
                <button
                    type="button"
                    data-changes-toggle
                    onClick={() => toggleChangesFile(agentId, path)}
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${f.name}`}
                    className="flex h-[34px] min-w-0 flex-1 cursor-pointer items-center gap-[8px] px-[10px] text-left font-mono"
                >
                    <ChevronRight
                        size={12}
                        aria-hidden
                        className={cn(
                            "flex-none text-muted transition-transform motion-reduce:transition-none",
                            open && "rotate-90"
                        )}
                    />
                    <span className={cn("w-[10px] flex-none text-[11px] font-bold", statusColor(f.letter))}>
                        {f.letter}
                    </span>
                    <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink-hi">{f.name}</span>
                    <span className="flex-1" />
                    {f.isNew && !open ? (
                        <span data-changes-new className="flex-none text-[11px] text-muted">
                            new file
                        </span>
                    ) : null}
                    {counted ? (
                        <>
                            <span className={cn("flex-none text-[11px]", adds > 0 ? "text-diff-added" : "text-muted")}>
                                +{adds}
                            </span>
                            <span
                                className={cn(
                                    "min-w-[24px] flex-none text-[11px]",
                                    dels > 0 ? "text-diff-removed" : "text-muted"
                                )}
                            >
                                −{dels}
                            </span>
                        </>
                    ) : null}
                </button>
                {codable ? (
                    <button
                        type="button"
                        data-changes-open-code
                        onClick={() =>
                            fireAndForget(() =>
                                openInCode(model, { projectPath: cwd, rel: path, line: f.hunks[0]?.newStart })
                            )
                        }
                        title="Open in Code"
                        aria-label="Open in Code"
                        className="inline-flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-[6px] text-muted hover:bg-surface-hover hover:text-ink-hi"
                    >
                        <Code size={13} />
                    </button>
                ) : null}
            </div>
            {open ? <FileBody f={f} foldered={foldered} failed={failed} /> : null}
        </div>
    );
}

function FileBody({ f, foldered, failed }: { f: ChangesFile; foldered: boolean; failed: boolean }) {
    if (f.body === "loading") {
        // a failed read has no rows to wait for: the band above says so, and the header alone draws
        return failed ? null : (
            <div
                data-changes-loading
                aria-hidden
                className="flex flex-col gap-[8px] border-t border-edge-faint px-[13px] py-[10px]"
            >
                {Array.from({ length: LOADING_ROWS }, (_, i) => (
                    <div key={i} className="flex gap-[10px]">
                        <SkeletonLine className="h-[12px] w-[28px]" />
                        <SkeletonLine className={cn("h-[12px]", i % 2 ? "w-[54%]" : "w-[72%]")} />
                    </div>
                ))}
            </div>
        );
    }
    if (f.body !== "hunks") {
        return (
            <div
                data-changes-note={f.body}
                className="border-t border-edge-faint px-[13px] py-[8px] font-mono text-[11.5px] text-muted"
            >
                {DIFF_NOTES[f.body]}
            </div>
        );
    }
    return (
        <div className="border-t border-edge-faint pb-[6px] pt-[4px]">
            {/* a jump lands the hunk under what sticks over it: the 34px file header, under a 32px folder label */}
            <DiffHunks hunks={f.hunks} hunkClassName={foldered ? "scroll-mt-[66px]" : "scroll-mt-[34px]"} />
        </div>
    );
}

function ChangesEmpty({
    view,
    agent,
    cwd,
    failure,
}: {
    view: "failed" | "norepo" | "clean";
    agent: AgentVM;
    cwd: string | null | undefined;
    failure: string | undefined;
}) {
    if (view === "failed") {
        return (
            <SurfaceEmptyState
                data={{ "data-workspace-changes-empty": view }}
                glyph={emptyGlyph}
                title="Couldn’t read the changed files"
                body={<span className="break-words">{failure}</span>}
                action={{
                    label: (
                        <>
                            <RotateCw size={13} />
                            Retry
                        </>
                    ),
                    onClick: () => fireAndForget(() => loadRailForAgent(agent.transcriptPath, agent.blockId)),
                    data: { "data-workspace-changes-retry": "" },
                }}
            />
        );
    }
    return (
        <SurfaceEmptyState
            data={{ "data-workspace-changes-empty": view }}
            glyph={emptyGlyph}
            title={view === "clean" ? "No changes" : "Not a git repository"}
            body={
                view === "clean" ? (
                    "The files this agent changes show here, each with its diff."
                ) : (
                    <span className="break-words">
                        {cwd
                            ? `${cwd} is not inside a git repository.`
                            : "The agent’s working folder is not known yet."}
                    </span>
                )
            }
        />
    );
}
