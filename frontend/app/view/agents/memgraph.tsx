// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Obsidian-style memory graph built on react-force-graph-2d: a live d3-force simulation (dots repel,
// links pull, nodes are draggable) with dots sized by link-count, hover-a-node to highlight its
// neighbors and dim the rest, and labels that fade in as you zoom. Lazy-loaded — the graph is not on
// the boot path, so the d3-force bundle stays off startup. Canvas colors are read from the @theme CSS
// tokens (canvas fillStyle can't use CSS vars) so there are no hardcoded design colors.

import { useSettle } from "@/app/element/motionhooks";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { degreeMap, graphSignature } from "./memgraphlayout";
import { memEdgesAtom, selectNote } from "./memstore";
import type { MemNote } from "./memtypes";

const ForceGraph2D = lazy(() => import("react-force-graph-2d"));

const LABEL_ZOOM = 1.2; // reveal all labels once zoomed past this
const nodeRadius = (deg: number) => 3 + Math.min(Math.sqrt(deg) * 2.2, 12);

type GNode = { id: string; title: string; type: string; deg: number; x?: number; y?: number };
type GLink = { source: string | GNode; target: string | GNode };

const idOf = (e: string | GNode) => (typeof e === "object" ? e.id : e);

// #rrggbb (+ optional alpha) → rgba() so we can add transparency to a token color for the label chip
function rgba(hex: string, a: number) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// resolve @theme tokens to concrete colors for canvas rendering (fillStyle can't take var(--…))
function useThemeColors() {
    return useMemo(() => {
        const s = getComputedStyle(document.documentElement);
        const c = (n: string) => s.getPropertyValue(n).trim() || "#888888";
        const mem: Record<string, string> = {
            project: c("--color-mem-project"),
            reference: c("--color-mem-reference"),
            feedback: c("--color-mem-feedback"),
            user: c("--color-mem-user"),
        };
        return {
            fill: (t: string) => mem[t] ?? c("--color-ink-mid"),
            label: c("--color-foreground"),
            chip: rgba(c("--color-background"), 0.72), // backing behind label text for contrast
            edge: c("--color-ink-faint"),
            edgeHot: c("--color-accent"),
            ring: c("--color-foreground"),
            bg: c("--color-background"),
        };
    }, []);
}

