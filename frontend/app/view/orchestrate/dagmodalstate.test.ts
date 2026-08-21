// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";
import { selectedTaskIdAtom } from "./dagstore";
import {
    allocateDagPlanRequestId,
    canDismissDagModal,
    closeDagModal,
    dagModalStateAtom,
    openDagLive,
    reduceDagModalState,
    requiresRetryConfirmation,
    type DagDraftState,
    type DagModalState,
} from "./dagmodalstate";

const request = { channelId: "channel-1", goal: "ship it", route: { runtime: "pi", tier: "fast" } } as any;
const draft = {
    title: "ship it",
    parallelism: 1,
    tasks: [{ id: "t-1", label: "ship it", description: "", deps: [], gate: false, route: null }],
} as any;

function live(): DagModalState {
    return { kind: "live", channelId: "channel-1", runId: "run-1", dagOref: "dag:dag-1", error: "" };
}

describe("reduceDagModalState", () => {
    it("opens live state with the complete run identity", () => {
        expect(
            reduceDagModalState(null, {
                type: "open-live",
                channelId: "channel-1",
                runId: "run-1",
                dagOref: "dag:dag-1",
            })
        ).toEqual(live());
    });

    it("opens the decomposing seed and closes every dismissible state", () => {
        const decomposing = reduceDagModalState(null, { type: "open-draft", requestId: 11, request });
        expect(decomposing).toEqual({ kind: "decomposing", requestId: 11, request, error: "" });
        expect(reduceDagModalState(decomposing, { type: "close" })).toBeNull();
        expect(
            reduceDagModalState(
                { kind: "draft", request, draft, fallback: false, warnings: [], view: "summary", selectedTaskId: null, dirty: false, error: "" },
                { type: "close" },
            ),
        ).toBeNull();
        expect(reduceDagModalState(live(), { type: "close" })).toBeNull();
    });

    it("refuses to close while launching", () => {
        const launching = { kind: "launching", request, draft, error: "" } as DagModalState;
        expect(canDismissDagModal(launching)).toBe(false);
        expect(reduceDagModalState(launching, { type: "close" })).toBe(launching);
        expect(canDismissDagModal(live())).toBe(true);
    });
});

describe("draft transitions", () => {
    const draftState: DagDraftState = {
        kind: "draft",
        request,
        draft,
        fallback: false,
        warnings: [],
        view: "summary",
        selectedTaskId: null,
        dirty: false,
        error: "",
    };

    it("creates a clean draft, tracks view/drawer edits, and restores on launch failure", () => {
        const decomposing = { kind: "decomposing", requestId: 1, request, error: "" } as DagModalState;
        const reviewed = reduceDagModalState(decomposing, {
            type: "plan-succeeded",
            requestId: 1,
            draft,
            fallback: true,
            warnings: ["fallback"],
        });
        expect(reviewed).toEqual({ ...draftState, fallback: true, warnings: ["fallback"] });
        const selected = reduceDagModalState(reviewed, { type: "select-task", taskId: "t-1" });
        expect(selected).toEqual({ ...draftState, fallback: true, warnings: ["fallback"], selectedTaskId: "t-1" });
        const graph = reduceDagModalState(selected, { type: "set-view", view: "graph" });
        expect(graph).toEqual({ ...selected, view: "graph" });
        expect(reduceDagModalState(graph, { type: "escape" })).toEqual({ ...graph, selectedTaskId: null });
        const changedDraft = { ...draft, title: "changed" };
        const changed = reduceDagModalState(draftState, { type: "apply-draft", draft: changedDraft });
        expect(changed).toEqual({ ...draftState, draft: changedDraft, dirty: true });
        expect(reduceDagModalState(draftState, { type: "apply-draft", draft })).toBe(draftState);
        const launching = reduceDagModalState(changed, { type: "begin-launch" });
        expect(launching).toEqual({ ...changed, kind: "launching" });
        expect(reduceDagModalState(launching, { type: "launch-failed", error: "submit failed" })).toEqual({
            ...changed,
            error: "submit failed",
        });
        expect(
            reduceDagModalState(launching, { type: "launch-succeeded", channelId: "channel-1", runId: "run-1", dagOref: "dag:1" }),
        ).toEqual({ kind: "live", channelId: "channel-1", runId: "run-1", dagOref: "dag:1", error: "" });
    });

    it("ignores stale planner completions and requires retry confirmation only for dirty fallbacks", () => {
        const newer = { kind: "decomposing", requestId: 2, request, error: "" } as DagModalState;
        expect(
            reduceDagModalState(newer, { type: "plan-succeeded", requestId: 1, draft, fallback: false, warnings: [] }),
        ).toBe(newer);
        expect(reduceDagModalState(newer, { type: "plan-failed", requestId: 1, error: "old" })).toBe(newer);
        const cleanFallback = { ...draftState, fallback: true };
        expect(requiresRetryConfirmation(cleanFallback)).toBe(false);
        expect(requiresRetryConfirmation({ ...cleanFallback, dirty: true })).toBe(true);
        expect(requiresRetryConfirmation({ ...cleanFallback, fallback: false, dirty: true })).toBe(false);
        const retried = reduceDagModalState({ ...cleanFallback, dirty: true }, { type: "retry-plan", requestId: 3 });
        expect(retried).toEqual({ kind: "decomposing", requestId: 3, request, error: "" });
        expect(allocateDagPlanRequestId()).toBeGreaterThan(0);
    });

    it("closes the drawer before the modal and ignores escape while launching", () => {
        const selected = { ...draftState, selectedTaskId: "t-1" };
        expect(reduceDagModalState(selected, { type: "escape" })).toEqual({ ...draftState, selectedTaskId: null });
        expect(reduceDagModalState(draftState, { type: "escape" })).toBeNull();
        const launching = { ...draftState, kind: "launching" } as DagModalState;
        expect(reduceDagModalState(launching, { type: "escape" })).toBe(launching);
        expect(reduceDagModalState(launching, { type: "close" })).toBe(launching);
    });
});

describe("dag modal atom actions", () => {
    it("resets selected task on open and close", () => {
        globalStore.set(selectedTaskIdAtom, "t-1");
        openDagLive("channel-1", "run-1", "dag:dag-1");
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
        globalStore.set(selectedTaskIdAtom, "t-2");
        closeDagModal();
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
        expect(globalStore.get(dagModalStateAtom)).toBeNull();
    });
});
