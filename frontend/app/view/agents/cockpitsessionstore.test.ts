// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const getChannels = vi.fn();
const runChanges = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetChannelsCommand: (...a: any[]) => getChannels(...a),
        GetChannelRunChangesCommand: (...a: any[]) => runChanges(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { popupBubble } from "./attentionpopup";
import { attentionAtom } from "./attentionstore";
import {
    cockpitRunsAtom,
    cockpitViewAtomFor,
    dismissSession,
    escalationStateAtom,
    outwardAttentionAtomFor,
    refreshCockpitRuns,
    runWaitAtom,
    stepCockpit,
    undismissSession,
} from "./cockpitsessionstore";

const TRANSCRIPT = "C:\\t\\det.jsonl";
const run = (id: string, over: Partial<Run> = {}): Run =>
    ({ oid: id, id, version: 1, status: "executing", createdts: Date.now(), ...over }) as Run;
const item = (over: Partial<AttentionItem>): AttentionItem =>
    ({
        kind: "dag-blocked",
        key: "k",
        source: "s",
        text: "t",
        action: "Review",
        waitingsince: 0,
        phaseidx: 0,
        ...over,
    }) as AttentionItem;

function fakeModel(agents: AgentVM[]) {
    const agentsAtom = atom(agents) as PrimitiveAtom<AgentVM[]>;
    const model = {
        agentsAtom,
        baseRosterAtom: atom<AgentVM[]>([]),
        lineageAtom: atom({ roles: {}, runs: {} }),
        structuralNowAtom: atom(Date.now()),
    } as unknown as AgentsViewModel;
    return { model, setAgents: (next: AgentVM[]) => globalStore.set(agentsAtom, next) };
}

const det = (state: AgentVM["state"], over: Partial<AgentVM> = {}): AgentVM => ({
    id: "det",
    name: "Detector",
    task: "",
    state,
    transcriptPath: TRANSCRIPT,
    idleSince: state === "idle" ? Date.now() : undefined,
    ...over,
});

// a store that has loaded, holding these channels' runs
function loaded(byChannel: Record<string, Run[]>) {
    const at = Date.now() - 1000;
    globalStore.set(cockpitRunsAtom, {
        byChannel,
        fetchedAt: Object.fromEntries(Object.keys(byChannel).map((c) => [c, at])),
        loadedAt: at,
    });
}

afterEach(() => {
    getChannels.mockReset();
    runChanges.mockReset();
    globalStore.set(attentionAtom, []);
    globalStore.set(escalationStateAtom, {});
    globalStore.set(cockpitRunsAtom, { byChannel: {}, fetchedAt: {}, loadedAt: null });
});

describe("the outward attention list", () => {
    it("holds a run wait only once it is yours, with the reason, and keeps it yours", () => {
        const { model, setAgents } = fakeModel([det("working")]);
        loaded({ c1: [run("r1", { origintranscript: TRANSCRIPT })] });
        const wait = item({ key: "dag-blocked:d1", runid: "r1", channelid: "c1" });
        const other = item({ key: "worker-orphan:t1", kind: "worker-orphan" });
        globalStore.set(attentionAtom, [wait, other]);
        stepCockpit(model);
        const outward = outwardAttentionAtomFor(model);

        const before = globalStore.get(outward);
        expect(before.map((i) => i.key)).toEqual([other.key]);
        expect(globalStore.get(runWaitAtom("r1"))).toMatchObject({ owner: "conductor", key: wait.key });

        setAgents([det("idle")]);
        const after = globalStore.get(outward);
        expect(after.map((i) => i.key)).toEqual([wait.key, other.key]);
        const bubble = popupBubble(before, after, false);
        expect(bubble).toMatchObject({ key: wait.key, more: 0 });
        expect(bubble.detail).toContain("Detector");

        stepCockpit(model);
        setAgents([det("working")]);
        stepCockpit(model);
        expect(globalStore.get(outward).map((i) => i.key)).toContain(wait.key);
        expect(globalStore.get(runWaitAtom("r1"))).toMatchObject({ owner: "you", why: "turn" });
    });

    it("leaves a run wait pending before the runs store loads", () => {
        const { model } = fakeModel([det("idle")]);
        globalStore.set(attentionAtom, [item({ key: "w", runid: "r1" })]);
        stepCockpit(model);
        expect(globalStore.get(outwardAttentionAtomFor(model))).toEqual([]);
        expect(globalStore.get(runWaitAtom("r1"))).toBeNull();
    });
});

describe("a wait on a run the store has not seen", () => {
    it.each([
        [
            "a run its conductor just created stays the conductor's",
            [run("new", { origintranscript: TRANSCRIPT })],
            "conductor",
        ],
        ["a run still unknown after the fetch has no conductor", [], "you"],
    ])("fetches its channel at once: %s", async (_, fetched, owner) => {
        const { model } = fakeModel([det("working")]);
        loaded({ c1: [] });
        globalStore.set(attentionAtom, [item({ key: "w", runid: "new", channelid: "c1" })]);
        runChanges.mockResolvedValue({ runids: fetched.map((r) => r.id), runs: fetched });

        stepCockpit(model);
        expect(globalStore.get(runWaitAtom("new"))).toBeNull();
        expect(runChanges).toHaveBeenCalledWith(expect.anything(), { channelid: "c1", known: {} });

        await vi.waitFor(() => expect(runChanges.mock.results[0]?.type).toBe("return"));
        await runChanges.mock.results[0].value;
        await vi.waitFor(() => {
            stepCockpit(model);
            expect(globalStore.get(runWaitAtom("new"))).toMatchObject({ owner });
        });
    });
});

describe("refreshCockpitRuns", () => {
    it("keeps a failed channel's runs and a seeded channel the list does not name", async () => {
        const { model } = fakeModel([]);
        globalStore.set(cockpitRunsAtom, {
            byChannel: { c1: [run("kept")], seeded: [run("fixture")] },
            fetchedAt: {},
            loadedAt: null,
        });
        getChannels.mockResolvedValue({ channels: [{ oid: "c1" }, { oid: "c2" }] });
        runChanges.mockImplementation(async (_c: unknown, data: { channelid: string }) => {
            if (data.channelid === "c1") throw new Error("down");
            return { runids: ["fresh"], runs: [run("fresh")] };
        });

        await refreshCockpitRuns();

        const view = globalStore.get(cockpitViewAtomFor(model));
        expect(view.loaded).toBe(true);
        expect(view.orphans.map((r) => r.id).sort()).toEqual(["fixture", "fresh", "kept"]);
    });

    it("drops the runs the engine started for a task or a stage", async () => {
        const { model } = fakeModel([]);
        getChannels.mockResolvedValue({ channels: [{ oid: "c1" }] });
        const runs = [run("lead"), run("worker", { taskid: "t-1" }), run("verifier", { stagerole: "verifier" })];
        runChanges.mockResolvedValue({ runids: runs.map((r) => r.id), runs });

        await refreshCockpitRuns();

        expect(globalStore.get(cockpitViewAtomFor(model)).orphans.map((r) => r.id)).toEqual(["lead"]);
    });
});

describe("dismissal", () => {
    it("moves a session to the Idle line, and undismissSession returns it at once", () => {
        const a: AgentVM = { id: "dis", name: "n", task: "", state: "working" };
        const { model, setAgents } = fakeModel([a]);
        stepCockpit(model);
        setAgents([{ ...a, state: "idle", idleSince: Date.now() - 1000 }]);
        stepCockpit(model);
        const view = cockpitViewAtomFor(model);
        expect(globalStore.get(view).sessions.map((s) => s.agent.id)).toEqual(["dis"]);

        dismissSession("dis");
        expect(globalStore.get(view).idle.map((s) => s.agent.id)).toEqual(["dis"]);
        undismissSession("dis");
        expect(globalStore.get(view).sessions.map((s) => s.agent.id)).toEqual(["dis"]);
    });
});
