// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { describe, expect, it } from "vitest";
import { resolveBriefComposerTarget } from "./briefcomposertarget";
import type { SheetFace } from "./briefsheetmodel";

function agent(over: Partial<AgentVM> = {}): AgentVM {
    return { id: "t1", name: "claude", state: "working", blockId: "b1", ...over } as AgentVM;
}
function phase(over: Partial<RunPhase> = {}): RunPhase {
    return { kind: "execute", state: "pending", ...over };
}
function run(over: Partial<Run> = {}): Run {
    return {
        otype: "run",
        oid: "r1",
        version: 1,
        meta: {},
        id: "r1",
        goal: "g",
        workspaceid: "w1",
        projectpath: "/p",
        status: "executing",
        phases: [phase({ state: "running", workerorefs: ["tab:t1"] })],
        createdts: 1,
        ...over,
    };
}
const channelRun: SheetFace = { kind: "channel", channelId: "c1", body: "run" };

describe("resolveBriefComposerTarget", () => {
    it("is the Brief's own thread while no sheet is open", () => {
        expect(
            resolveBriefComposerTarget({ sheetOpen: false, face: channelRun, run: run(), agents: [agent()] })
        ).toEqual({ audience: "brief" });
    });

    it("is the Brief's own thread when the sheet is open on nothing", () => {
        expect(resolveBriefComposerTarget({ sheetOpen: true, face: { kind: "none" }, run: null, agents: [] })).toEqual({
            audience: "brief",
        });
    });

    it("carries the effort oref for an initiative drawer, which has no worker to message", () => {
        expect(
            resolveBriefComposerTarget({
                sheetOpen: true,
                face: { kind: "effort", effortId: "e9" },
                run: null,
                agents: [],
                effortTitle: "  Jarvis Brief  ",
            })
        ).toEqual({ audience: "initiative", effortORef: "effort:e9", name: "Jarvis Brief" });
    });

    it("targets the current phase's lead when a session sheet is showing a live run", () => {
        expect(
            resolveBriefComposerTarget({
                sheetOpen: true,
                face: channelRun,
                run: run(),
                agents: [agent()],
                projectName: "waveterm",
            })
        ).toEqual({
            audience: "worker",
            channelId: "c1",
            workerORef: "tab:t1",
            workerName: "claude",
            sessionName: "waveterm",
        });
    });

    it("names the session after the worker when the channel has no name of its own", () => {
        const t = resolveBriefComposerTarget({ sheetOpen: true, face: channelRun, run: run(), agents: [agent()] });
        expect(t).toMatchObject({ audience: "worker", sessionName: "claude" });
    });

    it("falls back to Jarvis on the launcher face, which has no run to talk to", () => {
        expect(
            resolveBriefComposerTarget({
                sheetOpen: true,
                face: { kind: "channel", channelId: "c1", body: "launcher" },
                run: null,
                agents: [agent()],
            })
        ).toEqual({ audience: "brief" });
    });

    it("falls back to Jarvis on a terminal run, whose lead is no longer steerable", () => {
        const done = run({ status: "done", phases: [phase({ state: "done", workerorefs: ["tab:t1"] })] });
        expect(resolveBriefComposerTarget({ sheetOpen: true, face: channelRun, run: done, agents: [agent()] })).toEqual(
            { audience: "brief" }
        );
    });

    it("falls back to Jarvis when the phase's worker is gone from the roster", () => {
        expect(resolveBriefComposerTarget({ sheetOpen: true, face: channelRun, run: run(), agents: [] })).toEqual({
            audience: "brief",
        });
    });

    // the whole point of the fallback: a worker with no block has no terminal to write to, so steerWorker
    // would return false and the send would vanish. Better to be honestly talking to Jarvis.
    it("falls back to Jarvis when the lead has no writable block", () => {
        expect(
            resolveBriefComposerTarget({
                sheetOpen: true,
                face: channelRun,
                run: run(),
                agents: [agent({ blockId: undefined })],
            })
        ).toEqual({ audience: "brief" });
    });
});
