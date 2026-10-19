import { afterEach, describe, expect, it } from "vitest";
import { getEnv } from "./getenv";

const NAME = "ARC_GETENV_TEST_VAR";

afterEach(() => {
    delete (globalThis as any).window;
    delete process.env[NAME];
});

describe("getEnv", () => {
    it("reads process.env when there is no window", () => {
        process.env[NAME] = "from-process";
        expect(getEnv(NAME)).toBe("from-process");
        expect(getEnv("ARC_GETENV_TEST_UNSET")).toBeUndefined();
    });
    it("asks the native host when a window exists, ahead of process.env", () => {
        process.env[NAME] = "from-process";
        (globalThis as any).window = { api: { getEnv: (n: string) => `host:${n}` } };
        expect(getEnv(NAME)).toBe(`host:${NAME}`);
    });
    it("returns null with neither a window nor a process", () => {
        const proc = globalThis.process;
        try {
            (globalThis as any).process = undefined;
            expect(getEnv(NAME)).toBeNull();
        } finally {
            (globalThis as any).process = proc;
        }
    });
});
