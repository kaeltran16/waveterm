// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The builder check: the main area asks the talk question, then the builder's questions, then reviews what the
// check changed; the rail beside it (narrow, a summary line over the main area) says what the builder asked, and Approve
// sits under the main area.

import { composerReveal, turnTransition } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import { cn } from "@/util/util";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import {
    approveBlocker,
    CHECK_INTRO,
    checkAsk,
    checkMain,
    checkRailLine,
    checkReview,
    checkSummaryLine,
    checkUnder,
    hasProsCons,
    lineBox,
    partTitle,
    pickCount,
    runLine,
    type AskModel,
    type BrainstormFile,
    type BrainstormQuestion,
    type TrackSegment,
} from "./brainstormmodel";
import { AnsweredRail, AnsweredSection, CheckReview, ReviewHints } from "./brainstormreview";
import { approveAndOpenRun, openRunLauncher, sendBrainstorm } from "./brainstormsend";
import { clearPartTarget, openBrainstormDesign, setReviewCursor, type BrainstormState } from "./brainstormstore";
import {
    AnswerBox,
    BS_RAIL,
    BS_SPLIT,
    CHIP,
    DesignButton,
    DOT,
    ErrorLine,
    JudgingMain,
    LineBar,
    LINK,
    MainBody,
    ProsConsToggle,
    QuestionAnswers,
    questionHeadClasses,
    QuestionMain,
    SECTION_HEAD,
    SMALL_DOT,
    StaleBanner,
    Toolbar,
    Track,
    useAction,
    useAnswer,
    useBsNarrow,
    WORKING_TITLE,
    WorkingMain,
} from "./brainstormui";
import { CANVAS_BTN, CANVAS_PRIMARY_BTN } from "./canvaspane";
import { changeShown } from "./designroute";

type QueueState = AskModel["queue"][number]["state"];

const QUEUE_TRACK: Record<QueueState, TrackSegment> = { answered: "done", now: "now", waiting: "ahead" };
const QUEUE_DOT: Record<QueueState, string> = {
    now: "bg-warning",
    waiting: "border-[1.5px] border-ink-faint",
    answered: "bg-success",
};
const QUEUE_TEXT: Record<QueueState, string> = {
    now: "text-primary",
    waiting: "text-ink-mid",
    answered: "text-muted",
};

