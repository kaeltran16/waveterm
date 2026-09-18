import { atom, type PrimitiveAtom } from "jotai";
import { useWaveObjectValue } from "../../store/wos";
import { capabilityFor } from "../agents/route";
import { canEscalate } from "./escalate";

// selectedTaskIdAtom is shared by the live graph and its detail rail. Opening or closing a modal resets
// it through dagmodalstate.ts, while node clicks and keyboard navigation update it directly.
export const selectedTaskIdAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export type DagNodeRoute = {
    source: "pinned" | "workers" | "inherited";
    runtime: string;
    model: string; // exact model id; "" when the runtime runs its own default
    resolvedModel: string;
};

// routeSourceLabel is how a node names where its route came from.
export function routeSourceLabel(source: DagNodeRoute["source"]): string {
    switch (source) {
        case "pinned":
            return "pinned";
        case "workers":
            return "run worker route";
        default:
            return "inherits run route";
    }
}

export type DagActionRoute = "pick-route" | "merge" | "continue" | "action";

// dagActionRoute is where a node action goes. escalate needs a target model, which only the route picker
// supplies; sent bare, the server rejects it.
export function dagActionRoute(action: string): DagActionRoute {
    switch (action) {
        case "escalate":
            return "pick-route";
        case "merge":
            return "merge";
        case "resolve":
            return "continue";
        default:
            return "action";
    }
}

// dagActionError is the line the detail panel shows for a refused DAG action.
export function dagActionError(action: string, taskId: string, err: unknown): string {
    const reason = err instanceof Error ? err.message : String(err);
    return `${action} ${taskId} failed: ${reason}`;
}

// the engine's default runtime for a worker route that names only a model (runroute.DefaultRuntime)
const DEFAULT_RUNTIME = "claude";

// normalizeWorkerPin mirrors effectiveTaskRoute (pkg/orchestrate/engine.go): the dag's worker route applies
// when it names a runtime or a model.
function normalizeWorkerPin(pin: RoutePin | undefined): RoutePin | null {
    if (pin == null || (!pin.runtime && !pin.model)) return null;
    return { runtime: pin.runtime || DEFAULT_RUNTIME, ...(pin.model ? { model: pin.model } : {}) };
}

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
    "verify-failed": ["resolve"],
    failed: ["retry", "skip"],
    stalled: ["retry", "skip"],
};
const GATE_DONE_ACTIONS = ["approve", "sendback"];

// mergeReadyIds is the set of tasks a merge can be started from now, read from the digest: a lane merges as
// one, at its tip, and only the engine derives lanes. Empty while the digest is missing or stale, because the
// engine lands merges on its own and a missing button costs nothing.
export function mergeReadyIds(digest: DagStatusDigest | undefined, stale: boolean): Set<string> {
    if (digest == null || stale) return new Set();
    return new Set((digest.tasks ?? []).filter((row) => row.mergestate === "ready").map((row) => row.taskid));
}

// buildViewData maps the persisted group onto graph nodes/edges plus the action set each
// node offers. Pure: the view renders exactly this. mergeReady comes from mergeReadyIds.
export function buildViewData(
    group: TaskGroup,
    owner: Run,
    harnesses: HarnessInfo[],
    mergeReady: ReadonlySet<string>
): { nodes: DagViewNode[]; edges: DagViewEdge[] } {
    const ownerPin = normalizeRunPin(owner);
    const workerPin = normalizeWorkerPin(group.workerroute);
    const nodes: DagViewNode[] = group.tasks.map((t) => {
        let actions = ACTION_BY_STATE[t.state] ?? [];
        if (t.gate && t.state === "done") actions = GATE_DONE_ACTIONS;
        if (mergeReady.has(t.id)) actions = ["merge"];
        if (canEscalate(t)) actions = [...new Set([...actions, "escalate"])];
        const taskPin = t.runspec?.runtime || t.runspec?.model ? normalizeSpecPin(t.runspec, owner) : null;
        const effective: RoutePin = taskPin ?? workerPin ?? ownerPin ?? { runtime: "" };
        const capability = capabilityFor(effective, harnesses);
        return {
            id: t.id,
            label: t.label ?? t.id,
            state: t.state,
            gate: t.gate ?? false,
            meta: t.runid ? `wave/${t.runid}` : "",
            actions,
            route: {
                source: taskPin != null ? ("pinned" as const) : workerPin != null ? ("workers" as const) : ("inherited" as const),
                runtime: effective.runtime,
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

function normalizeRunPin(run: Pick<Run, "runtime" | "model">): RoutePin | null {
    if (!run.runtime && !run.model) return null;
    return { runtime: run.runtime ?? "", ...(run.model ? { model: run.model } : {}) };
}

function normalizeSpecPin(spec: TaskNode["runspec"] | undefined, owner: Run): RoutePin | null {
    if (spec == null || (!spec.runtime && !spec.model)) return null;
    return { runtime: spec.runtime || owner.runtime || "", ...(spec.model ? { model: spec.model } : {}) };
}
