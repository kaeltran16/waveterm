// frontend/app/view/agents/diffsource.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: which worktree the Diff surface is pointed at, and when the focused agent is allowed to move
// it. This is the run-beats-project-beats-agent precedence, which used to live inside two effects in
// the surface where it could only be read by tracing early returns. Stated here as three questions
// with answers, so it can be tested without mounting anything.

import { normalizeRepoPath, repoBasename } from "@/util/paths";
import { defaultRangeFor, type DiffOrigin, type DiffScope } from "./diffscope";

// The picker's two kinds of source. A run is neither, which is why it is absent here.
export type FilesSource = { kind: "agent"; id: string } | { kind: "project"; name: string };

// the picker needs no more of an agent than this
export interface SourceAgent {
    id: string;
    name: string;
}

// What the source picker should call current. Null means nothing claims to be the source, which is
// the picker's cue to fall back to the scope's own label — the only way a run's diff is labelled as
// a run rather than as whichever agent happens to be focused behind it.
export function sourceFor(scope: DiffScope | null, focusId: string | undefined): FilesSource | null {
    const origin = scope?.repo.origin;
    if (origin?.kind === "project") {
        return { kind: "project", name: origin.name };
    }
    if (origin?.kind === "agent") {
        return { kind: "agent", id: origin.id };
    }
    if (origin?.kind === "run") {
        return null;
    }
    return focusId ? { kind: "agent", id: focusId } : null;
}

// The agent the surface should re-scope to when focus moves, or null to stay put. Focus only moves a
// surface that is already showing an agent (or showing nothing yet): pinning a project or arriving
// from a run outranks it, which is the whole precedence in one guard.
export function focusFollowAgent(
    scope: DiffScope | null,
    focusId: string | undefined,
    agents: SourceAgent[]
): SourceAgent | null {
    const origin = scope?.repo.origin;
    if (origin != null && origin.kind !== "agent") {
        return null;
    }
    if (!focusId) {
        return null;
    }
    if (origin?.kind === "agent" && origin.id === focusId) {
        return null; // already showing it
    }
    // an ended agent's scope stays until a source is picked: when it leaves, the Agent surface moves focus to
    // the first agent, and following that would replace the ended state before anyone could read it
    if (origin?.kind === "agent" && !agents.some((a) => a.id === origin.id)) {
        return null;
    }
    return agents.find((a) => a.id === focusId) ?? null;
}

// Opening the surface with nothing scoped and nothing focused would show a dead "select a source"
// screen, so the first agent is adopted instead.
export function defaultFocusId(
    scope: DiffScope | null,
    focusId: string | undefined,
    agents: SourceAgent[]
): string | null {
    return scope == null && !focusId && agents.length > 0 ? agents[0].id : null;
}

export function filterSources<A extends { name: string }, P extends { name: string }>(
    query: string,
    agents: A[],
    projects: P[]
): { agents: A[]; projects: P[] } {
    const q = query.trim().toLowerCase();
    if (!q) {
        return { agents, projects };
    }
    const hit = (n: { name: string }) => n.name.toLowerCase().includes(q);
    return { agents: agents.filter(hit), projects: projects.filter(hit) };
}

// A registered project inside another registered project is a worktree of it (the repo's
// .worktrees/ convention); the picker names the parent so two "waveterm"s are told apart. The
// longest containing path wins, and "/" is required after it so waveterm2 is not waveterm's child.
export function worktreeParent<P extends { name: string; path: string }>(project: P, projects: P[]): string | null {
    const own = normalizeRepoPath(project.path);
    let best: P | null = null;
    for (const p of projects) {
        const other = normalizeRepoPath(p.path);
        if (p === project || !other || !own.startsWith(other + "/")) {
            continue;
        }
        if (best == null || other.length > normalizeRepoPath(best.path).length) {
            best = p;
        }
    }
    return best?.name ?? null;
}

// What the surface's body draws for its subject. `ended` is an agent scope whose agent has left the
// roster: its folder is still worth reviewing, so it is told apart from having nothing to show.
export type SubjectState = "empty" | "pick" | "ended" | "ready";

export function subjectState(
    scope: DiffScope | null,
    agents: SourceAgent[],
    projects: { name: string }[]
): SubjectState {
    if (scope == null) {
        return agents.length > 0 || projects.length > 0 ? "pick" : "empty";
    }
    const origin = scope.repo.origin;
    if (origin.kind === "agent" && !agents.some((a) => a.id === origin.id)) {
        return "ended";
    }
    return "ready";
}

// Where an ended agent's changes can still be read: the registered project at its folder, else the
// folder itself as an unregistered project. Built here rather than through agentdiffnav so this file
// stays free of stores.
export function endedAgentScope(cwd: string | undefined, projects: { name: string; path: string }[]): DiffScope | null {
    if (!cwd) {
        return null;
    }
    const own = normalizeRepoPath(cwd);
    const registered = projects.find((p) => normalizeRepoPath(p.path) === own);
    const name = registered?.name ?? repoBasename(cwd);
    const origin: DiffOrigin = { kind: "project", name, path: registered?.path ?? cwd };
    return { repo: { origin, label: name }, range: defaultRangeFor(origin) };
}

// The picker's rows in the order it draws them, which is the order the arrow keys walk.
export function pickerRows(agents: { id: string }[], projects: { name: string }[]): FilesSource[] {
    return [
        ...agents.map((a): FilesSource => ({ kind: "agent", id: a.id })),
        ...projects.map((p): FilesSource => ({ kind: "project", name: p.name })),
    ];
}

// clamped, not wrapped: holding an arrow key stops at the end of the list
export function moveHighlight(count: number, cur: number, dir: 1 | -1): number {
    return Math.max(0, Math.min(count - 1, cur + dir));
}
