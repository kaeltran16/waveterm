import { describe, expect, it } from "vitest";
import { controlMsg, deliver, isCommand, isDropped, steerNotice, takeLines } from "./control-core";

function recorder(compactError?: Error, commandError?: Error) {
    const calls: string[][] = [];
    return {
        calls,
        session: {
            submit: async (text: string) => void calls.push(["submit", text]),
            command: async (name: string, args: string) => {
                calls.push(["command", name, args]);
                if (commandError) {
                    throw commandError;
                }
            },
            compact: async (instructions: string) => {
                calls.push(["compact", instructions]);
                if (compactError) {
                    throw compactError;
                }
            },
        },
    };
}

describe("takeLines", () => {
    it("holds a line back until its newline arrives", () => {
        expect(takeLines('{"text":"a"}\n{"te')).toEqual({ lines: ['{"text":"a"}'], rest: '{"te' });
        expect(takeLines('{"te' + 'xt":"b"}\n')).toEqual({ lines: ['{"text":"b"}'], rest: "" });
    });

    it("drops blank lines and a windows line ending", () => {
        expect(takeLines('{"text":"a"}\r\n\n')).toEqual({ lines: ['{"text":"a"}'], rest: "" });
    });
});

describe("controlMsg", () => {
    it("reads a prompt, newlines kept", () => {
        expect(controlMsg('{"text":"wake: task 1 done\\nwsh jarvis dag status"}')).toEqual({
            text: "wake: task 1 done\nwsh jarvis dag status",
        });
    });

    it("reads a compaction with its instructions", () => {
        expect(controlMsg('{"compact":"Keep: the reasons."}')).toEqual({ compact: "Keep: the reasons." });
    });

    it("takes the compaction from a line that also carries its typed text", () => {
        expect(controlMsg('{"text":"/compact Keep: the reasons.","compact":"Keep: the reasons."}')).toEqual({
            compact: "Keep: the reasons.",
        });
    });

    it("reads a prompt that asks to join the running turn", () => {
        expect(controlMsg('{"text":"stop and rebase","midturn":true}')).toEqual({
            text: "stop and rebase",
            midTurn: true,
        });
    });

    it("ignores a line that asks for nothing", () => {
        expect(controlMsg("not json")).toBeNull();
        expect(controlMsg('{"text":""}')).toBeNull();
        expect(controlMsg('{"other":1}')).toBeNull();
        expect(controlMsg("null")).toBeNull();
    });
});

describe("deliver", () => {
    it("submits plain text as a prompt", async () => {
        const { calls, session } = recorder();
        await deliver(session, { text: "wake: task 1 done\nmore" });
        expect(calls).toEqual([["submit", "wake: task 1 done\nmore"]]);
    });

    it("runs a leading slash as a command with its arguments", async () => {
        const { calls, session } = recorder();
        await deliver(session, { text: "/compact Keep: the reasons. Drop: tool output." });
        expect(calls).toEqual([["command", "compact", "Keep: the reasons. Drop: tool output."]]);
    });

    it("runs a bare command with no arguments", async () => {
        const { calls, session } = recorder();
        await deliver(session, { text: "/compact" });
        expect(calls).toEqual([["command", "compact", ""]]);
    });

    it("runs a plugin command by its namespaced name", async () => {
        const { calls, session } = recorder();
        await deliver(session, { text: "/arc:brainstorm the queue" });
        expect(calls).toEqual([["command", "arc:brainstorm", "the queue"]]);
    });

    it("submits a prompt that starts with a path as a prompt", async () => {
        const { calls, session } = recorder();
        await deliver(session, { text: "/tmp/build.log has the failing test, read it" });
        await deliver(session, { text: "/README.md is out of date" });
        expect(calls).toEqual([
            ["submit", "/tmp/build.log has the failing test, read it"],
            ["submit", "/README.md is out of date"],
        ]);
    });

    it("submits a slash text the session refuses to run as a command", async () => {
        const { calls, session } = recorder(undefined, new Error("Unknown command: src"));
        await deliver(session, { text: "/src needs a cleanup, start with the store" });
        expect(calls).toEqual([
            ["command", "src", "needs a cleanup, start with the store"],
            ["submit", "/src needs a cleanup, start with the store"],
        ]);
    });

    it("compacts through the session when asked for a compaction", async () => {
        const { calls, session } = recorder();
        await deliver(session, { compact: "Keep: the reasons." });
        expect(calls).toEqual([["compact", "Keep: the reasons."]]);
    });

    it("runs the compact command when the session refuses to compact", async () => {
        const { calls, session } = recorder(new Error("not available in a headless session"));
        await deliver(session, { compact: "Keep: the reasons." });
        expect(calls).toEqual([
            ["compact", "Keep: the reasons."],
            ["command", "compact", "Keep: the reasons."],
        ]);
    });
});

describe("isCommand", () => {
    it("is a leading slash and a command name", () => {
        expect(isCommand("/compact Keep: the reasons.")).toBe(true);
        expect(isCommand("/arc:brainstorm")).toBe(true);
        expect(isCommand("/tmp/build.log has the failing test")).toBe(false);
        expect(isCommand("stop and rebase")).toBe(false);
    });
});

describe("isDropped", () => {
    it("is a submit the engine refused", () => {
        expect(isDropped({ drop: "the session was stopped and nobody has sent input since" })).toBe(true);
    });

    it("is not a prompt that entered, nor a command run", () => {
        expect(isDropped({ text: "a" })).toBe(false);
        expect(isDropped(undefined)).toBe(false);
        expect(isDropped({ drop: undefined })).toBe(false);
    });
});

describe("steerNotice", () => {
    it("is one line however the text is broken", () => {
        expect(steerNotice("stop and rebase\n  onto main\n")).toBe("read mid-turn: stop and rebase onto main");
    });
});
