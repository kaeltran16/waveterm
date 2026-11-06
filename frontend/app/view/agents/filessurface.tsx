// frontend/app/view/agents/filessurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Diff surface (Wave-git-review.dc.html): three panes on one time axis — commit history with a lane
// gutter (historypane), the selected commit's metadata + files (commitpane), and that file's diff
// (diffpane). Uncommitted work is row zero of the history, not a separate mode. Read-only.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { RefreshCw, RotateCcw } from "lucide-react";
import { MotionConfig } from "motion/react";
import { buildFilesBindings } from "@/app/store/keybindings/bindings";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useKeybindings } from "@/app/store/keybindings/store";
import { useEffect, useMemo, useState } from "react";
import { useSyncMonacoTheme } from "@/app/monaco/monacotheme";
import { openInCode } from "@/app/view/code/codestore";
import type { AgentsViewModel } from "./agents";
import { formatAgo } from "./agentsviewmodel";
import { CommentSendBar } from "./commentsendbar";
import { DiffPane } from "./diffpane";
import { firstDifferingLine, type CompareForm, type DiffSelection } from "./diffcontent";
import { activeCommentSourceAtom, batchSourceFor } from "./diffcomments";
import { clearDiffPair, diffPairAtom, loadDiffPair } from "./diffcontentstore";
import {
    defaultFocusId,
    endedAgentScope,
    focusFollowAgent,
    sourceFor,
    subjectState,
    type FilesSource,
} from "./diffsource";
import {
    agentCwdOf,
    filesErrorAtom,
    filesRefreshFailedAtom,
    filesStateAtom,
    loadFilesForScope,
    reloadChanges,
    startChangesPoll,
    type FilesProject,
} from "./filesstore";
import { availableRanges, historyOptsFor, rangeKey, scopeKey, summaryLine } from "./diffscope";
import { agentDiffScope, projectDiffScope } from "./agentdiffnav";
import { setDiffRange } from "./diffscopeatom";
import { diffBody, filesSurfaceWidthAtom, historyCollapsedAtom, historyLayout } from "./difflayout";
import { HistoryRail } from "./historyrail";
import { peekSessionStart } from "./agentsessionstore";
import { RangeStrip } from "./rangestrip";
import { projectListAtom } from "./projectsstore";
import { CommitPane } from "./commitpane";
import { AggregatePane } from "./aggregatepane";
import { CompareColumn } from "./comparecolumn";
import { AGGREGATE, buildCompareRows, compareNavIds, type CompareCommitRow } from "./comparerows";
import {
    compareActiveChangesAtom,
    compareAggregateAtom,
    compareBranchesAtom,
    compareCommitFailureAtom,
    compareErrorAtom,
    compareHasRemoteAtom,
    compareOnAtom,
    compareRefsAtom,
    compareSelectedFileAtom,
    compareSelectionAtom,
    compareSidesAtom,
    dismissFetchFailure,
    enterCompare,
    fetchStateOf,
    fetchStatesAtom,
    leaveCompare,
    retryCompareRow,
    runFetch,
    selectCompareFile,
    selectCompareRow,
    setCompareForm,
    setCompareRefs,
    swapCompareRefs,
} from "./comparestore";
import { RefPicker } from "./refpicker";
import { activeReviewAtom, reviewSubjectFor } from "./reviewmarks";
import {
    activeChangesAtom,
    commitChangesFailureAtom,
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
    retrySelectedCommit,
    selectCommit,
    selectCommitFile,
    selectedCommitAtom,
    selectedFileAtom,
    setHistoryOpts,
    startFromTop,
} from "./githistorystore";
import { GitFailureColumn, GitFailureNotice, GitFailurePanel, NotARepoPanel, SurfaceBanner } from "./gitstatepanels";
import { HistoryPane } from "./historypane";
import { RESTORE_DISMISS_MS, countLabel } from "./historyquery";
import { WORKING_TREE, commitCount, worktreeCaption } from "./historyrows";
import { SourcePicker } from "./sourcepicker";
import { SurfaceEmptyState, SurfaceError, SurfaceToolbar, ToolbarFact } from "./surfacescaffold";

