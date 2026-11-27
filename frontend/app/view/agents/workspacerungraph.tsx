// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run tab's Graph view: In flight chips, Lanes (every task beside a git-graph gutter, hover lights a chain) and
// Focus (one task as its centre card, its deps above and dependents below). The mode, the selection and the back
// trail are the tab's graph state, moved only through workspacerungraphmodel's transitions; hover is the only local
// state.

import { morphTransition } from "@/app/element/motiontokens";
import { StepSwap } from "@/app/element/stepswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { globalStore } from "@/app/store/jotaiStore";
import { openTaskWorker, resolveTaskWorker, type TaskWorkerView } from "@/app/view/orchestrate/taskcorrelate";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { openAgentDiff } from "./agentdiffnav";
import type { AgentsViewModel } from "./agents";
import { diffStatsByIdAtom } from "./cardgitstore";
import { runFinished } from "./runlineage";
import { tabKey, type RunGraphState } from "./workspacemodel";
import { FocusCentreCard } from "./workspacerunfocuscard";
import {
    backFrom,
    chainOf,
    flightIds,
    focusLayout,
    focusOn,
    focusRowLabel,
    focusView,
    graphNodes,
    gutterPath,
    laneLayout,
    LANES,
    laneWord,
    moveTo,
    stepDir,
    timedWord,
    toFocus,
    toLanes,
    type FocusBox,
    type FocusView,
    type GraphNode,
    type LaneLayout,
} from "./workspacerungraphmodel";
import type { RunViewProps } from "./workspaceruntab";
import { finalRow, planReviewRow, ROW_DOT, type RowDot, type StageRowView } from "./workspaceruntabmodel";
import { STATE_TEXT, useChildRuns } from "./workspaceruntasks";
import { openBeside, updateWorkspaceTab } from "./workspacestore";

// the canvas's gutter: 34px rows, lanes 13px apart, the first lane 10px in (gutterPath matches it to the pixel)
const GEO = { rowH: 34, laneW: 13, x0: 10 };
const DOT_PX = 10;
const ROW_GAP_PX = 4;

// a stage that has not started is the canvas's dashed ring, not a task's faint dot
function stageDot(dot: RowDot): string {
    return dot === "waits" ? "border-[1.5px] border-dashed border-muted" : ROW_DOT[dot];
}

type SetGraph = (next: RunGraphState) => void;

// the run's Changes tab holds merged work only, so a running worker's changes open as its own diff; the Diff surface
// follows focus, so the worker takes it first, as the cockpit's Review changes does
function openWorkerDiff(model: AgentsViewModel, worker: TaskWorkerView): void {
    globalStore.set(model.focusIdAtom, worker.agent.id);
    openAgentDiff(model, worker.agent);
}

