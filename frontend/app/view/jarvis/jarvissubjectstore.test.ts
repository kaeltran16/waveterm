// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// the module reaches the backend on selection (ResolveSpaceScope, GetDossier) and pulls in the channels
// store; stub the RPC layer so these tests exercise only the synchronous per-subject atoms.
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetDossierCommand: vi.fn(async () => null), ResolveFocusScopeCommand: vi.fn(async () => null) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { activeChannelRunsAtom } from "@/app/view/agents/channelsstore";
import {
    activeRunIdAtom,
    activeSubjectAtom,
    channelPickingAtom,
    jarvisDraftAtom,
    persistedSubjectAtom,
    selectSubject,
    setActiveRunId,
    setChannelPicking,
    setJarvisDraft,
} from "./jarvissubjectstore";

const draftFor = (subjectId: string) => globalStore.get(jarvisDraftAtom)[subjectId] ?? "";
const pickingFor = (subjectId: string) => globalStore.get(channelPickingAtom)[subjectId] ?? false;

describe("per-subject composer state", () => {
    beforeEach(() => {
        globalStore.set(jarvisDraftAtom, {});
        globalStore.set(channelPickingAtom, {});
    });

    // the defect: jarvisDraftAtom was a single string, so a half-typed question typed on one thread was
    // still in the box on the next subject — and one Enter there would dispatch it against that subject.
    it("does not carry a draft from one subject to another", () => {
        setJarvisDraft("thread-1", "@run tighten the record band copy");
        expect(draftFor("thread-2")).toBe("");
    });

    it("returns each subject to the draft it was left with", () => {
        setJarvisDraft("thread-1", "why worktrees?");
        setJarvisDraft("thread-2", "what changed here?");
        expect(draftFor("thread-1")).toBe("why worktrees?");
        expect(draftFor("thread-2")).toBe("what changed here?");
    });

    it("clears a subject's draft on submit without touching the others", () => {
        setJarvisDraft("thread-1", "why worktrees?");
        setJarvisDraft("thread-2", "what changed here?");
        setJarvisDraft("thread-1", "");
        expect(draftFor("thread-1")).toBe("");
        expect(draftFor("thread-2")).toBe("what changed here?");
    });

    // the picker's twin defect: an open "Dispatch into which channel?" prompt was component state on a
    // component that never unmounts, so it followed the user too — offering to dispatch the old draft.
    it("does not carry an open channel picker to another subject", () => {
        setChannelPicking("thread-1", true);
        expect(pickingFor("thread-1")).toBe(true);
        expect(pickingFor("thread-2")).toBe(false);
    });
});

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

    it("persists an ordinary subject selected after briefing", () => {
        selectSubject({ kind: "briefing", id: "all" });
        selectSubject({ kind: "dossier", id: "d-after-briefing" });
        expect(globalStore.get(persistedSubjectAtom)).toEqual({ kind: "dossier", id: "d-after-briefing" });
    });
});
