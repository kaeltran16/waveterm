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
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { getProcExitAtom } from "./agentcontrollerstore";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import {
    approveBlocker,
    decisionParts,
    designLabel,
    exitedSummary,
    handoffView,
    hasProsCons,
    historyRows,
    isNote,
    leftPanel,
    mainView,
    noteParts,
    optionLetter,
    orderedParts,
    paneView,
    partGist,
    partTitle,
    partView,
    phaseSteps,
    progressView,
    questionTrack,
    resumePrompt,
    reviewHead,
    runLine,
    sentenceDiff,
    type AnswerOption,
    type BrainstormAction,
    type BrainstormFile,
    type BrainstormPart,
    type BrainstormQuestion,
    type BuilderQuestion as BuilderQuestionT,
    type HandoffView,
    type HistoryRow,
    type PartState,
    type PartView,
    type TrackSegment,
} from "./brainstormmodel";
import { approveAndOpenRun, openRunLauncher, sendBrainstorm } from "./brainstormsend";
import {
    brainstormAtom,
    dismissBrainstorm,
    openBrainstormBoard,
    openBrainstormDesign,
    shownBrainstormFile,
    updateBrainstorm,
    type BrainstormState,
} from "./brainstormstore";
import { boardUrl, canvasDir, DEFAULT_BOARD_H, DEFAULT_BOARD_W, type CanvasBoard } from "./canvasmodel";
import { CANVAS_BTN, CANVAS_PRIMARY_BTN, CanvasPane, EdgeState, EXPLAINER } from "./canvaspane";
import { attachCanvas } from "./canvasstore";
import { runtimeStartupCommand, type Runtime } from "./launch";

const WORKING_TITLE = "The agent is writing; this opens when it asks again";
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
    "cursor-pointer rounded-[6px] border border-edge-mid bg-transparent px-[12px] py-[5px] text-[12px] text-primary hover:bg-surface-hover disabled:cursor-default disabled:opacity-50";
const FIELD =
    "resize-none rounded-[8px] border border-border bg-background px-[12px] py-[9px] text-[13px] leading-[1.5] text-primary outline-none placeholder:text-muted focus:border-warning/60";
const LINK = "cursor-pointer text-accent-soft hover:underline";
// a card that waits on your answer: the question, the builder's question
const ASK_CARD = "overflow-hidden rounded-[8px] border border-warning/45 bg-surface-raised";
const CARD_HEAD = "flex items-center gap-[8px] border-b border-border px-[14px] py-[9px]";
const ASK_HEAD = cn(CARD_HEAD, "bg-warning/12");
const CARD_LABEL = "font-mono text-[11px] font-semibold";
const ERROR_LINE = "text-[12px] text-error";
const SECTION_HEAD = "m-0 text-[13px] font-semibold text-secondary";
const SEGMENT = "box-border h-[6px] w-[22px] flex-none rounded-[3px]";
const SEGMENT_STATE: Record<PartState, string> = {
    yours: "bg-success",
    guess: "border-[1.5px] border-dashed border-ink-mid",
    asked: "bg-warning",
    open: "border-[1.5px] border-edge-strong",
};
const TRACK_STATE: Record<TrackSegment, string> = {
    done: "bg-success",
    now: "bg-warning",
    ahead: "bg-edge-mid",
};
const STATE_NAME: Record<PartState, string> = {
    yours: "yours",
    guess: "the agent’s guess",
    asked: "asked now",
    open: "open",
};
const PART_DOT: Record<PartView, string> = {
    yours: DOT_YOURS,
    guess: DOT_GUESS,
    changed: DOT_GUESS,
    asked: DOT_ASKED,
    writing: DOT_YOURS,
    open: DOT_OPEN,
};
const NOTE_DOT = "box-border h-[7px] w-[7px] flex-none rounded-[2px] border-[1.5px] border-ink-faint";

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
                <CanvasPane model={model} agent={agent} onBack={() => openBrainstormBoard(agent.id, null)} />
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