export function GraphView({ model, agent, tab, run, asks, events }: RunViewProps) {
    const now = useAtomValue(model.nowAtom);
    const dag = run.dag;
    const children = useChildRuns(dag);
    const roster = useAtomValue(model.agentsAtom);
    // the shell keeps every live agent's own changes here, so a running task's card reads its worker's
    const liveDiffs = useAtomValue(diffStatsByIdAtom);
    const nodes = useMemo(() => graphNodes(dag, run.digest, events, now), [dag, run.digest, events, now]);
    const layout = useMemo(() => laneLayout(nodes), [nodes]);
    const g = tab.graph ?? LANES;
    // moment 10's side, read from the step just taken, whoever took it (a click here, Esc, a Report link)
    const prev = useRef<RunGraphState | undefined>(undefined);
    const dir = useRef(1);
    if (prev.current !== g) {
        dir.current = stepDir(prev.current, g);
        prev.current = g;
    }
    if (dag == null || nodes.length === 0) {
        return (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">
                No plan submitted yet, so there is no graph.
            </div>
        );
    }
    const set: SetGraph = (next) => updateWorkspaceTab(agent.id, tabKey(tab), { graph: next });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const focus = g.mode === "focus" && g.focus != null && byId.has(g.focus) ? g.focus : null;
    const flights = flightIds(nodes);
    const planReview = planReviewRow(dag, events, now);
    const final = finalRow(dag, events, now);
    const centreCard = (id: string) => {
        const task = dag.tasks.find((t) => t.id === id);
        const node = byId.get(id);
        const worker = resolveTaskWorker(task, children[id], roster);
        return (
            <FocusCentreCard
                task={task}
                dot={node.dot}
                state={timedWord(node)}
                waitsOn={node.waitsOn}
                finished={runFinished(run)}
                ask={asks.find((a) => a.taskid === id)}
                evidence={children[id]?.evidence}
                live={worker.tabId ? liveDiffs[worker.tabId] : undefined}
                run={run}
                onOpenAgent={() => openTaskWorker(worker, model)}
                onOpenChanges={(selected) =>
                    selected || worker.agent == null
                        ? openBeside(model, agent.id, { kind: "changes", selected })
                        : openWorkerDiff(model, worker)
                }
            />
        );
    };
    return (
        <div data-workspace-run-graph data-graph-mode={focus ? "focus" : "lanes"} className="flex flex-col">
            <GraphBar
                g={g}
                focus={focus}
                flights={flights.map((id) => byId.get(id))}
                set={set}
                fallback={flights[0] ?? layout.rows[0]}
            />
            <StepSwap stepKey={focus ? `focus:${focus}` : "lanes"} dir={dir.current}>
                {focus ? (
                    <FocusBoard
                        view={focusView(nodes, focus)}
                        byId={byId}
                        planReview={planReview}
                        final={final}
                        centre={centreCard(focus)}
                        onMove={(id) => set(moveTo(g, id))}
                    />
                ) : (
                    <Lanes
                        layout={layout}
                        byId={byId}
                        selected={g.focus}
                        planReview={planReview}
                        final={final}
                        onPick={(id) => set(focusOn(id))}
                    />
                )}
            </StepSwap>
        </div>
    );
}

function GraphBar({
    g,
    focus,
    flights,
    set,
    fallback,
}: {
    g: RunGraphState;
    focus: string | null;
    flights: GraphNode[];
    set: SetGraph;
    fallback: string;
}) {
    const crumb = focus && g.trail.length > 0 ? g.trail[g.trail.length - 1] : null;
    return (
        <div className="flex flex-wrap items-center gap-[6px] px-[18px] pb-[10px]">
            <span className="mr-[2px] text-[12px] text-muted">In flight</span>
            {flights.map((n) => (
                <FlightChip key={n.id} node={n} on={g.focus === n.id} onPick={() => set(focusOn(n.id))} />
            ))}
            <span className="flex-1" />
            {crumb ? (
                <button
                    type="button"
                    data-graph-back={crumb}
                    onClick={() => set(backFrom(g))}
                    className="cursor-pointer rounded-[6px] border border-edge-mid px-[9px] py-[3px] text-[12px] text-secondary hover:text-primary"
                >
                    ← {crumb}
                </button>
            ) : null}
            <div
                role="tablist"
                aria-label="Graph view"
                className="flex overflow-hidden rounded-[6px] border border-edge-mid text-[12px]"
            >
                <ModeButton
                    label="Lanes"
                    title="Lanes (Esc from Focus)"
                    active={!focus}
                    onPick={() => set(toLanes(g))}
                />
                <ModeButton label="Focus" active={!!focus} onPick={() => set(toFocus(g, fallback))} />
            </div>
        </div>
    );
}

// the selected chip's tint is one shared layoutId, so a new selection moves it (moment 17)
function FlightChip({ node, on, onPick }: { node: GraphNode; on: boolean; onPick: () => void }) {
    return (
        <button
            type="button"
            data-graph-chip={node.id}
            aria-pressed={on}
            title={`${node.id} · ${node.name} · ${node.word}`}
            onClick={onPick}
            className="relative inline-flex cursor-pointer items-center gap-[6px] rounded-full border border-edge-mid px-[9px] py-[3px] text-[12px] text-secondary"
        >
            {on ? (
                <motion.span
                    layoutId="workspace-run-graph-chip"
                    aria-hidden
                    transition={morphTransition}
                    className="absolute inset-[-1px] rounded-full border border-accent bg-accentbg"
                />
            ) : null}
            <span className={cn("relative h-[7px] w-[7px] rounded-full", ROW_DOT[node.dot])} />
            <span className="relative font-mono text-[11.5px]">{node.id}</span>
        </button>
    );
}

