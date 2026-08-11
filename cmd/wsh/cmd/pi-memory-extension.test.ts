import { afterEach, describe, expect, it, vi } from "vitest";
import wavetermMemory, { registerWavetermMemory } from "./pi-memory-extension";

type Handler = (event: any, ctx: any) => void;

function fakePi() {
    const handlers = new Map<string, Handler[]>();
    const exec = vi.fn(async () => {});
    return {
        on: (event: string, fn: Handler) => {
            handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        },
        exec,
        handlers,
    };
}

function sessionCtx(over: Record<string, unknown> = {}) {
    return {
        cwd: "C:\\Users\\Jane Doe\\proj",
        sessionManager: {
            getSessionFile: () => "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl",
        },
        ...over,
    };
}

describe("registerWavetermMemory", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("registers session_start and session_shutdown", () => {
        const pi = fakePi();
        registerWavetermMemory(pi, "wsh");
        expect(pi.handlers.get("session_start")?.length).toBeGreaterThan(0);
        expect(pi.handlers.get("session_shutdown")?.length).toBeGreaterThan(0);
    });

    it("projects memory on session_start", async () => {
        const pi = fakePi();
        registerWavetermMemory(pi, "wsh");
        await pi.handlers.get("session_start")![0]({}, sessionCtx());
        expect(pi.exec).toHaveBeenCalledWith("wsh", [
            "agent-memory-project",
            "--cwd",
            "C:\\Users\\Jane Doe\\proj",
        ]);
    });

    it("enqueues the session on session_shutdown", async () => {
        const pi = fakePi();
        registerWavetermMemory(pi, "wsh");
        await pi.handlers.get("session_shutdown")![0]({}, sessionCtx());
        expect(pi.exec).toHaveBeenCalledWith("wsh", [
            "agent-memory-hook",
            "--transcript",
            "C:\\Users\\Jane Doe\\.pi\\agent\\sessions\\s.jsonl",
            "--cwd",
            "C:\\Users\\Jane Doe\\proj",
        ]);
    });

    it("skips enqueue when the session is ephemeral (no session file)", async () => {
        const pi = fakePi();
        registerWavetermMemory(pi, "wsh");
        await pi.handlers.get("session_shutdown")![0]({}, sessionCtx({ sessionManager: { getSessionFile: () => "" } }));
        expect(pi.exec).not.toHaveBeenCalled();
    });

    it("skips enqueue when WAVETERM_MEMORY_DISTILL is set", async () => {
        vi.stubEnv("WAVETERM_MEMORY_DISTILL", "1");
        const pi = fakePi();
        registerWavetermMemory(pi, "wsh");
        await pi.handlers.get("session_shutdown")![0]({}, sessionCtx());
        expect(pi.exec).not.toHaveBeenCalled();
    });

    it("falls back to empty cwd when absent", async () => {
        const pi = fakePi();
        registerWavetermMemory(pi, "wsh");
        await pi.handlers.get("session_start")![0]({}, { sessionManager: { getSessionFile: () => "f.jsonl" } });
        expect(pi.exec).toHaveBeenCalledWith("wsh", ["agent-memory-project", "--cwd", ""]);
    });

    it("swallows exec errors (best-effort, must not break the session)", async () => {
        const pi = fakePi();
        pi.exec.mockRejectedValue(new Error("boom"));
        registerWavetermMemory(pi, "wsh");
        await expect(pi.handlers.get("session_shutdown")![0]({}, sessionCtx())).resolves.toBeUndefined();
    });
});

describe("default export", () => {
    it("wires registerWavetermMemory with the placeholder wsh path", async () => {
        const pi = fakePi();
        wavetermMemory(pi);
        expect(pi.handlers.get("session_start")?.length).toBe(1);
        await pi.handlers.get("session_start")![0]({}, sessionCtx());
        expect(pi.exec).toHaveBeenCalledWith("__WSH_PATH__", [
            "agent-memory-project",
            "--cwd",
            "C:\\Users\\Jane Doe\\proj",
        ]);
    });
});