function Toolbar({ topic, f }: { topic: string; f?: BrainstormFile }) {
    return (
        <div className="flex flex-none items-center gap-[14px] border-b border-edge-faint bg-surface px-[22px] py-[8px]">
            <span className="min-w-0 truncate font-mono text-[12px] font-semibold text-secondary">{topic}</span>
            <div className="flex-1" />
            {f != null ? (
                <>
                    <Phases f={f} />
                    <div className="h-[16px] w-px flex-none bg-border" />
                    <Progress f={f} />
                </>
            ) : null}
        </div>
    );
}

function Phases({ f }: { f: BrainstormFile }) {
    return (
        <ol
            data-brainstorm-phase
            aria-label="Where the brainstorm is"
            className="m-0 flex flex-none list-none items-center gap-[8px] p-0 text-[12px]"
        >
            {phaseSteps(f).map((s, i) => (
                <Fragment key={s.phase}>
                    {i > 0 ? (
                        <li aria-hidden="true" className="flex text-ink-faint">
                            <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            >
                                <path d="M3.5 2l3 3-3 3" />
                            </svg>
                        </li>
                    ) : null}
                    <li
                        aria-current={s.status === "current" ? "step" : undefined}
                        className={cn(
                            "flex items-center gap-[6px]",
                            s.status === "current" && "font-semibold text-primary",
                            s.status === "done" && "text-ink-mid",
                            s.status === "todo" && "text-muted"
                        )}
                    >
                        {s.status === "current" ? <span className={cn(SMALL_DOT, "bg-accent")} /> : null}
                        {s.status === "done" ? (
                            <svg
                                width="11"
                                height="11"
                                viewBox="0 0 12 12"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                className="text-success"
                            >
                                <path d="M2.5 6.5l2.5 2.5 4.5-6" />
                            </svg>
                        ) : null}
                        {s.label}
                    </li>
                </Fragment>
            ))}
        </ol>
    );
}

function Progress({ f }: { f: BrainstormFile }) {
    const p = progressView(f);
    return (
        <div data-brainstorm-progress className="flex flex-none items-center gap-[8px]">
            <div className="flex gap-[3px]">
                {p.segments.map((s) => (
                    <span
                        key={s.id}
                        aria-hidden="true"
                        data-state={s.state}
                        title={`${s.title}: ${STATE_NAME[s.state]}`}
                        className={cn(SEGMENT, SEGMENT_STATE[s.state])}
                    />
                ))}
            </div>
            <span className="text-[11.5px] text-ink-mid">
                <span className="font-semibold text-primary">{p.lead}</span> {p.rest}
            </span>
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
    // a part to scroll to once the design is drawn: a link in the rail or over the question opens it first
    const [target, setTarget] = useState<string | null>(null);
    // the design's rows the user opened or closed; kept here so they survive the question taking the main area
    const [opened, setOpened] = useState<Record<string, boolean>>({});
    const view = mainView(f, s.designOpen);
    const goTo = (id: string) => {
        setOpened((o) => ({ ...o, [id]: true }));
        setTarget(id);
        openBrainstormDesign(agent.id, true);
    };
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
                        <QuestionMain agent={agent} f={f} goTo={goTo} openDesign={openDesign} />
                    ) : view === "working" ? (
                        <WorkingMain f={f} openDesign={openDesign} />
                    ) : (
                        <DesignMain
                            agent={agent}
                            s={s}
                            f={f}
                            partsRef={partsRef}
                            opened={opened}
                            setOpen={(id, open) => setOpened((o) => ({ ...o, [id]: open }))}
                        />
                    )}
                </div>
                <DecidedRail f={f} goTo={goTo} />
            </div>
        </>
    );
}

// one segment per question answered, the one asked now, and one per part a question is still to fill
function Track({ f }: { f: BrainstormFile }) {
    return (
        <div data-brainstorm-track aria-hidden="true" className="flex flex-none gap-[4px] px-[36px] pt-[14px]">
            {questionTrack(f).map((t, i) => (
                <span key={i} data-state={t} className={cn("h-[4px] flex-1 rounded-[2px]", TRACK_STATE[t])} />
            ))}
        </div>
    );
}

// centred while it fits, scrolled from its top once it does not
function MainBody({ children }: { children: ReactNode }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[7%] py-[24px]">
            <div className="my-auto flex flex-col gap-[26px]">{children}</div>
        </div>
    );
}

