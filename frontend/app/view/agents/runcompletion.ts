// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view derivations for the run-completion (evidence-snapshot) surface: formatting, verification
// tone/counts, file-stat + artifact-kind color classes, and the phase-history node model (elevating a
// freshctx phase to its own timeline node). No React, no jotai — unit-tested in runcompletion.test.ts.

export function runShortId(id: string): string {
    return (id ?? "").replace(/-/g, "").slice(0, 6);
}

export function fmtDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m === 0) {
        return `${rem}s`;
    }
    return `${m}m ${String(rem).padStart(2, "0")}s`;
}

export function fmtBytes(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${Math.round(n / 1024)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtClock(tsMs: number): string {
    if (!tsMs) {
        return "—";
    }
    const d = new Date(tsMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type VerifTone = { icon: string; labelClass: string; badgeClass: string; borderClass: string };

export function verifTone(result: string): VerifTone {
    switch (result) {
        case "pass":
            return { icon: "✓", labelClass: "text-success", badgeClass: "bg-success/15 text-success", borderClass: "border-success/25" };
        case "fail":
            return { icon: "✕", labelClass: "text-error", badgeClass: "bg-error/15 text-error", borderClass: "border-error/30" };
        default:
            return { icon: "?", labelClass: "text-warning", badgeClass: "bg-warning/15 text-warning", borderClass: "border-edge-mid" };
    }
}

export function verifCounts(v: EvidenceVerif[]): { pass: number; fail: number; unknown: number } {
    const counts = { pass: 0, fail: 0, unknown: 0 };
    for (const item of v ?? []) {
        if (item.result === "pass") counts.pass++;
        else if (item.result === "fail") counts.fail++;
        else counts.unknown++;
    }
    return counts;
}

export function statColor(stat: string): string {
    return stat === "A" ? "text-success" : stat === "D" ? "text-error" : "text-warning";
}

export function artifactKindClass(kind: string): string {
    switch (kind) {
        case "doc":
            return "text-accent bg-accentbg";
        case "report":
            return "text-success bg-success/15";
        case "image":
            return "text-accent-soft bg-accentbg";
        default:
            return "text-ink-mid bg-surface-hover";
    }
}

const PHASE_LABEL: Record<string, string> = {
    brainstorm: "Brainstorm",
    plan: "Plan",
    execute: "Execute",
    orchestrate: "Orchestrate",
    custom: "Custom",
};

export type PhaseNodeVM = {
    name: string;
    tag: string;
    detail: string;
    artifacts: string[];
    timeLabel: string;
    isBoundary: boolean;
    isGate: boolean;
    notLast: boolean;
};

// Phase-history node model. A gate phase carries a "gate" tag; a freshctx phase carries a "fresh ctx"
// tag and is flagged isBoundary (rendered with a squared node per the design). Detail prefers the skill.
export function phaseHistory(run: Run): PhaseNodeVM[] {
    const phases = (run.phases ?? []).filter((p) => p.state !== "skipped");
    return phases.map((p, i) => {
        const isGate = !!p.gate;
        const isBoundary = !!p.freshctx;
        return {
            name: PHASE_LABEL[p.kind] ?? p.kind,
            tag: isGate ? "gate" : isBoundary ? "fresh ctx" : "",
            detail: p.skill || p.kind,
            artifacts: p.artifacts ?? [],
            timeLabel: fmtClock(p.donets ?? p.startedts ?? 0),
            isBoundary,
            isGate,
            notLast: i < phases.length - 1,
        };
    });
}

export function needsEvidenceSeal(run: Run): boolean {
    return run?.status === "done" && !run?.evidence;
}
