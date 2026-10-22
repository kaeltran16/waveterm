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
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { getProcExitAtom } from "./agentcontrollerstore";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import { Check } from "./brainstormcheck";
import {
    boardBackLabel,
    decisionParts,
    droppedQuestion,
    exitedSummary,
    historyRows,
    isNote,
    leftPanel,
    mainView,
    noteParts,
    paneView,
    partAnswer,
    partGist,
    partView,
    resumePrompt,
    reviewHead,
    unseenSince,
    type BrainstormAction,
    type BrainstormFile,
    type BrainstormPart,
    type HistoryRow,
    type PartView,
    type Unseen,
} from "./brainstormmodel";
import { RunStep } from "./brainstormrun";
import { sendBrainstorm } from "./brainstormsend";
import {
    brainstormAtom,
    brainstormSeenAtom,
    dismissBrainstorm,
    markBrainstormSeen,
    openBrainstormBoard,
    openBrainstormDesign,
    shownBrainstormFile,
    updateBrainstorm,
    type BrainstormState,
} from "./brainstormstore";
import {
    ChangeDiff,
    CheckMark,
    CHIP,
    DesignHead,
    DOT,
    DOT_ASKED,
    DOT_GUESS,
    DOT_OPEN,
    DOT_YOURS,
    ERROR_LINE,
    FIELD,
    LINK,
    onEnter,
    PART_BTN,
    PartMockups,
    QuestionMain,
    SaidLine,
    SECTION_HEAD,
    SMALL_DOT,
    StaleBanner,
    Toolbar,
    useAction,
    WORKING_TITLE,
    WorkingMain,
} from "./brainstormui";
import { CANVAS_BTN, CANVAS_PRIMARY_BTN, CanvasPane, EdgeState, EXPLAINER } from "./canvaspane";
import { runtimeStartupCommand, type Runtime } from "./launch";

// how far back the exited card looks for the agent's last words
const LAST_OUTPUT_LINES = 200;

const PART_DOT: Record<PartView, string> = {
    yours: DOT_YOURS,
    guess: DOT_GUESS,
    changed: DOT_GUESS,
    asked: DOT_ASKED,
    writing: DOT_YOURS,
    open: DOT_OPEN,
};
const NOTE_DOT = "box-border h-[7px] w-[7px] flex-none rounded-[2px] border-[1.5px] border-ink-faint";

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
    const f = shownBrainstormFile(s);
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
                <CanvasPane
                    model={model}
                    agent={agent}
                    onBack={() => openBrainstormBoard(agent.id, null)}
                    backLabel={boardBackLabel(f, s.designOpen)}
                />
            ) : view === "run" ? (
                <RunStep model={model} agent={agent} s={s} f={f!} />
            ) : view === "check" ? (
                <Check model={model} agent={agent} s={s} f={f!} />
            ) : f == null ? (
                <>
                    <Toolbar topic={s.topic} />
                    <EdgeState>
                        <span className={EXPLAINER}>Reading {s.path}…</span>
                    </EdgeState>
                </>
            ) : (
                <Design agent={agent} s={s} f={f} />
            )}
        </div>
    );
}

