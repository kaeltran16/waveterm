import { capabilityFor } from "../agents/route";

export const MAX_DRAFT_TASKS = 8;
export const MAX_DRAFT_PARALLELISM = 8;

export type DraftTask = {
    id: string;
    label: string;
    description: string;
    deps: string[];
    gate: boolean;
    route: RoutePin | null;
};

export type DagDraft = {
    title: string;
    parallelism: number;
    tasks: DraftTask[];
};

function copyTask(task: DraftTask): DraftTask {
    return { ...task, deps: [...task.deps], route: task.route == null ? null : { ...task.route } };
}

function taskIndex(draft: DagDraft, id: string): number {
    return draft.tasks.findIndex((task) => task.id === id);
}

export function draftFromPlan(response: CommandJarvisPlanDagRtnData): DagDraft {
    const tasks = response.draft.tasks.map((task) => ({
        id: task.id,
        label: task.label,
        description: task.description ?? "",
        deps: [...(task.deps ?? [])],
        gate: task.gate ?? false,
        route: task.route == null ? null : { ...task.route },
    }));
    return {
        title: response.draft.title,
        parallelism: tasks.length === 1 ? 1 : 2,
        tasks,
    };
}

export function draftFromSubtasks(goal: string, subtasks: string[]): DagDraft {
    return draftFromPlan({
        draft: {
            title: goal,
            tasks: subtasks.map((label, index) => ({
                id: `t-${index + 1}`,
                label,
                description: "",
                deps: [],
                gate: false,
            })),
        },
    } as CommandJarvisPlanDagRtnData);
}

export function addDraftTask(draft: DagDraft, label = "New task"): DagDraft {
    if (draft.tasks.length >= MAX_DRAFT_TASKS) return draft;
    const used = new Set(draft.tasks.map((task) => task.id));
    let number = 1;
    while (used.has(`t-${number}`)) number++;
    return {
        ...draft,
        tasks: [
            ...draft.tasks.map(copyTask),
            { id: `t-${number}`, label, description: "", deps: [], gate: false, route: null },
        ],
    };
}

export function renameDraftTask(draft: DagDraft, id: string, label: string): DagDraft {
    const index = taskIndex(draft, id);
    if (index < 0 || draft.tasks[index].label === label) return draft;
    const tasks = draft.tasks.map(copyTask);
    tasks[index] = { ...tasks[index], label };
    return { ...draft, tasks };
}

export function setDraftDescription(draft: DagDraft, id: string, description: string): DagDraft {
    const index = taskIndex(draft, id);
    if (index < 0 || draft.tasks[index].description === description) return draft;
    const tasks = draft.tasks.map(copyTask);
    tasks[index] = { ...tasks[index], description };
    return { ...draft, tasks };
}

export function deleteDraftTask(draft: DagDraft, id: string): DagDraft {
    if (draft.tasks.length <= 1 || taskIndex(draft, id) < 0) return draft;
    return {
        ...draft,
        tasks: draft.tasks
            .filter((task) => task.id !== id)
            .map((task) => ({ ...copyTask(task), deps: task.deps.filter((dep) => dep !== id) })),
    };
}

function reaches(draft: DagDraft, start: string, target: string): boolean {
    const byId = new Map(draft.tasks.map((task) => [task.id, task]));
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
        if (id === target) return true;
        if (visited.has(id)) return false;
        visited.add(id);
        return (byId.get(id)?.deps ?? []).some(visit);
    };
    return visit(start);
}

export function setDraftDependency(draft: DagDraft, id: string, dep: string, enabled: boolean): DagDraft {
    const index = taskIndex(draft, id);
    if (index < 0 || taskIndex(draft, dep) < 0 || id === dep) return draft;
    const task = draft.tasks[index];
    if (!enabled) {
        if (!task.deps.includes(dep)) return draft;
        const tasks = draft.tasks.map(copyTask);
        tasks[index] = { ...tasks[index], deps: tasks[index].deps.filter((item) => item !== dep) };
        return { ...draft, tasks };
    }
    if (task.deps.includes(dep) || reaches(draft, dep, id)) return draft;
    const tasks = draft.tasks.map(copyTask);
    tasks[index] = { ...tasks[index], deps: [...tasks[index].deps, dep] };
    return { ...draft, tasks };
}

