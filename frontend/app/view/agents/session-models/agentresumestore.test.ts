import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistResume, shouldPersistResume, shouldRelaunchWorker } from "./agentresumestore";

const setMeta = vi.fn();
const reloadWaveObject = vi.fn();

let rememberFlags = true;
let block: { meta: Record<string, unknown> } | undefined;

const piBlock = (over: Record<string, unknown> = {}) => ({
    meta: {
        controller: "cmd",
        cmd: "pi",
        "agent:baseargs": ["--session", "C:\\old\\s.jsonl", "--model", "x"],
        "cmd:args": ["--session", "C:\\old\\s.jsonl", "--model", "x"],
        ...over,
    },
});

vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { get: () => rememberFlags } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: (...a: any[]) => setMeta(...a) } }));
vi.mock("@/app/store/wos", () => ({
    getObjectValue: () => block,
    reloadWaveObject: (...a: any[]) => reloadWaveObject(...a),
}));

describe("shouldPersistResume", () => {
    it("resumes a claude, opencode, or pi agent when Remember flags is on", () => {
        expect(shouldPersistResume("claude", true)).toBe(true);
        expect(shouldPersistResume("opencode", true)).toBe(true);
        expect(shouldPersistResume("pi", true)).toBe(true);
    });

    it("does not resume when Remember flags is off (user wants a clean slate)", () => {
        expect(shouldPersistResume("opencode", false)).toBe(false);
        expect(shouldPersistResume("pi", false)).toBe(false);
    });

    it("never resumes codex or unknown providers", () => {
        expect(shouldPersistResume("codex", true)).toBe(false);
        expect(shouldPersistResume(undefined, true)).toBe(false);
    });

    it("matches the provider case-insensitively", () => {
        expect(shouldPersistResume("OpEnCoDe", true)).toBe(true);
        expect(shouldPersistResume("PI", true)).toBe(true);
    });
});

