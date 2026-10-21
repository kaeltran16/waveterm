// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The agent's design canvas, shown on the Agent surface in place of its (still mounted, hidden) terminal.
// Thin: what it shows comes from canvasmodel/canvasmarks, and what it knows comes from the agent's canvas state,
// which useCanvasPoller keeps current.

import { Segmented } from "@/app/element/segmented";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { SquareDashed } from "lucide-react";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from "react";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
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
    shownBoard,
    shownBoards,
    updatedAgo,
    type BoardFrame,
} from "./canvasmodel";
import { sendCanvasMark } from "./canvassend";
import {
    canvasStateAtom,
    detachCanvas,
    selectCanvasBoard,
    selectCanvasTab,
    setMark,
    setMarking,
    type CanvasState,
} from "./canvasstore";
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

// New run opens as an orchestrator run on the agent's project, with this canvas as the run's prototype
function openBuildRun(model: AgentsViewModel, agent: AgentVM, s: CanvasState): void {
    globalStore.set(newRunPrefillAtom, {
        projectName: projectOf(agent),
        goal: buildGoal(s.dir, shownBoards(s)),
        shape: "orchestrator",
        prototype: prototypePath(s.dir, shownBoards(s)),
    });
    globalStore.set(model.newRunOpenAtom, true);
}

