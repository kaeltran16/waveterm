// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";
import { selectedTaskIdAtom } from "./dagstore";
import {
    canDismissDagModal,
    closeDagModal,
    dagModalStateAtom,
    openDagLive,
    reduceDagModalState,
    type DagModalState,
} from "./dagmodalstate";

const request = { channelId: "channel-1", goal: "ship it", route: { runtime: "pi", tier: "fast" } } as any;
const draft = { title: "ship it", parallelism: 1, tasks: [] } as any;

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
        const decomposing = reduceDagModalState(null, { type: "open-draft", request });
        expect(decomposing).toEqual({ kind: "decomposing", request, error: "" });
        expect(reduceDagModalState(decomposing, { type: "close" })).toBeNull();
        expect(reduceDagModalState({ kind: "draft", request, draft, error: "" }, { type: "close" })).toBeNull();
        expect(reduceDagModalState(live(), { type: "close" })).toBeNull();
    });

    it("refuses to close while launching", () => {
        const launching = { kind: "launching", request, draft, error: "" } as DagModalState;
        expect(canDismissDagModal(launching)).toBe(false);
        expect(reduceDagModalState(launching, { type: "close" })).toBe(launching);
        expect(canDismissDagModal(live())).toBe(true);
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
