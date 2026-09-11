// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// whenVersionAtom is what lets a reactive consumer that cannot enumerate every atom a when(ctx)
// predicate reads (the hints footer) still know to recompute. The case that matters is not "does the
// atom exist" but "does it actually bump for every way the underlying state can change" — including a
// write that never goes through comparestore.ts's own enterCompare/leaveCompare (e.g. filessurface.tsx
// flipping diffScopeAtom directly when the picker jumps to a different agent).

import { globalStore } from "@/app/store/jotaiStore";
import { diffScopeAtom } from "@/app/view/agents/diffscopeatom";
import { historyFiltersAtom } from "@/app/view/agents/githistorystore";
import { NO_FILTERS } from "@/app/view/agents/historyquery";
import { renamingRowAtom } from "@/app/view/agents/rowrenameatom";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
import { codeFinderOpenAtom, codeTreeFocusedAtom } from "@/app/view/code/codestore";
import { autonomyPanelOpenAtom } from "@/app/view/jarvis/autonomyladder";
import { graphPeekOpenAtom } from "@/app/view/jarvis/jarvisstore";
import { petPeekOpenAtom } from "@/app/view/jarvis/petstore";
import { afterEach, describe, expect, it } from "vitest";
import { listNavAtom } from "./listnav";
import { whenVersionAtom } from "./whenstate";

afterEach(() => {
    globalStore.set(diffScopeAtom, null);
    globalStore.set(historyFiltersAtom, NO_FILTERS);
    globalStore.set(graphPeekOpenAtom, false);
    globalStore.set(autonomyPanelOpenAtom, false);
    globalStore.set(petPeekOpenAtom, false);
    globalStore.set(codeFinderOpenAtom, false);
    globalStore.set(codeTreeFocusedAtom, false);
    globalStore.set(listNavAtom, null);
    globalStore.set(renamingRowAtom, null);
    globalStore.set(focusSubagentAtom, null);
});

describe("whenVersionAtom", () => {
    it("bumps when compareOnAtom flips on, however diffScopeAtom got there", () => {
        const before = globalStore.get(whenVersionAtom);
        // Not enterCompare() — this is the direct write filessurface.tsx's pickAgent/pickProject make,
        // which any per-call-site bump would miss.
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
        });
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when compareOnAtom flips off", () => {
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", form: "mergebase", from: { kind: "working" } },
        });
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "working" },
        });
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when historyFiltersAtom changes", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when filters are cleared back to NO_FILTERS", () => {
        globalStore.set(historyFiltersAtom, { author: "dana", path: "", text: "" });
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(historyFiltersAtom, NO_FILTERS);
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    // One case per atom PREDICATE_ATOMS added beyond the Diff surface's two — surface:back-home's
    // guard (bindings.ts) reads graphPeekOpenAtom, autonomyPanelOpenAtom, petPeekOpenAtom and
    // codeFinderOpenAtom directly; buildCodeBindings' inTree reads codeTreeFocusedAtom;
    // buildListNavBindings' active reads listNavAtom; buildAgentBindings' subagent:back/agent:back
    // read renamingRowAtom and focusSubagentAtom.
    it("bumps when the Jarvis graph peek opens", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(graphPeekOpenAtom, true);
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when the autonomy panel opens", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(autonomyPanelOpenAtom, true);
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when the pet peek opens", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(petPeekOpenAtom, true);
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when the Code file finder opens", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(codeFinderOpenAtom, true);
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when the Code tree gains focus", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(codeTreeFocusedAtom, true);
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when a surface publishes a list-nav controller", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(listNavAtom, { surface: "files", navigableIds: [], cursorId: undefined, setCursor() {} });
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when a tree row starts renaming", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(renamingRowAtom, "row-1");
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when a subagent interior opens", () => {
        const before = globalStore.get(whenVersionAtom);
        globalStore.set(focusSubagentAtom, {
            parentId: "p1",
            agentId: "a1",
            transcriptPath: "/tmp/t.jsonl",
            label: "child",
        });
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });
});