// onBack: shown inside a brainstorm, which owns the way back and the run launch
export function CanvasPane({ model, agent, onBack }: { model: AgentsViewModel; agent: AgentVM; onBack?: () => void }) {
    const s = useAtomValue(canvasStateAtom(agent.id));
    const now = useAtomValue(model.nowAtom);
    const [measureRef, scrollRef, rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const selected = s != null ? shownBoard(s).name : null;
    // a tab, [ or ] can pick a board below the fold. Only its top edge is brought into view, label included:
    // scrollIntoView top-aligns any board taller than the pane, which scrolled the labels away on every pick
    useEffect(() => {
        const pane = scrollRef.current;
        const frame = pane?.querySelector(`[data-canvas-frame="${CSS.escape(selected ?? "")}"]`);
        if (pane == null || frame == null) {
            return;
        }
        const top = frame.getBoundingClientRect().top - pane.getBoundingClientRect().top;
        if (top < CANVAS_TOP_PAD || top > pane.clientHeight - CANVAS_TOP_PAD) {
            pane.scrollTop += top - CANVAS_TOP_PAD;
        }
    }, [selected]);
    if (s == null) {
        return null;
    }
    const pane = paneState(s);
    const board = shownBoard(s);
    const layout = canvasLayout(shownBoards(s), rect?.width ?? 0);
    const scale = layout.scale;
    const marking = s.marking && pane === "board";
    const markFrame = marking && s.mark != null ? layout.frames.find((f) => f.board.name === board.name) : undefined;
    const meta = [updatedAgo(now, s.lastModifiedMs), `${Math.round(scale * 100)}%`].filter(Boolean).join(" · ");

    return (
        <div data-canvas-pane className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[10px] border-b border-edge-faint bg-surface px-[22px] py-[8px]">
                {onBack != null ? (
                    <button type="button" onClick={onBack} className={CANVAS_BTN}>
                        Back to the design
                    </button>
                ) : null}
                <span className="font-mono text-[12px] font-semibold text-secondary">{s.topic}</span>
                {s.boards.length > 0 ? (
                    <Segmented
                        role="tablist"
                        ariaLabel="Boards"
                        title={`Previous and next board (${formatChordString("[")} and ${formatChordString("]")})`}
                        value={currentTab(s)}
                        options={canvasTabs(s.boards).map((t) => ({
                            key: t,
                            label: t === ALL_TAB ? "All" : boardLabel(t),
                        }))}
                        onChange={(tab) => selectCanvasTab(agent.id, tab)}
                    />
                ) : null}
                <div className="flex-1" />
                {pane === "board" ? <span className="font-mono text-[10.5px] text-muted">{meta}</span> : null}
                <button
                    type="button"
                    title={`Mark part of the board (${formatChordString("m")})`}
                    aria-pressed={marking}
                    disabled={pane !== "board"}
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
                                onClick={() => getApi().openExternal(boardUrl(s.base!, s.topic, board.name))}
                                className={CANVAS_BTN}
                            >
                                Open in browser
                            </button>
                        ) : null}
                        {s.boards.length > 0 && onBack == null ? (
                            <button type="button" onClick={() => openBuildRun(model, agent, s)} className={CANVAS_BTN}>
                                Build this…
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col bg-surface-code">
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
                        <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
                            {layout.frames.map((f) => (
                                <BoardFrameView
                                    key={f.board.name}
                                    frame={f}
                                    scale={scale}
                                    selected={f.board.name === board.name}
                                    single={layout.frames.length === 1}
                                    src={
                                        pane === "board" && s.base != null
                                            ? boardUrl(s.base, s.topic, f.board.name)
                                            : null
                                    }
                                    reloadKey={s.reloadKey}
                                    onSelect={() => selectCanvasBoard(agent.id, f.board.name)}
                                >
                                    {marking && f.board.name === board.name ? (
                                        <MarkLayer agentId={agent.id} mark={s.mark} />
                                    ) : null}
                                </BoardFrameView>
                            ))}
                            {markFrame != null ? (
                                <MarkNote
                                    agent={agent}
                                    mark={s.mark!}
                                    frame={markFrame}
                                    width={layout.width}
                                    scrollRef={scrollRef}
                                />
                            ) : null}
                        </div>
                    </div>
                )}
            </div>
        </div>
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
                    <iframe
                        key={`${reloadKey}:${board.name}`}
                        src={src}
                        title={board.name}
                        sandbox="allow-scripts allow-same-origin"
                        className="absolute left-0 top-0 border-0"
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
// includes the box
function MarkLayer({ agentId, mark }: { agentId: string; mark: Mark | null }) {
    const [draft, setDraft] = useState<Box | null>(null);
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
            {mark == null && draft == null ? (
                <div className="pointer-events-none absolute left-1/2 top-[64px] -translate-x-1/2 rounded-full bg-accentbg px-[12px] py-[5px] text-[12.5px] font-semibold text-accent-soft">
                    Drag a box around what you want changed
                </div>
            ) : null}
            {mark != null && draft == null ? (
                <div
                    data-canvas-mark
                    className="pointer-events-none absolute rounded-[6px] border-2 border-accent bg-accentbg"
                    style={{ left: mark.x, top: mark.y, width: mark.w, height: mark.h }}
                />
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
            await sendCanvasMark(agent);
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
            {error != null ? <span className="text-[12px] text-error">{error}</span> : null}
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

// wavesrv serves the canvas itself, so this is a refusal or a dropped request, and the poller's next tick retries
function ServerDown() {
    return (
        <EdgeState>
            <span className="flex items-center gap-[8px] text-[14px] font-semibold text-primary">
                <span className="h-[7px] w-[7px] rounded-full bg-error" />
                Arc could not serve this canvas
            </span>
            <span className={EXPLAINER}>
                The canvas files are on disk, but Arc got no answer serving them. It tries again every few seconds.
            </span>
        </EdgeState>
    );
}

function Removed({ agent, topic }: { agent: AgentVM; topic: string }) {
    return (
        <EdgeState>
            <span className="text-[14px] font-semibold text-primary">{topic} was removed</span>
            <span className={EXPLAINER}>
                Its folder under .superpowers/design is gone, usually because the feature shipped. The swap control
                disappears once you go back to the terminal.
            </span>
            <button type="button" onClick={() => detachCanvas(agent.id)} className={cn("mt-[4px]", CANVAS_BTN)}>
                Back to terminal
            </button>
        </EdgeState>
    );
}
