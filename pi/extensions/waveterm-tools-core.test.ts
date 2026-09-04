import { describe, expect, it } from "vitest";
import {
    captureTailArgs,
    controlFileName,
    dagEventMessage,
    makeSerialChain,
    notifyArgs,
    openFileArgs,
    controlAckArgs,
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

    it("names control files by session id", () => {
        expect(controlFileName("sess-1")).toBe("sess-1.json");
    });

    it("parses a valid control command", () => {
        const cmd = parseControlCommand(JSON.stringify({ cmd: "steer", content: "look at this" }));
        expect(cmd).toEqual({
            cmd: "steer",
            content: "look at this",
            name: "",
            path: "",
            eventid: "",
            channelid: "",
            runid: "",
            taskid: "",
            sessionid: "",
        });
    });

    it("preserves the engine's envelope fields", () => {
        const cmd = parseControlCommand(
            JSON.stringify({
                cmd: "gate_open",
                content: "gate t-0",
                eventid: "ev-1",
                channelid: "ch-1",
                runid: "run-1",
                taskid: "t-0",
                sessionid: "sess-1",
            })
        );
        expect(cmd).toMatchObject({
            eventid: "ev-1",
            channelid: "ch-1",
            runid: "run-1",
            taskid: "t-0",
            sessionid: "sess-1",
        });
        expect(controlAckArgs(cmd!)).toEqual([
            "jarvis",
            "dag",
            "ack",
            "--channel",
            "ch-1",
            "--runid",
            "run-1",
            "--event",
            "ev-1",
            "--session",
            "sess-1",
        ]);
    });

    it("has nothing to acknowledge for a control file without an envelope", () => {
        const cmd = parseControlCommand(JSON.stringify({ cmd: "steer", content: "hi" }));
        expect(controlAckArgs(cmd!)).toBeNull();
    });

    it("rejects malformed or unknown control commands", () => {
        expect(parseControlCommand("not json")).toBeNull();
        expect(parseControlCommand(JSON.stringify({ cmd: "moo" }))).toBeNull();
        expect(parseControlCommand(JSON.stringify({ content: "no cmd" }))).toBeNull();
    });

    it("accepts dag control commands and maps them to notification lines", () => {
        for (const cmd of ["child_done", "gate_open", "dag_blocked", "dag_complete", "child_ask", "child_stalled"]) {
            expect(parseControlCommand(JSON.stringify({ cmd }))).not.toBeNull();
        }
        expect(dagEventMessage("gate_open", "t-1")).toBe("gate open — review in cockpit: t-1");
        expect(dagEventMessage("child_done", "t-0")).toBe("child done: t-0");
        expect(dagEventMessage("dag_complete", "")).toBe("dag complete");
        expect(dagEventMessage("child_ask", "t-3: A or B?")).toBe("child is asking: t-3: A or B?");
        expect(dagEventMessage("child_stalled", "t-2")).toBe("child stalled: t-2");
        expect(dagEventMessage("mystery", "x")).toBe("mystery: x");
    });

    it("builds wsh jarvis ask argv with json and optional cwd", () => {
        expect(vaultAskArgs("did the ask bridge ship?", "C:\\proj")).toEqual([
            "jarvis",
            "ask",
            "did the ask bridge ship?",
            "--json",
            "--cwd",
            "C:\\proj",
        ]);
        expect(vaultAskArgs("did the ask bridge ship?")).toEqual([
            "jarvis",
            "ask",
            "did the ask bridge ship?",
            "--json",
        ]);
    });

    describe("makeSerialChain", () => {
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

        it("runs burst enqueues one at a time", async () => {
            const order: string[] = [];
            let releaseFirst: (() => void) | null = null;
            const run = () =>
                new Promise<void>((resolve) => {
                    order.push("begin");
                    if (!releaseFirst) {
                        releaseFirst = resolve; // the first run blocks until released
                    } else {
                        resolve(); // later runs finish immediately
                    }
                });
            const enqueue = makeSerialChain(run, () => {});
            enqueue();
            enqueue();
            await tick();
            // the second call must wait for the first instead of interleaving
            expect(order).toEqual(["begin"]);
            releaseFirst!();
            await tick();
            expect(order).toEqual(["begin", "begin"]);
        });

        it("delivers failures to onError without blocking later runs", async () => {
            const errors: unknown[] = [];
            const order: string[] = [];
            let failNext = true;
            const run = async () => {
                order.push("run");
                if (failNext) {
                    failNext = false;
                    throw new Error("boom");
                }
            };
            const enqueue = makeSerialChain(run, (e) => errors.push(e));
            enqueue();
            await tick();
            enqueue();
            await tick();
            expect(errors.map((e) => (e as Error).message)).toEqual(["boom"]);
            expect(order).toEqual(["run", "run"]);
        });
    });
});
