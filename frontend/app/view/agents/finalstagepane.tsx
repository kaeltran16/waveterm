// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent surface's middle pane while the final stage's own row is focused: the stage has no session yet, so
// where a terminal would be it shows the pipeline, the running command with its output tail, and what an ended
// stage came to. A click on a step that ended shows the output it kept.

import { errorNudge, viewFade } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { MotionConfig, motion, type Variants } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { dockButtonClass } from "./endfinalform";
import { finalFailedNote, shownStep, type FinalStepKey } from "./finalstage";
import {
    EndFinalStage,
    FinalKeptOutput,
    FinalOutcome,
    FinalOutput,
    FinalShotsLink,
    FinalStepCells,
    RerunFinalStage,
    useFinalStageView,
} from "./finalstageviews";
import { leadAgentOf, stageLabel, verifierStepTarget, type RunInfo } from "./runlineage";
import { FINAL_FILL } from "./runstrip";

// the states a stage ends in without failing: a rerun the human asked for is answered by one of these or by failed
const ENDED_CLEAN = new Set(["passed", "unverified"]);

type BodyView = "running" | "kept" | "outcome";

export function FinalStagePane({ model, run }: { model: AgentsViewModel; run: RunInfo }) {
    const now = useAtomValue(model.nowAtom);
    const view = useFinalStageView(run.dag, run.runId, run.channelId, now);
    const agents = useAtomValue(model.agentsAtom);
    const lead = leadAgentOf(useAtomValue(model.lineageAtom), agents, run.runId);
    const [picked, setPicked] = useState<FinalStepKey | null>(null);
    // the verifier's transcript is its output, so its step opens that session instead of the output panel
    const verifierTarget = verifierStepTarget(run, agents);
    const onPick = (key: FinalStepKey) => {
        if (key === "verifier" && verifierTarget != null) {
            globalStore.set(model.focusIdAtom, verifierTarget);
            return;
        }
        setPicked(picked === key ? null : key);
    };
    // with no output yet (Tree, or a command's first seconds) the step list stands alone
    const shown = shownStep(view, picked);
    const outputRef = useRef<HTMLDivElement>(null);
    // a tail is read from its end, so each publish keeps the newest lines in view
    useEffect(() => {
        outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
    }, [view.output]);
    // the body swaps views with a fade, but not on mount: focusing the stage's row is not a change in it
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
    }, []);
    const body: BodyView = shown?.state === "running" ? "running" : shown?.kept ? "kept" : "outcome";
    // the failed note's moment, picked on the render the stage turns failed: a nudge when it answers the human's
    // own rerun ("your action failed, here"), else a fade. Cleared once played, so a remount never replays it.
    const [rerunAsked, setRerunAsked] = useState(false);
    const [stage, setStage] = useState<{ state: string; note: Variants | null }>({ state: view.state, note: null });
    if (stage.state !== view.state) {
        const failedNow = view.state === "failed";
        setStage({ state: view.state, note: failedNow ? (rerunAsked ? errorNudge : viewFade) : null });
        if (failedNow || ENDED_CLEAN.has(view.state)) {
            setRerunAsked(false);
        }
    }

    return (
        <div data-final-pane className="flex min-h-0 flex-1 flex-col bg-background">
            {/* not clipped: the end form opens under its button */}
            {/* wraps rather than truncate: the headline's end is the outcome ("failed at Final") */}
            <div className="flex flex-none flex-wrap items-center gap-x-[10px] gap-y-[6px] border-b border-border px-[22px] py-[12px]">
                <span
                    aria-hidden
                    className={cn(
                        "h-[7px] w-[7px] flex-none rounded-full",
                        view.tone === "wait" ? "border border-muted" : FINAL_FILL[view.tone]
                    )}
                />
                <span className="flex-none text-[13px] font-semibold text-foreground">{stageLabel("verifier")}</span>
                <span data-final-headline className="min-w-0 flex-1 font-mono text-[10.5px] text-ink-mid">
                    {view.headline}
                </span>
                <EndFinalStage group={run.dag} channelId={run.channelId} runId={run.runId} />
                <RerunFinalStage
                    group={run.dag}
                    channelId={run.channelId}
                    runId={run.runId}
                    className={dockButtonClass()}
                    onRerun={() => setRerunAsked(true)}
                />
            </div>
            {view.steps.length > 0 ? (
                <div className="flex-none border-b border-edge-faint px-[22px] py-[12px]">
                    <FinalStepCells
                        steps={view.steps}
                        shown={shown?.key}
                        onPick={onPick}
                        opensVerifier={verifierTarget != null}
                    />
                </div>
            ) : null}
            <MotionConfig reducedMotion="user">
                <motion.div
                    key={body === "kept" ? `kept:${shown?.key}` : body}
                    data-final-pane-view={body}
                    variants={viewFade}
                    initial={mounted.current ? "initial" : false}
                    animate="animate"
                    className="flex min-h-0 flex-1 flex-col gap-[10px] px-[22px] py-[14px]"
                >
                    {body === "running" ? (
                        <>
                            <span className="flex-none break-all font-mono text-[12px] text-ink-hi">
                                $ {shown.command}
                            </span>
                            <div ref={outputRef} className="sc min-h-0 flex-1 overflow-y-auto">
                                <FinalOutput output={view.output} />
                            </div>
                            <span className="flex-none font-mono text-[10.5px] text-muted">
                                output tail · the engine publishes it every 10s
                            </span>
                        </>
                    ) : body === "kept" ? (
                        <>
                            <span className="flex-none break-all font-mono text-[12px] text-ink-hi">
                                $ {shown.command}
                            </span>
                            <div className="sc min-h-0 flex-1 overflow-auto">
                                <FinalKeptOutput key={shown.key} kept={shown.kept} />
                            </div>
                            <span className="flex-none font-mono text-[10.5px] text-muted">
                                {shown.label} {shown.text} · click it again to close
                            </span>
                        </>
                    ) : (
                        <>
                            {run.dag ? <FinalOutcome view={view} group={run.dag} /> : null}
                            {view.state === "failed" ? (
                                <motion.span
                                    data-final-note
                                    variants={stage.note ?? viewFade}
                                    initial={stage.note ? "initial" : false}
                                    animate="animate"
                                    onAnimationComplete={() => setStage((s) => (s.note ? { ...s, note: null } : s))}
                                    className="flex-none text-[12px] text-muted"
                                >
                                    {finalFailedNote(lead ? { asking: lead.state === "asking" } : undefined)}
                                </motion.span>
                            ) : null}
                            <FinalShotsLink group={run.dag} />
                        </>
                    )}
                </motion.div>
            </MotionConfig>
        </div>
    );
}