function Design({ agent, s, f }: { agent: AgentVM; s: BrainstormState; f: BrainstormFile }) {
    const partsRef = useRef<HTMLDivElement>(null);
    // a part to scroll to once the design is drawn: a link in the rail or over the question opens it first
    const [target, setTarget] = useState<string | null>(null);
    // the design's rows the user opened or closed; kept here so they survive the question taking the main area
    const [opened, setOpened] = useState<Record<string, boolean>>({});
    const view = mainView(f, s.designOpen);
    const seen = useAtomValue(brainstormSeenAtom)[s.path] ?? null;
    const unseen = unseenSince(f, seen);
    // opens the parts' rows in the design and scrolls to the first
    const openParts = (ids: string[]) => {
        setOpened((o) => ({ ...o, ...Object.fromEntries(ids.map((id) => [id, true])) }));
        setTarget(ids[0]);
        openBrainstormDesign(agent.id, true);
    };
    const goTo = (id: string) => openParts([id]);
    const openDesign = () => openBrainstormDesign(agent.id, true);
    useEffect(() => {
        if (view === "design" && target != null) {
            scrollToPart(partsRef, target);
            setTarget(null);
        }
    }, [view, target]);

    return (
        <>
            <Toolbar topic={s.topic} f={f} />
            <StaleBanner s={s} />
            <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col bg-background">
                    {view === "question" ? (
                        <QuestionMain
                            agent={agent}
                            s={s}
                            f={f}
                            goTo={goTo}
                            openDesign={openDesign}
                            findings={
                                unseen.notes.length > 0
                                    ? { count: unseen.notes.length, open: () => openParts(unseen.notes) }
                                    : undefined
                            }
                        />
                    ) : view === "working" ? (
                        <WorkingMain f={f} openDesign={openDesign} />
                    ) : (
                        <DesignMain
                            agent={agent}
                            s={s}
                            f={f}
                            partsRef={partsRef}
                            unseen={unseen}
                            opened={opened}
                            setOpen={(id, open) => setOpened((o) => ({ ...o, [id]: open }))}
                        />
                    )}
                </div>
                <DecidedRail f={f} unseen={unseen} goTo={goTo} />
            </div>
        </>
    );
}