function DesignButton({ f, onClick }: { f: BrainstormFile; onClick: () => void }) {
    return (
        <button type="button" data-brainstorm-design-btn onClick={onClick} className={CHIP}>
            {designLabel(f)}
        </button>
    );
}

// the answer controls the question and the check's question share: what is typed, and the one send for both
function useAnswer(agent: AgentVM) {
    const [draft, setDraft] = useState("");
    const act = useAction();
    const send = async (action: BrainstormAction) => {
        if ((await act.run(() => sendBrainstorm(agent, action))) && action.kind === "answer") {
            setDraft("");
        }
    };
    const sendDraft = () => {
        if (draft.trim() !== "" && !act.busy) {
            void send({ kind: "answer", text: draft });
        }
    };
    return { draft, setDraft, act, send, sendDraft };
}

type Answer = ReturnType<typeof useAnswer>;

// the agent's read over the answers, with the one toggle for every answer's pros and cons, shown until hidden
function QuestionAnswers({ q, ans, compact }: { q: BrainstormQuestion; ans: Answer; compact: boolean }) {
    const [shown, setShown] = useState(true);
    if (q.options == null) {
        return null;
    }
    const reasons = hasProsCons(q);
    const options = <Options options={q.options} ans={ans} compact={compact} reasons={reasons && shown} />;
    if (!q.read && !reasons) {
        return options;
    }
    return (
        <div className={cn("flex flex-col", compact ? "gap-[8px]" : "gap-[12px]")}>
            <div className="flex items-baseline gap-[12px]">
                <span
                    data-brainstorm-read
                    className={cn(
                        "min-w-0 flex-1 text-secondary",
                        compact ? "text-[12.5px] leading-[1.5]" : "text-[15px] leading-[1.55]"
                    )}
                >
                    {q.read ? (
                        <>
                            <span className="font-semibold text-accent-soft">Agent’s read: </span>
                            {q.read}
                        </>
                    ) : null}
                </span>
                {reasons ? (
                    <button
                        type="button"
                        data-brainstorm-proscons-toggle
                        aria-expanded={shown}
                        onClick={() => setShown(!shown)}
                        className={cn(CHIP, "flex-none")}
                    >
                        {shown ? "Hide pros and cons" : "Show pros and cons"}
                    </button>
                ) : null}
            </div>
            {options}
        </div>
    );
}

// a letter key focuses its row (bindings.ts), so Enter, the row's own key, sends it
function Options({
    options,
    ans,
    compact,
    reasons,
}: {
    options: AnswerOption[];
    ans: Answer;
    compact: boolean;
    reasons: boolean;
}) {
    return (
        <div role="group" aria-label="Answers" className={cn("flex flex-col", compact ? "gap-[6px]" : "gap-[10px]")}>
            {options.map((o, i) => (
                <div
                    key={i}
                    className={cn(
                        "overflow-hidden rounded-[10px] border has-[>button:disabled]:opacity-50 has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-accent",
                        o.pick
                            ? "border-accent/55 bg-accent/8 has-[>button:enabled:hover]:bg-accentbg"
                            : "border-edge-mid bg-surface has-[>button:enabled:hover]:border-edge-strong"
                    )}
                >
                    <button
                        type="button"
                        data-brainstorm-option={i}
                        data-pick={o.pick ? "" : undefined}
                        disabled={ans.act.busy}
                        onClick={() => void ans.send({ kind: "answer", text: o.label })}
                        className={cn(
                            "flex w-full cursor-pointer items-center border-0 bg-transparent text-left outline-none disabled:cursor-default",
                            compact ? "gap-[12px] px-[12px] py-[9px]" : "gap-[18px] px-[20px] py-[16px]"
                        )}
                    >
                        <span
                            className={cn(
                                "flex flex-none items-center justify-center rounded-[6px] border border-edge-strong font-mono font-semibold text-secondary",
                                compact ? "h-[24px] w-[24px] text-[11.5px]" : "h-[30px] w-[30px] text-[13px]"
                            )}
                        >
                            {optionLetter(i)}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                            <span
                                className={cn(
                                    "font-semibold text-primary",
                                    compact ? "text-[13.5px] leading-[1.4]" : "text-[17px] leading-[1.35]"
                                )}
                            >
                                {o.label}
                            </span>
                            {o.detail ? (
                                <span
                                    className={cn(
                                        "text-ink-mid",
                                        compact ? "text-[12.5px] leading-[1.45]" : "text-[14px]"
                                    )}
                                >
                                    {o.detail}
                                </span>
                            ) : null}
                        </span>
                        {o.pick ? (
                            <span className="flex-none text-[12px] font-semibold text-accent-soft">Agent’s pick</span>
                        ) : null}
                    </button>
                    {reasons && (o.pros != null || o.cons != null) ? <ProsCons o={o} compact={compact} /> : null}
                </div>
            ))}
        </div>
    );
}

