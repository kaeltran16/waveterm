import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    Background,
    Handle,
    MarkerType,
    Position,
    ReactFlow,
    ReactFlowProvider,
    useReactFlow,
    type Edge,
    type Node,
    type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { DagGraphHeader } from "./daggraph-header";
import { computeLayeredLayout } from "./daglayout";
import { buildViewData, selectedTaskIdAtom, useDagGroup, type DagViewNode } from "./dagstore";

const STATE_TONE: Record<string, string> = {
    running: "border-accent/60 bg-accent/15 text-accent-soft",
    ready: "border-accent/40 bg-accent/10 text-accent-soft",
    done: "border-success/50 bg-success/10 text-success",
    failed: "border-warning/60 bg-warning/10 text-warning",
    stalled: "border-warning/80 bg-warning/15 text-warning",
    cancelled: "border-edge-mid bg-surface-raised text-muted",
    skipped: "border-edge-mid bg-surface-raised text-muted",
    "blocked-merge": "border-warning/70 bg-warning/15 text-warning",
    pending: "border-edge-mid bg-surface-raised text-secondary",
};

interface DagTaskNodeData {
    view: DagViewNode;
    channelid: string;
    runid: string;
    selected: boolean;
    onAction: (action: string) => void;
}

function DagTaskNode({ data }: NodeProps) {
    const d = data as unknown as DagTaskNodeData;
    const { view, selected } = d;
    const tone = STATE_TONE[view.state] ?? STATE_TONE.pending;
    return (
        <div
            className={`w-[168px] rounded-[11px] border bg-lane px-2.5 py-2 shadow-[0_2px_10px_rgba(0,0,0,0.25)] ${
                selected ? "border-accent" : "border-edge-mid"
            }`}
        >
            <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
            <div className="flex items-center justify-between gap-1.5">
                <span className="font-mono text-[9.5px] text-muted">{view.id}</span>
                <span
                    className={`rounded-[4px] border px-1 py-px font-mono text-[8.5px] uppercase tracking-wide ${tone}`}
                >
                    {view.state}
                </span>
            </div>
            <div className="mt-0.5 truncate text-[12px] font-semibold text-primary" title={view.label}>
                {view.label}
            </div>
            {view.meta ? <div className="truncate font-mono text-[9px] text-muted">{view.meta}</div> : null}
            {view.gate ? (
                <div className="mt-0.5 font-mono text-[8.5px] uppercase tracking-wide text-warning">gate</div>
            ) : null}
            {view.actions.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                    {view.actions.map((a) => (
                        <button
                            key={a}
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                d.onAction(a);
                            }}
                            className="cursor-pointer rounded-[4px] border border-edge-mid px-1.5 py-0.5 text-[9.5px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
                        >
                            {a}
                        </button>
                    ))}
                </div>
            ) : null}
            <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
        </div>
    );
}

const nodeTypes = { dagTask: DagTaskNode };

// the per-run graph: ReactFlow canvas fed by the pure view data + layered layout. Actions
// round-trip through the dag commands; the waveobj update re-derives the view. The provider
// must wrap the component that calls useReactFlow (the hook reads the provider's context).
export function DagGraphView({ oref }: { oref: string }) {
    return (
        <ReactFlowProvider>
            <DagGraphInner oref={oref} />
        </ReactFlowProvider>
    );
}