function DesignMain({
    agent,
    s,
    f,
    partsRef,
    unseen,
    opened,
    setOpen,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    partsRef: RefObject<HTMLDivElement>;
    unseen: Unseen;
    opened: Record<string, boolean>;
    setOpen: (id: string, open: boolean) => void;
}) {
    // what the design drew last is what the user has seen once they leave it (the question back in the main area, a
    // board, another agent): what came while it was open showed marked new
    const drawn = useRef(f);
    useEffect(() => {
        drawn.current = f;
    });
    useEffect(() => () => markBrainstormSeen(s.path, drawn.current), [s.path]);
    const working = f.working != null;
    const fresh = f.history.length === 0;
    const decisions = decisionParts(f);
    const notes = noteParts(f);
    // a changed part opens on its own: what changed is what it asks you to read
    const isOpen = (p: BrainstormPart) => opened[p.id] ?? partView(f, p) === "changed";
    const row = (p: BrainstormPart) => (
        <PartRow
            key={p.id}
            agent={agent}
            s={s}
            f={f}
            part={p}
            unseen={unseen.parts.includes(p.id)}
            open={isOpen(p)}
            setOpen={(open) => setOpen(p.id, open)}
        />
    );
    // the design opened over the question or the working note: the way back to it
    const back = s.designOpen ? mainView(f, false) : "design";
    return (
        <>
            {back !== "design" ? (
                <div className="flex flex-none items-center border-b border-border px-[22px] py-[8px]">
                    <button
                        type="button"
                        data-brainstorm-back
                        onClick={() => openBrainstormDesign(agent.id, false)}
                        className={cn(
                            CHIP,
                            "flex items-center gap-[8px]",
                            back === "question" && "border-warning/45 bg-warning/12"
                        )}
                    >
                        <span className={cn(SMALL_DOT, back === "question" ? "bg-warning" : "bg-success")} />
                        {back === "question"
                            ? `Back to question ${f.question!.n}`
                            : "Back to what the agent is writing"}
                    </button>
                </div>
            ) : null}
            <div ref={partsRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-[14px] px-[22px] pb-[40px] pt-[20px]">
                    <DesignHead f={f} />
                    {working ? (
                        <div
                            data-brainstorm-working-note
                            className="flex items-center gap-[8px] rounded-[8px] bg-surface px-[14px] py-[8px] text-[12.5px] text-ink-mid"
                        >
                            <span className={cn(SMALL_DOT, "bg-success")} />
                            The agent is writing. Confirm, edit and keep open again when it asks its next question.
                        </div>
                    ) : null}
                    {leftPanel(f) !== "none" ? <ReviewHead agent={agent} f={f} /> : null}
                    <section data-brainstorm-decisions aria-label="Decisions" className="flex flex-col">
                        <div className="flex items-baseline gap-[8px] px-[14px] pb-[6px]">
                            <h2 className={SECTION_HEAD}>Decisions · {decisions.length}</h2>
                            <span className="text-[12px] text-muted">
                                what the run builds; each one has to be yours
                            </span>
                        </div>
                        {decisions.map(row)}
                    </section>
                    {notes.length > 0 ? (
                        <section data-brainstorm-notes aria-label="What the agent found" className="flex flex-col">
                            <div className="flex items-baseline gap-[8px] px-[14px] py-[6px]">
                                <h2 className={SECTION_HEAD}>What the agent found · {notes.length}</h2>
                                <span className="text-[12px] text-muted">
                                    background the decisions stand on; it goes into the spec as context, nothing to
                                    confirm
                                </span>
                            </div>
                            {notes.map(row)}
                        </section>
                    ) : null}
                    {fresh ? (
                        <p className="m-0 px-[14px] text-[12.5px] leading-[1.5] text-muted">
                            More parts appear as the conversation finds them.
                        </p>
                    ) : null}
                </div>
            </div>
        </>
    );
}

// what stands before the builder check, in one line, and the one press that moves it on
function ReviewHead({ agent, f }: { agent: AgentVM; f: BrainstormFile }) {
    const head = reviewHead(f);
    const act = useAction();
    const send = (action: BrainstormAction) => void act.run(() => sendBrainstorm(agent, action));
    return (
        <section data-brainstorm-review className="flex flex-col gap-[6px] px-[14px] py-[4px]">
            <div className="flex items-center gap-[14px]">
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <h2 className="m-0 text-[15px] font-semibold text-primary">Confirm the design</h2>
                    <span data-brainstorm-review-line className="text-[13px] leading-[1.5] text-ink-mid">
                        {head.line}
                    </span>
                </div>
                {head.action === "confirm-all" ? (
                    <button
                        type="button"
                        data-brainstorm-confirm-all
                        disabled={act.busy}
                        onClick={() => send({ kind: "confirm-all" })}
                        className={cn(CANVAS_PRIMARY_BTN, "flex-none")}
                    >
                        Confirm all {head.guesses} guesses
                    </button>
                ) : null}
                {head.action === "check" ? (
                    <button
                        type="button"
                        data-brainstorm-check-btn
                        disabled={act.busy}
                        onClick={() => send({ kind: "check" })}
                        className={cn(CANVAS_PRIMARY_BTN, "flex-none")}
                    >
                        Check with a builder
                    </button>
                ) : null}
            </div>
            {act.error != null ? <span className={ERROR_LINE}>{act.error}</span> : null}
        </section>
    );
}

function Chevron({ open, onClick }: { open: boolean; onClick: () => void }) {
    return (
        <span
            aria-hidden="true"
            onClick={onClick}
            className={cn(
                "flex h-[20px] w-[12px] flex-none cursor-pointer items-center text-muted",
                open && "rotate-180"
            )}
        >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 4.5l3 3 3-3" />
            </svg>
        </span>
    );
}

// a decision or a note in one line: dot, title, gist, where it came from, what to do; opened, the whole of it
function PartRow({
    agent,
    s,
    f,
    part,
    unseen,
    open,
    setOpen,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    part: BrainstormPart;
    unseen: boolean;
    open: boolean;
    setOpen: (open: boolean) => void;
}) {
    const note = isNote(part);
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
        setOpen(true);
    };
    const btn = (label: string, onClick: () => void, quiet = false) => (
        <button
            type="button"
            disabled={locked}
            title={lockTitle}
            onClick={onClick}
            className={cn(PART_BTN, quiet && "text-secondary")}
        >
            {label}
        </button>
    );
    const quietEdit = editing ? null : (
        <button
            type="button"
            disabled={locked}
            title={lockTitle}
            onClick={startEdit}
            className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted hover:text-secondary disabled:cursor-default disabled:opacity-50"
        >
            Edit
        </button>
    );
    const askedHere = f.question?.part === part.id;
    let right: ReactNode = null;
    if (note) {
        right = quietEdit;
    } else if (view === "guess") {
        right = editing ? null : (
            <>
                {btn("That’s right", () => void send({ kind: "confirm", part: part.id }))}
                {btn("Edit", startEdit, true)}
            </>
        );
    } else if (view === "changed") {
        right = (
            <>
                {btn("Keep the change", () => void send({ kind: "keep", part: part.id }))}
                {btn("Put mine back", () => void send({ kind: "restore", part: part.id }), true)}
            </>
        );
    } else if (view === "yours") {
        right = (
            <>
                <span className="text-[11.5px] text-success">Yours</span>
                {quietEdit}
            </>
        );
    } else if (view === "asked") {
        right = (
            <span className="text-[11.5px] text-warning">
                Asked now{askedHere ? ` · question ${f.question!.n}` : ""}
            </span>
        );
    } else if (view === "writing") {
        right = <span className="text-[11.5px] text-success">Being written</span>;
    } else {
        const dropped = droppedQuestion(f, part);
        right = (
            <span className="text-[11.5px] text-muted">
                Open{dropped != null ? ` · question ${dropped} dropped` : ""}
            </span>
        );
    }
    const dim = view === "open" && !note;
    const said = partAnswer(f, part);

    return (
        <div
            data-brainstorm-part={part.id}
            data-state={note ? "note" : view}
            data-unseen={unseen ? "" : undefined}
            className="flex scroll-mt-[20px] flex-col border-t border-edge-faint"
        >
            <div className={cn("flex items-start gap-[12px] px-[14px]", note ? "py-[8px]" : "py-[9px]")}>
                <span className={cn(note ? NOTE_DOT : PART_DOT[view], "mt-[6px]")} />
                <button
                    type="button"
                    data-brainstorm-row-toggle
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                    className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-[14px] border-0 bg-transparent p-0 text-left"
                >
                    <span
                        className={cn(
                            "w-[200px] flex-none font-semibold",
                            note ? "text-[13px] text-secondary" : "text-[13.5px]",
                            !note && (dim ? "text-ink-mid" : "text-primary")
                        )}
                    >
                        {part.title}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                        <span
                            data-brainstorm-gist
                            className={cn(
                                "leading-[1.45]",
                                note ? "text-[13px] text-ink-mid" : "text-[13.5px]",
                                !note && (dim ? "text-muted" : "text-secondary")
                            )}
                        >
                            {partGist(f, part)}
                        </span>
                        {said != null ? <SaidLine said={said} open={open} /> : null}
                    </span>
                    {/* the answer line under the gist names the answer, so the column would only repeat it */}
                    <span title={part.from} className="w-[120px] flex-none truncate font-mono text-[10.5px] text-muted">
                        {said != null ? null : part.from}
                    </span>
                </button>
                <span className="flex h-[20px] min-w-[150px] flex-none items-center justify-end gap-[8px]">
                    {unseen ? <span className="text-[11px] font-semibold text-accent-soft">New</span> : null}
                    {right}
                </span>
                <Chevron open={open} onClick={() => setOpen(!open)} />
            </div>
            {open ? (
                <div data-brainstorm-row-body className="mb-[12px] ml-[233px] mr-[14px] flex flex-col gap-[8px]">
                    {editing ? (
                        <>
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
                        </>
                    ) : view === "writing" ? (
                        <>
                            <div aria-hidden="true" className="h-[10px] w-[92%] rounded-[4px] bg-surface-hover" />
                            <div aria-hidden="true" className="h-[10px] w-[78%] rounded-[4px] bg-surface-hover" />
                            <div aria-hidden="true" className="h-[10px] w-[54%] rounded-[4px] bg-surface-hover" />
                        </>
                    ) : (
                        <>
                            {view === "changed" && !note ? (
                                <span className="text-[11.5px] text-accent-soft">Changed since you confirmed it</span>
                            ) : null}
                            {part.body ? (
                                <div
                                    className={cn(
                                        "whitespace-pre-line rounded-[8px] bg-surface px-[14px] py-[10px] leading-[1.6]",
                                        note ? "text-[13px] text-ink-mid" : "text-[13.5px] text-secondary"
                                    )}
                                >
                                    {part.body}
                                </div>
                            ) : null}
                            {view === "changed" && !note ? <ChangeDiff part={part} /> : null}
                        </>
                    )}
                    {view === "writing" ? null : <PartMockups agentId={agent.id} s={s} f={f} part={part} />}
                </div>
            ) : null}
            {act.error != null ? <span className={cn(ERROR_LINE, "px-[14px] pb-[8px]")}>{act.error}</span> : null}
        </div>
    );
}

