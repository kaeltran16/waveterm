// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Runs view of a channel: run tabs (multiple runs per channel) + New run, a run header, and a
// vertical phase rail threading each phase's activity. Reads runs off the channel object (WOS-mirrored)
// and worker liveness off the live agent roster. Human decisions (approve/send-back/cancel/steer) call
// existing RPCs; phase completion arrives via the external hook. See runmodel.ts for all derivations.

import { useSettle } from "@/app/element/motionhooks";
import { cardVariants, computeEntrances, initialEntranceState } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString, fireAndForget, stringToBase64 } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { streamableTranscriptAgents, type AgentVM } from "./agentsviewmodel";
import { steerWorker } from "./channelactions";
import { AskRow, jumpToAgent } from "./channelsprimitives";
import { AttentionCard, AttentionBanner } from "./attentioncard";
import { ComposerShell } from "./composer-shell";
import { startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { MarkdownMessage } from "./markdownmessage";
import { PhaseHistory, RunRollup, RunWorkerCard } from "./runworkercard";
import { approveGate, cancelRun, createRun, sendBackGate } from "./runactions";
import {
    composerSummary,
    currentPhaseIndex,
    defaultRunId,
    isOrchestrator,
    isTerminal,
    leadWorker,
    planDirty,
    phaseProgressDots,
    phaseRailIds,
    phaseStateView,
    phaseThread,
    phaseWorkers,
    recordedWorkerTabs,
    resolveActiveRunId,
    resolveArtifactPath,
    runStatusView,
    steerTarget,
} from "./runmodel";
import { ProfilePanel } from "./profilepanel";
import { sessionSidebarViewModelAtom } from "./session-models/sessionsidebarmodel";
import { flattenVisualOrder } from "./session-models/sessionviewmodel";
import type { SubagentState } from "./session-models/sessionviewmodel";
import { focusSubagentAtom, subagentsByIdAtom } from "./subagentsstore";
import { useSubagentTracking } from "./subagenttracking";

const TONE_CLASS: Record<string, string> = {
    planning: "text-muted",
    review: "text-asking",
    running: "text-success",
    blocked: "text-error",
    done: "text-success",
    failed: "text-error",
    cancelled: "text-muted",
};

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

// Above this many lines, the plan preview starts collapsed (with a line-count hint) so a long plan
// (plans run to ~2000 lines) doesn't render its whole DOM eagerly on every gate — you expand on
// demand. Small plans stay open. The read itself is unbounded up to wshfs's 32MB transfer limit.
const PLAN_PREVIEW_COLLAPSE_LINES = 400;

// The plan document being approved, read from the gated phase's artifact and rendered inline so you
// can review it without leaving Runs. Read-only and non-blocking: a missing/unreadable file shows a
// subtle line and never disables the gate's actions. One read per gate (only one gate is ever live).
function PlanPreview({ path, onEditorReady }: { path: string; onEditorReady?: (flush: () => Promise<void>) => void }) {
    const [load, setLoad] = useState<{ status: "loading" | "error" | "ok"; text: string; lines: number }>({
        status: "loading",
        text: "",
        lines: 0,
    });
    const [override, setOverride] = useState<boolean | null>(null); // user's explicit collapse toggle; null = auto
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [saveErr, setSaveErr] = useState(false);

    useEffect(() => {
        let alive = true;
        setLoad({ status: "loading", text: "", lines: 0 });
        setOverride(null);
        setEditing(false);
        setSaveErr(false);
        fireAndForget(async () => {
            try {
                const fileData = await RpcApi.FileReadCommand(TabRpcClient, { info: { path } });
                const text = fileData?.data64 ? base64ToString(fileData.data64) : "";
                if (alive) {
                    setLoad(
                        text.trim()
                            ? { status: "ok", text, lines: text.split("\n").length }
                            : { status: "error", text: "", lines: 0 }
                    );
                }
            } catch {
                if (alive) {
                    setLoad({ status: "error", text: "", lines: 0 });
                }
            }
        });
        return () => {
            alive = false;
        };
    }, [path]);

    const save = async () => {
        try {
            await RpcApi.FileWriteCommand(TabRpcClient, { info: { path }, data64: stringToBase64(draft) });
            setLoad({ status: "ok", text: draft, lines: draft.split("\n").length });
            setSaveErr(false);
            setEditing(false);
        } catch {
            setSaveErr(true); // keep the edit in the textarea; never silently drop it
        }
    };

    // let the gate flush a pending edit before it advances the run
    useEffect(() => {
        onEditorReady?.(async () => {
            if (editing && planDirty(draft, load.text)) {
                await save();
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing, draft, load.text]);

    const large = load.status === "ok" && load.lines > PLAN_PREVIEW_COLLAPSE_LINES;
    const open = editing || (override ?? !large); // editing forces the section open
    const filename = path.split(/[/\\]/).pop() ?? path;
    return (
        <div className="border-b border-asking/20">
            <div className="flex w-full items-center gap-2 px-3.5 py-2">
                <button type="button" onClick={() => setOverride(!open)} className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80">
                    <span className="font-mono text-[8px] text-asking">{open ? "▼" : "▶"}</span>
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-asking">Plan</span>
                    <span className="truncate font-mono text-[10.5px] text-muted">
                        {filename}
                        {load.status === "ok" ? ` · ${load.lines} lines` : ""}
                    </span>
                </button>
                {load.status === "ok" && !editing ? (
                    <button
                        type="button"
                        onClick={() => {
                            setDraft(load.text);
                            setEditing(true);
                        }}
                        className="flex-none rounded-[6px] border border-edge-mid px-2 py-0.5 font-mono text-[10px] text-ink-mid hover:border-edge-strong"
                    >
                        Edit
                    </button>
                ) : null}
                {editing ? (
                    <button
                        type="button"
                        onClick={() => fireAndForget(save)}
                        className="flex-none rounded-[6px] border border-accent/50 bg-accentbg/40 px-2 py-0.5 font-mono text-[10px] text-accent-soft hover:bg-accentbg/60"
                    >
                        Save
                    </button>
                ) : null}
            </div>
            {open ? (
                <div className="sc max-h-[320px] overflow-y-auto px-3.5 pb-3">
                    {editing ? (
                        <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            className="h-[300px] w-full resize-none rounded-[8px] border border-edge-mid bg-background px-3 py-2 font-mono text-[12px] leading-[1.5] text-secondary focus:outline-none"
                        />
                    ) : load.status === "loading" ? (
                        <span className="text-[12px] text-muted">Loading plan…</span>
                    ) : load.status === "error" ? (
                        <span className="text-[12px] text-muted">Couldn't read plan · {filename}</span>
                    ) : (
                        <MarkdownMessage text={load.text} className="text-[12.5px] leading-[1.55] text-secondary" />
                    )}
                    {saveErr ? <div className="mt-1.5 text-[11px] text-error">Couldn't save the plan — try again.</div> : null}
                </div>
            ) : null}
        </div>
    );
}

function ReviewGateCard({ channelId, run, gateIdx }: { channelId: string; run: Run; gateIdx: number }) {
    const gatePhase = run.phases[gateIdx];
    const artifact = (gatePhase.artifacts ?? [])[0];
    const flushRef = useRef<() => Promise<void>>(async () => {});
    return (
        <AttentionCard className="mt-3 max-w-[760px]">
            <AttentionBanner
                glyph="diamond"
                label="Review gate — your approval needed"
                meta={artifact ?? undefined}
            />
            <div className="px-3.5 pt-2.5 text-[11.5px] text-ink-mid">
                {run.mode === "orchestrator" ? "Plan ready — approve to let the lead proceed." : "Approve before execution starts."}
            </div>
            {artifact ? (
                <PlanPreview
                    path={resolveArtifactPath(run.projectpath, artifact)}
                    onEditorReady={(flush) => {
                        flushRef.current = flush;
                    }}
                />
            ) : null}
            <div className="flex items-center gap-2.5 px-3.5 py-3">
                <button
                    type="button"
                    onClick={() =>
                        fireAndForget(async () => {
                            await flushRef.current(); // persist any unsaved plan edit first
                            await approveGate(channelId, run.id, gateIdx);
                        })
                    }
                    className="rounded-[8px] bg-accent px-4 py-2 text-[12px] font-bold text-background hover:bg-accent/90"
                >
                    {run.mode === "orchestrator" ? "Approve & proceed" : "Approve & execute"}
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
        </AttentionCard>
    );
}

function AskCard({ model, agent, kind }: { model: AgentsViewModel; agent: AgentVM; kind: "clarify" | "fork" }) {
    return (
        <AttentionCard className="mt-3 max-w-[760px]" glow>
            <AttentionBanner
                glyph="diamond"
                label={kind === "clarify" ? "Clarifying question" : "Escalated to you — a decision Jarvis can't make"}
            />
            <div className="px-3.5 py-3">
                <AskRow model={model} agent={agent} />
            </div>
        </AttentionCard>
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

// A just-spawned worker whose tab exists but hasn't reported its first status yet. Shown instead of the
// alarming "worker exited" card during the brief boot window; it flips to a live worker row on first status.
function StartingCard() {
    return (
        <div className="mt-2.5 inline-flex items-center gap-2 rounded-[9px] border border-edge-mid bg-background px-3 py-2">
            <span className="h-[7px] w-[7px] flex-none animate-pulse rounded-full bg-asking" />
            <span className="text-[12px] text-secondary">Worker starting…</span>
        </div>
    );
}

// The adaptive lead's announced quick-vs-plan call for an orchestrate phase (non-blocking; recorded
// via `wsh jarvis triage`). Informational — quick reads as go-ahead (success), plan as deliberate (asking).
function TriageChip({ triage }: { triage: PhaseTriage }) {
    const quick = triage.verdict === "quick";
    const tone = quick ? "text-success border-success/40 bg-success/10" : "text-asking border-asking/40 bg-warning/10";
    return (
        <div className={"mt-2 inline-flex max-w-[760px] items-center gap-2 rounded-[8px] border px-2.5 py-1.5 " + tone}>
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[.08em]">Triage · {triage.verdict}</span>
            {triage.note ? <span className="text-[11.5px] leading-[1.4] text-secondary">{triage.note}</span> : null}
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

// The run header (status + goal + Steer toggle) and the inline steer composer, shared by the pipeline
// rail body and the orchestrator body. Steer state is owned by RunsView and passed down so it resets
// on run switch. The steer target is the current phase's lead (steerTarget); the button is disabled
// when there is none (terminal run / no live worker).
function RunHeader({
    run,
    agents,
    channel,
    steering,
    steerDraft,
    setSteerDraft,
    onSteerToggle,
    onSteerClose,
}: {
    run: Run;
    agents: AgentVM[];
    channel: Channel;
    steering: boolean;
    steerDraft: string;
    setSteerDraft: (s: string) => void;
    onSteerToggle: () => void;
    onSteerClose: () => void;
}) {
    const target = steerTarget(run, agents);
    return (
        <>
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
                        disabled={!target}
                        onClick={onSteerToggle}
                        className="rounded-[8px] border border-edge-mid px-2.5 py-1.5 text-[11.5px] font-semibold text-secondary hover:border-edge-strong disabled:opacity-40"
                    >
                        Steer
                    </button>
                </div>
            </div>
            {steering && target ? (
                <div className="mb-4 max-w-[760px]">
                    <ComposerShell
                        value={steerDraft}
                        onChange={setSteerDraft}
                        autoFocus
                        placeholder={`Steer ${target.name}…`}
                        sendLabel="Steer ⏎"
                        onSubmit={() => {
                            const text = steerDraft.trim();
                            if (!target || !text) {
                                return;
                            }
                            setSteerDraft("");
                            onSteerClose();
                            fireAndForget(() =>
                                steerWorker({
                                    channelId: channel.oid,
                                    workerORef: `tab:${target.id}`,
                                    agents,
                                    text,
                                })
                            );
                        }}
                    />
                </div>
            ) : null}
        </>
    );
}

// dispatched-agent state -> text tone class (dot + state pill share it via bg-current / text-*)
const SUB_TONE_CLASS: Record<SubagentState, string> = {
    working: "text-accent",
    success: "text-success",
    failure: "text-error",
    done: "text-muted",
};

// Live Task-tool subagents an orchestrator lead has dispatched, rendered as rich rows beneath its
// transcript. Reads the disk-backed subagent store (populated by useSubagentTracking); renders nothing
// until the lead spawns any. A row with a transcript is clickable and opens that child's live interior
// on the agent surface — the same path the Agents tab uses (focusSubagentAtom + jumpToAgent). Finished
// children are kept (a run wants the whole fan-out as history, not just what is still live).
function DispatchedAgents({ model, leadId }: { model: AgentsViewModel; leadId: string }) {
    const subs = useAtomValue(subagentsByIdAtom)[leadId] ?? [];
    if (subs.length === 0) {
        return null;
    }
    const openChild = (s: (typeof subs)[number]) => {
        if (!s.transcriptPath) {
            return;
        }
        globalStore.set(focusSubagentAtom, {
            parentId: leadId,
            agentId: s.id,
            transcriptPath: s.transcriptPath,
            label: s.type || "subagent",
        });
        jumpToAgent(model, leadId);
    };
    return (
        <div className="mt-3 overflow-hidden rounded-[10px] border border-edge-mid bg-background">
            <div className="flex items-center gap-2 border-b border-edge-mid px-3 py-2">
                <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-muted">Dispatched</span>
                <span className="font-mono text-[10px] text-secondary">{subs.length}</span>
            </div>
            <div className="sc max-h-[220px] overflow-y-auto py-1">
                {subs.map((s) => {
                    const tone = SUB_TONE_CLASS[s.state] ?? "text-muted";
                    return (
                        <div
                            key={s.id}
                            onClick={() => openChild(s)}
                            className={
                                "flex items-center gap-2.5 px-3 py-1.5 " +
                                (s.transcriptPath ? "cursor-pointer hover:bg-surface-hover" : "")
                            }
                        >
                            <span className="font-mono text-[11px] font-semibold text-edge-strong">↳</span>
                            <span className={"h-[6px] w-[6px] flex-none rounded-full bg-current " + tone} />
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-[11.5px] font-semibold text-secondary">
                                    {s.type || "subagent"}
                                </div>
                                {s.model ? <div className="truncate font-mono text-[9.5px] text-muted">{s.model}</div> : null}
                            </div>
                            <span className={"shrink-0 whitespace-nowrap font-mono text-[9.5px] font-medium " + tone}>
                                {s.state}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Dedicated body for an orchestrator run: one long-lived lead in one phase. A flex-fill column so the
// lead transcript grows to the viewport (RunWorkerCard fill), with its dispatched subagents beneath it.
// Reuses the same header/gate/ask/blocked/ship/cancel pieces as the pipeline rail — only the layout is
// orchestrator-specific. Not wrapped in the surface's scroll container: the transcript owns scrolling.
function OrchestratorBody({
    model,
    channel,
    agents,
    run,
    now,
    liveTabIds,
    steering,
    steerDraft,
    setSteerDraft,
    onSteerToggle,
    onSteerClose,
}: {
    model: AgentsViewModel;
    channel: Channel;
    agents: AgentVM[];
    run: Run;
    now: number;
    liveTabIds: Set<string>;
    steering: boolean;
    steerDraft: string;
    setSteerDraft: (s: string) => void;
    onSteerToggle: () => void;
    onSteerClose: () => void;
}) {
    const idx = currentPhaseIndex(run);
    const thread = phaseThread(run, idx, agents, liveTabIds);
    const lead = leadWorker(run, agents);
    // populate subagentsByIdAtom[lead] for DispatchedAgents (as PhaseRail does for pipeline)
    useSubagentTracking(lead ? [lead] : []);
    return (
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-3 pt-5">
            <RunHeader
                run={run}
                agents={agents}
                channel={channel}
                steering={steering}
                steerDraft={steerDraft}
                setSteerDraft={setSteerDraft}
                onSteerToggle={onSteerToggle}
                onSteerClose={onSteerClose}
            />
            {thread.showGate ? <ReviewGateCard channelId={channel.oid} run={run} gateIdx={idx} /> : null}
            {thread.showAsk && thread.askAgent && thread.askKind ? (
                <AskCard model={model} agent={thread.askAgent} kind={thread.askKind} />
            ) : null}
            {thread.showWorkers && lead ? (
                <div className="mt-3 flex min-h-0 flex-1 flex-col">
                    <RunWorkerCard model={model} agent={lead} now={now} fill />
                    <DispatchedAgents model={model} leadId={lead.id} />
                </div>
            ) : null}
            {thread.showStarting ? <StartingCard /> : null}
            {thread.showBlocked ? <BlockedCard model={model} channelId={channel.oid} run={run} worker={lead} /> : null}
            {thread.showShip ? <ShipMarker /> : null}
            {!isTerminal(run.status) ? (
                <button
                    type="button"
                    onClick={() => fireAndForget(() => cancelRun(channel.oid, run.id))}
                    className="mt-4 flex-none self-start rounded-[8px] border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-muted hover:border-error hover:text-error"
                >
                    Cancel run
                </button>
            ) : null}
        </div>
    );
}

// The phase-rail node (icon disc + connector). Plays a one-shot settle when the phase completes.
function PhaseNode({ tone, icon, done, notLast }: { tone: string; icon: string; done: boolean; notLast: boolean }) {
    const settling = useSettle(done);
    return (
        <div className="flex w-9 flex-none flex-col items-center">
            <div
                className={
                    "flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-current font-mono text-[14px] font-bold " +
                    (PHASE_TONE_CLASS[tone] ?? "text-muted") +
                    (settling ? " animate-[settle_0.5s_ease-out] motion-reduce:animate-none" : "")
                }
            >
                {icon}
            </div>
            {notLast ? <div className="my-1 min-h-[22px] w-0.5 flex-1 bg-edge-mid" /> : null}
        </div>
    );
}

function PhaseRail({ model, run, agents, channelId, liveTabIds, now, entranceIds }: { model: AgentsViewModel; run: Run; agents: AgentVM[]; channelId: string; liveTabIds: Set<string>; now: number; entranceIds: Set<string> }) {
    const phases = run.phases ?? [];
    const trackedWorkers = isOrchestrator(run) ? phases.flatMap((p) => phaseWorkers(p, agents)) : [];
    useSubagentTracking(trackedWorkers);
    return (
        <AnimatePresence initial={false}>
            {phases.map((p, i) => {
                const v = phaseStateView(p.state);
                const thread = phaseThread(run, i, agents, liveTabIds);
                const workers = phaseWorkers(p, agents);
                const notLast = i < phases.length - 1;
                return (
                    <motion.div
                        key={i}
                        layout
                        variants={cardVariants}
                        initial={entranceIds.has(`p${i}`) ? "initial" : false}
                        animate="animate"
                    >
                        {thread.showBoundary ? (
                            <div className="my-2 flex items-center gap-3">
                                <div className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--color-edge-mid)_0_5px,transparent_5px_10px)]" />
                                <span className="font-mono text-[9.5px] font-semibold text-muted">context cleared → fresh worker</span>
                                <div className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--color-edge-mid)_0_5px,transparent_5px_10px)]" />
                            </div>
                        ) : null}
                        <div className="flex gap-4">
                            <PhaseNode tone={v.tone} icon={v.icon} done={p.state === "done"} notLast={notLast} />
                            <div className="min-w-0 flex-1 pb-4">
                                <div className="flex items-center gap-2">
                                    <span className="text-[14px] font-bold text-primary">{p.kind}</span>
                                    <span className={"font-mono text-[9px] font-semibold uppercase tracking-[.06em] " + (PHASE_TONE_CLASS[v.tone] ?? "text-muted")}>{v.label}</span>
                                </div>
                                {p.skill ? <div className="mt-0.5 font-mono text-[11px] text-muted">{p.skill}</div> : null}
                                {p.triage ? <TriageChip triage={p.triage} /> : null}
                                {(p.artifacts ?? []).map((art) => (
                                    <div key={art} className="mt-2 inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-background px-2.5 py-1">
                                        <span className="text-[11px] text-muted">▸</span>
                                        <span className="font-mono text-[11px] text-secondary">{art}</span>
                                    </div>
                                ))}
                                {thread.showWorkers ? (
                                    <div className="mt-2.5 flex flex-col gap-2">
                                        {workers.map((w) => (
                                            <RunWorkerCard key={w.id} model={model} agent={w} now={now} />
                                        ))}
                                    </div>
                                ) : null}
                                {p.state === "done" ? <PhaseHistory tabIds={recordedWorkerTabs(p)} /> : null}
                                {thread.showGate ? <ReviewGateCard channelId={channelId} run={run} gateIdx={i} /> : null}
                                {thread.showAsk && thread.askAgent && thread.askKind ? (
                                    <AskCard model={model} agent={thread.askAgent} kind={thread.askKind} />
                                ) : null}
                                {thread.showStarting ? <StartingCard /> : null}
                                {thread.showBlocked ? (
                                    <BlockedCard model={model} channelId={channelId} run={run} worker={workers[0]} />
                                ) : null}
                                {thread.showShip ? <ShipMarker /> : null}
                            </div>
                        </div>
                    </motion.div>
                );
            })}
        </AnimatePresence>
    );
}

export function RunsView({
    model,
    channel,
    agents,
    runMode,
    planGate,
}: {
    model: AgentsViewModel;
    channel: Channel;
    agents: AgentVM[];
    runMode: string;
    planGate: boolean;
}) {
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());
    const runs = (channel.runs ?? []).filter((r) => !dismissed.has(r.id));
    // tab ids of every live session that owns a running term block — read straight from the session
    // model so it includes an agent session that hasn't reported its first agent:status yet (that
    // worker is neither in the roster nor in `terminals`, since it's an agent, not a plain shell).
    // Lets the phase rail tell a *starting* worker (its tab still exists) from a *gone* one (tab
    // destroyed), so a freshly-spawned run doesn't render the false "worker exited" card.
    const sidebarVM = useAtomValue(sessionSidebarViewModelAtom);
    const liveTabIds = new Set<string>(flattenVisualOrder(sidebarVM).filter((r) => r.termBlockOref).map((r) => r.tabId));
    const [activeRunId, setActiveRunId] = useState<string | undefined>(() => defaultRunId(runs));
    const [draft, setDraft] = useState("");
    const [expanded, setExpanded] = useState(true);
    const [steering, setSteering] = useState(false);
    const [steerDraft, setSteerDraft] = useState("");

    // dismissals are view-local, per-channel — drop them when the channel changes
    useEffect(() => {
        setDismissed(new Set());
    }, [channel.oid]);

    // when the channel changes or the visible runs change, keep a valid selection (or the new-run state)
    useEffect(() => {
        setActiveRunId((cur) => resolveActiveRunId(runs, cur));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channel.oid, runs.length]);

    // close the inline steer composer when the selected run changes
    useEffect(() => {
        setSteering(false);
        setSteerDraft("");
    }, [activeRunId]);

    // hide a run tab from the strip (view-local; does not cancel the run). Reselect if it was active.
    const dismissTab = (id: string) => {
        const next = new Set(dismissed);
        next.add(id);
        setDismissed(next);
        const visible = (channel.runs ?? []).filter((r) => !next.has(r.id));
        setActiveRunId((cur) => (cur === id ? defaultRunId(visible) : cur));
    };

    const run = runs.find((r) => r.id === activeRunId);
    const onSteerToggle = () => setSteering((v) => !v);
    const onSteerClose = () => setSteering(false);

    // no-cascade entrance guard for the phase rail: switching runs / first mount is silent, a newly
    // appended phase animates in once. Scoped to the active run id (see motiontokens.computeEntrances).
    const railIds = run ? phaseRailIds(run) : [];
    const entranceRef = useRef(initialEntranceState());
    const { animate: entranceIds } = computeEntrances(entranceRef.current, activeRunId, railIds);
    const railKey = railIds.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, activeRunId, railIds).state;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeRunId, railKey]);

    // live workers of the active run's running phases — the set we open transcript streams for so the
    // phase rail can narrate them inline. Filtered to those actually streamable (have a transcript and
    // are working/asking/recently-idle), matching the cockpit's driver.
    const runWorkers = run ? (run.phases ?? []).filter((p) => p.state === "running").flatMap((p) => phaseWorkers(p, agents)) : [];

    // clock for liveness cues (quiet >45s) + elapsed labels; also re-runs the stream diff below
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // own transcript streams for the active run's workers (mirrors cockpitsurface: start what's wanted,
    // stop what's no longer wanted, tear all down on unmount). Streams are module-level and idempotent;
    // this surface and the cockpit grid never co-mount, so ownership doesn't collide.
    const streamable = streamableTranscriptAgents(runWorkers, now);
    const wantedKey = streamable.map((a) => a.id).join(",");
    const streamedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const wanted = new Map<string, { path: string; agent?: string }>();
        for (const a of streamable) {
            if (a.transcriptPath) {
                wanted.set(a.id, { path: a.transcriptPath, agent: a.agent });
            }
        }
        for (const [id, { path, agent }] of wanted) {
            if (!streamedRef.current.has(id)) {
                startTranscriptStream(id, path, agent);
                streamedRef.current.add(id);
            }
        }
        for (const id of [...streamedRef.current]) {
            if (!wanted.has(id)) {
                stopTranscriptStream(id);
                streamedRef.current.delete(id);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wantedKey]);
    useEffect(
        () => () => {
            for (const id of streamedRef.current) {
                stopTranscriptStream(id);
            }
            streamedRef.current.clear();
        },
        []
    );

    // the run's primary active worker drives the header "now" rollup
    const primaryWorker = runWorkers.find((w) => w.state === "working") ?? runWorkers.find((w) => w.state === "asking") ?? runWorkers[0];

    const startRun = () => {
        const goal = draft.trim();
        if (!goal) {
            return;
        }
        setDraft("");
        fireAndForget(async () => {
            const created = await createRun(channel.oid, goal, { mode: runMode, planGate });
            setActiveRunId(created.id);
        });
    };

    return (
        <MotionConfig reducedMotion="user">
        <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
            {/* run tabs */}
            <div className="sc flex flex-none gap-2 overflow-x-auto border-b border-border bg-background px-[22px] py-2.5">
                {runs.map((r) => {
                    const { tone } = runStatusView(r.status);
                    const dots = phaseProgressDots(r);
                    const isActive = r.id === activeRunId;
                    return (
                        <div
                            key={r.id}
                            className={
                                "group flex max-w-[250px] flex-none items-center gap-2 rounded-[9px] border px-3 py-2 " +
                                (isActive ? "border-accent/50 bg-accentbg/40" : "border-edge-mid hover:border-edge-strong")
                            }
                        >
                            <button
                                type="button"
                                onClick={() => setActiveRunId(r.id)}
                                className="flex min-w-0 items-center gap-2"
                            >
                                <span className={"h-[7px] w-[7px] flex-none rounded-full bg-current " + (TONE_CLASS[tone] ?? "text-muted")} />
                                <span className="truncate text-[12px] font-semibold text-primary">{r.goal}</span>
                            </button>
                            {dots.length > 0 ? (
                                <span className="flex flex-none items-center gap-0.5">
                                    {dots.map((t, i) => (
                                        <span
                                            key={i}
                                            className={"h-[4px] w-[4px] rounded-full bg-current " + (PHASE_TONE_CLASS[t] ?? "text-muted")}
                                        />
                                    ))}
                                </span>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => dismissTab(r.id)}
                                title="Dismiss from this list (does not cancel the run)"
                                className="flex-none font-mono text-[13px] leading-none text-muted opacity-0 hover:text-secondary group-hover:opacity-100"
                            >
                                ×
                            </button>
                        </div>
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

            {run && isOrchestrator(run) ? (
                <OrchestratorBody
                    model={model}
                    channel={channel}
                    agents={agents}
                    run={run}
                    now={now}
                    liveTabIds={liveTabIds}
                    steering={steering}
                    steerDraft={steerDraft}
                    setSteerDraft={setSteerDraft}
                    onSteerToggle={onSteerToggle}
                    onSteerClose={onSteerClose}
                />
            ) : (
                <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                    <div>
                        {run ? (
                            <>
                                <RunHeader
                                    run={run}
                                    agents={agents}
                                    channel={channel}
                                    steering={steering}
                                    steerDraft={steerDraft}
                                    setSteerDraft={setSteerDraft}
                                    onSteerToggle={onSteerToggle}
                                    onSteerClose={onSteerClose}
                                />

                                {run.status === "executing" && primaryWorker ? (
                                    <RunRollup agent={primaryWorker} now={now} />
                                ) : null}

                                <CompactStepper run={run} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
                                {expanded ? (
                                    <PhaseRail model={model} run={run} agents={agents} channelId={channel.oid} liveTabIds={liveTabIds} now={now} entranceIds={entranceIds} />
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
                            <div className="mx-auto mt-10 w-full max-w-[620px]">
                                <div className="mb-1 text-center text-[17px] font-bold text-primary">Start a run</div>
                                <div className="mb-5 text-center text-[13px] text-muted">Give Jarvis a goal for #{channel.name}</div>
                                <ComposerShell
                                    value={draft}
                                    onChange={setDraft}
                                    onSubmit={startRun}
                                    autoFocus
                                    placeholder="Give Jarvis a goal to start a run…"
                                    sendLabel="Start run ⏎"
                                    footerLeft={
                                        <span className="font-mono text-[11.5px] text-ink-mid">{composerSummary(runMode, planGate)}</span>
                                    }
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}
            </div>
            <ProfilePanel channelId={channel.oid} />
        </div>
        </MotionConfig>
    );
}
