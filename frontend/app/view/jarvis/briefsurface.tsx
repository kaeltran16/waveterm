// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief: the queue-first Jarvis surface that replaces the Subjects · Stage · rail composition.
// Four bounded regions — waiting on you, initiatives, runs, behind you — over the briefing
// snapshot, under a header whose fleet line comes off the live agent roster.
//
// Two rules shape every region. Absence is a written sentence, never a heading over an empty frame:
// a region renders rows or it says what is not there, and the `empty` flag on Region makes that
// structural rather than a habit. And every count printed is the number of rows rendered beneath it,
// with whatever the projection's caps hid stated separately as "+N more" — so no line here can claim
// more work than the surface is showing.
//
// The record peek is here (BriefPeek, opened by a record oref) and the palette extends the app's own. Every
// row is one line that opens its sheet in a click (briefrows.ts), because the sheet is where the actions
// live; a region's overflow and its folded stale runs open in place. The steer-only composer lives in the
// run sheet's footer (briefcomposer.tsx).
//
// One presentation rule runs through the whole file and decides every border below: a bordered chip is
// the control recipe, a borderless one is a label. Dressing something inert as a control and camouflaging
// a real control among labels are the same lie, so neither happens here.
//
// This file is the wiring: the projection, the cursor and the composition. The regions draw themselves
// (briefwaiting, briefinitiatives, briefruns, briefbehind) from briefprimitives, under brieftoolbar; the
// writes and queue actions are briefmutations and briefqueueactions, and j/k is briefnav.

import { computeEntrances, initialEntranceState, MOTION, paneReveal } from "@/app/element/motiontokens";
import { Skeleton } from "@/app/element/skeleton";
import { globalStore } from "@/app/store/jotaiStore";
import { buildJarvisBindings } from "@/app/store/keybindings/bindings";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useKeybindings } from "@/app/store/keybindings/store";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { attentionAtom } from "@/app/view/agents/attentionstore";
import { channelsAtom, loadChannels } from "@/app/view/agents/channelsstore";
import { projectListAtom, projectsAtom } from "@/app/view/agents/projectsstore";
import { DagModal } from "@/app/view/orchestrate/dagmodal";
import { setDagModalAgentsContext } from "@/app/view/orchestrate/dagmodalstate";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BehindRegion } from "./briefbehind";
import { useBehindDwell } from "./briefdwell";
import { briefFleet } from "./brieffleet";
import { BRIEFING_FIXTURES } from "./briefingfixtures";
import {
    ackableRuns,
    buildAttentionQueue,
    capRegion,
    DELTA_CAP,
    effectiveCursor,
    EFFORT_CAP,
    groupDelta,
    initiativeWindow,
    projectBriefing,
    SEVEN_DAYS_MS,
    SHIPPED_CAP,
    withoutSettledChunks,
    type QueueRow,
} from "./briefingmodel";
import {
    briefingCursorAtom,
    briefingFixtureAtom,
    briefingStateAtom,
    briefRestoreConsumedAtom,
    loadBriefing,
    refreshBriefing,
} from "./briefingstore";
import { BriefChunkPane, InitiativesRegion } from "./briefinitiatives";
import {
    effortOps,
    initiativeLineId,
    moveToProjectItems,
    mutationRunner,
    openChunkInPlan,
    revealChanges,
    stepTarget,
    trackerEdits,
    type EffortWrites,
    type MutationDeps,
} from "./briefmutations";
import { briefListNav, cursorAction, resolveBriefCursor, runNavFold, runNavLines } from "./briefnav";
import { BriefPeek } from "./briefpeekview";
import { REGIONS, showInitiativeMenu, type RegionId } from "./briefprimitives";
import { BriefProfileModal } from "./briefprofileview";
import { ackAll, actOnQueue, openQueueRow, type QueueActionDeps } from "./briefqueueactions";
import { briefRestorePlan } from "./briefrestore";
import {
    behindGroups,
    capBehind,
    filterCount,
    filterLines,
    initiativeLine,
    initiativeProjects,
    initiativesMeta,
    keepsProject,
    keepsRunKind,
    kindLabels,
    lineKindCounts,
    liveRunKindCounts,
    projectCountLabels,
    queueLine,
    runKindCounts,
    runKindLegs,
    sessionLine,
    sessionWindow,
    SHIPPED_LABEL,
    sinceLabel,
    waitingSummary,
    workProjectCount,
    type BriefLine,
    type LineTarget,
    type RunKindFilter,
} from "./briefrows";
import { RunsRegion } from "./briefruns";
import { BriefSheet } from "./briefsheet";
import { REGION_LABEL } from "./briefstyle";
import { BriefToastView } from "./brieftoast";
import { BriefToolbar } from "./brieftoolbar";
import {
    briefUndo,
    chunkKey,
    effortKey,
    noteKey,
    pendingDeleteKeysAtom,
    settleChunk,
    settledChunksAtom,
} from "./briefundo";
import { WaitingRegion } from "./briefwaiting";
import { EffortCreateForm } from "./effortcreateform";
import { effortFeed, feedNoteCounts } from "./effortfeed";
import { buildEffortCard } from "./effortmodel";
import {
    addChunkAt,
    archivedEffortsAtom,
    deleteEffort,
    effortChunkRows,
    effortDetailAtom,
    effortLoadErrorAtom,
    loadArchivedEfforts,
    loadEffortDetail,
    moveChunk,
    moveChunkToStage,
    removeChunks,
    renameChunk,
    renameEffort,
    setChunkStage,
    setChunkStatus,
    setEffortProject,
    setEffortStatus,
    unarchiveEffort,
} from "./effortstore";
import { freshKeys } from "./freshrows";
import { type PeekFocus } from "./graphfocus";
import { GraphPeek } from "./graphpeek";
import { initiativeResume, type InitiativeResume } from "./initiativework";
import { workOnInitiative } from "./initiativeworkaction";
import { expandableORef, trackerNavIds, trackerRows, type DetailRow } from "./inlinetracker";
import type { TrackerEdits } from "./inlinetrackerview";
import {
    briefEffortIndexAtom,
    briefGraphRecordAtom,
    briefPeekRecordAtom,
    briefProfileAtom,
    briefRevealChunkAtom,
    briefRunListAtom,
    briefSheetOpenAtom,
    chunkMoveAtom,
    graphPeekOpenAtom,
    noteChunkAtom,
    readingNoteAtom,
} from "./jarvisstore";
import { clearSubject, persistedSubjectAtom, stageRunAtom } from "./jarvissubjectstore";
import { JiraCheckDialog } from "./jiracheckdialog";
import { openOrPeek, openOrPeekAddress } from "./openref";
import { LAND_TIMEOUT_MS } from "./petactrun";
import { dismissPetBubble } from "./petstore";
import { AVATAR_SURFACE_REACH_PX } from "./petview";
import { forgetOrigin } from "./returnsurface";
import { loadTaskList, taskListAtom } from "./tasksstore";

