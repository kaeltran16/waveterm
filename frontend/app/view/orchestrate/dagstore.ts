import { atom, type PrimitiveAtom } from "jotai";
import { useWaveObjectValue } from "../../store/wos";
import { capabilityFor, normalizeLegacyRoute } from "../agents/route";

// selectedTaskIdAtom is shared by the live graph and its detail rail. Opening or closing a modal resets
// it through dagmodalstate.ts, while node clicks and keyboard navigation update it directly.
export const selectedTaskIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export type DagNodeRoute = {
    source: "pinned" | "inherited";
    runtime: string;
    tier: string;
    resolvedModel: string;
};

export interface DagViewNode {
    id: string;
    label: string;
    state: string;
    gate: boolean;
    meta: string; // worktree / evidence line
    actions: string[]; // approve | sendback | retry | skip | merge
    route: DagNodeRoute;
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
export function buildViewData(group: TaskGroup, owner: Run, harnesses: HarnessInfo[]): { nodes: DagViewNode[]; edges: DagViewEdge[] } {
    const ownerRoute = normalizeLegacyRoute(owner.runtime ?? "", owner.tier);
    const nodes: DagViewNode[] = group.tasks.map((t) => {
        let actions = ACTION_BY_STATE[t.state] ?? [];
        if (t.gate && t.state === "done") actions = GATE_DONE_ACTIONS;
        if (t.state === "done" && !t.gate && !t.merged) actions = ["merge"];
        const taskRoute = t.runspec?.runtime ? normalizeLegacyRoute(t.runspec.runtime, t.runspec.tier) : null;
        const effective = taskRoute ?? ownerRoute ?? { runtime: "", tier: "capable" };
        const capability = capabilityFor(effective, harnesses);
        return {
            id: t.id,
            label: t.label ?? t.id,
            state: t.state,
            gate: t.gate ?? false,
            meta: t.runid ? `wave/${t.runid}` : "",
            actions,
            route: {
                source: taskRoute == null ? "inherited" : "pinned",
                runtime: effective.runtime,
                tier: effective.tier,
                resolvedModel: capability?.resolvedmodel ?? "unavailable",
            },
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
