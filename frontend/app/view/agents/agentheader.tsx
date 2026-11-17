// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Identity + controls bar shown above the focused agent's live terminal in the Agent surface.
// Extracted from the former AgentTranscript header (now removed): the real Claude Code TUI has no
// chrome of its own, so this keeps name/status/model/context% + the details-rail toggle visible.

import { useSettle } from "@/app/element/motionhooks";
import { MOTION } from "@/app/element/motiontokens";
import { Segmented } from "@/app/element/segmented";
import { TickNumber } from "@/app/element/ticknumber";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { effortDetailAtom, loadEffortDetail } from "@/app/view/jarvis/effortstore";
import { initiativeLinkText } from "@/app/view/jarvis/initiativework";
import { openOrPeek } from "@/app/view/jarvis/openref";
import { formatChordString } from "@/util/keysym";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import {
    ChevronLeft,
    CircleStop,
    File as FileIcon,
    FileText,
    GitBranch,
    Maximize2,
    Minimize2,
    PanelRight,
    Smartphone,
    SquareTerminal,
    Workflow,
    X,
} from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useRef } from "react";
import { confirmCloseSession, interruptAgent } from "./agentactions";
import { getLastOutputAtom } from "./agentcontrollerstore";
import { FilesSummary } from "./agentdetailsrail";
import { agentDiffScope, openDiff } from "./agentdiffnav";
import { hungSilenceMs } from "./agenthung";
import { checkoutFacts, contextLevel, contextTokens } from "./agentrailmodel";
import type { AgentsViewModel } from "./agents";
import { agentStateView, STATE_TONE_COLOR } from "./agentstateview";
import { agentRunDone, type AgentVM } from "./agentsviewmodel";
import { brainstormAtom, brainstormWaitOf, setBrainstormMode } from "./brainstormstore";
import { isUnseen } from "./canvasmodel";
import { canvasStateAtom, setCanvasMode } from "./canvasstore";
import { cardCwdByIdAtom, sharedCheckoutCount } from "./cardgitstore";
import { nextSnap, type AgentSnap } from "./cockpitevents";
import { CommitTick } from "./committick";
import { DOC_REVIEW_COPY, docReviewAtom, parseDocReview } from "./docreview";
import { isFinalStageId } from "./finalstage";
import { canHandToPhone, isHandedOver } from "./handtophone";
import { HeaderControls } from "./headercontrols";
import { leadLandFacts } from "./leadland";
import { useRailGit } from "./railgit";
import { railStateAtom, railVisibleAtom, terminalFullscreenAtom } from "./railstore";
import { remoteStatusAtom, toggleHandToPhone } from "./remotestore";
import { brainstormSwitchShown } from "./renderedbsrunmodel";
import { canRender, effectiveViewMode, pickerFlipAtom, toggleViewMode, viewModeAtom } from "./renderedmode";
import { useRoleAsks } from "./roleasks";
import { agentProject, isEndedWorkerId, leadAgentOf, leadDisplayName } from "./runlineage";
import { RuntimeMark } from "./runtimemark";
import { runtimeMeta } from "./runtimemeta";
import { isStandingBy } from "./shelltasks";
import { shellReadAtByIdAtom, shellReadPending, shellTasksByIdAtom } from "./shelltasksstore";
import { StatusDot } from "./statusdot";
import { subagentsByIdAtom } from "./subagentsstore";
import { openBeside, workspaceAtom } from "./workspacestore";

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
        return { kind: "lead" as const, runId: role.runId, run: lineage.runs[role.runId] };
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
            title={`Open ${effort?.title ?? "this initiative"} in Hub`}
            className="cursor-pointer text-accent-soft hover:underline"
        >
            {initiativeLinkText(agent.name, effort)}
        </button>
    );
}

// the Rendered subline's parts, each after a separator but the line's first; from is the first part's place in it
function sublineParts(parts: React.ReactNode[], from: number) {
    return parts.map((part, i) => (
        <Fragment key={from + i}>
            {from + i > 0 ? <span className="shrink-0 text-ink-faint">{" · "}</span> : null}
            {part}
        </Fragment>
    ));
}

// the git read behind the Rendered header's facts, mounted only there: in Terminal the rail reads its own
function RailGitHold({ agent }: { agent: AgentVM }) {
    useRailGit(agent);
    return null;
}