export function MemGraph({ notes, selectedId }: { notes: MemNote[]; selectedId: string | null }) {
    const allEdges = useAtomValue(memEdgesAtom);
    const colors = useThemeColors();
    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<any>(undefined);
    const fitted = useRef(false);
    const settled = useRef(false); // true once the sim cools — gates label painting (smooth fly-in)
    const labelBoxes = useRef<{ x: number; y: number; w: number; h: number }[]>([]); // per-frame de-collision
    const [size, setSize] = useState({ w: 0, h: 0 });
    const [cooled, setCooled] = useState(false); // flips true when the sim cools -> one-shot settle cue (m4)
    const settling = useSettle(cooled);
    const [hover, setHover] = useState<{ nodes: Set<string>; links: Set<GLink> }>({
        nodes: new Set(),
        links: new Set(),
    });

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        // only push a new size when it actually changed — an unconditional setState on every observed
        // resize re-renders (and reflows the canvas) even when dimensions are identical
        const ro = new ResizeObserver(() =>
            setSize((prev) =>
                prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }
            )
        );
        ro.observe(el);
        setSize({ w: el.clientWidth, h: el.clientHeight });
        return () => ro.disconnect();
    }, []);

    // nodes + links for the current (filtered) set; links restricted to present notes so search
    // filtering never leaves dangling edges. deg drives node size.
    // Gate the rebuild on the structural signature (not the identity of `notes`, which is a fresh
    // filtered array every render): reuse the same node/link objects — and thus the sim's live x/y —
    // whenever the node/edge set is unchanged. This is the core clank fix (no restart per keystroke/hover).
    const sig = graphSignature(
        notes.map((n) => n.id),
        allEdges
    );
    const data = useMemo(() => {
        const ids = new Set(notes.map((n) => n.id));
        const edges = allEdges.filter((e) => ids.has(e.from) && ids.has(e.to));
        const deg = degreeMap(edges);
        const nodes: GNode[] = notes.map((n) => ({ id: n.id, title: n.title, type: n.type, deg: deg.get(n.id) ?? 0 }));
        const links: GLink[] = edges.map((e) => ({ source: e.from, target: e.to }));
        return { nodes, links };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sig]);

    useEffect(() => {
        fitted.current = false;
        settled.current = false;
        setCooled(false);
    }, [data]);

    const onNodeHover = useCallback(
        (node: GNode | null) => {
            const nodes = new Set<string>();
            const links = new Set<GLink>();
            if (node) {
                nodes.add(node.id);
                for (const l of data.links) {
                    if (idOf(l.source) === node.id || idOf(l.target) === node.id) {
                        links.add(l);
                        nodes.add(idOf(l.source));
                        nodes.add(idOf(l.target));
                    }
                }
            }
            setHover({ nodes, links });
        },
        [data]
    );

    const paintNode = useCallback(
        (node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
            const focused = hover.nodes.size > 0;
            const inFocus = !focused || hover.nodes.has(node.id);
            const sel = node.id === selectedId;
            const r = nodeRadius(node.deg) + (sel ? 2 : 0);
            // idle: de-emphasize the unlinked halo; focus: dim everything outside the neighborhood
            ctx.globalAlpha = focused ? (inFocus ? 1 : 0.12) : node.deg > 0 ? 1 : 0.55;
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
            ctx.fillStyle = colors.fill(node.type);
            ctx.fill();
            if (sel) {
                ctx.lineWidth = 1.5 / scale;
                ctx.strokeStyle = colors.ring;
                ctx.stroke();
            }
            // labels only once settled (skipping them during the sim keeps the fly-in smooth), and only
            // for the hover neighborhood or when zoomed in. Greedy de-collision (boxes reset per frame in
            // onRenderFramePre) so labels never overlap — the readability fix.
            const wantLabel = settled.current && inFocus && (hover.nodes.has(node.id) || scale > LABEL_ZOOM);
            if (wantLabel) {
                const fs = 12.5 / scale;
                ctx.font = `600 ${fs}px ui-monospace, monospace`;
                const tw = ctx.measureText(node.title).width;
                const padX = 4 / scale;
                const lx = node.x! + r + 4 / scale;
                const box = { x: lx - padX, y: node.y! - fs * 0.75, w: tw + padX * 2, h: fs * 1.5 };
                const hit = labelBoxes.current.some(
                    (q) => !(box.x > q.x + q.w || box.x + box.w < q.x || box.y > q.y + q.h || box.y + box.h < q.y)
                );
                if (!hit) {
                    labelBoxes.current.push(box);
                    ctx.globalAlpha = 1;
                    ctx.fillStyle = colors.chip;
                    ctx.beginPath();
                    ctx.roundRect(box.x, box.y, box.w, box.h, 3 / scale);
                    ctx.fill();
                    ctx.fillStyle = colors.label;
                    ctx.textBaseline = "middle";
                    ctx.fillText(node.title, lx, node.y!);
                }
            }
            ctx.globalAlpha = 1;
        },
        [hover, selectedId, colors]
    );

    // the sim may be idle when selection/hover/colors change — force a repaint
    useEffect(() => {
        fgRef.current?.refresh?.();
    }, [selectedId, hover, colors]);

    return (
        <div
            ref={containerRef}
            className={cn(
                "absolute inset-0 overflow-hidden",
                settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
            )}
        >
            <Suspense fallback={<div className="p-[28px] text-[13px] text-ink-mid">Loading graph…</div>}>
                {size.w > 0 && (
                    <ForceGraph2D
                        ref={fgRef}
                        width={size.w}
                        height={size.h}
                        graphData={data}
                        backgroundColor={colors.bg}
                        nodeRelSize={1}
                        nodeCanvasObject={paintNode as any}
                        nodePointerAreaPaint={
                            ((node: GNode, color: string, ctx: CanvasRenderingContext2D) => {
                                ctx.fillStyle = color;
                                ctx.beginPath();
                                ctx.arc(node.x!, node.y!, nodeRadius(node.deg) + 2, 0, 2 * Math.PI);
                                ctx.fill();
                            }) as any
                        }
                        linkColor={((l: GLink) => (hover.links.has(l) ? colors.edgeHot : colors.edge)) as any}
                        linkWidth={((l: GLink) => (hover.links.has(l) ? 2 : 0.6)) as any}
                        onNodeHover={onNodeHover as any}
                        onNodeClick={((node: GNode) => fireAndForget(() => selectNote(node.id))) as any}
                        onRenderFramePre={(() => {
                            labelBoxes.current = []; // reset de-collision boxes at the start of each frame
                        }) as any}
                        onEngineStop={() => {
                            settled.current = true;
                            setCooled(true);
                            if (!fitted.current) {
                                fgRef.current?.zoomToFit?.(600, 50); // animated fit
                                fitted.current = true;
                            }
                            fgRef.current?.refresh?.(); // repaint so labels appear now that it's settled
                        }}
                        // damped + time-boxed settle → calmer, smoother motion than the bouncy default.
                        // Slightly faster decay + shorter cooldown so it stops jiggling sooner (less "clank").
                        d3VelocityDecay={0.5}
                        d3AlphaDecay={0.045}
                        warmupTicks={30}
                        cooldownTime={3000}
                    />
                )}
            </Suspense>

            {/* type legend — pinned overlay */}
            <div className="pointer-events-none absolute bottom-[10px] left-[12px] flex gap-[15px] rounded-[9px] border border-edge-faint bg-surface/80 px-[13px] py-[8px]">
                {(["project", "reference", "feedback", "user"] as const).map((t) => (
                    <div key={t} className="flex items-center gap-[6px]">
                        <div className="h-[8px] w-[8px] rounded-full" style={{ background: colors.fill(t) }} />
                        <span className="font-mono text-[10.5px] capitalize text-ink-mid">{t}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
