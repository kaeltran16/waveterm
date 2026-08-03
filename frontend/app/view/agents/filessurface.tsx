// frontend/app/view/agents/filessurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Diff surface (Wave-git-review.dc.html): three panes on one time axis — commit history with a lane
// gutter (historypane), the selected commit's metadata + files (commitpane), and that file's diff
// (CenterPane, below). Uncommitted work is row zero of the history, not a separate mode. Read-only.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { MotionConfig, motion } from "motion/react";
import { buildFilesBindings } from "@/app/store/keybindings/bindings";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useKeybindings } from "@/app/store/keybindings/store";
import { useEffect, useMemo, useState } from "react";
import { MOTION } from "@/app/element/motiontokens";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { SkeletonLine } from "@/app/element/skeleton";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { type DiffLine, type FileView } from "./gitdiff";
import { StatusDot } from "./statusdot";
import {
    filesErrorAtom,
    filesProjectSelAtom,
    filesStateAtom,
    loadFilesForAgent,
    loadFilesForProject,
    loadFilesForRun,
    type FilesProject,
} from "./filesstore";
import { runShortId } from "./runcompletion";
import { projectsAtom } from "./projectsstore";
import { CommitPane } from "./commitpane";
import { AggregatePane } from "./aggregatepane";
import { CompareColumn } from "./comparecolumn";
import { AGGREGATE, buildCompareRows, compareNavIds, type CompareCommitRow } from "./comparerows";
import {
    compareActiveChangesAtom,
    compareAggregateAtom,
    compareAnchorAtom,
    compareBranchesAtom,
    compareDiffAtom,
    compareErrorAtom,
    compareOnAtom,
    compareRefsAtom,
    compareSelectedFileAtom,
    compareSelectionAtom,
    compareSidesAtom,
    enterCompare,
    exitCompare,
    selectCompareFile,
    selectCompareRow,
    setCompareRefs,
} from "./comparestore";
import { RefPicker } from "./refpicker";
import {
    activeChangesAtom,
    activeDiffAtom,
    dismissRestoreNotice,
    graphOnAtom,
    historyAppendAtom,
    historyFailureAtom,
    historyFilteredAtom,
    historyFiltersAtom,
    historyHasMoreAtom,
    historyRowsAtom,
    historyScrollAtom,
    loadHistory,
    loadMoreHistory,
    noteSurfaceLeft,
    resetHistory,
    restoreNoticeAtom,
    retryHistory,
    selectCommit,
    selectCommitFile,
    selectedCommitAtom,
    selectedFileAtom,
} from "./githistorystore";
import { GitFailurePanel, NotARepoPanel } from "./gitstatepanels";
import { HistoryFilterRow } from "./historyfilterrow";
import { HistoryPane } from "./historypane";
import { RESTORE_DISMISS_MS, countLabel } from "./historyquery";
import { WORKING_TREE } from "./historyrows";
import { SurfaceEmptyState, SurfaceError } from "./surfacescaffold";

