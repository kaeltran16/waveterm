// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useSettle } from "@/app/element/motionhooks";
import { cardVariants, composerReveal, computeEntrances, initialEntranceState } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { Copy, CopyPlus, Pencil, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentBranchesAtom, loadAgentBranch } from "./agentbranchstore";
import { confirmCloseSession } from "./agentactions";
import type { AgentsViewModel } from "./agents";
import { buildAgentTree, treeAgentCount } from "./agenttreemodel";
import { renamingRowAtom } from "./rowrenameatom";
import { duplicateSession, renameSession, sessionCustomLabel } from "./session-models/sessionsidebarmodel";
import { displayAgeMs, formatAgeShort, type AgentVM } from "./agentsviewmodel";
import { endedWorkerId, laneLabel, runProgress, workerAsk, workerSubtext, type RunInfo } from "./runlineage";
import { toggleRunCollapsed, toggleRunDoneOpen, treeFoldsAtom, useRunDigests } from "./runlineagestore";
import {
    getSubagentExpandAtom,
    toggleSubagentExpand,
} from "./session-models/agentstatusstore";
import {
    labelChanged,
    subagentExpanded,
    visibleSubagents,
    type SubagentState,
} from "./session-models/sessionviewmodel";
import { StatusDot } from "./statusdot";
import { focusSubagentAtom, subagentsByIdAtom } from "./subagentsstore";
import { useSubagentTracking } from "./subagenttracking";

const STATE_COLOR: Record<AgentVM["state"], string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};
const STATE_LABEL: Record<AgentVM["state"], string> = { asking: "asking", working: "working", idle: "idle" };
const SUB_COLOR: Record<SubagentState, string> = {
    working: "var(--color-accent)",
    success: "var(--color-success)",
    failure: "var(--color-error)",
    done: "var(--color-muted)",
};

function startRowRename(tabId: string): void {
    globalStore.set(renamingRowAtom, tabId);
}

// Scoped to one row on purpose: starting a rename on a second row has already moved the atom, and the
// first box unmounting must not then cancel the box that replaced it.
function endRowRename(tabId: string): void {
    if (globalStore.get(renamingRowAtom) === tabId) {
        globalStore.set(renamingRowAtom, null);
    }
}

// The inline rename editor, shared by both row kinds — a session is a tab either way, so both rename
// through the same `session:label` meta. Mounted in place of the row's name while renaming, which is
// why the seed is read on mount: this component's whole lifetime IS the edit.
function RenameBox({ tabId }: { tabId: string }) {
    const [initial] = useState(() => sessionCustomLabel(tabId));
    const [draft, setDraft] = useState(initial);
    // Enter and blur both mean commit and Escape means cancel, but removing a focused input also
    // fires blur — so without this latch, cancelling would immediately commit the draft it discarded.
    const settled = useRef(false);
    const finish = (save: boolean) => {
        if (settled.current) {
            return;
        }
        settled.current = true;
        if (save && labelChanged(draft, initial)) {
            renameSession(tabId, draft);
        }
        endRowRename(tabId);
    };
    // The row can vanish under an open box — its session closed, or the agent exited — and React does
    // not deliver blur to an unmounting input. Without this the atom would keep naming a dead tab and
    // the Escape guard in bindings.ts would go on yielding to a box nobody can see.
    useEffect(() => () => endRowRename(tabId), [tabId]);
    return (
        <input
            autoFocus
            value={draft}
            // the row itself is a click target (select/focus); a click meant for the caret is not one
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    finish(true);
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    finish(false);
                }
            }}
            onBlur={() => finish(true)}
            placeholder="Name this session"
            aria-label="Session name"
            className="w-full min-w-0 rounded-[5px] border border-accent bg-surface px-1 font-mono text-[12px] font-semibold text-primary focus:outline-none"
        />
    );
}

// The run glyph marks a row that stands for an orchestrator run: its lead, or the run itself before one.
function RunGlyph() {
    return <span className="mr-[5px] text-[10px] text-accent-soft">◆</span>;
}

// The elbow marks a row nested under a run.
function Elbow() {
    return (
        <span className="absolute left-[12px] top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-ink-faint">
            ↳
        </span>
    );
}

