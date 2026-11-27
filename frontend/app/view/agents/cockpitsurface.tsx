// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Cockpit's Grid board: every session you talk to as a read-only thumbnail in its anchored slot, the Idle line
// of dismissed and quiet sessions, and the strip of runs with no live conductor. What each session is, its runs and
// whose each run's wait is come from the shell (cockpitsessionstore.ts); the layout and the arrow path from
// cockpitgridmodel.ts. Every project shows, whatever the app bar's scope. Space zooms a session: the zoomed view
// (cockpitzoom.tsx) lies over the grid, which stays mounted under it so Esc lands back on the same thumbnail.

import { cardVariants } from "@/app/element/motiontokens";
import { Skeleton } from "@/app/element/skeleton";
import { TickNumber } from "@/app/element/ticknumber";
import { globalStore } from "@/app/store/jotaiStore";
import { buildCockpitBindings } from "@/app/store/keybindings/bindings";
import { focusClaimed } from "@/app/store/keybindings/dispatcher";
import { useKeybindings } from "@/app/store/keybindings/store";
import * as WOS from "@/app/store/wos";
import { openTarget } from "@/app/view/jarvis/openref";
import { landOn } from "@/app/view/jarvis/returnsurface";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { CockpitEmptyState } from "./cockpitemptystate";
import {
    GRID_ROWS_IN_VIEW,
    anchoredSessions,
    gridColumns,
    resolveCursor,
    type GridPath,
    type GridTrail,
} from "./cockpitgridmodel";
import { cockpitViewAtomFor, cockpitZoomAtom, dismissSession, undismissSession } from "./cockpitsessionstore";
import { CockpitThumbnail, RunLine, SelectionRing } from "./cockpitthumbnail";
import { CockpitZoom } from "./cockpitzoom";
import { ensurePreviousInfo, rosterSeededAtom } from "./liveagents";
import { runInfoOf, type RunInfo } from "./runlineage";
import { useRunDigests } from "./runlineagestore";
import { useCockpitKeyboard } from "./usecockpitkeyboard";

// the gap between thumbnails, in px: gap-3.5
const GRID_GAP_PX = 14;
const STRIP_PREFIX = "strip:";
const stripStop = (runId: string) => STRIP_PREFIX + runId;

// what useRunDigests needs of a listed run: its channel and, for a dag run, its dag
function digestReadsAtom(runs: Run[]) {
    return atom((get) =>
        runs.map(
            (r) =>
                ({
                    runId: r.id,
                    channelId: r.channeloid ?? "",
                    dag: r.dagoref ? get(WOS.getWaveObjectAtom<TaskGroup>(WOS.makeORef("dag", r.dagoref))) : undefined,
                }) as RunInfo
        )
    );
}

// the grid's content box, for its columns and the two rows that fill it
function useGridBox() {
    const ref = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        const measure = () => {
            const cs = getComputedStyle(el);
            setBox({
                width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
                height: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
            });
        };
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        measure();
        return () => ro.disconnect();
    }, []);
    return { ref, ...box };
}

