// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The dag's record sealed with the lead's run, as the run sidebar lists it below the report: each task's line,
// its non-empty sections under it, then the run-wide counts, what the human told workers, and the worktrees left
// behind. `wsh runs show` prints the same record (runsRecordLines).

export type RecordRow =
    | { kind: "task"; text: string }
    | { kind: "section"; label: string; text: string }
    | { kind: "run"; label?: string; text: string };

export function runRecordRows(dag: EvidenceDag | undefined): RecordRow[] {
    if (dag == null) {
        return [];
    }
    const rows: RecordRow[] = [];
    for (const t of dag.tasks ?? []) {
        rows.push({ kind: "task", text: taskLine(t) });
        const sections: [string, string | undefined][] = [
            ["differs", t.differs],
            ["not verified", t.notverified],
            ["reviewer", t.reviewerunverified],
            ["found not fixed", t.foundnotfixed],
            ["for lead", t.forlead],
            ["unstructured", t.unstructured],
        ];
        for (const [label, body] of sections) {
            const text = (body ?? "").trim();
            if (text !== "") {
                rows.push({ kind: "section", label, text });
            }
        }
    }
    rows.push({ kind: "run", text: `answered ${dag.answered}  forwarded ${dag.forwarded}` });
    for (const told of dag.told ?? []) {
        rows.push({ kind: "run", label: "told", text: told.trim() });
    }
    if ((dag.leftbehind ?? []).length > 0) {
        rows.push({ kind: "run", label: "left behind", text: dag.leftbehind.join(", ") });
    }
    return rows;
}

function taskLine(t: EvidenceDagTask): string {
    let line = `${t.taskid} ${t.state}`;
    if (t.commit) {
        line += `  ${t.commit.slice(0, 7)}`;
    }
    if ((t.reviewrounds ?? 0) > 0) {
        line += `  review rounds ${t.reviewrounds}`;
    }
    return line;
}
