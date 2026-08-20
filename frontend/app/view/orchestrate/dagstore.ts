import { atom, type PrimitiveAtom } from "jotai";
import { useWaveObjectValue } from "../../store/wos";

// selectedTaskIdAtom is shared by the live graph and its detail rail. Opening or closing a modal resets
// it through dagmodalstate.ts, while node clicks and keyboard navigation update it directly.
export const selectedTaskIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export interface DagViewNode {
    id: string;
    label: string;
    state: string;
    gate: boolean;
    meta: string; // worktree / evidence line
    actions: string[]; // approve | sendback | retry | skip | merge
}
export interface DagViewEdge {
    source: string;
    target: string;
}

const ACTION_BY_STATE: Record<string, string[]> = {
    "blocked-merge": ["resolve"],
    failed: ["retry", "skip"],
    stalled: ["retry", "skip"],
};
const GATE_DONE_ACTIONS = ["approve", "sendback"];

// buildViewData maps the persisted group onto graph nodes/edges plus the action set each
// node offers. Pure: the view renders exactly this.
export function buildViewData(group: TaskGroup): { nodes: DagViewNode[]; edges: DagViewEdge[] } {
    const nodes: DagViewNode[] = group.tasks.map((t) => {
        let actions = ACTION_BY_STATE[t.state] ?? [];
        if (t.gate && t.state === "done") actions = GATE_DONE_ACTIONS;
        if (t.state === "done" && !t.gate && !t.released) actions = ["merge"];
        return {
            id: t.id,
            label: t.label ?? t.id,
            state: t.state,
            gate: t.gate ?? false,
            meta: t.runid ? `wave/${t.runid}` : "",
            actions,
        };
    });
    const edges: DagViewEdge[] = [];
    for (const t of group.tasks) {
        for (const d of t.deps ?? []) edges.push({ source: d, target: t.id });
    }
    return { nodes, edges };
}

// useDagGroup subscribes the caller to the live dag object for its oref.
export function useDagGroup(oref: string) {
    return useWaveObjectValue<TaskGroup>(oref);
}
