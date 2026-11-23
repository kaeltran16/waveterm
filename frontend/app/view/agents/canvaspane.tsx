// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The agent's design canvas, shown on the Agent surface in place of its (still mounted, hidden) terminal.
// Thin: what it shows comes from canvasmodel/canvasmarks, and what it knows comes from the agent's canvas state,
// which useCanvasPoller keeps current.

import { pushToast } from "@/app/cockpit/notificationstore";
import { composerReveal, errorNudge, viewFade } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { Segmented } from "@/app/element/segmented";
import { StepSwap } from "@/app/element/stepswap";
import { ViewSwap } from "@/app/element/viewswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import { openTarget } from "@/app/view/jarvis/openref";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { SquareDashed, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from "react";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import { errText } from "./brainstormui";
import { boxToMark, type Box, type Mark } from "./canvasmarks";
import {
    ALL_TAB,
    boardLabel,
    boardUrl,
    buildGoal,
    canvasLayout,
    canvasTabs,
    currentTab,
    paneState,
    prototypePath,
    removedExit,
    shownBoard,
    shownBoards,
    updatedAgo,
    type BoardFrame,
    type CanvasBoard,
    type CanvasLayout,
} from "./canvasmodel";
import { sendCanvasMark } from "./canvassend";
import {
    canvasStateAtom,
    detachCanvas,
    selectCanvasBoard,
    selectCanvasTab,
    selectCanvasWindowTab,
    setMark,
    setMarking,
    type CanvasState,
} from "./canvasstore";
import {
    OTHER_TAB,
    otherBoards,
    windowGridLayout,
    windowTab,
    windowTabs,
    type ScopeTab,
    type WindowScope,
} from "./canvaswindowmodel";
import { routeDesign, tauriDesignAttach } from "./designroute";
import { NOTE_CARD, NoteCardBody } from "./docreviewnotesview";

// the app bar's buttons
export const CANVAS_BTN =
    "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-edge-mid bg-surface-raised px-[12px] py-[6px] text-[12.5px] font-semibold text-primary hover:border-edge-strong hover:bg-surface-hover";
export const CANVAS_PRIMARY_BTN =
    "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] bg-accent px-[12px] py-[7px] text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-50";

// room above a board's frame for its label; the scroll pane's top padding
const CANVAS_TOP_PAD = 36;
const LABEL_OFFSET = 22;

const NOTE_GAP = 6;

// a run waiting on this session takes the canvas as its prototype and the sheet opens on it; any other session
// opens New run as an orchestrator run on the agent's project, with this canvas as the run's prototype. boards: the
// ones it builds, the shown tab's in the canvas, every board from the workspace pane's list
export async function openBuildRun(
    model: AgentsViewModel,
    agent: AgentVM,
    s: CanvasState,
    boards: CanvasBoard[]
): Promise<void> {
    const prototype = prototypePath(s.dir, boards);
    const openLauncher = () => {
        globalStore.set(newRunPrefillAtom, {
            projectName: projectOf(agent),
            goal: buildGoal(s.dir, boards),
            shape: "orchestrator",
            prototype,
        });
        globalStore.set(model.newRunOpenAtom, true);
    };
    if (!agent.blockId) {
        openLauncher();
        return;
    }
    try {
        await routeDesign(
            {
                attach: tauriDesignAttach,
                onAttached: (channelId, runId) => void openTarget(model, { kind: "channel", channelId, runId }),
                openLauncher,
            },
            agent.blockId,
            { prototype }
        );
    } catch (e) {
        pushToast({ title: "Couldn't hand the design to its run", message: errText(e), level: "error" });
    }
}