describe("persistResume (pi)", () => {
    beforeEach(() => {
        setMeta.mockClear();
        reloadWaveObject.mockClear();
        rememberFlags = true;
        block = piBlock();
    });

    it("bakes the full transcript path as pi's resume args", async () => {
        const oref = "block:pi-1";
        const path = "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl";
        await persistResume(oref, "pi", path);
        expect(setMeta.mock.calls[0][1]).toEqual({
            oref,
            meta: { "cmd:args": ["--session", path, "--model", "x"] },
        });
        expect(reloadWaveObject).toHaveBeenCalledWith(oref);
    });

    it("dedups on the full transcript path so a repeat status update skips the write", async () => {
        const oref = "block:pi-2";
        const path = "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl";
        await persistResume(oref, "pi", path);
        setMeta.mockClear();
        await persistResume(oref, "pi", path);
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("drops a pi session with no transcript path (no id fallback for pi)", async () => {
        const oref = "block:pi-3";
        await persistResume(oref, "pi", undefined);
        expect(setMeta).not.toHaveBeenCalled();
    });
});

describe("persistResume (gates)", () => {
    beforeEach(() => {
        setMeta.mockClear();
        reloadWaveObject.mockClear();
        rememberFlags = true;
        block = piBlock();
    });

    it("writes nothing when Remember flags is off", async () => {
        rememberFlags = false;
        await persistResume("block:gate-1", "pi", "/s/a.jsonl");
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("writes nothing for a block it cannot find", async () => {
        block = undefined;
        await persistResume("block:gate-2", "pi", "/s/a.jsonl");
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("writes nothing for a block that is not a cmd controller, even with a resumable cmd", async () => {
        block = piBlock({ controller: "shell", cmd: "claude" });
        await persistResume("block:gate-3", "claude", "/s/abc.jsonl");
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("writes nothing for a cmd that is not claude, opencode or pi", async () => {
        block = piBlock({ cmd: "codex" });
        await persistResume("block:gate-4", "claude", "/s/abc.jsonl");
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("writes nothing for a block launched before resume support (no baseargs)", async () => {
        block = piBlock({ "agent:baseargs": undefined });
        await persistResume("block:gate-5", "pi", "/s/a.jsonl");
        expect(setMeta).not.toHaveBeenCalled();
        block = piBlock({ cmd: "claude", "agent:baseargs": undefined });
        await persistResume("block:gate-5b", "claude", "/s/abc.jsonl");
        expect(setMeta).not.toHaveBeenCalled();
    });
});

describe("persistResume (claude and opencode)", () => {
    beforeEach(() => {
        setMeta.mockClear();
        reloadWaveObject.mockClear();
        rememberFlags = true;
    });

    it("bakes the session id from the transcript's file name ahead of the base args", async () => {
        block = piBlock({ cmd: "claude", "agent:baseargs": ["--model", "x"], "cmd:args": ["--model", "x"] });
        await persistResume("block:c-1", "claude", "/home/me/.claude/projects/p/abc-123.jsonl");
        expect(setMeta).toHaveBeenCalledTimes(1);
        expect(setMeta.mock.calls[0][1]).toEqual({
            oref: "block:c-1",
            meta: { "cmd:args": ["--resume", "abc-123", "--model", "x"] },
        });
    });

    it("bakes opencode's session id the same way", async () => {
        block = piBlock({ cmd: "opencode", "agent:baseargs": ["--model", "x"], "cmd:args": ["--model", "x"] });
        await persistResume("block:o-1", "opencode", "/s/ses_1.jsonl");
        expect(setMeta.mock.calls[0][1]).toEqual({
            oref: "block:o-1",
            meta: { "cmd:args": ["-s", "ses_1", "--model", "x"] },
        });
    });

    it("writes when the block has no cmd:args yet", async () => {
        block = piBlock({ cmd: "claude", "agent:baseargs": ["--model", "x"], "cmd:args": undefined });
        await persistResume("block:c-2", "claude", "/s/abc.jsonl");
        expect(setMeta.mock.calls[0][1]).toEqual({
            oref: "block:c-2",
            meta: { "cmd:args": ["--resume", "abc", "--model", "x"] },
        });
    });

    it("skips the write when the block already carries the resume args, and remembers it did", async () => {
        const args = ["--resume", "abc", "--model", "x"];
        block = piBlock({ cmd: "claude", "agent:baseargs": ["--model", "x"], "cmd:args": args });
        await persistResume("block:c-3", "claude", "/s/abc.jsonl");
        expect(setMeta).not.toHaveBeenCalled();
        block = piBlock({ cmd: "claude", "agent:baseargs": ["--model", "x"], "cmd:args": ["--model", "x"] });
        await persistResume("block:c-3", "claude", "/s/abc.jsonl");
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("writes when the block's args differ from the resume args only in one value", async () => {
        block = piBlock({
            cmd: "claude",
            "agent:baseargs": ["--model", "x"],
            "cmd:args": ["--resume", "abc", "--model", "y"],
        });
        await persistResume("block:c-4", "claude", "/s/abc.jsonl");
        expect(setMeta).toHaveBeenCalledTimes(1);
    });

    it("keys pi's dedup on the whole path, so two sessions with one file name are both written", async () => {
        block = piBlock();
        await persistResume("block:p-1", "pi", "/one/s.jsonl");
        await persistResume("block:p-1", "pi", "/two/s.jsonl");
        expect(setMeta.mock.calls.map((c) => c[1].meta["cmd:args"][1])).toEqual(["/one/s.jsonl", "/two/s.jsonl"]);
    });
});

describe("shouldRelaunchWorker", () => {
    const worker = { "agent:runid": "r1", "agent:taskid": "t-1" };

    it("does not relaunch a worker whose run is over", () => {
        expect(shouldRelaunchWorker(worker, "done")).toBe(false);
        expect(shouldRelaunchWorker(worker, "failed")).toBe(false);
        expect(shouldRelaunchWorker(worker, "cancelled")).toBe(false);
    });

    it("relaunches a worker whose run is still live", () => {
        expect(shouldRelaunchWorker(worker, "executing")).toBe(true);
    });

    it("does not relaunch a blocked run's stopped worker: Resume brings it back in its session", () => {
        expect(shouldRelaunchWorker(worker, "blocked")).toBe(false);
        expect(shouldRelaunchWorker({ cmd: "claude" }, "blocked")).toBe(true);
    });

    it("relaunches when the run status is unknown", () => {
        expect(shouldRelaunchWorker(worker, undefined)).toBe(true);
    });

    it("relaunches a hand-launched agent that carries no agent:runid, whatever the status", () => {
        expect(shouldRelaunchWorker({ cmd: "claude" }, "done")).toBe(true);
        expect(shouldRelaunchWorker(undefined, undefined)).toBe(true);
    });
});