// indented to the label, under the letter; the check's narrow column stacks the two lists
function ProsCons({ o, compact }: { o: AnswerOption; compact: boolean }) {
    return (
        <div
            data-brainstorm-proscons
            className={cn(
                "grid",
                compact
                    ? "grid-cols-1 gap-[6px] pb-[10px] pl-[48px] pr-[12px]"
                    : "grid-cols-2 gap-[24px] pb-[16px] pl-[68px] pr-[20px] pt-[2px]"
            )}
        >
            <ReasonList label={`${o.label}: for`} mark="+" tone="text-success" items={o.pros} compact={compact} />
            <ReasonList label={`${o.label}: against`} mark="−" tone="text-error" items={o.cons} compact={compact} />
        </div>
    );
}

function ReasonList({
    label,
    mark,
    tone,
    items,
    compact,
}: {
    label: string;
    mark: string;
    tone: string;
    items: string[] | undefined;
    compact: boolean;
}) {
    return (
        <ul aria-label={label} className="m-0 flex list-none flex-col gap-[7px] p-0">
            {(items ?? []).map((t, i) => (
                <li
                    key={i}
                    className={cn(
                        "flex gap-[8px] leading-[1.5] text-secondary",
                        compact ? "text-[12.5px]" : "text-[13.5px]"
                    )}
                >
                    <span aria-hidden="true" className={cn("w-[10px] flex-none font-mono", tone)}>
                        {mark}
                    </span>
                    <span>{t}</span>
                </li>
            ))}
        </ul>
    );
}

function AnswerBox({ ans, options }: { ans: Answer; options: boolean }) {
    return (
        <div className="flex items-center gap-[12px]">
            <textarea
                data-brainstorm-answer
                aria-label="Your answer"
                rows={options ? 1 : 3}
                value={ans.draft}
                placeholder={options ? "Or type your own answer…" : "Answer in your own words…"}
                onChange={(e) => ans.setDraft(e.target.value)}
                onKeyDown={(e) => onEnter(e, ans.sendDraft)}
                className={cn(FIELD, "min-w-0 flex-1")}
            />
            <button
                type="button"
                data-brainstorm-ok
                disabled={ans.draft.trim() === "" || ans.act.busy}
                onClick={ans.sendDraft}
                className="flex-none cursor-pointer rounded-[7px] bg-accent px-[14px] py-[7px] text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-50"
            >
                OK
            </button>
            <span className="flex-none text-[12px] text-muted">press Enter</span>
        </div>
    );
}