export function CockpitSurface({ model }: { model: AgentsViewModel }) {
    const view = useAtomValue(cockpitViewAtomFor(model));
    const now = useAtomValue(model.structuralNowAtom);
    const seeded = useAtomValue(rosterSeededAtom);
    const roster = useAtomValue(model.agentsAtom);
    const zoomId = useAtomValue(cockpitZoomAtom);
    const zoomed = zoomId != null && [...view.sessions, ...view.idle].some((s) => s.agent.id === zoomId);

    const order = useAtomValue(model.orderAtom);
    const anchored = anchoredSessions(order, view.sessions);
    const sessions = anchored.sessions;
    const orderKey = anchored.order.join(",");
    useEffect(() => {
        if (globalStore.get(model.orderAtom).join(",") !== orderKey) {
            globalStore.set(model.orderAtom, anchored.order);
        }
    }, [orderKey]);

    // an asking session's ask leads its first paint until its live stream lands
    const askingKey = sessions
        .filter((s) => s.state === "asks")
        .map((s) => s.agent.id)
        .join(",");
    useEffect(() => {
        for (const s of sessions) {
            if (s.state === "asks" && s.agent.transcriptPath) {
                void ensurePreviousInfo(s.agent.id, s.agent.transcriptPath, s.agent.agent);
            }
        }
    }, [askingKey]);

    // digests load only for runs in view, so every listed run keeps its own current
    const listed = [...sessions.flatMap((s) => s.runs), ...view.orphans];
    const listedKey = listed.map((r) => `${r.id}:${r.dagoref ?? ""}`).join(",");
    const digestReads = useAtomValue(useMemo(() => digestReadsAtom(listed), [listedKey]));
    useRunDigests(digestReads);

    const grid = useGridBox();
    const columns = gridColumns(grid.width);
    const rowPx = Math.max(0, (grid.height - GRID_GAP_PX * (GRID_ROWS_IN_VIEW - 1)) / GRID_ROWS_IN_VIEW);
    const path: GridPath = {
        grid: sessions.map((s) => s.agent.id),
        idle: view.idle.map((s) => s.agent.id),
        strip: view.orphans.map((r) => stripStop(r.id)),
        columns,
    };
    const pathKey = [path.grid, path.idle, path.strip].map((z) => z.join(",")).join("|");

    const cursorId = useAtomValue(model.cursorIdAtom);
    const setCursorId = (id: string | undefined) => globalStore.set(model.cursorIdAtom, id);
    const trailRef = useRef<GridTrail>({});
    useEffect(() => {
        const next = resolveCursor(path, cursorId);
        if (next !== cursorId) {
            setCursorId(next);
        }
    }, [pathKey, cursorId]);
    useEffect(() => {
        if (cursorId != null) {
            document
                .querySelector(`[data-cockpit-stop="${CSS.escape(cursorId)}"]`)
                ?.scrollIntoView({ block: "nearest" });
        }
    }, [cursorId]);

    // a filmstrip hop moves the grid's cursor with it, so Esc lands on the last zoomed session
    useEffect(() => {
        if (zoomId != null) {
            setCursorId(zoomId);
        }
    }, [zoomId]);
    // a zoomed session that leaves the roster returns to the grid
    useEffect(() => {
        if (zoomId != null && seeded && !zoomed) {
            globalStore.set(cockpitZoomAtom, null);
        }
    }, [zoomId, seeded, zoomed]);

    const containerRef = useRef<HTMLDivElement>(null);
    const zoomLayerRef = useRef<HTMLDivElement>(null);
    // the zoomed view leaving takes focus with it when focus was inside, which would leave the grid's keys dead
    useEffect(() => {
        const active = document.activeElement;
        if (zoomId == null && (active === document.body || zoomLayerRef.current?.contains(active))) {
            containerRef.current?.focus({ preventScroll: true });
        }
    }, [zoomId]);
    // the keys are this container's own onKeyDown, so arriving without focus inside it (palette pick, nav click,
    // Escape home) would leave them dead until a click
    useEffect(() => {
        const el = containerRef.current;
        if (el && !el.contains(document.activeElement) && !focusClaimed()) {
            el.focus({ preventScroll: true });
        }
    }, []);

    const zoom = (id: string) => {
        setCursorId(id);
        globalStore.set(cockpitZoomAtom, id);
    };
    const zoomIdle = (id: string) => {
        undismissSession(id);
        zoom(id);
    };
    const openStrip = (stopId: string) =>
        fireAndForget(() => openTarget(model, { kind: "run", runId: stopId.slice(STRIP_PREFIX.length) }));
    const openAgent = (id: string) => {
        globalStore.set(model.focusIdAtom, id);
        globalStore.set(model.focusReplyAtom, false);
        landOn(model.surfaceAtom, "agent");
    };
    const onKeyDown = useCockpitKeyboard({
        path,
        cursorId,
        zoomed: zoomId != null,
        setCursorId,
        trailRef,
        zoom,
        zoomIdle,
        dismiss: (id, next) => {
            dismissSession(id);
            setCursorId(next);
        },
        openStrip,
        openAgent,
    });

    // documentation-only bindings: the cheat sheet lists the Cockpit's keys, which onKeyDown above performs
    const cockpitBindings = useMemo(() => buildCockpitBindings(), []);
    useKeybindings(cockpitBindings);

    const empty = seeded && roster.length === 0 && view.orphans.length === 0;

    return (
        <MotionConfig reducedMotion="user">
            <div
                ref={containerRef}
                data-cockpit-surface
                data-focus-home
                tabIndex={0}
                onKeyDown={onKeyDown}
                className="relative flex h-full w-full flex-col bg-background text-secondary outline-none"
            >
                {/* under the zoomed view the grid stays laid out, so Esc finds its thumbnail where it was */}
                <div inert={zoomId != null} className="flex min-h-0 flex-1 flex-col">
                    <header className="flex h-[50px] flex-none items-center gap-3 px-[22px]">
                        <h1 className="text-[15px] font-semibold text-primary">Cockpit</h1>
                        <span data-cockpit-session-count className="text-[12.5px] text-muted">
                            <TickNumber value={sessions.length} /> {sessions.length === 1 ? "session" : "sessions"} ·
                            all projects
                        </span>
                        {view.turnCount > 0 ? (
                            <span
                                data-cockpit-turn-count
                                className="inline-flex h-[22px] items-center gap-1.5 rounded-[6px] bg-askingbg px-[9px] text-[12.5px] font-semibold text-warning"
                            >
                                <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                                <TickNumber value={view.turnCount} /> on your turn
                            </span>
                        ) : null}
                        <span className="flex-1" />
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                            <kbd className="rounded-[4px] border border-edge-strong px-[5px] font-mono text-[10.5px] text-ink-mid">
                                Space
                            </kbd>
                            zooms
                            <span className="text-ink-faint">·</span>
                            <kbd className="rounded-[4px] border border-edge-strong px-[5px] font-mono text-[10.5px] text-ink-mid">
                                Esc
                            </kbd>
                            returns
                        </span>
                    </header>

                    <LayoutGroup>
                        <div className="relative flex min-h-0 flex-1 flex-col">
                            {empty ? (
                                <CockpitEmptyState onNewAgent={() => globalStore.set(model.newAgentOpenAtom, true)} />
                            ) : !seeded ? (
                                <CockpitGridSkeleton />
                            ) : null}
                            <div ref={grid.ref} className="min-h-0 flex-1 overflow-y-auto px-[22px]">
                                <div
                                    data-cockpit-grid
                                    className="grid gap-3.5"
                                    style={{
                                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                                        gridAutoRows: rowPx > 0 ? `${rowPx}px` : undefined,
                                    }}
                                >
                                    <AnimatePresence initial={false} mode="popLayout">
                                        {sessions.map((s) => (
                                            <CockpitThumbnail
                                                key={s.agent.id}
                                                session={s}
                                                selected={cursorId === s.agent.id}
                                                now={now}
                                                onClick={() =>
                                                    cursorId === s.agent.id ? zoom(s.agent.id) : setCursorId(s.agent.id)
                                                }
                                            />
                                        ))}
                                    </AnimatePresence>
                                </div>
                            </div>
                        </div>

                        <div
                            data-cockpit-idle
                            className="flex min-w-0 flex-none items-center gap-2.5 px-[22px] pt-3 text-[12.5px]"
                        >
                            <span className="font-semibold text-ink-mid">Idle</span>
                            <span data-idle-count className="font-mono text-[11px] text-muted">
                                <TickNumber value={view.idle.length} />
                            </span>
                            <div className="flex min-w-0 gap-1 overflow-hidden">
                                <AnimatePresence initial={false} mode="popLayout">
                                    {view.idle.map((s) => (
                                        <motion.button
                                            key={s.agent.id}
                                            layout
                                            variants={cardVariants}
                                            initial="initial"
                                            animate="animate"
                                            exit="exit"
                                            type="button"
                                            tabIndex={-1}
                                            data-idle-name={s.agent.id}
                                            data-cockpit-stop={s.agent.id}
                                            onClick={() => zoomIdle(s.agent.id)}
                                            className="relative flex-none cursor-pointer rounded-[6px] border border-transparent px-[7px] py-0.5 text-muted hover:text-secondary"
                                        >
                                            {cursorId === s.agent.id ? (
                                                <SelectionRing className="rounded-[6px]" />
                                            ) : null}
                                            {s.agent.name}
                                        </motion.button>
                                    ))}
                                </AnimatePresence>
                            </div>
                            {view.idle.length === 0 ? <span className="text-muted">Nothing idle</span> : null}
                        </div>

                        <div
                            data-cockpit-strip
                            className="mx-[22px] mb-4 mt-2.5 flex max-h-[30%] flex-none flex-col gap-[5px] overflow-y-auto rounded-[10px] border border-edge-mid bg-surface px-3 pb-[9px] pt-2"
                        >
                            <div className="flex items-center gap-2 text-[12px]">
                                <span className="font-semibold text-ink-mid">Runs with no conductor</span>
                                <TickNumber value={view.orphans.length} className="font-mono text-[11px] text-muted" />
                                <span className="flex-1" />
                                <span className="text-muted">
                                    their waits come straight to you · click opens the run
                                </span>
                            </div>
                            <AnimatePresence initial={false}>
                                {view.orphans.map((r) => {
                                    const stop = stripStop(r.id);
                                    return (
                                        <motion.div
                                            key={r.id}
                                            variants={cardVariants}
                                            initial="initial"
                                            animate="animate"
                                            exit="exit"
                                            data-strip-run={r.id}
                                            data-cockpit-stop={stop}
                                            onClick={() => {
                                                setCursorId(stop);
                                                openStrip(stop);
                                            }}
                                            className="relative -mx-1.5 cursor-pointer rounded-[6px] px-1.5 py-[3px] hover:bg-surface-hover"
                                        >
                                            {cursorId === stop ? <SelectionRing className="rounded-[6px]" /> : null}
                                            <RunLine
                                                run={r}
                                                now={now}
                                                project={runInfoOf(r.id, r, undefined, undefined).project}
                                            />
                                        </motion.div>
                                    );
                                })}
                            </AnimatePresence>
                            {view.orphans.length === 0 ? (
                                <span className="text-[12px] text-muted">None today</span>
                            ) : null}
                        </div>
                    </LayoutGroup>
                </div>

                <AnimatePresence>
                    {zoomed ? (
                        // Moment 1, scaled from the zoomed thumbnail, and back toward it on Esc. Not the frame morph
                        // (17): measured over CDP, the return dropped 3-5 frames against this one's 1-2.
                        <motion.div
                            key="zoom"
                            ref={zoomLayerRef}
                            variants={cardVariants}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            style={{ transformOrigin: thumbnailCenter(containerRef.current, zoomId) }}
                            className="absolute inset-0 z-10 flex"
                        >
                            <CockpitZoom
                                model={model}
                                agentId={zoomId}
                                onBack={() => globalStore.set(cockpitZoomAtom, null)}
                            />
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            </div>
        </MotionConfig>
    );
}

// where a thumbnail's center sits in the surface, so the zoom grows out of it; a hop re-reads it, so Esc shrinks
// toward the thumbnail it lands on
function thumbnailCenter(container: HTMLElement | null, agentId: string): string {
    const thumb = document.querySelector(`[data-cockpit-thumb="${CSS.escape(agentId)}"]`)?.getBoundingClientRect();
    const box = container?.getBoundingClientRect();
    if (thumb == null || box == null) {
        return "50% 50%";
    }
    return `${thumb.left + thumb.width / 2 - box.left}px ${thumb.top + thumb.height / 2 - box.top}px`;
}

// thumbnail-shaped placeholders in the grid's own gutters, so the first thumbnails land where the skeleton was
function CockpitGridSkeleton() {
    return (
        <div aria-hidden="true" className="absolute inset-0 z-[1] grid grid-cols-3 grid-rows-2 gap-3.5 px-[22px]">
            {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="min-h-0 rounded-[10px]" />
            ))}
        </div>
    );
}
