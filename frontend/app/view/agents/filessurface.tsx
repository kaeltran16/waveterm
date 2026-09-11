// frontend/app/view/agents/filessurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Diff surface (Wave-git-review.dc.html): three panes on one time axis — commit history with a lane
// gutter (historypane), the selected commit's metadata + files (commitpane), and that file's diff
// (diffpane). Uncommitted work is row zero of the history, not a separate mode. Read-only.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { joinRepoPath } from "@/util/paths";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { MotionConfig } from "motion/react";
import { buildFilesBindings } from "@/app/store/keybindings/bindings";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useKeybindings } from "@/app/store/keybindings/store";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSyncMonacoTheme } from "@/app/monaco/monacotheme";
import { PopoverReveal } from "@/app/element/popoverreveal";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { DiffPane } from "./diffpane";
import type { CompareForm, DiffSelection } from "./diffcontent";
import { clearDiffPair, loadDiffPair } from "./diffcontentstore";
import { StatusDot } from "./statusdot";
import { filesErrorAtom, filesStateAtom, loadFilesForScope, startChangesPoll, type FilesProject } from "./filesstore";
import { availableRanges, historyOptsFor, rangeKey, scopeKey, summaryLine } from "./diffscope";
import { agentDiffScope, projectDiffScope } from "./agentdiffnav";
import { setDiffRange } from "./diffscopeatom";
import { historyCollapsedAtom, resolveCollapsed } from "./difflayout";
import { HistoryRail } from "./historyrail";
import { peekSessionStart } from "./agentsessionstore";
import { RangeStrip } from "./rangestrip";
import { projectsAtom } from "./projectsstore";
import { CommitPane } from "./commitpane";
import { AggregatePane } from "./aggregatepane";
import { CompareColumn } from "./comparecolumn";
import { AGGREGATE, buildCompareRows, compareNavIds, type CompareCommitRow } from "./comparerows";
import {
    compareActiveChangesAtom,
    compareAggregateAtom,
    compareBranchesAtom,
    compareErrorAtom,
    compareOnAtom,
    compareRefsAtom,
    compareSelectedFileAtom,
    compareSelectionAtom,
    compareSidesAtom,
    enterCompare,
    leaveCompare,
    selectCompareFile,
    selectCompareRow,
    setCompareForm,
    setCompareRefs,
} from "./comparestore";
import { RefPicker } from "./refpicker";
import {
    activeChangesAtom,
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
    refreshHistoryIfMoved,
    resetHistory,
    restoreNoticeAtom,
    retryHistory,
    selectCommit,
    selectCommitFile,
    selectedCommitAtom,
    selectedFileAtom,
    setHistoryOpts,
} from "./githistorystore";
import { GitFailurePanel, NotARepoPanel } from "./gitstatepanels";
import { HistoryFilterRow } from "./historyfilterrow";
import { HistoryPane } from "./historypane";
import { RESTORE_DISMISS_MS, countLabel } from "./historyquery";
import { WORKING_TREE } from "./historyrows";
import { SurfaceEmptyState, SurfaceError } from "./surfacescaffold";

// The Files surface can be scoped either to a running agent's worktree or to a registered project.
export type FilesSource = { kind: "agent"; id: string } | { kind: "project"; name: string };