// module scope, not useState: a j/k cursor that reset on every glance at another surface would be worse
// than none.
// Cast per this repo's convention: under the pinned jotai, atom<T | undefined>(undefined) infers a
// read-only Atom, and the setter is only callable once it is a PrimitiveAtom.
const briefCursorAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

// The inline tracker's state, module scope for the cursor's reason: the Brief unmounts on every surface
// switch, and an initiative that silently re-collapsed while you were away would be worse than none.
// Keyed by BRIEF LINE id rather than oref, because the same effort can also sit in Behind you and only
// its Initiatives row expands.
const openInitiativeAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
const stageOverridesAtom = atom<Record<string, boolean>>({});

// Which regions the user has opened past their window. Module scope for the same reason as the cursor:
// the Brief unmounts on every surface switch, and a region that silently re-collapsed while you were
// reading a record would be worse than one that never opened.
const briefExpandedAtom = atom<Partial<Record<RegionId, boolean>>>({});

// Whether Runs shows its runs older than seven days, and Shipped its rows past the cap. Module scope for
// the same reason as the two above.
const briefStaleOpenAtom = atom(false);
const briefShippedOpenAtom = atom(false);

// which kind of run Runs and Shipped each show; module scope for the same reason
const briefRunKindAtom = atom<RunKindFilter>("all") as PrimitiveAtom<RunKindFilter>;
const briefShippedKindAtom = atom<RunKindFilter>("all") as PrimitiveAtom<RunKindFilter>;
// which project Initiatives shows, null for every one; module scope for the same reason
const briefInitiativeProjectAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// a stable empty list, so a region with no rows does not churn the memos that read it
const NO_LINES: BriefLine[] = [];

// the effortstore writes the mutation layer goes through, and the RPCs Waiting's in-place buttons send
const EFFORT_WRITES: EffortWrites = {
    setEffortStatus,
    setEffortProject,
    unarchiveEffort,
    deleteEffort,
    setChunkStatus,
    renameChunk,
    moveChunk,
    moveChunkToStage,
    removeChunks,
    setChunkStage,
    addChunkAt,
};
const QUEUE_RPC: QueueActionDeps["rpc"] = {
    dagAction: (data) => RpcApi.DagActionCommand(TabRpcClient, data),
    ackRun: (data) => RpcApi.AckRunCommand(TabRpcClient, data),
    setChunkStatus,
    landRun: (data) => RpcApi.LandRunCommand(TabRpcClient, data, { timeout: LAND_TIMEOUT_MS }),
};

