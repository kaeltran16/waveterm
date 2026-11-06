// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { describe, expect, it } from "vitest";
import { isTopModal, registerModal } from "@/app/modals/modalstack";
import { globalStore } from "@/app/store/jotaiStore";
import type { SurfaceKey } from "../agents/agents";
import { forgetOrigin, landOn } from "../jarvis/returnsurface";
import { selectedTaskIdAtom } from "./dagstore";
import {
    closeDagModal,
    DAG_MODAL_ID,
    dagModalAgentsContextAtom,
    dagModalStateAtom,
    dismissDagModal,
    escapeDagModal,
    openDagLive,
    openDagTask,
    openRunSheetDag,
    reduceDagModalState,
    setDagModalAgentsContext,
    type DagModalState,
} from "./dagmodalstate";

function live(): DagModalState {
    return { kind: "live", dagOref: "dag:1", error: "" };
}

describe("reduceDagModalState", () => {
    it("opens a persisted live DAG", () => {
        expect(
            reduceDagModalState(null, {
                type: "open-live",
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
        openDagLive("dag:dag-1");
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
        globalStore.set(selectedTaskIdAtom, "t-2");
        closeDagModal();
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
        expect(globalStore.get(dagModalStateAtom)).toBeNull();
    });

    // The attention queue's "take me to it": landing on an unfocused graph the reader then has to
    // search through is not navigation.
    it("opens the live DAG with the queue's task already selected", () => {
        globalStore.set(selectedTaskIdAtom, "t-old");
        openDagTask("dag:dag-1", "t-7");
        expect(globalStore.get(dagModalStateAtom)).toMatchObject({ kind: "live", dagOref: "dag:dag-1" });
        expect(globalStore.get(selectedTaskIdAtom)).toBe("t-7");
        closeDagModal();
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

describe("dismissDagModal", () => {
    // leaving Jarvis shuts the modal where the user is; only closing it in place goes back
    it("closes without returning to the surface the jump came from", () => {
        const surfaceAtom = atom<SurfaceKey>("agent");
        forgetOrigin();
        landOn(surfaceAtom, "jarvis", "dag");
        openDagTask("dag:x", "t-1");
        dismissDagModal();
        expect(globalStore.get(dagModalStateAtom)).toBeNull();
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
        expect(globalStore.get(surfaceAtom)).toBe("jarvis");
        forgetOrigin();
    });
});

describe("escapeDagModal", () => {
    it("clears a selection before it closes the modal", () => {
        openDagTask("dag:x", "t-1");
        escapeDagModal();
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
        expect(globalStore.get(dagModalStateAtom)).not.toBeNull();
        escapeDagModal();
        expect(globalStore.get(dagModalStateAtom)).toBeNull();
    });
});

describe("openDagTask", () => {
    // the owner comes off the dag, so the state names the dag alone: no opener can supply a run that disagrees
    it("holds the dag alone, with the task selected", () => {
        openDagTask("dag:x", "t-1");
        expect(globalStore.get(dagModalStateAtom)).toEqual({ kind: "live", dagOref: "dag:x", error: "" });
        expect(globalStore.get(selectedTaskIdAtom)).toBe("t-1");
        dismissDagModal();
    });
});

describe("openRunSheetDag", () => {
    it("opens a lead run's dag with nothing selected", () => {
        openRunSheetDag({ dagoref: "d1" });
        expect(globalStore.get(dagModalStateAtom)).toMatchObject({ dagOref: "dag:d1" });
        expect(globalStore.get(selectedTaskIdAtom)).toBeNull();
        dismissDagModal();
    });

    it("opens a worker run's dag on the worker's task", () => {
        openRunSheetDag({ dagoref: "d1", taskid: "t-3" });
        expect(globalStore.get(dagModalStateAtom)).toMatchObject({ dagOref: "dag:d1" });
        expect(globalStore.get(selectedTaskIdAtom)).toBe("t-3");
        dismissDagModal();
    });

    it("prefers the task the link names", () => {
        openRunSheetDag({ dagoref: "d1", taskid: "t-3" }, "t-9");
        expect(globalStore.get(selectedTaskIdAtom)).toBe("t-9");
        dismissDagModal();
    });
});

describe("the DAG modal on the modal stack", () => {
    it("has an id to register under", () => {
        expect(typeof DAG_MODAL_ID).toBe("string");
        expect(DAG_MODAL_ID).not.toBe("");
    });

    // the run sheet registers only once its face loads, so it can land above a DAG modal that mounted first;
    // the modal re-registers when the sheet shows, which puts it back on top
    it("is on top again after it re-registers over a sheet that registered later", () => {
        const unregisterDag = registerModal(DAG_MODAL_ID);
        const unregisterSheet = registerModal("sheet");
        expect(isTopModal(DAG_MODAL_ID)).toBe(false);
        unregisterDag();
        const reregisterDag = registerModal(DAG_MODAL_ID);
        expect(isTopModal(DAG_MODAL_ID)).toBe(true);
        reregisterDag();
        unregisterSheet();
    });
});