// useCheckoutFacts is what the Rendered header says about the agent's checkout (the rail's Details and Files touched
// in Terminal), and the asks on its run waiting on you; null outside Rendered, where the rail says it
function useCheckoutFacts(model: AgentsViewModel, agent: AgentVM, rendered: boolean) {
    const { role, roleRun, yours } = useRoleAsks(model, agent);
    const git = useAtomValue(railStateAtom);
    const sharedBy = sharedCheckoutCount(agent.id, useAtomValue(cardCwdByIdAtom));
    if (!rendered) {
        return { facts: null, yours: 0 };
    }
    // a land removes the run's worktree, so a landed lead reads its run's landing, as the rail does
    const landed = role?.kind === "lead" ? leadLandFacts(roleRun) : null;
    return { facts: checkoutFacts({ git, landed, sharedBy }), yours: yours.length };
}

export function AgentHeader({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const railVisible = useAtomValue(railVisibleAtom);
    const fullscreen = useAtomValue(terminalFullscreenAtom);
    const canvas = useAtomValue(canvasStateAtom(agent.id));
    const brainstorm = useAtomValue(brainstormAtom(agent.id));
    // the roster overlay already turned a wait the file holds into state "asking"
    const brainstormAsking = agent.state === "asking" && brainstormWaitOf(brainstorm, agent) != null;
    const lineage = useRunLineage(model, agent);
    const lineageState = useAtomValue(model.lineageAtom);
    const project = agentProject(lineageState, useAtomValue(model.agentsAtom), agent);
    const handed = isHandedOver(useAtomValue(remoteStatusAtom), agent.id);
    const name =
        lineage?.kind === "worker" && lineage.task
            ? `${lineage.task.id} · ${lineage.task.label || lineage.task.id}`
            : lineage?.kind === "lead"
              ? leadDisplayName(agent, lineage.run)
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
    const viewMode = effectiveViewMode(useAtomValue(viewModeAtom(agent.id)), useAtomValue(pickerFlipAtom(agent.id)));
    const renderable = canRender(agent, { ended, stage });
    // mirrors agentsurface: an agent with a brainstorm never shows its canvas
    const paneShown = brainstorm?.mode === "brainstorm" || (brainstorm == null && canvas?.mode === "canvas");
    const rendered = renderable && viewMode === "rendered";
    // the pane switch's other half names the view it returns to
    const centerLabel = rendered ? "Rendered" : "Terminal";
    // Ctrl+Shift+B goes to the pane when the agent has one, so then only v flips the view
    const viewToggleKeys = brainstorm != null || canvas != null ? formatChordString("v") : viewKeys("v");
    const viewToggleTitle = `${rendered ? "Show the terminal" : "Show rendered"} (${viewToggleKeys})`;
    // in Rendered the rail is gone, so its checkout facts and the run's asks waiting on you read here
    const { facts, yours } = useCheckoutFacts(model, agent, rendered);
    const ws = useAtomValue(workspaceAtom(agent.id));
    const changesOn = ws.active === "changes" && !ws.collapsed;
    // only the facts this session has: a background terminal often has none, and then the line goes
    const subline: React.ReactNode[] = [];
    if (project) {
        subline.push(project);
    }
    if (facts?.branch) {
        subline.push(
            <span title={facts.branch} className="inline-flex min-w-[6ch] items-center gap-[4px] text-ink-mid">
                <GitBranch size={11} strokeWidth={2} aria-hidden className="shrink-0" />
                <span className="truncate">{facts.branch}</span>
            </span>
        );
    }
    if (facts?.worktree) {
        // clipped at its start: a worktree's path ends in the name that tells it apart. On a narrow header it gives
        // way before the branch, and both before the run link
        subline.push(
            <span
                data-header-worktree
                title={facts.worktreePath}
                dir="rtl"
                className="min-w-[4ch] shrink-[100] truncate text-left"
            >
                <bdi dir="ltr">{facts.worktree}</bdi>
            </span>
        );
    }
    if (agent.effortId != null) {
        subline.push(<InitiativeLink model={model} agent={agent} />);
    }
    // in Rendered the facts before the links clip on a narrow header; the links after them stay whole
    const linksFrom = subline.length;
    if (lineage?.kind === "lead") {
        // a link, as a worker's header links up to its lead: the run's sheet, ctrl+click peeks it. In Rendered a
        // plain click opens the run beside the transcript instead
        const runId = lineage.runId;
        subline.push(
            <button
                type="button"
                data-peek
                data-header-run-link
                onClick={(e) => {
                    if (!openBeside(model, agent.id, { kind: "run", runId, view: "tasks" }, e)) {
                        fireAndForget(() => openOrPeek(model, { kind: "run", runId }, e));
                    }
                }}
                title="Open the run"
                className={cn(
                    "cursor-pointer text-accent-soft hover:underline",
                    rendered && "inline-flex shrink-0 items-center gap-[5px]"
                )}
            >
                orchestrator run {runId.slice(0, 8)}
                {yours > 0 ? (
                    <span
                        data-header-run-asks
                        aria-label={`${yours} waiting on you`}
                        className="inline-flex items-center gap-[4px] text-warning"
                    >
                        <span className="h-[6px] w-[6px] rounded-full bg-warning" aria-hidden />
                        <TickNumber value={yours} />
                    </span>
                ) : null}
            </button>
        );
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
                    ↑ {leadDisplayName(lineage.lead, lineage.run)}
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
        // Rendered has no details rail to show
        if (!rendered) {
            items.push({
                label: railVisible ? "Hide details" : "Show details",
                icon: <PanelRight size={15} />,
                click: () => globalStore.set(railVisibleAtom, !railVisible),
            });
        }
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
                    {/* Rendered draws the model, mode and context in its message box */}
                    {rendered ? null : renderable ? (
                        <HeaderControls key={agent.id} agent={agent} />
                    ) : agent.model ? (
                        <span className="shrink-0 whitespace-nowrap rounded-[5px] border border-edge-mid px-[7px] py-[1px] font-mono text-[10.5px] font-medium text-muted @max-[480px]:hidden">
                            {agent.model}
                        </span>
                    ) : null}
                    {!rendered && agent.usage?.contextpct != null ? (
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
                {subline.length > 0 && rendered ? (
                    <div
                        data-agent-subline
                        className="mt-[2px] flex min-w-0 items-center whitespace-nowrap font-mono text-[11px] font-medium text-muted"
                    >
                        {linksFrom > 0 ? (
                            <span className="flex min-w-0 items-center overflow-hidden">
                                {sublineParts(subline.slice(0, linksFrom), 0)}
                            </span>
                        ) : null}
                        {sublineParts(subline.slice(linksFrom), linksFrom)}
                    </div>
                ) : subline.length > 0 ? (
                    <div data-agent-subline className="mt-[2px] truncate font-mono text-[11px] font-medium text-muted">
                        {subline.map((part, i) => (
                            <Fragment key={i}>
                                {i > 0 ? " · " : null}
                                {part}
                            </Fragment>
                        ))}
                    </div>
                ) : null}
            </div>
            {rendered ? <RailGitHold agent={agent} /> : null}
            <div data-agent-actions className="flex shrink-0 items-center gap-[7px]">
                {facts?.chip ? (
                    <button
                        type="button"
                        data-header-files-chip
                        onClick={(e) => {
                            if (!openBeside(model, agent.id, { kind: "changes", selected: null }, e)) {
                                openDiff(model, agentDiffScope(agent.id, agent.name));
                            }
                        }}
                        title={facts.chip.title ? `${facts.chip.title} · Open the Changes tab` : "Open the Changes tab"}
                        data-on={changesOn || undefined}
                        className={cn(
                            "inline-flex cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[7px] border px-[9px] py-[5px] font-mono text-[11px] font-semibold",
                            changesOn
                                ? "border-edge-strong bg-surface-selected text-primary"
                                : "border-edge-mid bg-surface-raised text-ink-mid hover:border-edge-strong"
                        )}
                    >
                        <FileIcon size={12} strokeWidth={2} aria-hidden />
                        <span>
                            <FilesSummary chip={facts.chip} />
                        </span>
                    </button>
                ) : null}
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
                {brainstorm != null && brainstormSwitchShown(brainstorm, rendered) ? (
                    <Segmented
                        role="group"
                        ariaLabel="Show terminal or brainstorm"
                        value={brainstorm.mode}
                        options={[
                            { key: "terminal", label: centerLabel, title: `${centerLabel} (${viewKeys("b")})` },
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
                ) : brainstorm == null && canvas != null ? (
                    <Segmented
                        role="group"
                        ariaLabel="Show terminal or canvas"
                        value={canvas.mode}
                        options={[
                            { key: "terminal", label: centerLabel, title: `${centerLabel} (${viewKeys("c")})` },
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
                        {/* an open pane hides the terminal, so there is no view for this to flip */}
                        {renderable && !paneShown ? (
                            <button
                                type="button"
                                data-view-toggle
                                onClick={() => toggleViewMode(agent.id)}
                                title={viewToggleTitle}
                                aria-label={viewToggleTitle}
                                aria-pressed={rendered}
                                className={
                                    rendered
                                        ? "cursor-pointer rounded-[7px] border border-accent bg-accentbg px-[9px] py-[6px] text-accent"
                                        : cn(ICON_BTN, "hover:border-edge-strong")
                                }
                            >
                                {rendered ? (
                                    <SquareTerminal size={16} strokeWidth={1.8} aria-hidden />
                                ) : (
                                    <FileText size={16} strokeWidth={1.8} aria-hidden />
                                )}
                            </button>
                        ) : null}
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
