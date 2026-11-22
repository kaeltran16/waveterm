import { describe, expect, it } from "vitest";
import {
    captureTailArgs,
    dagRulesArgs,
    notifyArgs,
    openFileArgs,
    querySessionsArgs,
    runCommandArgs,
    shouldAutoCompact,
    withOrchestrationRules,
} from "./waveterm-tools-core";

describe("waveterm-tools-core", () => {
    it.each([
        ["a 1M window at 20%", { contextWindow: 1_000_000, percent: 20 }, true],
        ["a 1M window below 20%", { contextWindow: 1_000_000, percent: 19.9 }, false],
        ["a smaller window past 20%", { contextWindow: 400_000, percent: 80 }, false],
        ["unknown usage after a compaction", { contextWindow: 1_000_000, percent: null }, false],
        ["no model", undefined, false],
    ])("auto-compacts %s: %s", (_name, usage, want) => {
        expect(shouldAutoCompact(usage)).toBe(want);
    });

    it("builds the dag rules argv", () => {
        expect(dagRulesArgs()).toEqual(["jarvis", "dag", "rules"]);
    });

    it("appends a lead's rules as the last user message", () => {
        const messages = [{ role: "user", content: "hi", timestamp: 1 }];
        expect(withOrchestrationRules(messages, "  You are the lead for run r-1.\n", 5)).toEqual([
            ...messages,
            { role: "user", content: "You are the lead for run r-1.", timestamp: 5 },
        ]);
    });

    it("leaves a request alone when there are no rules", () => {
        expect(withOrchestrationRules([{ role: "user", content: "hi", timestamp: 1 }], " \n", 5)).toBeUndefined();
    });

    it("builds wsh run argv with an optional cwd", () => {
        expect(runCommandArgs("echo hi", "C:\\proj")).toEqual(["run", "--cwd", "C:\\proj", "-c", "echo hi"]);
        expect(runCommandArgs("echo hi")).toEqual(["run", "-c", "echo hi"]);
    });

    it("builds the capture-tail argv", () => {
        expect(captureTailArgs("b1")).toEqual(["termscrollback", "-b", "b1", "--lastcommand"]);
    });

    it("builds open-file and query-sessions argv", () => {
        expect(openFileArgs("C:\\a.txt")).toEqual(["view", "C:\\a.txt"]);
        expect(querySessionsArgs()).toEqual(["blocks", "list", "--json"]);
    });

    it("builds notify argv with optional message and level", () => {
        expect(notifyArgs("t")).toEqual(["notify", "t"]);
        expect(notifyArgs("t", { message: "m", level: "error" })).toEqual([
            "notify",
            "t",
            "--message",
            "m",
            "--level",
            "error",
        ]);
        expect(notifyArgs("t", { level: "info" })).toEqual(["notify", "t"]);
    });
});