function ModeButton({
    label,
    title,
    active,
    onPick,
}: {
    label: string;
    title?: string;
    active: boolean;
    onPick: () => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            data-graph-mode-pick={label.toLowerCase()}
            title={title}
            onClick={onPick}
            className={cn(
                "relative cursor-pointer px-[10px] py-[4px]",
                active ? "text-primary" : "text-muted hover:text-secondary"
            )}
        >
            {active ? (
                <motion.span
                    layoutId="workspace-run-graph-mode"
                    aria-hidden
                    transition={morphTransition}
                    className="absolute inset-0 bg-surface-selected"
                />
            ) : null}
            <span className="relative">{label}</span>
        </button>
    );
}

function StageLine({ stage, row }: { stage: string; row: StageRowView }) {
    return (
        <div
            data-graph-stage={stage}
            className="flex h-[34px] items-center gap-[10px] pl-[5px] text-[12.5px] text-ink-mid"
        >
            <span className={cn("box-border h-[10px] w-[10px] flex-none rounded-full", stageDot(row.dot))} />
            {row.label}
            <span data-graph-stage-word className="font-mono text-[11px] text-muted">
                {row.word}
            </span>
        </div>
    );
}

function Lanes({
    layout,
    byId,
    selected,
    planReview,
    final,
    onPick,
}: {
    layout: LaneLayout;
    byId: Map<string, GraphNode>;
    selected: string | null;
    planReview: StageRowView | null;
    final: StageRowView | null;
    onPick: (id: string) => void;
}) {
    const [hover, setHover] = useState<string | null>(null);
    const lit = hover ?? selected;
    const chain = lit != null && byId.has(lit) ? chainOf(layout.edges, lit) : null;
    const gutterW = GEO.x0 * 2 + Math.max(0, layout.laneCount - 1) * GEO.laneW;
    const height = layout.rows.length * GEO.rowH;
    const laneX = (id: string) => GEO.x0 + layout.lane[id] * GEO.laneW;
    return (
        <div data-graph-lanes data-lane-count={layout.laneCount} className="px-[18px] pb-[18px]">
            {planReview ? <StageLine stage="plan-review" row={planReview} /> : null}
            <div className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
                <svg width={gutterW} height={height} className="absolute left-0 top-0" aria-hidden>
                    {layout.edges.map((e) => {
                        const on = chain != null && chain.has(e[0]) && chain.has(e[1]);
                        return (
                            <path
                                key={`${e[0]}>${e[1]}`}
                                data-graph-edge={`${e[0]}>${e[1]}`}
                                data-lit={on ? "1" : "0"}
                                d={gutterPath(layout, e, GEO)}
                                fill="none"
                                strokeWidth={1.6}
                                strokeLinecap="round"
                                className={cn(
                                    on ? "stroke-accent" : "stroke-edge-strong",
                                    chain && !on && "opacity-30"
                                )}
                            />
                        );
                    })}
                </svg>
                {layout.rows.map((id, r) => (
                    <LaneRow
                        key={id}
                        node={byId.get(id)}
                        top={r * GEO.rowH}
                        indent={gutterW + ROW_GAP_PX}
                        selected={selected === id}
                        hovered={hover === id}
                        dimmed={chain != null && !chain.has(id)}
                        onHover={setHover}
                        onPick={onPick}
                    />
                ))}
                {layout.rows.map((id, r) => (
                    <span
                        key={id}
                        data-graph-dot={id}
                        data-lane={layout.lane[id]}
                        className={cn(
                            "pointer-events-none absolute box-border rounded-full border-2 border-surface",
                            ROW_DOT[byId.get(id).dot]
                        )}
                        style={{
                            left: laneX(id) - DOT_PX / 2,
                            top: r * GEO.rowH + GEO.rowH / 2 - DOT_PX / 2,
                            width: DOT_PX,
                            height: DOT_PX,
                        }}
                    />
                ))}
            </div>
            {final ? <StageLine stage="final" row={final} /> : null}
        </div>
    );
}

