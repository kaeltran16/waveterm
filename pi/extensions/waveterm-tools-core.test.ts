import { describe, expect, it } from "vitest";
import {
    captureTailArgs,
    controlFileName,
    notifyArgs,
    openFileArgs,
    parseControlCommand,
    querySessionsArgs,
    runCommandArgs,
    vaultAskArgs,
} from "./waveterm-tools-core";

describe("waveterm-tools-core", () => {
    it("builds wsh run argv with an optional cwd", () => {
        expect(runCommandArgs("echo hi", "C:\\proj")).toEqual(["run", "--cwd", "C:\\proj", "-c", "echo hi"]);
        expect(runCommandArgs("echo hi")).toEqual(["run", "-c", "echo hi"]);
    });

    it("builds the capture-tail argv", () => {
        expect(captureTailArgs("b1")).toEqual(["termscrollback", "-b", "b1", "--lastcommand"]);
    });

    it("builds open-file and query-sessions argv", () => {
        expect(openFileArgs("C:\\a.txt")).toEqual(["editor", "C:\\a.txt"]);
        expect(querySessionsArgs()).toEqual(["blocks", "list", "--json"]);
    });

    it("builds notify argv with optional message and level", () => {
        expect(notifyArgs("t")).toEqual(["notify", "t"]);
        expect(notifyArgs("t", { message: "m", level: "error" })).toEqual(["notify", "t", "--message", "m", "--level", "error"]);
        expect(notifyArgs("t", { level: "info" })).toEqual(["notify", "t"]);
    });

    it("names control files by session id", () => {
        expect(controlFileName("sess-1")).toBe("sess-1.json");
    });

    it("parses a valid control command", () => {
        const cmd = parseControlCommand(JSON.stringify({ cmd: "steer", content: "look at this" }));
        expect(cmd).toEqual({ cmd: "steer", content: "look at this", name: "", path: "" });
    });

    it("rejects malformed or unknown control commands", () => {
        expect(parseControlCommand("not json")).toBeNull();
        expect(parseControlCommand(JSON.stringify({ cmd: "moo" }))).toBeNull();
        expect(parseControlCommand(JSON.stringify({ content: "no cmd" }))).toBeNull();
    });

    it("builds wsh jarvis ask argv with json and optional cwd", () => {
        expect(vaultAskArgs("did the ask bridge ship?", "C:\\proj")).toEqual([
            "jarvis", "ask", "did the ask bridge ship?", "--json", "--cwd", "C:\\proj",
        ]);
        expect(vaultAskArgs("did the ask bridge ship?")).toEqual([
            "jarvis", "ask", "did the ask bridge ship?", "--json",
        ]);
    });
});
