// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { diffScopeAtom } from "@/app/view/agents/diffscopeatom";
import { historyFiltersAtom } from "@/app/view/agents/githistorystore";
import { NO_FILTERS } from "@/app/view/agents/historyquery";
import { renamingRowAtom } from "@/app/view/agents/rowrenameatom";
import { vaultFocusAtom, vaultReaderAtom, vaultTabAtom } from "@/app/view/agents/vaultstore";
import { codeTreeFocusedAtom } from "@/app/view/code/codestore";
import { autonomyPanelOpenAtom } from "@/app/view/jarvis/autonomyladder";
import { graphPeekOpenAtom } from "@/app/view/jarvis/jarvisstore";
import { petPeekOpenAtom } from "@/app/view/jarvis/petstore";
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
    buildVaultBindings,
} from "./bindings";
import { listNavAtom } from "./listnav";
import { bindingsAtom, registerBindings, unregisterBindings } from "./store";
import type { Binding, KeyContext, SurfaceKey } from "./types";
import { PREDICATE_ATOMS } from "./whenstate";

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
    "vault",
    "usage",
    "code",
    "settings",
];
function contexts(): KeyContext[] {
    const out: KeyContext[] = [];
    for (const surface of SURFACES) {
        for (const editable of [false, true]) {
            for (const modalOpen of [false, true]) {
                // leader: "g" is a real posture now — the alias chord (matcher.ts LEADER_ALIASES) opens
                // the tree from a focused text field, and the leader-aware `navigate` guard activates
                // bindings that are dormant at rest. Without this axis the invariant would pass
                // vacuously for every key the leader newly exposes.
                for (const leader of [null, "g"]) {
                    out.push({ surface, editable, modalOpen, leader });
                }
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
                    `key conflict "${b.keys}" between "${prev}" and "${b.id}" in surface=${ctx.surface} editable=${ctx.editable} modalOpen=${ctx.modalOpen} leader=${ctx.leader}`
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

    // The Code surface holds Ctrl+S save, which deliberately survives `editable`, so it is the
    // surface most likely to collide with a global chord. It went uncovered when the surface
    // landed; this is the guard — and it is what would catch the file finder re-claiming Ctrl+P
    // now that the global palette binding owns that key on every surface.
    it("global + code-surface bindings do not conflict, editable or not", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildCodeBindings()])).not.toThrow();
    });

    // The tree keys are bare letters and arrows, live only while the tree pane holds focus. With
    // focus false they are inert and prove nothing, so assert with focus TRUE — and with a list-nav
    // controller published for another surface, which is the state the shared j/k bindings need to
    // be inert in.
    it("global + list-nav + code tree keys (tree focused) do not conflict", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: [], cursorId: undefined, setCursor() {} });
        globalStore.set(codeTreeFocusedAtom, true);
        try {
            expect(() =>
                assertNoConflicts([...buildGlobalBindings(model), ...buildListNavBindings(), ...buildCodeBindings()])
            ).not.toThrow();
        } finally {
            globalStore.set(codeTreeFocusedAtom, false);
            globalStore.set(listNavAtom, null);
        }
    });

    // The Vault's triage keys are bare letters live only while the queue has the focus, so assert with
    // that posture ON — inert bindings prove nothing. A list-nav controller is published for another
    // surface at the same time, which is the state the shared j/k bindings have to stay inert in.
    it("global + list-nav + vault triage keys (queue focused) do not conflict", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, { surface: "jarvis", navigableIds: [], cursorId: undefined, setCursor() {} });
        globalStore.set(vaultTabAtom, "memory");
        globalStore.set(vaultFocusAtom, "queue");
        globalStore.set(vaultReaderAtom, null);
        try {
            expect(() =>
                assertNoConflicts([...buildGlobalBindings(model), ...buildListNavBindings(), ...buildVaultBindings()])
            ).not.toThrow();
        } finally {
            globalStore.set(listNavAtom, null);
        }
    });

    // Escape is claimed by surface:back-home on the Vault and by the reader while it is open. The two
    // must never be live together, which only shows up with the reader actually open.
    it("hands Escape to the Vault reader while it is open, without conflicting", () => {
        const model = {} as any;
        globalStore.set(listNavAtom, null);
        globalStore.set(vaultReaderAtom, { kind: "pending", path: "p" });
        try {
            expect(() => assertNoConflicts([...buildGlobalBindings(model), ...buildVaultBindings()])).not.toThrow();
        } finally {
            globalStore.set(vaultReaderAtom, null);
        }
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
            range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
        });
        // compare owns Escape: exactly one of the two is live, so the key never means two things
        expect(backHome.when!(filesCtx)).toBe(false);
        expect(exitCompare.when!(filesCtx)).toBe(true);
        expect(() => assertNoConflicts(all)).not.toThrow();
        globalStore.set(diffScopeAtom, null);
    });

    it("global + agent + jarvis + files bindings do not conflict in leader posture either", () => {
        const model = {} as any;
        expect(() =>
            assertNoConflicts([
                ...buildGlobalBindings(model),
                ...buildAgentBindings(model),
                ...buildJarvisBindings(),
                ...buildFilesBindings(),
            ])
        ).not.toThrow();
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

// Guards the hand-maintained list in whenstate.ts, which is what lets the hints footer stay reactive
// to state a when(ctx) predicate reads outside of ctx (see docs/open-issues.md, "Hints-footer
// staleness"). A predicate reading an atom this list doesn't have reproduces that staleness bug for
// whatever the predicate gates; a stale entry that no predicate reads any more makes the footer
// re-render on unrelated state for no reason. Both directions are checked mechanically here instead of
// trusted to whoever last edited bindings.ts.
describe("PREDICATE_ATOMS completeness (whenstate.ts)", () => {
    it("matches exactly the atoms a when() predicate can read — no more, no less", () => {
        const model = {} as any;
        const askRef = { current: { id: "w1", state: "asking" } as AgentVM };
        const all: Binding[] = [
            ...buildGlobalBindings(model),
            ...buildListNavBindings(),
            ...buildChannelsAskBindings(model, askRef),
            ...buildJarvisBindings(),
            ...buildCockpitBindings(),
            ...buildAgentBindings(model),
            ...buildFilesBindings(),
            ...buildCodeBindings(),
            ...buildVaultBindings(),
        ];

        // Neutral so no `&&` chain (e.g. surface:back-home's, subagent:back's) short-circuits before
        // reaching a later globalStore.get — a short-circuited read would falsely report a registered
        // atom as unused.
        globalStore.set(diffScopeAtom, null);
        globalStore.set(graphPeekOpenAtom, false);
        globalStore.set(autonomyPanelOpenAtom, false);
        globalStore.set(petPeekOpenAtom, false);
        globalStore.set(renamingRowAtom, null);

        const seen = new Set<unknown>();
        const realGet = globalStore.get;
        (globalStore as { get: typeof globalStore.get }).get = ((a: unknown) => {
            seen.add(a);
            return (realGet as (a: unknown) => unknown)(a);
        }) as typeof globalStore.get;
        try {
            for (const ctx of contexts()) {
                for (const binding of all) {
                    binding.when?.(ctx);
                }
            }
        } finally {
            (globalStore as { get: typeof globalStore.get }).get = realGet;
            globalStore.set(diffScopeAtom, null);
            globalStore.set(renamingRowAtom, null);
        }

        const registered = new Set<unknown>(PREDICATE_ATOMS);
        const missing = [...seen].filter((a) => !registered.has(a));
        const unused = PREDICATE_ATOMS.filter((a) => !seen.has(a));
        expect(missing).toEqual([]); // a when() predicate reads an atom whenstate.ts doesn't watch
        expect(unused).toEqual([]); // whenstate.ts watches an atom no when() predicate reads
    });
});
