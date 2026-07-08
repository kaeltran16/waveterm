// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Obsidian-style memory graph on react-force-graph-2d, driven for calm-but-alive: node positions
// and the camera persist at module scope so remounts (Graph<->List toggles) resume exactly where
// you left off; a partial warmup roughs the layout in off-screen and the camera frames the graph
// from the first live tick, so the remaining ~1.5s of cooling plays as a short, framed organic
// settle instead of an unframed explosion; search dims non-matches instead of removing them, so
// typing never restarts the simulation; labels reveal map-style by degree (hubs first) with greedy
// de-collision. Canvas colors are read from the @theme CSS tokens (fillStyle can't use CSS vars).
// Lazy-loaded — the d3-force bundle stays off the boot path.

import { useSettle } from "@/app/element/motionhooks";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Maximize, Minus, Plus } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    degreeMap,
    degreeRank,
    graphSignature,
    labelBudget,
    labelZoomThreshold,
    seedPosition,
    truncateTitle,
    type XY,
} from "./memgraphlayout";
import { memEdgesAtom, selectNote } from "./memstore";
import type { MemNote } from "./memtypes";

const ForceGraph2D = lazy(() => import("react-force-graph-2d"));

// Rough the layout in off-screen, then let the last ~1.5s of cooling play live: enough warmup that
// the first frame has real structure (no explosion), few enough ticks that an organic settle still
// animates. The settle reads calm because the camera frames it from the FIRST tick (initCamera on
// onEngineTick), unlike the old flow that fit only at engine stop.
const WARMUP_TICKS = 50;
const FIT_MAX_ZOOM = 1.6; // don't let zoomToFit blow a tiny graph up to poster size
const SEARCH_LABEL_MAX = 40; // label every search match while the match set stays readable
const LABEL_FADE = 0.2; // zoom range over which a label fades in past its threshold
const OFFSCREEN_MARGIN = 28; // px; selection outside this margin recenters the camera
const PARTICLE_COUNT = 2; // flowing dots per hovered link
const PARTICLE_SPEED = 0.007; // fraction of link length per frame — a calm drift, not a race
const PARTICLE_WIDTH = 3;
const PULSE_PERIOD = 1500; // ms for one breath of the hover/selection halo
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
        return {
            fill: (t: string) => mem[t] ?? c("--color-ink-mid"),
            label: c("--color-foreground"),
            labelSoft: c("--color-ink-mid"), // unforced (zoom-revealed) labels stay quiet
            chip: rgba(c("--color-background"), 0.72), // backing behind quiet (zoom-revealed) label text
            chipStrong: rgba(c("--color-background"), 0.92), // near-opaque backing so hover/selected labels stay crisp
            edge: c("--color-ink-faint"),
            edgeHot: c("--color-accent"),
            ring: c("--color-foreground"),
            bg: c("--color-background"),
        };
    }, []);
}