// RunSubline is a run row's second line: a chip folding its workers away, and how far the plan is.
function RunSubline({ run, open, live, leadless }: { run: RunInfo; open: boolean; live: number; leadless?: boolean }) {
    if (run.dag == null) {
        return <div className="truncate text-[10.5px] text-muted">planning</div>;
    }
    const { done, total } = runProgress(run.dag);
    const chip = live > 0 || done === 0 ? `${live} ${live === 1 ? "worker" : "workers"}` : `${done} done`;
    let progress = `${done}/${total} done`;
    if (run.dag.status === "done") {
        progress = "run complete";
    } else if (leadless) {
        progress = `${done}/${total} · ${run.leadStarted ? "lead closed" : "lead not started"}`;
    }
    return (
        <div className="mt-[2px] flex min-w-0 items-center gap-[6px]">
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    toggleRunCollapsed(run.runId);
                }}
                title={open ? "Hide workers" : "Show workers"}
                className="flex flex-none items-center gap-[3px] rounded-sm border border-edge-mid bg-surface-hover px-[5px] font-mono text-[9.5px] font-semibold text-muted hover:border-accent hover:text-accent-soft"
            >
                <span className="text-xxxs leading-none">{open ? "▾" : "▸"}</span>
                {chip}
            </button>
            <span className="truncate text-[10.5px] text-muted">{progress}</span>
        </div>
    );
}

function ParentRow({
    model,
    agent,
    lead,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    lead?: { run: RunInfo; open: boolean; live: number };
}) {
    const focusId = useAtomValue(model.focusIdAtom);
    const branch = useAtomValue(agentBranchesAtom)[agent.id];
    const oref = `block:${agent.blockId}`;
    // drop children that finished (success/done) so a completed fan-out doesn't linger in the tree
    const subs = visibleSubagents(useAtomValue(subagentsByIdAtom)[agent.id] ?? []);
    const expandOverride = useAtomValue(getSubagentExpandAtom(oref));
    const expanded = subagentExpanded(subs, expandOverride);
    const selected = focusId === agent.id;
    const asking = agent.state === "asking";
    // m4: one-shot settle when this agent reaches idle (working/asking -> idle)
    const settling = useSettle(agent.state === "idle");

    const renaming = useAtomValue(renamingRowAtom) === agent.id;

    const select = () => {
        globalStore.set(model.focusIdAtom, agent.id);
        globalStore.set(model.focusReplyAtom, false);
    };
    const onContextMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = [
            { label: "Rename", icon: <Pencil size={15} />, click: () => startRowRename(agent.id) },
            { label: "Duplicate", icon: <CopyPlus size={15} />, click: () => duplicateSession(model, agent.id) },
            {
                label: "Copy name",
                icon: <Copy size={15} />,
                click: () => void navigator.clipboard.writeText(agent.name),
            },
            { type: "separator" },
            {
                label: "Close agent",
                icon: <X size={15} />,
                danger: true,
                click: () => confirmCloseSession(agent),
            },
        ];
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    // The animating motion.div wrapper lives in AgentTree (direct AnimatePresence child, required for
    // popLayout to pop an exiting row out of flow). This is just the row body + subagent reveal.
    return (
        <>
            <div
                onClick={select}
                onContextMenu={onContextMenu}
                className={cn(
                    "relative flex cursor-pointer items-center gap-[9px] rounded-[9px] px-[11px] py-[10px] transition-colors duration-[140ms]",
                    // m3 attention: a static amber tint marks an asking row (the pulse lives in the dot, not the row);
                    // selection wins the background so the focused row still reads as focused.
                    selected ? "bg-accentbg" : asking ? "bg-warning/[0.06]" : "hover:bg-surface-hover",
                    settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                )}
            >
                <StatusDot state={agent.state} pulse={agent.state !== "idle"} className="!h-[7px] !w-[7px]" />
                <div className="min-w-0 flex-1">
                    {renaming ? (
                        <RenameBox tabId={agent.id} />
                    ) : (
                        <div className="truncate font-mono text-[12px] font-semibold text-ink-hi">
                            {lead ? <RunGlyph /> : null}
                            {agent.name}
                        </div>
                    )}
                    {lead ? (
                        <RunSubline run={lead.run} open={lead.open} live={lead.live} />
                    ) : (
                        <div className="truncate text-[10.5px] text-muted">{branch || "—"}</div>
                    )}
                </div>
                {subs.length > 0 ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleSubagentExpand(oref, expanded);
                        }}
                        title="Toggle subagents"
                        className="flex items-center gap-[3px] rounded-sm border border-edge-mid bg-surface-hover px-[6px] py-[2px] font-mono text-[9.5px] font-semibold text-muted hover:border-accent hover:text-accent-soft"
                    >
                        <span className="text-xxxs leading-none">{expanded ? "▾" : "▸"}</span>
                        {subs.length}
                    </button>
                ) : null}
                <span className="font-mono text-[10px] font-medium transition-colors duration-[140ms]" style={{ color: STATE_COLOR[agent.state] }}>
                    {STATE_LABEL[agent.state]}
                </span>
            </div>
            {/* subagent reveal: the children block expands/collapses via composerReveal (height+opacity).
                It is not a layout node itself, so its height animation and the row-list reflow don't fight. */}
            <AnimatePresence initial={false}>
                {expanded ? (
                    <motion.div key="subs" variants={composerReveal} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
                        {subs.map((s) => (
                            <div
                                key={s.id}
                                onClick={() => {
                                    if (!s.transcriptPath) {
                                        return;
                                    }
                                    globalStore.set(model.focusIdAtom, agent.id);
                                    globalStore.set(focusSubagentAtom, {
                                        parentId: agent.id,
                                        agentId: s.id,
                                        transcriptPath: s.transcriptPath,
                                        label: s.type || "subagent",
                                    });
                                }}
                                className={cn(
                                    "relative flex items-center gap-[8px] rounded-[9px] py-[7px] pl-[28px] pr-[10px] hover:bg-surface-hover",
                                    s.transcriptPath && "cursor-pointer"
                                )}
                            >
                                <span className="absolute left-[13px] top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-ink-faint">
                                    ↳
                                </span>
                                <span
                                    className="h-[5px] w-[5px] shrink-0 rounded-full"
                                    style={{ background: SUB_COLOR[s.state] }}
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-mono text-[11px] font-semibold text-muted-foreground">
                                        {s.type || "subagent"}
                                    </div>
                                    <div className="truncate text-[9.5px] text-muted">{s.model ?? ""}</div>
                                </div>
                                <span
                                    className="whitespace-nowrap font-mono text-[9.5px] font-medium"
                                    style={{ color: SUB_COLOR[s.state] }}
                                >
                                    {s.state}
                                </span>
                            </div>
                        ))}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </>
    );
}