// tabLabels names a board's tab in place of its plain label, as a brainstorm's open question numbers its answers'
// boards; boardActions draws a row under the toolbar for the one board shown, never under All or while marking. Either
// marks a brainstorm's canvas, whose brainstorm owns the run launch, so it has no Build this. onClose makes it the
// canvas window (canvaswindow.tsx): a Close button, the marking hint in the header, and All in rows of 3. scope
// (window only) replaces every board and All with the scope's tabs and Other boards, and band draws under the toolbar
// for the shown scope tab; a scope is a brainstorm's, so it too has no Build this
export function CanvasPane({
    model,
    agent,
    tabLabels,
    boardActions,
    scope,
    band,
    onClose,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tabLabels?: Record<string, string>;
    boardActions?: (board: string) => ReactNode;
    scope?: WindowScope;
    band?: (tab: ScopeTab, scope: WindowScope) => ReactNode;
    onClose?: () => void;
}) {
    const s = useAtomValue(canvasStateAtom(agent.id));
    const now = useAtomValue(model.nowAtom);
    const [measureRef, scrollRef, rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const selected = s != null ? shownBoard(s).name : null;
    const tab = s == null ? "" : scope != null ? windowTab(scope, s) : currentTab(s);
    // a board picked from the Other boards grid is a step of its own, though the tab stays Other boards
    const step = s == null ? "" : scope != null ? (s.all ? OTHER_TAB : selected!) : tab;
    const stepDir = useStepDir(
        step,
        s == null ? [] : scope != null ? scopeOrder(scope, s.boards) : canvasTabs(s.boards)
    );
    const layoutRef = useRef<CanvasLayout | null>(null);
    // a tab, [ or ] can pick a board below the fold. Only its top edge is brought into view, label included:
    // scrollIntoView top-aligns any board taller than the pane, which scrolled the labels away on every pick. Read
    // from the layout, not the DOM: a board switch mounts the new frame only once the old one has slid out
    useEffect(() => {
        const pane = scrollRef.current;
        const frame = layoutRef.current?.frames.find((f) => f.board.name === selected);
        if (pane == null || frame == null) {
            return;
        }
        const top = CANVAS_TOP_PAD + frame.top - pane.scrollTop;
        if (top < CANVAS_TOP_PAD || top > pane.clientHeight - CANVAS_TOP_PAD) {
            pane.scrollTop += top - CANVAS_TOP_PAD;
        }
    }, [selected]);
    // the tabs scroll sideways once a brainstorm has more boards than the toolbar fits; keep the picked one in view
    const tabsFade = useEdgeFade();
    useEffect(() => {
        tabsFade.el?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [tab, tabsFade.el]);
    if (s == null) {
        return null;
    }
    const pane = paneState(s);
    const board = shownBoard(s);
    const inWindow = onClose != null;
    const grid = scope != null && s.all;
    const shownList = grid ? otherBoards(scope, s.boards) : shownBoards(s);
    const scopeTab = scope?.tabs.find((t) => t.board === tab);
    const tabOptions =
        scope != null
            ? windowTabs(scope, s.boards).map((t) => {
                  const label = t === OTHER_TAB ? "Other boards" : scope.tabs.find((x) => x.board === t)!.label;
                  return { key: t, title: label, label: <span className="max-w-[260px] truncate">{label}</span> };
              })
            : canvasTabs(s.boards).map((t) => ({
                  key: t,
                  label: t === ALL_TAB ? "All" : (tabLabels?.[t] ?? boardLabel(t)),
              }));
    const select = (t: string) => (scope != null ? selectCanvasWindowTab(agent.id, t) : selectCanvasTab(agent.id, t));
    const layout =
        inWindow && shownList.length > 1
            ? windowGridLayout(shownList, rect?.width ?? 0)
            : canvasLayout(shownList, rect?.width ?? 0);
    layoutRef.current = layout;
    const scale = layout.scale;
    const marking = s.marking && pane === "board";
    const markFrame = marking && s.mark != null ? layout.frames.find((f) => f.board.name === board.name) : undefined;
    const meta = [updatedAgo(now, s.lastModifiedMs), `${Math.round(scale * 100)}%`].filter(Boolean).join(" · ");

    return (
        <div data-canvas-pane className="flex min-h-0 flex-1 flex-col">
            {/* wraps in a narrow pane: unwrapped, the board tabs shrank to nothing and keeping the picked one in view scrolled
                the whole pane sideways. The window is wide enough to keep one row: its tabs take the rest of the width and
                scroll */}
            <div
                className={cn(
                    "flex flex-none items-center gap-x-[10px] gap-y-[8px] border-b border-edge-faint bg-surface py-[8px] pl-[22px]",
                    inWindow ? "pr-[10px]" : "flex-wrap pr-[22px]"
                )}
            >
                {scope != null ? (
                    <ScopeSourceLabel scope={scope} />
                ) : (
                    <span className="flex-none whitespace-nowrap font-mono text-[12px] font-semibold text-secondary">
                        {s.topic}
                    </span>
                )}
                {s.boards.length > 0 ? (
                    <div
                        ref={tabsFade.ref}
                        onScroll={tabsFade.update}
                        onWheel={(e) => {
                            e.currentTarget.scrollLeft += e.deltaY;
                        }}
                        className={cn("flex min-w-0 overflow-x-auto [scrollbar-width:none]", inWindow && "flex-1")}
                        style={tabsFade.style}
                    >
                        <Segmented
                            role="tablist"
                            ariaLabel="Boards"
                            title={`Previous and next board (${formatChordString("[")} and ${formatChordString("]")})`}
                            value={tab}
                            options={tabOptions}
                            onChange={select}
                        />
                    </div>
                ) : null}
                {inWindow && s.boards.length > 0 ? null : <div className="flex-1" />}
                {pane === "board" && !(inWindow && marking) ? (
                    <span className="flex-none whitespace-nowrap font-mono text-[10.5px] text-muted">{meta}</span>
                ) : null}
                {inWindow && marking && s.mark == null ? (
                    <span className="flex-none whitespace-nowrap text-[12px] text-secondary">
                        Click the part of the board that should change
                    </span>
                ) : null}
                <button
                    type="button"
                    title={`Mark part of the board (${formatChordString("m")})`}
                    aria-pressed={marking}
                    disabled={pane !== "board" || grid}
                    onClick={() => setMarking(agent.id, !s.marking)}
                    className={cn(
                        "flex cursor-pointer items-center gap-[6px] rounded-[8px] border px-[11px] py-[6px] text-[12.5px] font-semibold disabled:cursor-default disabled:opacity-50",
                        marking
                            ? "border-accent bg-accentbg text-accent"
                            : "border-edge-mid bg-surface-raised text-primary hover:border-edge-strong"
                    )}
                >
                    <SquareDashed size={15} strokeWidth={1.8} aria-hidden />
                    Mark
                </button>
                {!marking ? (
                    <div className="flex items-center gap-[10px]">
                        {s.base != null ? (
                            <button
                                type="button"
                                disabled={grid}
                                onClick={() => getApi().openExternal(boardUrl(s.base!, s.topic, board.name))}
                                className={cn(CANVAS_BTN, "disabled:cursor-default disabled:opacity-50")}
                            >
                                Open in browser
                            </button>
                        ) : null}
                        {s.boards.length > 0 && boardActions == null && scope == null ? (
                            <button
                                type="button"
                                onClick={() => {
                                    // the launcher opens over the surface, so the window makes way for it
                                    onClose?.();
                                    void openBuildRun(model, agent, s, shownList);
                                }}
                                className={CANVAS_BTN}
                            >
                                Build this…
                            </button>
                        ) : null}
                    </div>
                ) : null}
                {inWindow ? (
                    <button
                        type="button"
                        aria-label="Close"
                        title="Close (Esc)"
                        onClick={onClose}
                        className="flex size-[28px] flex-none cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-primary"
                    >
                        <X size={15} strokeWidth={2} aria-hidden />
                    </button>
                ) : null}
            </div>
            {scope != null ? (
                <PaneReveal
                    open={band != null && scopeTab != null && pane === "board" && !marking}
                    variants={composerReveal}
                    className="flex-none"
                >
                    {scopeTab != null ? <ViewSwap swapKey={scopeTab.board}>{band?.(scopeTab, scope)}</ViewSwap> : null}
                </PaneReveal>
            ) : (
                <PaneReveal
                    open={boardActions != null && pane === "board" && !marking && tab !== ALL_TAB}
                    variants={composerReveal}
                    className="flex-none"
                >
                    {boardActions?.(board.name)}
                </PaneReveal>
            )}
            <ViewSwap swapKey={pane} className="flex min-h-0 flex-1 flex-col bg-surface-code">
                {pane === "server-down" ? (
                    <ServerDown />
                ) : pane === "removed" ? (
                    <Removed agent={agent} topic={s.topic} />
                ) : (
                    // the shown boards (every one under All) at their canvas.json frames, each iframe at the board's full size, so the canvas
                    // scrolls here, in Arc, instead of showing the board pages' own scrollbars. The gutter is
                    // reserved so the scrollbar appearing can't narrow the pane, change the fit scale, and make
                    // itself disappear again
                    <div
                        ref={measureRef}
                        data-canvas-scroll
                        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-[24px] pb-[24px] [scrollbar-gutter:stable]"
                        style={{ paddingTop: CANVAS_TOP_PAD }}
                    >
                        {/* keyed by agent: another agent's canvas is a different view, not the next board */}
                        <StepSwap key={agent.id} stepKey={step} dir={stepDir}>
                            <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
                                {layout.frames.map((f) => (
                                    <BoardFrameView
                                        key={f.board.name}
                                        frame={f}
                                        scale={scale}
                                        selected={!grid && f.board.name === board.name}
                                        single={layout.frames.length === 1}
                                        src={
                                            pane === "board" && s.base != null
                                                ? boardUrl(s.base, s.topic, f.board.name)
                                                : null
                                        }
                                        reloadKey={s.reloadKey}
                                        onSelect={() =>
                                            grid
                                                ? selectCanvasWindowTab(agent.id, f.board.name)
                                                : selectCanvasBoard(agent.id, f.board.name)
                                        }
                                    >
                                        {marking && f.board.name === board.name ? (
                                            <MarkLayer agentId={agent.id} mark={s.mark} hint={!inWindow} />
                                        ) : null}
                                    </BoardFrameView>
                                ))}
                                {markFrame != null ? (
                                    <MarkNote
                                        model={model}
                                        agent={agent}
                                        mark={s.mark!}
                                        frame={markFrame}
                                        width={layout.width}
                                        scrollRef={scrollRef}
                                    />
                                ) : null}
                            </div>
                        </StepSwap>
                    </div>
                )}
            </ViewSwap>
        </div>
    );
}

// the toolbar's name for where the window came from, in place of the canvas topic
function ScopeSourceLabel({ scope }: { scope: WindowScope }) {
    const src = scope.source;
    const [lead, text] = src.kind === "question" ? [String(src.n), src.text] : ["Part", src.title];
    return (
        <span
            data-canvas-scope-source
            title={text}
            className="flex min-w-0 max-w-[40%] flex-none items-baseline gap-[8px] text-[13px] font-semibold"
        >
            <span className="flex-none text-warning">{lead}</span>
            <span className="truncate text-primary">{text}</span>
        </span>
    );
}

// the slide's order: the scope's tabs, then the boards Other boards shows alone
function scopeOrder(scope: WindowScope, boards: CanvasBoard[]): string[] {
    return [...windowTabs(scope, boards), ...otherBoards(scope, boards).map((b) => b.name)];
}

// the side a board switch slides toward: +1 when the new tab sits after the old one in the header, -1 before it
function useStepDir(tab: string, order: string[]): number {
    const [step, setStep] = useState({ tab, dir: 1 });
    // derived during render, so the direction is already set on the render that swaps the board
    if (step.tab !== tab) {
        setStep({ tab, dir: order.indexOf(tab) < order.indexOf(step.tab) ? -1 : 1 });
    }
    return step.dir;
}

const EDGE_FADE_PX = 28;

// a scroller with its scrollbar hidden fades the edge that has more past it, so a cut tab reads as "more", not crooked
function useEdgeFade() {
    const [el, setEl] = useState<HTMLDivElement | null>(null);
    const [edges, setEdges] = useState({ left: false, right: false });
    const update = () => {
        if (el == null) {
            return;
        }
        const left = el.scrollLeft > 1;
        const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    useEffect(() => {
        if (el == null) {
            return;
        }
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        if (el.firstElementChild != null) {
            ro.observe(el.firstElementChild);
        }
        return () => ro.disconnect();
    }, [el]);
    let style: CSSProperties = {};
    if (edges.left || edges.right) {
        const mask = `linear-gradient(to right, ${edges.left ? "transparent" : "black"}, black ${EDGE_FADE_PX}px, black calc(100% - ${EDGE_FADE_PX}px), ${edges.right ? "transparent" : "black"})`;
        style = { maskImage: mask, WebkitMaskImage: mask };
    }
    return { ref: setEl, el, style, update };
}

// a fresh iframe paints only once its page loads, long after a view fade ends: fading on load is what shows
export function BoardIframe({ src, title, style }: { src: string; title: string; style: CSSProperties }) {
    const [loaded, setLoaded] = useState(false);
    return (
        <motion.iframe
            src={src}
            title={title}
            sandbox="allow-scripts allow-same-origin"
            className="absolute left-0 top-0 border-0"
            style={style}
            variants={viewFade}
            initial="initial"
            animate={loaded ? "animate" : "initial"}
            onLoad={() => setLoaded(true)}
        />
    );
}

// A board the user hasn't picked wears a transparent cover: its iframe would swallow the click, and the first
// click on a board should pick it (the one a mark and Open in browser act on), not operate it
function BoardFrameView({
    frame,
    scale,
    selected,
    single,
    src,
    reloadKey,
    onSelect,
    children,
}: {
    frame: BoardFrame;
    scale: number;
    selected: boolean;
    single: boolean;
    src: string | null;
    reloadKey: number;
    onSelect: () => void;
    children?: ReactNode;
}) {
    const { board } = frame;
    const label = boardLabel(board.name);
    return (
        <>
            <button
                type="button"
                onClick={onSelect}
                title={board.title ?? label}
                className={cn(
                    "absolute flex cursor-pointer items-baseline gap-[8px] truncate text-left font-mono text-[11px]",
                    selected ? "text-accent-soft" : "text-muted hover:text-secondary"
                )}
                style={{ left: frame.left, top: frame.top - LABEL_OFFSET, maxWidth: frame.width }}
            >
                <span className="flex-none font-semibold">{label}</span>
                {board.title != null ? <span className="truncate">{board.title}</span> : null}
            </button>
            <div
                data-canvas-frame={board.name}
                data-canvas-board={selected ? "" : undefined}
                className={cn(
                    "absolute overflow-hidden rounded-[8px] border bg-background",
                    selected && !single ? "border-accent" : "border-edge-mid"
                )}
                style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
            >
                {src != null ? (
                    <BoardIframe
                        key={`${reloadKey}:${board.name}`}
                        src={src}
                        title={board.name}
                        style={{
                            width: board.w,
                            height: board.h,
                            transform: `scale(${scale})`,
                            transformOrigin: "0 0",
                        }}
                    />
                ) : null}
                {!selected ? (
                    <button
                        type="button"
                        aria-label={`Select ${label}`}
                        onClick={onSelect}
                        className="absolute inset-0 cursor-pointer hover:bg-accentbg"
                    />
                ) : null}
                {children}
            </div>
        </>
    );
}

// Arc DOM over the iframe, so the iframe can't take the pointer or focus while marking, and the window capture
// includes the box. hint: the in-board prompt, which the canvas window's header carries instead
function MarkLayer({ agentId, mark, hint }: { agentId: string; mark: Mark | null; hint: boolean }) {
    const [draft, setDraft] = useState<Box | null>(null);
    // the box keeps its place while it leaves, after the mark itself is gone
    const lastMark = useRef(mark);
    if (mark != null) {
        lastMark.current = mark;
    }
    const placed = lastMark.current;
    const at = (e: ReactPointerEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = at(e);
        setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    };
    const move = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (draft != null) {
            const p = at(e);
            setDraft({ ...draft, x1: p.x, y1: p.y });
        }
    };
    // a click-sized box keeps the mark already drawn
    const up = () => {
        if (draft != null) {
            const next = boxToMark(draft);
            if (next != null) {
                setMark(agentId, next);
            }
            setDraft(null);
        }
    };
    return (
        <div
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => setDraft(null)}
            className="absolute inset-0 cursor-crosshair select-none rounded-[8px] outline outline-2 -outline-offset-1 outline-accent"
        >
            {hint && mark == null && draft == null ? (
                <div className="pointer-events-none absolute left-1/2 top-[64px] -translate-x-1/2 rounded-full bg-accentbg px-[12px] py-[5px] text-[12.5px] font-semibold text-accent-soft">
                    Drag a box around what you want changed
                </div>
            ) : null}
            {placed != null ? (
                <div
                    className="pointer-events-none absolute"
                    style={{ left: placed.x, top: placed.y, width: placed.w, height: placed.h }}
                >
                    <PopoverReveal open={mark != null && draft == null} origin="center" className="h-full w-full">
                        <div
                            data-canvas-mark
                            className="h-full w-full rounded-[6px] border-2 border-accent bg-accentbg"
                        />
                    </PopoverReveal>
                </div>
            ) : null}
            {draft != null ? (
                <div
                    className="pointer-events-none absolute rounded-[6px] border-2 border-dashed border-accent"
                    style={{
                        left: Math.min(draft.x0, draft.x1),
                        top: Math.min(draft.y0, draft.y1),
                        width: Math.abs(draft.x1 - draft.x0),
                        height: Math.abs(draft.y1 - draft.y0),
                    }}
                />
            ) : null}
        </div>
    );
}

// the capture is of the window, so what must stay out of the picture needs a painted frame without it first
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// The review dialog's note card, under the box (above it when the pane has no room below): Enter sends the mark
// at once, Esc drops it. It sits beside the board frames rather than in one, since a frame clips its content.
function MarkNote(p: {
    model: AgentsViewModel;
    agent: AgentVM;
    mark: Mark;
    frame: BoardFrame;
    width: number;
    scrollRef: RefObject<HTMLDivElement | null>;
}) {
    const { agent, mark, frame } = p;
    const fieldRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // placed by hand before paint, in the frames' container, which starts CANVAS_TOP_PAD into the scroller
    useLayoutEffect(() => {
        const field = fieldRef.current;
        const scroller = p.scrollRef.current;
        if (field == null || scroller == null) {
            return;
        }
        const viewTop = scroller.scrollTop - CANVAS_TOP_PAD;
        const viewBottom = viewTop + scroller.clientHeight;
        const below = frame.top + mark.y + mark.h + NOTE_GAP;
        const above = frame.top + mark.y - NOTE_GAP - field.offsetHeight;
        const fitsBelow = below + field.offsetHeight <= viewBottom;
        field.style.top = `${fitsBelow || above < viewTop ? below : above}px`;
        field.style.left = `${Math.max(0, Math.min(frame.left + mark.x, p.width - field.offsetWidth))}px`;
        inputRef.current?.focus({ preventScroll: true });
    }, [mark.x, mark.y, mark.w, mark.h, frame.left, frame.top, p.width]);

    // the card hides while it sends, which drops the input's focus; a failed send gives it back
    useEffect(() => {
        if (!sending) {
            inputRef.current?.focus({ preventScroll: true });
        }
    }, [sending]);

    const send = async () => {
        setSending(true);
        setError(null);
        try {
            await nextPaint();
            await sendCanvasMark(p.model, agent);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSending(false);
        }
    };

    return (
        <div ref={fieldRef} data-canvas-mark-note className={cn("z-[2]", NOTE_CARD, sending && "invisible")}>
            <NoteCardBody
                inputRef={inputRef}
                value={mark.note}
                onChange={(note) => setMark(agent.id, { ...mark, note })}
                onSubmit={() => void send()}
                onCancel={() => setMark(agent.id, null)}
                label="What should change in the marked part"
                action="Send"
                busy={sending}
            />
            <AnimatePresence initial={false}>
                {error != null ? (
                    <motion.span
                        variants={errorNudge}
                        initial="initial"
                        animate="animate"
                        className="text-[12px] text-error"
                    >
                        {error}
                    </motion.span>
                ) : null}
            </AnimatePresence>
        </div>
    );
}

export function EdgeState({ children }: { children: ReactNode }) {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-[10px] p-[24px] text-center">
            {children}
        </div>
    );
}