// In-tab source selector: picks whose worktree the Files surface shows. Agents (with a state dot)
// write the shared focusIdAtom so a diff can be inspected without bouncing back to the Agent tab;
// registered projects (folder glyph) resolve straight from their registry path — no agent needed.
function SourcePicker({
    agents,
    projects,
    source,
    currentLabel,
    onPickAgent,
    onPickProject,
}: {
    agents: AgentVM[];
    projects: FilesProject[];
    source: FilesSource | null;
    // The stored scope's own label. A run is neither an agent nor a registered project, so without
    // this the picker would read "Select a source" while a run's diff is on screen.
    currentLabel?: string;
    onPickAgent: (id: string) => void;
    onPickProject: (p: FilesProject) => void;
}) {
    const [open, setOpen] = useState(false);
    const currentAgent = source?.kind === "agent" ? agents.find((a) => a.id === source.id) : undefined;
    const currentProject = source?.kind === "project" ? projects.find((p) => p.name === source.name) : undefined;
    const hasAny = agents.length > 0 || projects.length > 0;
    const fallback = hasAny ? "Select a source" : "No agents or projects";
    const label = currentAgent?.name ?? currentProject?.name ?? currentLabel ?? fallback;
    return (
        <div className="relative">
            <button
                data-files-source-picker
                onClick={() => setOpen((v) => !v)}
                disabled={!hasAny}
                className="flex w-full items-center gap-[8px] rounded-[9px] border border-border px-[10px] py-[7px] hover:border-edge-strong disabled:cursor-default disabled:opacity-60"
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
    const compareOn = useAtomValue(compareOnAtom);
    const compareRefs = useAtomValue(compareRefsAtom);
    const compareSides = useAtomValue(compareSidesAtom);
    const compareAggregate = useAtomValue(compareAggregateAtom);
    const compareSelection = useAtomValue(compareSelectionAtom);
    const compareFile = useAtomValue(compareSelectedFileAtom);
    const compareError = useAtomValue(compareErrorAtom);
    const compareBranches = useAtomValue(compareBranchesAtom);
    const compareChanges = useAtomValue(compareActiveChangesAtom);
    // the ref picker's own open/closed state: `c` and a click on the chip open it, Enter/Escape close it
    const [pickerOpen, setPickerOpen] = useState(false);

    // The history column folds to a rail below a width threshold. Measured on the surface root rather
    // than the window: the surface does not own the whole window, and the rail's whole purpose is to
    // leave the diff pane something to render in.
    const surfaceRef = useRef<HTMLDivElement>(null);
    const [surfaceWidth, setSurfaceWidth] = useState(0);
    const collapsed = resolveCollapsed(useAtomValue(historyCollapsedAtom), surfaceWidth);

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

    // The surface's stored subject: which repository, and which range within it.
    const scope = useAtomValue(model.diffScopeAtom);
    const origin = scope?.repo.origin;
    const agent = origin?.kind === "agent" ? agents.find((a) => a.id === origin.id) : undefined;
    const source: FilesSource | null =
        origin?.kind === "project"
            ? { kind: "project", name: origin.name }
            : origin?.kind === "agent"
              ? { kind: "agent", id: origin.id }
              : focusId
                ? { kind: "agent", id: focusId }
                : null;

    const pickAgent = (id: string) => {
        const a = agents.find((x) => x.id === id);
        globalStore.set(model.diffScopeAtom, agentDiffScope(id, a?.name ?? id));
        globalStore.set(model.focusIdAtom, id);
    };
    const pickProject = (p: FilesProject) => {
        globalStore.set(model.diffScopeAtom, projectDiffScope(p.name, p.path));
    };

    // Entering compare is a repo-scoped two-ref read, so it needs a cwd and a branch to start from.
    const startCompare = () => {
        if (!state?.cwd || !state.isRepo) {
            return;
        }
        setPickerOpen(true);
        fireAndForget(() => enterCompare(state.cwd!, state.branch ?? ""));
    };
    // The ref fields are this surface's own state; the range itself is restored by the store.
    const stopCompare = () => {
        setPickerOpen(false);
        leaveCompare();
    };

    // Follows the focused agent only while the stored repository IS an agent — pinning a project or
    // arriving from a run stops focus changes from moving the surface. This is the old
    // run-beats-project-beats-agent precedence, stated once, as data.
    useEffect(() => {
        if (scope != null && scope.repo.origin.kind !== "agent") {
            return;
        }
        if (!focusId) {
            return;
        }
        if (scope?.repo.origin.kind === "agent" && scope.repo.origin.id === focusId) {
            return;
        }
        const a = agents.find((x) => x.id === focusId);
        if (a == null) {
            return;
        }
        globalStore.set(model.diffScopeAtom, agentDiffScope(a.id, a.name));
    }, [focusId, scope, agents]);

    // Default to the first agent when nothing is scoped, so opening Files is immediately useful
    // instead of a dead "select a source" screen.
    useEffect(() => {
        if (scope == null && !focusId && agents.length > 0) {
            globalStore.set(model.focusIdAtom, agents[0].id);
        }
    }, [scope, focusId, agents]);

    // The surface unmounts on every nav switch; stamping the time on the way out is all it has to do.
    // The next history load decides whether anything is worth announcing (historyquery.restoreNotice).
    useEffect(() => () => noteSurfaceLeft(), []);

    // Keeps the change list from going stale while this surface is on screen; stops the moment it isn't.
    useEffect(() => startChangesPoll(), []);

    useEffect(() => {
        const el = surfaceRef.current;
        if (el == null) {
            return;
        }
        const ro = new ResizeObserver(() => setSurfaceWidth(el.clientWidth));
        ro.observe(el);
        setSurfaceWidth(el.clientWidth);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        if (restoreMsg == null) {
            return;
        }
        const t = setTimeout(() => dismissRestoreNotice(), RESTORE_DISMISS_MS);
        return () => clearTimeout(t);
    }, [restoreMsg]);

    // Which subject the surface is scoped to, in the same vocabulary filesstore's loader uses as its
    // guard token. Both the change-list load and the history load are keyed off this, so a deep link
    // built for one of them is claimable by the other.
    const loadScope = scope ? scopeKey(scope) : undefined;

    useEffect(() => {
        if (scope == null) {
            return;
        }
        fireAndForget(() =>
            loadFilesForScope(scope, { transcriptPath: agent?.transcriptPath, blockId: agent?.blockId })
        );
    }, [loadScope, agent?.transcriptPath, agent?.blockId]);

    // History follows whatever directory the change-list load resolved. The anchor and its labels are
    // derived from the range, and are pushed separately so switching range relabels without a re-read.
    useEffect(() => {
        // A null state means the change list is still loading, not that there is no repository here:
        // beginLoad() nulls it at the start of every load, including the one this surface fires on
        // every mount. Resetting on that transient would wipe the scroll offset, the filters and the
        // selection on every return to the surface — the exact state this surface exists to keep.
        if (state == null || scope == null) {
            return;
        }
        // A failed change-list read also lands here as isRepo:false, but a repository git cannot read
        // is not an absent one. Ask git for the history anyway: its refusal is what carries the real
        // message the failure panel shows.
        if (!state.cwd || (!state.isRepo && !loadError)) {
            resetHistory();
            return;
        }
        // loadScope names the subject this load is for, so it can claim a file an evidence card or an
        // agent's file rail asked for, once that scope's change set is in.
        fireAndForget(() => loadHistory(state.cwd, historyOptsFor(scope.range, state.ref), loadScope));
    }, [state?.cwd, state?.isRepo, state?.ref, loadScope, loadError]);

    useEffect(() => {
        if (scope == null || state == null) {
            return;
        }
        setHistoryOpts(historyOptsFor(scope.range, state.ref));
    }, [scope && rangeKey(scope.range), state?.ref]);

    // A commit landing under the open surface — an agent committing in the worktree this is scoped to,
    // or a commit made in another window — has to reach the commit column. The change-list poll above
    // is the only thing reading the repository on a timer, so HEAD rides along with it and this keys on
    // the sha: one log re-read per actual commit, nothing at all on a quiet tick. The store decides
    // whether the sha really moved, so the first value after a load is not a second read.
    useEffect(() => {
        refreshHistoryIfMoved(state?.head ?? "");
    }, [state?.head]);

    // Which range form the comparison is asking about. The scope is the one place that says so, which
    // is what keeps the file list and the diff pane from answering two different questions.
    const compareForm: CompareForm = scope?.range.kind === "compare" ? scope.range.form : "mergebase";

    // What the diff pane is showing. The header's +/- come from the row that is already loaded, so
    // opening a file costs no extra read.
    const shownPath = compareOn ? compareFile : selectedFile;
    const shownChanges = compareOn ? compareChanges : activeChanges;
    const selectedChange = shownChanges?.files.find((f) => f.path === shownPath) ?? null;
    // The working-tree side is live — an agent editing under this surface must not leave a stale diff
    // on screen. The change poll replaces filesStateAtom on every tick, so its identity IS the tick;
    // a commit or a comparison is immutable and stays out of the dep so it is read exactly once.
    const liveTick = !compareOn && selectedCommit === WORKING_TREE ? state : null;

    // publish the visible column's rows for global j/k list-nav. cursor == selection: moving selects,
    // which loads that row's files and first diff. Must run before the early return (hooks rules).
    const navIds = compareOn ? compareNavIds(compareRows) : (historyRows ?? []).map((r) => r.hash);
    const navCursor = compareOn ? compareSelection : (selectedCommit ?? undefined);
    const navFile = shownPath;
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
                          navFile && state.cwd ? () => getApi().openExternal(joinRepoPath(state.cwd!, navFile)) : undefined,
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

    // the diff pane is Monaco, which reads the same theme tokens the Code surface syncs
    useSyncMonacoTheme();

    // One place decides which two refs the pane reads; the three selection states differ only in
    // what they name, which is diffcontent.ts's whole job.
    useEffect(() => {
        const cwd = state?.cwd;
        if (!cwd || !shownPath) {
            clearDiffPair();
            return;
        }
        // In compare mode only the aggregate row means "the whole comparison"; a commit row there is
        // still one commit against its parent, exactly as in history.
        const sel: DiffSelection = compareOn
            ? compareSelection === AGGREGATE
                ? {
                      kind: "compare",
                      base: compareRefs?.base ?? "",
                      head: compareRefs?.head ?? "",
                      mergeBase: compareSides?.mergeBase ?? "",
                      form: compareForm,
                  }
                : { kind: "commit", hash: compareSelection ?? "" }
            : selectedCommit === WORKING_TREE
              ? { kind: "worktree", anchorRef: state?.ref ?? "" }
              : { kind: "commit", hash: selectedCommit ?? "" };
        fireAndForget(() => loadDiffPair(cwd, shownPath, sel));
    }, [
        state?.cwd,
        state?.ref,
        shownPath,
        compareOn,
        compareRefs?.base,
        compareRefs?.head,
        compareSides?.mergeBase,
        compareSelection,
        compareForm,
        selectedCommit,
        liveTick,
    ]);

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
            <div ref={surfaceRef} className="absolute inset-0 flex min-h-0 flex-col">
                {/* subject bar: which repository, and which range within it */}
                <div className="flex-none px-[18px] pt-[14px]">
                    <div className="flex items-center gap-[14px] pb-[6px]">
                        <h1 className="flex-none text-[16px] font-bold">Diff</h1>
                        <div className="w-[210px] rounded-[9px] border border-edge-mid bg-surface">
                            <SourcePicker
                                agents={agents}
                                projects={projects}
                                source={source}
                                currentLabel={scope?.repo.label}
                                onPickAgent={pickAgent}
                                onPickProject={pickProject}
                            />
                        </div>
                        {scope ? (
                            <RangeStrip
                                options={availableRanges(scope, {
                                    sessionStartTs: peekSessionStart(agent?.transcriptPath),
                                    sessionRef: state?.ref ?? "",
                                })}
                                active={scope.range}
                                onPick={(r) =>
                                    r.kind === "compare"
                                        ? startCompare()
                                        : compareOn
                                          ? (stopCompare(), setDiffRange(r))
                                          : setDiffRange(r)
                                }
                            />
                        ) : null}
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
                        ) : null}
                    </div>
                    {scope ? (
                        <div data-files-range-summary className="pb-[11px] font-mono text-[11.5px] text-ink-faint">
                            {summaryLine({
                                range: scope.range,
                                branch: state?.branch ?? "",
                                ref: state?.ref ?? "",
                                changes: activeChanges,
                                compareChanges,
                            })}
                        </div>
                    ) : null}
                </div>

                {restoreMsg ? (
                    <div
                        data-restore-notice
                        className="mx-[18px] mb-[10px] flex flex-none items-center gap-[9px] rounded-[8px] border border-success/25 bg-success/12 px-[11px] py-[7px]"
                    >
                        <span className="font-mono text-xxxs font-bold uppercase tracking-[0.1em] text-graphlane-2">
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

                {/* the detailed panel below says the same thing with git's own words behind it */}
                {loadError && historyFailure == null ? <SurfaceError message="Couldn’t read this repository." /> : null}

                {/* a broken read is checked first: it also reports isRepo:false, and showing it as an
                    absent repository would hide the reason behind a screen that reads like normality */}
                {historyFailure ? (
                    <GitFailurePanel failure={historyFailure} onRetry={() => retryHistory()} />
                ) : state?.isRepo === false && state?.cwd ? (
                    <NotARepoPanel />
                ) : (
                    <div className="flex min-h-0 flex-1 border-t border-edge-faint">
                        <div
                            className={cn(
                                "flex flex-none flex-col border-r border-edge-faint",
                                collapsed ? "w-[44px]" : "w-[460px]"
                            )}
                        >
                            {collapsed ? (
                                <HistoryRail
                                    // a compare commit row IS a HistoryRow, so the rail takes it directly
                                    rows={
                                        compareOn
                                            ? (compareRows.filter((r) => r.kind === "commit") as CompareCommitRow[])
                                            : (historyRows ?? [])
                                    }
                                    selected={compareOn ? compareSelection : selectedCommit}
                                    onSelect={(hash) =>
                                        state?.cwd &&
                                        fireAndForget(() =>
                                            compareOn
                                                ? selectCompareRow(state.cwd!, hash)
                                                : selectCommit(state.cwd!, hash)
                                        )
                                    }
                                    onExpand={() => globalStore.set(historyCollapsedAtom, false)}
                                />
                            ) : (
                                <>
                                    {/* mirrors the rail's expand affordance, so toggling shifts no rows */}
                                    <button
                                        onClick={() => globalStore.set(historyCollapsedAtom, true)}
                                        title="Collapse history"
                                        className="flex-none border-b border-edge-faint py-[6px] text-[11px] text-ink-faint hover:text-foreground"
                                    >
                                        ‹
                                    </button>
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
                                            // a filtered set mostly lacks its own parents, so lane assignment
                                            // would sprawl to the fold limit and draw edges to commits that
                                            // are not there
                                            graphOn={graphOn && !historyFiltered}
                                            loading={historyRows == null}
                                            countLabel={countLabel(
                                                historyFilters,
                                                historyRows?.length ?? 0,
                                                historyRows == null
                                            )}
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
                                </>
                            )}
                        </div>
                        <div className="flex w-[300px] flex-none flex-col border-r border-edge-faint bg-surface">
                            {compareOn ? (
                                compareSelection === AGGREGATE ? (
                                    <AggregatePane
                                        base={compareRefs?.base ?? ""}
                                        head={compareRefs?.head ?? ""}
                                        form={compareForm}
                                        changes={compareChanges}
                                        selectedFile={compareFile}
                                        onSelectFile={(path) => selectCompareFile(path)}
                                        onSetForm={(f) =>
                                            state?.cwd && fireAndForget(() => setCompareForm(state.cwd!, f))
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
                                        onSelectFile={(path) => selectCompareFile(path)}
                                    />
                                )
                            ) : (
                                <CommitPane
                                    row={selectedRow}
                                    changes={activeChanges}
                                    selectedFile={selectedFile}
                                    onSelectFile={(path) =>
                                        selectedCommit != null && selectCommitFile(selectedCommit, path)
                                    }
                                />
                            )}
                        </div>
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            <DiffPane
                                path={shownPath}
                                adds={selectedChange?.adds ?? 0}
                                dels={selectedChange?.dels ?? 0}
                                // "Open in editor" only makes sense for a path that exists in the working tree
                                editorCwd={!compareOn && selectedCommit === WORKING_TREE ? (state?.cwd ?? null) : null}
                                // "Open in Code" wants only the repository: the Code surface always shows the
                                // working-tree file, and says so itself when the path is gone
                                repoCwd={state?.cwd ?? null}
                                model={model}
                            />
                        </div>
                    </div>
                )}
            </div>
        </MotionConfig>
    );
}
