import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistResume, shouldPersistResume } from "./agentresumestore";

const setMeta = vi.fn();
const reloadWaveObject = vi.fn();

vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { get: () => true } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: (...a: any[]) => setMeta(...a) } }));
vi.mock("@/app/store/wos", () => ({
    getObjectValue: () => ({
        meta: {
            controller: "cmd",
            cmd: "pi",
            "agent:baseargs": ["--session", "C:\\old\\s.jsonl", "--model", "x"],
            "cmd:args": ["--session", "C:\\old\\s.jsonl", "--model", "x"],
        },
    }),
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
