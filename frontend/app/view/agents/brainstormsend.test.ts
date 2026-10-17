// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import { atom } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { brainstormLine, runPrefill, type BrainstormAction, type BrainstormFile } from "./brainstormmodel";
import { approveAndOpenRun, openRunLauncher, sendBrainstorm } from "./brainstormsend";
import type { BrainstormState } from "./brainstormstore";

const AGENT = { id: "a1", name: "lag-alerts", blockId: "blk-1", project: "siem" } as AgentVM;

const FILE: BrainstormFile = {
    v: 1,
    title: "Consumer lag alerts",
    spec: "docs/specs/lag.md",
    canvas: "lag",
    question: null,
    working: null,
    parts: [{ id: "page", title: "What on-call sees", state: "yours", body: "b", boards: ["Page.dc.html"] }],
    history: [],
    done: true,
    check: null,
    run: null,
};

const STATE = {
    topic: "lag",
    path: "/p/.superpowers/brainstorm/lag/brainstorm.json",
    cwd: "/p",
    file: FILE,
} as BrainstormState;

function fakeIO(fail = false) {
    const typed: [string, string][] = [];
    return {
        typed,
        type: async (blockId: string, text: string) => {
            if (fail) {
                throw new Error("boom");
            }
            typed.push([blockId, text]);
        },
    };
}

function fakeModel(): AgentsViewModel {
    return { newRunOpenAtom: atom(false) } as unknown as AgentsViewModel;
}

afterEach(() => {
    globalStore.set(newRunPrefillAtom, null);
});

describe("sendBrainstorm", () => {
    const actions: BrainstormAction[] = [
        { kind: "answer", text: "first line\n\tsecond  line" },
        { kind: "guess" },
        { kind: "skip" },
        { kind: "confirm", part: "current" },
        { kind: "edit", part: "constraints", text: "No new\nservice." },
        { kind: "keep", part: "constraints" },
        { kind: "restore", part: "constraints" },
        { kind: "check" },
        { kind: "builder-answer", text: "Only report." },
        { kind: "approved" },
        { kind: "keep-talking" },
    ];

    it.each(actions)("types the $kind line and Enter into the agent's block", async (action) => {
        const io = fakeIO();
        await sendBrainstorm(AGENT, action, io);
        expect(io.typed).toEqual([["blk-1", brainstormLine(action) + "\r"]]);
    });

    it("types a multi-line answer as one line", async () => {
        const io = fakeIO();
        await sendBrainstorm(AGENT, { kind: "answer", text: "  one\n\ntwo\tthree " }, io);
        expect(io.typed).toEqual([["blk-1", "one two three\r"]]);
    });

    it.each([
        { kind: "answer", text: " \n\t " },
        { kind: "edit", part: "x", text: "" },
        { kind: "builder-answer", text: "\n" },
    ] as BrainstormAction[])("a blank $kind throws and types nothing", async (action) => {
        const io = fakeIO();
        await expect(sendBrainstorm(AGENT, action, io)).rejects.toThrow("Nothing to send");
        expect(io.typed).toEqual([]);
    });

    it("refuses an agent with no terminal", async () => {
        const io = fakeIO();
        await expect(sendBrainstorm({ ...AGENT, blockId: undefined }, { kind: "guess" }, io)).rejects.toThrow(
            "This agent has no terminal to type into"
        );
        expect(io.typed).toEqual([]);
    });

    it("names the agent when typing fails", async () => {
        await expect(sendBrainstorm(AGENT, { kind: "guess" }, fakeIO(true))).rejects.toThrow(
            "Couldn't type into lag-alerts: boom"
        );
    });
});

describe("approveAndOpenRun", () => {
    it("types brainstorm: approved before it prefills and opens the launcher", async () => {
        const model = fakeModel();
        const seen: unknown[] = [];
        const io = {
            type: async (blockId: string, text: string) => {
                seen.push([blockId, text, globalStore.get(newRunPrefillAtom), globalStore.get(model.newRunOpenAtom)]);
            },
        };
        await approveAndOpenRun(model, AGENT, STATE, io);
        expect(seen).toEqual([["blk-1", "brainstorm: approved\r", null, false]]);
        expect(globalStore.get(newRunPrefillAtom)).toEqual(runPrefill(FILE, { projectName: "siem", cwd: "/p" }));
        expect(globalStore.get(model.newRunOpenAtom)).toBe(true);
    });

    it("leaves the launcher closed when the line cannot be typed", async () => {
        const model = fakeModel();
        await expect(approveAndOpenRun(model, AGENT, STATE, fakeIO(true))).rejects.toThrow("Couldn't type into");
        expect(globalStore.get(newRunPrefillAtom)).toBeNull();
        expect(globalStore.get(model.newRunOpenAtom)).toBe(false);
    });
});

describe("openRunLauncher", () => {
    it("prefills and opens the launcher without typing", () => {
        const model = fakeModel();
        openRunLauncher(model, AGENT, STATE);
        expect(globalStore.get(newRunPrefillAtom)).toEqual(runPrefill(FILE, { projectName: "siem", cwd: "/p" }));
        expect(globalStore.get(model.newRunOpenAtom)).toBe(true);
    });
});
