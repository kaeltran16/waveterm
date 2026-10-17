// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The agent's brainstorm, shown on the Agent surface in place of its (still mounted, hidden) terminal. Thin: what it
// shows comes from brainstormmodel, what it knows from the agent's brainstorm state (BrainstormPoller keeps it
// current), and every action is one line typed into the agent (brainstormsend).

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeFeBlockRouteId } from "@/app/store/wshrouter";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { getProcExitAtom } from "./agentcontrollerstore";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import {
    brainstormCounts,
    canCheck,
    exitedSummary,
    handoffSummary,
    handoffView,
    historyRows,
    orderedParts,
    paneView,
    partTitle,
    resumePrompt,
    runLine,
    sentenceDiff,
    type BrainstormAction,
    type BrainstormFile,
    type BrainstormPart,
    type BuilderQuestion as BuilderQuestionT,
    type HandoffView,
} from "./brainstormmodel";
import { approveAndOpenRun, openRunLauncher, sendBrainstorm } from "./brainstormsend";
import {
    brainstormAtom,
    dismissBrainstorm,
    openBrainstormBoard,
    updateBrainstorm,
    type BrainstormState,
} from "./brainstormstore";
import { boardUrl, canvasDir, DEFAULT_BOARD_H, DEFAULT_BOARD_W, type CanvasBoard } from "./canvasmodel";
import { CANVAS_BTN, CANVAS_PRIMARY_BTN, CanvasPane, EdgeState, EXPLAINER } from "./canvaspane";
import { attachCanvas } from "./canvasstore";
import { runtimeStartupCommand, type Runtime } from "./launch";

const WORKING_TITLE = "The agent is writing; this opens when it asks again";
const CHECK_TITLE = "Opens when the agent has nothing left to ask and every part is yours";
const APPROVE_TITLE = "Answer the builder’s question first";
const THUMB_W = 300;
const THUMB_MAX_H = 200;
const RUN_ID_CHARS = 8;
// how far back the exited card looks for the agent's last words
const LAST_OUTPUT_LINES = 200;

const DOT = "h-[7px] w-[7px] flex-none rounded-full";
const DOT_YOURS = cn(DOT, "bg-success");
const DOT_GUESS = cn(DOT, "border-[1.5px] border-dashed border-ink-mid");
const DOT_OPEN = cn(DOT, "border-[1.5px] border-ink-faint");
const DOT_ASKED = cn(DOT, "bg-warning");
const SMALL_DOT = "h-[6px] w-[6px] flex-none rounded-full";
const PART_BTN =
    "cursor-pointer rounded-[7px] border border-edge-mid bg-surface-raised px-[10px] py-[4px] text-[12px] font-semibold text-primary hover:border-edge-strong disabled:cursor-default disabled:opacity-50";
const CHIP =
    "cursor-pointer rounded-[6px] border border-border bg-transparent px-[12px] py-[4px] text-[12px] text-primary hover:bg-surface-hover disabled:cursor-default disabled:opacity-50";
const FIELD =
    "resize-none rounded-[8px] border border-border bg-background px-[12px] py-[9px] text-[13px] leading-[1.5] text-primary outline-none placeholder:text-muted focus:border-warning/60";
const LINK = "cursor-pointer text-accent-soft hover:underline";
const CARD = "overflow-hidden rounded-[8px] border border-edge-mid bg-surface-raised";
const CARD_HEAD = "flex items-center gap-[8px] border-b border-border px-[14px] py-[9px]";
const CARD_LABEL = "font-mono text-[11px] font-semibold";
const ERROR_LINE = "text-[12px] text-error";

type PartView = "yours" | "guess" | "changed" | "asked" | "writing" | "open";

function partView(f: BrainstormFile, p: BrainstormPart): PartView {
    if (p.state === "guess") {
        return p.was != null ? "changed" : "guess";
    }
    if (p.state === "asked" && f.working != null && f.question == null) {
        return "writing";
    }
    return p.state;
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// one per control group, so a failure shows under the control that sent it
function useAction() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const run = async (fn: () => Promise<void>): Promise<boolean> => {
        setBusy(true);
        setError(null);
        try {
            await fn();
            return true;
        } catch (e) {
            setError(errText(e));
            return false;
        } finally {
            setBusy(false);
        }
    };
    return { busy, error, run };
}

// Enter sends, Shift+Enter is a newline, and Enter that ends an IME composition stays with the IME
function onEnter(e: KeyboardEvent<HTMLTextAreaElement>, send: () => void): void {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    send();
}

