import { atom, type PrimitiveAtom } from "jotai";
import { globalStore } from "../../store/jotaiStore";
import { useWaveObjectValue } from "../../store/wos";

// dagViewOrefAtom is the dag currently open in the graph surface ("dag:<id>"), or null.
// No nav surface owns it: run cards open the graph, Escape/back clears it.
// (cast to PrimitiveAtom: gotypes.d.ts declares a global Atom type that clashes with jotai's)
export const dagViewOrefAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const selectedTaskIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export function openDag(oref: string) {
    globalStore.set(dagViewOrefAtom, oref);
    globalStore.set(selectedTaskIdAtom, null);
}
export function closeDag() {
    globalStore.set(dagViewOrefAtom, null);
    globalStore.set(selectedTaskIdAtom, null);
}

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