// exponential ease toward a target (~160ms to settle at 60fps); undefined current snaps — first
// paint must not fade in from nowhere
function easeVal(cur: number | undefined, target: number): number {
    if (cur == null) return target;
    const next = cur + (target - cur) * 0.22;
    return Math.abs(next - target) < 0.01 ? target : next;
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
    const reducedMotion = useMemo(
        () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
        []
    );
    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<any>(undefined);
    const camInit = useRef(false); // camera restored/fit once per mount
    const hoverIdRef = useRef<string | null>(null);
    const labelBoxes = useRef<{ x: number; y: number; w: number; h: number }[]>([]); // per-frame de-collision
    const nodeAlpha = useRef(new Map<string, number>()); // eased per-node alpha (smooth dim/undim)
    const linkAlpha = useRef(new WeakMap<object, number>()); // eased per-link alpha
    const pumpUntil = useRef(0);
    const pumpRaf = useRef(0);
    const activeRef = useRef(false); // keep repainting while a hover/selection animation is live
    const frameTime = useRef(0); // performance.now() sampled once per frame -> shared pulse phase
    const [size, setSize] = useState({ w: 0, h: 0 });
    const [fgApi, setFgApi] = useState<any>(null); // set when the lazy graph mounts (ref callback)
    const [ready, setReady] = useState(false); // forces configured -> real data may flow to the sim
    const [cooled, setCooled] = useState(false); // flips when the sim cools -> one-shot settle cue (m4)
    const settling = useSettle(cooled);
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
        return { nodes, links, rank: degreeRank(nodes) };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sig]);
    const dataRef = useRef(data);
    dataRef.current = data;

    // a structural change (note created/deleted) re-arms the one-shot settle cue; the camera is
    // deliberately NOT reset — it stays where the user left it
    useEffect(() => {
        setCooled(false);
    }, [data]);

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
            fg.zoomToFit(0, 80); // generous padding leaves room for the live settle's outward drift
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
            // de-emphasizes the unlinked halo. Eased per node so dim/undim glides instead of snapping.
            const targetA = searchDim ? 0.07 : focused ? (inFocus ? 1 : 0.12) : node.deg > 0 ? 1 : 0.55;
            const a = easeVal(nodeAlpha.current.get(node.id), targetA);
            nodeAlpha.current.set(node.id, a);
            ctx.globalAlpha = a;
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
            ctx.fillStyle = colors.fill(node.type);
            ctx.fill();
            if (sel) {
                ctx.lineWidth = 1.5 / scale;
                ctx.strokeStyle = colors.ring;
                ctx.stroke();
            }
            // breathing halo: the hovered/selected node pulses so focus reads as alive. A ring drawn
            // OUTSIDE the dot (r unchanged) so the label anchor never jitters. frameTime is one clock
            // per frame, so every node breathes in phase.
            const focal = node.id === hoverIdRef.current;
            if (!reducedMotion && (focal || sel)) {
                const pulse = 0.5 - 0.5 * Math.cos(((frameTime.current % PULSE_PERIOD) / PULSE_PERIOD) * 2 * Math.PI);
                ctx.globalAlpha = (focal ? 0.6 : 0.42) * (1 - pulse);
                ctx.lineWidth = 1.5 / scale;
                ctx.strokeStyle = focal ? colors.edgeHot : colors.ring;
                ctx.beginPath();
                ctx.arc(node.x!, node.y!, r + (2 + pulse * 5) / scale, 0, 2 * Math.PI);
                ctx.stroke();
                ctx.globalAlpha = a;
            }
            // map-style labels: hovered/selected/search-matched nodes always label; otherwise a
            // label needs its zoom tier passed AND a slot in the zoom-scaled budget (degree-ranked,
            // so landmarks label first). Greedy de-collision (boxes reset per frame in
            // onRenderFramePre) keeps them overlap-free.
            if (searchDim || !inFocus) {
                ctx.globalAlpha = 1;
                return;
            }
            const forced =
                sel || hover.nodes.has(node.id) || (filteredIds != null && filteredIds.size <= SEARCH_LABEL_MAX);
            const thr = labelZoomThreshold(node.deg);
            const withinBudget = (data.rank.get(node.id) ?? Infinity) < labelBudget(scale);
            const la = forced ? 1 : scale > thr && withinBudget ? Math.min(1, (scale - thr) / LABEL_FADE) : 0;
            if (la > 0.05) {
                const title = truncateTitle(node.title);
                const fs = 12.5 / scale;
                ctx.font = `600 ${fs}px ui-monospace, monospace`;
                const tw = ctx.measureText(title).width;
                const padX = 4 / scale;
                const lx = node.x! + r + 4 / scale;
                const box = { x: lx - padX, y: node.y! - fs * 0.75, w: tw + padX * 2, h: fs * 1.5 };
                const hit = labelBoxes.current.some(
                    (q) => !(box.x > q.x + q.w || box.x + box.w < q.x || box.y > q.y + q.h || box.y + box.h < q.y)
                );
                if (!hit) {
                    labelBoxes.current.push(box);
                    ctx.globalAlpha = la;
                    ctx.fillStyle = forced ? colors.chipStrong : colors.chip;
                    ctx.beginPath();
                    ctx.roundRect(box.x, box.y, box.w, box.h, 3 / scale);
                    ctx.fill();
                    ctx.fillStyle = forced ? colors.label : colors.labelSoft;
                    ctx.textBaseline = "middle";
                    ctx.fillText(title, lx, node.y!);
                }
            }
            ctx.globalAlpha = 1;
        },
        [hover, selectedId, colors, filteredIds, data, reducedMotion]
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

    // hue switches instantly (hot/selected accents are click/hover feedback), but the mass dimming
    // of everything else eases via per-link alpha — same glide as the nodes
    const linkColor = useCallback(
        (l: GLink) => {
            let base = colors.edge;
            let target = 1;
            if (hover.links.has(l)) {
                base = colors.edgeHot;
            } else if (
                (filteredIds != null && !(filteredIds.has(idOf(l.source)) && filteredIds.has(idOf(l.target)))) ||
                hover.nodes.size > 0 // focused elsewhere
            ) {
                target = 0.12;
            } else if (selLinks.has(l)) {
                base = colors.edgeHot;
                target = 0.5;
            }
            const a = easeVal(linkAlpha.current.get(l), target);
            linkAlpha.current.set(l, a);
            return rgba(base, a);
        },
        [hover, filteredIds, selLinks, colors]
    );

    const linkWidth = useCallback(
        (l: GLink) => (hover.links.has(l) ? 1.8 : selLinks.has(l) ? 1.2 : 0.7),
        [hover, selLinks]
    );

    // particles flow only along the hovered node's links. react-force-graph (re)emits/clears photons
    // when this accessor's identity changes, so it's memoized on `hover` — an unrelated re-render
    // must not rebuild the photon list and restart every dot mid-flight.
    const linkParticles = useCallback(
        (l: GLink) => (!reducedMotion && hover.links.has(l) ? PARTICLE_COUNT : 0),
        [hover, reducedMotion]
    );
    const particleColor = useCallback(() => colors.edgeHot, [colors]);

    // The sim is usually idle when selection/hover/search change, so nothing would repaint the
    // canvas while the alpha easings play out — or while a hover/selection halo breathes. Pump
    // refresh() for at least a short window per change, and keep pumping as long as `activeRef` is
    // set (a live hover/selection), so the pulse and particles animate instead of freezing after
    // the initial transition settles.
    const startPump = useCallback(() => {
        pumpUntil.current = performance.now() + 400;
        if (pumpRaf.current) return; // already pumping — just extended the window
        const step = () => {
            fgRef.current?.refresh?.();
            if (performance.now() < pumpUntil.current || activeRef.current) {
                pumpRaf.current = requestAnimationFrame(step);
            } else {
                pumpRaf.current = 0;
            }
        };
        pumpRaf.current = requestAnimationFrame(step);
    }, []);
    useEffect(() => () => cancelAnimationFrame(pumpRaf.current), []);
    useEffect(() => {
        activeRef.current = !reducedMotion && (hover.nodes.size > 0 || selectedId != null);
        startPump();
    }, [selectedId, hover, colors, filteredIds, reducedMotion, startPump]);

    const zoomBy = (f: number) => {
        const fg = fgRef.current;
        if (!fg) return;
        fg.zoom(Math.min(8, Math.max(0.05, fg.zoom() * f)), 220);
    };

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
                        linkDirectionalParticles={linkParticles as any}
                        linkDirectionalParticleSpeed={PARTICLE_SPEED}
                        linkDirectionalParticleWidth={PARTICLE_WIDTH}
                        linkDirectionalParticleColor={particleColor as any}
                        onNodeHover={onNodeHover as any}
                        onNodeClick={((node: GNode) => fireAndForget(() => selectNote(node.id))) as any}
                        onNodeDragEnd={(() => savePositions()) as any}
                        onRenderFramePre={(() => {
                            labelBoxes.current = []; // reset de-collision boxes at the start of each frame
                            frameTime.current = performance.now(); // one clock per frame -> in-phase pulse
                        }) as any}
                        onEngineTick={initCamera}
                        onEngineStop={() => {
                            initCamera();
                            savePositions();
                            setCooled(true);
                        }}
                        onZoomEnd={saveCamera as any}
                        // damped decay: warmup roughs the layout in, then the live cooldown plays a
                        // short organic settle before the engine stops
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