export const EXPLAINER = "max-w-[440px] text-[13px] leading-[1.5] text-secondary";

// wavesrv serves the canvas itself, so this is a refusal or a dropped request, and the poller's next tick retries.
// The Rendered transcript's Mockup card words it the same
export const SERVER_DOWN = {
    title: "Arc could not serve this canvas",
    explainer: "The canvas files are on disk, but Arc got no answer serving them. It tries again every few seconds.",
};

export function ServerDown() {
    return (
        <EdgeState>
            <span className="flex items-center gap-[8px] text-[14px] font-semibold text-primary">
                <span className="h-[7px] w-[7px] rounded-full bg-error" />
                {SERVER_DOWN.title}
            </span>
            <span className={EXPLAINER}>{SERVER_DOWN.explainer}</span>
        </EdgeState>
    );
}

export function Removed({ agent, topic, inTab = false }: { agent: AgentVM; topic: string; inTab?: boolean }) {
    const exit = removedExit(inTab);
    return (
        <EdgeState>
            <span className="text-[14px] font-semibold text-primary">{topic} was removed</span>
            <span className={EXPLAINER}>
                Its folder under .superpowers/design is gone, usually because the feature shipped.
                {exit.swapNote ? " The swap control disappears once you close it." : ""}
            </span>
            <button type="button" onClick={() => detachCanvas(agent.id)} className={cn("mt-[4px]", CANVAS_BTN)}>
                {exit.label}
            </button>
        </EdgeState>
    );
}
