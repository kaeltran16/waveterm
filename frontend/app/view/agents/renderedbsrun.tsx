// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The run card and the gone card, in the Rendered transcript. The run card is the brainstorm's Run step as one card
// under the transcript (where the run stands, Close the brainstorm once it merged with its final check passed); the
// gone card says why no brainstorm is drawn, and a brainstorm Arc closed is a row.

import { DrawCheck } from "@/app/element/drawcheck";
import { ViewSwap } from "@/app/element/viewswap";
import { openTarget } from "@/app/view/jarvis/openref";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, Lightbulb } from "lucide-react";
import type { JSX } from "react";
import type { AgentVM } from "./agentsviewmodel";
import { closeBrainstorm } from "./brainstormrun";
import { closeTargets, type RunStepState } from "./brainstormrunmodel";
import { openBrainstormAt, type BrainstormState } from "./brainstormstore";
import { DOT, ErrorLine, useAction } from "./brainstormui";
import { CANVAS_PRIMARY_BTN } from "./canvaspane";
import { CardFrame } from "./renderedbrainstorm";
import type { CardProps } from "./renderedbrainstormmodel";
import { brainstormClosedAtom, goneView, runCardView } from "./renderedbsrunmodel";
import { useRunInfo } from "./runlineagestore";

const STATE_DOT: Partial<Record<RunStepState, string>> = {
    "final-failed": "bg-error",
    held: "bg-error",
    cancelled: "bg-error",
    missing: "bg-error",
    unverified: "bg-warning",
    loading: "bg-muted",
};

const HEAD_LINK = "min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-ink-mid hover:underline";

function CloseButton({
    agentId,
    s,
    canvas,
    runId,
    compact,
}: {
    agentId: string;
    s: BrainstormState;
    canvas: string | undefined;
    runId: string;
    compact: boolean;
}) {
    const act = useAction();
    const targets = closeTargets(s.cwd, s.topic, canvas);
    const refusal = "reason" in targets ? targets.reason : null;
    return (
        <div className={cn("flex flex-none flex-col gap-1.5", compact ? "items-start pt-1" : "max-w-[45%] items-end")}>
            <button
                type="button"
                data-rendered-bs-close
                disabled={refusal != null || act.busy}
                onClick={() => void act.run(() => closeBrainstorm(agentId, runId))}
                className={CANVAS_PRIMARY_BTN}
            >
                Close the brainstorm
            </button>
            <ErrorLine
                error={refusal ?? act.error}
                className={compact ? undefined : "text-right"}
                attrs={{ "data-rendered-bs-close-error": "" }}
            />
        </div>
    );
}

export function RunCard({ model, agent, s, f, compact }: CardProps): JSX.Element | null {
    const runId = f.run;
    const { run, loaded } = useRunInfo(runId ?? null);
    if (runId == null) {
        return null;
    }
    const v = runCardView(runId, run, loaded, s.topic, f.canvas);
    const state = v.view.state;
    const merged = v.view.merged;
    const open = v.showOpen ? (
        <button
            type="button"
            data-rendered-bs-open-run
            onClick={() => void openTarget(model, { kind: "run", runId })}
            className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline"
        >
            Open run
            <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
        </button>
    ) : (
        false
    );
    const head = (
        <button
            type="button"
            data-rendered-bs-topic
            title="Open the brainstorm"
            onClick={() => openBrainstormAt(agent.id, {})}
            className={HEAD_LINK}
        >
            {s.topic}
        </button>
    );
    return (
        <CardFrame
            agent={agent}
            s={s}
            f={f}
            asking={false}
            head={head}
            status={v.status}
            open={open}
            compact={compact}
            attr="data-rendered-bs-run"
        >
            <div data-rendered-bs-run-state={state} className="flex items-start gap-3">
                {/* outside the swap, so the check draws when the run merges rather than mounting drawn */}
                <span className="mt-[5px] flex flex-none">
                    {state !== "loading" ? (
                        <DrawCheck done={merged} className="mt-px h-[13px] w-[13px] text-success" />
                    ) : null}
                    {!merged ? (
                        <span data-rendered-bs-run-dot className={cn(DOT, STATE_DOT[state] ?? "bg-accent")} />
                    ) : null}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <ViewSwap swapKey={state} className="flex flex-col gap-1">
                        <span
                            data-rendered-bs-run-headline
                            className={cn("font-semibold text-primary", compact ? "text-[14px]" : "text-[15px]")}
                        >
                            {v.headline}
                        </span>
                        {v.detail ? (
                            <span
                                data-rendered-bs-run-detail
                                className={cn("leading-[1.55] text-ink-mid", compact ? "text-[12.5px]" : "text-[13px]")}
                            >
                                {v.detail}
                            </span>
                        ) : null}
                    </ViewSwap>
                    {compact && v.canClose ? (
                        <CloseButton agentId={agent.id} s={s} canvas={f.canvas} runId={runId} compact />
                    ) : null}
                </div>
                {!compact && v.canClose ? (
                    <CloseButton agentId={agent.id} s={s} canvas={f.canvas} runId={runId} compact={false} />
                ) : null}
            </div>
        </CardFrame>
    );
}

const GONE_CARD = "flex flex-col rounded-[10px] border border-edge-mid bg-surface";

export function GoneCard({
    s,
    why,
    compact,
}: {
    agent: AgentVM;
    s: BrainstormState;
    why: "unreadable" | "removed";
    compact: boolean;
}): JSX.Element | null {
    const closed = useAtomValue(brainstormClosedAtom);
    const v = goneView(why, s, closed);
    const pad = compact ? "gap-1.5 px-[14px] py-3" : "gap-1.5 px-[18px] py-[14px]";
    const body = (text: string) => (
        <span
            className={cn(
                "leading-[1.5] text-secondary [overflow-wrap:anywhere]",
                compact ? "text-[12.5px]" : "text-[13px]"
            )}
        >
            {text}
        </span>
    );
    return (
        <ViewSwap swapKey={v.kind}>
            {v.kind === "closed" ? (
                <div
                    data-rendered-bs-gone="closed"
                    className={cn(
                        "flex min-w-0 items-center justify-center gap-2 py-0.5 text-muted",
                        compact ? "text-[12px]" : "text-[12.5px]"
                    )}
                >
                    <Lightbulb size={13} strokeWidth={2} className="shrink-0" aria-hidden />
                    <span className="min-w-0">{v.text}</span>
                </div>
            ) : v.kind === "unreadable" ? (
                <div data-rendered-bs-gone="unreadable" className={cn(GONE_CARD, pad)}>
                    <span className="flex items-center gap-2 text-[13.5px] font-semibold text-primary">
                        <span className={cn(DOT, "bg-error")} />
                        {v.title}
                    </span>
                    {body(v.error)}
                    <span className="break-all font-mono text-[11.5px] text-muted">{v.path}</span>
                </div>
            ) : (
                <div data-rendered-bs-gone="removed" className={cn(GONE_CARD, pad)}>
                    <span className="text-[13.5px] font-semibold text-primary [overflow-wrap:anywhere]">{v.title}</span>
                    {body(v.text)}
                </div>
            )}
        </ViewSwap>
    );
}
