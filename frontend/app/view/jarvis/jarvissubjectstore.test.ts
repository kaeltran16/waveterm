// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// the module reaches the backend on selection (ResolveSpaceScope, GetDossier) and pulls in the channels
// store; stub the RPC layer so these tests exercise only the synchronous per-subject atoms.
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetDossierCommand: vi.fn(async () => null), ResolveFocusScopeCommand: vi.fn(async () => null) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
// the channel and effort warm-ups are what selectSubject is observed through; replace the real loads
vi.mock("@/app/view/agents/channelsstore", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/view/agents/channelsstore")>()),
    selectChannel: vi.fn(async () => {}),
}));
vi.mock("./effortstore", () => ({ loadEffortDetail: vi.fn(async () => {}) }));

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { activeChannelRunsAtom, selectChannel } from "@/app/view/agents/channelsstore";
import { loadEffortDetail } from "./effortstore";
import {
    activeRunIdAtom,
    activeSubjectAtom,
    persistedSubjectAtom,
    recordDetailAtom,
    recordScopeAtom,
    selectSubject,
    setActiveRunId,
} from "./jarvissubjectstore";

describe("setActiveRunId", () => {
    it("keys the active run by channel, leaving other channels alone", () => {
        globalStore.set(activeRunIdAtom, {});
        setActiveRunId("chan-a", "run-1");
        setActiveRunId("chan-b", "run-2");
        expect(globalStore.get(activeRunIdAtom)).toEqual({ "chan-a": "run-1", "chan-b": "run-2" });
    });
});

// leaving a channel with a finished run selected clears that selection, so returning to the channel
// lands on the fresh-run state instead of the finished run (the reported "navigating to the channel
// shows the last finished run" friction). A live run's selection survives — it is the default anyway.
describe("selectSubject clears a cold run selection on leaving its channel", () => {
    const run = (over: Partial<Run>) =>
        ({
            otype: "run",
            oid: "r",
            version: 1,
            meta: {},
            id: "r",
            goal: "g",
            workspaceid: "w",
            projectpath: "/p",
            status: "done",
            phases: [],
            createdts: 1,
            ...over,
        }) as Run;

    beforeEach(() => {
        globalStore.set(activeSubjectAtom, null);
        globalStore.set(activeRunIdAtom, {});
        globalStore.set(activeChannelRunsAtom, []);
    });

    it("drops a finished run selection when leaving the channel", () => {
        setActiveRunId("c1", "run-1");
        globalStore.set(activeChannelRunsAtom, [run({ id: "run-1", status: "done" })]);
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "c1" });

        selectSubject({ kind: "briefing", id: "all" });

        expect(globalStore.get(activeRunIdAtom)["c1"]).toBeUndefined();
    });

    it("keeps a live run selection when leaving the channel", () => {
        setActiveRunId("c1", "run-live");
        globalStore.set(activeChannelRunsAtom, [run({ id: "run-live", status: "executing" })]);
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "c1" });

        selectSubject({ kind: "briefing", id: "all" });

        expect(globalStore.get(activeRunIdAtom)["c1"]).toBe("run-live");
    });

    it("re-selecting the channel you are on is not leaving, so the selection stays", () => {
        setActiveRunId("c1", "run-1");
        globalStore.set(activeChannelRunsAtom, [run({ id: "run-1", status: "done" })]);
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "c1" });

        selectSubject({ kind: "channel", id: "c1" });

        expect(globalStore.get(activeRunIdAtom)["c1"]).toBe("run-1");
    });

    it("leaves other channels' selections alone", () => {
        setActiveRunId("c1", "run-1");
        setActiveRunId("c2", "run-2");
        globalStore.set(activeChannelRunsAtom, [run({ id: "run-1", status: "done" })]);
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "c1" });

        selectSubject({ kind: "channel", id: "c2" });

        expect(globalStore.get(activeRunIdAtom)["c1"]).toBeUndefined();
        expect(globalStore.get(activeRunIdAtom)["c2"]).toBe("run-2");
    });

    it("drops the selection when leaving to a non-channel subject that shares the channel's id", () => {
        setActiveRunId("c1", "run-1");
        globalStore.set(activeChannelRunsAtom, [run({ id: "run-1", status: "done" })]);
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "c1" });

        selectSubject({ kind: "dossier", id: "c1" });

        expect(globalStore.get(activeRunIdAtom)["c1"]).toBeUndefined();
    });

    it("leaves a non-channel subject's run entry alone when moving on", () => {
        setActiveRunId("d1", "run-1");
        globalStore.set(activeChannelRunsAtom, [run({ id: "run-1", status: "done" })]);
        globalStore.set(activeSubjectAtom, { kind: "dossier", id: "d1" });

        selectSubject({ kind: "briefing", id: "all" });

        expect(globalStore.get(activeRunIdAtom)["d1"]).toBe("run-1");
    });

    it("judges the selected run, not the first run in the list", () => {
        setActiveRunId("c1", "run-live");
        globalStore.set(activeChannelRunsAtom, [
            run({ id: "run-old", status: "done" }),
            run({ id: "run-live", status: "executing" }),
        ]);
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "c1" });

        selectSubject({ kind: "briefing", id: "all" });

        expect(globalStore.get(activeRunIdAtom)["c1"]).toBe("run-live");
    });

    it("selects the first subject from an empty state", () => {
        selectSubject({ kind: "briefing", id: "all" });

        expect(globalStore.get(activeSubjectAtom)).toEqual({ kind: "briefing", id: "all" });
    });
});