// Windows-only build: git reports repo-relative paths with forward slashes while cwd uses backslashes,
// so a raw `${cwd}/${path}` join is mixed-separator. Normalize the whole join to backslashes so
// open::that (ShellExecute) resolves it and a copied absolute path is a valid native Windows path.
function joinPath(cwd: string, rel: string): string {
    return `${cwd}/${rel}`.replace(/\//g, "\\");
}

// The Files surface can be scoped either to a running agent's worktree or to a registered project.
export type FilesSource = { kind: "agent"; id: string } | { kind: "project"; name: string };

// In-tab source selector: picks whose worktree the Files surface shows. Agents (with a state dot)
// write the shared focusIdAtom so a diff can be inspected without bouncing back to the Agent tab;
// registered projects (folder glyph) resolve straight from their registry path — no agent needed.
function SourcePicker({
    agents,
    projects,
    source,
    onPickAgent,
    onPickProject,
}: {
    agents: AgentVM[];
    projects: FilesProject[];
    source: FilesSource | null;
    onPickAgent: (id: string) => void;
    onPickProject: (p: FilesProject) => void;
}) {
    const [open, setOpen] = useState(false);
    const currentAgent = source?.kind === "agent" ? agents.find((a) => a.id === source.id) : undefined;
    const currentProject = source?.kind === "project" ? projects.find((p) => p.name === source.name) : undefined;
    const hasAny = agents.length > 0 || projects.length > 0;
    const label = currentAgent?.name ?? currentProject?.name ?? (hasAny ? "Select a source" : "No agents or projects");
    return (
        <div className="relative">
            <button
                data-files-source-picker
                onClick={() => setOpen((v) => !v)}
                disabled={!hasAny}
                className="flex w-full items-center gap-[8px] rounded border border-border px-[10px] py-[7px] hover:border-edge-strong disabled:cursor-default disabled:opacity-60"
            >
                {currentAgent ? (
                    <StatusDot state={currentAgent.state} className="!h-[7px] !w-[7px]" />
                ) : currentProject ? (
                    <span className="flex-none text-[11px] text-ink-faint">▪</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-ink-mid">{label}</span>
                {hasAny ? <span className="flex-none text-[10px] text-ink-faint">▾</span> : null}
            </button>
            {open && hasAny ? <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} /> : null}
            <PopoverReveal
                open={open && hasAny}
                origin="top"
                className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[280px] overflow-y-auto rounded border border-border bg-modalbg py-1 shadow-popover"
            >
                        {agents.length > 0 ? (
                            <div className="px-[10px] pb-[3px] pt-[5px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-faint">
                                Agents
                            </div>
                        ) : null}
                        {agents.map((a) => (
                            <button
                                key={a.id}
                                onClick={() => {
                                    onPickAgent(a.id);
                                    setOpen(false);
                                }}
                                className={cn(
                                    "flex w-full items-center gap-[8px] px-[10px] py-[7px] text-left hover:bg-surface-hover",
                                    source?.kind === "agent" && a.id === source.id ? "text-foreground" : "text-ink-mid"
                                )}
                            >
                                <StatusDot state={a.state} className="!h-[7px] !w-[7px]" />
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{a.name}</span>
                            </button>
                        ))}
                        {projects.length > 0 ? (
                            <div className="px-[10px] pb-[3px] pt-[7px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-faint">
                                Projects
                            </div>
                        ) : null}
                        {projects.map((p) => (
                            <button
                                key={p.name}
                                // agent names and project names can collide, and this dropdown renders
                                // both — a scenario needs to click a project by name, not by text match
                                data-files-source-option={p.name}
                                title={p.path}
                                onClick={() => {
                                    onPickProject(p);
                                    setOpen(false);
                                }}
                                className={cn(
                                    "flex w-full items-center gap-[8px] px-[10px] py-[7px] text-left hover:bg-surface-hover",
                                    source?.kind === "project" && p.name === source.name ? "text-foreground" : "text-ink-mid"
                                )}
                            >
                                <span className="flex-none text-[11px] text-ink-faint">▪</span>
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{p.name}</span>
                            </button>
                        ))}
            </PopoverReveal>
        </div>
    );
}

function EmptyCenter({ msg }: { msg: string }) {
    return <div className="flex h-full items-center justify-center text-[13px] text-muted">{msg}</div>;
}

function DiffSkeleton() {
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[14px] border-b border-edge-faint px-[20px] py-[8px]">
                <SkeletonLine className="h-[11px] w-[34px]" />
                <SkeletonLine className="h-[11px] w-[34px]" />
                <SkeletonLine className="h-[11px] w-[92px]" />
            </div>
            <div className="flex-1 overflow-hidden px-[20px] py-[14px]">
                {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="mb-[10px] flex gap-[10px]">
                        <SkeletonLine className="h-[12px] w-[30px]" />
                        <SkeletonLine className="h-[12px] w-[30px]" />
                        <SkeletonLine className="h-[12px] w-[72%]" />
                    </div>
                ))}
            </div>
        </div>
    );
}