// the selected row's tint is one shared layoutId, so a new selection moves it (moment 17)
function LaneRow({
    node,
    top,
    indent,
    selected,
    hovered,
    dimmed,
    onHover,
    onPick,
}: {
    node: GraphNode;
    top: number;
    indent: number;
    selected: boolean;
    hovered: boolean;
    dimmed: boolean;
    onHover: (id: string | null) => void;
    onPick: (id: string) => void;
}) {
    return (
        <button
            type="button"
            data-graph-row={node.id}
            data-lit={dimmed ? "0" : "1"}
            data-selected={selected ? "1" : "0"}
            onClick={() => onPick(node.id)}
            onMouseEnter={() => onHover(node.id)}
            onFocus={() => onHover(node.id)}
            onBlur={() => onHover(null)}
            className={cn(
                "absolute left-0 right-0 box-border flex cursor-pointer items-center gap-[10px] rounded-[6px] pr-[10px] text-left",
                hovered && !selected && "bg-surface-hover",
                dimmed && "opacity-35"
            )}
            style={{ top, height: GEO.rowH, paddingLeft: indent }}
        >
            {selected ? (
                <motion.span
                    layoutId="workspace-run-graph-row"
                    aria-hidden
                    transition={morphTransition}
                    className="absolute inset-0 rounded-[6px] bg-surface-selected"
                />
            ) : null}
            <span className="relative w-[30px] flex-none font-mono text-[11px] text-muted">{node.id}</span>
            <span
                className={cn(
                    "relative min-w-0 flex-1 truncate text-[13px]",
                    node.dot === "waits" ? "text-ink-mid" : "text-secondary"
                )}
            >
                {node.name}
            </span>
            <span data-graph-word className={cn("relative flex-none text-[12px]", STATE_TEXT[node.dot])}>
                {laneWord(node)}
            </span>
            {hovered ? (
                <span data-graph-focus-hint className="relative flex-none text-[12px] text-muted">
                    Focus →
                </span>
            ) : null}
        </button>
    );
}

// the Focus board's width before it is measured: the default pane's
const FOCUS_W = 564;
// the centre's height before it is measured: a card with one line under its name
const CENTRE_H = 100;
const MORE_GAP = 10;

