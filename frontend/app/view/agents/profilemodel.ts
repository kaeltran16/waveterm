// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers for the Jarvis profile editor. The frontend edits only a PrinciplePatch (additions,
// per-global replacements, disables); it never materializes the resolved global list into the override.
// The merge rule itself lives only in Go (ResolvePrinciples) — the editor reads the resolved profile and
// diagnostics from the backend and never re-derives resolution here. principleRows() maps to presentation
// state (which badge / affordance each row shows), not effective policy.

// mirror the Go jarvis diagnostic codes so the editor can route a stale row's removal to the right action.
export const DIAGNOSTIC_MISSING_REPLACEMENT = "missing-replacement";
export const DIAGNOSTIC_MISSING_DISABLED = "missing-disabled";

export type SectionSource = "global" | "project";

// A section is "project" when the override carries it (non-null), else "global". Uses != null so an
// explicit empty override (empty principles patch / empty playbook array) still counts as project.
export function sectionSource(override: ProfileOverride | null | undefined): {
    playbook: SectionSource;
    principles: SectionSource;
} {
    return {
        playbook: override?.playbook != null ? "project" : "global",
        principles: override?.principles != null ? "project" : "global",
    };
}

export type PrinciplePatchAction =
    | { type: "override"; id: string; text: string }
    | { type: "reset"; id: string }
    | { type: "disable"; id: string }
    | { type: "reenable"; id: string }
    | { type: "add"; principle: Principle }
    | { type: "update-addition"; id: string; text: string }
    | { type: "delete-addition"; id: string };

// each action touches exactly one field (replacements / disabled / additions) and is fully immutable;
// the returned patch is cleaned so empty maps/slices are dropped and a fully-empty patch becomes undefined.
export function reducePrinciplePatch(
    patch: PrinciplePatch | undefined,
    action: PrinciplePatchAction
): PrinciplePatch | undefined {
    const additions = patch?.additions ? [...patch.additions] : [];
    const replacements = { ...(patch?.replacements ?? {}) };
    const disabled = patch?.disabled ? [...patch.disabled] : [];
    switch (action.type) {
        case "override":
            replacements[action.id] = action.text;
            break;
        case "reset":
            delete replacements[action.id];
            break;
        case "disable":
            if (!disabled.includes(action.id)) {
                disabled.push(action.id);
            }
            break;
        case "reenable": {
            const idx = disabled.indexOf(action.id);
            if (idx >= 0) {
                disabled.splice(idx, 1);
            }
            break;
        }
        case "add":
            additions.push(action.principle);
            break;
        case "update-addition":
            for (let i = 0; i < additions.length; i++) {
                if (additions[i].id === action.id) {
                    additions[i] = { ...additions[i], text: action.text };
                }
            }
            break;
        case "delete-addition": {
            const idx = additions.findIndex((a) => a.id === action.id);
            if (idx >= 0) {
                additions.splice(idx, 1);
            }
            break;
        }
    }
    return cleanPatch({ additions, replacements, disabled });
}

export type PrincipleRowKind = "inherited" | "modified" | "project" | "disabled" | "stale";

// presentation-only view of one editor row. Not a resolution result — a disabled global still appears
// (so the editor can list it under "Disabled · N"); stale rows exist only to be removed.
export type PrincipleRow = {
    id: string;
    text: string;
    kind: PrincipleRowKind;
    originalText?: string; // "modified" only — the inherited global text, for the comparison disclosure
    diagnostic?: string; // "stale" only — the diagnostic code, to route the remove action
};

export function principleRows(
    global: Principle[],
    patch: PrinciplePatch | undefined,
    diagnostics: PrincipleDiagnostic[]
): PrincipleRow[] {
    const replacements = patch?.replacements ?? {};
    const disabled = new Set(patch?.disabled ?? []);
    const globalIds = new Set(global.map((p) => p.id));
    const rows: PrincipleRow[] = [];
    for (const g of global) {
        if (disabled.has(g.id)) {
            rows.push({ id: g.id, text: g.text, kind: "disabled" });
        } else if (replacements[g.id] != null) {
            rows.push({ id: g.id, text: replacements[g.id], kind: "modified", originalText: g.text });
        } else {
            rows.push({ id: g.id, text: g.text, kind: "inherited" });
        }
    }
    for (const a of patch?.additions ?? []) {
        rows.push({ id: a.id, text: a.text, kind: "project" });
    }
    for (const d of diagnostics ?? []) {
        if (globalIds.has(d.principleid)) {
            continue; // still-valid global — not stale
        }
        rows.push({ id: d.principleid, text: replacements[d.principleid] ?? "", kind: "stale", diagnostic: d.code });
    }
    return rows;
}

// Compare normalized overrides so a structurally empty patch reads equal to no patch at all.
export function isDirty(a: ProfileOverride, b: ProfileOverride): boolean {
    return JSON.stringify(normalizeOverride(a)) !== JSON.stringify(normalizeOverride(b));
}

// True when the principle patch carries no additions, replacements, or disables.
export function principlePatchIsEmpty(patch: PrinciplePatch | null | undefined): boolean {
    return cleanPatch(patch) == null;
}

function cleanPatch(patch: PrinciplePatch | null | undefined): PrinciplePatch | undefined {
    if (patch == null) {
        return undefined;
    }
    const out: PrinciplePatch = {};
    if (patch.additions?.length) {
        out.additions = patch.additions;
    }
    if (patch.replacements && Object.keys(patch.replacements).length) {
        out.replacements = patch.replacements;
    }
    if (patch.disabled?.length) {
        out.disabled = patch.disabled;
    }
    return Object.keys(out).length ? out : undefined;
}

function normalizeOverride(o: ProfileOverride): ProfileOverride {
    const out: ProfileOverride = { ...o };
    const cleaned = cleanPatch(o.principles);
    if (cleaned == null) {
        delete out.principles;
    } else {
        out.principles = cleaned;
    }
    return out;
}

export type GlobalPrincipleAction =
    | { type: "add"; principle: Principle }
    | { type: "update"; id: string; text: string }
    | { type: "delete"; id: string }
    | { type: "move"; id: string; dir: -1 | 1 };

// Global-scope principles are a plain flat list (no override/disable/inherit — those only make sense
// against a global baseline). Pure; "add" appends a caller-built principle so the reducer stays deterministic.
export function reduceGlobalPrinciples(list: Principle[], action: GlobalPrincipleAction): Principle[] {
    switch (action.type) {
        case "add":
            return [...list, action.principle];
        case "update":
            return list.map((p) => (p.id === action.id ? { ...p, text: action.text } : p));
        case "delete":
            return list.filter((p) => p.id !== action.id);
        case "move": {
            const i = list.findIndex((p) => p.id === action.id);
            const j = i + action.dir;
            if (i < 0 || j < 0 || j >= list.length) {
                return list;
            }
            const next = [...list];
            [next[i], next[j]] = [next[j], next[i]];
            return next;
        }
    }
}

// Structural dirty check for the whole global profile (plain data; key order is stable across edits).
export function globalProfileIsDirty(a: JarvisProfile, b: JarvisProfile): boolean {
    return JSON.stringify(a) !== JSON.stringify(b);
}