export function FilesSurface({ model }: { model: AgentsViewModel }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const projects: FilesProject[] = useAtomValue(projectListAtom);
    const state = useAtomValue(filesStateAtom);
    const loadError = useAtomValue(filesErrorAtom);
    const historyRows = useAtomValue(historyRowsAtom);
    const historyFailure = useAtomValue(historyFailureAtom);
    const fetchStates = useAtomValue(fetchStatesAtom);
    const fetchState = fetchStateOf(fetchStates, state?.cwd);
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
    const compareHasRemote = useAtomValue(compareHasRemoteAtom);
    const compareCommitFailure = useAtomValue(compareCommitFailureAtom);
    const commitFailure = useAtomValue(commitChangesFailureAtom);
    const refreshFailed = useAtomValue(filesRefreshFailedAtom);
    // the ref picker's own open/closed state: `c` and a click on the chip open it, Enter/Escape close it
    const [pickerOpen, setPickerOpen] = useState(false);

    // The history column folds to a rail below a width threshold. Measured on the surface root rather
    // than the window: the surface does not own the whole window, and the rail's whole purpose is to
    // leave the diff pane something to render in.
    // state, not a ref: the first render can be the empty state, which has no root to measure, so the
    // observer attaches whenever the root actually mounts (F7)
    const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
    const surfaceWidth = useAtomValue(filesSurfaceWidthAtom);
    const layout = historyLayout(useAtomValue(historyCollapsedAtom), surfaceWidth);

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
    const source: FilesSource | null = sourceFor(scope, focusId);

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

    // Both rules live in diffsource.ts: whether focus may move the surface, and what to show when
    // nothing has been picked yet. The effects are the only part that has to be an effect.
    useEffect(() => {
        const a = focusFollowAgent(scope, focusId, agents);
        if (a != null) {
            globalStore.set(model.diffScopeAtom, agentDiffScope(a.id, a.name));
        }
    }, [focusId, scope, agents]);

    useEffect(() => {
        const id = defaultFocusId(scope, focusId, agents);
        if (id != null) {
            globalStore.set(model.focusIdAtom, id);
        }
    }, [scope, focusId, agents]);

    // The surface unmounts on every nav switch; stamping the time on the way out is all it has to do.
    // The next history load decides whether anything is worth announcing (historyquery.restoreNotice).
    useEffect(() => () => noteSurfaceLeft(), []);

    // Keeps the change list from going stale while this surface is on screen; stops the moment it isn't.
    useEffect(() => startChangesPoll(), []);

    useEffect(() => {
        if (surfaceEl == null) {
            return;
        }
        const measure = () => globalStore.set(filesSurfaceWidthAtom, surfaceEl.clientWidth);
        const ro = new ResizeObserver(measure);
        ro.observe(surfaceEl);
        measure();
        return () => ro.disconnect();
    }, [surfaceEl]);

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
    // which commit pane 2 is showing: null for the working-tree row and compare's aggregate row
    const shownCommit = compareOn
        ? compareSelection === AGGREGATE
            ? null
            : compareSelection
        : selectedCommit === WORKING_TREE
          ? null
          : selectedCommit;
    const review = reviewSubjectFor(state?.cwd, scope?.range, shownCommit);

    // the `v` binding and the diff header act on the open file through this, not through the surface
    useEffect(() => {
        globalStore.set(
            activeReviewAtom,
            review == null || shownChanges == null
                ? null
                : {
                      subject: review,
                      files: shownChanges.files,
                      open: shownPath,
                      select: compareOn
                          ? selectCompareFile
                          : (path) => selectedCommit != null && selectCommitFile(selectedCommit, path),
                  }
        );
    }, [review, shownChanges, shownPath, compareOn, selectedCommit]);
    useEffect(() => () => globalStore.set(activeReviewAtom, null), []);

    // the pane and the send bar comment on this source without reaching into the surface; an ended agent
    // still publishes its key (cwd "") so its stored batch stays reachable. Keyed on the two roster
    // fields the source copies: any other roster tick must not republish it.
    const agentRunId = agent?.runId;
    const agentProject = agent?.project;
    const commentSource = useMemo(
        () => batchSourceFor(scope, state?.cwd, agent),
        [scope, state?.cwd, agent?.id, agentRunId, agentProject]
    );
    useEffect(() => {
        globalStore.set(activeCommentSourceAtom, commentSource);
    }, [commentSource]);
    useEffect(() => () => globalStore.set(activeCommentSourceAtom, null), []);

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
                      // the open file in Code at its first change, like the diff header's Open in Code
                      activate:
                          navFile && state.cwd
                              ? () => {
                                    const pair = globalStore.get(diffPairAtom);
                                    const line =
                                        pair?.path === navFile
                                            ? firstDifferingLine(pair.original, pair.modified)
                                            : undefined;
                                    fireAndForget(() =>
                                        openInCode(model, { projectPath: state.cwd!, rel: navFile, line })
                                    );
                                }
                              : undefined,
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
              ? { kind: "worktree", anchorRef: state?.ref ?? "", head: state?.head ?? "", end: state?.end ?? "" }
              : { kind: "commit", hash: selectedCommit ?? "" };
        fireAndForget(() => loadDiffPair(cwd, shownPath, sel, selectedChange?.from));
    }, [
        state?.cwd,
        state?.ref,
        state?.head,
        state?.end,
        shownPath,
        compareOn,
        compareRefs?.base,
        compareRefs?.head,
        compareSides?.mergeBase,
        compareSelection,
        compareForm,
        selectedCommit,
        selectedChange?.from,
        liveTick,
    ]);

    const subject = subjectState(scope, agents, projects);
    // a scope set by a link (a run's evidence) names its own repo, so it shows even with no agent or project
    if (subject === "empty") {
        return (
            <SurfaceEmptyState
                title="No changes to show"
                body="Start an agent or pick a project to see its changed files here."
                action={{ label: "New agent", onClick: () => globalStore.set(model.newAgentOpenAtom, true) }}
            />
        );
    }
    const ready = subject === "ready";
    const selectedRow = (historyRows ?? []).find((r) => r.hash === selectedCommit) ?? null;
    // a compare commit row *is* a HistoryRow, so the shipped commit pane takes it directly
    const compareCommit =
        (compareRows.find((r) => r.kind === "commit" && r.id === compareSelection) as CompareCommitRow | undefined) ??
        null;
    // with no commit open the commit pane would only repeat the diff pane's prompt, so it steps aside;
    // with no rows to pick from, the history column's own empty state is the only message
    const noCommit = compareOn ? compareSelection !== AGGREGATE && compareCommit == null : selectedRow == null;
    const canPick = (compareOn ? compareRows.length : (historyRows?.length ?? 0)) > 0;
    const collapseHistory = () => globalStore.set(historyCollapsedAtom, true);
    // the same click-through the bindings use to open the picker
    const chooseSource = () => document.querySelector<HTMLElement>("[data-files-source-picker]")?.click();
    const endedScope =
        subject === "ended" && origin?.kind === "agent" ? endedAgentScope(agentCwdOf(origin.id), projects) : null;
    const endedPath = endedScope?.repo.origin.kind === "project" ? endedScope.repo.origin.path : "";
    const body = diffBody(historyFailure != null, state);
    // compare reads no history, so a history failure has nothing to replace there
    const historyFailedInColumn = body === "history-failure-in-column" && !compareOn;

    const notReady = () =>
        subject === "pick" ? (
            <SurfaceEmptyState
                title="Pick something to review"
                body="Choose an agent or a project to see its changes."
                action={{ label: "Choose a source", onClick: chooseSource }}
            />
        ) : endedScope ? (
            <SurfaceEmptyState
                title="This agent has ended"
                body={`Its changes are in ${endedPath}.`}
                action={{ label: "Open its folder", onClick: () => globalStore.set(model.diffScopeAtom, endedScope) }}
            />
        ) : (
            <SurfaceEmptyState
                title="This agent has ended"
                body="Its folder was never read. Choose an agent or a project to see its changes."
                action={{ label: "Choose a source", onClick: chooseSource }}
            />
        );

    const historyPane = () => (
        <HistoryPane
            rows={historyRows ?? []}
            selected={selectedCommit}
            // a filtered set mostly lacks its own parents, so lane assignment would sprawl to the fold
            // limit and draw edges to commits that are not there
            graphOn={graphOn && !historyFiltered}
            loading={historyRows == null}
            countLabel={countLabel(historyFilters, commitCount(historyRows ?? []), historyRows == null)}
            filtered={historyFiltered}
            initialScroll={historyScroll}
            hasMore={historyHasMore}
            appendState={historyAppend}
            onSelect={(hash) => state?.cwd && fireAndForget(() => selectCommit(state.cwd!, hash))}
            onScroll={(top) => globalStore.set(historyScrollAtom, top)}
            onLoadMore={() => fireAndForget(() => loadMoreHistory())}
            onCollapse={collapseHistory}
        />
    );

    const historyColumn = () =>
        compareOn ? (
            <CompareColumn
                rows={compareRows}
                selected={compareSelection}
                mergeBase={compareSides?.mergeBase ?? ""}
                mergeBaseTs={compareSides?.mergeBaseTs ?? 0}
                onCollapse={collapseHistory}
                error={compareError}
                loading={compareSides == null && compareError == null}
                onSelect={(id) => state?.cwd && fireAndForget(() => selectCompareRow(state.cwd!, id))}
            />
        ) : historyFailedInColumn ? (
            // in place of the commit list; the working-tree row is the only row a failed read leaves, and with
            // no row the pane would read "No commits", which is not what happened
            <div className="flex min-h-0 flex-1 flex-col">
                <GitFailureColumn failure={historyFailure} onRetry={retryHistory} />
                {(historyRows?.length ?? 0) > 0 ? historyPane() : null}
            </div>
        ) : (
            historyPane()
        );

    const historyRail = () => (
        <HistoryRail
            // a compare commit row IS a HistoryRow, so the rail takes it directly
            rows={
                compareOn ? (compareRows.filter((r) => r.kind === "commit") as CompareCommitRow[]) : (historyRows ?? [])
            }
            selected={compareOn ? compareSelection : selectedCommit}
            onSelect={(hash) =>
                state?.cwd &&
                fireAndForget(() => (compareOn ? selectCompareRow(state.cwd!, hash) : selectCommit(state.cwd!, hash)))
            }
            expanded={layout === "overlay"}
            onToggle={() => globalStore.set(historyCollapsedAtom, layout === "overlay")}
            allChanges={compareOn}
            hasMore={!compareOn && historyHasMore && historyAppend !== "loading"}
            onLoadMore={() => fireAndForget(() => loadMoreHistory())}
        />
    );

    return (
        <MotionConfig reducedMotion="user">
            <div ref={setSurfaceEl} data-files-surface className="absolute inset-0 flex min-h-0 flex-col">
                {/* subject bar: which repository, and which range within it. The toolbar wraps because
                    compare adds two controls to it: at the shipped 1000x700 the ref picker's editing form
                    plus Fetch need more than one row, and a nowrap row pays for that by squeezing the
                    source picker from its 210px and pushing Fetch off the window edge. Wrapping costs a
                    second line only at the width that cannot hold one. The negative margins let these
                    33-38px controls overhang the toolbar's padding, so a single row stays 52px. */}
                <SurfaceToolbar
                    title="Diff"
                    actions={
                        scope && ready ? (
                            <>
                                {refreshFailed ? (
                                    <ToolbarFact>
                                        <span data-files-refresh-failed>couldn’t refresh · showing the last read</span>
                                    </ToolbarFact>
                                ) : null}
                                <ToolbarFact>
                                    <span data-files-range-summary className="truncate">
                                        {summaryLine({
                                            range: scope.range,
                                            branch: state?.branch ?? "",
                                            ref: state?.ref ?? "",
                                            mergeBase: compareSides?.mergeBase ?? "",
                                            commit: shownCommit,
                                            changes: shownChanges,
                                        })}
                                    </span>
                                </ToolbarFact>
                            </>
                        ) : null
                    }
                >
                    <div className="-my-[2px] w-[210px] rounded-[9px] bg-surface">
                        <SourcePicker
                            agents={agents}
                            projects={projects}
                            source={source}
                            currentLabel={scope?.repo.label}
                            onPickAgent={pickAgent}
                            onPickProject={pickProject}
                        />
                    </div>
                    {scope && ready ? (
                        <div className="-my-[2px]">
                            <RangeStrip
                                options={availableRanges(scope, {
                                    sessionStartTs: peekSessionStart(agent?.transcriptPath),
                                    sessionRef: state?.ref ?? "",
                                    isRepo: state?.isRepo !== false,
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
                        </div>
                    ) : null}
                    {compareOn && ready ? (
                        <div className="-my-[4px]">
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
                                onSwap={() => state?.cwd && fireAndForget(() => swapCompareRefs(state.cwd!))}
                            />
                        </div>
                    ) : null}
                    {/* a repository with no remote has nothing to fetch, and a change list still loading has
                        no folder to fetch in yet */}
                    {compareOn && ready && compareHasRemote && state?.cwd ? (
                        <div className="flex items-center gap-[7px]">
                            <button
                                data-files-fetch
                                onClick={() => state?.cwd && fireAndForget(() => runFetch(state.cwd!))}
                                disabled={fetchState.running}
                                title="Update remote-tracking refs"
                                className={cn(
                                    "flex flex-none items-center gap-[6px] rounded-[7px] border border-edge-mid px-[9px] py-[5px] text-[11.5px] font-semibold",
                                    fetchState.running
                                        ? "text-ink-faint opacity-50"
                                        : "text-ink-mid hover:border-edge-strong hover:text-foreground"
                                )}
                            >
                                <RefreshCw size={13} className={cn(fetchState.running && "animate-spin")} />
                                {fetchState.running ? "Fetching…" : "Fetch"}
                            </button>
                            {/* A remote-tracking ref is only as fresh as the last fetch, so the
                                clock is part of reading the comparison. Absent until one has
                                happened — "just now" on an unfetched session would be a lie. */}
                            {fetchState.at > 0 ? (
                                <span data-files-fetched className="font-mono text-[10.5px] text-muted">
                                    fetched {formatAgo(Date.now() - fetchState.at * 1000)}
                                </span>
                            ) : null}
                        </div>
                    ) : null}
                </SurfaceToolbar>

                {!ready ? (
                    <div className="flex min-h-0 flex-1 flex-col border-t border-edge-faint">
                        <div className="min-h-0 flex-1">{notReady()}</div>
                        {/* an ended agent's pending comments are still its batch to send */}
                        {subject === "ended" ? <CommentSendBar model={model} /> : null}
                    </div>
                ) : (
                    <>
                        {restoreMsg ? (
                            <SurfaceBanner
                                data-restore-notice
                                tone="neutral"
                                icon={<RotateCcw size={14} />}
                                action={{ label: "Start from the top", onClick: startFromTop }}
                                onDismiss={dismissRestoreNotice}
                            >
                                <span className="min-w-0 flex-1 truncate text-ink-hi">{restoreMsg}</span>
                            </SurfaceBanner>
                        ) : null}

                        {fetchState.failure ? (
                            <GitFailureNotice
                                title="Fetch failed"
                                note="showing refs as of the last fetch"
                                failure={fetchState.failure}
                                onRetry={() => state?.cwd && fireAndForget(() => runFetch(state.cwd!))}
                                onDismiss={() => state?.cwd && dismissFetchFailure(state.cwd)}
                            />
                        ) : null}

                        {/* git listed the working tree's files but one it could not read failed every line
                            count; the exit status is already inside git's text */}
                        {state?.numstatError ? (
                            <GitFailureNotice
                                title="Line counts unavailable"
                                note="the changed files are still listed"
                                failure={{ command: "git diff --numstat", exitcode: -1, stderr: state.numstatError }}
                                onRetry={() => fireAndForget(() => reloadChanges(state.cwd))}
                            />
                        ) : null}

                        {/* the detailed panel below says the same thing with git's own words behind it */}
                        {loadError && historyFailure == null ? (
                            <SurfaceError message="Couldn’t read this repository." />
                        ) : null}

                        {/* a folded column has no room for the failure, so it says so here and stays until the
                            read succeeds */}
                        {historyFailedInColumn && layout === "rail" ? (
                            <GitFailureNotice
                                title="Couldn’t read the history"
                                note="the working tree is still current"
                                failure={historyFailure}
                                onRetry={retryHistory}
                            />
                        ) : null}

                        {/* a broken read is checked first (diffBody): it also reports isRepo:false, and showing it
                            as an absent repository would hide the reason behind a screen that reads like normality */}
                        {body === "whole-body-failure" ? (
                            <GitFailurePanel failure={historyFailure} onRetry={() => retryHistory()} />
                        ) : body === "not-a-repo" ? (
                            <NotARepoPanel path={state.cwd} onChooseSource={chooseSource} />
                        ) : (
                            <div className="relative flex min-h-0 flex-1 border-t border-edge-faint">
                                <div
                                    className={cn(
                                        "flex flex-none flex-col border-r border-edge-faint",
                                        layout === "column" ? "w-[460px]" : "w-[44px]"
                                    )}
                                >
                                    {layout === "column" ? historyColumn() : historyRail()}
                                </div>
                                {/* below the collapse width an expanded history is drawn over the panes, so
                                    asking for it does not squeeze the diff pane to nothing */}
                                {layout === "overlay" ? (
                                    <div
                                        data-history-overlay
                                        className="absolute bottom-0 left-[44px] top-0 z-20 flex w-[460px] flex-col border-r border-edge-faint bg-background shadow-popover"
                                    >
                                        {historyColumn()}
                                    </div>
                                ) : null}
                                {noCommit ? null : (
                                    <div className="flex w-[300px] flex-none flex-col border-r border-edge-faint bg-surface">
                                        {compareOn ? (
                                            compareSelection === AGGREGATE ? (
                                                <AggregatePane
                                                    base={compareRefs?.base ?? ""}
                                                    head={compareRefs?.head ?? ""}
                                                    form={compareForm}
                                                    mergeBase={compareSides?.mergeBase ?? ""}
                                                    changes={compareChanges}
                                                    selectedFile={compareFile}
                                                    onSelectFile={(path) => selectCompareFile(path)}
                                                    onSetForm={(f) =>
                                                        state?.cwd && fireAndForget(() => setCompareForm(state.cwd!, f))
                                                    }
                                                    review={review}
                                                />
                                            ) : (
                                                <CommitPane
                                                    row={compareCommit}
                                                    changes={compareChanges}
                                                    selectedFile={compareFile}
                                                    onSelectFile={(path) => selectCompareFile(path)}
                                                    review={review}
                                                    failure={compareCommitFailure}
                                                    onRetry={() => state?.cwd && retryCompareRow(state.cwd)}
                                                />
                                            )
                                        ) : (
                                            <CommitPane
                                                row={selectedRow}
                                                caption={
                                                    scope && state
                                                        ? worktreeCaption(
                                                              scope.range,
                                                              state.branch,
                                                              state.head,
                                                              state.ref
                                                          )
                                                        : undefined
                                                }
                                                changes={activeChanges}
                                                selectedFile={selectedFile}
                                                onSelectFile={(path) =>
                                                    selectedCommit != null && selectCommitFile(selectedCommit, path)
                                                }
                                                review={review}
                                                // the working-tree row's list is the change list, which fails as a whole
                                                failure={selectedCommit === WORKING_TREE ? null : commitFailure}
                                                onRetry={retrySelectedCommit}
                                                lineCounts={selectedCommit !== WORKING_TREE || !state?.numstatError}
                                            />
                                        )}
                                    </div>
                                )}
                                <div className="isolate flex min-h-0 min-w-0 flex-1 flex-col">
                                    {noCommit && !canPick ? null : (
                                        <DiffPane
                                            path={shownPath}
                                            adds={selectedChange?.adds ?? 0}
                                            dels={selectedChange?.dels ?? 0}
                                            // "Open in Code" wants only the repository: the Code surface always shows
                                            // the working-tree file, and says so itself when the path is gone
                                            repoCwd={state?.cwd ?? null}
                                            nothingToCompare={
                                                compareOn &&
                                                compareSelection === AGGREGATE &&
                                                compareChanges != null &&
                                                compareChanges.files.length === 0
                                                    ? { base: compareRefs?.base ?? "", head: compareRefs?.head ?? "" }
                                                    : null
                                            }
                                            noCommit={noCommit}
                                            model={model}
                                        />
                                    )}
                                    <CommentSendBar model={model} />
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </MotionConfig>
    );
}