function FocusBoard({
    view,
    byId,
    planReview,
    final,
    centre,
    onMove,
}: {
    view: FocusView;
    byId: Map<string, GraphNode>;
    planReview: StageRowView | null;
    final: StageRowView | null;
    centre: ReactNode;
    onMove: (id: string) => void;
}) {
    const [boardRef, , rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const [centreRef, , centreRect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const width = rect?.width || FOCUS_W;
    const l = focusLayout(view, {
        width,
        centreH: centreRect?.height || CENTRE_H,
        planReview: planReview != null,
        final: final != null,
    });
    const rowOf = (side: "up" | "down") => l.boxes.filter((b) => b.side === side);
    return (
        <div data-graph-focus={view.centre} className="flex flex-col pb-[18px]">
            <div className="px-[18px]">
                <div ref={boardRef} data-graph-board className="relative" style={{ height: l.height }}>
                    <svg
                        width={width}
                        height={l.height}
                        className="pointer-events-none absolute left-0 top-0 overflow-visible"
                        aria-hidden
                    >
                        <g
                            className="fill-none stroke-edge-strong"
                            strokeWidth={1.5}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            {l.edges.map((e, i) => (
                                <Fragment key={i}>
                                    <path d={e.d} />
                                    <path d={e.arrow} />
                                </Fragment>
                            ))}
                        </g>
                    </svg>
                    {(["up", "down"] as const).map((side) => {
                        const first = rowOf(side)[0];
                        return first ? (
                            <span
                                key={side}
                                data-graph-row-label={side}
                                className="absolute left-0 flex items-center text-[11.5px] text-muted"
                                style={{ top: first.y, height: first.h }}
                            >
                                {focusRowLabel(view, side)}
                            </span>
                        ) : null;
                    })}
                    {l.boxes.map((b) =>
                        b.side === "centre" ? (
                            <div
                                key={b.id}
                                ref={centreRef}
                                data-graph-node={b.id}
                                data-side="centre"
                                className="absolute"
                                style={{ left: b.x, top: b.y, width: b.w }}
                            >
                                {centre}
                            </div>
                        ) : b.stage ? (
                            <StageNode key={b.stage} box={b} row={b.stage === "final" ? final : planReview} />
                        ) : (
                            <NeighbourCard key={b.id} box={b} node={byId.get(b.id)} onMove={onMove} />
                        )
                    )}
                    <MorePill side="up" row={rowOf("up")} rest={view.upMore} onMove={onMove} />
                    <MorePill side="down" row={rowOf("down")} rest={view.downMore} onMove={onMove} />
                </div>
            </div>
            <div data-graph-hint className="px-[18px] pt-[14px] text-[12px] text-ink-faint">
                click a task to move to it · Esc for Lanes
            </div>
        </div>
    );
}

// a neighbour carries its short word, no time; a click moves Focus to it
function NeighbourCard({ box, node, onMove }: { box: FocusBox; node: GraphNode; onMove: (id: string) => void }) {
    return (
        <button
            type="button"
            data-graph-node={node.id}
            data-side={box.side}
            title={`${node.id} · ${node.name} · ${node.word}`}
            onClick={() => onMove(node.id)}
            className="absolute box-border flex cursor-pointer flex-col justify-center gap-[3px] rounded-[10px] border border-edge-strong bg-background px-[12px] text-left hover:bg-surface-hover"
            style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        >
            <span className="flex items-center gap-[7px]">
                <span className={cn("h-[8px] w-[8px] flex-none rounded-full", ROW_DOT[node.dot])} />
                <span className="min-w-0 flex-1 font-mono text-[11px] text-muted">{node.id}</span>
                <span data-graph-node-word className={cn("truncate text-[11.5px]", STATE_TEXT[node.dot])}>
                    {node.word}
                </span>
            </span>
            <span className={cn("truncate text-[12.5px]", node.dot === "waits" ? "text-ink-mid" : "text-secondary")}>
                {node.name}
            </span>
        </button>
    );
}

function StageNode({ box, row }: { box: FocusBox; row: StageRowView }) {
    return (
        <div
            data-graph-node-stage={box.stage}
            title={`${row.label} · ${row.word}`}
            className="absolute box-border flex flex-col justify-center gap-[3px] rounded-[10px] border border-dashed border-edge-strong px-[12px]"
            style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        >
            <span className="flex items-center gap-[7px]">
                <span className={cn("box-border h-[9px] w-[9px] flex-none rounded-full", stageDot(row.dot))} />
                <span className="truncate text-[12.5px] text-secondary">{row.label}</span>
            </span>
            <span data-graph-stage-word className="truncate font-mono text-[11px] text-muted">
                {row.word}
            </span>
        </div>
    );
}

// "+N more" beside a folded side; a pick moves to the first hidden task
function MorePill({
    side,
    row,
    rest,
    onMove,
}: {
    side: "up" | "down";
    row: FocusBox[];
    rest: string[];
    onMove: (id: string) => void;
}) {
    const last = row[row.length - 1];
    if (rest.length === 0 || last == null) {
        return null;
    }
    return (
        <span
            className="absolute flex items-center"
            style={{ left: last.x + last.w + MORE_GAP, top: last.y, height: last.h }}
        >
            <button
                type="button"
                data-graph-more={side}
                title={rest.join(", ")}
                onClick={() => onMove(rest[0])}
                className="cursor-pointer whitespace-nowrap rounded-full border border-edge-mid px-[11px] py-[5px] text-[12px] text-ink-mid hover:text-secondary"
            >
                +{rest.length} more
            </button>
        </span>
    );
}
