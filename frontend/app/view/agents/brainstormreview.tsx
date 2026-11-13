// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The builder check's review of what it changed, the rail of the builder's answered questions beside it, and the
// review's key hints.

import { turnTransition, viewFade } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { TickNumber } from "@/app/element/ticknumber";
import { ViewSwap } from "@/app/element/viewswap";
import { cn } from "@/util/util";
import { motion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import {
    answeredLine,
    checkReview,
    handoffView,
    hasMockups,
    partAnswer,
    partGist,
    pickCount,
    picksLine,
    plural,
    type BrainstormAction,
    type BrainstormFile,
    type BrainstormPart,
    type PartPick,
    type PartView,
    type ReviewRow,
} from "./brainstormmodel";
import { pickPart, sendBrainstorm } from "./brainstormsend";
import {
    openBrainstormDesign,
    setReviewCursor,
    shownPicks,
    toggleReviewRow,
    type BrainstormState,
} from "./brainstormstore";
import {
    BS_RAIL,
    ChangeDiff,
    CheckMark,
    DOT,
    DOT_ASKED,
    DOT_GUESS,
    DOT_OPEN,
    DOT_YOURS,
    ErrorLine,
    FIELD,
    LINK,
    onEnter,
    PART_BTN,
    PartMockups,
    PickButton,
    SaidLine,
    SECTION_HEAD,
    useAction,
    WORKING_TITLE,
} from "./brainstormui";
import { CANVAS_PRIMARY_BTN } from "./canvaspane";

const ROW_GRID =
    "grid grid-cols-[7px_minmax(120px,190px)_minmax(0,1fr)_max-content_12px] items-start gap-x-[12px] gap-y-[6px] border-t border-edge-faint px-[14px] py-[9px]";
// below this review width a row's title and actions beside its gist would squeeze the gist under a readable width
// (the 1600px layout leaves it ~320px; a 1000px window leaves the review ~400px), so the row stacks: the title,
// then the gist, then the actions, each across the row
const STACK_ROW = "@max-[820px]:grid-cols-[7px_minmax(0,1fr)_12px]";
const STACK_GIST = "@max-[820px]:col-[2] @max-[820px]:row-start-2";
const STACK_ACTIONS = "@max-[820px]:col-[2] @max-[820px]:row-start-3 @max-[820px]:mt-0 @max-[820px]:justify-start";
const STACK_UNDER = "@max-[820px]:col-[2/-1]";
const ROW_CURSOR = "rounded-[8px] bg-surface-selected outline outline-1 -outline-offset-1 outline-accent";
// a decision the check rewrote waits on keep or put back: an accent ring until it is yours again
const REVIEW_DOT: Record<PartView, string> = {
    changed: cn(DOT, "box-border border-[1.5px] border-accent"),
    yours: DOT_YOURS,
    guess: cn(DOT_GUESS, "box-border"),
    asked: DOT_ASKED,
    writing: DOT_YOURS,
    open: cn(DOT_OPEN, "box-border"),
};
const QUIET_BTN =
    "cursor-pointer whitespace-nowrap border-0 bg-transparent px-[2px] py-[4px] text-[12px] text-ink-mid hover:text-secondary disabled:cursor-default disabled:opacity-50";
const UNDER_COL = "col-[3/-1]";
const UNDER_BODY = "flex flex-col gap-[4px]";
const REVIEW_KEYS: [string, string][] = [
    ["j k", "Next or previous decision"],
    ["Enter", "Open or close the decision"],
    ["y", "Keep the change"],
    ["u", "Put mine back"],
    ["b", "Back to the terminal"],
];

export function CheckReview({
    agent,
    s,
    f,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const r = checkReview(f);
    const cursor = s.review.cursor;
    // j and k move the cursor from outside the review, so the row it lands on is brought into view here
    useEffect(() => {
        if (cursor != null) {
            scrollRef.current
                ?.querySelector(`[data-brainstorm-review-row="${CSS.escape(cursor)}"]`)
                ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }, [cursor]);
    const row = (x: ReviewRow) => (
        <ReviewRowView
            key={x.id}
            agent={agent}
            s={s}
            f={f}
            row={x}
            cursor={x.id === cursor}
            open={s.review.open[x.id] === true}
        />
    );
    return (
        <div ref={scrollRef} data-brainstorm-review className="@container min-h-0 flex-1 overflow-y-auto bg-background">
            <div className="flex flex-col gap-[16px] px-[22px] pb-[30px] pt-[22px]">
                <div className="flex flex-col gap-[3px] px-[14px]">
                    <h1 className="m-0 text-[18px] font-bold text-primary">Review what the check changed</h1>
                    {r.summary ? (
                        <span data-brainstorm-review-summary className="text-[13px] leading-[1.5] text-ink-mid">
                            {r.summary}
                        </span>
                    ) : null}
                </div>
                <PicksBar agent={agent} s={s} f={f} className="px-[14px]" />
                {r.changed.length > 0 ? (
                    <section aria-label="Changed" data-brainstorm-review-section="changed" className="flex flex-col">
                        <div className="flex items-baseline gap-[8px] px-[14px] pb-[6px]">
                            <h2 className={SECTION_HEAD}>
                                Changed since you confirmed · <TickNumber value={r.changed.length} />
                            </h2>
                            {r.anyWas ? (
                                <span className="text-[12px] text-muted">open one to see what it was</span>
                            ) : null}
                            {r.pending > 1 ? <KeepAll agent={agent} f={f} pending={r.pending} /> : null}
                        </div>
                        {r.changed.map(row)}
                    </section>
                ) : null}
                {r.fresh.length > 0 ? (
                    <section aria-label="New" data-brainstorm-review-section="fresh" className="flex flex-col">
                        <div className="flex items-baseline gap-[8px] px-[14px] py-[6px]">
                            <h2 className={SECTION_HEAD}>New since the check · {r.fresh.length}</h2>
                        </div>
                        {r.fresh.map(row)}
                    </section>
                ) : null}
                <PartLinks kind="unchanged" label="Yours, unchanged" agent={agent} s={s} f={f} parts={r.unchanged} />
                <PartLinks kind="notes" label="What the agent found" agent={agent} s={s} f={f} parts={r.notes} />
            </div>
        </div>
    );
}

// one press for every change still waiting, so a check that rewrote many decisions is not one agent turn each
function KeepAll({ agent, f, pending }: { agent: AgentVM; f: BrainstormFile; pending: number }) {
    const act = useAction();
    const working = f.working != null;
    return (
        <span className="ml-auto flex flex-none flex-col items-end gap-[4px] self-center">
            <button
                type="button"
                data-brainstorm-keep-all
                disabled={working || act.busy}
                title={working ? WORKING_TITLE : undefined}
                onClick={() => void act.run(() => sendBrainstorm(agent, { kind: "keep-all" }))}
                className={cn(PART_BTN, "whitespace-nowrap")}
            >
                Keep all <TickNumber value={pending} /> changes
            </button>
            <ErrorLine error={act.error} />
        </span>
    );
}

// the picks waiting to go, and the press that sends them before every decision is settled
export function PicksBar({
    agent,
    s,
    f,
    className,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    className?: string;
}) {
    const act = useAction();
    const c = pickCount(f, s.picks);
    if (c.picked === 0) {
        return null;
    }
    const working = f.working != null;
    return (
        <div data-brainstorm-picks className={cn("flex flex-col gap-[4px]", className)}>
            <div className="flex items-center gap-[14px]">
                <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span data-brainstorm-picks-line className="text-[13px] leading-[1.5] text-secondary">
                        {picksLine(c)}
                    </span>
                    <span className="text-[12px] text-muted">
                        They go with the next line you send, or by themselves once every decision is settled.
                    </span>
                </div>
                <button
                    type="button"
                    data-brainstorm-send-picks
                    disabled={act.busy || working}
                    title={working ? WORKING_TITLE : undefined}
                    onClick={() => void act.run(() => sendBrainstorm(agent, { kind: "settle" }))}
                    className={cn(CANVAS_PRIMARY_BTN, "flex-none")}
                >
                    Send {plural(c.picked, "choice", "choices")}
                </button>
            </div>
            <ErrorLine error={act.error} />
        </div>
    );
}

// one decision on one grid line: dot, title, what it says now with its cause, the one action it asks for, and the
// arrow that opens what it was
function ReviewRowView({
    agent,
    s,
    f,
    row,
    cursor,
    open,
}: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    row: ReviewRow;
    cursor: boolean;
    open: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const act = useAction();
    const working = f.working != null;
    const locked = working || act.busy;
    const lockTitle = working ? WORKING_TITLE : undefined;
    const part = f.parts.find((p) => p.id === row.id);
    // only a decision that was yours has something it was: what is new since the check opens only for its mockups
    const expandable = row.action === "keep-restore" || row.view === "yours" || hasMockups(f, part, s.base);
    const send = (action: BrainstormAction) => act.run(() => sendBrainstorm(agent, action));
    const toggle = () => toggleReviewRow(agent.id, row.id);
    const startEdit = () => {
        setDraft(row.body);
        setEditing(true);
    };
    const stacks = row.action === "keep-restore" || row.action === "confirm";
    const under = stacks && STACK_UNDER;
    const picked = shownPicks(s)[row.id];
    const pickBtn = (label: string, pick: PartPick, className: string) => (
        <PickButton
            label={label}
            pressed={picked === pick}
            dimmed={picked != null}
            className={className}
            disabled={locked}
            title={lockTitle}
            onClick={() => void act.run(() => pickPart(agent, row.id, pick))}
        />
    );
    let right = null;
    if (row.action === "keep-restore") {
        right = (
            <span className={cn("-mt-[3px] flex items-center justify-end gap-[12px]", STACK_ACTIONS)}>
                {pickBtn("Keep the change", "keep", cn(PART_BTN, "whitespace-nowrap"))}
                {pickBtn("Put mine back", "restore", QUIET_BTN)}
            </span>
        );
    } else if (row.action === "confirm") {
        // the actions give way to the edit box under the row, and come back when it closes
        right = (
            <ViewSwap
                swapKey={editing ? "editing" : "actions"}
                className={cn(!editing && "-mt-[3px] flex items-center justify-end gap-[12px]", STACK_ACTIONS)}
            >
                {editing ? null : (
                    <>
                        {pickBtn("That’s right", "confirm", cn(PART_BTN, "whitespace-nowrap"))}
                        <button
                            type="button"
                            disabled={locked}
                            title={lockTitle}
                            onClick={startEdit}
                            className={QUIET_BTN}
                        >
                            Edit
                        </button>
                    </>
                )}
            </ViewSwap>
        );
    } else if (row.action === "answer") {
        right = (
            <span className="-mt-[3px] flex justify-end">
                <button
                    type="button"
                    onClick={() => openBrainstormDesign(agent.id, false)}
                    className={cn(PART_BTN, "whitespace-nowrap border-warning/45 bg-warning/12")}
                >
                    Answer question {row.question}
                </button>
            </span>
        );
    } else if (row.view === "yours") {
        right = <span className="mt-[2px] text-right text-[11.5px] text-success">Yours</span>;
    } else {
        right = <span />;
    }
    return (
        <div
            data-brainstorm-review-row={row.id}
            data-cursor={cursor ? "" : undefined}
            data-state={row.view}
            onClick={() => setReviewCursor(agent.id, row.id)}
            className={cn(ROW_GRID, "scroll-mt-[20px]", stacks && STACK_ROW, cursor && ROW_CURSOR)}
        >
            <span className={cn(REVIEW_DOT[row.view], "mt-[6px]")} />
            {expandable ? (
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={toggle}
                    className="cursor-pointer border-0 bg-transparent p-0 text-left text-[13.5px] font-semibold leading-[1.45] text-primary"
                >
                    {row.title}
                </button>
            ) : (
                <span className="text-[13.5px] font-semibold leading-[1.45] text-primary">{row.title}</span>
            )}
            <span className={cn("flex min-w-0 flex-col gap-[2px]", stacks && STACK_GIST)}>
                <span
                    data-brainstorm-gist
                    className={cn(
                        "text-[13.5px] leading-[1.45]",
                        row.action === "answer" ? "text-ink-mid" : "text-secondary"
                    )}
                >
                    {row.gist}
                </span>
                {row.cause ? (
                    <span data-brainstorm-review-cause className="font-mono text-[10.5px] text-muted">
                        {row.cause}
                    </span>
                ) : null}
                {row.said != null ? <SaidLine said={row.said} open={open && expandable} /> : null}
            </span>
            {right}
            {expandable ? (
                <button
                    type="button"
                    data-brainstorm-review-toggle
                    aria-label={`${open ? "Hide" : "Show"} ${row.hasWas ? "what it was" : "it"}`}
                    aria-expanded={open}
                    onClick={toggle}
                    style={turnTransition}
                    className={cn(
                        "mt-[4px] flex w-[12px] cursor-pointer border-0 bg-transparent p-0 text-muted transition-transform motion-reduce:transition-none",
                        open && "rotate-180"
                    )}
                >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M3 4.5l3 3 3-3" />
                    </svg>
                </button>
            ) : (
                <span />
            )}
            <PaneReveal open={open && expandable} className={cn(UNDER_COL, under)}>
                <div data-brainstorm-review-diff className={UNDER_BODY}>
                    {/* the cause is already under the title, so the diff leaves out its why */}
                    {row.was != null && part != null ? (
                        <ChangeDiff part={{ ...part, why: undefined }} />
                    ) : (
                        <div className="whitespace-pre-line rounded-[6px] bg-surface px-[10px] py-[6px] text-[13px] leading-[1.5] text-secondary">
                            {row.body}
                        </div>
                    )}
                    {part != null ? <PartMockups agentId={agent.id} s={s} f={f} part={part} /> : null}
                </div>
            </PaneReveal>
            {editing ? (
                // editing starts false, so this mounts only on the user's Edit
                <motion.div
                    variants={viewFade}
                    initial="initial"
                    animate="animate"
                    className={cn(UNDER_COL, UNDER_BODY, under)}
                >
                    <textarea
                        data-brainstorm-edit
                        aria-label={`Edit ${row.title}`}
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
                                void send({ kind: "edit", part: row.id, text: draft }).then((ok) => {
                                    if (ok) {
                                        setEditing(false);
                                    }
                                });
                            });
                        }}
                        className={FIELD}
                    />
                    <span className="text-[11.5px] text-muted">Enter sends · Esc cancels</span>
                </motion.div>
            ) : null}
            {row.calls.map((c, i) => (
                <div
                    key={i}
                    data-brainstorm-review-call
                    className={cn(
                        "col-[3/-1] flex items-baseline gap-[8px] rounded-[6px] bg-accentbg px-[10px] py-[5px] text-[12.5px] leading-[1.5] text-secondary",
                        under
                    )}
                >
                    <span className="flex-none text-[11px] font-semibold text-accent-soft">Agent’s call</span>
                    {c}
                </div>
            ))}
            <ErrorLine error={act.error} className={cn("col-[3/-1]", under)} />
        </div>
    );
}