function DiffRow({ line }: { line: DiffLine }) {
    if (line.kind === "hunk") {
        return <div className="bg-surface px-[20px] py-[2px] font-mono text-[11px] text-ink-mid">{line.text}</div>;
    }
    const tint =
        line.kind === "add"
            ? "color-mix(in srgb, var(--color-success) 12%, transparent)"
            : line.kind === "del"
              ? "color-mix(in srgb, var(--color-error) 12%, transparent)"
              : undefined;
    const textColor = line.kind === "add" ? "text-success" : line.kind === "del" ? "text-error" : "text-foreground";
    return (
        <div className="flex min-w-max" style={tint ? { background: tint } : undefined}>
            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{line.gOld}</span>
            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{line.gNew}</span>
            <span className={cn("w-[16px] flex-none text-center", textColor)}>{line.sign}</span>
            <span className={cn("whitespace-pre pr-[28px]", textColor)}>{line.text}</span>
        </div>
    );
}

function CenterPane({ path, view, cwd }: { path: string | null; view: FileView | null; cwd: string | null }) {
    return (
        <motion.div
            key={path ?? "__empty__"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
            {!path ? (
                <EmptyCenter msg="Select a file to view its changes" />
            ) : (
                <>
                    <div className="flex flex-none items-center gap-[11px] border-b border-border px-[20px] py-[13px]">
                        <span className="min-w-0 truncate font-mono text-[13px] font-semibold">{path}</span>
                        <div className="flex-1" />
                        <span className="flex-none font-mono text-[11px] text-ink-mid">Read-only</span>
                        {cwd && (
                            <button
                                onClick={() => getApi().openExternal(joinPath(cwd, path))}
                                className="flex-none rounded border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                            >
                                Open in editor ↗
                            </button>
                        )}
                    </div>
                    {view == null ? (
                        <DiffSkeleton />
                    ) : (
                        <>
                            {view.isDiff && (
                                <div className="flex flex-none items-center gap-[14px] border-b border-edge-faint px-[20px] py-[8px] font-mono text-[11px] font-bold">
                                    <span className="text-success">+{view.adds}</span>
                                    <span className="text-error">−{view.dels}</span>
                                    <span className="font-medium text-ink-mid">{view.hunkLabel}</span>
                                </div>
                            )}
                            <div className="min-h-0 flex-1 overflow-auto py-[8px] font-mono text-[12.5px] leading-[1.75]">
                                {view.lines.map((l, i) => (
                                    <DiffRow key={i} line={l} />
                                ))}
                            </div>
                        </>
                    )}
                </>
            )}
        </motion.div>
    );
}

export function FilesSurface({ model }: { model: AgentsViewModel }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const registry = useAtomValue(projectsAtom);
    const state = useAtomValue(filesStateAtom);
    const loadError = useAtomValue(filesErrorAtom);
    const historyRows = useAtomValue(historyRowsAtom);
    const historyFailure = useAtomValue(historyFailureAtom);
    const historyFiltered = useAtomValue(historyFilteredAtom);
    const historyFilters = useAtomValue(historyFiltersAtom);
    const historyScroll = useAtomValue(historyScrollAtom);
    const historyHasMore = useAtomValue(historyHasMoreAtom);
    const historyAppend = useAtomValue(historyAppendAtom);
    const restoreMsg = useAtomValue(restoreNoticeAtom);
    const selectedCommit = useAtomValue(selectedCommitAtom);
    const selectedFile = useAtomValue(selectedFileAtom);
    const graphOn = useAtomValue(graphOnAtom);
    const activeChanges = useAtomValue(activeChangesAtom);
    const activeDiff = useAtomValue(activeDiffAtom);
    const compareOn = useAtomValue(compareOnAtom);
    const compareRefs = useAtomValue(compareRefsAtom);
    const compareSides = useAtomValue(compareSidesAtom);
    const compareAggregate = useAtomValue(compareAggregateAtom);
    const compareSelection = useAtomValue(compareSelectionAtom);
    const compareFile = useAtomValue(compareSelectedFileAtom);
    const compareError = useAtomValue(compareErrorAtom);
    const compareBranches = useAtomValue(compareBranchesAtom);
    const compareChanges = useAtomValue(compareActiveChangesAtom);
    const compareDiff = useAtomValue(compareDiffAtom);
    // the ref picker's own open/closed state: `c` and a click on the chip open it, Enter/Escape close it
    const [pickerOpen, setPickerOpen] = useState(false);

    // registered projects (name -> path) as a sorted, path-bearing list for the picker
    const projects: FilesProject[] = Object.entries(registry ?? {})
        .filter(([, v]) => v?.path)
        .map(([name, v]) => ({ name, path: v.path }))
        .sort((a, b) => a.name.localeCompare(b.name));

    // Rebuilt from the raw divergence on every render: buildCompareRows is pure and the input is at
    // most a few hundred commits, the same reasoning the history rows use.
    const compareRows = useMemo(
        () =>
            compareRefs == null
                ? []
                : buildCompareRows({
                      base: compareRefs.base,
                      head: compareRefs.head,
                      ahead: compareSides?.ahead ?? [],
                      behind: compareSides?.behind ?? [],
                      aggregate: compareAggregate,
                      now: Date.now(),
                  }),
        [compareRefs, compareSides, compareAggregate]
    );

    // A picked project overrides agent-focus scoping; null means "follow the focused agent".
    const projectSel = useAtomValue(filesProjectSelAtom);
    const setProjectSel = (p: FilesProject | null) => globalStore.set(filesProjectSelAtom, p);
    const runSource = useAtomValue(model.filesRunAtom);
    const agent = agents.find((a) => a.id === focusId);
    const source: FilesSource | null = projectSel
        ? { kind: "project", name: projectSel.name }
        : focusId
          ? { kind: "agent", id: focusId }
          : null;

    // The three scopes the surface already had, now named. Run wins, then a picked project, then the
    // focused agent — the same precedence the load effect below uses. Compare is a two-ref read of
    // the repo, so it reads as repo scope for as long as it is on.
    const scope: "run" | "repo" | "agent" = compareOn ? "repo" : runSource ? "run" : projectSel ? "repo" : "agent";
    const refExpr = runSource
        ? `${(runSource.baseCommit || "HEAD").slice(0, 7)} … HEAD`
        : scope === "agent" && state?.ref
          ? `session start ${state.ref.slice(0, 7)} … worktree`
          : `${state?.branch || "—"} · all refs`;

    // Which repository+run the surface is currently showing. Compare is anchored to one of these, and
    // leaves when it changes; comparing it to a stored anchor rather than keying an effect on cwd is
    // what lets compare survive the surface unmounting on a nav switch.
    const scopeAnchor = `${state?.cwd ?? ""}|${runSource?.runId ?? ""}`;

    // Entering compare is a repo-scoped two-ref read, so it needs a cwd and a branch to start from.
    const startCompare = () => {
        if (!state?.cwd || !state.isRepo) {
            return;
        }
        setPickerOpen(true);
        fireAndForget(() => enterCompare(state.cwd!, state.branch ?? "", scopeAnchor));
    };
    const leaveCompare = () => {
        setPickerOpen(false);
        exitCompare();
    };

    // Default to the first agent when nothing is scoped, so opening Files is immediately useful
    // instead of a dead "select a source" screen.
    useEffect(() => {
        if (!projectSel && !focusId && agents.length > 0) {
            globalStore.set(model.focusIdAtom, agents[0].id);
        }
    }, [projectSel, focusId, agents]);

    // The surface unmounts on every nav switch; stamping the time on the way out is all it has to do.
    // The next history load decides whether anything is worth announcing (historyquery.restoreNotice).
    useEffect(() => () => noteSurfaceLeft(), []);

    useEffect(() => {
        if (restoreMsg == null) {
            return;
        }
        const t = setTimeout(() => dismissRestoreNotice(), RESTORE_DISMISS_MS);
        return () => clearTimeout(t);
    }, [restoreMsg]);

    useEffect(() => {
        if (runSource) {
            fireAndForget(() => loadFilesForRun(runSource.runId, runSource.cwd, runSource.baseCommit));
        } else if (projectSel) {
            fireAndForget(() => loadFilesForProject(projectSel.name, projectSel.path));
        } else if (focusId) {
            fireAndForget(() => loadFilesForAgent(focusId, agent?.transcriptPath, agent?.blockId));
        }
    }, [runSource?.runId, runSource?.cwd, runSource?.baseCommit, projectSel?.name, projectSel?.path, focusId, agent?.transcriptPath, agent?.blockId]);

    // History follows whatever cwd the change-list load resolved, and anchors on the scope's base so
    // the session-start / run-base commit gets a labelled divider. rowLabel names what the synthetic
    // top row is counting: only repo scope reads the bare working tree, so the other two must say so.
    useEffect(() => {
        if (!state?.cwd || !state.isRepo) {
            resetHistory();
            return;
        }
        const anchor = runSource ? runSource.baseCommit : state.ref;
        fireAndForget(() =>
            loadHistory(state.cwd, {
                anchor: anchor || undefined,
                anchorLabel: runSource ? "run base" : anchor ? "session start" : undefined,
                rowLabel: runSource ? "Run changes" : anchor ? "Since session start" : undefined,
            })
        );
    }, [state?.cwd, state?.isRepo, state?.ref, runSource?.runId]);

    // A different repository (or entering a run) means different refs: keep compare from showing one
    // scope's divergence over another's. The guard is the anchor compare recorded when it was entered,
    // NOT the bare cwd — this effect also runs on every remount, and the surface unmounts on a nav
    // switch, so keying on cwd alone would tear down a compare the user is still using.
    useEffect(() => {
        const anchored = globalStore.get(compareAnchorAtom);
        if (anchored != null && anchored !== scopeAnchor) {
            exitCompare();
            setPickerOpen(false);
        }
    }, [scopeAnchor]);

    // publish the visible column's rows for global j/k list-nav. cursor == selection: moving selects,
    // which loads that row's files and first diff. Must run before the early return (hooks rules).
    const navIds = compareOn ? compareNavIds(compareRows) : (historyRows ?? []).map((r) => r.hash);
    const navCursor = compareOn ? compareSelection : (selectedCommit ?? undefined);
    const navFile = compareOn ? compareFile : selectedFile;
    const listNav = useMemo<ListNavController | null>(
        () =>
            state?.cwd && navIds.length > 0
                ? {
                      surface: "files",
                      navigableIds: navIds,
                      cursorId: navCursor,
                      setCursor: (id) =>
                          fireAndForget(() =>
                              compareOn ? selectCompareRow(state.cwd!, id) : selectCommit(state.cwd!, id)
                          ),
                      activate:
                          navFile && state.cwd ? () => getApi().openExternal(joinPath(state.cwd!, navFile)) : undefined,
                      // Tab needs to know which side a row belongs to, which an id list cannot say.
                      rows: compareOn ? compareRows : undefined,
                  }
                : null,
        [state?.cwd, compareOn, navIds.join(" "), navCursor, navFile, compareRows]
    );
    useSurfaceListNav(listNav);

    // stable array: every run() reads live atoms, so it never needs rebuilding
    const filesBindings = useMemo(() => buildFilesBindings(), []);
    useKeybindings(filesBindings);

    if (agents.length === 0 && projects.length === 0) {
        return (
            <SurfaceEmptyState
                title="No changes to show"
                body="Start an agent or pick a project to see its changed files here."
                action={{ label: "New agent", onClick: () => globalStore.set(model.newAgentOpenAtom, true) }}
            />
        );
    }
    const selectedRow = (historyRows ?? []).find((r) => r.hash === selectedCommit) ?? null;

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex min-h-0 flex-col">
                {/* subject bar: what am I looking at, and against what */}
                <div className="flex-none px-[18px] pt-[14px]">
                    <div className="flex items-center gap-[14px] pb-[11px]">
                        <h1 className="flex-none text-[16px] font-bold">Diff</h1>
                        <div className="flex items-center overflow-hidden rounded-[9px] border border-edge-mid bg-surface">
                            <div className="w-[210px] border-r border-edge-mid">
                                {runSource ? (
                                    <div className="flex items-center gap-[8px] px-[11px] py-[6px]">
                                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-mid">
                                            run {runShortId(runSource.runId)}
                                        </span>
                                        <button
                                            onClick={() => globalStore.set(model.filesRunAtom, null)}
                                            className="flex-none rounded border border-border px-[8px] py-[2px] text-[11px] text-ink-mid hover:text-foreground"
                                        >
                                            Exit
                                        </button>
                                    </div>
                                ) : (
                                    <SourcePicker
                                        agents={agents}
                                        projects={projects}
                                        source={source}
                                        onPickAgent={(id) => {
                                            setProjectSel(null);
                                            globalStore.set(model.focusIdAtom, id);
                                        }}
                                        onPickProject={(p) => setProjectSel(p)}
                                    />
                                )}
                            </div>
                            {(
                                [
                                    ["repo", "Repository", projectSel?.name ?? ""],
                                    ["agent", "Agent", agent?.name ?? ""],
                                    ["run", "Run", runSource ? runShortId(runSource.runId) : ""],
                                ] as const
                            ).map(([key, label, sub]) => (
                                <button
                                    key={key}
                                    // run scope and agent scope are single-ref reads by definition, so
                                    // picking one of them is a way out of compare
                                    onClick={() => {
                                        if (compareOn && key !== "repo") {
                                            leaveCompare();
                                        }
                                    }}
                                    className={cn(
                                        "flex items-center gap-[6px] border-r border-edge-faint px-[11px] py-[6px] text-[11.5px] font-semibold",
                                        scope === key ? "bg-surface-selected text-ink-hi" : "text-muted"
                                    )}
                                >
                                    {label}
                                    <span
                                        className={cn(
                                            "max-w-[90px] truncate font-mono text-[10.5px]",
                                            scope === key ? "text-accent-soft" : "text-edge-strong"
                                        )}
                                    >
                                        {sub}
                                    </span>
                                </button>
                            ))}
                        </div>
                        {compareOn ? (
                            <RefPicker
                                base={compareRefs?.base ?? ""}
                                head={compareRefs?.head ?? ""}
                                branches={compareBranches}
                                editing={pickerOpen}
                                onEdit={() => setPickerOpen(true)}
                                onApply={(b, h) => {
                                    setPickerOpen(false);
                                    if (state?.cwd) {
                                        fireAndForget(() => setCompareRefs(state.cwd!, b, h));
                                    }
                                }}
                                onCancel={() => setPickerOpen(false)}
                            />
                        ) : (
                            <button
                                data-files-ref-expr
                                onClick={startCompare}
                                disabled={!state?.cwd || !state.isRepo}
                                className="flex items-center gap-[8px] rounded-[9px] border border-edge-mid bg-surface px-[11px] py-[6px] hover:border-edge-strong disabled:cursor-default disabled:hover:border-edge-mid"
                            >
                                <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                                    Reading
                                </span>
                                <span className="font-mono text-[12px] text-ink-mid">{refExpr}</span>
                            </button>
                        )}
                    </div>
                </div>

                {restoreMsg ? (
                    <div
                        data-restore-notice
                        className="mx-[18px] mb-[10px] flex flex-none items-center gap-[9px] rounded-[8px] border border-success/25 bg-success/12 px-[11px] py-[7px]"
                    >
                        <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-graphlane-2">
                            Restored
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mid">{restoreMsg}</span>
                        <button
                            onClick={() => dismissRestoreNotice()}
                            className="flex-none text-[11px] text-ink-faint hover:text-foreground"
                        >
                            ✕
                        </button>
                    </div>
                ) : null}

                {/* nothing to filter in the two failure states, and compare has its own column */}
                {!compareOn && historyFailure == null && state?.isRepo !== false ? <HistoryFilterRow /> : null}

                {loadError ? <SurfaceError message="Couldn’t read this repository." /> : null}

                {state?.isRepo === false && state?.cwd ? (
                    <NotARepoPanel />
                ) : historyFailure ? (
                    <GitFailurePanel failure={historyFailure} onRetry={() => retryHistory()} />
                ) : (
                    <div className="flex min-h-0 flex-1 border-t border-edge-faint">
                        <div className="flex w-[460px] flex-none flex-col border-r border-edge-faint">
                            {compareOn ? (
                                <CompareColumn
                                    rows={compareRows}
                                    selected={compareSelection}
                                    mergeBase={compareSides?.mergeBase ?? ""}
                                    error={compareError}
                                    loading={compareSides == null && compareError == null}
                                    onSelect={(id) =>
                                        state?.cwd && fireAndForget(() => selectCompareRow(state.cwd!, id))
                                    }
                                />
                            ) : (
                                <HistoryPane
                                    rows={historyRows ?? []}
                                    selected={selectedCommit}
                                    // a filtered set mostly lacks its own parents, so lane assignment would
                                    // sprawl to the fold limit and draw edges to commits that are not there
                                    graphOn={graphOn && !historyFiltered}
                                    loading={historyRows == null}
                                    countLabel={countLabel(historyFilters, historyRows?.length ?? 0, historyRows == null)}
                                    filtered={historyFiltered}
                                    initialScroll={historyScroll}
                                    hasMore={historyHasMore}
                                    appendState={historyAppend}
                                    onSelect={(hash) =>
                                        state?.cwd && fireAndForget(() => selectCommit(state.cwd!, hash))
                                    }
                                    onScroll={(top) => globalStore.set(historyScrollAtom, top)}
                                    onLoadMore={() => fireAndForget(() => loadMoreHistory())}
                                />
                            )}
                        </div>
                        <div className="flex w-[300px] flex-none flex-col border-r border-edge-faint bg-surface">
                            {compareOn ? (
                                compareSelection === AGGREGATE ? (
                                    <AggregatePane
                                        base={compareRefs?.base ?? ""}
                                        head={compareRefs?.head ?? ""}
                                        changes={compareChanges}
                                        selectedFile={compareFile}
                                        onSelectFile={(path) =>
                                            state?.cwd && fireAndForget(() => selectCompareFile(state.cwd!, path))
                                        }
                                    />
                                ) : (
                                    // a compare commit row *is* a HistoryRow, so the shipped pane takes it directly
                                    <CommitPane
                                        row={
                                            (compareRows.find(
                                                (r) => r.kind === "commit" && r.id === compareSelection
                                            ) as CompareCommitRow | undefined) ?? null
                                        }
                                        changes={compareChanges}
                                        selectedFile={compareFile}
                                        onSelectFile={(path) =>
                                            state?.cwd && fireAndForget(() => selectCompareFile(state.cwd!, path))
                                        }
                                    />
                                )
                            ) : (
                                <CommitPane
                                    row={selectedRow}
                                    changes={activeChanges}
                                    selectedFile={selectedFile}
                                    onSelectFile={(path) =>
                                        state?.cwd &&
                                        selectedCommit != null &&
                                        fireAndForget(() => selectCommitFile(state.cwd!, selectedCommit, path))
                                    }
                                />
                            )}
                        </div>
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            <CenterPane
                                path={compareOn ? compareFile : selectedFile}
                                view={compareOn ? compareDiff : activeDiff}
                                // "Open in editor" only makes sense for a path that exists in the working tree
                                cwd={!compareOn && selectedCommit === WORKING_TREE ? (state?.cwd ?? null) : null}
                            />
                        </div>
                    </div>
                )}
            </div>
        </MotionConfig>
    );
}
