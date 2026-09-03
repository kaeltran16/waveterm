// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { globalStore } from "@/app/store/jotaiStore";
import { selectedTaskIdAtom } from "./dagstore";
import {
    closeDagModal,
    dagModalAgentsContextAtom,
    dagModalStateAtom,
    openDagLive,
    reduceDagModalState,
    setDagModalAgentsContext,
    type DagModalState,
} from "./dagmodalstate";

function live(): DagModalState {
    return { kind: "live", channelId: "channel-1", runId: "run-1", dagOref: "dag:1", error: "" };
}

describe("reduceDagModalState", () => {
    it("opens a persisted live DAG", () => {
        expect(
            reduceDagModalState(null, {
                type: "open-live",
                channelId: "channel-1",
                runId: "run-1",
                dagOref: "dag:1",
            })
        ).toEqual(live());
    });

    it("closes on escape", () => {
        expect(reduceDagModalState(live(), { type: "escape" })).toBeNull();
    });

    it("does not reopen the removed local draft flow", () => {
        const removedAction = {
            type: "open-draft",
            requestId: 1,
            request: { channelId: "channel-1", goal: "ship", route: { runtime: "pi", model: "m" } },
        } as never;
        expect(reduceDagModalState(null, removedAction)).toBeNull();
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

    it("carries the agents context for worker navigation without touching selection", () => {
        setDagModalAgentsContext(
            { nowAtom: "now" } as never,
            [{ id: "w1", name: "w1", task: "", state: "working" }]
        );
        const ctx = globalStore.get(dagModalAgentsContextAtom);
        expect(ctx?.agents).toHaveLength(1);
        expect(ctx?.agents[0]).toMatchObject({ id: "w1" });
        // selection source stays selectedTaskIdAtom — the context never writes it
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
    });
});