function QuestionMain({
    agent,
    f,
    goTo,
    openDesign,
}: {
    agent: AgentVM;
    f: BrainstormFile;
    goTo: (id: string) => void;
    openDesign: () => void;
}) {
    const q = f.question!;
    const fresh = f.history.length === 0;
    // guessing or skipping means something only for a question about a part of the design
    const chips = q.part !== "";
    const ans = useAnswer(agent);
    return (
        <div data-brainstorm-question className="flex min-h-0 flex-1 flex-col">
            <Track f={f} />
            <MainBody>
                <div className="flex flex-col gap-[14px]">
                    <span className="flex items-center gap-[10px] text-[13px] text-warning">
                        {q.part ? (
                            <>
                                <span className="font-mono font-semibold">{q.n} →</span>
                                <button
                                    type="button"
                                    onClick={() => goTo(q.part)}
                                    className="cursor-pointer border-0 bg-transparent p-0 text-warning hover:underline"
                                >
                                    {partTitle(f, q.part)}
                                </button>
                            </>
                        ) : (
                            <span className="font-mono font-semibold">Question {q.n}</span>
                        )}
                    </span>
                    <h1 className="m-0 whitespace-pre-line text-[30px] font-bold leading-[1.3] text-primary">
                        {q.text}
                    </h1>
                    {q.why ? (
                        <p data-brainstorm-why className="m-0 text-[16px] leading-[1.6] text-ink-mid">
                            {q.why}
                        </p>
                    ) : null}
                </div>
                <QuestionAnswers key={q.n} q={q} ans={ans} compact={false} />
                <AnswerBox ans={ans} options={q.options != null} />
                <div className="flex flex-col gap-[10px]">
                    <div className="flex items-center gap-[10px]">
                        {chips && !fresh ? (
                            <button
                                type="button"
                                disabled={ans.act.busy}
                                onClick={() => void ans.send({ kind: "guess" })}
                                className={CHIP}
                            >
                                Guess for me
                            </button>
                        ) : null}
                        {chips ? (
                            <button
                                type="button"
                                disabled={ans.act.busy}
                                onClick={() => void ans.send({ kind: "skip" })}
                                className={CHIP}
                            >
                                Skip the questions
                            </button>
                        ) : null}
                        <div className="flex-1" />
                        <DesignButton f={f} onClick={openDesign} />
                    </div>
                    {ans.act.error != null ? <span className={ERROR_LINE}>{ans.act.error}</span> : null}
                    {fresh && chips ? (
                        <p data-brainstorm-skip-note className="m-0 text-[12.5px] leading-[1.5] text-ink-mid">
                            Skipping has the agent write every part as its guess. You confirm or edit each one after,
                            before the builder check.
                        </p>
                    ) : null}
                </div>
            </MainBody>
        </div>
    );
}

function WorkingMain({ f, openDesign }: { f: BrainstormFile; openDesign: () => void }) {
    return (
        <div data-brainstorm-working aria-live="polite" className="flex min-h-0 flex-1 flex-col">
            <Track f={f} />
            <MainBody>
                <div className="flex flex-col gap-[14px]">
                    <span className="flex items-center gap-[8px] text-[13px] font-semibold text-success">
                        <span className={cn(SMALL_DOT, "bg-success")} />
                        Working
                    </span>
                    <p className="m-0 text-[22px] font-semibold leading-[1.4] text-primary">{f.working}</p>
                    <p className="m-0 text-[15px] leading-[1.6] text-ink-mid">The next question comes after.</p>
                </div>
                <div className="flex">
                    <DesignButton f={f} onClick={openDesign} />
                </div>
            </MainBody>
        </div>
    );
}

function DesignMain({
    agent,
    s,
    f,
    partsRef,
    opened,
    setOpen,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    partsRef: RefObject<HTMLDivElement>;
    opened: Record<string, boolean>;
    setOpen: (id: string, open: boolean) => void;
}) {
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
    open,
    setOpen,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    part: BrainstormPart;
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
        right = <span className="text-[11.5px] text-muted">Open</span>;
    }
    const dim = view === "open" && !note;
    const thumbs = part.boards != null && f.canvas != null && s.base != null && view !== "writing";

    return (
        <div
            data-brainstorm-part={part.id}
            data-state={note ? "note" : view}
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
                    <span
                        data-brainstorm-gist
                        className={cn(
                            "min-w-0 flex-1 leading-[1.45]",
                            note ? "text-[13px] text-ink-mid" : "text-[13.5px]",
                            !note && (dim ? "text-muted" : "text-secondary")
                        )}
                    >
                        {partGist(f, part)}
                    </span>
                    <span title={part.from} className="w-[120px] flex-none truncate font-mono text-[10.5px] text-muted">
                        {part.from}
                    </span>
                </button>
                <span className="flex h-[20px] min-w-[150px] flex-none items-center justify-end gap-[8px]">
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
                    {thumbs ? (
                        <Thumbnails agentId={agent.id} s={s} canvas={f.canvas!} base={s.base!} boards={part.boards!} />
                    ) : null}
                </div>
            ) : null}
            {act.error != null ? <span className={cn(ERROR_LINE, "px-[14px] pb-[8px]")}>{act.error}</span> : null}
        </div>
    );
}