// A run with workers in the roster and no lead there: a plan-path run before its first judgment event, or
// one whose lead session was closed. Its workers nest under it the way they would under a lead.
function RunRow({ run, open, live }: { run: RunInfo; open: boolean; live: number }) {
    return (
        <div className="relative flex items-center gap-[9px] rounded-[9px] px-[11px] py-[10px]">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full border border-muted" />
            <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px] font-semibold text-ink-hi">
                    <RunGlyph />
                    {run.title}
                </div>
                <RunSubline run={run} open={open} live={live} leadless />
            </div>
            <span className="whitespace-nowrap font-mono text-[10px] font-medium text-muted">no lead</span>
        </div>
    );
}

// A task's worker under its run. A done task's worker opens as its read-only transcript, whether or not its tab
// is still in the roster, so the run's history stays readable after its sessions close.
function WorkerRow({
    model,
    run,
    task,
    agent,
}: {
    model: AgentsViewModel;
    run: RunInfo;
    task: TaskNode;
    agent?: AgentVM;
}) {
    const focusId = useAtomValue(model.focusIdAtom);
    const now = useAtomValue(model.nowAtom);
    const done = task.state === "done";
    const lane = laneLabel(run.digest, task.id);
    const ask = done ? undefined : workerAsk(run.digest, task.id);
    const focusKey = done ? endedWorkerId(run.runId, task.id) : agent?.id;
    const selected = focusKey != null && focusId === focusKey;
    const landed = task.merged ? "landed" : "done";

    let sub: string;
    let stateText: string;
    let stateColor: string;
    if (done) {
        sub = [lane ? `lane ${lane}` : "", landed].filter(Boolean).join(" · ");
        stateText = landed;
        stateColor = "var(--color-success)";
    } else {
        sub = workerSubtext(ask, lane, agent ? formatAgeShort(displayAgeMs(agent, now)) : "", now);
        stateText = ask?.owner === "lead" ? "→ lead" : agent ? STATE_LABEL[agent.state] : task.state;
        stateColor = ask?.owner === "lead" || agent == null ? "var(--color-muted)" : STATE_COLOR[agent.state];
    }

    const select = () => {
        if (focusKey == null) {
            return;
        }
        globalStore.set(model.focusIdAtom, focusKey);
        globalStore.set(model.focusReplyAtom, false);
    };
    const onContextMenu = (e: React.MouseEvent) => {
        if (agent == null) {
            return;
        }
        const items: ContextMenuItem[] = [
            { label: "Close agent", icon: <X size={15} />, danger: true, click: () => confirmCloseSession(agent) },
        ];
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };

    return (
        <div
            onClick={select}
            onContextMenu={onContextMenu}
            className={cn(
                "relative flex items-center gap-[9px] rounded-[9px] py-[8px] pl-[28px] pr-[11px] transition-colors duration-[140ms]",
                focusKey != null && "cursor-pointer",
                selected
                    ? "bg-accentbg"
                    : ask?.owner === "you"
                      ? "bg-warning/[0.06]"
                      : focusKey != null && "hover:bg-surface-hover"
            )}
        >
            <Elbow />
            {done || agent == null ? (
                <span
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: done ? "var(--color-success)" : "var(--color-muted)" }}
                />
            ) : (
                <StatusDot state={agent.state} pulse={agent.state !== "idle"} className="!h-[7px] !w-[7px]" />
            )}
            <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11.5px] font-semibold text-ink-hi">
                    {task.id} · {task.label || task.id}
                </div>
                <div className="truncate text-[10.5px] text-muted">{sub}</div>
            </div>
            <span className="whitespace-nowrap font-mono text-[10px] font-medium" style={{ color: stateColor }}>
                {stateText}
            </span>
        </div>
    );
}

