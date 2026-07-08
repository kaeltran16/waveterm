// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Obsidian-style memory graph on react-force-graph-2d, driven for calm: node positions and the
// camera persist at module scope so remounts (Graph<->List toggles) resume exactly where you left
// off instead of replaying the fly-in; the sim is pre-warmed past alpha-min so the first painted
// frame is already settled and framed; search dims non-matches instead of removing them, so typing
// never restarts the simulation; labels reveal map-style by degree (hubs first) with greedy
// de-collision. Canvas colors are read from the @theme CSS tokens (fillStyle can't use CSS vars).
// Lazy-loaded — the d3-force bundle stays off the boot path.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Maximize, Minus, Plus } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { degreeMap, graphSignature, labelZoomThreshold, seedPosition, type XY } from "./memgraphlayout";
import { memEdgesAtom, selectNote } from "./memstore";
import type { MemNote } from "./memtypes";

const ForceGraph2D = lazy(() => import("react-force-graph-2d"));

const WARMUP_TICKS = 200; // enough for the sim to cool below alpha-min -> first paint is settled
const FIT_MAX_ZOOM = 1.6; // don't let zoomToFit blow a tiny graph up to poster size
const SEARCH_LABEL_MAX = 40; // label every search match while the match set stays readable
const LABEL_FADE = 0.2; // zoom range over which a label fades in past its threshold
const OFFSCREEN_MARGIN = 28; // px; selection outside this margin recenters the camera
const nodeRadius = (deg: number) => 3 + Math.min(Math.sqrt(deg) * 2.2, 12);

type GNode = { id: string; title: string; type: string; deg: number; x?: number; y?: number };
type GLink = { source: string | GNode; target: string | GNode };

const idOf = (e: string | GNode) => (typeof e === "object" ? e.id : e);

// layout + camera survive remounts so reopening the graph resumes in place (no re-simulation)
const posCache = new Map<string, XY>();
let savedCam: { x: number; y: number; k: number } | null = null;

const EMPTY_DATA = { nodes: [] as GNode[], links: [] as GLink[] };

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
        const edge = c("--color-ink-faint");
        return {
            fill: (t: string) => mem[t] ?? c("--color-ink-mid"),
            label: c("--color-foreground"),
            chip: rgba(c("--color-background"), 0.72), // backing behind label text for contrast
            edge,
            edgeDim: rgba(edge, 0.15),
            edgeHot: c("--color-accent"),
            edgeSel: rgba(c("--color-accent"), 0.45),
            ring: c("--color-foreground"),
            bg: c("--color-background"),
        };
    }, []);
}

function CtrlBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
    return (
        <button
            title={label}
            aria-label={label}
            onClick={onClick}
            className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center text-ink-mid hover:bg-accentbg hover:text-foreground"
        >
            {children}
        </button>
    );
}

