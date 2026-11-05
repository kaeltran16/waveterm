// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const getDossier = vi.fn();
const resolveScope = vi.fn();
const resolveAmbient = vi.fn();
const appendDecisionRpc = vi.fn();
const detachCmd = vi.fn();
const listDetached = vi.fn();
const setStatusCmd = vi.fn();
const acceptCmd = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetDossierStatusCommand: (...a: unknown[]) => setStatusCmd(...a),
        AcceptDossierEdgeCommand: (...a: unknown[]) => acceptCmd(...a),
        GetDossierCommand: (...a: unknown[]) => getDossier(...a),
        ResolveFocusScopeCommand: (...a: unknown[]) => resolveScope(...a),
        ResolveAmbientCommand: (...a: unknown[]) => resolveAmbient(...a),
        AppendDossierDecisionCommand: (...a: unknown[]) => appendDecisionRpc(...a),
        DetachDossierEdgeCommand: (...a: unknown[]) => detachCmd(...a),
        ListDetachedEdgesCommand: (...a: unknown[]) => listDetached(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({ loadAndPinWaveObject: vi.fn().mockResolvedValue(null) }));

import { globalStore } from "@/app/store/jotaiStore";
import { briefToastAtom } from "./briefundo";
import { graphBloomAtom } from "./jarvisgraphstore";
import { recordDetailAtom, recordRunsAtom, recordScopeAtom } from "./jarvissubjectstore";
import {
    acceptEdge,
    afterRecordWrite,
    appendDecision,
    detachedEdgesAtom,
    detachEdge,
    setDossierStatus,
} from "./recordactions";
import { tasksErrorAtom } from "./tasksstore";

describe("afterRecordWrite", () => {
    beforeEach(() => {
        getDossier.mockResolvedValue({ id: "task-a", status: "completed", decisions: [] });
        resolveScope.mockResolvedValue({ runorefs: [], channeloids: [], tabids: [] });
        resolveAmbient.mockResolvedValue({ tasks: [], edges: [], decisions: [] });
        globalStore.set(recordDetailAtom, { "task-a": { status: "active" } as unknown as DossierDetail });
        globalStore.set(recordScopeAtom, { "task-a": { runorefs: ["run:old"] } as unknown as SpaceScope });
        globalStore.set(recordRunsAtom, { "task-a": [{ id: "old" }] as unknown as Run[] });
        globalStore.set(graphBloomAtom, new Map([["task-a", { runs: [], links: [] }]]));
    });

    it("replaces the record's detail with a fresh read", async () => {
        await afterRecordWrite("task-a");
        expect(globalStore.get(recordDetailAtom)["task-a"].status).toBe("completed");
    });

    it("re-resolves the record's scope and runs", async () => {
        await afterRecordWrite("task-a");
        expect(globalStore.get(recordScopeAtom)["task-a"].runorefs).toEqual([]);
        expect(globalStore.get(recordRunsAtom)["task-a"]).toEqual([]);
    });

    it("drops the record's graph attribution bloom", async () => {
        await afterRecordWrite("task-a");
        expect(globalStore.get(graphBloomAtom).has("task-a")).toBe(false);
    });

    it("re-reads the whole-vault ambient map", async () => {
        await afterRecordWrite("task-a");
        expect(resolveAmbient).toHaveBeenCalled();
    });
});

describe("appendDecision", () => {
    beforeEach(() => {
        appendDecisionRpc.mockReset();
        getDossier.mockReset().mockResolvedValue({ id: "task-a", status: "active", decisions: [] });
        resolveScope.mockReset().mockResolvedValue({ runorefs: [], channeloids: [], tabids: [] });
        resolveAmbient.mockReset().mockResolvedValue({ tasks: [], edges: [], decisions: [] });
        globalStore.set(tasksErrorAtom, null);
        globalStore.set(briefToastAtom, null);
    });

    it("a failed write toasts its reason and leaves tasksErrorAtom alone", async () => {
        const cached = { id: "task-a", status: "active", decisions: [] } as unknown as DossierDetail;
        globalStore.set(recordDetailAtom, { "task-a": cached });
        appendDecisionRpc.mockRejectedValue(new Error("disk full"));

        await expect(appendDecision("task-a", "summary", "why", [])).resolves.toBe(false);

        const toast = globalStore.get(briefToastAtom);
        expect(toast?.error).toBe(true);
        expect(toast?.text).toContain("record the decision");
        expect(toast?.text).toContain("disk full");
        expect(globalStore.get(tasksErrorAtom)).toBeNull();
        expect(globalStore.get(recordDetailAtom)["task-a"]).toBe(cached);
    });

    it("reports success only after refreshing the record", async () => {
        appendDecisionRpc.mockResolvedValue({ decisionid: "d1" });
        getDossier.mockResolvedValue({ id: "task-a", status: "completed", decisions: [] });

        await expect(appendDecision("task-a", "summary", "why", [])).resolves.toBe(true);

        expect(globalStore.get(recordDetailAtom)["task-a"].status).toBe("completed");
    });
});

