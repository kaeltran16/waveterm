// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// the module reaches the backend on selection (ResolveSpaceScope, GetDossier) and pulls in the channels
// store; stub the RPC layer so these tests exercise only the synchronous per-subject atoms.
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import type { JarvisConversation, JarvisScope } from "./jarviscontract";
import { conversationsByIdAtom, setConversation } from "./jarvisstore";
import { activeChannelRunsAtom } from "@/app/view/agents/channelsstore";
import {
    activeRunIdAtom,
    activeSubjectAtom,
    askAboutRecord,
    askAboutSource,
    channelPickingAtom,
    conversationForSource,
    jarvisDraftAtom,
    persistedSubjectAtom,
    selectSubject,
    setActiveRunId,
    setChannelPicking,
    setJarvisDraft,
    sourceConversationAtom,
} from "./jarvissubjectstore";

const draftFor = (subjectId: string) => globalStore.get(jarvisDraftAtom)[subjectId] ?? "";
const pickingFor = (subjectId: string) => globalStore.get(channelPickingAtom)[subjectId] ?? false;

const scopeFor = (oref: string): JarvisScope => ({
    mode: "attached",
    chips: [{ label: "This Run", active: true }],
    attached: [{ oref, sourceType: "run", title: "a run" }],
});

const withTurn = (id: string): JarvisConversation => ({
    id,
    title: "asked something",
    turns: [{ role: "user", text: "why?", attachments: [] }],
    scope: { mode: "all", chips: [], attached: [] },
});

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

// The reported growth: four distinct questions occupied twelve rows, because every "Ask Jarvis" on the
// same object minted another thread. askAboutRecord already kept one per record; the contextual entry from
// a Run, a Radar finding or a memory note did not.
describe("conversationForSource", () => {
    beforeEach(() => {
        globalStore.set(sourceConversationAtom, {});
        globalStore.set(conversationsByIdAtom, {});
    });

    it("returns the same thread when the same source is asked about twice", () => {
        const first = conversationForSource("run:r1", scopeFor("run:r1"));
        const second = conversationForSource("run:r1", scopeFor("run:r1"));
        expect(second).toBe(first);
    });

    it("keeps a separate thread per source", () => {
        const a = conversationForSource("run:r1", scopeFor("run:r1"));
        const b = conversationForSource("run:r2", scopeFor("run:r2"));
        expect(b).not.toBe(a);
        expect(globalStore.get(sourceConversationAtom)).toEqual({ "run:r1": a, "run:r2": b });
    });

    it("attaches the source to the thread it creates", () => {
        const id = conversationForSource("run:r1", scopeFor("run:r1"));
        expect(globalStore.get(conversationsByIdAtom)[id].scope.attached[0].oref).toBe("run:r1");
    });

    // the mapping outlives a pruned thread, and submitting into an id nothing holds any more is a silent
    // no-op — so a dead mapping has to mint a fresh thread rather than hand back the dead id.
    it("mints a fresh thread when the mapped one was pruned", () => {
        const first = conversationForSource("run:r1", scopeFor("run:r1"));
        globalStore.set(conversationsByIdAtom, {});
        const second = conversationForSource("run:r1", scopeFor("run:r1"));
        expect(second).not.toBe(first);
        expect(globalStore.get(conversationsByIdAtom)[second]).toBeDefined();
    });
});