function scrollToPart(root: RefObject<HTMLElement>, id: string): void {
    root.current
        ?.querySelector(`[data-brainstorm-part="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function hhmm(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function BrainstormPane({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const s = useAtomValue(brainstormAtom(agent.id));
    const exit = useAtomValue(getProcExitAtom(agent.blockId ?? ""));
    if (s == null) {
        return null;
    }
    const view = paneView({
        file: s.file,
        error: s.error,
        removed: s.removed,
        exited: exit != null,
        showDesign: s.showDesign,
        board: s.board,
    });
    return (
        <div data-brainstorm-pane data-brainstorm-view={view} className="flex min-h-0 flex-1 flex-col">
            {view === "removed" ? (
                <Removed agent={agent} topic={s.topic} />
            ) : view === "error" ? (
                <Unreadable s={s} />
            ) : view === "exited" ? (
                <Exited model={model} agent={agent} s={s} exit={exit!} />
            ) : view === "board" ? (
                <CanvasPane model={model} agent={agent} onBack={() => openBrainstormBoard(agent.id, null)} />
            ) : view === "check" ? (
                <Check model={model} agent={agent} s={s} f={s.file!} />
            ) : s.file == null ? (
                <>
                    <Toolbar topic={s.topic} />
                    <EdgeState>
                        <span className={EXPLAINER}>Reading {s.path}…</span>
                    </EdgeState>
                </>
            ) : (
                <Design agent={agent} s={s} f={s.file} />
            )}
        </div>
    );
}

function Toolbar({ topic, children }: { topic: string; children?: ReactNode }) {
    return (
        <div className="flex flex-none items-center gap-[10px] border-b border-edge-faint bg-surface px-[22px] py-[8px]">
            <span className="font-mono text-[12px] font-semibold text-secondary">{topic}</span>
            <div className="flex-1" />
            {children}
        </div>
    );
}

// the last good contents stay on screen; this says they may be behind the file
function StaleBanner({ s }: { s: BrainstormState }) {
    if (s.error == null) {
        return null;
    }
    return (
        <div
            data-brainstorm-stale
            className="flex flex-none items-center gap-[8px] border-b border-edge-faint bg-surface px-[22px] py-[6px] text-[12px] text-ink-mid"
        >
            <span className={cn(SMALL_DOT, "bg-error")} />
            <span className="min-w-0 truncate" title={`${s.error}\n${s.path}`}>
                Arc could not read the latest brainstorm.json; this is the last version it read. {s.error}
            </span>
        </div>
    );
}

function Design({ agent, s, f }: { agent: AgentVM; s: BrainstormState; f: BrainstormFile }) {
    const partsRef = useRef<HTMLDivElement>(null);
    const check = useAction();
    const working = f.working != null;
    const counts = brainstormCounts(f);
    const ready = canCheck(f) && !working;
    const rows = historyRows(f);
    const fresh = f.history.length === 0;
    const goTo = (id: string) => scrollToPart(partsRef, id);

    return (
        <>
            <Toolbar topic={s.topic}>
                <div
                    data-brainstorm-counts
                    className="flex items-center gap-[12px] font-mono text-[10.5px] text-ink-mid"
                >
                    <span className="flex items-center gap-[5px]">
                        <span className={DOT_YOURS} />
                        {counts.yours} yours
                    </span>
                    <span className="flex items-center gap-[5px]">
                        <span className={DOT_GUESS} />
                        {counts.guesses} guesses
                    </span>
                    <span className="flex items-center gap-[5px]">
                        <span className={DOT_OPEN} />
                        {counts.open} open
                    </span>
                </div>
                <button
                    type="button"
                    data-brainstorm-check-btn
                    disabled={!ready || check.busy}
                    title={working ? WORKING_TITLE : ready ? undefined : CHECK_TITLE}
                    onClick={() => void check.run(() => sendBrainstorm(agent, { kind: "check" }))}
                    className={CANVAS_PRIMARY_BTN}
                >
                    Check with a builder
                </button>
            </Toolbar>
            {check.error != null ? (
                <div className={cn(ERROR_LINE, "flex-none border-b border-edge-faint px-[22px] py-[6px] text-right")}>
                    {check.error}
                </div>
            ) : null}
            <StaleBanner s={s} />
            <div className="flex min-h-0 flex-1">
                <div className="flex w-[430px] flex-none flex-col overflow-hidden border-r border-border bg-surface">
                    <div className="flex flex-col gap-[12px] px-[20px] pb-[14px] pt-[18px]">
                        {fresh ? (
                            <div className="text-[12.5px] leading-[1.5] text-ink-mid">
                                Rather skip the questions and have me start? Say so.
                            </div>
                        ) : null}
                        {working ? (
                            <WorkingCard working={f.working!} />
                        ) : f.question != null ? (
                            <QuestionCard agent={agent} f={f} fresh={fresh} goTo={goTo} />
                        ) : null}
                    </div>
                    {rows.length > 0 ? (
                        <>
                            <div className="px-[20px] pb-[8px] pt-[4px] text-[12px] font-semibold text-ink-mid">
                                Earlier
                            </div>
                            <div
                                data-brainstorm-history
                                className="flex min-h-0 flex-1 flex-col gap-[4px] overflow-y-auto px-[20px] pb-[20px]"
                            >
                                {rows.map((h, i) => (
                                    <div
                                        key={`${h.label}:${rows.length - i}`}
                                        className="flex flex-col gap-[6px] border-t border-edge-faint py-[10px]"
                                    >
                                        <div className="flex items-baseline gap-[8px]">
                                            <span className="flex-none font-mono text-[10.5px] text-ink-faint">
                                                {h.label}
                                                {i === 0 && working ? " · just now" : ""}
                                            </span>
                                            <span className="text-[12.5px] leading-[1.45] text-ink-mid">{h.q}</span>
                                        </div>
                                        <div className="text-[13.5px] leading-[1.5] text-ink-hi">{h.a}</div>
                                        {h.into.length > 0 ? (
                                            <div className="text-[11.5px] text-muted">
                                                Went into{" "}
                                                {h.into.map((p, j) => (
                                                    <span key={p.id}>
                                                        {j > 0 ? ", " : ""}
                                                        <button
                                                            type="button"
                                                            onClick={() => goTo(p.id)}
                                                            className={LINK}
                                                        >
                                                            {p.title}
                                                        </button>
                                                    </span>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        </>
                    ) : null}
                </div>
                <div ref={partsRef} className="min-w-0 flex-1 overflow-y-auto bg-background">
                    <div className="sticky top-0 z-[1] border-b border-border bg-background">
                        <div className="mx-auto flex max-w-[640px] flex-col gap-[4px] px-[44px] pb-[10px] pt-[12px]">
                            <div className="flex items-center gap-[8px]">
                                <span className="text-[12px] font-semibold text-secondary">Design</span>
                                <span className="text-[12px] text-muted">written as you talk</span>
                                <div className="flex-1" />
                                <div className="flex gap-[14px] text-[11.5px] text-ink-mid">
                                    <span className="flex items-center gap-[6px]">
                                        <span className={DOT_YOURS} />
                                        Yours
                                    </span>
                                    <span className="flex items-center gap-[6px]">
                                        <span className={DOT_GUESS} />
                                        Agent’s guess
                                    </span>
                                    <span className="flex items-center gap-[6px]">
                                        <span className={DOT_OPEN} />
                                        Open
                                    </span>
                                </div>
                            </div>
                            <div className="flex min-w-0 items-baseline gap-[10px]">
                                <h1 className="m-0 flex-none text-[16px] font-bold text-primary">{f.title}</h1>
                                {f.spec ? (
                                    <span
                                        title={f.spec}
                                        className="min-w-0 truncate font-mono text-[10.5px] text-muted"
                                    >
                                        {f.spec}
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    </div>
                    <div className="mx-auto flex max-w-[640px] flex-col gap-[6px] px-[32px] pb-[32px] pt-[12px]">
                        {orderedParts(f).map((p) => (
                            <PartCard key={p.id} agent={agent} s={s} f={f} part={p} />
                        ))}
                        {fresh ? (
                            <span className="px-[12px] pt-[10px] text-[12.5px] leading-[1.5] text-muted">
                                Parts appear here as the conversation finds them. Nothing else exists until you have
                                said something.
                            </span>
                        ) : null}
                    </div>
                </div>
            </div>
        </>
    );
}

function WorkingCard({ working }: { working: string }) {
    return (
        <div data-brainstorm-working className={CARD}>
            <div className={CARD_HEAD}>
                <span className={cn(SMALL_DOT, "bg-success")} />
                <span className={cn(CARD_LABEL, "text-success")}>Working</span>
            </div>
            <div className="px-[14px] py-[12px] text-[13.5px] leading-[1.5] text-secondary">
                {working} The next question comes after.
            </div>
        </div>
    );
}

function QuestionCard({
    agent,
    f,
    fresh,
    goTo,
}: {
    agent: AgentVM;
    f: BrainstormFile;
    fresh: boolean;
    goTo: (id: string) => void;
}) {
    const q = f.question!;
    const [draft, setDraft] = useState("");
    const act = useAction();
    const send = async (action: BrainstormAction) => {
        if (await act.run(() => sendBrainstorm(agent, action))) {
            if (action.kind === "answer") {
                setDraft("");
            }
        }
    };
    return (
        <div data-brainstorm-question className={CARD}>
            <div className={CARD_HEAD}>
                <span className={cn(SMALL_DOT, "bg-warning")} />
                <span className={cn(CARD_LABEL, "text-warning")}>Question {q.n}</span>
                <div className="flex-1" />
                {q.part ? (
                    <span className="text-[11.5px] text-muted">
                        for{" "}
                        <button type="button" onClick={() => goTo(q.part)} className={LINK}>
                            {partTitle(f, q.part)}
                        </button>
                    </span>
                ) : null}
            </div>
            <div className="flex flex-col gap-[12px] px-[14px] pb-[12px] pt-[14px]">
                <div className="whitespace-pre-line text-[14.5px] font-semibold leading-[1.5] text-primary">
                    {q.text}
                </div>
                <textarea
                    data-brainstorm-answer
                    aria-label="Your answer"
                    rows={3}
                    value={draft}
                    placeholder="Answer in your own words…"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) =>
                        onEnter(e, () => {
                            if (draft.trim() !== "" && !act.busy) {
                                void send({ kind: "answer", text: draft });
                            }
                        })
                    }
                    className={FIELD}
                />
                <div className="flex items-center gap-[8px]">
                    {!fresh ? (
                        <button
                            type="button"
                            disabled={act.busy}
                            onClick={() => void send({ kind: "guess" })}
                            className={CHIP}
                        >
                            Guess for me
                        </button>
                    ) : null}
                    <button
                        type="button"
                        disabled={act.busy}
                        onClick={() => void send({ kind: "skip" })}
                        className={CHIP}
                    >
                        Skip the questions
                    </button>
                    <div className="flex-1" />
                    <EnterSends />
                </div>
                {act.error != null ? <span className={ERROR_LINE}>{act.error}</span> : null}
            </div>
        </div>
    );
}

function EnterSends() {
    return (
        <span className="flex items-center gap-[6px] text-[11.5px] text-muted">
            <span className="rounded-[5px] border border-b-2 border-edge-strong px-[5px] font-mono text-[10.5px] text-secondary">
                Enter
            </span>
            sends
        </span>
    );
}

function PartCard({
    agent,
    s,
    f,
    part,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    part: BrainstormPart;
}) {
    const view = partView(f, part);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const act = useAction();
    const working = f.working != null;
    const locked = working || act.busy;
    const lockTitle = working ? WORKING_TITLE : undefined;
    const send = (action: BrainstormAction) => act.run(() => sendBrainstorm(agent, action));
    const startEdit = () => {
        setDraft(part.body);
        setEditing(true);
    };
    const editBtn = (quiet: boolean) => (
        <button
            type="button"
            disabled={locked}
            title={lockTitle}
            onClick={startEdit}
            className={
                quiet
                    ? "cursor-pointer border-0 bg-transparent px-[4px] py-[2px] text-[12px] text-muted hover:text-secondary disabled:cursor-default disabled:opacity-50"
                    : cn(PART_BTN, "text-secondary")
            }
        >
            Edit
        </button>
    );

    let dot: string;
    let label: ReactNode;
    let actions: ReactNode = null;
    switch (view) {
        case "yours":
            dot = DOT_YOURS;
            label = (
                <>
                    <span className="text-[11.5px] text-success">Yours</span>
                    <div className="flex-1" />
                    {part.from ? <span className="text-[11.5px] text-muted">{part.from}</span> : null}
                </>
            );
            actions = editBtn(true);
            break;
        case "guess":
            dot = DOT_GUESS;
            label = (
                <span className="text-[11.5px] text-ink-mid">Agent’s guess{part.from ? ` · ${part.from}` : ""}</span>
            );
            actions = (
                <>
                    <button
                        type="button"
                        disabled={locked}
                        title={lockTitle}
                        onClick={() => void send({ kind: "confirm", part: part.id })}
                        className={PART_BTN}
                    >
                        That’s right
                    </button>
                    {editBtn(false)}
                </>
            );
            break;
        case "changed":
            dot = DOT_GUESS;
            label = <span className="text-[11.5px] text-accent-soft">Changed since you confirmed it</span>;
            actions = (
                <>
                    <button
                        type="button"
                        disabled={locked}
                        title={lockTitle}
                        onClick={() => void send({ kind: "keep", part: part.id })}
                        className={PART_BTN}
                    >
                        Keep the change
                    </button>
                    <button
                        type="button"
                        disabled={locked}
                        title={lockTitle}
                        onClick={() => void send({ kind: "restore", part: part.id })}
                        className={cn(PART_BTN, "text-secondary")}
                    >
                        Put mine back
                    </button>
                </>
            );
            break;
        case "asked":
            dot = DOT_ASKED;
            label = <span className="text-[11.5px] text-warning">Asked now</span>;
            break;
        case "writing":
            dot = DOT_YOURS;
            label = <span className="text-[11.5px] text-success">Being written</span>;
            break;
        default:
            dot = DOT_OPEN;
            label = <span className="text-[11.5px] text-muted">Open</span>;
    }

    return (
        <div
            data-brainstorm-part={part.id}
            data-state={view}
            className={cn(
                "flex scroll-mt-[96px] flex-col rounded-[8px]",
                view === "changed" ? "gap-[8px] px-[14px] py-[12px]" : "gap-[5px] px-[12px] py-[10px]",
                (view === "guess" || view === "writing") &&
                    "gap-[6px] border border-dashed border-edge-strong bg-surface",
                view === "changed" && "border border-accent bg-surface",
                view === "asked" && "border border-warning/45"
            )}
        >
            <div className="flex items-center gap-[8px]">
                <span className={dot} />
                <span className={cn("text-[14px] font-semibold", view === "open" ? "text-ink-mid" : "text-primary")}>
                    {part.title}
                </span>
                {label}
                {view !== "yours" && actions != null ? <div className="flex-1" /> : null}
                {actions}
            </div>
            {editing ? (
                <div className="flex flex-col gap-[6px] pl-[15px]">
                    <textarea
                        data-brainstorm-edit
                        aria-label={`Edit ${part.title}`}
                        autoFocus
                        rows={3}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                e.preventDefault();
                                e.stopPropagation();
                                setEditing(false);
                                return;
                            }
                            onEnter(e, () => {
                                if (draft.trim() === "" || locked) {
                                    return;
                                }
                                void send({ kind: "edit", part: part.id, text: draft }).then((ok) => {
                                    if (ok) {
                                        setEditing(false);
                                    }
                                });
                            });
                        }}
                        className={FIELD}
                    />
                    <span className="text-[11.5px] text-muted">Enter sends · Esc cancels</span>
                </div>
            ) : view === "writing" ? (
                <>
                    <div className="ml-[15px] h-[10px] w-[92%] rounded-[4px] bg-surface-hover" />
                    <div className="ml-[15px] h-[10px] w-[78%] rounded-[4px] bg-surface-hover" />
                    <div className="ml-[15px] h-[10px] w-[54%] rounded-[4px] bg-surface-hover" />
                </>
            ) : view === "asked" ? (
                <div className="pl-[15px] text-[13px] leading-[1.55] text-muted">
                    {part.body || "Waiting on your answer to the question on the left."}
                </div>
            ) : part.body ? (
                <div
                    className={cn(
                        "whitespace-pre-line pl-[15px] leading-[1.55]",
                        view === "open" ? "text-[13px] text-muted" : "text-[13.5px] text-secondary"
                    )}
                >
                    {part.body}
                </div>
            ) : null}
            {view === "changed" ? <ChangeDiff part={part} /> : null}
            {act.error != null ? <span className={cn(ERROR_LINE, "pl-[15px]")}>{act.error}</span> : null}
            {part.boards != null && f.canvas != null && s.base != null && view !== "writing" ? (
                <Thumbnails agentId={agent.id} s={s} canvas={f.canvas} base={s.base} boards={part.boards} />
            ) : null}
        </div>
    );
}

function ChangeDiff({ part }: { part: BrainstormPart }) {
    const diff = sentenceDiff(part.was ?? "", part.body).filter((d) => d.kind !== "same");
    return (
        <>
            {diff.map((d, i) => (
                <div
                    key={i}
                    className={cn(
                        "ml-[15px] rounded-[6px] px-[10px] py-[6px] text-[13px] leading-[1.5] text-secondary",
                        d.kind === "added" ? "bg-success/10" : "bg-error/10"
                    )}
                >
                    <span className={cn("font-mono", d.kind === "added" ? "text-success" : "text-error")}>
                        {d.kind === "added" ? "+ " : "− "}
                    </span>
                    {d.text}
                </div>
            ))}
            {part.why ? <div className="pl-[15px] text-[12px] text-muted">Why: {part.why}</div> : null}
        </>
    );
}

function Thumbnails({
    agentId,
    s,
    canvas,
    base,
    boards,
}: {
    agentId: string;
    s: BrainstormState;
    canvas: string;
    base: string;
    boards: string[];
}) {
    const open = (board: string) => {
        attachCanvas(agentId, { topic: canvas, dir: canvasDir(s.cwd, canvas), projectDir: s.cwd, board }, Date.now());
        openBrainstormBoard(agentId, board);
    };
    return (
        <div className="ml-[15px] mt-[4px] flex flex-col gap-[10px]">
            {boards.map((name, i) => {
                const b: CanvasBoard | undefined = s.boards.find((x) => x.name === name);
                const w = b?.w ?? DEFAULT_BOARD_W;
                const h = b?.h ?? DEFAULT_BOARD_H;
                const scale = THUMB_W / w;
                return (
                    <div key={name} className="flex items-start gap-[12px]">
                        <div
                            data-brainstorm-thumb={name}
                            className="pointer-events-none relative flex-none overflow-hidden rounded-[8px] border border-edge-mid bg-background"
                            style={{ width: THUMB_W, height: Math.min(THUMB_MAX_H, Math.round(h * scale)) }}
                        >
                            <iframe
                                src={boardUrl(base, canvas, name)}
                                title={name}
                                tabIndex={-1}
                                sandbox="allow-scripts allow-same-origin"
                                className="absolute left-0 top-0 border-0"
                                style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "0 0" }}
                            />
                        </div>
                        <div className="flex flex-col gap-[6px] pt-[2px]">
                            <span className="font-mono text-[10.5px] text-muted">
                                {boards.length > 1
                                    ? `${name} · option ${String.fromCharCode(65 + i)} of ${boards.length}`
                                    : name}
                            </span>
                            <button
                                type="button"
                                data-brainstorm-open-board
                                onClick={() => open(name)}
                                className={cn(LINK, "text-left text-[12px] font-semibold")}
                            >
                                Open full size
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function Check({
    model,
    agent,
    s,
    f,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
}) {
    const hv = handoffView(f);
    const working = f.working != null;
    return (
        <>
            <Toolbar topic={s.topic}>
                <span className="flex items-center gap-[5px] font-mono text-[10.5px] text-ink-mid">
                    <span className={DOT_YOURS} />
                    {handoffSummary(f)}
                </span>
            </Toolbar>
            <StaleBanner s={s} />
            <div className="flex min-h-0 flex-1">
                <div className="flex w-[430px] flex-none flex-col gap-[16px] overflow-y-auto border-r border-border bg-surface px-[20px] py-[18px]">
                    <div className="flex flex-col gap-[4px]">
                        <span className="text-[15px] font-semibold text-primary">A builder read the design</span>
                        <span className="text-[13px] leading-[1.5] text-ink-mid">
                            A fresh agent checked whether it could plan from this without coming back to you. It had{" "}
                            {hv.questions} questions; this is where they went.
                        </span>
                    </div>
                    {hv.open != null ? (
                        <BuilderQuestion
                            agent={agent}
                            q={hv.open}
                            unanswered={f.check!.yours.length - hv.answered.length}
                            working={working}
                        />
                    ) : null}
                    {hv.answered.map((y, i) => (
                        <div
                            key={i}
                            className="flex flex-col gap-[6px] rounded-[12px] border border-edge-mid bg-surface-raised px-[16px] py-[12px]"
                        >
                            <div className="flex items-center gap-[8px] text-[12px] font-semibold text-success">
                                <span className={cn(SMALL_DOT, "bg-success")} />
                                You answered
                            </div>
                            <div className="text-[13.5px] leading-[1.5] text-ink-hi">
                                {y.a}
                                {y.into ? ` Added to ${partTitle(f, y.into)}.` : ""}
                            </div>
                        </div>
                    ))}
                    {hv.calls.length > 0 ? (
                        <div className="flex flex-col gap-[8px]">
                            <div className="flex items-baseline gap-[8px]">
                                <span className="text-[13px] font-semibold text-secondary">
                                    The agent’s calls · {hv.calls.length}
                                </span>
                                <span className="text-[12px] text-muted">
                                    marked in the design, check them as you read
                                </span>
                            </div>
                            {hv.calls.map((c, i) => (
                                <div
                                    key={i}
                                    className="border-t border-edge-faint py-[8px] text-[13px] leading-[1.5] text-secondary"
                                >
                                    {c.text}
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {f.check!.answered.length > 0 ? (
                        <div className="flex flex-col gap-[8px]">
                            <div className="flex items-baseline gap-[8px]">
                                <span className="text-[13px] font-semibold text-ink-mid">
                                    Answered already · {f.check!.answered.length}
                                </span>
                                <span className="text-[12px] text-muted">written into the design</span>
                            </div>
                            {f.check!.answered.map((a, i) => (
                                <div
                                    key={i}
                                    className="border-t border-edge-faint py-[8px] text-[12.5px] leading-[1.5] text-ink-mid"
                                >
                                    {a}
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                    <FinishedDesign f={f} hv={hv} />
                    <ApproveBar model={model} agent={agent} s={s} f={f} hv={hv} working={working} />
                </div>
            </div>
        </>
    );
}

function BuilderQuestion({
    agent,
    q,
    unanswered,
    working,
}: {
    agent: AgentVM;
    q: BuilderQuestionT;
    unanswered: number;
    working: boolean;
}) {
    const [draft, setDraft] = useState("");
    const act = useAction();
    return (
        <div data-brainstorm-builder-question className={CARD}>
            <div className={CARD_HEAD}>
                <span className={cn(SMALL_DOT, "bg-warning")} />
                <span className={cn(CARD_LABEL, "text-warning")}>Only you can answer · {unanswered}</span>
            </div>
            <div className="flex flex-col gap-[10px] px-[14px] pb-[12px] pt-[14px]">
                <div className="text-[14.5px] font-semibold leading-[1.5] text-primary">{q.q}</div>
                {q.why ? <div className="text-[12.5px] leading-[1.5] text-ink-mid">{q.why}</div> : null}
                <textarea
                    aria-label="Your answer"
                    rows={2}
                    value={draft}
                    disabled={working}
                    title={working ? WORKING_TITLE : undefined}
                    placeholder="Answer in your own words…"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) =>
                        onEnter(e, () => {
                            if (draft.trim() === "" || act.busy || working) {
                                return;
                            }
                            void act
                                .run(() => sendBrainstorm(agent, { kind: "builder-answer", text: draft }))
                                .then((ok) => ok && setDraft(""));
                        })
                    }
                    className={cn(FIELD, "disabled:opacity-50")}
                />
                <div className="flex justify-end">
                    <EnterSends />
                </div>
                {act.error != null ? <span className={ERROR_LINE}>{act.error}</span> : null}
            </div>
        </div>
    );
}

function FinishedDesign({ f, hv }: { f: BrainstormFile; hv: HandoffView }) {
    const [all, setAll] = useState(false);
    const parts = all ? orderedParts(f) : hv.touched;
    const specName = f.spec.split(/[\\/]/).pop() ?? f.spec;
    return (
        <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-[600px] flex-col gap-[14px] px-[32px] py-[22px]">
                <div className="flex items-baseline justify-between gap-[12px]">
                    <h1 className="m-0 text-[18px] font-bold text-primary">{f.title}</h1>
                    {f.spec ? (
                        <span title={f.spec} className="min-w-0 truncate font-mono text-[10.5px] text-muted">
                            {specName === f.spec ? f.spec : `…/${specName}`}
                        </span>
                    ) : null}
                </div>
                {parts.map((p) => (
                    <div key={p.id} data-brainstorm-part={p.id} className="flex flex-col gap-[4px]">
                        <span className="text-[14px] font-semibold text-primary">{p.title}</span>
                        {p.body ? (
                            <span className="whitespace-pre-line text-[13.5px] leading-[1.55] text-secondary">
                                {p.body}
                            </span>
                        ) : null}
                        {(hv.callsByPart[p.id] ?? []).map((c, i) => (
                            <span
                                key={i}
                                className="flex items-baseline gap-[8px] rounded-[6px] bg-accentbg px-[10px] py-[6px] text-[13px] leading-[1.5] text-secondary"
                            >
                                <span className="flex-none text-[11px] font-semibold text-accent-soft">
                                    Agent’s call
                                </span>
                                {c}
                            </span>
                        ))}
                    </div>
                ))}
                {hv.untouched.length > 0 ? (
                    <button
                        type="button"
                        data-brainstorm-untouched
                        aria-expanded={all}
                        onClick={() => setAll(!all)}
                        className={cn(LINK, "self-start text-[12.5px] font-semibold")}
                    >
                        {all ? "Hide" : "Show"} the {hv.untouched.length} parts the builder did not touch
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function ApproveBar({
    model,
    agent,
    s,
    f,
    hv,
    working,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    hv: HandoffView;
    working: boolean;
}) {
    const act = useAction();
    const bar = "flex flex-none items-center gap-[14px] border-t border-border bg-surface px-[22px] py-[12px]";
    if (f.run != null) {
        const runId = f.run;
        return (
            <div data-brainstorm-approve-bar className={bar}>
                <span className="flex-1 text-[13px] font-semibold text-primary">
                    Run {runId.slice(0, RUN_ID_CHARS)} started
                </span>
                <button
                    type="button"
                    onClick={() => void openTarget(model, { kind: "run", runId })}
                    className={CANVAS_BTN}
                >
                    Open run
                </button>
            </div>
        );
    }
    const approveTitle = working ? WORKING_TITLE : hv.canApprove ? undefined : APPROVE_TITLE;
    return (
        <div data-brainstorm-approve-bar className={bar}>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="text-[13px] font-semibold text-primary">Approve and start an orchestrator run</span>
                <span className="truncate font-mono text-[11px] text-muted">
                    {runLine(projectOf(agent))} ·{" "}
                    <button type="button" onClick={() => openRunLauncher(model, agent, s)} className={LINK}>
                        Change
                    </button>
                </span>
                {act.error != null ? <span className={ERROR_LINE}>{act.error}</span> : null}
            </div>
            <button
                type="button"
                disabled={working || act.busy}
                title={working ? WORKING_TITLE : undefined}
                onClick={() => void act.run(() => sendBrainstorm(agent, { kind: "keep-talking" }))}
                className={cn(CANVAS_BTN, "disabled:cursor-default disabled:opacity-50")}
            >
                Keep talking
            </button>
            <button
                type="button"
                data-brainstorm-approve
                disabled={!hv.canApprove || working || act.busy}
                title={approveTitle}
                onClick={() => void act.run(() => approveAndOpenRun(model, agent, s))}
                className={CANVAS_PRIMARY_BTN}
            >
                Approve and start run
            </button>
        </div>
    );
}

function Exited({
    model,
    agent,
    s,
    exit,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    exit: { code: number; at: number };
}) {
    const [lastLine, setLastLine] = useState<string | null>(null);
    const act = useAction();
    const blockId = agent.blockId;
    useEffect(() => {
        if (blockId == null) {
            return;
        }
        let live = true;
        RpcApi.TermGetScrollbackLinesCommand(
            TabRpcClient,
            { linestart: 0, lineend: LAST_OUTPUT_LINES, lastcommand: false },
            { route: makeFeBlockRouteId(blockId) }
        )
            .then((r) => {
                const line = [...(r?.lines ?? [])].reverse().find((l) => l.trim() !== "");
                if (live && line != null) {
                    setLastLine(line.trim());
                }
            })
            .catch((e) => console.warn("brainstorm exited: reading the last output failed", blockId, e));
        return () => {
            live = false;
        };
    }, [blockId, exit.at]);
    const resume = () => {
        const runtime = (agent.agent ?? "claude") as Runtime;
        return launchAgent(model, {
            runtime,
            startupCommand: runtimeStartupCommand(runtime),
            task: resumePrompt(s.path),
            projectPath: s.cwd,
            projectName: projectOf(agent),
        }).then(() => undefined);
    };
    return (
        <div className="flex flex-1 items-center justify-center bg-surface p-[24px]">
            <div data-brainstorm-exited className="flex w-[420px] flex-col gap-[12px]">
                <span className="flex items-center gap-[8px] text-[14px] font-semibold text-primary">
                    <span className={cn(DOT, "bg-error")} />
                    {agent.name} exited with code {exit.code} at {hhmm(exit.at)}
                </span>
                {s.file != null ? (
                    <span className="text-[13px] leading-[1.5] text-secondary">{exitedSummary(s.file)}</span>
                ) : null}
                <div className="flex gap-[8px]">
                    <button
                        type="button"
                        data-brainstorm-resume
                        disabled={act.busy}
                        onClick={() => void act.run(resume)}
                        className={CANVAS_PRIMARY_BTN}
                    >
                        Resume in a new agent
                    </button>
                    <button
                        type="button"
                        onClick={() => updateBrainstorm(agent.id, (x) => ({ ...x, showDesign: true }))}
                        className={CANVAS_BTN}
                    >
                        Open the design
                    </button>
                </div>
                {act.error != null ? <span className={ERROR_LINE}>{act.error}</span> : null}
                {lastLine != null ? (
                    <span className="font-mono text-[11px] text-muted">Last output: {lastLine}</span>
                ) : null}
            </div>
        </div>
    );
}

function Unreadable({ s }: { s: BrainstormState }) {
    return (
        <EdgeState>
            <span className="flex items-center gap-[8px] text-[14px] font-semibold text-primary">
                <span className={cn(DOT, "bg-error")} />
                Arc could not read this brainstorm
            </span>
            <span className={EXPLAINER}>{s.error}</span>
            <span className="max-w-full break-all font-mono text-[11px] text-muted">{s.path}</span>
        </EdgeState>
    );
}

function Removed({ agent, topic }: { agent: AgentVM; topic: string }) {
    return (
        <EdgeState>
            <span className="text-[14px] font-semibold text-primary">{topic}'s brainstorm file is gone</span>
            <span className={EXPLAINER}>
                Its brainstorm.json under .superpowers/brainstorm was deleted, usually because the feature shipped. The
                switch disappears once you go back to the terminal.
            </span>
            <button
                type="button"
                onClick={() => void dismissBrainstorm(agent.id)}
                className={cn("mt-[4px]", CANVAS_BTN)}
            >
                Back to terminal
            </button>
        </EdgeState>
    );
}
