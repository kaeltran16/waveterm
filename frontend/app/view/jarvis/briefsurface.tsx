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
import { DagModal } from "@/app/view/orchestrate/dagmodal";
import { setDagModalAgentsContext } from "@/app/view/orchestrate/dagmodalstate";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { X } from "lucide-react";
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
    EFFORT_CAP,
    groupDelta,
    projectBriefing,
    SEVEN_DAYS_MS,
    SHIPPED_CAP,
    summarizeAttentionQueue,
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
    mutationRunner,
    openChunkInPlan,
    stepTarget,
    trackerEdits,
    type EffortWrites,
    type MutationDeps,
} from "./briefmutations";
import { briefListNav, cursorAction, resolveBriefCursor, runNavLines } from "./briefnav";
import { BriefPeek } from "./briefpeekview";
import { REGIONS, showInitiativeMenu, type RegionId } from "./briefprimitives";
import { BriefProfileModal } from "./briefprofileview";
import { ackAll, actOnQueue, type QueueActionDeps } from "./briefqueueactions";
import { briefRestorePlan } from "./briefrestore";
import {
    behindGroups,
    filterLines,
    initiativeLine,
    initiativeProjects,
    keepsProject,
    keepsRunKind,
    projectCounts,
    queueLine,
    runKindCounts,
    runKindLegs,
    sessionLine,
    sessionWindow,
    SHIPPED_LABEL,
    sinceLabel,
    type BriefLine,
    type LineTarget,
    type RunKindFilter,
} from "./briefrows";
import { RunsRegion } from "./briefruns";
import { BriefSheet } from "./briefsheet";
import { REGION_LABEL } from "./briefstyle";
import { BriefToastView } from "./brieftoast";
import { BriefToolbar } from "./brieftoolbar";
import { briefUndo, chunkKey, effortKey, noteKey, pendingDeleteKeysAtom } from "./briefundo";
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
    loadArchivedEfforts,
    loadEffortDetail,
    moveChunk,
    moveChunkToStage,
    removeChunks,
    renameChunk,
    renameEffort,
    setChunkStage,
    setChunkStatus,
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
import { openOrPeek, openOrPeekAddress } from "./openref";
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
    const model_ = useMemo(() => {
        if (snapshot == null) {
            return null;
        }
        return projectBriefing({
            state: snapshot.state,
            agents,
            actualCursor: snapshot.actualCursor,
            queryStartedAt: snapshot.queryStartedAt,
            sevenDaysAgo: snapshot.queryStartedAt - SEVEN_DAYS_MS,
        });
    }, [snapshot, agents]);

    // a fixture seeds attention the same way it seeds the roster, so every fixture previews the queue.
    const attention = fixture != null ? BRIEFING_FIXTURES[fixture].attention : liveAttention;
    // memoized because the j/k controller below is registered per identity: recomputing these every
    // render would re-register it every render. They are pure functions of the snapshot projection, so
    // pinning them to it also stops groupDelta's "now" drifting between renders of the same snapshot.
    const queue = useMemo(
        () =>
            model_ != null
                ? buildAttentionQueue({ attention, efforts: model_.efforts, blockers: model_.blockers })
                : [],
        [model_, attention]
    );
    // the full projection, not the window: a blocked chunk on the seventh initiative is still waiting on
    // you, so the queue reads every effort even when the Initiatives region is only showing six.
    const efforts = useMemo(() => model_?.efforts ?? [], [model_]);

    // Each region opens at its cap and the region's own control opens the rest in place. The caps stay
    // display-side so the overflow count is what was actually hidden from the rows above it.
    const [expanded, setExpanded] = useAtom(briefExpandedAtom);
    const toggleRegion = useCallback(
        (id: RegionId) => setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true })),
        [setExpanded]
    );
    const waitingOpen = expanded.waiting === true;
    const initiativesOpen = expanded.initiatives === true;
    const sessionsOpen = expanded.sessions === true;
    const behindOpen = expanded.behind === true;
    const queueSummary = useMemo(() => summarizeAttentionQueue(queue, Date.now()), [queue]);

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
    const perProject = useMemo(() => projectCounts(projectCards), [projectCards]);
    // a pick whose last initiative went away reads as every project rather than an empty region
    const project = pickedProject != null && projectOptions.includes(pickedProject) ? pickedProject : null;
    const projectEfforts = useMemo(() => efforts.filter((e) => keepsProject(project, e.project)), [efforts, project]);
    const effortWindow = useMemo(
        () => capRegion(projectEfforts, EFFORT_CAP, initiativesOpen),
        [projectEfforts, initiativesOpen]
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
                : sessionWindow(runKindLegs(model_, runKind), sessionsOpen, Date.now()),
        [model_, sessionsOpen, runKind]
    );
    const runCounts = useMemo(
        () =>
            runKindCounts(
                (model_?.activeRuns ?? []).map((r) => r.mode),
                model_?.directAgents.length ?? 0
            ),
        [model_]
    );
    // moment 1: which rows are new to YOU. Excludes `behind` deliberately — that region is entirely
    // since-your-last-visit by construction, so marking it would mark every row and its own label
    // already states the fact.
    const cursorTs = snapshot?.actualCursor ?? 0;
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

    const deltaWindow = useMemo(() => capRegion(model_?.delta ?? [], DELTA_CAP, behindOpen), [model_, behindOpen]);
    const deltaGroups = useMemo(() => groupDelta(deltaWindow.rows, Date.now()), [deltaWindow]);

    // The filter and the one-region view narrow what is drawn, and the nav ids are the drawn lines' own, so
    // j/k can never land on a row the filter hid.
    const [query, setQuery] = useState("");
    const [only, setOnly] = useState<RegionId | null>(null);
    const [staleOpen, setStaleOpen] = useAtom(briefStaleOpenAtom);
    const toggleOnly = (id: RegionId) => setOnly((cur) => (cur === id ? null : id));
    const filtering = query.trim() !== "";
    const [shippedOpen, setShippedOpen] = useAtom(briefShippedOpenAtom);
    const [shippedKind, setShippedKind] = useAtom(briefShippedKindAtom);
    const shippedAll = useMemo(
        () => (model_?.shipped ?? []).filter((s) => keepsRunKind(shippedKind, s.mode)),
        [model_, shippedKind]
    );
    const shippedCounts = useMemo(() => runKindCounts((model_?.shipped ?? []).map((s) => s.mode)), [model_]);
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
    const lines = useMemo(() => {
        const now = Date.now();
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
            behind: behindGroups(deltaGroups, shipped.rows, now)
                .map((g) => ({ ...g, lines: filterLines(g.lines, query) }))
                .filter((g) => g.lines.length > 0),
        };
    }, [queue, effortWindow, showArchived, archivedShown, sessions, deltaGroups, shipped, query, pendingDeletes]);
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
    useEffect(() => {
        if (openEffortORef == null) {
            return;
        }
        // a failure here leaves the row expanded on its "loading" line rather than collapsing under the
        // click; the next snapshot refresh retries.
        fireAndForget(() => loadEffortDetail(openEffortORef, openFreshTs));
    }, [openEffortORef, openFreshTs]);

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
    const [renamingTitle, setRenamingTitle] = useState<string | null>(null);
    const [detailsOpen, setDetailsOpen] = useState(false);
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
                onRename: (title) => setRenamingTitle(title),
                onDetails: () => setDetailsOpen(true),
                onActivity: (e) => fireAndForget(() => openOrPeekAddress(model, oref, e)),
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
            openLine(act.target);
        }
    }, [cursorRow, openLine, setNoteChunk, setReadingNote, toggleInitiative]);
    const shippedLines = lines.behind.find((g) => g.label === SHIPPED_LABEL)?.lines ?? NO_LINES;
    const stageRun = useAtomValue(stageRunAtom);
    const runList = useAtomValue(briefRunListAtom);
    // with a run sheet open on the published run list, j/k step the sheet through that list (briefnav.ts)
    const runNav = useMemo(
        () => runNavLines({ sheetOpen, stageRun, runList, shippedLines, sessionLines: view.sessionLines }),
        [sheetOpen, stageRun, runList, shippedLines, view.sessionLines]
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
                    sheetOpen,
                    cursorRow,
                    activate: activateCursor,
                    cursorTarget,
                }),
            [runNav, tracker.navIds, cursor, setCursor, openLine, sheetOpen, cursorRow, activateCursor, cursorTarget]
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
    const projectCount = snapshot?.state.projects?.length ?? 0;
    const paused = projectEfforts.filter((e) => e.status === "paused").length;
    const liveN = view.sessionLines.filter((l) => !l.stale).length;
    const visitCursor = useAtomValue(briefingCursorAtom);

    // the run sheet mounts outside the Brief's snapshot, so the Brief publishes what its ↳ chunk line and
    // its n / N position read
    useEffect(() => {
        globalStore.set(
            briefEffortIndexAtom,
            new Map(
                [...efforts, ...archivedCards].map((e) => [
                    e.oref.replace(/^effort:/, ""),
                    { oref: e.oref, title: e.title, chunkStages: e.chunkStages },
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
                setRenamingTitle(l.title);
            },
            details: () => {
                expand();
                setDetailsOpen(true);
            },
            status:
                card != null
                    ? { value: card.status, ops: effortOps(mutationDeps, card.oref, card.title, card.status) }
                    : undefined,
        });
    };
    useEffect(() => {
        globalStore.set(
            briefRunListAtom,
            stageRun != null && stageRun.status === "done"
                ? shipped.rows.map((r) => r.oref.replace(/^run:/, ""))
                : view.sessionLines.flatMap((l) => (l.runOid ? [l.runOid] : []))
        );
    }, [stageRun, shipped, view.sessionLines]);

    const queueDeps: QueueActionDeps = { rpc: QUEUE_RPC, undo: briefUndo, openLine };
    const ackable = ackableRuns(queue);

    const revealChunk = useCallback(
        (effortOref: string, chunk: string) =>
            fireAndForget(() =>
                openChunkInPlan(
                    {
                        closeSheet: () => {
                            globalStore.set(briefSheetOpenAtom, false);
                            clearSubject();
                            forgetOrigin();
                        },
                        openInitiative: setOpenInitiative,
                        setCursor,
                        loadPlan: async (oref) => {
                            await loadEffortDetail(oref);
                            const effort = globalStore.get(effortDetailAtom).get(oref);
                            return effort != null ? effortChunkRows(effort) : [];
                        },
                        openStage: (id) => setStageOverrides((cur) => ({ ...cur, [id]: true })),
                    },
                    effortOref,
                    chunk
                )
            ),
        [setOpenInitiative, setCursor, setStageOverrides]
    );
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
            </AnimatePresence>
            {/* @container, not a media query: the sidebar's width rule is about how much SURFACE the
                index has left, and the window is not the surface. */}
            <div className="@container relative flex min-h-0 flex-1">
                <div
                    className={cn(
                        "flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-[22px] pb-2.5 pt-5",
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
                                        openLine={openLine}
                                        onAct={(q, l) => fireAndForget(() => actOnQueue(queueDeps, q, l))}
                                    />
                                ) : null}
                                {view.shows("initiatives") ? (
                                    <InitiativesRegion
                                        lines={lines.initiatives}
                                        empty={efforts.length === 0 && archivedCards.length === 0}
                                        paused={paused}
                                        only={only === "initiatives"}
                                        onOnly={() => toggleOnly("initiatives")}
                                        projects={{
                                            options: projectOptions,
                                            total: projectCards.length,
                                            counts: perProject,
                                            picked: project,
                                            onPick: setPickedProject,
                                        }}
                                        filtering={filtering}
                                        entering={entering}
                                        fresh={freshInitiatives}
                                        cursor={cursor}
                                        openInitiative={openInitiative}
                                        rename={
                                            renamingTitle != null
                                                ? {
                                                      title: renamingTitle,
                                                      onChange: setRenamingTitle,
                                                      onCommit: () => {
                                                          const t = renamingTitle.trim();
                                                          setRenamingTitle(null);
                                                          if (
                                                              t !== "" &&
                                                              openEffortORef != null &&
                                                              t !== openEffort?.title
                                                          ) {
                                                              runMutation(() => renameEffort(openEffortORef, t));
                                                          }
                                                      },
                                                      onCancel: () => setRenamingTitle(null),
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
                                        groups={lines.behind.filter((g) => g.label !== SHIPPED_LABEL)}
                                        cursor={cursor}
                                        openLine={openLine}
                                        more={deltaWindow.more}
                                        expanded={behindOpen}
                                        onToggleMore={() => toggleRegion("behind")}
                                        shippedTotal={shippedAll.length}
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
            {detailsOpen && openEffort != null && openEffortORef != null ? (
                <EffortCreateForm
                    onClose={() => setDetailsOpen(false)}
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
