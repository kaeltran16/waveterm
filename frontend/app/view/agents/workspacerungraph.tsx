// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run tab's Graph view: In flight chips, Lanes (every task beside a git-graph gutter, hover lights a chain) and
// Focus (one task, its deps above and dependents below). The mode, the selection and the back trail are the tab's
// graph state, moved only through workspacerungraphmodel's transitions; hover is the only local state.

import { morphTransition } from "@/app/element/motiontokens";
import { StepSwap } from "@/app/element/stepswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import { tabKey, type RunGraphState } from "./workspacemodel";
import {
    backFrom,
    chainOf,
    flightIds,
    focusOn,
    focusView,
    graphNodes,
    gutterPath,
    laneLayout,
    LANES,
    laneWord,
    moveTo,
    stepDir,
    toFocus,
    toLanes,
    type FocusView,
    type GraphNode,
    type LaneLayout,
} from "./workspacerungraphmodel";
import type { RunViewProps } from "./workspaceruntab";
import { finalRow, planReviewRow, ROW_DOT, type RowDot, type StageRowView } from "./workspaceruntabmodel";
import { updateWorkspaceTab } from "./workspacestore";

// the canvas's gutter: 34px rows, lanes 13px apart, the first lane 10px in (gutterPath matches it to the pixel)
const GEO = { rowH: 34, laneW: 13, x0: 10 };
const DOT_PX = 10;
const ROW_GAP_PX = 4;

const WORD_TONE: Record<GraphNode["dot"], string> = {
    merged: "text-muted",
    working: "text-accent",
    asked: "text-warning",
    failed: "text-error",
    waits: "text-muted",
};

// a stage that has not started is the canvas's dashed ring, not a task's faint dot
function stageDot(dot: RowDot): string {
    return dot === "waits" ? "border-[1.5px] border-dashed border-muted" : ROW_DOT[dot];
}

type SetGraph = (next: RunGraphState) => void;