// the parts the review has nothing to ask about, as one line of titles; a title opens that part under the line
function PartLinks({
    kind,
    label,
    agent,
    s,
    f,
    parts,
}: {
    kind: string;
    label: string;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
    parts: BrainstormPart[];
}) {
    const [shown, setShown] = useState<string | null>(null);
    if (parts.length === 0) {
        return null;
    }
    const part = parts.find((p) => p.id === shown);
    const said = part != null ? partAnswer(f, part) : null;
    return (
        <section
            aria-label={label}
            data-brainstorm-review-links={kind}
            className="flex flex-col gap-[8px] border-t border-edge-faint px-[14px] py-[10px]"
        >
            <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[6px]">
                <h2 className="m-0 text-[13px] font-semibold text-ink-mid">
                    {label} · {parts.length}
                </h2>
                {parts.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        data-brainstorm-review-link={p.id}
                        aria-expanded={p.id === shown}
                        onClick={() => setShown(p.id === shown ? null : p.id)}
                        className={cn(
                            "cursor-pointer border-0 bg-transparent p-0 text-[12.5px] hover:underline",
                            p.id === shown ? "text-accent-soft" : "text-ink-mid"
                        )}
                    >
                        {p.title}
                    </button>
                ))}
            </div>
            {part != null ? (
                <div
                    data-brainstorm-review-body={part.id}
                    className="whitespace-pre-line rounded-[8px] bg-surface px-[14px] py-[10px] text-[13px] leading-[1.6] text-secondary"
                >
                    {part.body || partGist(f, part)}
                </div>
            ) : null}
            {said != null ? <SaidLine said={said} open /> : null}
            {part != null ? <PartMockups agentId={agent.id} s={s} f={f} part={part} /> : null}
        </section>
    );
}

