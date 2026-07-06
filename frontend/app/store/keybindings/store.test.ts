// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import { buildAgentBindings, buildGlobalBindings } from "./bindings";
import { bindingsAtom, registerBindings, unregisterBindings } from "./store";
import type { Binding, KeyContext, SurfaceKey } from "./types";

function b(id: string, keys = "j"): Binding {
    return { id, keys, group: "g", label: id, run: () => {} };
}

// A representative sample of contexts the dispatcher can be in.
const SURFACES: SurfaceKey[] = [
    "cockpit",
    "agent",
    "activity",
    "channels",
    "sessions",
    "files",
    "memory",
    "usage",
    "settings",
];
function contexts(): KeyContext[] {
    const out: KeyContext[] = [];
    for (const surface of SURFACES) {
        for (const editable of [false, true]) {
            for (const modalOpen of [false, true]) {
                out.push({ surface, editable, modalOpen, leader: null });
            }
        }
    }
    return out;
}

function assertNoConflicts(bindings: Binding[]) {
    for (const ctx of contexts()) {
        const active = bindings.filter((b) => (b.when ? b.when(ctx) : true));
        const seen = new Map<string, string>();
        for (const b of active) {
            const prev = seen.get(b.keys);
            if (prev != null) {
                throw new Error(
                    `key conflict "${b.keys}" between "${prev}" and "${b.id}" in surface=${ctx.surface} editable=${ctx.editable} modalOpen=${ctx.modalOpen}`
                );
            }
            seen.set(b.keys, b.id);
        }
    }
}

describe("keybindings store", () => {
    it("registers and unregisters bindings by identity", () => {
        const arr = [b("a"), b("b")];
        registerBindings(arr);
        expect(globalStore.get(bindingsAtom)).toEqual(expect.arrayContaining(arr));
        unregisterBindings(arr);
        for (const binding of arr) {
            expect(globalStore.get(bindingsAtom)).not.toContain(binding);
        }
    });

    it("keeps other registrations intact when one unregisters", () => {
        const g1 = [b("g1")];
        const g2 = [b("g2")];
        registerBindings(g1);
        registerBindings(g2);
        unregisterBindings(g1);
        const now = globalStore.get(bindingsAtom);
        expect(now).toContain(g2[0]);
        expect(now).not.toContain(g1[0]);
        unregisterBindings(g2);
    });
});

describe("keybinding conflict invariant", () => {
    it("has no two active-in-same-context bindings sharing keys", () => {
        // A stub model is enough: bindings only read atoms at run(), not at build().
        const model = { surfaceAtom: {}, paletteOpenAtom: {}, newAgentOpenAtom: {} } as any;
        expect(() => assertNoConflicts(buildGlobalBindings(model))).not.toThrow();
    });

    it("global + agent-surface bindings do not conflict", () => {
        const model = {} as any; // build() reads no atoms; run()/when() do, and are not called here
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildAgentBindings(model)])).not.toThrow();
    });

    it("registers agent:return-nav on Shift:Escape, active only in the terminal", () => {
        const model = {} as any;
        const b = buildAgentBindings(model).find((x) => x.id === "agent:return-nav");
        expect(b?.keys).toBe("Shift:Escape");
        // fires only while the TUI owns focus (editable) on the agent surface
        expect(b?.when?.({ surface: "agent", editable: true, modalOpen: false, leader: null })).toBe(true);
        expect(b?.when?.({ surface: "agent", editable: false, modalOpen: false, leader: null })).toBe(false);
    });
});
