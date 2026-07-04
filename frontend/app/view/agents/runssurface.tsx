// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Runs view of a channel: run tabs (multiple runs per channel) + New run, a run header, and a
// vertical phase rail threading each phase's activity. Reads runs off the channel object (WOS-mirrored)
// and worker liveness off the live agent roster. Human decisions (approve/send-back/cancel/steer) call
// existing RPCs; phase completion arrives via the external hook. See runmodel.ts for all derivations.

import { fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { steerWorker } from "./channelactions";
import { AskRow, jumpToAgent, WorkerRow } from "./channelsprimitives";
import type { WorkerState } from "./jarvisderive";
import { approveGate, cancelRun, createRun, sendBackGate } from "./runactions";
import {
    currentPhaseIndex,
    defaultRunId,
    isTerminal,
    phaseStateView,
    phaseThread,
    phaseWorkers,
    runStatusView,
} from "./runmodel";
import { ProfilePanel } from "./profilepanel";

const TONE_CLASS: Record<string, string> = {
    planning: "text-muted",
    review: "text-asking",
    running: "text-success",
    blocked: "text-error",
    done: "text-success",
    failed: "text-error",
    cancelled: "text-muted",
};

// adapt a live roster row to the WorkerRow shape (oref is the tab: form used by WorkerRow's open-jump)
function toWorkerState(a: AgentVM): WorkerState {
    return { oref: `tab:${a.id}`, name: a.name, state: a.state, task: a.task, dispatchTask: undefined };
}

const PHASE_TONE_CLASS: Record<string, string> = {
    pending: "text-muted",
    running: "text-success",
    blocked: "text-error",
    done: "text-success",
    failed: "text-error",
    skipped: "text-muted",
};

function StatusPill({ status }: { status: string }) {
    const { label, tone } = runStatusView(status);
    return (
        <span className={"inline-flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.08em] " + (TONE_CLASS[tone] ?? "text-muted")}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {label}
        </span>
    );
}

function ReviewGateCard({ channelId, run, gateIdx }: { channelId: string; run: Run; gateIdx: number }) {
    const gatePhase = run.phases[gateIdx];
    const artifact = (gatePhase.artifacts ?? [])[0];
    return (
        <div className="mt-3 max-w-[760px] overflow-hidden rounded-[12px] border border-asking/40 bg-lane-asking">
            <div className="flex items-center gap-2 border-b border-asking/20 px-3.5 py-2.5">
                <span className="h-[7px] w-[7px] rounded-full bg-asking" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-asking">Review gate</span>
                <span className="flex-1 text-[11.5px] text-ink-mid">approve before execution starts</span>
                {artifact ? <span className="font-mono text-[10.5px] text-muted">{artifact}</span> : null}
            </div>
            <div className="flex items-center gap-2.5 px-3.5 py-3">
                <button
                    type="button"
                    onClick={() => fireAndForget(() => approveGate(channelId, run.id, gateIdx))}
                    className="rounded-[8px] bg-accent px-4 py-2 text-[12px] font-bold text-background hover:bg-accent/90"
                >
                    Approve & execute
                </button>
                <button
                    type="button"
                    disabled
                    title="Edit plan is coming in a later piece"
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary opacity-40"
                >
                    Edit plan
                </button>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => fireAndForget(() => sendBackGate(channelId, run.id, gateIdx))}
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary hover:border-asking hover:text-asking"
                >
                    Send back
                </button>
            </div>
        </div>
    );
}

function AskCard({ model, agent, kind }: { model: AgentsViewModel; agent: AgentVM; kind: "clarify" | "fork" }) {
    return (
        <div className="mt-3 max-w-[760px]">
            <div className="mb-1.5 flex items-center gap-2">
                <span className="h-[7px] w-[7px] rounded-full bg-asking" />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-asking">
                    {kind === "clarify" ? "Clarifying question" : "Escalated to you"}
                </span>
            </div>
            <AskRow model={model} agent={agent} />
        </div>
    );
}

function BlockedCard({ model, channelId, run, worker }: { model: AgentsViewModel; channelId: string; run: Run; worker?: AgentVM }) {
    return (
        <div className="relative mt-3 max-w-[760px] overflow-hidden rounded-[12px] border border-error/40 bg-error/10 px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[12px] font-bold text-error">!</span>
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-error">Blocked · worker exited</span>
            </div>
            <p className="mb-3 text-[12.5px] leading-[1.5] text-secondary">The worker for this phase is no longer running. Take control to inspect it, or cancel the run.</p>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    disabled
                    title="Re-dispatch is coming in a later piece"
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary opacity-40"
                >
                    Re-dispatch
                </button>
                {worker ? (
                    <button
                        type="button"
                        onClick={() => jumpToAgent(model, worker.id)}
                        className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary hover:border-edge-strong"
                    >
                        Take control
                    </button>
                ) : null}
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => fireAndForget(() => cancelRun(channelId, run.id))}
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-muted hover:border-error hover:text-error"
                >
                    Cancel run
                </button>
            </div>
        </div>
    );
}

