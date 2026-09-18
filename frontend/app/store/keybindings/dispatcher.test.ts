// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel, SurfaceKey } from "@/app/view/agents/agents";
import { dagModalStateAtom } from "@/app/view/orchestrate/dagmodalstate";
import { atom } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveKeyContext, initKeybindingDispatcher, isEditableTarget } from "./dispatcher";

// Element stubs rather than jsdom: the suite runs in vitest's node environment, and the three fields
// this predicate reads are the whole contract.
function el(tagName: string, opts?: { contentEditable?: boolean; inMonaco?: boolean }): Element {
    return {
        tagName,
        isContentEditable: opts?.contentEditable ?? false,
        closest: (sel: string) => (opts?.inMonaco && sel === ".monaco-editor" ? ({} as Element) : null),
    } as unknown as Element;
}

describe("isEditableTarget", () => {
    it("reports the form elements and contenteditable hosts", () => {
        expect(isEditableTarget(el("INPUT"))).toBe(true);
        expect(isEditableTarget(el("TEXTAREA"))).toBe(true);
        expect(isEditableTarget(el("SELECT"))).toBe(true);
        expect(isEditableTarget(el("DIV", { contentEditable: true }))).toBe(true);
    });

    it("reports nothing else, including no focus at all", () => {
        expect(isEditableTarget(null)).toBe(false);
        expect(isEditableTarget(el("DIV"))).toBe(false);
        expect(isEditableTarget(el("BUTTON"))).toBe(false);
    });

    // The regression: Monaco 0.52+ focuses a plain <div class="native-edit-context"> (EditContext API),
    // so the tag test alone said "not editable" while the caret was in the Code editor — and bare `r`
    // refreshed the file index out of the middle of a word.
    it("reports Monaco's EditContext host as editable", () => {
        expect(isEditableTarget(el("DIV", { inMonaco: true }))).toBe(true);
    });
});

describe("deriveKeyContext", () => {
    afterEach(() => {
        globalStore.set(dagModalStateAtom, null);
        vi.unstubAllGlobals();
    });

    function bindModel(surface: SurfaceKey): () => void {
        vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
        vi.stubGlobal("document", { activeElement: null });
        const model = {
            surfaceAtom: atom<SurfaceKey>(surface),
            paletteOpenAtom: atom(false),
            newAgentOpenAtom: atom(false),
            newProjectOpenAtom: atom(false),
            memNewOpenAtom: atom(false),
        } as unknown as AgentsViewModel;
        return initKeybindingDispatcher(model);
    }

    function openDag(): void {
        globalStore.set(dagModalStateAtom, {
            kind: "live",
            channelId: "ch-1",
            runId: "run-1",
            dagOref: "dag:run-1",
            error: "",
        });
    }

    // the Brief's own bindings (Enter submitting an ask, digits, n/r/e/i) took the graph's keys first
    it("counts the DAG modal as a modal on the surface that shows it", () => {
        const unbind = bindModel("jarvis");
        expect(deriveKeyContext().modalOpen).toBe(false);
        openDag();
        expect(deriveKeyContext().modalOpen).toBe(true);
        unbind();
    });

    // opening a worker from the graph leaves the modal's state set while the Agent surface is up
    it("does not count it on another surface, where it is not mounted", () => {
        const unbind = bindModel("agent");
        openDag();
        expect(deriveKeyContext().modalOpen).toBe(false);
        unbind();
    });
});