function CheckMark() {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="mt-[3px] flex-none text-success"
        >
            <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" />
        </svg>
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

// every question answered with all it offered, newest first, and the recon it all stood on at the bottom
function DecidedRail({ f, goTo }: { f: BrainstormFile; goTo: (id: string) => void }) {
    const rows = historyRows(f);
    const decided = rows.filter((r) => r.kind === "question").length;
    const working = f.working != null;
    return (
        <aside
            data-brainstorm-rail
            aria-label="Decided so far"
            className="flex w-[32%] min-w-[280px] max-w-[500px] flex-none flex-col overflow-y-auto border-l border-border bg-surface px-[24px] py-[22px]"
        >
            <div className="flex items-baseline gap-[8px] pb-[8px]">
                <h2 className="m-0 text-[13px] font-semibold text-secondary">Decided so far · {decided}</h2>
                <span className="text-[12px] text-muted">newest first</span>
            </div>
            {rows.length === 0 ? (
                <p className="m-0 border-t border-border pt-[12px] text-[12.5px] leading-[1.5] text-muted">
                    Each answer lands here, with the options it was picked from.
                </p>
            ) : null}
            <div data-brainstorm-history className="flex flex-col">
                {rows.map((h, i) =>
                    h.kind === "recon" ? (
                        <div key={`recon:${i}`} className="flex flex-col gap-[5px] border-t border-border py-[12px]">
                            <span className="font-mono text-[10.5px] text-muted">{h.label}</span>
                            <span className="text-[12.5px] leading-[1.5] text-ink-mid">{h.answer}</span>
                            <IntoLinks into={h.into} goTo={goTo} />
                        </div>
                    ) : (
                        <RailQuestion key={h.label} h={h} justNow={i === 0 && working} goTo={goTo} />
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
        <div data-brainstorm-rail-entry className="flex flex-col gap-[8px] border-t border-border py-[12px]">
            <div className="flex items-baseline gap-[8px]">
                <span className="flex-none font-mono text-[10.5px] text-muted">
                    {h.label}
                    {justNow ? " · just now" : ""}
                </span>
                <span className="text-[12.5px] leading-[1.45] text-ink-mid">{h.q}</span>
            </div>
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

// the design's title and spec path, at the top of the design column in both the design and the check
function DesignHead({ f }: { f: BrainstormFile }) {
    return (
        <div className="flex flex-col gap-[4px] border-b border-border px-[14px] pb-[6px]">
            <h1 className="m-0 text-[16px] font-bold text-primary">{f.title}</h1>
            {f.spec ? (
                <span title={f.spec} className="truncate font-mono text-[10.5px] text-muted">
                    {f.spec}
                </span>
            ) : null}
        </div>
    );
}

// a question asked during the builder check: the check keeps its column, so the question is a card in it
function CheckQuestion({ agent, f, goTo }: { agent: AgentVM; f: BrainstormFile; goTo: (id: string) => void }) {
    const q = f.question!;
    const ans = useAnswer(agent);
    return (
        <div data-brainstorm-question className={ASK_CARD}>
            <div className={ASK_HEAD}>
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
            <div className="flex flex-col gap-[12px] p-[14px]">
                <div className="whitespace-pre-line text-[15px] font-semibold leading-[1.5] text-primary">{q.text}</div>
                {q.why ? <div className="text-[12.5px] leading-[1.5] text-ink-mid">{q.why}</div> : null}
                <QuestionAnswers key={q.n} q={q} ans={ans} compact />
                <AnswerBox ans={ans} options={q.options != null} />
                {ans.act.error != null ? <span className={ERROR_LINE}>{ans.act.error}</span> : null}
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

function ChangeDiff({ part }: { part: BrainstormPart }) {
    const diff = sentenceDiff(part.was ?? "", part.body).filter((d) => d.kind !== "same");
    return (
        <>
            {diff.map((d, i) => (
                <div
                    key={i}
                    className={cn(
                        "rounded-[6px] px-[10px] py-[6px] text-[13px] leading-[1.5] text-secondary",
                        d.kind === "added" ? "bg-success/10" : "bg-error/10"
                    )}
                >
                    <span className={cn("font-mono", d.kind === "added" ? "text-success" : "text-error")}>
                        {d.kind === "added" ? "+ " : "− "}
                    </span>
                    {d.text}
                </div>
            ))}
            {part.why ? <div className="text-[12px] text-muted">Why: {part.why}</div> : null}
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
        <div className="flex flex-col gap-[10px]">
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
    const leftRef = useRef<HTMLDivElement>(null);
    const designRef = useRef<HTMLDivElement>(null);
    const hv = handoffView(f);
    const check = f.check!;
    const working = f.working != null;
    const goToSection = (key: string) =>
        leftRef.current
            ?.querySelector(`[data-brainstorm-section="${key}"]`)
            ?.scrollIntoView({ block: "start", behavior: "smooth" });
    return (
        <>
            <Toolbar topic={s.topic} f={f} />
            <StaleBanner s={s} />
            <div className="flex min-h-0 flex-1">
                <div
                    ref={leftRef}
                    className="flex w-[430px] flex-none flex-col gap-[18px] overflow-y-auto border-r border-border bg-surface p-[20px] *:flex-none"
                >
                    {!working && f.question != null ? (
                        <CheckQuestion agent={agent} f={f} goTo={(id) => scrollToPart(designRef, id)} />
                    ) : null}
                    <div className="flex flex-col gap-[8px]">
                        <h2 className="m-0 text-[15px] font-semibold text-primary">A builder read the design</h2>
                        <p className="m-0 text-[13px] leading-[1.5] text-ink-mid">
                            A fresh agent checked whether it could plan from this without coming back to you. It had{" "}
                            {hv.questions} questions:
                        </p>
                        <div className="grid grid-cols-3 gap-[6px]">
                            <Tile
                                tile="for-you"
                                n={hv.forYou}
                                label="for you"
                                tone={hv.open != null ? "text-warning" : "text-ink-mid"}
                                waiting={hv.open != null}
                                onClick={goToSection}
                            />
                            <Tile
                                tile="calls"
                                n={hv.calls.length}
                                label="the agent decided"
                                tone="text-accent-soft"
                                onClick={goToSection}
                            />
                            <Tile
                                tile="already"
                                n={hv.already}
                                label="already in the design"
                                tone="text-ink-mid"
                                onClick={goToSection}
                            />
                        </div>
                    </div>
                    {hv.forYou > 0 ? (
                        <div data-brainstorm-section="for-you" className="flex scroll-mt-[20px] flex-col gap-[10px]">
                            {hv.open != null ? (
                                <BuilderQuestion
                                    agent={agent}
                                    q={hv.open}
                                    unanswered={hv.forYou - hv.answered.length}
                                    working={working}
                                />
                            ) : null}
                            {hv.answered.map((y, i) => (
                                <div
                                    key={i}
                                    data-brainstorm-answered
                                    className="flex flex-col gap-[8px] rounded-[8px] border border-edge-mid bg-surface-raised px-[16px] py-[12px]"
                                >
                                    <div className="flex items-center gap-[8px] text-[12px] font-semibold text-success">
                                        <span className={cn(SMALL_DOT, "bg-success")} />
                                        You answered
                                    </div>
                                    {y.q ? (
                                        <div className="text-[13.5px] font-semibold leading-[1.5] text-primary">
                                            {y.q}
                                        </div>
                                    ) : null}
                                    {y.why ? (
                                        <div className="text-[12px] leading-[1.5] text-muted">Why: {y.why}</div>
                                    ) : null}
                                    <div className="flex items-start gap-[8px] pt-[2px]">
                                        <CheckMark />
                                        <span className="text-[13.5px] leading-[1.5] text-ink-hi">
                                            {y.a}
                                            {y.into ? (
                                                <>
                                                    {" "}
                                                    Added to{" "}
                                                    <button
                                                        type="button"
                                                        onClick={() => scrollToPart(designRef, y.into!)}
                                                        className={LINK}
                                                    >
                                                        {partTitle(f, y.into)}
                                                    </button>
                                                    .
                                                </>
                                            ) : null}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {hv.calls.length > 0 ? (
                        <section data-brainstorm-section="calls" className="flex scroll-mt-[20px] flex-col">
                            <div className="flex items-baseline gap-[8px] pb-[4px]">
                                <h2 className={SECTION_HEAD}>The agent decided · {hv.calls.length}</h2>
                                <span className="text-[12px] text-muted">
                                    shown in the design; check them as you read
                                </span>
                            </div>
                            {hv.calls.map((c, i) => (
                                <div
                                    key={i}
                                    className="flex flex-col gap-[3px] border-t border-edge-faint py-[9px] text-[13px] leading-[1.5] text-secondary"
                                >
                                    {c.text}
                                    {c.part != null ? (
                                        <span className="text-[11.5px] text-muted">
                                            in{" "}
                                            <button
                                                type="button"
                                                onClick={() => scrollToPart(designRef, c.part!)}
                                                className={LINK}
                                            >
                                                {partTitle(f, c.part)}
                                            </button>
                                        </span>
                                    ) : null}
                                </div>
                            ))}
                        </section>
                    ) : null}
                    {hv.already > 0 ? (
                        <section data-brainstorm-section="already" className="flex scroll-mt-[20px] flex-col">
                            <h2 className="m-0 pb-[4px] text-[13px] font-semibold text-ink-mid">
                                Already in the design · {hv.already}
                            </h2>
                            {check.answered.map((a, i) => (
                                <div
                                    key={i}
                                    className="border-t border-edge-faint py-[8px] text-[12.5px] leading-[1.5] text-ink-mid"
                                >
                                    {a}
                                </div>
                            ))}
                        </section>
                    ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                    <FinishedDesign f={f} hv={hv} scrollRef={designRef} />
                    <ApproveBar model={model} agent={agent} s={s} f={f} working={working} />
                </div>
            </div>
        </>
    );
}

// one of the check's three counts, which scrolls the left column to its section
function Tile({
    tile,
    n,
    label,
    tone,
    waiting = false,
    onClick,
}: {
    tile: string;
    n: number;
    label: string;
    tone: string;
    waiting?: boolean;
    onClick: (tile: string) => void;
}) {
    return (
        <button
            type="button"
            data-brainstorm-tile={tile}
            disabled={n === 0}
            onClick={() => onClick(tile)}
            className={cn(
                "flex cursor-pointer flex-col gap-[2px] rounded-[8px] border bg-transparent px-[10px] py-[8px] text-left hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent",
                waiting ? "border-warning/45" : "border-edge-mid"
            )}
        >
            <span className="text-[16px] font-bold text-primary">{n}</span>
            <span className={cn("text-[11.5px]", tone)}>{label}</span>
        </button>
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
        <div data-brainstorm-builder-question className={ASK_CARD}>
            <div className={ASK_HEAD}>
                <span className={cn(SMALL_DOT, "bg-warning")} />
                <span className={cn(CARD_LABEL, "text-warning")}>Only you can answer · {unanswered}</span>
            </div>
            <div className="flex flex-col gap-[10px] p-[14px]">
                <div className="text-[15px] font-semibold leading-[1.5] text-primary">{q.q}</div>
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

function FinishedDesign({
    f,
    hv,
    scrollRef,
}: {
    f: BrainstormFile;
    hv: HandoffView;
    scrollRef: RefObject<HTMLDivElement>;
}) {
    const [all, setAll] = useState(false);
    const parts = all ? orderedParts(f) : hv.touched;
    return (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-background">
            <div className="flex flex-col gap-[16px] px-[22px] pb-[40px] pt-[20px]">
                <DesignHead f={f} />
                <div className="flex items-baseline gap-[8px] px-[14px]">
                    <h2 className={SECTION_HEAD}>What the builder touched</h2>
                    <span className="text-[12px] text-muted">the spec, as the run will get it</span>
                </div>
                {parts.map((p) => (
                    <div
                        key={p.id}
                        data-brainstorm-part={p.id}
                        className="flex scroll-mt-[20px] flex-col gap-[6px] px-[14px]"
                    >
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
                        className={cn(LINK, "mx-[14px] self-start text-[12.5px] font-semibold")}
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
    working,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
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
    const blocker = approveBlocker(f);
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
            {blocker != null ? (
                <span data-brainstorm-approve-reason className="flex-none text-[12px] text-warning">
                    {blocker}
                </span>
            ) : null}
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
                disabled={blocker != null || act.busy}
                title={blocker ?? undefined}
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
