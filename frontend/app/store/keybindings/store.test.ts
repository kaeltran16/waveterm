// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it } from "vitest";
import {
    buildAgentBindings,
    buildChannelsAskBindings,
    buildCockpitBindings,
    buildCodeBindings,
    buildFilesBindings,
    buildGlobalBindings,
    buildJarvisBindings,
    buildListNavBindings,
} from "./bindings";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { diffScopeAtom } from "@/app/view/agents/diffscopeatom";
import { historyFiltersAtom } from "@/app/view/agents/githistorystore";
import { NO_FILTERS } from "@/app/view/agents/historyquery";
import { graphPeekOpenAtom } from "@/app/view/jarvis/jarvisstore";
import { listNavAtom } from "./listnav";
import { bindingsAtom, registerBindings, unregisterBindings } from "./store";
import type { Binding, KeyContext, SurfaceKey } from "./types";

function b(id: string, keys = "j"): Binding {
    return { id, keys, group: "g", label: id, run: () => {} };
}

// A representative sample of contexts the dispatcher can be in.
const SURFACES: SurfaceKey[] = [
    "cockpit",
    "agent",
    "jarvis",
    "radar",
    "sessions",
    "files",
    "memory",
    "usage",
    "code",
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

    it("global + list-nav (controller active on a plain surface) has no key conflicts", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: [], cursorId: undefined, setCursor() {} });
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildListNavBindings()])).not.toThrow();
        globalStore.set(listNavAtom, null);
    });

    it("global + list-nav + agent bindings do not conflict (no controller)", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        expect(() =>
            assertNoConflicts([...buildGlobalBindings(model), ...buildListNavBindings(), ...buildAgentBindings(model)])
        ).not.toThrow();
    });

    it("Escape stays unambiguous on the Diff surface with filters active", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        globalStore.set(diffScopeAtom, null);
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildFilesBindings()])).not.toThrow();
        globalStore.set(historyFiltersAtom, NO_FILTERS);
    });

    // The Code surface holds the two bindings that deliberately survive `editable` (Ctrl+P find,
    // Ctrl+S save), so it is the surface most likely to collide with a global chord. It went
    // uncovered when the surface landed; this is the guard.
    it("global + code-surface bindings do not conflict, editable or not", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildCodeBindings()])).not.toThrow();
    });

    it("global + cockpit-grid documentation bindings do not conflict", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildCockpitBindings()])).not.toThrow();
    });

    it("global + channels ask bindings (with an active asking worker) do not conflict", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        const askRef = { current: { id: "w1", state: "asking" } as AgentVM };
        expect(() =>
            assertNoConflicts([...buildGlobalBindings(model), ...buildChannelsAskBindings(model, askRef)])
        ).not.toThrow();
    });

    it("global + list-nav + jarvis-surface bindings do not conflict (the Subjects cursor published)", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: [], cursorId: undefined, setCursor() {} });
        globalStore.set(graphPeekOpenAtom, false);
        expect(() =>
            assertNoConflicts([...buildGlobalBindings(model), ...buildListNavBindings(), ...buildJarvisBindings()])
        ).not.toThrow();
        globalStore.set(listNavAtom, null);
    });

    it("global + ask + jarvis-surface bindings do not conflict (a worker asking, no list cursor)", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        globalStore.set(graphPeekOpenAtom, false);
        const askRef = { current: { id: "w1", state: "asking" } as AgentVM };
        expect(() =>
            assertNoConflicts([
                ...buildGlobalBindings(model),
                ...buildChannelsAskBindings(model, askRef),
                ...buildJarvisBindings(),
            ])
        ).not.toThrow();
    });

    // KNOWN DEFECT, pinned rather than hidden: with the Subjects cursor published *and* a worker asking —
    // the ordinary state of the Jarvis surface — list:activate and channels:submit both claim Enter.
    // matchBinding returns the first match only and the dispatcher does not fall through on `run() === false`
    // (dispatcher.ts runBinding), so the ask's documented Enter never reaches submitAnswer. Predates the
    // Jarvis keys added here; fixing it means either dispatcher fall-through (a global semantic change) or a
    // precedence rule between the two. When it is fixed, this expectation flips to .not.toThrow.
    it("documents the Enter overlap between the list cursor and an ask (pre-existing)", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: [], cursorId: undefined, setCursor() {} });
        const askRef = { current: { id: "w1", state: "asking" } as AgentVM };
        expect(() =>
            assertNoConflicts([
                ...buildGlobalBindings(model),
                ...buildListNavBindings(),
                ...buildChannelsAskBindings(model, askRef),
            ])
        ).toThrow(/key conflict "Enter" between "list:activate" and "channels:submit"/);
        globalStore.set(listNavAtom, null);
    });

    it("hands Escape to the files surface while compare is on, without conflicting", () => {
        const model = {} as any;
        const filesCtx = { surface: "files" as const, editable: false, modalOpen: false, leader: null };
        const all = [...buildGlobalBindings(model), ...buildFilesBindings()];
        const backHome = all.find((b) => b.id === "surface:back-home")!;
        const exitCompare = all.find((b) => b.id === "files:exit-compare")!;

        // compare is on when the stored range says so, so this drives it the way the surface does
        globalStore.set(diffScopeAtom, null);
        expect(backHome.when!(filesCtx)).toBe(true);
        expect(exitCompare.when!(filesCtx)).toBe(false);

        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", from: { kind: "working" } },
        });
        // compare owns Escape: exactly one of the two is live, so the key never means two things
        expect(backHome.when!(filesCtx)).toBe(false);
        expect(exitCompare.when!(filesCtx)).toBe(true);
        expect(() => assertNoConflicts(all)).not.toThrow();
        globalStore.set(diffScopeAtom, null);
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
