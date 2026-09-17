// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The details rail's run sections: Run for a lead (status, the questions on the run, lanes, the newest
// timeline rows) and Task for a worker (its lead, lane, dependencies, attempt and question). A question the
// lead holds can be taken over; one the human holds is answered in place.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { openTarget } from "@/app/view/jarvis/openref";
import { digestStale, formatElapsed, healthView, nextStepView, taskBriefs } from "@/app/view/orchestrate/dagdigest";
import { openDagLive, openDagTask } from "@/app/view/orchestrate/dagmodalstate";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { canSubmitAsk } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { ASK_OWNER_USER, childAskAgent, childAskKey, childAskSent } from "./childaskmodel";
import {
    bindChildAsks,
    childAskErrorAtom,
    childAskSelAtom,
    childAskSentAtom,
    childAskTextAtom,
    childAsksAtom,
    setChildAnswerText,
    submitChildAnswer,
    takeOverChildAsk,
    toggleChildAnswer,
} from "./childaskstore";
import { useRunEvents } from "./runeventstore";
import { formatLeft, leadAgentOf, runProgress, taskAgentOf, type RunInfo } from "./runlineage";
import { laneRows, questionOrder, runElapsedMs, runLog, taskFacts, type LaneDot } from "./runrail";
import { tsLabel } from "./runtimeline";

const LANE_DOT: Record<LaneDot, string> = {
    done: "bg-success",
    working: "bg-accent animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none",
    asking: "bg-warning animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none",
    pending: "border border-muted bg-transparent",
    failed: "bg-error",
    muted: "bg-muted",
};

const LINK =
    "-ml-[6px] w-fit cursor-pointer rounded-[7px] px-[6px] py-[3px] font-mono text-[10.5px] font-semibold text-accent-soft hover:bg-surface-hover";

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-ink-mid">{children}</h3>;
}

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline gap-[12px] border-b border-edge-faint py-[5px] last:border-b-0">
            <span className="flex-none text-[12.5px] text-muted">{label}</span>
            <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] font-medium text-secondary">
                {children}
            </span>
        </div>
    );
}

// openRunDag lands on the run's Brief sheet, where the DAG modal lives, with the modal open on the run or
// one of its tasks.
function openRunDag(model: AgentsViewModel, run: RunInfo, taskId?: string) {
    const dag = run.dag;
    if (dag == null) {
        return;
    }
    void openTarget(model, { kind: "channel", channelId: run.channelId, runId: run.runId }).then((res) => {
        if ("reason" in res) {
            return;
        }
        const dagOref = WOS.makeORef("dag", dag.oid);
        if (taskId) {
            openDagTask(run.channelId, run.runId, dagOref, taskId);
        } else {
            openDagLive(run.channelId, run.runId, dagOref);
        }
    });
}

function useRunAsks(run: RunInfo): DagAskItem[] {
    useEffect(() => {
        bindChildAsks(run.channelId, run.runId);
    }, [run.channelId, run.runId]);
    return questionOrder(useAtomValue(childAsksAtom)[run.runId] ?? []);
}

