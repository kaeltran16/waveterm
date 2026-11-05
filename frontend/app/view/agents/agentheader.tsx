// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Identity + controls bar shown above the focused agent's live terminal in the Agent surface.
// Extracted from the former AgentTranscript header (now removed): the real Claude Code TUI has no
// chrome of its own, so this keeps name/status/model/context% + the details-rail toggle visible.

import { useSettle } from "@/app/element/motionhooks";
import { MOTION } from "@/app/element/motiontokens";
import { Segmented } from "@/app/element/segmented";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { effortDetailAtom, loadEffortDetail } from "@/app/view/jarvis/effortstore";
import { initiativeLinkText } from "@/app/view/jarvis/initiativework";
import { openOrPeek } from "@/app/view/jarvis/openref";
import { formatChordString } from "@/util/keysym";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronLeft, CircleStop, Maximize2, Minimize2, PanelRight, Smartphone, Workflow, X } from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useRef } from "react";
import { confirmCloseSession, interruptAgent } from "./agentactions";
import { getLastOutputAtom } from "./agentcontrollerstore";
import { hungSilenceMs } from "./agenthung";
import { contextLevel, contextTokens } from "./agentrailmodel";
import type { AgentsViewModel } from "./agents";
import { agentStateView, STATE_TONE_COLOR } from "./agentstateview";
import { agentRunDone, type AgentVM } from "./agentsviewmodel";
import { isAsking } from "./brainstormmodel";
import { brainstormAtom, setBrainstormMode, shownBrainstormFile } from "./brainstormstore";
import { isUnseen } from "./canvasmodel";
import { canvasStateAtom, setCanvasMode } from "./canvasstore";
import { nextSnap, type AgentSnap } from "./cockpitevents";
import { CommitTick } from "./committick";
import { DOC_REVIEW_COPY, docReviewAtom, parseDocReview } from "./docreview";
import { isFinalStageId } from "./finalstage";
import { canHandToPhone, isHandedOver } from "./handtophone";
import { railVisibleAtom, terminalFullscreenAtom } from "./railstore";
import { remoteStatusAtom, toggleHandToPhone } from "./remotestore";
import { agentProject, isEndedWorkerId, leadAgentOf } from "./runlineage";
import { RuntimeMark } from "./runtimemark";
import { runtimeMeta } from "./runtimemeta";
import { isStandingBy } from "./shelltasks";
import { shellReadAtByIdAtom, shellReadPending, shellTasksByIdAtom } from "./shelltasksstore";
import { StatusDot } from "./statusdot";
import { subagentsByIdAtom } from "./subagentsstore";

// header context chip color by context level (mirrors the rail gauge, as text not fill)
const CTX_TEXT: Record<"ok" | "warn" | "hot", string> = {
    ok: "text-accent",
    warn: "text-warning",
    hot: "text-error",
};

// the brainstorm/canvas switch's keys: its letter off the terminal, agent:view-chord from anywhere
const viewKeys = (letter: string) => `${formatChordString(letter)} or ${formatChordString("Ctrl:Shift:b")}`;

// shared compact icon-button (matches the rail-toggle's resting style)
export const ICON_BTN =
    "cursor-pointer rounded-[7px] border border-edge-mid bg-surface-raised px-[9px] py-[6px] text-secondary";

// useRunLineage reads what the header says about an agent a run spawned: a lead's run, a worker's task and
// lead, or a stage session's run and lead.
function useRunLineage(model: AgentsViewModel, agent: AgentVM) {
    const lineage = useAtomValue(model.lineageAtom);
    const agents = useAtomValue(model.agentsAtom);
    const role = lineage.roles[agent.id];
    if (role == null) {
        return null;
    }
    if (role.kind === "lead") {
        return { kind: "lead" as const, runId: role.runId };
    }
    const run = lineage.runs[role.leadRunId];
    const lead = leadAgentOf(lineage, agents, role.leadRunId);
    if (role.kind === "stage") {
        return { kind: "stage" as const, run, lead };
    }
    const task = run?.dag?.tasks?.find((t) => t.id === role.taskId);
    return {
        kind: "worker" as const,
        run,
        task,
        lead,
    };
}