export function MemGraph({
    notes,
    filteredIds,
    selectedId,
}: {
    notes: MemNote[];
    filteredIds: ReadonlySet<string> | null;
    selectedId: string | null;
}) {
    const allEdges = useAtomValue(memEdgesAtom);
    const colors = useThemeColors();
    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<any>(undefined);
    const camInit = useRef(false); // camera restored/fit once per mount
    const hoverIdRef = useRef<string | null>(null);
    const labelBoxes = useRef<{ x: number; y: number; w: number; h: number }[]>([]); // per-frame de-collision
    const [size, setSize] = useState({ w: 0, h: 0 });
    const [fgApi, setFgApi] = useState<any>(null); // set when the lazy graph mounts (ref callback)
    const [ready, setReady] = useState(false); // forces configured -> real data may flow to the sim
    const [hover, setHover] = useState<{ nodes: Set<string>; links: Set<GLink> }>({
        nodes: new Set(),
        links: new Set(),
    });

    const attachFg = useCallback((inst: any) => {
        fgRef.current = inst;
        setFgApi(inst ?? null);
    }, []);

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

    // Configure physics BEFORE any data reaches the sim (the graph mounts with EMPTY_DATA until
    // `ready`), so the one warmup runs with the right forces — no post-hoc reheat/re-settle.
    // collide stops cluster overlap; weak x/y gravity keeps disconnected components in frame; the
    // default center force is dropped because it translates the whole graph while dragging one node.
    useEffect(() => {
        if (!fgApi) return;
        let live = true;
        fireAndForget(async () => {
            const { forceCollide, forceX, forceY } = await import("d3-force-3d");
            if (!live) return;
            fgApi.d3Force("collide", forceCollide((n: GNode) => nodeRadius(n.deg) + 3));
            fgApi.d3Force("charge")?.strength(-100).distanceMax(260);
            fgApi.d3Force("link")?.distance(38);
            fgApi.d3Force("x", forceX(0).strength(0.04));
            fgApi.d3Force("y", forceY(0).strength(0.04));
            fgApi.d3Force("center", null);
            setReady(true);
        });
        return () => {
            live = false;
        };
    }, [fgApi]);

    // Nodes + links for the FULL note set (search dims rather than removes — see paintNode). Links
    // are restricted to present notes so broken [[links]] never produce dangling edges. Gate the
    // rebuild on the structural signature (not the identity of `notes`, which is a fresh array every
    // render): reuse the same node/link objects — and thus the sim's live x/y — whenever the set is
    // unchanged. Nodes seed from the position cache so structural changes wobble locally.
    const sig = graphSignature(
        notes.map((n) => n.id),
        allEdges
    );
    const data = useMemo(() => {
        const ids = new Set(notes.map((n) => n.id));
        const edges = allEdges.filter((e) => ids.has(e.from) && ids.has(e.to));
        const deg = degreeMap(edges);
        const nodes: GNode[] = notes.map((n) => {
            const seed = seedPosition(n.id, edges, posCache);
            return { id: n.id, title: n.title, type: n.type, deg: deg.get(n.id) ?? 0, ...(seed ?? {}) };
        });
        const links: GLink[] = edges.map((e) => ({ source: e.from, target: e.to }));
        return { nodes, links };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sig]);
    const dataRef = useRef(data);
    dataRef.current = data;

    const savePositions = useCallback(() => {
        for (const n of dataRef.current.nodes) {
            if (Number.isFinite(n.x) && Number.isFinite(n.y)) posCache.set(n.id, { x: n.x!, y: n.y! });
        }
    }, []);

    const saveCamera = useCallback(() => {
        const fg = fgRef.current;
        if (!fg || !camInit.current) return; // ignore zoom events from before the restore/fit
        const c = fg.centerAt();
        const k = fg.zoom();
        if (c && Number.isFinite(c.x) && Number.isFinite(k)) savedCam = { x: c.x, y: c.y, k };
    }, []);

    // restore the last camera, or frame the graph — once per mount, on the first settled frame
    const initCamera = useCallback(() => {
        const fg = fgRef.current;
        if (camInit.current || !fg || dataRef.current.nodes.length === 0) return;
        camInit.current = true;
        if (savedCam) {
            fg.centerAt(savedCam.x, savedCam.y, 0);
            fg.zoom(savedCam.k, 0);
        } else {
            fg.zoomToFit(0, 60);
            if (fg.zoom() > FIT_MAX_ZOOM) fg.zoom(FIT_MAX_ZOOM, 0);
        }
    }, []);

    const onNodeHover = useCallback(
        (node: GNode | null) => {
            const id = node?.id ?? null;
            if (id === hoverIdRef.current) return; // mousemove churn guard
            hoverIdRef.current = id;
            if (containerRef.current) containerRef.current.style.cursor = node ? "pointer" : "";
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

    // the selected node's links stay softly highlighted so the selection reads at a glance
    const selLinks = useMemo(() => {
        const s = new Set<GLink>();
        if (selectedId) {
            for (const l of data.links) {
                if (idOf(l.source) === selectedId || idOf(l.target) === selectedId) s.add(l);
            }
        }
        return s;
    }, [data, selectedId]);

    // when selection changes to a node outside the viewport (e.g. via the related-notes rail),
    // glide the camera to it
    useEffect(() => {
        const fg = fgRef.current;
        const el = containerRef.current;
        if (!fg || !el || !selectedId || !camInit.current) return;
        const node = dataRef.current.nodes.find((n) => n.id === selectedId);
        if (!node || !Number.isFinite(node.x)) return;
        const p = fg.graph2ScreenCoords(node.x, node.y);
        const m = OFFSCREEN_MARGIN;
        if (p.x < m || p.y < m || p.x > el.clientWidth - m || p.y > el.clientHeight - m) {
            fg.centerAt(node.x, node.y, 500);
        }
    }, [selectedId]);

    const paintNode = useCallback(
        (node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
            const searchDim = filteredIds != null && !filteredIds.has(node.id);
            const focused = hover.nodes.size > 0;
            const inFocus = !focused || hover.nodes.has(node.id);
            const sel = node.id === selectedId;
            const r = nodeRadius(node.deg) + (sel ? 2 : 0);
            // search dim dominates; hover focus dims everything outside the neighborhood; idle
            // de-emphasizes the unlinked halo
            ctx.globalAlpha = searchDim ? 0.07 : focused ? (inFocus ? 1 : 0.12) : node.deg > 0 ? 1 : 0.55;
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
            ctx.fillStyle = colors.fill(node.type);
            ctx.fill();
            if (sel) {
                ctx.lineWidth = 1.5 / scale;
                ctx.strokeStyle = colors.ring;
                ctx.stroke();
            }
            // map-style labels: hovered/selected/search-matched nodes always label; otherwise the
            // label fades in as zoom passes the node's degree-tiered threshold. Greedy de-collision
            // (boxes reset per frame in onRenderFramePre) keeps labels overlap-free.
            if (searchDim || !inFocus) {
                ctx.globalAlpha = 1;
                return;
            }
            const forced =
                sel || hover.nodes.has(node.id) || (filteredIds != null && filteredIds.size <= SEARCH_LABEL_MAX);
            const la = forced ? 1 : Math.min(1, Math.max(0, (scale - labelZoomThreshold(node.deg)) / LABEL_FADE));
            if (la > 0.05) {
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
                    ctx.globalAlpha = la;
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
        [hover, selectedId, colors, filteredIds]
    );

    // search-dimmed nodes get no pointer area: near-invisible dots shouldn't be clickable
    const paintPointerArea = useCallback(
        (node: GNode, color: string, ctx: CanvasRenderingContext2D) => {
            if (filteredIds != null && !filteredIds.has(node.id)) return;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, nodeRadius(node.deg) + 2, 0, 2 * Math.PI);
            ctx.fill();
        },
        [filteredIds]
    );

    const linkColor = useCallback(
        (l: GLink) => {
            if (hover.links.has(l)) return colors.edgeHot;
            if (filteredIds != null && !(filteredIds.has(idOf(l.source)) && filteredIds.has(idOf(l.target)))) {
                return colors.edgeDim;
            }
            if (hover.nodes.size > 0) return colors.edgeDim; // focused elsewhere
            if (selLinks.has(l)) return colors.edgeSel;
            return colors.edge;
        },
        [hover, filteredIds, selLinks, colors]
    );

    const linkWidth = useCallback(
        (l: GLink) => (hover.links.has(l) ? 1.8 : selLinks.has(l) ? 1.2 : 0.7),
        [hover, selLinks]
    );

    // the sim may be idle when selection/hover/search change — force a repaint
    useEffect(() => {
        fgRef.current?.refresh?.();
    }, [selectedId, hover, colors, filteredIds]);

    const zoomBy = (f: number) => {
        const fg = fgRef.current;
        if (!fg) return;
        fg.zoom(Math.min(8, Math.max(0.05, fg.zoom() * f)), 220);
    };

    return (
        <div ref={containerRef} className="absolute inset-0 overflow-hidden">
            <Suspense fallback={<div className="p-[28px] text-[13px] text-ink-mid">Loading graph…</div>}>
                {size.w > 0 && (
                    <ForceGraph2D
                        // typed as MutableRefObject only, but react-kapsule forwards callback refs fine
                        ref={attachFg as any}
                        width={size.w}
                        height={size.h}
                        graphData={ready ? data : EMPTY_DATA}
                        backgroundColor={colors.bg}
                        nodeRelSize={1}
                        minZoom={0.05}
                        maxZoom={8}
                        nodeCanvasObject={paintNode as any}
                        nodePointerAreaPaint={paintPointerArea as any}
                        linkColor={linkColor as any}
                        linkWidth={linkWidth as any}
                        onNodeHover={onNodeHover as any}
                        onNodeClick={((node: GNode) => fireAndForget(() => selectNote(node.id))) as any}
                        onNodeDragEnd={(() => savePositions()) as any}
                        onRenderFramePre={(() => {
                            labelBoxes.current = []; // reset de-collision boxes at the start of each frame
                        }) as any}
                        onEngineStop={() => {
                            initCamera();
                            savePositions();
                        }}
                        onZoomEnd={saveCamera as any}
                        // damped decay: the pre-warmed layout arrives settled; live ticks only run
                        // after drag reheats, and cool quickly
                        d3VelocityDecay={0.5}
                        d3AlphaDecay={0.045}
                        warmupTicks={WARMUP_TICKS}
                        cooldownTime={3000}
                    />
                )}
            </Suspense>

            {/* zoom controls — pinned overlay */}
            <div className="absolute right-[12px] top-[12px] flex flex-col overflow-hidden rounded-[9px] border border-edge-mid bg-surface/90">
                <CtrlBtn label="Zoom in" onClick={() => zoomBy(1.5)}>
                    <Plus size={14} strokeWidth={2} />
                </CtrlBtn>
                <CtrlBtn label="Zoom out" onClick={() => zoomBy(1 / 1.5)}>
                    <Minus size={14} strokeWidth={2} />
                </CtrlBtn>
                <CtrlBtn label="Fit to view" onClick={() => fgRef.current?.zoomToFit?.(400, 60)}>
                    <Maximize size={13} strokeWidth={2} />
                </CtrlBtn>
            </div>

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