function ShipMarker() {
    return (
        <div className="mt-2 inline-flex items-center gap-2 rounded-[9px] border border-success/30 bg-success/10 px-3 py-2">
            <span className="text-[12px] text-success">✓</span>
            <span className="text-[12px] font-semibold text-secondary">Done · all phases complete</span>
        </div>
    );
}

function CompactStepper({ run, expanded, onToggle }: { run: Run; expanded: boolean; onToggle: () => void }) {
    return (
        <div className="mb-4 flex items-center gap-3 rounded-[11px] border border-border bg-background px-3.5 py-2.5">
            <button type="button" onClick={onToggle} className="w-3.5 flex-none text-[11px] text-muted">
                {expanded ? "▾" : "▸"}
            </button>
            <span className="flex-none font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-muted">Playbook</span>
            <div className="relative flex flex-1 justify-between">
                {(run.phases ?? []).map((p, i) => {
                    const v = phaseStateView(p.state);
                    return (
                        <div key={i} className="flex flex-1 flex-col items-center gap-1.5 text-center">
                            <div className={"flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border border-current font-mono text-[8px] font-bold " + (PHASE_TONE_CLASS[v.tone] ?? "text-muted")}>
                                {v.icon}
                            </div>
                            <span className="whitespace-nowrap text-[9px] font-semibold text-secondary">{p.kind}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function PhaseRail({ model, run, agents, channelId }: { model: AgentsViewModel; run: Run; agents: AgentVM[]; channelId: string }) {
    const phases = run.phases ?? [];
    return (
        <div>
            {phases.map((p, i) => {
                const v = phaseStateView(p.state);
                const thread = phaseThread(run, i, agents);
                const workers = phaseWorkers(p, agents);
                const notLast = i < phases.length - 1;
                return (
                    <div key={i}>
                        {thread.showBoundary ? (
                            <div className="my-2 flex items-center gap-3">
                                <div className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--color-edge-mid)_0_5px,transparent_5px_10px)]" />
                                <span className="font-mono text-[9.5px] font-semibold text-muted">context cleared → fresh worker</span>
                                <div className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--color-edge-mid)_0_5px,transparent_5px_10px)]" />
                            </div>
                        ) : null}
                        <div className="flex gap-4">
                            <div className="flex w-9 flex-none flex-col items-center">
                                <div className={"flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-current font-mono text-[14px] font-bold " + (PHASE_TONE_CLASS[v.tone] ?? "text-muted")}>
                                    {v.icon}
                                </div>
                                {notLast ? <div className="my-1 min-h-[22px] w-0.5 flex-1 bg-edge-mid" /> : null}
                            </div>
                            <div className="min-w-0 flex-1 pb-4">
                                <div className="flex items-center gap-2">
                                    <span className="text-[14px] font-bold text-primary">{p.kind}</span>
                                    <span className={"font-mono text-[9px] font-semibold uppercase tracking-[.06em] " + (PHASE_TONE_CLASS[v.tone] ?? "text-muted")}>{v.label}</span>
                                </div>
                                {p.skill ? <div className="mt-0.5 font-mono text-[11px] text-muted">{p.skill}</div> : null}
                                {(p.artifacts ?? []).map((art) => (
                                    <div key={art} className="mt-2 inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-background px-2.5 py-1">
                                        <span className="text-[11px] text-muted">▸</span>
                                        <span className="font-mono text-[11px] text-secondary">{art}</span>
                                    </div>
                                ))}
                                {thread.showWorkers ? (
                                    <div className="mt-2.5 flex flex-col gap-1.5">
                                        {workers.map((w) => (
                                            <WorkerRow key={w.id} model={model} w={toWorkerState(w)} />
                                        ))}
                                    </div>
                                ) : null}
                                {thread.showGate ? <ReviewGateCard channelId={channelId} run={run} gateIdx={i} /> : null}
                                {thread.showAsk && thread.askAgent && thread.askKind ? (
                                    <AskCard model={model} agent={thread.askAgent} kind={thread.askKind} />
                                ) : null}
                                {thread.showBlocked ? (
                                    <BlockedCard model={model} channelId={channelId} run={run} worker={workers[0]} />
                                ) : null}
                                {thread.showShip ? <ShipMarker /> : null}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export function RunsView({ model, channel, agents }: { model: AgentsViewModel; channel: Channel; agents: AgentVM[] }) {
    const runs = channel.runs ?? [];
    const [activeRunId, setActiveRunId] = useState<string | undefined>(() => defaultRunId(runs));
    const [draft, setDraft] = useState("");
    const [expanded, setExpanded] = useState(true);

    // when the channel changes or runs first arrive, land on the channel's default run
    useEffect(() => {
        if (!activeRunId || !runs.some((r) => r.id === activeRunId)) {
            setActiveRunId(defaultRunId(runs));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channel.oid, runs.length]);

    const run = runs.find((r) => r.id === activeRunId);

    const startRun = () => {
        const goal = draft.trim();
        if (!goal) {
            return;
        }
        setDraft("");
        fireAndForget(async () => {
            const created = await createRun(channel.oid, goal);
            setActiveRunId(created.id);
        });
    };

    return (
        <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
            {/* run tabs */}
            <div className="sc flex flex-none gap-2 overflow-x-auto border-b border-border bg-background px-[22px] py-2.5">
                {runs.map((r) => {
                    const { tone } = runStatusView(r.status);
                    return (
                        <button
                            key={r.id}
                            type="button"
                            onClick={() => setActiveRunId(r.id)}
                            className={
                                "flex max-w-[230px] flex-none items-center gap-2 rounded-[9px] border px-3 py-2 " +
                                (r.id === activeRunId ? "border-accent/50 bg-accentbg/40" : "border-edge-mid hover:border-edge-strong")
                            }
                        >
                            <span className={"h-[7px] w-[7px] flex-none rounded-full bg-current " + (TONE_CLASS[tone] ?? "text-muted")} />
                            <span className="truncate text-[12px] font-semibold text-primary">{r.goal}</span>
                        </button>
                    );
                })}
                <button
                    type="button"
                    onClick={() => setActiveRunId(undefined)}
                    className="flex-none rounded-[9px] border border-dashed border-edge-mid px-3 py-2 text-[12px] font-semibold text-muted hover:text-secondary"
                >
                    + New run
                </button>
            </div>

            <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                <div>
                    {run ? (
                        <>
                            {/* run header */}
                            <div className="mb-4 flex items-start gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="mb-1.5">
                                        <StatusPill status={run.status} />
                                    </div>
                                    <div className="text-[19px] font-bold leading-tight tracking-[-0.01em] text-primary">{run.goal}</div>
                                </div>
                                <div className="flex flex-none gap-1.5">
                                    <button
                                        type="button"
                                        disabled={isTerminal(run.status)}
                                        onClick={() => {
                                            const idx = currentPhaseIndex(run);
                                            const worker = phaseWorkers(run.phases[idx], agents)[0];
                                            if (!worker) {
                                                return;
                                            }
                                            const text = window.prompt(`Steer ${worker.name}:`);
                                            if (text) {
                                                fireAndForget(() =>
                                                    steerWorker({ channelId: channel.oid, workerORef: `tab:${worker.id}`, agents, text })
                                                );
                                            }
                                        }}
                                        className="rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:border-edge-strong disabled:opacity-40"
                                    >
                                        Steer
                                    </button>
                                    <button
                                        type="button"
                                        disabled
                                        title="Pause is coming in a later piece"
                                        className="rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[11.5px] font-semibold text-secondary opacity-40"
                                    >
                                        Pause
                                    </button>
                                </div>
                            </div>

                            <CompactStepper run={run} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
                            {expanded ? (
                                <PhaseRail model={model} run={run} agents={agents} channelId={channel.oid} />
                            ) : null}

                            {!isTerminal(run.status) ? (
                                <button
                                    type="button"
                                    onClick={() => fireAndForget(() => cancelRun(channel.oid, run.id))}
                                    className="mt-4 rounded-[8px] border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-muted hover:border-error hover:text-error"
                                >
                                    Cancel run
                                </button>
                            ) : null}
                        </>
                    ) : (
                        <div className="mt-10 text-center text-[13px] text-muted">
                            {runs.length === 0 ? "No runs yet." : "Select a run above, or start a new one."} Give Jarvis a goal below to start one.
                        </div>
                    )}
                </div>
            </div>

            {/* start-run composer — mirrors the chat Composer's shell so the two feel like one system */}
            <div className="flex-none px-6 pb-[18px] pt-2">
                <div className="rounded-[12px] border border-edge-mid bg-surface-raised px-[15px] py-3">
                    <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                startRun();
                            }
                        }}
                        placeholder="Give Jarvis a goal to start a run…"
                        className="w-full bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none"
                    />
                    <div className="mt-2.5 flex items-center gap-2.5">
                        <span className="font-mono text-[11.5px] text-ink-mid">playbook · Superpowers default</span>
                        <div className="flex-1" />
                        <button
                            type="button"
                            onClick={startRun}
                            className="shrink-0 cursor-pointer rounded-[8px] bg-accent px-[15px] py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-50"
                        >
                            Start run ⏎
                        </button>
                    </div>
                </div>
            </div>
            </div>
            <ProfilePanel channelId={channel.oid} />
        </div>
    );
}
