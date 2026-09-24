// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure scope model for the universal search. Scopes are visible chips rather than sigils you had to
// know: Tab walks them, and the old sigils still work by turning into the chip when typed into an
// empty All query. The transitions live here so the component only renders them.

import type { SurfaceKey } from "@/app/store/keybindings/types";
import { fuzzyScore } from "./palette-match";

export type ScopeId = "all" | "goto" | "agents" | "runs" | "sessions" | "records" | "projects" | "files" | "commands";

// a command row that opens a sub-list instead of acting
export type DrillId = "theme" | "focus";

export interface ScopeDef {
    id: ScopeId;
    label: string;
    sigil?: string;
    noun: string; // "No <noun> match …"
    placeholder: string;
}

export const SCOPES: ScopeDef[] = [
    { id: "all", label: "All", noun: "results", placeholder: "Search, or type a goal…" },
    { id: "goto", label: "Go to", noun: "surfaces", placeholder: "Go to a surface…" },
    { id: "agents", label: "Agents", sigil: "@", noun: "agents", placeholder: "Find an agent…" },
    { id: "runs", label: "Runs", noun: "runs", placeholder: "Find a run…" },
    { id: "sessions", label: "Sessions", sigil: "/", noun: "sessions", placeholder: "Find a session to resume…" },
    { id: "records", label: "Records", noun: "records", placeholder: "Find a record or initiative…" },
    {
        id: "projects",
        label: "Projects",
        sigil: "#",
        noun: "projects",
        placeholder: "Switch project, or project goal…",
    },
    { id: "files", label: "Files", noun: "files", placeholder: "Open a file, path:line jumps…" },
    { id: "commands", label: "Commands", sigil: ">", noun: "commands", placeholder: "Run a command…" },
];

export const DRILL_LABELS: Record<DrillId, string> = { theme: "Theme", focus: "Focus on task" };
export const DRILL_PLACEHOLDERS: Record<DrillId, string> = { theme: "Pick a theme…", focus: "Pick a task…" };

export function scopeDef(id: ScopeId): ScopeDef {
    return SCOPES.find((s) => s.id === id)!;
}

// Code's Ctrl+P was a file finder; it folds in as the Files scope, preselected there
export function initialScope(surface: SurfaceKey): ScopeId {
    return surface === "code" ? "files" : "all";
}

export interface NavState {
    scope: ScopeId;
    query: string;
    drill: DrillId | null;
    asGoal: boolean; // All only: the "Start as a goal" row was chosen, so the launch rows lead
}

export function initialNav(surface: SurfaceKey): NavState {
    return { scope: initialScope(surface), query: "", drill: null, asGoal: false };
}

function sigilScope(ch: string): ScopeId | null {
    return SCOPES.find((s) => s.sigil === ch)?.id ?? null;
}

// A sigil typed into an empty All query becomes the chip instead of query text. Checked against the
// previous query rather than the new value's length, so a pasted "@juno" lands as Agents + "juno".
export function typeQuery(s: NavState, value: string): NavState {
    if (s.scope === "all" && s.drill == null && s.query === "") {
        const scope = sigilScope(value[0] ?? "");
        if (scope != null) {
            return { ...s, scope, query: value.slice(1), asGoal: false };
        }
    }
    return { ...s, query: value, asGoal: false };
}

export function cycleScope(s: NavState, dir: 1 | -1): NavState {
    const i = SCOPES.findIndex((d) => d.id === s.scope);
    const next = SCOPES[(i + dir + SCOPES.length) % SCOPES.length].id;
    return { ...s, scope: next, drill: null, asGoal: false };
}

export function pickScope(s: NavState, scope: ScopeId): NavState {
    return { ...s, scope, drill: null, asGoal: false };
}

// Backspace on an empty query: leave a drill first, then drop the scope back to All. null means there
// is nothing to leave, so the key keeps its ordinary meaning.
export function backspaceEmpty(s: NavState): NavState | null {
    if (s.query !== "") {
        return null;
    }
    if (s.drill != null) {
        return { ...s, drill: null };
    }
    if (s.scope !== "all") {
        return { ...s, scope: "all", asGoal: false };
    }
    return null;
}

export function openDrill(s: NavState, drill: DrillId): NavState {
    return { scope: "commands", query: "", drill, asGoal: false };
}

export interface ChannelLaunch {
    token: string; // project selector (first whitespace token)
    goal: string; // trimmed goal text after the token
}

// Projects scope: "backend fix the auth bug" starts a goal in #backend. A lone token, or a token with
// only trailing space, is still picking a project.
export function parseProjectLaunch(query: string): ChannelLaunch | null {
    const m = query.replace(/^\s+/, "").match(/^(\S+)\s+([\s\S]+)$/);
    if (m == null || m[2].trim() === "") {
        return null;
    }
    return { token: m[1], goal: m[2].trim() };
}

// Resolve a channel selector token to a channel: exact (case-insensitive) name first,
// else the best fuzzy match, else undefined.
export function resolveChannelToken<T extends { name: string }>(token: string, channels: T[]): T | undefined {
    const t = token.toLowerCase();
    const exact = channels.find((c) => c.name.toLowerCase() === t);
    if (exact) {
        return exact;
    }
    let best: T | undefined;
    let bestScore = -Infinity;
    for (const c of channels) {
        const s = fuzzyScore(token, c.name);
        if (s != null && s > bestScore) {
            bestScore = s;
            best = c;
        }
    }
    return best;
}