export function GraphView({ model, agent, tab, run, events }: RunViewProps) {
    const now = useAtomValue(model.nowAtom);
    const dag = run.dag;
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
            <span data-graph-word className={cn("relative flex-none text-[12px]", WORD_TONE[node.dot])}>
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

// the canvas's Focus geometry: a 564px board (the default pane's width), 236px centre card, 168px neighbours, rows at
// 30, 180 and 350; a narrower pane narrows the neighbours
const FOCUS_W = 564;
const FOCUS_H = 460;
const CENTRE_W = 236;
const SIDE_W = 168;
const NODE_GAP = 14;
const MORE_W = 96;
const Y_UP = 30;
const Y_MID = 180;
const Y_DOWN = 350;
const H_CENTRE = 76;
const H_SIDE = 58;
const ARROW_GAP = 4;
const STAGE_UP_W = 160;
const STAGE_DOWN_W = 180;

type Box = { id: string; x: number; y: number; w: number; h: number; stage?: "plan-review" | "final" };

function placeRow(ids: string[], y: number, more: boolean, width: number): Box[] {
    const n = ids.length;
    const extra = more ? MORE_W : 0;
    const w = Math.min(SIDE_W, (width - (n - 1) * NODE_GAP - extra) / n);
    const span = n * w + (n - 1) * NODE_GAP + extra;
    return ids.map((id, i) => ({ id, x: width / 2 - span / 2 + i * (w + NODE_GAP), y, w, h: H_SIDE }));
}

function curve(a: Box, b: Box): { d: string; arrow: string } {
    const [x1, y1, x2, y2] = [a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y - ARROW_GAP];
    const my = (y1 + y2) / 2;
    return {
        d: `M${x1} ${y1} C${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`,
        arrow: `M${x2 - 4.5} ${y2 - 6} L${x2} ${y2} L${x2 + 4.5} ${y2 - 6}`,
    };
}

function FocusBoard({
    view,
    byId,
    planReview,
    final,
    onMove,
}: {
    view: FocusView;
    byId: Map<string, GraphNode>;
    planReview: StageRowView | null;
    final: StageRowView | null;
    onMove: (id: string) => void;
}) {
    const [boardRef, , rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const width = rect?.width || FOCUS_W;
    const mid = width / 2;
    const centre: Box = { id: view.centre, x: mid - CENTRE_W / 2, y: Y_MID, w: CENTRE_W, h: H_CENTRE };
    const ups: Box[] = view.upStage
        ? planReview
            ? [{ id: "", x: mid - STAGE_UP_W / 2, y: Y_UP, w: STAGE_UP_W, h: H_SIDE, stage: "plan-review" }]
            : []
        : placeRow(view.up, Y_UP, view.upMore.length > 0, width);
    const downs: Box[] = view.downStage
        ? final
            ? [{ id: "", x: mid - STAGE_DOWN_W / 2, y: Y_DOWN, w: STAGE_DOWN_W, h: H_SIDE, stage: "final" }]
            : []
        : placeRow(view.down, Y_DOWN, view.downMore.length > 0, width);
    const lines = [...ups.map((u) => curve(u, centre)), ...downs.map((d) => curve(centre, d))];
    const upCount = view.up.length + view.upMore.length;
    const downCount = view.down.length + view.downMore.length;
    return (
        <div data-graph-focus={view.centre} className="flex flex-col">
            <div data-graph-up-count={upCount} className="px-[18px] pt-[4px] text-[12px] text-muted">
                waits on {upCount}
            </div>
            <div className="px-[18px]">
                <div ref={boardRef} className="relative" style={{ height: FOCUS_H }}>
                    <svg
                        width={width}
                        height={FOCUS_H}
                        className="pointer-events-none absolute left-0 top-0 overflow-visible"
                        aria-hidden
                    >
                        {lines.map((l, i) => (
                            <g key={i} className="fill-none stroke-ink-faint" strokeWidth={1.5}>
                                <path d={l.d} />
                                <path d={l.arrow} strokeLinecap="round" strokeLinejoin="round" />
                            </g>
                        ))}
                    </svg>
                    {[...ups, centre, ...downs].map((b) =>
                        b.stage ? (
                            <StageNode key={b.stage} box={b} row={b.stage === "final" ? final : planReview} />
                        ) : (
                            <TaskNodeCard
                                key={b.id}
                                box={b}
                                node={byId.get(b.id)}
                                side={b === centre ? "centre" : ups.includes(b) ? "up" : "down"}
                                onMove={onMove}
                            />
                        )
                    )}
                    <MorePill side="up" row={ups} y={Y_UP} rest={view.upMore} onMove={onMove} />
                    <MorePill side="down" row={downs} y={Y_DOWN} rest={view.downMore} onMove={onMove} />
                </div>
            </div>
            <div data-graph-down-count={downCount} className="px-[18px] text-[12px] text-muted">
                waited on by {downCount} · click a task to move to it
            </div>
        </div>
    );
}

function TaskNodeCard({
    box,
    node,
    side,
    onMove,
}: {
    box: Box;
    node: GraphNode;
    side: "up" | "centre" | "down";
    onMove: (id: string) => void;
}) {
    const centre = side === "centre";
    return (
        <button
            type="button"
            data-graph-node={node.id}
            data-side={side}
            title={`${node.id} · ${node.name}${node.word ? ` · ${node.word}` : ""}`}
            disabled={centre}
            onClick={() => onMove(node.id)}
            className={cn(
                "absolute box-border flex gap-[9px] border text-left",
                centre
                    ? cn(
                          "cursor-default rounded-[16px] bg-surface-raised px-[16px] py-[12px]",
                          node.dot === "asked" ? "border-warning/60" : "border-accent"
                      )
                    : "cursor-pointer rounded-[14px] border-edge-strong bg-background px-[13px] py-[9px] hover:border-edge-mid"
            )}
            style={{ left: box.x, top: box.y, width: box.w, minHeight: box.h }}
        >
            <span className={cn("mt-[3px] h-[9px] w-[9px] flex-none self-start rounded-full", ROW_DOT[node.dot])} />
            <span className="flex min-w-0 flex-col gap-[2px]">
                <span className="font-mono text-[11px] text-muted">{node.id}</span>
                <span
                    className={cn(
                        "line-clamp-2 leading-[1.35]",
                        centre ? "text-[14px] font-semibold text-primary" : "text-[12.5px] text-secondary"
                    )}
                >
                    {node.name}
                </span>
            </span>
        </button>
    );
}

function StageNode({ box, row }: { box: Box; row: StageRowView }) {
    return (
        <div
            data-graph-node-stage={box.stage}
            title={`${row.label} · ${row.word}`}
            className="absolute box-border flex gap-[9px] rounded-[14px] border border-dashed border-edge-strong px-[13px] py-[9px]"
            style={{ left: box.x, top: box.y, width: box.w, minHeight: box.h }}
        >
            <span
                className={cn(
                    "mt-[3px] box-border h-[9px] w-[9px] flex-none self-start rounded-full",
                    stageDot(row.dot)
                )}
            />
            <span className="text-[12.5px] leading-[1.35] text-secondary">{row.label}</span>
        </div>
    );
}

// "+N more" beside a folded side; a pick moves to the first hidden task
function MorePill({
    side,
    row,
    y,
    rest,
    onMove,
}: {
    side: "up" | "down";
    row: Box[];
    y: number;
    rest: string[];
    onMove: (id: string) => void;
}) {
    const last = row[row.length - 1];
    if (rest.length === 0 || last == null) {
        return null;
    }
    return (
        <button
            type="button"
            data-graph-more={side}
            title={rest.join(", ")}
            onClick={() => onMove(rest[0])}
            className="absolute cursor-pointer whitespace-nowrap rounded-full border border-edge-mid px-[11px] py-[5px] text-[12px] text-ink-mid hover:text-secondary"
            style={{ left: last.x + last.w + 10, top: y + 15 }}
        >
            +{rest.length} more
        </button>
    );
}
