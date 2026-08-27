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
            groups.push({
                id: `phase-${i + 1}`,
                title: `PHASE ${i + 1} · ${(run.phases?.[i].kind ?? "").toUpperCase()}`,
                events: phaseEvents,
            });
        }
    });
    return { groups, preview: sorted.slice(0, PREVIEW_COUNT) };
}
// --- row rendering helpers (pure; the view maps them to DOM) ---

// KIND_TITLE renders each event kind as a human sentence; a kind outside the map (older rows or a
// future kind) falls back to the raw kind string rather than blanking the row.
const KIND_TITLE: Record<string, string> = {
    "run-created": "Run created",
    "phase-started": "Phase started",
    "phase-complete": "Phase complete",
    "phase-held": "Held for review",
    "gate-approved": "Gate approved",
    "gate-sent-back": "Gate sent back",
    triage: "Triage",
    "child-created": "Child run created",
    "child-done": "Child done",
    "child-cancelled": "Child cancelled",
    "run-cancelled": "Run cancelled",
    "evidence-sealed": "Evidence sealed",
    "task-spawned": "Task spawned",
    "task-stalled": "Task stalled",
    "dag-blocked": "DAG blocked",
    "dag-done": "DAG complete",
};

// KIND_TONE stays inside the EXISTING status/phase tone utilities (the same token classes
// TONE_CLASS / PHASE_TONE_CLASS in runbody.tsx use). No new colors: success = progress, warning =
// attention/stall, asking = review, muted = terminal/informational.
const KIND_TONE: Record<string, string> = {
    "run-created": "text-success",
    "phase-started": "text-success",
    "phase-complete": "text-success",
    "child-created": "text-success",
    "child-done": "text-success",
    "evidence-sealed": "text-success",
    "gate-approved": "text-success",
    "task-spawned": "text-success",
    "dag-done": "text-success",
    "phase-held": "text-asking",
    "gate-sent-back": "text-warning",
    triage: "text-warning",
    "task-stalled": "text-warning",
    "dag-blocked": "text-warning",
    "child-cancelled": "text-muted",
    "run-cancelled": "text-muted",
};

export function eventKindTitle(kind: string): string {
    return KIND_TITLE[kind] ?? kind;
}

export function eventTitle(event: RunEvent): string {
    return eventKindTitle(event.kind);
}

// detailOf parses the row's JSON detail payload; undefined on malformed data (a row render must
// never throw over a telemetry blob).
export function detailOf<T>(event: RunEvent): T | undefined {
    if (event.detail == null) {
        return undefined;
    }
    if (typeof event.detail === "object") {
        return event.detail as unknown as T;
    }
    try {
        return JSON.parse(event.detail as string) as T;
    } catch {
        return undefined;
    }
}

// artifactsOf extracts the reported artifact list (completed/held detail rows), for the row's
// inline "open first artifact" link.
export function artifactsOf(event: RunEvent): string[] {
    const detail = detailOf<{ artifacts?: string[] }>(event);
    return Array.isArray(detail?.artifacts) ? detail!.artifacts! : [];
}

export function tsLabel(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

export function toneFor(kind: string): string {
    return KIND_TONE[kind] ?? "text-muted";
}

// --- click dispatch (pure decision, applied by the view) ---

export type TimelineClick =
    | { kind: "select-child"; childRunId: string }
    | { kind: "open-dag"; taskId: string }
    | { kind: "focus-phase"; phaseIdx: number }
    | { kind: "approve-gate"; phaseIdx: number }
    | { kind: "sendback-gate"; phaseIdx: number }
    | { kind: "open-diff" }
    | { kind: "none" };

export function clickTargetFor(event: RunEvent): TimelineClick {
    const detail = detailOf<{ childrunid?: string; taskid?: string }>(event);
    switch (event.kind) {
        case "child-done":
        case "child-cancelled":
            return detail?.childrunid ? { kind: "select-child", childRunId: detail.childrunid } : { kind: "none" };
        case "task-stalled":
        case "dag-blocked":
            return { kind: "open-dag", taskId: detail?.taskid ?? "" };
        case "phase-started":
        case "phase-complete":
            return event.phaseidx != null ? { kind: "focus-phase", phaseIdx: event.phaseidx } : { kind: "none" };
        case "phase-held":
            return event.phaseidx != null ? { kind: "approve-gate", phaseIdx: event.phaseidx } : { kind: "none" };
        case "gate-approved":
        case "gate-sent-back":
            return event.phaseidx != null ? { kind: "focus-phase", phaseIdx: event.phaseidx } : { kind: "none" };
        case "evidence-sealed":
            return { kind: "open-diff" };
        default:
            return { kind: "none" };
    }
}

// joinWorkspacePath joins the run's project path with a workspace-relative artifact path the worker
// reported (the completion surface's open verb does the same join — the rule the routes through
// os.path at the backend too).
export function joinWorkspacePath(projectPath: string, rel: string): string {
    const sep = projectPath.includes("\\") ? "\\" : "/";
    return rel.match(/^([/\\]|[a-zA-Z]:)/) ? rel : `${projectPath}${sep}${rel}`;
}