// The fold holding a run's done workers.
function DoneRow({ run, count, open }: { run: RunInfo; count: number; open: boolean }) {
    return (
        <div
            onClick={() => toggleRunDoneOpen(run.runId)}
            className="relative flex cursor-pointer items-center gap-[8px] rounded-[9px] py-[6px] pl-[28px] pr-[11px] font-mono text-[10.5px] text-muted hover:bg-surface-hover hover:text-secondary"
        >
            <Elbow />
            <span className="text-success">✓</span>
            {count} done
            <span className="ml-auto">{open ? "▾" : "▸"}</span>
        </div>
    );
}

// A background terminal row: no agent chrome (no status dot / model / subagents) — just a glyph +
// name that focuses the terminal's block in the surface's focus pane.
function TerminalRow({ model, terminal }: { model: AgentsViewModel; terminal: AgentVM }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const selected = focusId === terminal.id;
    const renaming = useAtomValue(renamingRowAtom) === terminal.id;
    const select = () => {
        globalStore.set(model.focusIdAtom, terminal.id);
        globalStore.set(model.focusReplyAtom, false);
    };
    // The same actions an agent row offers, minus the agent-only wording: a terminal duplicates into a
    // fresh shell in the same cwd (buildDuplicateBlockMeta copies only launch keys). Rename matters
    // more here than on an agent row — a terminal has no ai-title to name it, so without a rename it
    // is stuck forever on the launch-time label it shares with every other shell in the repo.
    const onContextMenu = (e: React.MouseEvent) => {
        const items: ContextMenuItem[] = [
            { label: "Rename", icon: <Pencil size={15} />, click: () => startRowRename(terminal.id) },
            { label: "Duplicate", icon: <CopyPlus size={15} />, click: () => duplicateSession(model, terminal.id) },
            {
                label: "Copy name",
                icon: <Copy size={15} />,
                click: () => void navigator.clipboard.writeText(terminal.name),
            },
            { type: "separator" },
            {
                label: "Close terminal",
                icon: <X size={15} />,
                danger: true,
                click: () => confirmCloseSession(terminal),
            },
        ];
        ContextMenuModel.getInstance().showContextMenu(items, e);
    };
    return (
        <div
            onClick={select}
            onContextMenu={onContextMenu}
            className={cn(
                "relative flex cursor-pointer items-center gap-[9px] rounded-[9px] px-[11px] py-[10px] transition-colors duration-[140ms]",
                selected ? "bg-accentbg" : "hover:bg-surface-hover"
            )}
        >
            <span className="w-[7px] shrink-0 text-center font-mono text-[11px] leading-none text-muted">›_</span>
            <div className="min-w-0 flex-1">
                {renaming ? (
                    <RenameBox tabId={terminal.id} />
                ) : (
                    <div className="truncate font-mono text-[12px] font-semibold text-ink-hi">{terminal.name}</div>
                )}
            </div>
            <span className="font-mono text-[10px] font-medium text-muted">terminal</span>
        </div>
    );
}

