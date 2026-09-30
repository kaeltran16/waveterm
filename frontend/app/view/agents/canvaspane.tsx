// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The agent's design-local canvas, shown on the Agent surface in place of its (still mounted, hidden) terminal.
// Thin: what it shows comes from canvasmodel/canvasmarks, and what it knows comes from the agent's canvas state,
// which useCanvasPoller keeps current.

import { Segmented } from "@/app/element/segmented";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { SquareDashed, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import { addMark, removeMark, setMarkNote, type Box, type Mark } from "./canvasmarks";
import {
    boardLabel,
    boardUrl,
    buildGoal,
    CANVAS_PORT_COUNT,
    CANVAS_PORT_FIRST,
    canvasDesignDir,
    fitScale,
    paneState,
    pickFreePort,
    prototypePath,
    serverDownText,
    shownBoard,
    updatedAgo,
} from "./canvasmodel";
import { pollAndMerge, probeCanvasPorts, tauriCanvasIO } from "./canvaspoller";
import { sendCanvasMarks } from "./canvassend";
import {
    canvasStateAtom,
    clearMarks,
    detachCanvas,
    getCanvas,
    selectCanvasBoard,
    setMarking,
    updateCanvas,
    type CanvasState,
} from "./canvasstore";

// the app bar's secondary and primary buttons
export const CANVAS_BTN =
    "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-edge-mid bg-surface-raised px-[12px] py-[6px] text-[12.5px] font-semibold text-primary hover:border-edge-strong hover:bg-surface-hover";
export const CANVAS_PRIMARY_BTN =
    "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] bg-accent px-[12px] py-[7px] text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-50";

// start_canvas_server resolves once python spawns, not once it listens
const START_POLL_MS = 500;
const START_WAIT_MS = 5000;

const MARK_CHIP =
    "h-[20px] w-[20px] rounded-full bg-accent text-center font-mono text-[11px] font-bold leading-[20px] text-background";

// New run opens as an orchestrator run on the agent's project, with this canvas as the run's prototype
function openBuildRun(model: AgentsViewModel, agent: AgentVM, s: CanvasState): void {
    globalStore.set(newRunPrefillAtom, {
        projectName: projectOf(agent),
        goal: buildGoal(s.dir, s.boards),
        prototype: prototypePath(s.dir, s.boards),
    });
    globalStore.set(model.newRunOpenAtom, true);
}

export function CanvasPane({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const s = useAtomValue(canvasStateAtom(agent.id));
    const now = useAtomValue(model.nowAtom);
    const [measureRef, , rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    if (s == null) {
        return null;
    }
    const pane = paneState(s);
    const board = shownBoard(s);
    const scale = fitScale(rect?.width ?? 0, board.w);
    const marking = s.marking && pane === "board";
    const meta = [updatedAgo(now, s.lastModifiedMs), `${Math.round(scale * 100)}%`].filter(Boolean).join(" · ");

    return (
        <div data-canvas-pane className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[10px] border-b border-edge-faint bg-surface px-[22px] py-[8px]">
                <span className="font-mono text-[12px] font-semibold text-secondary">{s.topic}</span>
                {s.boards.length > 0 ? (
                    <Segmented
                        role="tablist"
                        ariaLabel="Boards"
                        title={`Previous and next board (${formatChordString("[")} and ${formatChordString("]")})`}
                        value={board.name}
                        options={s.boards.map((b) => ({ key: b.name, label: boardLabel(b.name) }))}
                        onChange={(name) => selectCanvasBoard(agent.id, name)}
                    />
                ) : null}
                <div className="flex-1" />
                {pane === "board" ? <span className="font-mono text-[10.5px] text-muted">{meta}</span> : null}
                <button
                    type="button"
                    title={`Mark parts of the board (${formatChordString("m")})`}
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
                        {s.port != null ? (
                            <button
                                type="button"
                                onClick={() => getApi().openExternal(boardUrl(s.port!, s.topic, board.name))}
                                className={CANVAS_BTN}
                            >
                                Open in browser
                            </button>
                        ) : null}
                        {s.boards.length > 0 ? (
                            <button type="button" onClick={() => openBuildRun(model, agent, s)} className={CANVAS_BTN}>
                                Build this…
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col bg-surface-code">
                {pane === "server-down" ? (
                    <ServerDown agent={agent} s={s} />
                ) : pane === "removed" ? (
                    <Removed agent={agent} topic={s.topic} />
                ) : (
                    // the iframe gets the board's full height, so a board taller than the pane scrolls here, in Arc,
                    // instead of showing the board page's own scrollbars. The gutter is reserved so the scrollbar
                    // appearing can't narrow the pane, change the fit scale, and make itself disappear again
                    <div
                        ref={measureRef}
                        data-canvas-scroll
                        className="flex min-h-0 flex-1 justify-center overflow-y-auto overflow-x-hidden py-[16px] [scrollbar-gutter:stable]"
                    >
                        <div
                            data-canvas-board
                            className="relative flex-none overflow-hidden rounded-[8px] border border-edge-mid bg-background"
                            style={{ width: board.w * scale, height: board.h != null ? board.h * scale : undefined }}
                        >
                            {pane === "board" && s.port != null ? (
                                <iframe
                                    key={`${s.reloadKey}:${board.name}`}
                                    src={boardUrl(s.port, s.topic, board.name)}
                                    title={board.name}
                                    sandbox="allow-scripts allow-same-origin"
                                    className="absolute left-0 top-0 border-0"
                                    style={{
                                        width: board.w,
                                        height: board.h ?? (rect?.height ?? 0) / scale,
                                        transform: `scale(${scale})`,
                                        transformOrigin: "0 0",
                                    }}
                                />
                            ) : null}
                            {marking ? <MarkLayer agentId={agent.id} marks={s.marks} /> : null}
                        </div>
                    </div>
                )}
                {marking ? <MarkTray agent={agent} marks={s.marks} /> : null}
            </div>
        </div>
    );
}

// Arc DOM over the iframe, so the iframe can't take the pointer or focus while marking, and the window capture
// includes the boxes
function MarkLayer({ agentId, marks }: { agentId: string; marks: Mark[] }) {
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
    const up = () => {
        if (draft != null) {
            updateCanvas(agentId, (s) => ({ ...s, marks: addMark(s.marks, draft) }));
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
            {marks.length === 0 && draft == null ? (
                <div className="pointer-events-none absolute left-1/2 top-[64px] -translate-x-1/2 rounded-full bg-accentbg px-[12px] py-[5px] text-[12.5px] font-semibold text-accent-soft">
                    Drag a box around what you want changed
                </div>
            ) : null}
            {marks.map((m, i) => (
                <div
                    key={i}
                    className="pointer-events-none absolute rounded-[6px] border-2 border-accent bg-accentbg"
                    style={{ left: m.x, top: m.y, width: m.w, height: m.h }}
                >
                    <span className={cn("absolute left-[-11px] top-[-11px]", MARK_CHIP)}>{i + 1}</span>
                </div>
            ))}
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

function MarkTray({ agent, marks }: { agent: AgentVM; marks: Mark[] }) {
    const agentId = agent.id;
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const noMarks = marks.length === 0;

    const send = async () => {
        setSending(true);
        setError(null);
        try {
            await sendCanvasMarks(agent);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="flex flex-none items-start gap-[16px] border-t border-border bg-surface px-[22px] py-[12px]">
            <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
                {marks.length === 0 ? (
                    <span className="py-[6px] text-[13px] text-muted">
                        No marks yet. Each box you draw gets a number and a note here.
                    </span>
                ) : null}
                {marks.map((m, i) => (
                    <div key={i} className="flex items-center gap-[10px]">
                        <span className={cn("flex-none", MARK_CHIP)}>{i + 1}</span>
                        <input
                            aria-label={`Note for mark ${i + 1}`}
                            placeholder="What should change here? (optional)"
                            value={m.note}
                            onChange={(e) =>
                                updateCanvas(agentId, (s) => ({ ...s, marks: setMarkNote(s.marks, i, e.target.value) }))
                            }
                            className="min-w-0 flex-1 rounded-[7px] border border-edge-mid bg-surface-raised px-[10px] py-[6px] text-[13px] text-primary outline-none"
                        />
                        <button
                            type="button"
                            aria-label={`Remove mark ${i + 1}`}
                            onClick={() => updateCanvas(agentId, (s) => ({ ...s, marks: removeMark(s.marks, i) }))}
                            className="flex-none cursor-pointer rounded-[7px] border border-edge-mid bg-surface-raised p-[6px] leading-none text-secondary hover:border-edge-strong"
                        >
                            <X size={14} strokeWidth={1.9} aria-hidden />
                        </button>
                    </div>
                ))}
            </div>
            <div className="flex flex-none flex-col items-end gap-[6px]">
                <div data-canvas-tray-actions className="flex items-center gap-[10px]">
                    <button type="button" onClick={() => clearMarks(agentId)} className={CANVAS_BTN}>
                        Clear
                    </button>
                    <button
                        type="button"
                        data-canvas-send
                        title={`Send the marks to the agent (${formatChordString("Ctrl:Enter")})`}
                        disabled={noMarks || sending}
                        onClick={() => void send()}
                        className={cn(
                            CANVAS_PRIMARY_BTN,
                            noMarks && "bg-surface-hover text-muted hover:bg-surface-hover disabled:opacity-100"
                        )}
                    >
                        {sending ? "Sending…" : `Send to ${agent.name}`}
                    </button>
                </div>
                <span className="text-[12px] text-muted">
                    Saves a picture of the board with your marks, then types one line into the agent.
                </span>
                {error != null ? <span className="max-w-[440px] text-[12px] text-error">{error}</span> : null}
            </div>
        </div>
    );
}

function EdgeState({ children }: { children: ReactNode }) {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-[10px] p-[24px] text-center">
            {children}
        </div>
    );
}

const EXPLAINER = "max-w-[440px] text-[13px] leading-[1.5] text-secondary";

function ServerDown({ agent, s }: { agent: AgentVM; s: CanvasState }) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const alive = useRef(true);
    useEffect(
        () => () => {
            alive.current = false;
        },
        []
    );

    const start = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const port = pickFreePort(await probeCanvasPorts(s.topic, tauriCanvasIO));
            if (port == null) {
                const last = CANVAS_PORT_FIRST + CANVAS_PORT_COUNT - 1;
                throw new Error(`No free port in ${CANVAS_PORT_FIRST}–${last}`);
            }
            await invoke("start_canvas_server", { dir: canvasDesignDir(s.projectDir), port });
            for (let waited = 0; waited < START_WAIT_MS && alive.current; waited += START_POLL_MS) {
                await new Promise((r) => setTimeout(r, START_POLL_MS));
                await pollAndMerge(agent.id);
                if (getCanvas(agent.id)?.status === "ready") {
                    return;
                }
            }
            if (alive.current) {
                setMessage(`Started, but nothing answered on ${port}`);
            }
        } catch (e) {
            if (alive.current) {
                setMessage(e instanceof Error ? e.message : String(e));
            }
        } finally {
            if (alive.current) {
                setBusy(false);
            }
        }
    };

    return (
        <EdgeState>
            <span className="flex items-center gap-[8px] text-[14px] font-semibold text-primary">
                <span className="h-[7px] w-[7px] rounded-full bg-error" />
                {serverDownText(s.port)}
            </span>
            <span className={EXPLAINER}>
                The canvas files are on disk, but nothing is serving them. Start the server, or press{" "}
                <span className="font-mono">c</span> and ask the agent to.
            </span>
            <button
                type="button"
                disabled={busy}
                onClick={() => void start()}
                className={cn("mt-[4px]", CANVAS_PRIMARY_BTN)}
            >
                {busy ? "Starting…" : "Start server"}
            </button>
            {message != null ? <span className="max-w-[440px] text-[12px] text-error">{message}</span> : null}
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