// the builder's questions the user answered, each with the decisions its answer changed. Without the agent the
// decisions read as plain titles, since a link moves that agent's review cursor
export function AnsweredRail({ f, agent }: { f: BrainstormFile; agent?: AgentVM }) {
    const r = checkReview(f);
    const hv = handoffView(f);
    const line = answeredLine(hv.questions, hv.forYou, r.answered.length, hv.calls.length);
    return (
        <aside
            aria-label="The builder check"
            className={cn(
                BS_RAIL,
                "flex flex-col gap-[18px] overflow-y-auto border-l border-border bg-surface px-[24px] py-[22px] *:flex-none"
            )}
        >
            <div className="flex flex-col gap-[8px]">
                <h2 className="m-0 text-[15px] font-semibold text-primary">A builder read the design</h2>
                <p data-brainstorm-answered-line className="m-0 text-[13px] leading-[1.5] text-ink-mid">
                    {line.lead}
                    {line.answered != null ? <TickNumber value={line.answered} /> : null}
                    {line.rest}
                </p>
            </div>
            {r.answered.length > 0 ? (
                <section aria-label="You answered" className="flex flex-col">
                    {r.answered.map((y, i) => (
                        <div
                            key={i}
                            data-brainstorm-answered
                            className="flex flex-col gap-[6px] border-t border-edge-faint py-[10px]"
                        >
                            <span className="text-[12.5px] leading-[1.45] text-ink-mid">{y.q}</span>
                            <div className="flex items-start gap-[8px]">
                                <CheckMark />
                                <span className="text-[13.5px] font-semibold leading-[1.45] text-primary">{y.a}</span>
                            </div>
                            {y.changed.length > 0 ? (
                                <span className="pl-[21px] text-[11.5px] text-muted">
                                    Changed{" "}
                                    {y.changed.map((c, j) => (
                                        <Fragment key={c.id}>
                                            {j > 0 ? ", " : null}
                                            {agent != null ? (
                                                <button
                                                    type="button"
                                                    data-brainstorm-answered-link={c.id}
                                                    onClick={() => setReviewCursor(agent.id, c.id)}
                                                    className={cn(LINK, "border-0 bg-transparent p-0 text-[11.5px]")}
                                                >
                                                    {c.title}
                                                </button>
                                            ) : (
                                                c.title
                                            )}
                                        </Fragment>
                                    ))}
                                </span>
                            ) : null}
                        </div>
                    ))}
                </section>
            ) : null}
        </aside>
    );
}

// the review's own keys, in the hints footer's style (hints-footer.tsx), under the main area and the rail
export function ReviewHints() {
    return (
        <div
            data-brainstorm-review-hints
            aria-label="Keys"
            className="flex h-7 flex-none items-center gap-4 border-t border-edge-strong bg-modalbg px-4"
        >
            {REVIEW_KEYS.map(([glyph, label]) => (
                <span key={glyph} className="flex items-center gap-1.5 text-[12px] text-secondary">
                    <span className="rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px] text-primary">
                        {glyph}
                    </span>
                    {label}
                </span>
            ))}
        </div>
    );
}