function QuestionCard({ model, run, ask }: { model: AgentsViewModel; run: RunInfo; ask: DagAskItem }) {
    const now = useAtomValue(model.nowAtom);
    const events = useRunEvents(run.runId, run.channelId);
    const key = childAskKey(ask);
    const selections = useAtomValue(childAskSelAtom)[key] ?? {};
    const texts = useAtomValue(childAskTextAtom)[key] ?? {};
    const sentTs = useAtomValue(childAskSentAtom)[key];
    const error = useAtomValue(childAskErrorAtom)[key];
    const [activeQuestion, setActiveQuestion] = useState(0);
    const yours = ask.owner === ASK_OWNER_USER;
    const first = ask.questions[0];

    const meta = (
        <div className="flex items-center gap-[7px] overflow-hidden whitespace-nowrap font-mono text-[10.5px] text-muted">
            <span className="h-[7px] w-[7px] flex-none animate-[pulseDot_1.6s_infinite] rounded-full bg-warning motion-reduce:animate-none" />
            <b className="font-semibold text-primary">{ask.taskid}</b>
            <span className={cn("truncate", yours && "text-warning")}>
                {yours
                    ? "waiting on you"
                    : ask.deadline
                      ? `lead is answering · ${formatLeft(Math.max(0, ask.deadline - now))}`
                      : "lead is answering"}
            </span>
        </div>
    );
    const errorLine = error ? <div className="mt-[6px] text-[11px] text-warning">{error}</div> : null;

    if (!yours) {
        return (
            <div className="rounded-[9px] border border-edge-mid bg-surface-raised px-[11px] py-[9px]">
                {meta}
                {first?.header ? (
                    <span className="mt-[6px] inline-block font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-muted">
                        {first.header}
                    </span>
                ) : null}
                <div className="mt-[2px] text-[12.5px] leading-[1.45] text-primary">{first?.question}</div>
                {ask.questions.length > 1 ? (
                    <div className="mt-[2px] font-mono text-[10.5px] text-muted">+{ask.questions.length - 1} more</div>
                ) : null}
                {errorLine}
                <div className="mt-[7px] flex justify-end">
                    <button
                        type="button"
                        onClick={() => takeOverChildAsk(run.channelId, run.runId, ask)}
                        title="Answer it yourself; the lead leaves it to you"
                        className="cursor-pointer whitespace-nowrap rounded-[7px] border border-edge-mid bg-surface px-[9px] py-[3px] font-mono text-[10.5px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
                    >
                        Take over
                    </button>
                </div>
            </div>
        );
    }

    const agent = childAskAgent(ask);
    const answered = childAskSent(sentTs, ask, events);
    const ready = canSubmitAsk(agent.ask?.questions ?? [], selections, texts);
    return (
        <div className="rounded-[9px] border border-warning/45 bg-warning/[0.06] px-[11px] py-[9px]">
            {meta}
            <AnswerBar
                agent={agent}
                selections={selections}
                texts={texts}
                sent={answered}
                showHint={false}
                activeQuestion={activeQuestion}
                onSelectQuestion={setActiveQuestion}
                onToggle={(qi, oi) => toggleChildAnswer(ask, qi, oi)}
                onText={(qi, value) => setChildAnswerText(ask, qi, value)}
                onSubmit={() => submitChildAnswer(run.channelId, run.runId, ask)}
            />
            {errorLine}
            {answered ? null : (
                <button
                    type="button"
                    disabled={!ready}
                    onClick={() => submitChildAnswer(run.channelId, run.runId, ask)}
                    className="mt-[8px] cursor-pointer rounded-[7px] bg-accent px-[12px] py-[5px] font-mono text-[10.5px] font-semibold text-background disabled:cursor-not-allowed disabled:opacity-40"
                >
                    Send answer
                </button>
            )}
        </div>
    );
}

function Lanes({ model, run }: { model: AgentsViewModel; run: RunInfo }) {
    const now = useAtomValue(model.nowAtom);
    const agents = useAtomValue(model.agentsAtom);
    const lineage = useAtomValue(model.lineageAtom);
    const focusId = useAtomValue(model.focusIdAtom);
    const rows = laneRows(run.dag, run.digest, now);
    if (rows.length === 0) {
        return null;
    }
    return (
        <div className="mt-[2px] flex flex-col gap-px">
            {rows.map((r) => {
                const agent = taskAgentOf(lineage, agents, run.runId, r.taskId);
                return (
                    <div
                        key={r.key}
                        onClick={agent ? () => globalStore.set(model.focusIdAtom, agent.id) : undefined}
                        className={cn(
                            "flex items-center gap-[6px] overflow-hidden whitespace-nowrap rounded-[6px] px-[5px] py-[4px] font-mono text-[11.5px] text-secondary",
                            agent && "cursor-pointer hover:bg-surface-hover",
                            agent != null && agent.id === focusId && "bg-surface-selected"
                        )}
                    >
                        <span className="w-[12px] flex-none font-semibold text-muted">{r.key}</span>
                        {r.dots.map((d, i) => (
                            <span key={i} className="contents">
                                {i > 0 ? <span className="text-ink-faint">→</span> : null}
                                <span className={cn("h-[7px] w-[7px] flex-none rounded-full", LANE_DOT[d])} />
                            </span>
                        ))}
                        <span className="min-w-0 truncate">{r.name}</span>
                        <span className="ml-auto pl-[6px] text-[10.5px] text-muted">{r.meta}</span>
                    </div>
                );
            })}
        </div>
    );
}