describe("setDossierStatus", () => {
    it("a failed write toasts its reason and leaves tasksErrorAtom alone", async () => {
        setStatusCmd.mockReset().mockRejectedValue(new Error("disk full"));
        globalStore.set(tasksErrorAtom, null);
        globalStore.set(briefToastAtom, null);

        setDossierStatus("task-a", "archived");

        await vi.waitFor(() => expect(globalStore.get(briefToastAtom)).not.toBeNull());
        const toast = globalStore.get(briefToastAtom);
        expect(toast?.error).toBe(true);
        expect(toast?.text).toContain("set the record's status");
        expect(toast?.text).toContain("disk full");
        expect(globalStore.get(tasksErrorAtom)).toBeNull();
    });
});

describe("edge writes", () => {
    beforeEach(() => {
        detachCmd.mockReset();
        acceptCmd.mockReset();
        globalStore.set(tasksErrorAtom, null);
        globalStore.set(briefToastAtom, null);
    });

    it("a refused edge write toasts its reason and leaves tasksErrorAtom alone", async () => {
        detachCmd.mockRejectedValue(new Error("no such edge"));
        detachEdge("task-a", "run:r1");
        await vi.waitFor(() => expect(globalStore.get(briefToastAtom)).not.toBeNull());
        expect(globalStore.get(briefToastAtom)?.text).toContain("Couldn't detach the run");
        expect(globalStore.get(briefToastAtom)?.text).toContain("no such edge");
        expect(globalStore.get(briefToastAtom)?.error).toBe(true);

        globalStore.set(briefToastAtom, null);
        acceptCmd.mockRejectedValue(new Error("run is gone"));
        acceptEdge("task-a", "run:r1");
        await vi.waitFor(() => expect(globalStore.get(briefToastAtom)).not.toBeNull());
        expect(globalStore.get(briefToastAtom)?.text).toContain("Couldn't attach the run");
        expect(globalStore.get(briefToastAtom)?.text).toContain("run is gone");
        expect(globalStore.get(tasksErrorAtom)).toBeNull();
    });
});

describe("detachEdge", () => {
    beforeEach(() => {
        detachCmd.mockReset().mockResolvedValue(undefined);
        listDetached.mockReset().mockResolvedValue({
            tasks: [{ id: "task-a", label: "Alpha" }],
            edges: [{ oref: "run:r1", dossierid: "task-a", provenance: "", bucket: "", state: "detached" }],
        });
        globalStore.set(detachedEdgesAtom, {});
    });

    it("sends both ids to the backend", async () => {
        detachEdge("task-a", "run:r1");
        await vi.waitFor(() => expect(detachCmd).toHaveBeenCalled());
        expect(detachCmd.mock.calls[0][1]).toEqual({ dossierid: "task-a", runoref: "run:r1" });
    });

    it("refreshes the detached list for the record and for the run", async () => {
        detachEdge("task-a", "run:r1");
        await vi.waitFor(() => expect(globalStore.get(detachedEdgesAtom)["run:r1"]).toBeDefined());
        const row = globalStore.get(detachedEdgesAtom)["task:task-a"][0];
        expect(row.label).toBe("Alpha");
        // both ids survive the projection: the record view needs the run, the band view needs the record
        expect(row.runORef).toBe("run:r1");
        expect(row.dossierId).toBe("task-a");
    });

    it("carries an empty bucket through rather than inventing a strength", async () => {
        detachEdge("task-a", "run:r1");
        await vi.waitFor(() => expect(globalStore.get(detachedEdgesAtom)["task:task-a"]).toBeDefined());
        expect(globalStore.get(detachedEdgesAtom)["task:task-a"][0].bucket).toBe("");
    });
});
