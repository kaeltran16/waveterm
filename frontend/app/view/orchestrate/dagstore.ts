import { atom, type PrimitiveAtom } from "jotai";
import { useWaveObjectValue } from "../../store/wos";
import { capabilityFor } from "../agents/route";
import { canEscalate } from "./escalate";

// selectedTaskIdAtom is shared by the live graph and its detail rail. Opening or closing a modal resets
// it through dagmodalstate.ts, while node clicks and keyboard navigation update it directly.
export const selectedTaskIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export type DagNodeRoute = {
    source: "pinned" | "inherited";
    runtime: string;
    tier: string;
    model: string; // exact model id when set; "" for legacy tier routes
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
    const ownerPin = normalizeRunPin(owner);
    const nodes: DagViewNode[] = group.tasks.map((t) => {
        let actions = ACTION_BY_STATE[t.state] ?? [];
        if (t.gate && t.state === "done") actions = GATE_DONE_ACTIONS;
        if (t.state === "done" && !t.gate && !t.merged) actions = ["merge"];
        if (canEscalate(t)) actions = [...new Set([...actions, "escalate"])];
        const taskPin = t.runspec?.runtime || t.runspec?.model ? normalizeSpecPin(t.runspec, owner) : null;
        const effective = taskPin ?? ownerPin ?? { runtime: "", tier: "capable", model: "" } as RoutePin;
        const capability = capabilityFor(effective, harnesses);
        return {
            id: t.id,
            label: t.label ?? t.id,
            state: t.state,
            gate: t.gate ?? false,
            meta: t.runid ? `wave/${t.runid}` : "",
            actions,
            route: {
                source: taskPin == null ? ("inherited" as const) : ("pinned" as const),
                runtime: effective.runtime,
                tier: effective.tier,
                model: effective.model ?? "",
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

// normalizeRunPin folds a run's runtime+tier(+model) into a selectable pin; model wins.
function normalizeRunPin(run: Pick<Run, "runtime" | "tier" | "model">): RoutePin | null {
    if (!run.runtime && !run.model) return null;
    return { runtime: run.runtime ?? "", tier: run.tier || "capable", ...(run.model ? { model: run.model } : {}) };
}

function normalizeSpecPin(spec: TaskNode["runspec"] | undefined, owner: Run): RoutePin | null {
    if (spec == null || (!spec.runtime && !spec.model)) return null;
    return {
        runtime: spec.runtime ?? owner.runtime ?? "",
        tier: spec.tier || "capable",
        ...(spec.model ? { model: spec.model } : {}),
    };
}