describe("selectSubject warms the selected kind's detail", () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    beforeEach(() => {
        vi.clearAllMocks();
        globalStore.set(activeSubjectAtom, null);
        globalStore.set(persistedSubjectAtom, null);
        globalStore.set(recordDetailAtom, {});
        globalStore.set(recordScopeAtom, {});
    });

    it("selects the channel and nothing else for a channel subject", async () => {
        selectSubject({ kind: "channel", id: "c1" });
        await flush();

        expect(selectChannel).toHaveBeenCalledExactlyOnceWith("c1");
        expect(loadEffortDetail).not.toHaveBeenCalled();
        expect(RpcApi.GetDossierCommand).not.toHaveBeenCalled();
        expect(RpcApi.ResolveFocusScopeCommand).not.toHaveBeenCalled();
    });

    it("loads nothing for the briefing subject", async () => {
        selectSubject({ kind: "briefing", id: "all" });
        await flush();

        expect(selectChannel).not.toHaveBeenCalled();
        expect(loadEffortDetail).not.toHaveBeenCalled();
        expect(RpcApi.GetDossierCommand).not.toHaveBeenCalled();
        expect(RpcApi.ResolveFocusScopeCommand).not.toHaveBeenCalled();
    });

    it("warms the effort detail by oref, without persisting the subject", async () => {
        selectSubject({ kind: "effort", id: "e1" });
        await flush();

        expect(loadEffortDetail).toHaveBeenCalledExactlyOnceWith("effort:e1");
        expect(selectChannel).not.toHaveBeenCalled();
        expect(RpcApi.GetDossierCommand).not.toHaveBeenCalled();
        expect(RpcApi.ResolveFocusScopeCommand).not.toHaveBeenCalled();
        expect(globalStore.get(persistedSubjectAtom)).toBeNull();
    });

    it("loads the record detail and scope for a dossier subject", async () => {
        selectSubject({ kind: "dossier", id: "d1" });
        await flush();

        expect(RpcApi.GetDossierCommand).toHaveBeenCalledExactlyOnceWith({}, { dossierid: "d1" });
        expect(RpcApi.ResolveFocusScopeCommand).toHaveBeenCalledExactlyOnceWith({}, { kind: "task", id: "d1" });
        expect(selectChannel).not.toHaveBeenCalled();
        expect(loadEffortDetail).not.toHaveBeenCalled();
    });
});

describe("briefing subject persistence", () => {
    beforeEach(() => {
        globalStore.set(persistedSubjectAtom, null);
    });

    it("does not persist the briefing subject", () => {
        selectSubject({ kind: "briefing", id: "all" });
        expect(globalStore.get(activeSubjectAtom)).toEqual({ kind: "briefing", id: "all" });
        expect(globalStore.get(persistedSubjectAtom)).toBeNull();
    });

    it("does not persist an effort subject", () => {
        selectSubject({ kind: "effort", id: "e1" });
        expect(globalStore.get(persistedSubjectAtom)).toBeNull();
    });

    it("persists an ordinary subject selected after briefing", () => {
        selectSubject({ kind: "briefing", id: "all" });
        selectSubject({ kind: "dossier", id: "d-after-briefing" });
        expect(globalStore.get(persistedSubjectAtom)).toEqual({ kind: "dossier", id: "d-after-briefing" });
    });
});
