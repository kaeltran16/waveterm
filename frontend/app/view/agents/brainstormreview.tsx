// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The builder check's review of what it changed, the rail of the builder's answered questions beside it, and the
// review's key hints.

import { cn } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { handoffView, orderedParts, partTitle, type BrainstormFile } from "./brainstormmodel";
import type { BrainstormState } from "./brainstormstore";
import { CheckMark, DesignHead, LINK, SECTION_HEAD, SMALL_DOT } from "./brainstormui";

export function CheckReview({
    s,
    f,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [all, setAll] = useState(false);
    const hv = handoffView(f);
    const parts = all ? orderedParts(f) : hv.touched;
    const cursor = s.review.cursor;
    useEffect(() => {
        if (cursor != null) {
            scrollRef.current
                ?.querySelector(`[data-brainstorm-part="${CSS.escape(cursor)}"]`)
                ?.scrollIntoView({ block: "start", behavior: "smooth" });
        }
    }, [cursor]);
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

// the builder's questions the user answered, each with what its answer went into
export function AnsweredRail({ f }: { f: BrainstormFile }) {
    const hv = handoffView(f);
    return (
        <aside
            aria-label="What the builder asked"
            className="flex w-[460px] flex-none flex-col gap-[10px] overflow-y-auto border-l border-border bg-surface p-[20px] *:flex-none"
        >
            <h2 className="m-0 text-[15px] font-semibold text-primary">A builder read the design</h2>
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
                    {y.q ? <div className="text-[13.5px] font-semibold leading-[1.5] text-primary">{y.q}</div> : null}
                    {y.why ? <div className="text-[12px] leading-[1.5] text-muted">Why: {y.why}</div> : null}
                    <div className="flex items-start gap-[8px] pt-[2px]">
                        <CheckMark />
                        <span className="text-[13.5px] leading-[1.5] text-ink-hi">
                            {y.a}
                            {y.into != null ? ` Added to ${y.into.map((id) => partTitle(f, id)).join(", ")}.` : null}
                        </span>
                    </div>
                </div>
            ))}
        </aside>
    );
}

export function ReviewHints() {
    return null;
}