// The initiative this session works on, linking back to it on the Brief.
function InitiativeLink({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const oref = "effort:" + agent.effortId;
    const effort = useAtomValue(effortDetailAtom).get(oref);
    useEffect(() => {
        // the title is decoration: a failed load leaves the plain link, which still opens the initiative
        loadEffortDetail(oref).catch(() => {});
    }, [oref]);
    return (
        <button
            type="button"
            data-peek
            onClick={(e) => fireAndForget(() => openOrPeek(model, { kind: "effort", effortId: agent.effortId! }, e))}
            title={`Open ${effort?.title ?? "this initiative"} in Jarvis`}
            className="cursor-pointer text-accent-soft hover:underline"
        >
            {initiativeLinkText(agent.name, effort)}
        </button>
    );
}

export function AgentHeader({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const railVisible = useAtomValue(railVisibleAtom);
    const fullscreen = useAtomValue(terminalFullscreenAtom);
    const canvas = useAtomValue(canvasStateAtom(agent.id));
    const brainstorm = useAtomValue(brainstormAtom(agent.id));
    // the roster overlay already turned a question the file asks into state "asking"
    const brainstormFile = shownBrainstormFile(brainstorm);
    const brainstormAsking = brainstormFile != null && isAsking(brainstormFile) && agent.state === "asking";
    const lineage = useRunLineage(model, agent);
    const lineageState = useAtomValue(model.lineageAtom);
    const project = agentProject(lineageState, useAtomValue(model.agentsAtom), agent);
    const handed = isHandedOver(useAtomValue(remoteStatusAtom), agent.id);
    const name =
        lineage?.kind === "worker" && lineage.task
            ? `${lineage.task.id} · ${lineage.task.label || lineage.task.id}`
            : agent.name;
    const rt = runtimeMeta(agent.agent);
    const blockId = agent.blockId;
    // a done task's worker reads as what its task came to, not as an idle session
    const ended = isEndedWorkerId(agent.id);
    // the final stage's own id is no session: it has no runtime, and its pane says its state
    const stage = isFinalStageId(agent.id);
    const landed = lineage?.kind === "worker" && lineage.task?.merged;
    const standingBy = isStandingBy(
        agent.state,
        useAtomValue(shellTasksByIdAtom)[agent.id] ?? [],
        useAtomValue(subagentsByIdAtom)[agent.id] ?? []
    );
    // a quick run's worker that completed its run reads as done, not as an idle session
    const runDone = agentRunDone(agent, standingBy);
    const silentMs = hungSilenceMs(
        agent,
        useAtomValue(getLastOutputAtom(agent.blockId ?? "")),
        useAtomValue(model.structuralNowAtom)
    );
    const stateView = agentStateView({
        agent,
        ended,
        landed: landed === true,
        runDone,
        standingBy,
        silentMs,
    });
    // a controller that refused to start reads as failed, never as still booting
    const failed = stateView?.tone === "error";
    const stateColor = stateView ? STATE_TONE_COLOR[stateView.tone] : STATE_TONE_COLOR.idle;
    // m4: one-shot settle on the state pill when the focused agent reaches idle
    const readPending = shellReadPending(agent, useAtomValue(shellReadAtByIdAtom)[agent.id]);
    // held until a shell-task read since the Stop lands, so a just-launched task never settles first;
    // nextSnap is idempotent for the same inputs, so advancing it in render is safe
    const snapRef = useRef<AgentSnap>(undefined);
    snapRef.current = nextSnap(snapRef.current, agent.state, standingBy, readPending);
    const settling = useSettle(!ended && agent.state === "idle" && !standingBy && !snapRef.current.held);
    const review = parseDocReview(agent.ask);
    const reviewOpen = useAtomValue(docReviewAtom) != null;
    // only the facts this session has: a background terminal often has none, and then the line goes
    const subline: React.ReactNode[] = [];
    if (project) {
        subline.push(project);
    }
    if (agent.effortId != null) {
        subline.push(<InitiativeLink model={model} agent={agent} />);
    }
    if (lineage?.kind === "lead") {
        subline.push(`orchestrator run ${lineage.runId.slice(0, 8)}`);
    }
    if (lineage?.kind === "worker" || lineage?.kind === "stage") {
        subline.push(
            lineage.lead ? (
                <button
                    type="button"
                    onClick={() => globalStore.set(model.focusIdAtom, lineage.lead!.id)}
                    title="Go to the lead"
                    className="cursor-pointer text-accent-soft hover:underline"
                >
                    ↑ {lineage.lead.name}
                </button>
            ) : (
                <span>↑ {lineage.run?.title ?? "no lead"}</span>
            )
        );
    }

    // Esc cancels the current Claude turn — same PTY-write path as the composer (ControllerInputCommand).
    const interrupt = () => interruptAgent(blockId);

    // Close the whole session (a tab, per launchAgent) — shared with the double-Ctrl+C handler. The
    // header also fronts background terminals, so the noun follows what is actually focused.
    const closeTerminal = () => confirmCloseSession(agent, model);
    const closeLabel = agent.kind === "terminal" ? "Close terminal" : "Close agent";

    // Right-click the header for the same controls as the button row (plus the details toggle).
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const items: ContextMenuItem[] = [];
        if (blockId != null) {
            if (agent.state === "working") {
                items.push({ label: "Interrupt turn", icon: <CircleStop size={15} />, click: interrupt });
            }
            items.push({
                label: fullscreen ? "Exit fullscreen" : "Fullscreen terminal",
                icon: fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />,
                click: () => globalStore.set(terminalFullscreenAtom, !fullscreen),
            });
        }
        items.push({
            label: railVisible ? "Hide details" : "Show details",
            icon: <PanelRight size={15} />,
            click: () => globalStore.set(railVisibleAtom, !railVisible),
        });
        if (blockId != null) {
            items.push({ type: "separator" });
            items.push({ label: closeLabel, icon: <X size={15} />, danger: true, click: closeTerminal });
        }
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    return (
        <div
            data-agent-header
            onContextMenu={onContextMenu}
            className="@container flex shrink-0 items-center gap-[13px] border-b border-border bg-background px-[22px] py-[14px]"
        >
            {stage ? null : ended || failed ? (
                <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: stateColor }} />
            ) : runDone ? (
                <CommitTick runDone />
            ) : (
                <StatusDot
                    state={agent.state}
                    pulse={agent.state !== "idle"}
                    standing={standingBy}
                    className="!h-[9px] !w-[9px]"
                />
            )}
            <div className="min-w-0 flex-1 overflow-hidden">
                <div data-agent-title-row className="flex flex-wrap items-center gap-x-[9px] gap-y-[3px]">
                    <span className="min-w-[96px] max-w-full truncate font-mono text-[15px] font-semibold text-foreground">
                        {lineage?.kind === "lead" ? (
                            <Workflow
                                size={13}
                                aria-hidden
                                className="mr-[5px] inline-block align-[-1px] text-accent-soft"
                            />
                        ) : null}
                        {name}
                    </span>
                    {stage ? null : (
                        <>
                            <span
                                className={cn(
                                    "inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[5px] border px-[8px] py-[2px] font-mono text-[10.5px] font-semibold",
                                    rt.text,
                                    rt.softBg,
                                    rt.line
                                )}
                            >
                                <RuntimeMark runtime={agent.agent} className="text-[11px] leading-none" />
                                {rt.label}
                            </span>
                            {stateView ? (
                                <span
                                    className={cn(
                                        "shrink-0 whitespace-nowrap rounded-[5px] border px-[7px] py-[1px] font-mono text-[10.5px] font-medium opacity-85 transition-colors duration-[140ms]",
                                        failed && "border-error text-error",
                                        settling &&
                                            !failed &&
                                            "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                                    )}
                                    style={failed ? undefined : { color: stateColor, borderColor: stateColor }}
                                    data-agent-state-pill
                                >
                                    {stateView.text}
                                </span>
                            ) : null}
                        </>
                    )}
                    {agent.model ? (
                        <span className="shrink-0 whitespace-nowrap rounded-[5px] border border-edge-mid px-[7px] py-[1px] font-mono text-[10.5px] font-medium text-muted @max-[480px]:hidden">
                            {agent.model}
                        </span>
                    ) : null}
                    {agent.usage?.contextpct != null ? (
                        <span
                            title={`context: ${Math.round(agent.usage.contextpct)}% of the window`}
                            className={cn(
                                "shrink-0 whitespace-nowrap font-mono text-[10.5px] font-semibold @max-[400px]:hidden",
                                CTX_TEXT[contextLevel(agent.usage.contextpct, agent.usage.contextmax)]
                            )}
                        >
                            {contextTokens(agent.usage.contextpct, agent.usage.contextmax) ??
                                `${Math.round(agent.usage.contextpct)}%`}
                        </span>
                    ) : null}
                </div>
                {failed ? (
                    <div data-agent-start-error className="mt-[2px] font-mono text-[11px] font-medium text-error">
                        {agent.startError}
                    </div>
                ) : null}
                {subline.length > 0 ? (
                    <div className="mt-[2px] truncate font-mono text-[11px] font-medium text-muted">
                        {subline.map((part, i) => (
                            <Fragment key={i}>
                                {i > 0 ? " · " : null}
                                {part}
                            </Fragment>
                        ))}
                    </div>
                ) : null}
            </div>
            <div data-agent-actions className="flex shrink-0 items-center gap-[7px]">
                {review && !reviewOpen ? (
                    <button
                        type="button"
                        onClick={() => globalStore.set(docReviewAtom, agent.id)}
                        title={`Show the review (${formatChordString("r")})`}
                        className="flex cursor-pointer items-center gap-[7px] rounded-[7px] border border-warning/45 bg-askingbg px-[11px] py-[6px] font-mono text-[11px] font-semibold text-warning hover:border-warning"
                    >
                        <span className="h-[6px] w-[6px] rounded-full bg-warning" aria-hidden />
                        {DOC_REVIEW_COPY[review.kind].header}
                        <ChevronLeft size={12} strokeWidth={2} aria-hidden />
                    </button>
                ) : null}
                {brainstorm != null ? (
                    <Segmented
                        role="group"
                        ariaLabel="Show terminal or brainstorm"
                        value={brainstorm.mode}
                        options={[
                            { key: "terminal", label: "Terminal", title: `Terminal (${viewKeys("b")})` },
                            {
                                key: "brainstorm",
                                label: (
                                    <>
                                        Brainstorm
                                        {brainstormAsking ? (
                                            <span
                                                aria-label="asking you"
                                                className="h-[6px] w-[6px] rounded-full bg-warning"
                                            />
                                        ) : null}
                                    </>
                                ),
                                title: `Brainstorm (${viewKeys("b")})`,
                            },
                        ]}
                        onChange={(m) => setBrainstormMode(agent.id, m, Date.now())}
                    />
                ) : canvas != null ? (
                    <Segmented
                        role="group"
                        ariaLabel="Show terminal or canvas"
                        value={canvas.mode}
                        options={[
                            { key: "terminal", label: "Terminal", title: `Terminal (${viewKeys("c")})` },
                            {
                                key: "canvas",
                                label: (
                                    <>
                                        Canvas
                                        {isUnseen(canvas) ? (
                                            <span
                                                aria-label="updated since you last looked"
                                                className="h-[6px] w-[6px] rounded-full bg-accent"
                                            />
                                        ) : null}
                                    </>
                                ),
                                title: `Canvas (${viewKeys("c")})`,
                            },
                        ]}
                        onChange={(m) => setCanvasMode(agent.id, m, Date.now())}
                    />
                ) : null}
                {blockId != null ? (
                    <>
                        {canHandToPhone(agent, lineageState.roles[agent.id]) ? (
                            <button
                                type="button"
                                data-hand-to-phone
                                onClick={() => toggleHandToPhone(agent.id)}
                                title={
                                    handed ? "Take back from the phone (p)" : "Hand to phone: turns remote mode on (p)"
                                }
                                aria-label={handed ? undefined : "Hand to phone"}
                                aria-pressed={handed}
                                className={
                                    // idle it is one of the window controls; the label only earns its width while handed
                                    handed
                                        ? "flex cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[7px] border border-accent bg-accentbg px-[11px] py-[6px] font-mono text-[11px] font-semibold text-accent"
                                        : cn(ICON_BTN, "hover:border-edge-strong")
                                }
                            >
                                {handed ? (
                                    <>
                                        <Smartphone size={13} strokeWidth={1.9} aria-hidden />
                                        On phone · Take back
                                    </>
                                ) : (
                                    <Smartphone size={16} strokeWidth={1.8} aria-hidden />
                                )}
                            </button>
                        ) : null}
                        <motion.button
                            type="button"
                            onClick={() => globalStore.set(terminalFullscreenAtom, !fullscreen)}
                            title={
                                fullscreen
                                    ? `Exit fullscreen (${formatChordString("F11")}, or ${formatChordString("f")} / ${formatChordString("Escape")} outside the terminal)`
                                    : `Fullscreen terminal (${formatChordString("f")}, or ${formatChordString("F11")} in the terminal)`
                            }
                            aria-pressed={fullscreen}
                            whileHover={{ scale: 1.06 }}
                            whileTap={{ scale: 0.85 }}
                            className={cn(
                                "cursor-pointer rounded-[7px] border px-[9px] py-[6px]",
                                fullscreen
                                    ? "border-accent bg-accentbg text-accent"
                                    : cn(ICON_BTN, "hover:border-edge-strong")
                            )}
                        >
                            {/* re-keyed so each toggle replays the rotate-in, reinforcing the state flip */}
                            <motion.span
                                key={fullscreen ? "min" : "max"}
                                initial={{ rotate: -90, opacity: 0 }}
                                animate={{ rotate: 0, opacity: 1 }}
                                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                                className="block"
                            >
                                {fullscreen ? (
                                    <Minimize2 size={16} strokeWidth={1.8} />
                                ) : (
                                    <Maximize2 size={16} strokeWidth={1.8} />
                                )}
                            </motion.span>
                        </motion.button>
                        <button
                            type="button"
                            onClick={closeTerminal}
                            title={
                                agent.kind === "terminal"
                                    ? "Close terminal"
                                    : `Close agent (${formatChordString("Ctrl:c")} twice in its terminal)`
                            }
                            className={cn(ICON_BTN, "hover:border-error hover:text-error")}
                        >
                            <X size={16} strokeWidth={1.9} />
                        </button>
                    </>
                ) : null}
            </div>
        </div>
    );
}