function DagGraphInner({ oref }: { oref: string }) {
    const [group, loading] = useDagGroup(oref);
    const selectedId = useAtomValue(selectedTaskIdAtom);
    const { fitView, zoomIn, zoomOut } = useReactFlow();

    const { nodes, edges, byId } = useMemo(() => {
        if (loading || !group)
            return { nodes: [] as Node[], edges: [] as Edge[], byId: new Map<string, DagViewNode>() };
        const { nodes: vnodes, edges: vedges } = buildViewData(group);
        const pos = computeLayeredLayout(group.tasks);
        const viewById = new Map(vnodes.map((n) => [n.id, n]));
        const reactNodes: Node[] = vnodes.map((n) => ({
            id: n.id,
            type: "dagTask",
            position: pos.get(n.id) ?? { x: 0, y: 0 },
            data: {
                view: n,
                channelid: group.channelid,
                runid: group.runid,
                selected: n.id === selectedId,
                onAction: (action: string) => runAction(group, n, action),
            } satisfies DagTaskNodeData,
        }));
        const reactEdges: Edge[] = vedges.map((e, i) => ({
            id: `e-${i}`,
            source: e.source,
            target: e.target,
            markerEnd: { type: MarkerType.ArrowClosed, color: "#6b7482" },
            style: {
                stroke: viewById.get(e.target)?.state === "failed" ? "#e5a50a" : "#6b7482",
                strokeDasharray: viewById.get(e.target)?.state === "failed" ? "6 4" : undefined,
            },
        }));
        return { nodes: reactNodes, edges: reactEdges, byId: viewById };
    }, [group, loading, selectedId]);

    const orderedIds = useMemo(() => (group ? group.tasks.map((t) => t.id) : []), [group]);

    // j/k move the selection through the task list (layer order). The modal owns Escape.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "j" && e.key !== "k") return;
            const cur = selectedId ? orderedIds.indexOf(selectedId) : -1;
            const next = e.key === "j" ? Math.min(cur + 1, orderedIds.length - 1) : Math.max(cur - 1, 0);
            if (next >= 0 && next !== cur) globalStore.set(selectedTaskIdAtom, orderedIds[next]);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [selectedId, orderedIds]);

    const selected = selectedId && byId.get(selectedId) ? byId.get(selectedId)! : null;

    if (loading || !group) {
        return <div className="flex h-full items-center justify-center text-sm text-muted">loading dag…</div>;
    }

    return (
        <div className="relative flex h-full min-h-0 w-full flex-col bg-background">
            <DagGraphHeader group={group} />
            <div className="relative min-h-0 flex-1">
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    fitView
                    fitViewOptions={{ padding: 0.2 }}
                    colorMode="dark"
                    proOptions={{ hideAttribution: true }}
                    onNodeClick={(_e, n) => globalStore.set(selectedTaskIdAtom, n.id)}
                    onPaneClick={() => globalStore.set(selectedTaskIdAtom, null)}
                    minZoom={0.2}
                >
                    <Background gap={24} size={1} color="rgba(120,130,150,0.14)" />
                </ReactFlow>
                {/* zoom cluster */}
                <div className="absolute right-3 top-3 z-[5] flex flex-col overflow-hidden rounded-[7px] border border-edge-mid bg-surface-raised">
                    <button
                        type="button"
                        onClick={() => void fitView({ padding: 0.2 })}
                        className="cursor-pointer px-2.5 py-1 text-[12px] text-secondary hover:bg-surface-hover"
                        title="fit"
                    >
                        ⤢
                    </button>
                    <button
                        type="button"
                        onClick={() => void zoomIn()}
                        className="cursor-pointer border-t border-edge-mid px-2.5 py-1 text-[12px] text-secondary hover:bg-surface-hover"
                        title="zoom in"
                    >
                        +
                    </button>
                    <button
                        type="button"
                        onClick={() => void zoomOut()}
                        className="cursor-pointer border-t border-edge-mid px-2.5 py-1 text-[12px] text-secondary hover:bg-surface-hover"
                        title="zoom out"
                    >
                        −
                    </button>
                </div>
            </div>
            {/* detail rail */}
            {selected ? (
                <div className="border-t border-border bg-lane px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <div className="font-mono text-[10px] text-muted">{selected.id}</div>
                            <div className="truncate text-[13px] font-semibold text-primary">{selected.label}</div>
                            <div className="text-[10.5px] text-secondary">
                                state <b className="text-primary">{selected.state}</b>
                                {selected.gate ? " · gate" : ""}
                                {selected.meta ? ` · ${selected.meta}` : ""}
                            </div>
                        </div>
                        {selected.actions.length > 0 ? (
                            <div className="flex flex-none gap-1.5">
                                {selected.actions.map((a) => (
                                    <button
                                        key={a}
                                        type="button"
                                        onClick={() => runAction(group, selected, a)}
                                        className="cursor-pointer rounded border border-edge-mid px-2.5 py-1 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
                                    >
                                        {a}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

// runAction dispatches the node's action to the dag commands; the resulting waveobj update
// re-derives the graph. blocked-merge "resolve" surfaces via the merge command (v1: retry).
function runAction(group: TaskGroup, view: DagViewNode, action: string) {
    const data = { channelid: group.channelid, runid: group.runid, taskid: view.id, action };
    if (action === "merge") {
        void RpcApi.DagMergeCommand(TabRpcClient, { channelid: group.channelid, runid: group.runid });
        return;
    }
    void RpcApi.DagActionCommand(TabRpcClient, data);
}