function EmptyMark() {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="mt-[3px] flex-none text-ink-faint"
        >
            <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
    );
}

function IntoLinks({
    into,
    goTo,
    className,
}: {
    into: HistoryRow["into"];
    goTo: (id: string) => void;
    className?: string;
}) {
    if (into.length === 0) {
        return null;
    }
    return (
        <div className={cn("text-[11.5px] text-muted", className)}>
            Went into{" "}
            {into.map((p, j) => (
                <span key={p.id}>
                    {j > 0 ? ", " : ""}
                    <button type="button" onClick={() => goTo(p.id)} className={LINK}>
                        {p.title}
                    </button>
                </span>
            ))}
        </div>
    );
}

// the recon it all stood on at the top, then every question answered with all it offered, newest at the bottom
function DecidedRail({ f, unseen, goTo }: { f: BrainstormFile; unseen: Unseen; goTo: (id: string) => void }) {
    const rows = historyRows(f, unseen);
    const decided = rows.filter((r) => r.kind === "question" && !r.dropped).length;
    const working = f.working != null;
    const railRef = useRef<HTMLElement>(null);
    const shown = useRef(0);
    // a new entry lands at the bottom, so follow it; the first draw jumps there without animating
    useEffect(() => {
        const el = railRef.current;
        if (el != null && rows.length > shown.current) {
            el.scrollTo({ top: el.scrollHeight, behavior: shown.current === 0 ? "auto" : "smooth" });
        }
        shown.current = rows.length;
    }, [rows.length]);
    return (
        <aside
            ref={railRef}
            data-brainstorm-rail
            aria-label="Decided so far"
            className="flex w-[32%] min-w-[280px] max-w-[500px] flex-none flex-col overflow-y-auto border-l border-border bg-surface px-[24px] py-[22px]"
        >
            <div className="flex items-baseline gap-[8px] pb-[8px]">
                <h2 className="m-0 text-[13px] font-semibold text-secondary">Decided so far · {decided}</h2>
                <span className="text-[12px] text-muted">newest last</span>
            </div>
            {rows.length === 0 ? (
                <p className="m-0 border-t border-border pt-[12px] text-[12.5px] leading-[1.5] text-muted">
                    Each answer lands here, with the options it was picked from.
                </p>
            ) : null}
            <div data-brainstorm-history className="flex flex-col">
                {rows.map((h, i) =>
                    h.kind === "recon" ? (
                        <div
                            key={`recon:${i}`}
                            data-unseen={h.unseen ? "" : undefined}
                            className="flex flex-col gap-[5px] border-t border-border py-[12px]"
                        >
                            <span className="font-mono text-[10.5px] text-muted">
                                {h.label}
                                {h.unseen ? <span className="text-accent-soft"> · new</span> : null}
                            </span>
                            <span className="text-[12.5px] leading-[1.5] text-ink-mid">{h.answer}</span>
                            <IntoLinks into={h.into} goTo={goTo} />
                        </div>
                    ) : (
                        <RailQuestion key={`${h.label}:${i}`} h={h} justNow={i === rows.length - 1 && working} goTo={goTo} />
                    )
                )}
            </div>
        </aside>
    );
}