export function dependencyCandidates(draft: DagDraft, id: string): DraftTask[] {
    if (taskIndex(draft, id) < 0) return [];
    return draft.tasks.filter((candidate) => {
        if (candidate.id === id) return false;
        if (draft.tasks[taskIndex(draft, id)].deps.includes(candidate.id)) return true;
        return setDraftDependency(draft, id, candidate.id, true) !== draft;
    });
}

export function setDraftGate(draft: DagDraft, id: string, gate: boolean): DagDraft {
    const index = taskIndex(draft, id);
    if (index < 0 || draft.tasks[index].gate === gate) return draft;
    const tasks = draft.tasks.map(copyTask);
    tasks[index] = { ...tasks[index], gate };
    return { ...draft, tasks };
}

export function setDraftRoute(draft: DagDraft, id: string, route: RoutePin | null): DagDraft {
    const index = taskIndex(draft, id);
    if (index < 0) return draft;
    const current = draft.tasks[index].route;
    if (current?.runtime === route?.runtime && current?.tier === route?.tier) return draft;
    const tasks = draft.tasks.map(copyTask);
    tasks[index] = { ...tasks[index], route: route == null ? null : { ...route } };
    return { ...draft, tasks };
}

export function setDraftParallelism(draft: DagDraft, parallelism: number): DagDraft {
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > MAX_DRAFT_PARALLELISM) return draft;
    if (draft.parallelism === parallelism) return draft;
    return { ...draft, parallelism, tasks: draft.tasks.map(copyTask) };
}

export function validateDraft(draft: DagDraft, harnesses: HarnessInfo[]): string[] {
    const errors: string[] = [];
    if (!draft.title.trim()) errors.push("title is required");
    if (!Number.isInteger(draft.parallelism) || draft.parallelism < 1 || draft.parallelism > MAX_DRAFT_PARALLELISM) {
        errors.push("parallelism must be an integer from 1 through 8");
    }
    if (draft.tasks.length === 0) errors.push("at least one task is required");
    if (draft.tasks.length > MAX_DRAFT_TASKS) errors.push("no more than 8 tasks are allowed");

    const ids = new Set<string>();
    for (const task of draft.tasks) {
        if (!task.id.trim()) errors.push("task id is required");
        if (ids.has(task.id)) errors.push(`duplicate task id ${task.id}`);
        ids.add(task.id);
        if (!task.label.trim()) errors.push(`task ${task.id} label is required`);
        if (task.route != null && capabilityFor(task.route, harnesses) == null) {
            errors.push(`task ${task.id} route is not supported by an installed backend`);
        }
    }
    for (const task of draft.tasks) {
        const deps = new Set<string>();
        for (const dep of task.deps) {
            if (dep === task.id) errors.push(`task ${task.id} depends on itself`);
            if (!ids.has(dep)) errors.push(`task ${task.id} depends on unknown task ${dep}`);
            if (deps.has(dep)) errors.push(`task ${task.id} has duplicate dependency ${dep}`);
            deps.add(dep);
        }
    }
    for (const task of draft.tasks) {
        if (task.deps.some((dep) => dep === task.id || reaches(draft, dep, task.id))) {
            errors.push(`dependency cycle involving ${task.id}`);
            break;
        }
    }
    return errors;
}

export function toDagSubmitPayload(draft: DagDraft): { title: string; parallelism: number; tasks: TaskNode[] } {
    return {
        title: draft.title,
        parallelism: draft.parallelism,
        tasks: draft.tasks.map((task) => ({
            id: task.id,
            label: task.label,
            description: task.description,
            deps: [...task.deps],
            gate: task.gate,
            state: "",
            ...(task.route == null ? {} : { runspec: { runtime: task.route.runtime, tier: task.route.tier } }),
        })),
    };
}
