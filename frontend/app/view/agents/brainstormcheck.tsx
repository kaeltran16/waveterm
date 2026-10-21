// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The builder check: the main area asks the talk question, then the builder's questions, then reviews what the
// check changed; the rail beside it says what the builder asked, and Approve sits under the main area.

import { cn } from "@/util/util";
import { useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import {
    approveBlocker,
    checkMain,
    handoffView,
    partTitle,
    runLine,
    type BrainstormFile,
    type BuilderQuestion,
} from "./brainstormmodel";
import { AnsweredRail, CheckReview, ReviewHints } from "./brainstormreview";
import { approveAndOpenRun, openRunLauncher, sendBrainstorm } from "./brainstormsend";
import { openBrainstormDesign, setReviewCursor, type BrainstormState } from "./brainstormstore";
import {
    CARD_LABEL,
    CHIP,
    ERROR_LINE,
    FIELD,
    LINK,
    MainBody,
    onEnter,
    QuestionMain,
    SECTION_HEAD,
    SMALL_DOT,
    StaleBanner,
    Toolbar,
    useAction,
    WORKING_TITLE,
    WorkingMain,
} from "./brainstormui";
import { CANVAS_BTN, CANVAS_PRIMARY_BTN } from "./canvaspane";

// a card that waits on your answer
const ASK_CARD = "overflow-hidden rounded-[8px] border border-warning/45 bg-surface-raised";
const ASK_HEAD = "flex items-center gap-[8px] border-b border-border bg-warning/12 px-[14px] py-[9px]";

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
    const main = checkMain(f, s.designOpen);
    // the review opened over a question: the way back to it
    const back = s.designOpen && checkMain(f, false) !== "review";
    const openDesign = () => openBrainstormDesign(agent.id, true);
    const goTo = (id: string) => {
        setReviewCursor(agent.id, id);
        openDesign();
    };
    return (
        <>
            <Toolbar topic={s.topic} f={f} progress={false} />
            <StaleBanner s={s} />
            <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col bg-background">
                    {back ? (
                        <div className="flex flex-none items-center border-b border-border px-[22px] py-[8px]">
                            <button
                                type="button"
                                data-brainstorm-back
                                onClick={() => openBrainstormDesign(agent.id, false)}
                                className={cn(CHIP, "flex items-center gap-[8px] border-warning/45 bg-warning/12")}
                            >
                                <span className={cn(SMALL_DOT, "bg-warning")} />
                                Back to the question
                            </button>
                        </div>
                    ) : null}
                    {main === "question" ? (
                        <QuestionMain agent={agent} f={f} goTo={goTo} openDesign={openDesign} />
                    ) : main === "builder" ? (
                        <BuilderAsk agent={agent} f={f} />
                    ) : main === "working" ? (
                        <WorkingMain f={f} openDesign={openDesign} />
                    ) : (
                        <CheckReview model={model} agent={agent} s={s} f={f} />
                    )}
                    <ApproveBar model={model} agent={agent} s={s} f={f} />
                </div>
                {main === "review" ? <AnsweredRail f={f} /> : <AskRail f={f} goTo={goTo} />}
            </div>
            {main === "review" ? <ReviewHints /> : null}
        </>
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

function BuilderAsk({ agent, f }: { agent: AgentVM; f: BrainstormFile }) {
    const hv = handoffView(f);
    return (
        <MainBody>
            <BuilderQuestionCard
                agent={agent}
                q={hv.open!}
                unanswered={hv.forYou - hv.answered.length}
                working={f.working != null}
            />
        </MainBody>
    );
}

function BuilderQuestionCard({
    agent,
    q,
    unanswered,
    working,
}: {
    agent: AgentVM;
    q: BuilderQuestion;
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

// what the builder asked: the counts, the calls the agent made, and what was already in the design
function AskRail({ f, goTo }: { f: BrainstormFile; goTo: (id: string) => void }) {
    const railRef = useRef<HTMLDivElement>(null);
    const hv = handoffView(f);
    const check = f.check!;
    const goToSection = (key: string) =>
        railRef.current
            ?.querySelector(`[data-brainstorm-section="${key}"]`)
            ?.scrollIntoView({ block: "start", behavior: "smooth" });
    return (
        <aside
            ref={railRef}
            aria-label="What the builder asked"
            className="flex w-[460px] flex-none flex-col gap-[18px] overflow-y-auto border-l border-border bg-surface p-[20px] *:flex-none"
        >
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
            {hv.calls.length > 0 ? (
                <section data-brainstorm-section="calls" className="flex scroll-mt-[20px] flex-col">
                    <div className="flex items-baseline gap-[8px] pb-[4px]">
                        <h2 className={SECTION_HEAD}>The agent decided · {hv.calls.length}</h2>
                        <span className="text-[12px] text-muted">shown in the design; check them as you read</span>
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
                                    <button type="button" onClick={() => goTo(c.part!)} className={LINK}>
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
        </aside>
    );
}

// one of the check's three counts, which scrolls the rail to its section
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
    return (
        <div
            data-brainstorm-approve-bar
            className="flex flex-none items-center gap-[14px] border-t border-border bg-surface px-[22px] py-[12px]"
        >
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