export function Check({
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
    // narrow, the hints bar would take a row of the tab's 600px (the keys work without it), and the rail gives way to
    // the summary line
    const narrow = useBsNarrow();
    const linePending = s.sent != null;
    const main = checkMain(f, s.designOpen, linePending);
    // the review opened over a question or the working note: the way back to it
    const under = checkUnder(f, s.designOpen, linePending);
    const openDesign = () => openBrainstormDesign(agent.id, true);
    const goTo = (id: string) => {
        setReviewCursor(agent.id, id);
        openDesign();
    };
    const mainRef = useRef<HTMLDivElement>(null);
    // a part opened from outside the pane (the transcript's Edit): the cursor on its row, which is brought into view
    // even when the cursor was there already, once
    useEffect(() => {
        const id = s.partTarget;
        if (id == null) {
            return;
        }
        goTo(id);
        clearPartTarget(agent.id);
        mainRef.current
            ?.querySelector(`[data-brainstorm-review-row="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [s.partTarget]);
    return (
        <>
            <Toolbar topic={s.topic} f={f} progress={false} />
            <StaleBanner s={s} />
            {narrow && f.check != null ? (
                <CheckSummary f={f} agent={agent} review={main === "review"} goTo={goTo} />
            ) : null}
            <div className={BS_SPLIT}>
                <div ref={mainRef} className="flex min-w-0 flex-1 flex-col bg-background">
                    {under !== "review" ? (
                        <div className="flex flex-none items-center border-b border-border px-[22px] py-[8px]">
                            <button
                                type="button"
                                data-brainstorm-back
                                onClick={() => openBrainstormDesign(agent.id, false)}
                                className={cn(
                                    CHIP,
                                    "flex items-center gap-[8px]",
                                    under !== "working" && "border-warning/45 bg-warning/12"
                                )}
                            >
                                <span className={cn(SMALL_DOT, under === "working" ? "bg-success" : "bg-warning")} />
                                {under === "working" ? "Back to what the agent is writing" : "Back to the question"}
                            </button>
                        </div>
                    ) : null}
                    <ViewSwap swapKey={main} className="flex min-h-0 flex-1 flex-col">
                        {main === "question" ? (
                            <QuestionMain agent={agent} s={s} f={f} goTo={goTo} openDesign={openDesign} skip={false} />
                        ) : main === "builder" ? (
                            <BuilderAsk agent={agent} f={f} goTo={goTo} openDesign={openDesign} />
                        ) : main === "judging" ? (
                            <JudgingMain agent={agent} s={s} f={f} goTo={goTo} openDesign={openDesign} skip={false} />
                        ) : main === "working" ? (
                            <WorkingMain agent={agent} s={s} f={f} nowAtom={model.nowAtom} openDesign={openDesign} />
                        ) : (
                            <CheckReview model={model} agent={agent} s={s} f={f} />
                        )}
                    </ViewSwap>
                    {main === "review" ? (
                        <LineBar agent={agent} box={lineBox(f)} carrying={pickCount(f, s.picks).picked} />
                    ) : null}
                    <ApproveBar model={model} agent={agent} s={s} f={f} />
                </div>
                {narrow ? null : main === "review" ? (
                    <AnsweredRail f={f} agent={agent} />
                ) : (
                    <AskRail f={f} goTo={goTo} />
                )}
            </div>
            {main === "review" && !narrow ? <ReviewHints /> : null}
        </>
    );
}

// the builder's open question, asked as the talk question is: its answers, a box for your own, or the agent decides
function BuilderAsk({
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
    const ask = checkAsk(f);
    const ans = useAnswer(agent, "builder-answer");
    const narrow = useBsNarrow();
    const head = questionHeadClasses(narrow);
    // the question whose pros and cons are hidden, so the next question shows them again
    const [hiddenFor, setHiddenFor] = useState<number | null>(null);
    const open = ask.open!;
    // drawn with the talk question's answers, which read a question's options
    const asked: BrainstormQuestion = { n: ask.index, text: open.q, part: open.part ?? "", options: open.options };
    const reasonsShown = hiddenFor !== ask.index;
    return (
        <div data-brainstorm-builder-question className="flex min-h-0 flex-1 flex-col">
            {/* a lone question is the one on screen, so its track would only repeat it */}
            {narrow && ask.total < 2 ? null : <Track segments={ask.queue.map((y) => QUEUE_TRACK[y.state])} />}
            <MainBody>
                <div className={head.wrap}>
                    <div className="flex items-center gap-x-[12px] gap-y-[8px] @max-[480px]/bs:flex-wrap">
                        <span data-brainstorm-builder-head className={cn(head.label, "min-w-0 grow")}>
                            <span className="font-mono font-semibold">
                                Builder {ask.index} of {ask.total}
                            </span>
                            {open.part ? (
                                <>
                                    <span className="text-muted">·</span>
                                    <span>
                                        for{" "}
                                        <button
                                            type="button"
                                            onClick={() => goTo(open.part!)}
                                            className={cn(LINK, "border-0 bg-transparent p-0")}
                                        >
                                            {partTitle(f, open.part)}
                                        </button>
                                    </span>
                                </>
                            ) : null}
                        </span>
                        {hasProsCons(asked) ? (
                            <ProsConsToggle
                                shown={reasonsShown}
                                onToggle={() => setHiddenFor(reasonsShown ? ask.index : null)}
                            />
                        ) : null}
                    </div>
                    <h1 className={head.text}>{open.q}</h1>
                    {open.why ? (
                        <p data-brainstorm-why className={head.why}>
                            {open.why}
                        </p>
                    ) : null}
                </div>
                <QuestionAnswers key={ask.index} q={asked} ans={ans} compact={false} reasonsShown={reasonsShown} />
                <AnswerBox ans={ans} options={open.options != null} />
                <div className="flex flex-col gap-[10px]">
                    <div className="flex items-center gap-[10px] @max-[480px]/bs:flex-wrap">
                        {/* the spacer would take a row of its own once the chips wrap */}
                        <button
                            type="button"
                            data-brainstorm-builder-decide
                            disabled={ans.act.busy}
                            onClick={() => void ans.send({ kind: "builder-decide" })}
                            className={CHIP}
                        >
                            Let the agent decide
                        </button>
                        <div className="flex-1 @max-[480px]/bs:hidden" />
                        <DesignButton f={f} onClick={openDesign} />
                    </div>
                    <ErrorLine error={ans.act.error} />
                </div>
            </MainBody>
        </div>
    );
}

// what the builder asked: the questions only you can answer, the calls the agent made by part, and what was
// already in the design
function AskRail({ f, goTo }: { f: BrainstormFile; goTo: (id: string) => void }) {
    const ask = checkAsk(f);
    return (
        <aside
            data-brainstorm-check-rail
            aria-label="The builder check"
            className={cn(
                BS_RAIL,
                "flex flex-col gap-[20px] overflow-y-auto border-l border-border bg-surface px-[24px] py-[22px] *:flex-none"
            )}
        >
            <div className="flex flex-col gap-[8px]">
                <h2 className="m-0 text-[15px] font-semibold text-primary">A builder read the design</h2>
                <p data-brainstorm-check-rail-line className="m-0 text-[13px] leading-[1.5] text-ink-mid">
                    {checkRailLine(ask.questions)}
                </p>
            </div>
            {ask.total > 0 ? <ForYouSection ask={ask} /> : null}
            <DecidedSection ask={ask} goTo={goTo} />
            <AlreadySection already={ask.already} />
        </aside>
    );
}

// the narrow check's rail: one line of counts under the stepper, opening onto the rail's sections. Closed on mount
function CheckSummary({
    f,
    agent,
    review,
    goTo,
}: {
    f: BrainstormFile;
    agent: AgentVM;
    review: boolean;
    goTo: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const line = checkSummaryLine(f);
    const ask = checkAsk(f);
    return (
        <div data-brainstorm-check-summary className="flex flex-none flex-col border-b border-edge-faint bg-surface">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex w-full cursor-pointer items-center gap-[10px] border-0 bg-transparent px-[22px] py-[9px] text-left text-[12.5px] text-ink-mid @max-[480px]/bs:items-start @max-[480px]/bs:pr-[16px] @max-[480px]/bs:leading-[1.45]"
            >
                <span data-brainstorm-check-summary-line className="min-w-0 flex-1">
                    {line.lead}
                    <span className="font-semibold text-primary">{line.yours}</span>
                    {line.rest}
                </span>
                <span className="flex flex-none items-center gap-[6px] text-accent-soft">
                    {open ? "Hide" : "Show"}
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden="true"
                        style={turnTransition}
                        className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")}
                    >
                        <path d="M2 3.5l3 3 3-3" />
                    </svg>
                </span>
            </button>
            <div data-brainstorm-check-summary-panel>
                <PaneReveal open={open}>
                    <div className="flex max-h-[300px] flex-col gap-[14px] overflow-y-auto px-[22px] pb-[12px] *:flex-none">
                        {review ? (
                            <AnsweredSection answered={checkReview(f).answered} agent={agent} titled />
                        ) : (
                            <>
                                <p className="m-0 text-[12.5px] leading-[1.5] text-muted">{CHECK_INTRO}</p>
                                {/* one question is the one on screen, so its queue would only repeat it */}
                                {ask.total > 1 ? <ForYouSection ask={ask} /> : null}
                                <DecidedSection ask={ask} goTo={goTo} />
                            </>
                        )}
                        <AlreadySection already={ask.already} />
                    </div>
                </PaneReveal>
            </div>
        </div>
    );
}

function ForYouSection({ ask }: { ask: AskModel }) {
    return (
        <section aria-label="For you" className="flex flex-col">
            <RailHead
                title={
                    <>
                        For you · <TickNumber value={ask.total} />
                    </>
                }
                caption="only you can answer"
            />
            {ask.queue.map((y, i) => (
                <div
                    key={i}
                    data-brainstorm-queue={y.state}
                    className={cn(
                        "flex items-start gap-[10px] rounded-[7px] px-[10px] py-[8px]",
                        y.state === "now" && "bg-warning/12"
                    )}
                >
                    <span className={cn(DOT, "mt-[6px] box-border", QUEUE_DOT[y.state])} />
                    <span className={cn("text-[13px] leading-[1.45]", QUEUE_TEXT[y.state])}>{y.label}</span>
                </div>
            ))}
        </section>
    );
}

// the agent's calls under the part each is about; a part's title moves the review cursor to it
function DecidedSection({ ask, goTo }: { ask: AskModel; goTo: (id: string) => void }) {
    if (ask.calls === 0) {
        return null;
    }
    return (
        <section aria-label="The agent decided" className="flex flex-col">
            <RailHead
                title={
                    <>
                        The agent decided · <TickNumber value={ask.calls} />
                    </>
                }
                caption="you review them with the changes"
            />
            {ask.callGroups.map((g) => (
                <div
                    key={g.part ?? ""}
                    data-brainstorm-call-group={g.part ?? ""}
                    className="flex flex-col gap-[5px] border-t border-edge-faint py-[9px]"
                >
                    {g.part != null ? (
                        <button
                            type="button"
                            onClick={() => goTo(g.part!)}
                            className={cn(
                                LINK,
                                "self-start border-0 bg-transparent p-0 text-left text-[12px] font-semibold"
                            )}
                        >
                            {g.title}
                        </button>
                    ) : (
                        <span className="text-[12px] font-semibold text-ink-mid">{g.title}</span>
                    )}
                    {g.calls.map((c, i) => (
                        <span key={i} className="text-[12.5px] leading-[1.5] text-ink-mid">
                            {c}
                        </span>
                    ))}
                </div>
            ))}
        </section>
    );
}

function AlreadySection({ already }: { already: string[] }) {
    if (already.length === 0) {
        return (
            <span data-brainstorm-already className="text-[12px] text-muted">
                Nothing the builder asked was already in the design.
            </span>
        );
    }
    return (
        <section data-brainstorm-already aria-label="Already in the design" className="flex flex-col">
            <RailHead
                title={
                    <>
                        Already in the design · <TickNumber value={already.length} />
                    </>
                }
            />
            {already.map((a, i) => (
                <div key={i} className="border-t border-edge-faint py-[8px] text-[12.5px] leading-[1.5] text-ink-mid">
                    {a}
                </div>
            ))}
        </section>
    );
}

function RailHead({ title, caption }: { title: ReactNode; caption?: string }) {
    return (
        <div className="flex items-baseline gap-[8px] pb-[6px]">
            <h3 className={SECTION_HEAD}>{title}</h3>
            {caption ? <span className="text-[12px] text-muted">{caption}</span> : null}
        </div>
    );
}

function ApproveBar({
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
    const act = useAction();
    const working = f.working != null;
    const blocker = approveBlocker(f);
    const narrow = useBsNarrow();
    // hidden until the lookup answers, so a click cannot beat it
    const [showChange, setShowChange] = useState(false);
    useEffect(() => {
        let live = true;
        void changeShown(agent.blockId).then((shown) => live && setShowChange(shown));
        return () => {
            live = false;
        };
    }, [agent.blockId]);
    // the two buttons stay together: beside the text while they fit, else on a row of their own under it. The text
    // wraps rather than truncating, since the run line names where the run starts. The blocker, which can be long, takes
    // a row of its own below; narrow it stays the button's title only, as the summary line and main area say what waits
    return (
        <div
            data-brainstorm-approve-bar
            className="flex flex-none flex-col gap-[8px] border-t border-border bg-surface px-[22px] py-[12px]"
        >
            <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[8px]">
                <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-[3px]">
                    <span data-brainstorm-approve-title className="text-[13px] font-semibold text-primary">
                        Approve and start an orchestrator run
                    </span>
                    <span data-brainstorm-approve-line className="break-words font-mono text-[11px] text-muted">
                        {runLine(projectOf(agent))}
                        {showChange ? (
                            <>
                                {" "}
                                ·{" "}
                                <button
                                    type="button"
                                    disabled={blocker != null || act.busy}
                                    title={blocker ?? undefined}
                                    onClick={() => openRunLauncher(model, agent, s)}
                                    className={cn(LINK, "disabled:cursor-default disabled:opacity-50")}
                                >
                                    Change
                                </button>
                            </>
                        ) : null}
                    </span>
                    <ErrorLine error={act.error} />
                </div>
                <div className="ml-auto flex flex-none items-center gap-[14px]">
                    <button
                        type="button"
                        disabled={working || act.busy}
                        title={working ? WORKING_TITLE : undefined}
                        onClick={() => void act.run(() => sendBrainstorm(agent, { kind: "keep-talking" }))}
                        className={cn(CANVAS_BTN, "whitespace-nowrap disabled:cursor-default disabled:opacity-50")}
                    >
                        Keep talking
                    </button>
                    <button
                        type="button"
                        data-brainstorm-approve
                        disabled={blocker != null || act.busy}
                        title={blocker ?? undefined}
                        onClick={() => void act.run(() => approveAndOpenRun(model, agent, s))}
                        className={cn(CANVAS_PRIMARY_BTN, "whitespace-nowrap")}
                    >
                        Approve and start run
                    </button>
                </div>
            </div>
            <PaneReveal open={blocker != null && !narrow} variants={composerReveal}>
                <span data-brainstorm-approve-reason className="block text-[12px] leading-[1.45] text-warning">
                    {blocker}
                </span>
            </PaneReveal>
        </div>
    );
}
