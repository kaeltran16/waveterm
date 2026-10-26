// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { forgetOrigin } from "@/app/view/jarvis/returnsurface";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import { openSessionHit, type SessionsFind } from "./sessionsfind";

function fakeModel() {
    return {
        surfaceAtom: atom<SurfaceKey>("cockpit"),
        sessionsSelAtom: atom<string>("all"),
        sessionsMemberAtom: atom<string>("lead"),
        sessionsViewAtom: atom<"transcript" | "activity">("transcript"),
        sessionsQueryAtom: atom<string>(""),
        sessionsFindAtom: atom<SessionsFind | null>(null) as PrimitiveAtom<SessionsFind | null>,
    } as unknown as AgentsViewModel;
}

function session(over: Partial<SessionActivity> = {}): SessionActivity {
    return {
        id: "s1",
        runtime: "claude",
        projectpath: "/p",
        projectname: "p",
        lastactivets: 1,
        status: "done",
        startedts: 0,
        durationms: 0,
        events: [],
        ...over,
    } as SessionActivity;
}

function hit(kind: "turn" | "event", ord: number): SessionHit {
    return { kind, speaker: kind === "turn" ? "agent" : "committed", ord, text: "x", marks: [[0, 1]] };
}

function result(s: SessionActivity, hits: SessionHit[]): SessionSearchResult {
    return {
        session: s,
        hits,
        turnhits: hits.filter((h) => h.kind === "turn").length,
        eventhits: hits.filter((h) => h.kind === "event").length,
    };
}

afterEach(() => forgetOrigin());

describe("openSessionHit", () => {
    it("openSessionHit opens a solo turn hit on the transcript", () => {
        const m = fakeModel();
        const r = result(session(), [hit("turn", 0), hit("turn", 1), hit("turn", 2), hit("event", 0)]);
        openSessionHit(m, r, "flaky test", ["flaky", "test"], r.hits[2]);
        expect(globalStore.get(m.sessionsSelAtom)).toBe("claude:s1");
        expect(globalStore.get(m.sessionsViewAtom)).toBe("transcript");
        expect(globalStore.get(m.sessionsQueryAtom)).toBe("flaky test");
        expect(globalStore.get(m.sessionsFindAtom)).toEqual({
            sessionKey: "claude:s1",
            query: "flaky test",
            terms: ["flaky", "test"],
            target: { kind: "turn", ord: 2 },
        });
        expect(globalStore.get(m.surfaceAtom)).toBe("sessions");
    });

    it("openSessionHit opens an event hit on the activity view", () => {
        const m = fakeModel();
        const r = result(session(), [hit("event", 3)]);
        openSessionHit(m, r, "fix", ["fix"], r.hits[0]);
        expect(globalStore.get(m.sessionsViewAtom)).toBe("activity");
        expect(globalStore.get(m.sessionsFindAtom)?.target).toEqual({ kind: "event", ord: 3 });
    });

    it("openSessionHit opens a run member inside its run", () => {
        const m = fakeModel();
        const r = result(session({ runid: "r9", role: "worker", taskid: "t-2" }), [hit("turn", 0)]);
        openSessionHit(m, r, "fix", ["fix"]);
        expect(globalStore.get(m.sessionsSelAtom)).toBe("run:r9");
        expect(globalStore.get(m.sessionsMemberAtom)).toBe("t-2");
        expect(globalStore.get(m.sessionsFindAtom)?.sessionKey).toBe("claude:s1");
    });

    it("openSessionHit with no hits targets turn 0", () => {
        const m = fakeModel();
        globalStore.set(m.sessionsViewAtom, "activity");
        openSessionHit(m, result(session(), []), "fix", ["fix"]);
        expect(globalStore.get(m.sessionsViewAtom)).toBe("transcript");
        expect(globalStore.get(m.sessionsFindAtom)?.target).toEqual({ kind: "turn", ord: 0 });
    });
});
