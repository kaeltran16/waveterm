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
    it("has no composer with the sheet closed", () => {
        expect(
            resolveBriefComposerTarget({ sheetOpen: false, face: channelRun, run: run(), agents: [agent()] })
        ).toBeNull();
    });

    it("has no composer on an empty sheet", () => {
        expect(
            resolveBriefComposerTarget({ sheetOpen: true, face: { kind: "none" }, run: null, agents: [] })
        ).toBeNull();
    });

    it("has no composer on an initiative sheet — an initiative has no worker to message", () => {
        expect(
            resolveBriefComposerTarget({
                sheetOpen: true,
                face: { kind: "effort", effortId: "e1" },
                run: null,
                agents: [],
            })
        ).toBeNull();
    });

    it("has no composer on the launcher face, which has no run to talk to", () => {
        expect(
            resolveBriefComposerTarget({
                sheetOpen: true,
                face: { kind: "channel", channelId: "c1", body: "launcher" },
                run: null,
                agents: [agent()],
            })
        ).toBeNull();
    });

    it("has no composer for a finished run", () => {
        const done = run({ status: "done", phases: [phase({ state: "done", workerorefs: ["tab:t1"] })] });
        expect(
            resolveBriefComposerTarget({ sheetOpen: true, face: channelRun, run: done, agents: [agent()] })
        ).toBeNull();
    });

    it("has no composer when the phase's worker is gone from the roster", () => {
        expect(resolveBriefComposerTarget({ sheetOpen: true, face: channelRun, run: run(), agents: [] })).toBeNull();
    });

    // a worker with no block has no terminal to write to, so steerWorker would return false and the send
    // would vanish: no composer beats one that silently drops what was typed.
    it("has no composer for a lead with no terminal", () => {
        expect(
            resolveBriefComposerTarget({
                sheetOpen: true,
                face: channelRun,
                run: run(),
                agents: [agent({ blockId: "" })],
            })
        ).toBeNull();
        expect(
            resolveBriefComposerTarget({
                sheetOpen: true,
                face: channelRun,
                run: run(),
                agents: [agent({ blockId: undefined })],
            })
        ).toBeNull();
    });

    it("messages the live lead of the open session", () => {
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
});