export function AgentTree({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const terminals = useAtomValue(model.terminalsAtom);
    const order = useAtomValue(model.orderAtom);
    const lineage = useAtomValue(model.lineageAtom);
    const folds = useAtomValue(treeFoldsAtom);
    const rows = buildAgentTree(agents, order, lineage, folds);

    useRunDigests(Object.values(lineage.runs));

    useSubagentTracking(agents);

    // resolve each agent's real branch for its row (cached per cwd-source; see agentbranchstore.ts)
    useEffect(() => {
        for (const a of agents) {
            void loadAgentBranch(a.id, a.transcriptPath, a.blockId);
        }
    }, [agents.map((a) => `${a.id}:${a.transcriptPath ?? ""}:${a.blockId ?? ""}`).join(",")]);

    // no-cascade guard (single constant key — the surface has one roster): mounting or switching to the
    // surface seeds silently, so only agents/terminals that arrive after mount fade in. See motiontokens.ts.
    const rowIds = [...agents.map((a) => a.id), ...terminals.map((t) => t.id)];
    const entranceRef = useRef(initialEntranceState());
    const { animate: entranceIds } = computeEntrances(entranceRef.current, "agents", rowIds);
    const idsKey = rowIds.join(",");
    useLayoutEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, "agents", rowIds).state;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idsKey]);

    return (
        <div data-agent-tree className="flex w-[248px] shrink-0 flex-col border-r border-border bg-surface">
            <div className="border-b border-edge-faint px-[16px] pb-[12px] pt-[16px]">
                <div className="flex items-center justify-between">
                    <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-ink-mid">Agents</h3>
                    <span className="font-mono text-[11px] font-semibold text-muted">{treeAgentCount(rows)}</span>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-[8px]">
                <AnimatePresence mode="popLayout" initial={false}>
                    {rows.map((r) => {
                        if (r.kind === "group") {
                            return (
                                <motion.div
                                    key={`g-${r.project}`}
                                    layout="position"
                                    className="flex items-center gap-[8px] px-[11px] pb-[6px] pt-[14px]"
                                >
                                    <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                                        {r.project}
                                    </span>
                                    <div className="h-px flex-1 bg-edge-faint" />
                                    {r.attn > 0 ? (
                                        <span className="rounded-[5px] bg-warning/10 px-[6px] py-[1px] font-mono text-[9.5px] font-semibold text-warning">
                                            {r.attn}
                                        </span>
                                    ) : null}
                                    <span className="font-mono text-[10px] font-semibold text-feed-time">{r.count}</span>
                                </motion.div>
                            );
                        }
                        // an agent's row keeps the agent's key wherever it moves (a worker folding into done, an
                        // agent nesting once its run loads), so the move animates instead of remounting
                        let key: string;
                        let body: React.ReactNode;
                        switch (r.kind) {
                            case "parent":
                                key = r.agent.id;
                                body = <ParentRow model={model} agent={r.agent} />;
                                break;
                            case "lead":
                                key = r.agent.id;
                                body = (
                                    <ParentRow
                                        model={model}
                                        agent={r.agent}
                                        lead={{ run: r.run, open: r.open, live: r.live }}
                                    />
                                );
                                break;
                            case "run":
                                key = `run-${r.run.runId}`;
                                body = <RunRow run={r.run} open={r.open} live={r.live} />;
                                break;
                            case "worker":
                                key = r.agent?.id ?? `task-${r.run.runId}-${r.task.id}`;
                                body = <WorkerRow model={model} run={r.run} task={r.task} agent={r.agent} />;
                                break;
                            case "done":
                                key = `done-${r.run.runId}`;
                                body = <DoneRow run={r.run} count={r.count} open={r.open} />;
                                break;
                        }
                        // layout="position" so a subagent expand doesn't scale-distort the row — only its
                        // position animates on reflow. Must be the direct AnimatePresence child: popLayout
                        // measures it via ref to pop an exiting row out of flow (else its space lingers).
                        return (
                            <motion.div
                                key={key}
                                layout="position"
                                variants={cardVariants}
                                initial={entranceIds.has(key) ? "initial" : false}
                                animate="animate"
                                exit="exit"
                            >
                                {body}
                            </motion.div>
                        );
                    })}
                    {terminals.length > 0 ? (
                        <motion.div
                            key="terminals-header"
                            layout="position"
                            className="flex items-center gap-[8px] px-[11px] pb-[6px] pt-[14px]"
                        >
                            <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                                Terminals
                            </span>
                            <div className="h-px flex-1 bg-edge-faint" />
                            <span className="font-mono text-[10px] font-semibold text-feed-time">{terminals.length}</span>
                        </motion.div>
                    ) : null}
                    {terminals.map((t) => (
                        <motion.div
                            key={t.id}
                            layout="position"
                            variants={cardVariants}
                            initial={entranceIds.has(t.id) ? "initial" : false}
                            animate="animate"
                            exit="exit"
                        >
                            <TerminalRow model={model} terminal={t} />
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
        </div>
    );
}
