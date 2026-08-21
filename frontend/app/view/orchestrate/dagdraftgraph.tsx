import {
    Background,
    Handle,
    Position,
    ReactFlow,
    ReactFlowProvider,
    type Edge,
    type Node,
    type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, type JSX } from "react";
import { computeLayeredLayout } from "./daglayout";
import { addDraftTask, setDraftParallelism, type DagDraft } from "./draftmodel";

function DraftTaskNode({ data }: NodeProps): JSX.Element {
    const task = data as { label: string; description: string; selected: boolean; route: RoutePin | null; onSelect: () => void };
    return (
        <button type="button" onClick={task.onSelect} className={`relative w-[168px] cursor-pointer rounded-lg border bg-lane px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${task.selected ? "border-accent" : "border-edge-mid"}`}>
            <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
            <span className="block truncate text-[12px] font-semibold text-primary">{task.label}</span>
            <span className="mt-1 block truncate font-mono text-xxs text-muted">{task.route == null ? "inherits Run route" : `${task.route.runtime} / ${task.route.tier}`}</span>
            {task.description ? <span className="mt-1 block truncate text-[10px] text-secondary">{task.description}</span> : null}
            <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-none !bg-edge-strong" />
        </button>
    );
}

const nodeTypes = { draftTask: DraftTaskNode };

export function DagDraftGraph({
    draft,
    selectedTaskId,
    onSelectTask,
    onChange,
    onOpenSummary,
}: {
    draft: DagDraft;
    selectedTaskId: string | null;
    onSelectTask: (taskId: string | null) => void;
    onChange?: (draft: DagDraft) => void;
    onOpenSummary?: () => void;
}): JSX.Element {
    const { nodes, edges } = useMemo(() => {
        const positions = computeLayeredLayout(draft.tasks);
        const nodes: Node[] = draft.tasks.map((task) => ({
            id: task.id,
            type: "draftTask",
            position: positions.get(task.id) ?? { x: 0, y: 0 },
            data: { label: task.label, description: task.description, route: task.route, selected: task.id === selectedTaskId, onSelect: () => onSelectTask(task.id) },
        }));
        const edges: Edge[] = draft.tasks.flatMap((task) => task.deps.map((dep, index) => ({ id: `${dep}-${task.id}-${index}`, source: dep, target: task.id, style: { stroke: "var(--color-edge-strong)" } })));
        return { nodes, edges };
    }, [draft, onSelectTask, selectedTaskId]);

    return (
        <ReactFlowProvider>
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-2">
                    {onOpenSummary ? <button type="button" onClick={onOpenSummary} className="cursor-pointer rounded-md border border-edge-mid px-2.5 py-1 text-[11px] font-semibold text-secondary hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Open summary</button> : null}
                    <span className="ml-auto font-mono text-xxs text-muted">Parallelism</span>
                    <button type="button" disabled={onChange == null || draft.parallelism <= 1} onClick={() => onChange?.(setDraftParallelism(draft, draft.parallelism - 1))} className="cursor-pointer rounded border border-edge-mid px-2 py-1 text-secondary disabled:opacity-40">−</button>
                    <span className="min-w-5 text-center font-mono text-xxs text-primary">{draft.parallelism}</span>
                    <button type="button" disabled={onChange == null || draft.parallelism >= 8} onClick={() => onChange?.(setDraftParallelism(draft, draft.parallelism + 1))} className="cursor-pointer rounded border border-edge-mid px-2 py-1 text-secondary disabled:opacity-40">+</button>
                    <button type="button" disabled={onChange == null || draft.tasks.length >= 8} onClick={() => onChange?.(addDraftTask(draft))} className="cursor-pointer rounded-md border border-edge-mid px-2.5 py-1 text-[11px] font-semibold text-secondary hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40">Add task</button>
                </div>
                <div className="relative min-h-0 flex-1 bg-background">
                    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} fitView fitViewOptions={{ padding: 0.2 }} colorMode="dark" proOptions={{ hideAttribution: true }} onNodeClick={(_event, node) => onSelectTask(node.id)} onPaneClick={() => onSelectTask(null)}>
                        <Background gap={24} size={1} color="var(--color-edge-faint)" />
                    </ReactFlow>
                </div>
            </div>
        </ReactFlowProvider>
    );
}