describe("selectSubject prunes the thread it leaves", () => {
    beforeEach(() => {
        globalStore.set(sourceConversationAtom, {});
        globalStore.set(conversationsByIdAtom, {});
        globalStore.set(jarvisDraftAtom, {});
        globalStore.set(activeSubjectAtom, null);
    });

    it("drops an unasked thread on the way out, with its draft and its source mapping", () => {
        const id = conversationForSource("run:r1", scopeFor("run:r1"));
        setJarvisDraft(id, "What changed in this Run and why?");
        globalStore.set(activeSubjectAtom, { kind: "conversation", id });

        selectSubject({ kind: "conversation", id: "other" });

        expect(globalStore.get(conversationsByIdAtom)[id]).toBeUndefined();
        expect(globalStore.get(sourceConversationAtom)["run:r1"]).toBeUndefined();
        expect(draftFor(id)).toBe("");
    });

    it("keeps a thread that was asked in", () => {
        setConversation(withTurn("v1"));
        globalStore.set(activeSubjectAtom, { kind: "conversation", id: "v1" });
        selectSubject({ kind: "conversation", id: "other" });
        expect(globalStore.get(conversationsByIdAtom)["v1"]).toBeDefined();
    });

    // asking about the same source twice without leaving re-selects the thread already showing: pruning
    // there would delete the thread the click is about to open.
    it("does not prune the subject it is re-selecting", () => {
        const id = conversationForSource("run:r1", scopeFor("run:r1"));
        globalStore.set(activeSubjectAtom, { kind: "conversation", id });
        selectSubject({ kind: "conversation", id });
        expect(globalStore.get(conversationsByIdAtom)[id]).toBeDefined();
    });

    it("leaves a channel subject alone on the way out", () => {
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "c1" });
        setConversation(withTurn("v1"));
        selectSubject({ kind: "conversation", id: "v1" });
        expect(globalStore.get(conversationsByIdAtom)["v1"]).toBeDefined();
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

        selectSubject({ kind: "conversation", id: "v1" });

        expect(globalStore.get(activeRunIdAtom)["c1"]).toBeUndefined();
    });

    it("keeps a live run selection when leaving the channel", () => {
        setActiveRunId("c1", "run-live");
        globalStore.set(activeChannelRunsAtom, [run({ id: "run-live", status: "executing" })]);
        globalStore.set(activeSubjectAtom, { kind: "channel", id: "c1" });

        selectSubject({ kind: "conversation", id: "v1" });

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

// A volunteered utterance can point at a memory note or a decision, not only a record, so the gesture
// that was record-only had to widen. askAboutRecord stays as the record-shaped caller of it.
describe("askAboutSource", () => {
    beforeEach(() => {
        globalStore.set(sourceConversationAtom, {});
        globalStore.set(conversationsByIdAtom, {});
    });

    it("attaches any source type with its title and a kind-named chip", () => {
        askAboutSource("memnote:mem-1", "memory", "Drop-oldest on overflow", "Tell me more.");
        const convId = globalStore.get(sourceConversationAtom)["memnote:mem-1"];
        expect(convId).toBeDefined();
        const scope = globalStore.get(conversationsByIdAtom)[convId].scope;
        expect(scope.attached[0]).toEqual({
            oref: "memnote:mem-1",
            sourceType: "memory",
            title: "Drop-oldest on overflow",
        });
        expect(scope.chips[0].label).toBe("This memory");
    });

    it("continues one thread when asked twice about the same source", () => {
        askAboutSource("memnote:mem-1", "memory", "A note", "first question");
        const first = globalStore.get(sourceConversationAtom)["memnote:mem-1"];
        askAboutSource("memnote:mem-1", "memory", "A note", "second question");
        expect(globalStore.get(sourceConversationAtom)["memnote:mem-1"]).toBe(first);
    });

    it("mints separate threads for different sources", () => {
        askAboutSource("memnote:mem-1", "memory", "A note", "q");
        askAboutSource("task:task-a", "task", "A record", "q");
        const map = globalStore.get(sourceConversationAtom);
        expect(map["task:task-a"]).not.toBe(map["memnote:mem-1"]);
    });

    it("keeps askAboutRecord addressing its record through the same seam", () => {
        askAboutRecord("task-418", "Finish the migration", "What is left?");
        const convId = globalStore.get(sourceConversationAtom)["task:task-418"];
        expect(convId).toBeDefined();
        const scope = globalStore.get(conversationsByIdAtom)[convId].scope;
        expect(scope.attached[0]).toEqual({
            oref: "task:task-418",
            sourceType: "task",
            title: "Finish the migration",
        });
    });

    // the vault calls a record a "dossier", the view's SourceType union calls it a "task"
    it("translates the backend's dossier vocabulary to the view's task type", () => {
        askAboutSource("task:task-a", "dossier", "A record", "q");
        const convId = globalStore.get(sourceConversationAtom)["task:task-a"];
        const scope = globalStore.get(conversationsByIdAtom)[convId].scope;
        expect(scope.attached[0].sourceType).toBe("task");
        expect(scope.chips[0].label).toBe("This record");
    });

    it("falls back to a generic chip for a source type it has no name for", () => {
        askAboutSource("weird:w1", "weird", "Something", "q");
        const convId = globalStore.get(sourceConversationAtom)["weird:w1"];
        expect(globalStore.get(conversationsByIdAtom)[convId].scope.chips[0].label).toBe("This source");
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
        selectSubject({ kind: "conversation", id: "c-after-briefing" });
        expect(globalStore.get(persistedSubjectAtom)).toEqual({ kind: "conversation", id: "c-after-briefing" });
    });
});