export function RunSection({ model, run }: { model: AgentsViewModel; run: RunInfo }) {
    const now = useAtomValue(model.nowAtom);
    const events = useRunEvents(run.runId, run.channelId);
    const asks = useRunAsks(run);
    const digest = run.digest;
    const { done, total } = runProgress(run.dag);
    const state = { digest, loading: digest == null, stale: digestStale(digest, run.dag?.version) };
    const health = healthView(state);
    const next = nextStepView(state, taskBriefs(run.dag));
    const finished = !state.stale && digest?.health === "done";
    const report = digest?.report;
    const lanes = digest?.shape?.lanes;
    const elapsed = runElapsedMs(run.dag, digest, now);
    const log = runLog(events);

    return (
        <div className="flex flex-col gap-[10px]">
            <div className="flex items-baseline justify-between gap-[8px]">
                <SectionLabel>Run</SectionLabel>
                {run.dag ? (
                    <span className="whitespace-nowrap font-mono text-[11px] font-semibold text-muted">
                        {done}/{total}
                        {elapsed ? ` · ${formatElapsed(elapsed)}` : ""}
                    </span>
                ) : null}
            </div>
            {run.dag == null ? (
                <div className="font-mono text-[11px] text-muted">planning · no plan submitted yet</div>
            ) : (
                <div>
                    <div>
                        <span
                            className={cn("font-mono text-[12px] font-bold", finished ? "text-success" : health.tone)}
                        >
                            {finished ? "✓ " : ""}
                            {health.text.replace(/-/g, " ")}
                        </span>
                        {lanes ? (
                            <span className="font-mono text-[11px] text-muted">
                                {" "}
                                · {lanes} {lanes === 1 ? "lane" : "lanes"} ·{" "}
                                {report?.unverified ? "unverified" : "verified"}
                            </span>
                        ) : null}
                    </div>
                    {next && !finished ? (
                        <div className="mt-[2px] font-mono text-[11px] text-muted">next: {next}</div>
                    ) : null}
                    {finished && report ? (
                        <div className="mt-[10px]">
                            <FactRow label="Landed">
                                {report.commits?.length ?? 0} {report.commits?.length === 1 ? "commit" : "commits"}
                            </FactRow>
                            {elapsed ? <FactRow label="Elapsed">{formatElapsed(elapsed)}</FactRow> : null}
                            <FactRow label="Worker time">{formatElapsed(report.workerms)}</FactRow>
                            <FactRow label="Answered">{report.answered}</FactRow>
                            <FactRow label="Forwarded">{report.forwarded}</FactRow>
                        </div>
                    ) : null}
                </div>
            )}
            {asks.map((a) => (
                <QuestionCard key={childAskKey(a)} model={model} run={run} ask={a} />
            ))}
            <Lanes model={model} run={run} />
            {log.length > 0 ? (
                <div className="flex flex-col gap-[3px]">
                    {log.map((l) => (
                        <div key={l.id} className="flex gap-[9px] font-mono text-[11px] leading-[1.45] text-secondary">
                            <span className="flex-none text-muted">{tsLabel(l.ts)}</span>
                            <span className="min-w-0">{l.text}</span>
                        </div>
                    ))}
                </div>
            ) : null}
            {run.dag ? (
                <button type="button" onClick={() => openRunDag(model, run)} className={LINK}>
                    timeline ↗
                </button>
            ) : null}
        </div>
    );
}

export function TaskSection({ model, run, taskId }: { model: AgentsViewModel; run: RunInfo; taskId: string }) {
    const now = useAtomValue(model.nowAtom);
    const agents = useAtomValue(model.agentsAtom);
    const lineage = useAtomValue(model.lineageAtom);
    const ask = useRunAsks(run).find((a) => a.taskid === taskId);
    const facts = taskFacts(run.dag, run.digest, taskId, now);
    const lead = leadAgentOf(lineage, agents, run.runId);

    return (
        <div className="flex flex-col gap-[8px]">
            <div className="flex items-baseline justify-between gap-[8px]">
                <SectionLabel>Task</SectionLabel>
                <button type="button" onClick={() => openRunDag(model, run, taskId)} className={cn(LINK, "ml-0")}>
                    plan · Task {taskId.replace(/^t-/, "")} ↗
                </button>
            </div>
            <div>
                <FactRow label="Lead">
                    {lead ? (
                        <button
                            type="button"
                            onClick={() => globalStore.set(model.focusIdAtom, lead.id)}
                            className="cursor-pointer text-accent-soft hover:underline"
                        >
                            ↑ {lead.name}
                        </button>
                    ) : (
                        `↑ ${run.title}`
                    )}
                </FactRow>
                {facts?.laneText ? <FactRow label="Lane">{facts.laneText}</FactRow> : null}
                {facts ? <FactRow label="Depends on">{facts.depends}</FactRow> : null}
                {facts ? (
                    <FactRow label={facts.resultLabel}>
                        <span className={facts.landed ? "text-success" : undefined}>{facts.result}</span>
                    </FactRow>
                ) : null}
            </div>
            {ask ? <QuestionCard model={model} run={run} ask={ask} /> : null}
        </div>
    );
}