// the picked answer keeps what it is; the toggle opens why it was asked and what the others were, when there is any
function RailQuestion({ h, justNow, goTo }: { h: HistoryRow; justNow: boolean; goTo: (id: string) => void }) {
    const [open, setOpen] = useState(false);
    return (
        <div
            data-brainstorm-rail-entry
            data-dropped={h.dropped ? "" : undefined}
            className="flex flex-col gap-[8px] border-t border-border py-[12px]"
        >
            <div className="flex items-baseline gap-[8px]">
                <span className="flex-none font-mono text-[10.5px] text-muted">
                    {h.label}
                    {h.dropped ? " · dropped" : justNow ? " · just now" : ""}
                </span>
                <span className={cn("text-[12.5px] leading-[1.45]", h.dropped ? "text-muted" : "text-ink-mid")}>
                    {h.q}
                </span>
            </div>
            {h.dropped ? (
                <div className="pl-[23px] text-[12px] leading-[1.5] text-muted">
                    Dropped after your pushback, unanswered: nothing was decided from it.
                </div>
            ) : null}
            {open && h.why != null ? (
                <div data-brainstorm-rail-why className="pl-[23px] text-[12px] leading-[1.5] text-muted">
                    Why: {h.why}
                </div>
            ) : null}
            <ul aria-label={`${h.label} answers`} className="m-0 flex list-none flex-col gap-[6px] p-0 pl-[2px]">
                {h.options.map((o, j) => (
                    <li key={j} data-picked={o.picked ? "" : undefined} className="flex items-start gap-[8px]">
                        {o.picked ? <CheckMark /> : <EmptyMark />}
                        <span className="flex min-w-0 flex-col gap-[2px]">
                            <span className="flex flex-wrap items-baseline gap-x-[8px]">
                                <span
                                    className={
                                        o.picked
                                            ? "text-[14px] font-semibold leading-[1.45] text-primary"
                                            : "text-[13px] leading-[1.45] text-muted"
                                    }
                                >
                                    {o.label}
                                </span>
                                {o.agentPick ? (
                                    <span className="text-[11px] font-semibold text-accent-soft">Agent’s pick</span>
                                ) : null}
                            </span>
                            {o.detail && (o.picked || open) ? (
                                <span
                                    className={
                                        o.picked
                                            ? "text-[12.5px] leading-[1.5] text-ink-mid"
                                            : "text-[12px] leading-[1.5] text-muted"
                                    }
                                >
                                    {o.detail}
                                </span>
                            ) : null}
                        </span>
                    </li>
                ))}
                {h.answer != null ? (
                    <li data-picked="" className="flex items-start gap-[8px]">
                        <CheckMark />
                        <span className="flex flex-col gap-[1px]">
                            {h.ownWords ? <span className="text-[11px] text-success">In your words</span> : null}
                            <span className="text-[14px] font-semibold leading-[1.45] text-primary">{h.answer}</span>
                        </span>
                    </li>
                ) : null}
            </ul>
            {h.reasons || h.into.length > 0 ? (
                <div className="flex items-baseline gap-[14px] pl-[23px]">
                    {h.reasons ? (
                        <button
                            type="button"
                            data-brainstorm-reasoning
                            aria-expanded={open}
                            onClick={() => setOpen(!open)}
                            className="flex-none cursor-pointer border-0 bg-transparent p-0 text-[11.5px] font-semibold text-accent-soft hover:underline"
                        >
                            {open ? "Hide the reasoning" : "Show the reasoning"}
                        </button>
                    ) : null}
                    <IntoLinks into={h.into} goTo={goTo} />
                </div>
            ) : null}
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
                        onClick={() =>
                            updateBrainstorm(agent.id, (x) => ({ ...x, showDesign: true, designOpen: true }))
                        }
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
