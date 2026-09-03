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
import { atom, useAtomValue, type Atom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { AgentsViewModel } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { runAtom } from "../agents/channelsstore";
import { StatusLine } from "../agents/statusline";
import { RoutePicker } from "../agents/routepicker";
import { DagGraphHeader } from "./daggraph-header";
import { computeLayeredLayout } from "./daglayout";
import { buildViewData, selectedTaskIdAtom, useDagGroup, type DagViewNode } from "./dagstore";
import { escalatePayload } from "./escalate";
import { dagModalAgentsContextAtom } from "./dagmodalstate";
import { openTaskWorker, resolveTaskWorker, type TaskWorkerView } from "./taskcorrelate";

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
            data-dag-node-route={`${view.route.source}:${view.route.runtime}:${view.route.tier}`}
            className={`w-[168px] rounded-[11px] border bg-lane px-2.5 py-2 shadow-popover-line ${
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
            <div className="truncate font-mono text-[9px] text-secondary">
                {view.route.source === "pinned" ? "pinned" : "inherits run route"} · {view.route.runtime} / {view.route.model || view.route.tier} · {view.route.resolvedModel}
            </div>
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

// SelectedTaskWorker renders the selected task's worker treatment in the modal rail: the shared status
// line when dispatched, Open in Agent navigation, and the explicit pending / worker-unavailable states
// per spec 6.2. Node clicks still only select — navigation happens through the buttons.
function SelectedTaskWorker({
    taskNode,
    channelId,
    model,
    agents,
}: {
    taskNode: TaskNode;
    channelId: string;
    model: AgentsViewModel;
    agents: AgentVM[];
}) {
    const childRun = useAtomValue<Run | undefined>(
        (taskNode.runid ? runAtom(taskNode.runid) : NO_RUN_ATOM) as Atom<Run | undefined>
    );
    const worker: TaskWorkerView = resolveTaskWorker({ id: taskNode.id, runid: taskNode.runid }, childRun, agents);
    if (worker.state === "pending") {
        return (
            <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-edge-strong" />
                Not dispatched yet
            </div>
        );
    }
    if (worker.state === "dispatched" && worker.agent) {
        return (
            <div className="mt-1.5 flex min-w-0 items-center gap-2">
                <StatusLine agent={worker.agent} nowAtom={model.nowAtom} className="min-w-0 flex-1" />
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        openTaskWorker(worker, model, channelId);
                    }}
                    className="flex-none cursor-pointer rounded-[5px] border border-accent/50 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-accent-soft hover:border-accent"
                >
                    Open in Agent ↗
                </button>
            </div>
        );
    }
    return (
        <div className="mt-1.5 flex min-w-0 items-center gap-2 font-mono text-[10px] text-muted">
            <span className="shrink-0">Worker session unavailable</span>
            <div className="flex-1" />
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    openTaskWorker(worker, model, channelId);
                }}
                className="flex-none cursor-pointer rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] text-secondary hover:border-edge-strong"
            >
                View child run
            </button>
        </div>
    );
}

// stable no-run atom for a task that has not been dispatched (runAtom is oref-cached, so per-run
// atoms keep identity across renders; a static Atom is needed for the no-run slot so the row's hook
// count never varies)
const NO_RUN_ATOM = atom<Run | undefined>(undefined);

// the per-run graph: ReactFlow canvas fed by the pure view data + layered layout. Actions
// round-trip through the dag commands; the waveobj update re-derives the view. The provider
// must wrap the component that calls useReactFlow (the hook reads the provider's context).
export function DagGraphView({ oref, owner, harnesses }: { oref: string; owner: Run; harnesses: HarnessInfo[] }) {
    return (
        <ReactFlowProvider>
            <DagGraphInner oref={oref} owner={owner} harnesses={harnesses} />
        </ReactFlowProvider>
    );
}

function DagGraphInner({ oref, owner, harnesses }: { oref: string; owner: Run; harnesses: HarnessInfo[] }) {
    const [group, loading] = useDagGroup(oref);
    const selectedId = useAtomValue(selectedTaskIdAtom);
    const { fitView, zoomIn, zoomOut } = useReactFlow();

    const { nodes, edges, byId } = useMemo(() => {
        if (loading || !group)
            return { nodes: [] as Node[], edges: [] as Edge[], byId: new Map<string, DagViewNode>() };
        const { nodes: vnodes, edges: vedges } = buildViewData(group, owner, harnesses);
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
            markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-edge-strong)" },
            style: {
                stroke: viewById.get(e.target)?.state === "failed" ? "var(--color-warning)" : "var(--color-edge-strong)",
                strokeDasharray: viewById.get(e.target)?.state === "failed" ? "6 4" : undefined,
            },
        }));
        return { nodes: reactNodes, edges: reactEdges, byId: viewById };
    }, [group, harnesses, loading, owner, selectedId]);

    const orderedIds = useMemo(() => (group ? group.tasks.map((t) => t.id) : []), [group]);
    const [escalating, setEscalating] = useState(false);
    const [escalateRoute, setEscalateRoute] = useState<RoutePin | null>(null);

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
    const agentsCtx = useAtomValue(dagModalAgentsContextAtom);
    const selectedNode = group && selectedId ? group.tasks.find((t) => t.id === selectedId) : undefined;

    if (loading || !group) {
        return <div className="flex h-full items-center justify-center text-sm text-muted">loading dag…</div>;
    }

    return (
        <div className="relative flex h-full min-h-0 w-full flex-col bg-background">
            <DagGraphHeader group={group} />
            <div className="flex flex-none items-center gap-2 border-b border-border bg-surface px-4 py-1.5 font-mono text-xxs text-muted">
                Run route · {owner.runtime || "unavailable"} / {owner.tier || "capable"}
            </div>
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
                    <Background gap={24} size={1} color="color-mix(in srgb, var(--color-ink-mid) 14%, transparent)" />
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
                            <div className="font-mono text-[10px] text-secondary" data-dag-node-route={`${selected.route.source}:${selected.route.runtime}:${selected.route.tier}`}>
                                {selected.route.source === "pinned" ? "pinned" : "inherits run route"} · {selected.route.runtime} / {selected.route.model || selected.route.tier} · {selected.route.resolvedModel}
                            </div>
                            {selectedNode && agentsCtx ? (
                                <SelectedTaskWorker
                                    taskNode={selectedNode}
                                    channelId={group.channelid}
                                    model={agentsCtx.model}
                                    agents={agentsCtx.agents}
                                />
                            ) : null}
                        </div>
                        {selected.actions.length > 0 ? (
                            <div className="flex flex-none gap-1.5">
                                {selected.actions.map((a) =>
                                    a === "escalate" ? (
                                        <button
                                            key={a}
                                            type="button"
                                            onClick={() => setEscalating(!escalating)}
                                            aria-expanded={escalating}
                                            className="cursor-pointer rounded border border-edge-mid bg-surface px-2.5 py-1 text-[11px] font-semibold text-accent hover:border-edge-strong hover:text-accent-soft"
                                        >
                                            escalate…
                                        </button>
                                    ) : (
                                        <button
                                            key={a}
                                            type="button"
                                            onClick={() => runAction(group, selected, a)}
                                            className="cursor-pointer rounded border border-edge-mid px-2.5 py-1 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
                                        >
                                            {a}
                                        </button>
                                    )
                                )}
                            </div>
                        ) : null}
                    </div>
                    {escalating && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
                            <RoutePicker value={escalateRoute} canInherit={false} onChange={setEscalateRoute} placement="top-start" />
                            <span className="text-[10px] text-muted">one judged hop — a second failure blocks this task for you</span>
                            <div className="ml-auto flex gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => setEscalating(false)}
                                    className="cursor-pointer rounded border border-edge-mid px-2.5 py-1 text-[11px] text-secondary hover:border-edge-strong"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    disabled={escalateRoute == null}
                                    onClick={() => {
                                        if (escalateRoute && selected) {
                                            runEscalate(group, selected, escalateRoute);
                                            setEscalating(false);
                                            setEscalateRoute(null);
                                        }
                                    }}
                                    className="cursor-pointer rounded bg-accent px-2.5 py-1 text-[11px] font-semibold text-background hover:bg-accenthover disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Re-queue on model
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}

// runEscalate re-queues a failed/stalled task on the exact model the human picked; one judged hop.
function runEscalate(group: TaskGroup, view: DagViewNode, route: RoutePin) {
    void RpcApi.DagActionCommand(TabRpcClient, escalatePayload(group.channelid, group.runid, view.id, route));
}

// runAction dispatches the node's action to the dag commands; the resulting waveobj update
// re-derives the graph. "resolve" finishes a blocked squash merge the human resolved in the
// project tree; the remaining actions go through the engine's dag action RPC.
function runAction(group: TaskGroup, view: DagViewNode, action: string) {
    const data = { channelid: group.channelid, runid: group.runid, taskid: view.id, action };
    const mergeData = { channelid: group.channelid, runid: group.runid, taskid: view.id };
    if (action === "merge") {
        void RpcApi.DagMergeCommand(TabRpcClient, mergeData);
        return;
    }
    if (action === "resolve") {
        void RpcApi.DagMergeContinueCommand(TabRpcClient, mergeData);
        return;
    }
    void RpcApi.DagActionCommand(TabRpcClient, data);
}
