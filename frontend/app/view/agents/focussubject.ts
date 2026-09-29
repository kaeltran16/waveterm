// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one decision every "subject"-posture surface makes: adopt the focus, say nothing, or say it has
// diverged. Surfaces differ in what their target IS (a project name, a repo path, a diff origin), so
// each maps its own target to a comparable string and this decides from the pair. Pure — no jotai.

export type SubjectDecision =
    | { kind: "seed"; target: string }
    | { kind: "aligned" }
    | { kind: "diverged"; focus: string; local: string };

export function subjectDecision(local: string | null, focus: string | null): SubjectDecision {
    // no focus is Global, not a thing to rejoin: a surface with its own target is correct as it stands
    if (focus == null || focus === "") {
        return { kind: "aligned" };
    }
    if (local == null || local === "") {
        return { kind: "seed", target: focus };
    }
    return local === focus ? { kind: "aligned" } : { kind: "diverged", focus, local };
}

// "project" = the app-bar project scope, "focus" = the app-bar Focus. They are separate controls, so the
// banner must name the one it compared against or it claims a focus the Focus control says is unset.
export type DivergenceScope = "project" | "focus";

export function divergenceText(scope: DivergenceScope, focusLabel: string, localLabel: string): string {
    return scope === "project"
        ? `Showing ${localLabel} · project is ${focusLabel}`
        : `Showing ${localLabel} · focus is on ${focusLabel}`;
}
