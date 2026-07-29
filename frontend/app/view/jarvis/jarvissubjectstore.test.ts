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
import {
    activeRunIdAtom,
    activeSubjectAtom,
    channelPickingAtom,
    conversationForSource,
    jarvisDraftAtom,
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
