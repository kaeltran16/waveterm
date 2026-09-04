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
import { afterEach, describe, expect, it } from "vitest";
import { whenVersionAtom } from "./whenstate";

afterEach(() => {
    globalStore.set(diffScopeAtom, null);
    globalStore.set(historyFiltersAtom, NO_FILTERS);
});

describe("whenVersionAtom", () => {
    it("bumps when compareOnAtom flips on, however diffScopeAtom got there", () => {
        const before = globalStore.get(whenVersionAtom);
        // Not enterCompare() — this is the direct write filessurface.tsx's pickAgent/pickProject make,
        // which any per-call-site bump would miss.
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", from: { kind: "working" } },
        });
        expect(globalStore.get(whenVersionAtom)).toBeGreaterThan(before);
    });

    it("bumps when compareOnAtom flips off", () => {
        globalStore.set(diffScopeAtom, {
            repo: { origin: { kind: "agent", id: "a1" }, label: "a1" },
            range: { kind: "compare", base: "main", head: "feat", from: { kind: "working" } },
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
});
