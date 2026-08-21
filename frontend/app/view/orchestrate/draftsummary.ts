import type { DagDraftRequest } from "../agents/composercommand";
import { validateDraft, type DagDraft } from "./draftmodel";

export type DraftWave = { index: number; taskIds: string[] };

export type DraftException =
    | { kind: "gate"; taskId: string; label: string }
    | { kind: "route"; taskId: string; label: string; route: RoutePin };

export type DagDraftSummary = {
    title: string;
    runRoute: RoutePin;
    taskCount: number;
    parallelism: number;
    waves: DraftWave[];
    routineTaskIds: string[];
    exceptions: DraftException[];
    warnings: string[];
    fallback: boolean;
    validationErrors: string[];
    canLaunch: boolean;
};

export function dependencyWaves(draft: DagDraft): DraftWave[] {
    const pending = [...draft.tasks];
    const assigned = new Set<string>();
    const waves: DraftWave[] = [];
    while (pending.length > 0) {
        const ready = pending.filter((task) => task.deps.every((dep) => assigned.has(dep)));
        if (ready.length === 0) return [];
        waves.push({ index: waves.length, taskIds: ready.map((task) => task.id) });
        ready.forEach((task) => assigned.add(task.id));
        const readyIds = new Set(ready.map((task) => task.id));
        for (let i = pending.length - 1; i >= 0; i--) {
            if (readyIds.has(pending[i].id)) pending.splice(i, 1);
        }
    }
    return waves;
}

export function projectDraftSummary(input: {
    request: DagDraftRequest;
    draft: DagDraft;
    fallback: boolean;
    warnings: string[];
    harnesses: HarnessInfo[];
}): DagDraftSummary {
    const validationErrors = validateDraft(input.draft, input.harnesses);
    const gateExceptions: DraftException[] = input.draft.tasks
        .filter((task) => task.gate)
        .map((task) => ({ kind: "gate", taskId: task.id, label: task.label }));
    const routeExceptions: DraftException[] = input.draft.tasks
        .filter((task) => task.route != null)
        .map((task) => ({ kind: "route", taskId: task.id, label: task.label, route: { ...task.route! } }));
    const exceptions = [...gateExceptions, ...routeExceptions];
    const exceptionalIds = new Set(exceptions.map((exception) => exception.taskId));
    return {
        title: input.draft.title,
        runRoute: { ...input.request.route },
        taskCount: input.draft.tasks.length,
        parallelism: input.draft.parallelism,
        waves: dependencyWaves(input.draft),
        routineTaskIds: input.draft.tasks.filter((task) => !exceptionalIds.has(task.id)).map((task) => task.id),
        exceptions,
        warnings: [...input.warnings],
        fallback: input.fallback,
        validationErrors,
        canLaunch: validationErrors.length === 0,
    };
}
