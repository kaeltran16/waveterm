// Copyright 2026, Command Line Inc.
//
// Pure: group a run's lifecycle events into the hybrid timeline — cross-cutting events under a RUN
// group, phase-scoped events under their phase group — plus a 3-event collapsed preview (newest
// first). Grouping does not depend on live state; the store in runeventstore.ts feeds it.

export const RUN_GROUP_ID = "run";
export const PREVIEW_COUNT = 3;

export interface RunTimelineGroup {
    id: string; // RUN_GROUP_ID or "phase-<index+1>"
    title: string; // "RUN" or "PHASE N · <kind>"
    events: RunEvent[];
}

// kinds that render under the RUN group — everything not phase-scoped.
const RUN_GROUP_KINDS = new Set([
    "run-created",
    "triage",
    "child-created",
    "child-done",
    "child-cancelled",
    "run-cancelled",
    "evidence-sealed",
    "task-spawned",
    "task-stalled",
    "dag-blocked",
    "dag-done",
]);

export function buildRunTimeline(run: Run, events: RunEvent[]): { groups: RunTimelineGroup[]; preview: RunEvent[] } {
    if (events.length === 0) {
        return { groups: [], preview: [] };
    }
    const sorted = [...events].sort((a, b) => b.ts - a.ts);
    const groups: RunTimelineGroup[] = [];
    const runEvents = sorted.filter((e) => RUN_GROUP_KINDS.has(e.kind));
    if (runEvents.length > 0) {
        groups.push({ id: RUN_GROUP_ID, title: "RUN", events: runEvents });
    }
    (run.phases ?? []).forEach((_, i) => {
        const phaseEvents = sorted.filter((e) => e.phaseidx === i);
        if (phaseEvents.length > 0) {
            groups.push({ id: `phase-${i + 1}`, title: `PHASE ${i + 1} · ${(run.phases?.[i].kind ?? "").toUpperCase()}`, events: phaseEvents });
        }
    });
    return { groups, preview: sorted.slice(0, PREVIEW_COUNT) };
}