export function BriefSurface({ model }: { model: AgentsViewModel }) {
    // the briefing pipeline, unchanged from briefingview: one load per entry, a dwell-gated visit ack,
    // the memoized projection, the DEV fixture seam, and the live attention read.
    const { snapshot, loading, error } = useAtomValue(briefingStateAtom);
    const fixture = useAtomValue(briefingFixtureAtom);
    const liveAgents = useAtomValue(model.agentsAtom);
    const liveAttention = useAtomValue(attentionAtom);

    useEffect(() => {
        loadBriefing();
    }, []);

    // DEV-only: the resource-linking scenario's seams (linkingdevhooks.ts)
    useEffect(() => {
        if (import.meta.env.DEV) {
            void import("./linkingdevhooks").then((m) => m.installLinkingDevHooks(model));
        }
    }, [model]);

    // The lists the Brief's boot restore validates against. Loaded here rather than inherited: in the Brief
    // composition the Subjects column does not mount, and that column is what loads both of these today.
    useEffect(() => {
        loadTaskList();
        loadChannels();
    }, []);

    // Boot restore, Brief edition. A stored record lands on the record peek; a stored channel is forgotten
    // (briefrestore.ts). One-shot: this
    // surface unmounts on every nav switch, and a restore that re-ran would re-open a peek the user had closed.
    const storedSubject = useAtomValue(persistedSubjectAtom);
    const channels = useAtomValue(channelsAtom);
    const dossiers = useAtomValue(taskListAtom);
    const [restoreConsumed, consumeRestore] = useAtom(briefRestoreConsumedAtom);

    useEffect(() => {
        if (restoreConsumed) {
            return;
        }
        const plan = briefRestorePlan(storedSubject, {
            channels: channels?.map((c) => c.oid) ?? null,
            dossiers: dossiers?.map((d) => d.id) ?? null,
        });
        if (plan.action === "wait") {
            return;
        }
        consumeRestore(true);
        if (plan.action === "record") {
            globalStore.set(briefPeekRecordAtom, plan.id);
            return;
        }
        globalStore.set(persistedSubjectAtom, null);
    }, [storedSubject, dossiers, channels, restoreConsumed, consumeRestore]);

    // the visit ack waits on Behind you being read, not loaded (briefdwell.ts)
    const setBehindEl = useBehindDwell(snapshot?.complete === true, snapshot?.queryStartedAt);

    const agents = fixture != null ? BRIEFING_FIXTURES[fixture].agents : liveAgents;
    // the plan-gate modal reads the roster out of this atom, and the Stage was its only writer
    useEffect(() => {
        setDagModalAgentsContext(model, agents);
    }, [model, agents]);
    // mark seen moves the visit cursor at once and the snapshot's on the reload, so Behind you reads the later
    // of the two. A fixture's window is its own: the visit cursor stored on this machine would empty it.
    const visitCursor = useAtomValue(briefingCursorAtom);
    const cursorTs =
        snapshot != null ? effectiveCursor(snapshot.actualCursor, fixture != null ? null : visitCursor) : 0;
    const model_ = useMemo(() => {
        if (snapshot == null) {
            return null;
        }
        return projectBriefing({
            state: snapshot.state,
            agents,
            actualCursor: cursorTs,
            queryStartedAt: snapshot.queryStartedAt,
            sevenDaysAgo: snapshot.queryStartedAt - SEVEN_DAYS_MS,
        });
    }, [snapshot, agents, cursorTs]);

    // a fixture seeds attention the same way it seeds the roster, so every fixture previews the queue.
    const attention = fixture != null ? BRIEFING_FIXTURES[fixture].attention : liveAttention;
    // the full projection, not the window: a blocked chunk on the seventh initiative is still waiting on
    // you, so the queue reads every effort even when the Initiatives region is only showing six. A chunk
    // Unblock or Done just settled is gone from this one list, so its Waiting row, the summary and its
    // initiative's "N blocked" agree before the snapshot catches up.
    const settled = useAtomValue(settledChunksAtom);
    const efforts = useMemo(
        () =>
            model_ != null && snapshot != null
                ? withoutSettledChunks(model_.efforts, settled, snapshot.queryStartedAt)
                : [],
        [model_, snapshot, settled]
    );
    // memoized because the j/k controller below is registered per identity: recomputing these every
    // render would re-register it every render. They are pure functions of the snapshot projection, so
    // pinning them to it also stops groupDelta's "now" drifting between renders of the same snapshot.
    const queue = useMemo(
        () => (model_ != null ? buildAttentionQueue({ attention, efforts, blockers: model_.blockers, agents }) : []),
        [model_, efforts, attention, agents]
    );

    // Each region opens at its cap and the region's own control opens the rest in place. The caps stay
    // display-side so the overflow count is what was actually hidden from the rows above it.
    // a search reaches every fold: a match hidden behind "+N more" would read as no match
    const [query, setQuery] = useState("");
    const filtering = query.trim() !== "";
    const [expanded, setExpanded] = useAtom(briefExpandedAtom);
    const toggleRegion = useCallback(
        (id: RegionId) => setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true })),
        [setExpanded]
    );
    const waitingOpen = expanded.waiting === true;
    const initiativesOpen = expanded.initiatives === true;
    const sessionsOpen = expanded.sessions === true;
    const behindOpen = expanded.behind === true;

    // archived initiatives come off the effort list, not the briefing, and show only on request
    const [showArchived, setShowArchived] = useState(false);
    const archivedSummaries = useAtomValue(archivedEffortsAtom);
    const archivedCards = useMemo(() => archivedSummaries.map(buildEffortCard), [archivedSummaries]);
    useEffect(() => {
        fireAndForget(loadArchivedEfforts);
    }, []);
    // the project filter narrows before the cap, so a project with older initiatives still fills the window
    const [pickedProject, setPickedProject] = useAtom(briefInitiativeProjectAtom);
    const projectCards = useMemo(
        () => (showArchived ? [...efforts, ...archivedCards] : efforts),
        [efforts, archivedCards, showArchived]
    );
    const projectOptions = useMemo(() => initiativeProjects(projectCards), [projectCards]);
    // while filtering, each chip counts the initiatives the filter keeps of its own
    const projectLabels = useMemo(
        () =>
            projectCountLabels(
                projectCards,
                filtering ? projectCards.filter((c) => filterLines([initiativeLine(c)], query).length > 0) : null
            ),
        [projectCards, filtering, query]
    );
    // a pick whose last initiative went away reads as every project rather than an empty region
    const project = pickedProject != null && projectOptions.includes(pickedProject) ? pickedProject : null;
    const projectEfforts = useMemo(() => efforts.filter((e) => keepsProject(project, e.project)), [efforts, project]);
    const effortWindow = useMemo(
        () => initiativeWindow(projectEfforts, EFFORT_CAP, initiativesOpen || filtering),
        [projectEfforts, initiativesOpen, filtering]
    );
    const archivedShown = useMemo(
        () => archivedCards.filter((c) => keepsProject(project, c.project)),
        [archivedCards, project]
    );
    const [runKind, setRunKind] = useAtom(briefRunKindAtom);
    const sessions = useMemo(
        () =>
            model_ == null
                ? { rows: [], more: 0 }
                : sessionWindow(runKindLegs(model_, runKind), sessionsOpen || filtering, Date.now()),
        [model_, sessionsOpen, runKind, filtering]
    );
    // the chips count what the head's "N live" counts; the stale fold states the rest. While filtering, each
    // counts its live lines the filter keeps, of every kind, since the chips are how you switch kind.
    const runCounts = useMemo(() => {
        const now = Date.now();
        const total = liveRunKindCounts(model_ ?? { activeRuns: [], directAgents: [] }, now);
        if (model_ == null || !filtering) {
            return kindLabels(total, null);
        }
        const live = sessionWindow(model_, true, now)
            .rows.map((r) => sessionLine(r, now))
            .filter((l) => !l.stale);
        return kindLabels(total, lineKindCounts(filterLines(live, query)));
    }, [model_, filtering, query]);
    // moment 1: which rows are new to YOU. Excludes `behind` deliberately — that region is entirely
    // since-your-last-visit by construction, so marking it would mark every row and its own label
    // already states the fact.
    const freshInitiatives = useMemo(
        () =>
            freshKeys(
                effortWindow.rows.map((e) => ({ key: e.oref, ts: e.updatedts })),
                cursorTs
            ),
        [effortWindow, cursorTs]
    );

    // moment 2: only ids that arrive while the snapshot's identity is unchanged animate in. A refresh
    // reseeds silently, which is what stops a whole-snapshot swap from firing N entrances at once; the
    // live attention poll still lands a new waiting row against an unchanged key. Committed in a layout
    // effect rather than during render because the render pass can run twice (motiontokens.ts).
    const entranceIds = [
        ...queue.map((q) => q.key),
        // every effort rather than the window: opening the region is not news arriving, so the rows it
        // adds must not animate in as if they had
        ...efforts.map((e) => e.oref),
        ...sessions.rows.map((r) => r.key),
    ];
    const entranceKey = snapshot?.queryStartedAt?.toString();
    const entranceRef = useRef(initialEntranceState());
    const { animate: entering } = computeEntrances(entranceRef.current, entranceKey, entranceIds);
    const entranceIdsKey = entranceIds.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, entranceKey, entranceIds).state;
    }, [entranceIdsKey, entranceKey]);

    // the whole delta, grouped: Behind you folds it before it caps it (capBehind)
    const deltaGroups = useMemo(() => groupDelta(model_?.delta ?? [], Date.now()), [model_]);

    // The filter and the one-region view narrow what is drawn, and the nav ids are the drawn lines' own, so
    // j/k can never land on a row the filter hid.
    const [only, setOnly] = useState<RegionId | null>(null);
    const [staleOpen, setStaleOpen] = useAtom(briefStaleOpenAtom);
    const toggleOnly = (id: RegionId) => setOnly((cur) => (cur === id ? null : id));
    const [shippedOpen, setShippedOpen] = useAtom(briefShippedOpenAtom);
    const [shippedKind, setShippedKind] = useAtom(briefShippedKindAtom);
    const shippedAll = useMemo(
        () => (model_?.shipped ?? []).filter((s) => keepsRunKind(shippedKind, s.mode)),
        [model_, shippedKind]
    );
    const shipped = useMemo(
        () => capRegion(shippedAll, SHIPPED_CAP, shippedOpen || filtering),
        [shippedAll, shippedOpen, filtering]
    );
    // a delete waiting out its undo window is already gone as far as the reader is concerned
    const pendingDeletes = useAtomValue(pendingDeleteKeysAtom);
    // leaving the Brief or the app inside the window still performs the delete the user did not undo;
    // beforeunload is best-effort, the RPCs are already in flight when the page goes
    useEffect(() => {
        const flush = () => void briefUndo.flushAll();
        window.addEventListener("beforeunload", flush);
        return () => {
            window.removeEventListener("beforeunload", flush);
            flush();
        };
    }, []);
    // Behind you folds a run into its initiative by title and names a row's project
    const effortIndex = useAtomValue(briefEffortIndexAtom);
    const projects = useAtomValue(projectsAtom);
    const projectList = useAtomValue(projectListAtom);
    const lines = useMemo(() => {
        const now = Date.now();
        // fold, filter, then cap: a filter still reaches every fold, and "+N more" counts lines, not events
        const behind = capBehind(
            behindGroups(deltaGroups, shipped.rows, now, { efforts: effortIndex, projects })
                .map((g) => ({ ...g, lines: filterLines(g.lines, query) }))
                .filter((g) => g.lines.length > 0),
            DELTA_CAP,
            behindOpen || filtering
        );
        return {
            waiting: filterLines(
                queue.map((q) => queueLine(q, now)),
                query
            ),
            initiatives: filterLines(
                [...effortWindow.rows, ...(showArchived ? archivedShown : [])]
                    .filter((r) => !pendingDeletes.has(effortKey(r.oref)))
                    .map(initiativeLine),
                query
            ),
            sessions: filterLines(
                sessions.rows.map((r) => sessionLine(r, now)),
                query
            ),
            behind: behind.groups,
            behindMore: behind.more,
        };
    }, [
        queue,
        effortWindow,
        showArchived,
        archivedShown,
        sessions,
        deltaGroups,
        shipped,
        query,
        pendingDeletes,
        effortIndex,
        projects,
        behindOpen,
        filtering,
    ]);
    // Waiting's card and head count the rows the filter keeps, "N of M" of the whole queue
    const waitingMatching = useMemo(() => {
        const ids = new Set(lines.waiting.map((l) => l.id));
        return queue.filter((q) => ids.has("waiting:" + q.key));
    }, [queue, lines.waiting]);
    const queueSummary = useMemo(
        () => waitingSummary(queue, waitingMatching, filtering, Date.now()),
        [queue, waitingMatching, filtering]
    );
    const waitingCount = queue.length > 0 ? filterCount(waitingMatching.length, queue.length, filtering) : undefined;
    // Shipped's kind chips: every shipped run, and while filtering the ones whose line the filter keeps
    const shippedCounts = useMemo(() => {
        const all = model_?.shipped ?? [];
        const total = runKindCounts(all.map((s) => s.mode));
        if (!filtering) {
            return kindLabels(total, null);
        }
        const shippedGroup = behindGroups([], all, Date.now(), { efforts: effortIndex, projects }).find(
            (g) => g.label === SHIPPED_LABEL
        );
        return kindLabels(total, lineKindCounts(filterLines(shippedGroup?.lines ?? NO_LINES, query)));
    }, [model_, filtering, query, effortIndex, projects]);
    const staleCount = lines.sessions.filter((l) => l.stale).length;
    const waitingShown = waitingOpen || filtering;
    const view = useMemo(() => {
        const shows = (id: RegionId) => only == null || only === id;
        // a search reaches the folded runs too: a match hidden behind the fold would read as no match
        const sessionLines = staleOpen || filtering ? lines.sessions : lines.sessions.filter((l) => !l.stale);
        const visible: BriefLine[] = [
            ...(shows("waiting") && waitingShown ? lines.waiting : []),
            ...(shows("initiatives") ? lines.initiatives : []),
            ...(shows("sessions") ? sessionLines : []),
            ...(shows("behind") ? lines.behind.flatMap((g) => g.lines) : []),
        ];
        return { shows, sessionLines, visible };
    }, [lines, only, staleOpen, filtering, waitingShown]);

    // --- inline tracker -----------------------------------------------------------------------------
    // The expanded initiative's plan is spliced into the SAME row list the cursor walks, so j/k falls
    // into the chunks and back out. A second ↑/↓ handler here would be a second cursor fighting the first.
    const [openInitiative, setOpenInitiative] = useAtom(openInitiativeAtom);
    const [stageOverrides, setStageOverrides] = useAtom(stageOverridesAtom);
    const [noteChunk, setNoteChunk] = useAtom(noteChunkAtom);
    const [readingNote, setReadingNote] = useAtom(readingNoteAtom);
    const effortCache = useAtomValue(effortDetailAtom);
    const expandedLine = view.visible.find((l) => l.id === openInitiative) ?? null;
    const openEffortORef = expandedLine != null ? expandableORef(expandedLine) : null;
    const openEffort = openEffortORef != null ? (effortCache.get(openEffortORef) ?? null) : null;
    // the freshest updatedts the app knows, so a chunk ticked by `wsh effort` out of band still refreshes
    const openCard = efforts.find((e) => e.oref === openEffortORef) ?? null;
    const openFreshTs = openCard?.updatedts;
    const loadPlan = useCallback(() => {
        if (openEffortORef != null) {
            fireAndForget(() => loadEffortDetail(openEffortORef, openFreshTs));
        }
    }, [openEffortORef, openFreshTs]);
    // a failure leaves the row expanded, drawing the load error and a Retry in place of the plan
    useEffect(loadPlan, [loadPlan]);
    const loadErrors = useAtomValue(effortLoadErrorAtom);
    const planLoadError =
        openEffortORef != null && openEffort == null ? (loadErrors.get(openEffortORef) ?? null) : null;

    const tracker = useMemo(() => {
        const feed =
            openEffort != null
                ? effortFeed(openEffort).filter(
                      (e) => !pendingDeletes.has(noteKey(openEffortORef ?? "", e.chunk, e.ts))
                  )
                : [];
        const rows = trackerRows({
            lines: view.visible,
            openLineId: openInitiative,
            chunks:
                openEffort != null
                    ? effortChunkRows(openEffort).filter(
                          (r) => !pendingDeletes.has(chunkKey(openEffortORef ?? "", r.label))
                      )
                    : null,
            noteCounts: feedNoteCounts(feed),
            stageOverrides,
        });
        return {
            rows,
            feed,
            navIds: trackerNavIds(rows),
            detail: rows.filter((r): r is DetailRow => r.kind !== "line"),
        };
    }, [view.visible, openInitiative, openEffort, openEffortORef, openCard, stageOverrides, pendingDeletes]);

    const [storedCursor, setStoredCursor] = useAtom(briefCursorAtom);
    const cursor = resolveBriefCursor(tracker.navIds, storedCursor);
    // cursor == selection: landing on a chunk is what shows its notes, so j/k reads the plan as it walks.
    const setCursor = useCallback(
        (id: string) => {
            setStoredCursor(id);
            if (id.includes("/chunk:")) {
                setNoteChunk(id);
                setReadingNote(new Set());
            }
        },
        [setStoredCursor, setNoteChunk, setReadingNote]
    );
    const selected = tracker.rows.find((r) => r.kind === "chunk" && r.id === noteChunk);
    const selectedChunk = selected?.kind === "chunk" ? selected : null;
    const closeNotes = useCallback(() => {
        setNoteChunk(null);
        setReadingNote(new Set());
    }, [setNoteChunk, setReadingNote]);

    const [mutateError, setMutateError] = useState<string | null>(null);
    const runMutation = useMemo(() => mutationRunner(setMutateError), []);

    // index math runs on the server's list, pending deletes included: the server still has them
    const planChunks = useMemo(() => (openEffort != null ? effortChunkRows(openEffort) : []), [openEffort]);
    // The rename field and Details belong to the initiative they were opened on: Details asked of an unloaded
    // initiative waits for its plan, and must not then show on another one. Keyed by line id, so the menu can
    // open the row and the form in one click; any change of the open initiative drops them.
    const [renaming, setRenaming] = useState<{ lineId: string; title: string } | null>(null);
    const [detailsFor, setDetailsFor] = useState<string | null>(null);
    useEffect(() => {
        setRenaming((cur) => (cur?.lineId === openInitiative ? cur : null));
        setDetailsFor((cur) => (cur === openInitiative ? cur : null));
    }, [openInitiative]);
    const renamingTitle = renaming != null && renaming.lineId === openInitiative ? renaming.title : null;
    const detailsOpen = detailsFor != null && detailsFor === openInitiative;
    const mutationDeps = useMemo<MutationDeps>(
        () => ({
            store: EFFORT_WRITES,
            undo: briefUndo,
            run: runMutation,
            setError: setMutateError,
            closeInitiative: (lineId) => setOpenInitiative((cur) => (cur === lineId ? null : cur)),
        }),
        [runMutation, setOpenInitiative]
    );
    const edits = useMemo<TrackerEdits | null>(() => {
        const oref = openEffortORef;
        if (oref == null || openEffort == null) {
            return null;
        }
        return trackerEdits(mutationDeps, {
            oref,
            effort: openEffort,
            chunks: planChunks,
            pendingDeletes,
            ui: {
                onRename: (title) => setRenaming({ lineId: initiativeLineId(oref), title }),
                onDetails: () => setDetailsFor(initiativeLineId(oref)),
                onActivity: (e) => fireAndForget(() => openOrPeekAddress(model, oref, e)),
                // lazy, so this file gains no import line beside the one the Check Jira toolbar adds
                onConnectJira: () =>
                    fireAndForget(() => import("./jiraactions").then((m) => m.openJiraSettings(model))),
            },
        });
    }, [model, openEffortORef, openEffort, planChunks, pendingDeletes, mutationDeps]);

    // Alt+↑/↓: published only while the cursor sits on a chunk of the open plan
    const setChunkMove = useSetAtom(chunkMoveAtom);
    useEffect(() => {
        const row = tracker.rows.find((r) => r.id === cursor);
        if (edits == null || row?.kind !== "chunk") {
            setChunkMove(null);
            return;
        }
        setChunkMove(() => (dir: "up" | "down") => edits.onMoveChunk(row.row.label, dir));
        return () => setChunkMove(null);
    }, [edits, cursor, tracker.rows, setChunkMove]);
    // the sidebar's ↑/↓ move the ONE Brief cursor, opening the target's stage if it is collapsed
    const stepTo = (dir: "prev" | "next"): (() => void) | null => {
        if (selectedChunk == null || openInitiative == null) {
            return null;
        }
        const to = stepTarget({
            chunks: planChunks,
            pendingDeletes,
            oref: selectedChunk.oref,
            lineId: openInitiative,
            label: selectedChunk.row.label,
            dir,
        });
        if (to == null) {
            return null;
        }
        return () => {
            setStageOverrides((cur) => ({ ...cur, [to.stageId]: true }));
            setCursor(to.cursorId);
        };
    };
    const sheetOpen = useAtomValue(briefSheetOpenAtom);
    // a click hands its event over, so Ctrl peeks the row's target instead
    const openLine = useCallback(
        (target: LineTarget, e?: React.MouseEvent) => {
            if (target == null) {
                return;
            }
            if ("queue" in target) {
                const queue = target.queue;
                fireAndForget(() =>
                    queue.kind === "channel"
                        ? openOrPeek(
                              model,
                              { kind: "channel", channelId: queue.channelId, runId: queue.runId ?? undefined },
                              e
                          )
                        : openOrPeekAddress(model, queue.oref, e)
                );
                return;
            }
            fireAndForget(() => openOrPeekAddress(model, target.oref, e));
        },
        [model]
    );
    const revealChunk = useCallback(
        (effortOref: string, chunk: string, notes = false) =>
            fireAndForget(() =>
                openChunkInPlan(
                    {
                        closeSheet: () => {
                            globalStore.set(briefSheetOpenAtom, false);
                            clearSubject();
                            forgetOrigin();
                        },
                        showInitiative: (oref) => {
                            const change = revealChanges({
                                oref,
                                live: efforts,
                                archived: archivedCards,
                                project,
                                windowORefs: effortWindow.rows.map((e) => e.oref),
                                query,
                                only,
                            });
                            if (change.clearProject) {
                                setPickedProject(null);
                            }
                            if (change.expandInitiatives) {
                                setExpanded((prev) => ({ ...prev, initiatives: true }));
                            }
                            if (change.showArchived) {
                                setShowArchived(true);
                            }
                            if (change.clearQuery) {
                                setQuery("");
                            }
                            if (change.clearOnly) {
                                setOnly(null);
                            }
                        },
                        openInitiative: setOpenInitiative,
                        setCursor,
                        loadPlan: async (oref) => {
                            await loadEffortDetail(oref);
                            const effort = globalStore.get(effortDetailAtom).get(oref);
                            return effort != null ? effortChunkRows(effort) : [];
                        },
                        pendingDeletes: () => globalStore.get(pendingDeleteKeysAtom),
                        openStage: (id) => setStageOverrides((cur) => ({ ...cur, [id]: true })),
                        openNotes: (id) => {
                            setNoteChunk(id);
                            setReadingNote(new Set());
                        },
                    },
                    effortOref,
                    chunk,
                    notes
                )
            ),
        [
            efforts,
            archivedCards,
            project,
            effortWindow,
            query,
            only,
            setPickedProject,
            setExpanded,
            setOpenInitiative,
            setCursor,
            setStageOverrides,
            setNoteChunk,
            setReadingNote,
        ]
    );
    const queueDeps: QueueActionDeps = {
        rpc: QUEUE_RPC,
        undo: briefUndo,
        openLine,
        openChunk: (oref, label) => revealChunk(oref, label, true),
        settle: settleChunk,
    };
    // Ctrl still peeks the initiative, as every other row's click does
    const openWaiting = (q: QueueRow, l: BriefLine, e?: React.MouseEvent) => {
        if (e?.ctrlKey) {
            openLine(l.target, e);
        } else {
            openQueueRow(queueDeps, q, l);
        }
    };
    const cursorRow = tracker.rows.find((r) => r.id === cursor) ?? null;
    const cursorTarget = cursorRow?.kind === "line" ? cursorRow.line.target : null;
    const toggleInitiative = useCallback(
        (lineId: string) => {
            setOpenInitiative((cur) => (cur === lineId ? null : lineId));
            setNoteChunk(null);
            setReadingNote(new Set());
        },
        [setOpenInitiative, setNoteChunk, setReadingNote]
    );
    // Enter's primary action, by what the cursor is on (briefnav.ts)
    const activateCursor = useCallback(() => {
        const act = cursorAction(cursorRow);
        if (act?.kind === "select-chunk") {
            setNoteChunk(act.id);
            setReadingNote(new Set());
        } else if (act?.kind === "toggle-initiative") {
            toggleInitiative(act.id);
        } else if (act?.kind === "open") {
            const q = cursorRow?.kind === "line" ? queue.find((r) => "waiting:" + r.key === cursorRow.line.id) : null;
            if (q != null && cursorRow?.kind === "line") {
                openWaiting(q, cursorRow.line);
            } else {
                openLine(act.target);
            }
        }
    }, [cursorRow, queue, openWaiting, openLine, setNoteChunk, setReadingNote, toggleInitiative]);
    const shippedLines = lines.behind.find((g) => g.label === SHIPPED_LABEL)?.lines ?? NO_LINES;
    const stageRun = useAtomValue(stageRunAtom);
    const runList = useAtomValue(briefRunListAtom);
    // The run sheet steps through every run the kind filter keeps, not only the drawn ones: Shipped past its cap,
    // and Runs' live rows past the cap and its stale ones. The query still applies, so every run it lands on can
    // be drawn by opening the fold that hides it.
    const runNavSource = useMemo(() => {
        if (model_ == null) {
            return { sessions: NO_LINES, shipped: NO_LINES };
        }
        const now = Date.now();
        const all = sessionWindow(runKindLegs(model_, runKind), true, now).rows.map((r) => sessionLine(r, now));
        const shippedGroup = behindGroups([], shippedAll, now, { efforts: effortIndex, projects }).find(
            (g) => g.label === SHIPPED_LABEL
        );
        return { sessions: filterLines(all, query), shipped: filterLines(shippedGroup?.lines ?? NO_LINES, query) };
    }, [model_, runKind, shippedAll, effortIndex, projects, query]);
    // with a run sheet open on the published run list, j/k step the sheet through that list (briefnav.ts)
    const runNav = useMemo(
        () =>
            runNavLines({
                sheetOpen,
                stageRun,
                runList,
                shippedLines: runNavSource.shipped,
                sessionLines: runNavSource.sessions,
            }),
        [sheetOpen, stageRun, runList, runNavSource]
    );
    // a landing on a run behind a fold opens that fold, so closing the sheet leaves the cursor on a drawn row
    const drawnRunIds = useMemo(
        () => new Set([...view.sessionLines, ...shippedLines].map((l) => l.id)),
        [view.sessionLines, shippedLines]
    );
    const revealRunLine = useCallback(
        (line: BriefLine) => {
            const fold = runNavFold(line, drawnRunIds);
            if (fold === "shipped") {
                setShippedOpen(true);
            } else if (fold === "stale") {
                setStaleOpen(true);
            } else if (fold === "more") {
                setExpanded((prev) => ({ ...prev, sessions: true }));
            }
        },
        [drawnRunIds, setShippedOpen, setStaleOpen, setExpanded]
    );
    // memoized because the controller is registered per identity. Typing never reaches here: list keys
    // are off in a field.
    useSurfaceListNav(
        useMemo<ListNavController>(
            () =>
                briefListNav({
                    runNav,
                    navIds: tracker.navIds,
                    cursor,
                    setCursor,
                    openLine,
                    revealLine: revealRunLine,
                    sheetOpen,
                    cursorRow,
                    activate: activateCursor,
                    cursorTarget,
                }),
            [
                runNav,
                tracker.navIds,
                cursor,
                setCursor,
                openLine,
                revealRunLine,
                sheetOpen,
                cursorRow,
                activateCursor,
                cursorTarget,
            ]
        )
    );
    // the four regions scroll as one column, so a cursor moved off-screen has to be brought back
    useEffect(() => {
        document.querySelector('[data-jarvis-brief-cursor="true"]')?.scrollIntoView({ block: "nearest" });
    }, [cursor]);

    const fleet = briefFleet(agents);

    // The profile modal is open on a project the palette can name, so it lives in jarvisstore. The detail
    // sheet draws the surface's active subject, so what is open lives in the subject store instead.
    const [profileTarget, setProfileTarget] = useAtom(briefProfileAtom);

    // The surface's own keys: the run switcher, the record band, the composer's i/Escape, and
    // the graph peek. The Stage used to register these for a composition that no longer exists.
    const jarvisBindings = useMemo(() => buildJarvisBindings(), []);
    useKeybindings(jarvisBindings);

    // Where the graph peek opens: the record the peek's map button named. The Brief has no Stage subject
    // and no thread, so with no record named the peek opens on nothing rather than guessing one.
    const graphRecord = useAtomValue(briefGraphRecordAtom);
    const graphOpen = useAtomValue(graphPeekOpenAtom);
    const graphFocus = useMemo<PeekFocus>(() => ({ dossierId: graphRecord ?? null, runORef: null }), [graphRecord]);
    // closing clears the explicit record too: leaving it set would re-centre every later open on a record
    // the user has moved on from
    const closeBriefGraph = () => {
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(briefGraphRecordAtom, null);
    };
    const projectCount = workProjectCount(snapshot?.state.projects?.map((p) => p.project) ?? [], projects ?? {});
    const initiativesHead = initiativesMeta(projectEfforts, Date.now());
    const liveN = view.sessionLines.filter((l) => !l.stale).length;

    // the run sheet mounts outside the Brief's snapshot, so the Brief publishes what its ↳ chunk line and
    // its n / N position read
    useEffect(() => {
        globalStore.set(
            briefEffortIndexAtom,
            new Map(
                [...efforts, ...archivedCards].map((e) => [
                    e.oref.replace(/^effort:/, ""),
                    { oref: e.oref, title: e.title, chunkStages: e.chunkStages, ticket: e.ticket ?? "" },
                ])
            )
        );
    }, [efforts, archivedCards]);
    // Work on reads the live initiatives only: an archived one is finished, so it offers nothing to resume
    const liveCards = useMemo(() => new Map(efforts.map((e) => [e.oref, e])), [efforts]);
    const cardOf = (l: BriefLine) =>
        l.target != null && "oref" in l.target ? liveCards.get(l.target.oref) : undefined;
    const resumeOf = (l: BriefLine): InitiativeResume | undefined => {
        const c = cardOf(l);
        return c != null ? initiativeResume(c.oref.replace(/^effort:/, ""), c.lastnote, agents, Date.now()) : undefined;
    };
    const showMenuFor = (l: BriefLine, ev: React.MouseEvent) => {
        const live = cardOf(l);
        const card =
            live ?? archivedCards.find((c) => l.target != null && "oref" in l.target && c.oref === l.target.oref);
        // rename and details live on the expanded row, so the menu opens it first
        const expand = () => {
            setCursor(l.id);
            if (openInitiative !== l.id) {
                toggleInitiative(l.id);
            }
        };
        showInitiativeMenu(l, ev, {
            openActivity: (oref) => openLine({ oref }),
            work: live != null ? () => void workOnInitiative(model, live) : undefined,
            rename: () => {
                expand();
                setRenaming({ lineId: l.id, title: l.title });
            },
            details: () => {
                expand();
                setDetailsFor(l.id);
            },
            status:
                card != null
                    ? { value: card.status, ops: effortOps(mutationDeps, card.oref, card.title, card.status) }
                    : undefined,
            move:
                card != null
                    ? moveToProjectItems(
                          mutationDeps,
                          card.oref,
                          card.project ?? "",
                          projectList.map((p) => p.name)
                      )
                    : undefined,
        });
    };
    useEffect(() => {
        globalStore.set(
            briefRunListAtom,
            stageRun != null && stageRun.status === "done"
                ? runNavSource.shipped.flatMap((l) =>
                      l.target != null && "oref" in l.target ? [l.target.oref.replace(/^run:/, "")] : []
                  )
                : runNavSource.sessions.flatMap((l) => (l.runOid ? [l.runOid] : []))
        );
    }, [stageRun, runNavSource]);

    const ackable = ackableRuns(queue);

    // the run sheet's ↳ chunk line reveals through the same handler, published because the sheet mounts
    // outside the Brief
    const setRevealChunk = useSetAtom(briefRevealChunkAtom);
    useEffect(() => {
        setRevealChunk(() => revealChunk);
        return () => setRevealChunk(null);
    }, [revealChunk, setRevealChunk]);
    const firstLoad = snapshot == null && loading;
    const loadFailed = snapshot == null && error != null;
    const staleSnapshot = snapshot != null && error != null;
    const missingLegs = model_?.health.missingLegs ?? [];
    // "Where we were" closes once the rows are in use, on input only: the cursor's own scrollIntoView scrolls the
    // container too, on mount and on every cursor move, and that is not the user moving on
    const dismissResume = () => dismissPetBubble("resume");

    return (
        <div data-jarvis-region="brief" className="absolute inset-0 flex flex-col bg-background">
            <BriefToolbar
                model={model}
                query={query}
                onQuery={setQuery}
                hits={view.visible.length}
                profileOpen={profileTarget != null}
                onOpenProfile={() => setProfileTarget("")}
                projectCount={projectCount}
                waiting={model_ != null ? queue.length : null}
                fleetLine={fleet.line}
            />
            {/* both bands push the surface down, so height belongs in the animation rather than a cut */}
            <AnimatePresence initial={false}>
                {staleSnapshot ? (
                    <motion.div
                        key="stale"
                        variants={paneReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        data-jarvis-brief-band="stale"
                        className="flex flex-none items-center gap-2 overflow-hidden border-b border-edge-faint px-[22px] py-1 font-mono text-[10.5px] text-error"
                    >
                        <X size={12} aria-hidden className="flex-none" />
                        refresh failed — showing the previous snapshot
                    </motion.div>
                ) : null}
                {missingLegs.length > 0 ? (
                    <motion.div
                        key="partial"
                        variants={paneReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        data-jarvis-brief-band="partial"
                        className="flex flex-none items-center gap-2 overflow-hidden border-b border-edge-faint px-[22px] py-1 font-mono text-[10.5px] text-asking"
                    >
                        <TriangleAlert size={12} aria-hidden className="flex-none" />
                        <span className="min-w-0 truncate">
                            Partial snapshot: couldn't read {missingLegs.join(", ")}. Behind you stays unread until a
                            full load.
                        </span>
                        <button
                            type="button"
                            data-jarvis-brief-partial-retry
                            onClick={refreshBriefing}
                            className="flex-none cursor-pointer text-accent-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            Retry
                        </button>
                    </motion.div>
                ) : null}
            </AnimatePresence>
            {/* @container, not a media query: the sidebar's width rule is about how much SURFACE the
                index has left, and the window is not the surface. */}
            <div className="@container relative flex min-h-0 flex-1">
                <div
                    data-jarvis-brief-scroll
                    // the pet sits over the bottom-right corner: the rows end with its reach of room, so any
                    // row-end control scrolls clear of it, and "Where we were" closes once the rows are in use
                    style={{ paddingBottom: AVATAR_SURFACE_REACH_PX + 20 }}
                    onWheel={dismissResume}
                    onTouchMove={dismissResume}
                    onPointerDown={dismissResume}
                    onKeyDown={dismissResume}
                    className={cn(
                        "flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-[22px] pt-5",
                        // the sidebar docks only in the wide band; below it, it floats over the index
                        selectedChunk != null && "@min-[1281px]:pr-[480px]"
                    )}
                    aria-live="polite"
                >
                    <AnimatePresence initial={false}>
                        {loadFailed ? (
                            <motion.div
                                key="load-error"
                                variants={paneReveal}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                data-jarvis-brief-state="error"
                                className="flex flex-col gap-2 overflow-hidden rounded-[10px] border border-border bg-surface px-4 py-3"
                            >
                                <span className="text-[13px] font-semibold text-ink-hi">
                                    Couldn't load your work state.
                                </span>
                                <span className="text-[12px] text-secondary">{error}</span>
                                <button
                                    type="button"
                                    onClick={refreshBriefing}
                                    className="mt-1 w-fit cursor-pointer rounded-[7px] border border-border bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    Retry
                                </button>
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                    {/* mode="wait" so the skeleton is gone before the regions arrive: the two cross-faded in
                    place would read as a double exposure of the same four headings. The skeleton blocks'
                    own animate-pulse is unchanged. */}
                    <AnimatePresence mode="wait" initial={false}>
                        {firstLoad ? (
                            <motion.div
                                key="skeleton"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                                data-jarvis-brief-state="loading"
                                className="flex min-h-0 flex-1 flex-col gap-[26px]"
                            >
                                {Object.entries(REGIONS).map(([id, r]) => (
                                    <div key={id} className="flex min-h-0 flex-1 flex-col gap-2">
                                        <span className={cn(REGION_LABEL, "text-feed-label")}>{r.label}</span>
                                        <Skeleton className="min-h-12 flex-1 rounded-[10px]" />
                                    </div>
                                ))}
                            </motion.div>
                        ) : null}
                        {model_ != null ? (
                            <motion.div
                                key="regions"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                                className="flex flex-col gap-[26px]"
                            >
                                {view.shows("waiting") ? (
                                    <WaitingRegion
                                        queue={queue}
                                        countLabel={waitingCount}
                                        lines={lines.waiting}
                                        summary={queueSummary}
                                        open={waitingOpen}
                                        shown={waitingShown}
                                        only={only === "waiting"}
                                        onOnly={() => toggleOnly("waiting")}
                                        onToggle={() => toggleRegion("waiting")}
                                        ackable={ackable.length}
                                        onAckAll={() => fireAndForget(() => ackAll(queueDeps, ackable))}
                                        entering={entering}
                                        cursor={cursor}
                                        onOpenRow={openWaiting}
                                        onAct={(q, l, act) => fireAndForget(() => actOnQueue(queueDeps, q, l, act))}
                                    />
                                ) : null}
                                {view.shows("initiatives") ? (
                                    <InitiativesRegion
                                        lines={lines.initiatives}
                                        empty={efforts.length === 0 && archivedCards.length === 0}
                                        missing={missingLegs.includes("Initiatives")}
                                        meta={initiativesHead}
                                        only={only === "initiatives"}
                                        onOnly={() => toggleOnly("initiatives")}
                                        projects={{
                                            options: projectOptions,
                                            labels: projectLabels,
                                            picked: project,
                                            onPick: setPickedProject,
                                        }}
                                        filtering={filtering}
                                        entering={entering}
                                        fresh={freshInitiatives}
                                        cursor={cursor}
                                        openInitiative={openInitiative}
                                        rename={
                                            renamingTitle != null && openInitiative != null
                                                ? {
                                                      title: renamingTitle,
                                                      onChange: (title) =>
                                                          setRenaming({ lineId: openInitiative, title }),
                                                      onCommit: () => {
                                                          const t = renamingTitle.trim();
                                                          setRenaming(null);
                                                          if (
                                                              t !== "" &&
                                                              openEffortORef != null &&
                                                              t !== openEffort?.title
                                                          ) {
                                                              runMutation(() => renameEffort(openEffortORef, t));
                                                          }
                                                      },
                                                      onCancel: () => setRenaming(null),
                                                  }
                                                : null
                                        }
                                        resumeOf={resumeOf}
                                        onWork={(l) => {
                                            const c = cardOf(l);
                                            if (c != null) {
                                                void workOnInitiative(model, c);
                                            }
                                        }}
                                        onContextMenu={showMenuFor}
                                        onOpen={(l) => {
                                            setCursor(l.id);
                                            toggleInitiative(l.id);
                                        }}
                                        edits={edits}
                                        detail={tracker.detail}
                                        onSelectChunk={(id) => {
                                            setCursor(id);
                                            setNoteChunk(id);
                                            setReadingNote(new Set());
                                        }}
                                        onToggleStage={(id, open) =>
                                            setStageOverrides((cur) => ({
                                                ...cur,
                                                [id]: open,
                                            }))
                                        }
                                        mutateError={mutateError}
                                        loadError={planLoadError}
                                        onRetryLoad={loadPlan}
                                        sidebarOpen={selectedChunk != null}
                                        more={effortWindow.more}
                                        expanded={initiativesOpen}
                                        onToggleMore={() => toggleRegion("initiatives")}
                                        archived={archivedShown.length}
                                        showArchived={showArchived}
                                        onToggleArchived={() => setShowArchived(!showArchived)}
                                    />
                                ) : null}
                                {view.shows("sessions") ? (
                                    <RunsRegion
                                        model={model}
                                        lines={view.sessionLines}
                                        empty={sessions.rows.length === 0}
                                        missing={missingLegs.includes("Runs")}
                                        runKind={runKind}
                                        onRunKind={setRunKind}
                                        runCounts={runCounts}
                                        liveN={liveN}
                                        only={only === "sessions"}
                                        onOnly={() => toggleOnly("sessions")}
                                        filtering={filtering}
                                        entering={entering}
                                        cursor={cursor}
                                        sheetOpen={sheetOpen}
                                        stageRunId={stageRun?.id}
                                        openLine={openLine}
                                        onOpenChunk={revealChunk}
                                        staleCount={staleCount}
                                        staleOpen={staleOpen}
                                        onToggleStale={() => setStaleOpen(!staleOpen)}
                                        more={sessions.more}
                                        expanded={sessionsOpen}
                                        onToggleMore={() => toggleRegion("sessions")}
                                    />
                                ) : null}
                                {view.shows("behind") ? (
                                    <BehindRegion
                                        sectionRef={setBehindEl}
                                        since={sinceLabel(
                                            cursorTs,
                                            snapshot?.queryStartedAt ?? Date.now(),
                                            visitCursor == null
                                        )}
                                        deltaTotal={model_.delta.length}
                                        only={only === "behind"}
                                        onOnly={() => toggleOnly("behind")}
                                        groups={lines.behind.filter((g) => g.label !== SHIPPED_LABEL)}
                                        cursor={cursor}
                                        openLine={openLine}
                                        more={lines.behindMore}
                                        expanded={behindOpen}
                                        onToggleMore={() => toggleRegion("behind")}
                                        shippedTotal={shippedAll.length}
                                        shippedMissing={missingLegs.includes("Runs")}
                                        shippedLines={shippedLines}
                                        shippedKind={shippedKind}
                                        onShippedKind={setShippedKind}
                                        shippedCounts={shippedCounts}
                                        shippedOpen={shippedOpen}
                                        onToggleShipped={() => setShippedOpen(!shippedOpen)}
                                        filtering={filtering}
                                        sheetOpen={sheetOpen}
                                        stageRunId={stageRun?.id}
                                    />
                                ) : null}
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                </div>
                <BriefChunkPane
                    model={model}
                    initiative={openEffort?.title ?? ""}
                    selectedChunk={openInitiative != null ? selectedChunk : null}
                    planChunks={planChunks}
                    feed={tracker.feed}
                    readingNote={readingNote}
                    setReadingNote={setReadingNote}
                    error={mutateError}
                    onPrev={stepTo("prev")}
                    onNext={stepTo("next")}
                    onClose={closeNotes}
                    openLine={openLine}
                    runMutation={runMutation}
                    edits={edits}
                />
                <BriefToastView />
            </div>
            {/* the Brief's destination for a record address: openref.ts's record landing sets the atom this reads.
                Mounted here rather than beside the surface switch because it is the Brief's own overlay —
                the three-pane composition opens a record on the Stage instead. */}
            <BriefPeek model={model} />
            {/* The same overlay the Stage used to mount, with the Brief's own exits. canOpenRuns is true
                now that a run has a destination: openref.ts's run landing opens the channel's detail sheet, which
                is where the run body and its gate live. A graph-selected record closes into the record
                peek. */}
            <AnimatePresence>
                {graphOpen ? (
                    <GraphPeek
                        key="brief-graph-peek"
                        model={model}
                        focus={graphFocus}
                        canOpenRuns
                        onOpenRecord={(id) => globalStore.set(briefPeekRecordAtom, id)}
                        onClose={closeBriefGraph}
                    />
                ) : null}
            </AnimatePresence>
            {/* B4's detail sheet, now drawing the surface's active subject: a channel's run body (or its
                launcher), or an initiative's chunk detail. */}
            <BriefSheet model={model} />
            {/* keyed by project so an open on a named project starts there, not on the last one picked */}
            <BriefProfileModal
                key={profileTarget ?? ""}
                open={profileTarget != null}
                initialChannelId={profileTarget ?? ""}
                onClose={() => setProfileTarget(null)}
            />
            <JiraCheckDialog model={model} />
            {detailsOpen && openEffort != null && openEffortORef != null ? (
                <EffortCreateForm
                    model={model}
                    onClose={() => setDetailsFor(null)}
                    edit={{
                        oref: openEffortORef,
                        details: {
                            title: openEffort.title,
                            project: openEffort.project ?? "",
                            ticket: openEffort.ticket ?? "",
                            parent: openEffort.parentoid ?? "",
                        },
                    }}
                />
            ) : null}
            {/* the plan-gate modal, mounted here because the Stage was the surface that hosted it */}
            <DagModal />
        </div>
    );
}
